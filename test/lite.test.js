import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { computeClimateConflictRisk, computeDataQuality, computeFloodRisk, computeServiceImpacts } from '../src/analytics.js'
import { computeEnsembleStats } from '../src/analytics/ensemble.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from '../src/analytics/impact.js'
import { quantileMap } from '../src/analytics/downscaling.js'
import { getConnector, runIngestion } from '../src/ingestion.js'
import { createServer } from '../src/server.js'
import { stacCatalog } from '../src/stac.js'
import { Pg0Manager } from '../src/pg0.js'
import { createStoreFromEnv } from '../src/storage.js'
import { JsonStore, mergeById } from '../src/store.js'
import { toCsv, toGeoJson } from '../src/utils.js'

const execFileAsync = promisify(execFile)

describe('Lindela Lite STAC', () => {
  it('returns catalog with non-empty links', () => {
    const catalog = stacCatalog('http://localhost:4177')
    assert.equal(catalog.type, 'Catalog')
    assert.equal(catalog.stac_version, '1.0.0')
    assert.ok(Array.isArray(catalog.links))
    assert.ok(catalog.links.length > 0)
  })

  it('GET /stac/catalog.json returns valid STAC Catalog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-stac-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/stac/catalog.json`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.type, 'Catalog')
      assert.equal(json.stac_version, '1.0.0')
      assert.ok(json.links.length > 0)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite open-source boundary', () => {
  it('rejects gdelt ingestion', () => {
    assert.throws(() => getConnector('gdelt'), /excluded/)
  })

  it('rejects gdelt in ingestion requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await assert.rejects(() => runIngestion(store, { sources: ['gdelt'] }), /excluded/)
  })

  it('honors ingestion retry settings when a connector throws', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-retry-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const result = await runIngestion(store, {
      sources: ['service_assets'],
      retries: 1,
      service_assets_geojson: '{',
    })
    assert.equal(result.source_runs[0].status, 'failed')
    assert.equal(result.source_runs[0].diagnostics.attempts, 2)
  })
})

describe('Lindela Lite analytics', () => {
  const data = {
    climate_observations: [
      { id: 'c1', source: 'open_meteo', type: 'precipitation_forecast', latitude: 3.1, longitude: 35.6, country: 'KE', region_name: 'Turkana', precipitation_mm: 42, precipitation_probability_pct: 80 },
    ],
    hazard_events: [
      { id: 'h1', source: 'gdacs', event_type: 'flood', severity: 'high', latitude: 3.2, longitude: 35.7, country: 'KE' },
    ],
    conflict_events: [
      { id: 'e1', source: 'conflict_csv', event_type: 'communal_tension', latitude: 3.15, longitude: 35.62, country: 'KE', fatalities: 1 },
    ],
    service_assets: [
      { id: 'a1', name: 'Clinic A', service_type: 'health', latitude: 3.13, longitude: 35.63, country: 'KE' },
    ],
  }

  it('computes flood and climate-conflict risk scores from real records', () => {
    const flood = computeFloodRisk(data)
    const conflict = computeClimateConflictRisk(data)
    assert.equal(flood.length, 1)
    assert.equal(conflict.length, 1)
    assert.ok(flood[0].score > 0)
    assert.ok(conflict[0].score > 0)
    assert.ok(flood[0].confidence > 0)
    assert.ok(conflict[0].confidence > 0)
  })

  it('computes service delivery impacts', () => {
    const risks = [...computeFloodRisk(data), ...computeClimateConflictRisk(data)]
    const impacts = computeServiceImpacts(data, risks)
    assert.equal(impacts.length, 1)
    assert.equal(impacts[0].asset_name, 'Clinic A')
    assert.ok(impacts[0].impact_score > 0)
    assert.ok(impacts[0].confidence > 0)
  })

  it('computes source-level data quality', () => {
    const quality = computeDataQuality({
      ...data,
      source_runs: [{ id: 'r1', source: 'gdacs', status: 'success', completed_at: new Date().toISOString(), errors: [] }],
    })
    assert.ok(quality.some((item) => item.source === 'gdacs'))
    assert.ok(quality.every((item) => Number.isFinite(item.confidence)))
  })

  it('includes probabilistic bands in risk scores', () => {
    const flood = computeFloodRisk(data)
    assert.equal(flood.length, 1)
    assert.ok(Number.isFinite(flood[0].score_p10))
    assert.ok(Number.isFinite(flood[0].score_p50))
    assert.ok(Number.isFinite(flood[0].score_p90))
    assert.ok(Number.isFinite(flood[0].interval_width))
    assert.ok(flood[0].score_p10 <= flood[0].score_p50)
    assert.ok(flood[0].score_p50 <= flood[0].score_p90)
    assert.ok(flood[0].interval_width >= 0)
  })

  it('computes ensemble statistics with linear interpolation', () => {
    const stats = computeEnsembleStats([1, 2, 3, 4, 5])
    assert.equal(stats.p50, 3)
    assert.ok(Math.abs(stats.p90 - 4.6) < 0.1)
    assert.ok(Math.abs(stats.p10 - 1.4) < 0.1)
    assert.equal(stats.count, 5)
  })

  it('computes population at risk for hazards near service assets', () => {
    const dataWithAssets = {
      ...data,
      service_assets: [
        { id: 'a1', name: 'Clinic', service_type: 'health', latitude: 3.12, longitude: 35.61, country: 'KE', population_served: 500 },
      ],
    }
    const par = computePopulationAtRisk(dataWithAssets)
    assert.ok(par.length > 0)
    assert.ok(par[0].population_at_risk >= 500)
  })

  it('maps gridded values to station values via quantile matching', () => {
    const gridded = [1, 2, 3, 4, 5]
    const station = [10, 20, 30, 40, 50]
    const mapper = quantileMap(gridded, station)
    const result = mapper(3)
    assert.ok(Math.abs(result - 30) < 5)
  })

  it('exports GeoJSON and CSV', () => {
    const records = [...data.hazard_events, ...data.conflict_events]
    const geojson = toGeoJson(records)
    const csv = toCsv(records)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.equal(geojson.features.length, 2)
    assert.match(csv, /event_type/)
    assert.match(csv, /gdacs/)
  })
})


describe('Lindela Lite storage modes', () => {
  it('orders merged records by operational timestamps', () => {
    const records = mergeById([
      { id: 'old-run', completed_at: '2026-01-01T00:00:00.000Z' },
    ], [
      { id: 'new-run', completed_at: '2026-01-02T00:00:00.000Z' },
    ])
    assert.deepEqual(records.map((record) => record.id), ['new-run', 'old-run'])
  })

  it('creates a JSON store when explicitly requested', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-storage-'))
    const store = await createStoreFromEnv({
      LINDELA_LITE_DB_MODE: 'json',
      LINDELA_LITE_STORE: path.join(dir, 'store.json'),
    })
    assert.equal(store.mode, 'json')
    const data = await store.read()
    assert.equal(data.source_runs.length, 0)
  })

  it('reports pg0 unavailable when the configured command is missing', async () => {
    const pg0 = new Pg0Manager({ command: 'missing-pg0-for-lindela-lite-test' })
    assert.equal(await pg0.available(), false)
  })

  it('requires a database URL for explicit postgres mode', async () => {
    await assert.rejects(
      () => createStoreFromEnv({ LINDELA_LITE_DB_MODE: 'postgres' }),
      /DATABASE_URL/,
    )
  })
})

describe('Lindela Lite validation', () => {
  it('passes the docs and deployment validation script', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/validate.mjs'], {
      cwd: process.cwd(),
    })
    assert.match(stdout, /validation ok/)
  })
})

describe('Lindela Lite API', () => {
  let server
  let baseUrl
  let tmpDir

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-api-'))
    const store = new JsonStore(path.join(tmpDir, 'store.json'))
    store.mode = 'json'
    server = createServer({ store })
    await new Promise((resolve) => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('serves health and source catalogs', async () => {
    const health = await fetchJson(`${baseUrl}/api/v1/health`)
    const sources = await fetchJson(`${baseUrl}/api/v1/sources`)
    const docs = await fetch(`${baseUrl}/docs/platform.md`)
    assert.equal(health.success, true)
    assert.ok(health.exclusions.includes('gdelt'))
    assert.equal(health.storage.mode, 'json')
    assert.ok(sources.data.some((source) => source.id === 'open_meteo'))
    assert.ok(!sources.data.some((source) => source.id === 'gdelt'))
    assert.equal(docs.headers.get('content-type').startsWith('text/markdown'), true)
    assert.match(await docs.text(), /Lindela Lite Platform Guide/)
  })

  it('requires the configured API key for mutating requests', async () => {
    const originalApiKey = process.env.LINDELA_LITE_API_KEY
    const originalWebhookSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
    process.env.LINDELA_LITE_API_KEY = 'test-api-key'
    process.env.RAPIDPRO_WEBHOOK_SECRET = 'rapidpro-secret'
    try {
      const health = await fetch(`${baseUrl}/api/v1/health`)
      assert.equal(health.status, 200)

      const rejected = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Blocked incident',
          incident_type: 'auth_test',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const rejectedPayload = await rejected.json()
      assert.equal(rejected.status, 401)
      assert.equal(rejectedPayload.success, false)

      const accepted = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-api-key',
        },
        body: JSON.stringify({
          title: 'Authorized incident',
          incident_type: 'auth_test',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const acceptedPayload = await accepted.json()
      assert.equal(accepted.status, 201)
      assert.equal(acceptedPayload.success, true)

      const rapidProWebhook = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'rapidpro-secret',
        },
        body: JSON.stringify({ id: 'auth-rapidpro-1', from: '+254700000001', content: 'REPORT API key bypass through webhook secret' }),
      })
      const rapidProWebhookPayload = await rapidProWebhook.json()
      assert.equal(rapidProWebhook.status, 201)
      assert.equal(rapidProWebhookPayload.success, true)

      const rapidProRejected = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'wrong',
        },
        body: JSON.stringify({ id: 'auth-rapidpro-2', content: 'REPORT blocked' }),
      })
      assert.equal(rapidProRejected.status, 401)
    } finally {
      if (originalApiKey === undefined) delete process.env.LINDELA_LITE_API_KEY
      else process.env.LINDELA_LITE_API_KEY = originalApiKey
      if (originalWebhookSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
      else process.env.RAPIDPRO_WEBHOOK_SECRET = originalWebhookSecret
    }
  })

  it('falls back to the dashboard shell for unknown static routes', async () => {
    const response = await fetch(`${baseUrl}/non-existent-dashboard-route`)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(body, /<title>Lindela Lite<\/title>/)
  })

  it('returns 404 for missing docs pages', async () => {
    const response = await fetch(`${baseUrl}/docs/not-a-real-doc.md`)
    const payload = await response.json()
    assert.equal(response.status, 404)
    assert.equal(payload.success, false)
    assert.match(payload.error, /Document not found/)
  })

  it('does not serve paths outside the docs directory', async () => {
    const response = await rawGet(baseUrl, '/docs/%2e%2e/package.json')
    const body = response.body
    assert.equal(response.status, 404)
    assert.doesNotMatch(body, /"scripts"/)
  })

  it('keeps dashboard mutating calls authenticated and dynamic HTML escaped', async () => {
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    assert.match(app, /function authHeaders/)
    assert.match(app, /'x-api-key': apiKey/)
    assert.match(app, /function escapeHtml/)
    assert.match(app, /title="\$\{escapeHtml\(source\.name\)\}"/)
    assert.doesNotMatch(app, /<td>\$\{record\.(title|message|text|name|source|status|id|owner)/)
  })

  it('ingests user-supplied conflict and service data through the API', async () => {
    const response = await fetch(`${baseUrl}/api/v1/ingest/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: ['service_assets', 'conflict_csv'],
        service_assets: [
          { name: 'Water Point 1', service_type: 'water', latitude: 3.1, longitude: 35.6, country: 'KE' },
        ],
        conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-01,resource_tension,3.11,35.61,KE,0,Water access tension\n',
      }),
    })
    const payload = await response.json()
    assert.equal(payload.success, true)

    const events = await fetchJson(`${baseUrl}/api/v1/events`)
    const impacts = await fetchJson(`${baseUrl}/api/v1/service-impacts`)
    assert.equal(events.data.length, 1)
    assert.equal(impacts.data.length, 1)
  })

  it('tracks ingestion health and runs due ingestion schedules', async () => {
    const status = await fetchJson(`${baseUrl}/api/v1/ingest/status`)
    assert.equal(status.success, true)
    assert.ok(status.data.some((item) => item.source === 'open_meteo' && item.regular === true))

    const defaultsResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules/defaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ next_run_at: '2999-01-01T00:00:00.000Z', actor: 'test' }),
    })
    const defaults = await defaultsResponse.json()
    assert.equal(defaultsResponse.status, 201)
    assert.ok(defaults.created >= 5)
    assert.ok(defaults.data.every((schedule) => schedule.status === 'active'))

    const scheduleResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'conflict_csv',
        interval_minutes: 60,
        next_run_at: '2026-01-01T00:00:00.000Z',
        default_options: {
          conflict_csv: 'event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-02,scheduled_ingest,3.12,35.62,KE,0,Scheduled ingestion event\n',
        },
        actor: 'test',
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)
    assert.equal(schedule.data.source, 'conflict_csv')

    const runDueResponse = await fetch(`${baseUrl}/api/v1/ingest/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.data[0].run_type, 'scheduled')
    assert.equal(runDue.data[0].schedule_id, schedule.data.id)
    assert.equal(runDue.data[0].status, 'success')
    assert.equal(runDue.schedules[0].last_run_at, runDue.data[0].completed_at)
    assert.ok(Date.parse(runDue.schedules[0].next_run_at) > Date.parse(runDue.schedules[0].last_run_at))

    const events = await fetchJson(`${baseUrl}/api/v1/events?event_type=scheduled_ingest`)
    assert.equal(events.data.length, 1)

    const health = await fetchJson(`${baseUrl}/api/v1/ingest/status`)
    const conflictHealth = health.data.find((item) => item.source === 'conflict_csv')
    assert.equal(conflictHealth.status, 'fresh')
    assert.equal(conflictHealth.schedule.id, schedule.data.id)

    const runOneResponse = await fetch(`${baseUrl}/api/v1/ingest/schedules/${schedule.data.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runOne = await runOneResponse.json()
    assert.equal(runOneResponse.status, 201)
    assert.equal(runOne.data.length, 1)
    assert.equal(runOne.data[0].schedule_id, schedule.data.id)
    assert.equal(runOne.schedule.last_run_at, runOne.data[0].completed_at)
  })

  it('returns empty arrays for empty-state API responses', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-empty-api-'))
    const emptyStore = new JsonStore(path.join(dir, 'store.json'))
    emptyStore.mode = 'json'
    const emptyServer = createServer({ store: emptyStore })
    await new Promise((resolve) => emptyServer.listen(0, resolve))
    const emptyBase = `http://127.0.0.1:${emptyServer.address().port}`
    try {
      const events = await fetchJson(`${emptyBase}/api/v1/events`)
      const climate = await fetchJson(`${emptyBase}/api/v1/climate`)
      assert.deepEqual(events.data, [])
      assert.deepEqual(climate.data, [])
    } finally {
      await new Promise((resolve) => emptyServer.close(resolve))
    }
  })

  it('validates service asset imports', async () => {
    const response = await fetch(`${baseUrl}/api/v1/service-assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service_assets: [{ name: 'Bad asset', service_type: 'health', country: 'KE', longitude: 35.6 }] }),
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.success, false)
    assert.match(payload.errors[0], /latitude/)
  })

  it('filters events and exports CSV and GeoJSON', async () => {
    const filtered = await fetchJson(`${baseUrl}/api/v1/events?country=KE&event_type=resource_tension`)
    assert.equal(filtered.data.length, 1)

    const geojson = await fetchJson(`${baseUrl}/api/v1/export.geojson?country=KE`)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.ok(geojson.features.length >= 1)

    const csvResponse = await fetch(`${baseUrl}/api/v1/export.csv?country=KE`)
    const csv = await csvResponse.text()
    assert.equal(csvResponse.headers.get('content-type').startsWith('text/csv'), true)
    assert.match(csv, /resource_tension/)
  })

  it('manages incidents, interventions, tasks, field reports, resources, and action logs', async () => {
    const incidentResponse = await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Clinic flood access disruption',
        incident_type: 'flood_access',
        priority: 'high',
        country: 'KE',
        latitude: 3.13,
        longitude: 35.63,
        actor: 'test',
      }),
    })
    const incident = await incidentResponse.json()
    assert.equal(incidentResponse.status, 201)
    assert.equal(incident.success, true)
    assert.equal(incident.data.status, 'open')

    const interventionResponse = await fetch(`${baseUrl}/api/v1/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.data.id,
        title: 'Maintain clinic continuity',
        lead_org: 'County health ops',
        status: 'active',
      }),
    })
    const intervention = await interventionResponse.json()
    assert.equal(interventionResponse.status, 201)
    assert.equal(intervention.data.incident_id, incident.data.id)

    const taskResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intervention_id: intervention.data.id,
        title: 'Validate dry access route',
        owner: 'field-lead',
      }),
    })
    const task = await taskResponse.json()
    assert.equal(taskResponse.status, 201)
    assert.equal(task.data.status, 'todo')

    const updatedTask = await fetchJson(`${baseUrl}/api/v1/tasks/${task.data.id}`)
    assert.equal(updatedTask.data.title, 'Validate dry access route')

    const reportResponse = await fetch(`${baseUrl}/api/v1/field-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        incident_id: incident.data.id,
        summary: 'Access route passable by 4x4 only',
        reported_by: 'field-lead',
        needs: ['fuel', 'water'],
      }),
    })
    const report = await reportResponse.json()
    assert.equal(reportResponse.status, 201)
    assert.equal(report.data.incident_id, incident.data.id)

    const resourceResponse = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Water treatment kits',
        resource_type: 'supply',
        quantity: 20,
        unit: 'kit',
        status: 'reserved',
        assigned_intervention_id: intervention.data.id,
      }),
    })
    const resource = await resourceResponse.json()
    assert.equal(resourceResponse.status, 201)
    assert.equal(resource.data.quantity, 20)

    const closeIncidentResponse = await fetch(`${baseUrl}/api/v1/incidents/${incident.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'responding', owner: 'ops-lead' }),
    })
    const closedIncident = await closeIncidentResponse.json()
    assert.equal(closeIncidentResponse.status, 200)
    assert.equal(closedIncident.data.status, 'responding')
    assert.equal(closedIncident.data.owner, 'ops-lead')

    const summary = await fetchJson(`${baseUrl}/api/v1/operations/summary`)
    assert.ok(summary.data.counts.open_incidents >= 1)
    assert.ok(summary.data.counts.active_interventions >= 1)

    const logs = await fetchJson(`${baseUrl}/api/v1/action-logs?limit=20`)
    assert.ok(logs.data.some((log) => log.record_id === incident.data.id))

    const geojson = await fetchJson(`${baseUrl}/api/v1/export.geojson?incident_id=${incident.data.id}`)
    assert.equal(geojson.type, 'FeatureCollection')
    assert.ok(geojson.features.length >= 1)
  })

  it('evaluates alert rules into auditable alert events', async () => {
    const ruleResponse = await fetch(`${baseUrl}/api/v1/alert-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Open incident alert',
        metric: 'operations.counts.open_incidents',
        operator: '>=',
        threshold: 1,
        severity: 'high',
        actions: [{ type: 'notify', target: 'response-lead' }],
      }),
    })
    const rule = await ruleResponse.json()
    assert.equal(ruleResponse.status, 201)
    assert.equal(rule.data.status, 'active')

    const evaluationResponse = await fetch(`${baseUrl}/api/v1/alerts/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const evaluation = await evaluationResponse.json()
    assert.equal(evaluationResponse.status, 201)
    assert.equal(evaluation.created, 1)
    assert.equal(evaluation.data[0].rule_id, rule.data.id)

    const duplicateResponse = await fetch(`${baseUrl}/api/v1/alerts/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const duplicate = await duplicateResponse.json()
    assert.equal(duplicate.created, 0)

    const updateResponse = await fetch(`${baseUrl}/api/v1/alert-events/${evaluation.data[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged', owner: 'ops-lead' }),
    })
    const updated = await updateResponse.json()
    assert.equal(updateResponse.status, 200)
    assert.equal(updated.data.status, 'acknowledged')
    assert.equal(updated.data.owner, 'ops-lead')
  })

  it('dispatches alert events through RapidPro flow starts', async () => {
    const received = []
    const rapidPro = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ uuid: 'flow-start-1', status: 'pending' }))
    })
    await new Promise((resolve) => rapidPro.listen(0, resolve))
    const original = rapidProEnv()
    process.env.RAPIDPRO_API_TOKEN = 'rapidpro-token'
    process.env.RAPIDPRO_BASE_URL = `http://127.0.0.1:${rapidPro.address().port}`
    process.env.RAPIDPRO_ALERT_FLOW_UUID = 'flow-uuid-1'
    try {
      const alerts = await fetchJson(`${baseUrl}/api/v1/alert-events?limit=1`)
      assert.ok(alerts.data.length >= 1)
      const alertId = alerts.data[0].id
      const approveResponse = await fetch(`${baseUrl}/api/v1/alert-events/${alertId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer test-token-${Math.random()}` },
        body: JSON.stringify({ actor: 'test-approver', note: 'Approved for testing' }),
      })
      assert.equal(approveResponse.status, 200)
      const response = await fetch(`${baseUrl}/api/v1/rapidpro/alert-events/${alertId}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urns: ['+254700000000'], actor: 'test' }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.success, true)
      assert.equal(payload.data.status, 'sent')
      assert.equal(received[0].url, '/api/v2/flow_starts.json')
      assert.equal(received[0].authorization, 'Token rapidpro-token')
      assert.deepEqual(received[0].body.urns, ['tel:+254700000000'])
      assert.equal(received[0].body.flow, 'flow-uuid-1')

      const dispatches = await fetchJson(`${baseUrl}/api/v1/rapidpro/dispatches`)
      assert.ok(dispatches.data.some((dispatch) => dispatch.alert_event_id === alertId))
    } finally {
      restoreRapidProEnv(original)
      await new Promise((resolve) => rapidPro.close(resolve))
    }
  })

  it('receives RapidPro webhook payloads as field reports', async () => {
    const original = rapidProEnv()
    process.env.RAPIDPRO_WEBHOOK_SECRET = 'incoming-secret'
    try {
      const incidentResponse = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'RapidPro linked incident',
          incident_type: 'field_report',
          priority: 'medium',
          country: 'KE',
        }),
      })
      const incident = await incidentResponse.json()
      const response = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': 'incoming-secret',
        },
        body: JSON.stringify({
          id: 'rapidpro-message-1',
          from: '+254711111111',
          content: `REPORT ${incident.data.id} Bridge access blocked needs: fuel, water 3.12,35.63`,
          contact: { uuid: 'contact-1', name: 'Field Agent' },
          run: { uuid: 'run-1' },
        }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.success, true)
      assert.equal(payload.data.incident_id, incident.data.id)
      assert.deepEqual(payload.data.needs, ['fuel', 'water'])
      assert.equal(payload.data.latitude, 3.12)
      assert.equal(payload.inbound.from, '+254711111111')

      const inbound = await fetchJson(`${baseUrl}/api/v1/rapidpro/inbound`)
      assert.ok(inbound.data.some((message) => message.source_id === 'rapidpro-message-1'))

      const rejected = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rapidpro-secret': 'wrong' },
        body: JSON.stringify({ content: 'REPORT bad secret' }),
      })
      assert.equal(rejected.status, 401)
    } finally {
      restoreRapidProEnv(original)
    }
  })

  it('exposes data quality and confidence-enhanced assessments', async () => {
    const quality = await fetchJson(`${baseUrl}/api/v1/data-quality`)
    assert.equal(quality.success, true)
    assert.ok(quality.data.some((item) => item.source === 'conflict_csv'))

    const assessments = await fetchJson(`${baseUrl}/api/v1/assessments`)
    assert.equal(assessments.success, true)
    assert.ok(Array.isArray(assessments.data.data_quality))
    assert.ok(assessments.data.operations.counts.open_incidents >= 1)
    assert.ok(Array.isArray(assessments.data.alert_events))
    assert.ok(assessments.data.climate_conflict_risk.every((risk) => Number.isFinite(risk.confidence)))
  })

  it('creates, displays, approves, and distributes generated reports', async () => {
    const receivedWebhooks = []
    const webhook = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      receivedWebhooks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
    })
    const rapidProRequests = []
    const rapidPro = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      rapidProRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ uuid: 'report-flow-start-1' }))
    })
    await new Promise((resolve) => webhook.listen(0, resolve))
    await new Promise((resolve) => rapidPro.listen(0, resolve))
    const original = rapidProEnv()
    process.env.RAPIDPRO_API_TOKEN = 'rapidpro-token'
    process.env.RAPIDPRO_BASE_URL = `http://127.0.0.1:${rapidPro.address().port}`
    process.env.RAPIDPRO_ALERT_FLOW_UUID = 'report-flow-uuid'
    try {
      const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Daily operations SITREP',
          report_type: 'situation_report',
          title_pattern: 'Daily operations SITREP - {{country}} - {{date}}',
          default_filters: { country: 'KE' },
          sections: ['executive_summary', 'incident_summary', 'field_report_summary', 'alert_summary', 'data_quality_summary', 'appendix_sources'],
          actor: 'test',
        }),
      })
      const template = await templateResponse.json()
      assert.equal(templateResponse.status, 201)
      assert.equal(template.data.version, 1)

      const copyResponse = await fetch(`${baseUrl}/api/v1/report-templates/${template.data.id}/copy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Copied SITREP', actor: 'test' }),
      })
      const copied = await copyResponse.json()
      assert.equal(copyResponse.status, 201)
      assert.equal(copied.data.version, 1)
      assert.notEqual(copied.data.id, template.data.id)

      const reportResponse = await fetch(`${baseUrl}/api/v1/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: template.data.id, generate: true, actor: 'test' }),
      })
      const report = await reportResponse.json()
      assert.equal(reportResponse.status, 201)
      assert.equal(report.data.status, 'ready')
      assert.ok(report.data.sections.some((section) => section.id === 'incident_summary'))
      assert.ok(report.data.source_refs.length >= 1)

      const markdownResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/export.md`)
      const markdown = await markdownResponse.text()
      assert.equal(markdownResponse.headers.get('content-type').startsWith('text/markdown'), true)
      assert.match(markdown, /Daily operations SITREP/)
      assert.match(markdown, /Source Appendix/)

      const exportedJson = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}/export.json`)
      assert.equal(exportedJson.data.id, report.data.id)

      const appendixCsv = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/export.csv`)
      const appendixCsvText = await appendixCsv.text()
      assert.equal(appendixCsv.headers.get('content-type').startsWith('text/csv'), true)
      assert.match(appendixCsvText, /report_source_collection/)

      const appendixGeoJson = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}/export.geojson`)
      assert.equal(appendixGeoJson.type, 'FeatureCollection')

      const approveResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test' }),
      })
      const approved = await approveResponse.json()
      assert.equal(approveResponse.status, 200)
      assert.equal(approved.data.status, 'approved')

      const distributeResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/distribute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'test',
          channels: [
            { channel: 'markdown_download' },
            { channel: 'csv' },
            { channel: 'geojson' },
            { channel: 'webhook', url: `http://127.0.0.1:${webhook.address().port}/report` },
            { channel: 'rapidpro_sms', urns: ['+254700000000'] },
          ],
        }),
      })
      const distributed = await distributeResponse.json()
      assert.equal(distributeResponse.status, 201)
      assert.equal(distributed.success, true)
      assert.equal(distributed.report.status, 'distributed')
      assert.equal(distributed.data.length, 5)
      assert.ok(distributed.data.some((run) => run.channel === 'markdown_download' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'csv' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'geojson' && run.status === 'prepared'))
      assert.ok(distributed.data.some((run) => run.channel === 'webhook' && run.status === 'sent'))
      assert.ok(distributed.data.some((run) => run.channel === 'rapidpro_sms' && run.status === 'sent'))
      assert.equal(receivedWebhooks[0].report.id, report.data.id)
      assert.equal(rapidProRequests[0].url, '/api/v2/flow_starts.json')
      assert.equal(rapidProRequests[0].authorization, 'Token rapidpro-token')
      assert.equal(rapidProRequests[0].body.params.report_id, report.data.id)

      const runs = await fetchJson(`${baseUrl}/api/v1/report-distributions?limit=20`)
      assert.ok(runs.data.some((run) => run.report_id === report.data.id))
    } finally {
      restoreRapidProEnv(original)
      await new Promise((resolve) => webhook.close(resolve))
      await new Promise((resolve) => rapidPro.close(resolve))
    }
  })

  it('keeps reports approved when every distribution channel fails', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Failure-path report',
        report_type: 'incident_brief',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'incident_summary', 'appendix_sources'],
        actor: 'test',
      }),
    })
    const template = await templateResponse.json()
    assert.equal(templateResponse.status, 201)

    const reportResponse = await fetch(`${baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: template.data.id, generate: true, actor: 'test' }),
    })
    const report = await reportResponse.json()
    assert.equal(reportResponse.status, 201)

    const approveResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    assert.equal(approveResponse.status, 200)

    const distributeResponse = await fetch(`${baseUrl}/api/v1/reports/${report.data.id}/distribute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'test',
        channels: [{ channel: 'webhook', url: 'http://127.0.0.1:1/report' }],
      }),
    })
    const distributed = await distributeResponse.json()
    assert.equal(distributeResponse.status, 201)
    assert.equal(distributed.success, false)
    assert.equal(distributed.data.length, 1)
    assert.equal(distributed.data[0].status, 'failed')
    assert.equal(distributed.report.status, 'approved')

    const persisted = await fetchJson(`${baseUrl}/api/v1/reports/${report.data.id}`)
    assert.equal(persisted.data.status, 'approved')
  })

  it('records and advances failed report schedules when the template is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-missing-template-'))
    const missingStore = new JsonStore(path.join(dir, 'store.json'))
    missingStore.mode = 'json'
    const missingServer = createServer({ store: missingStore })
    await missingStore.write({
      report_schedules: [{
        id: 'report_schedule_missing_template',
        template_id: 'report_template_missing',
        status: 'active',
        timezone: 'UTC',
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    })
    await new Promise((resolve) => missingServer.listen(0, resolve))
    const missingBase = `http://127.0.0.1:${missingServer.address().port}`
    try {
      const response = await fetch(`${missingBase}/api/v1/report-schedules/run-due`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test' }),
      })
      const payload = await response.json()
      assert.equal(response.status, 201)
      assert.equal(payload.data.length, 1)
      assert.equal(payload.data[0].status, 'failed')
      assert.equal(payload.data[0].error, 'Template not found')
      assert.deepEqual(payload.reports, [])

      const persisted = await missingStore.read()
      const schedule = persisted.report_schedules.find((item) => item.id === 'report_schedule_missing_template')
      assert.ok(schedule.last_run_at)
      assert.ok(Date.parse(schedule.next_run_at) > Date.parse(schedule.last_run_at))
      assert.equal(persisted.reports.some((item) => item === null), false)
      assert.ok(persisted.action_logs.some((log) => log.record_id === payload.data[0].id && log.action === 'failed'))
    } finally {
      await new Promise((resolve) => missingServer.close(resolve))
    }
  })

  it('schedules report templates and records schedule runs', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly intervention update',
        report_type: 'intervention_update',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'intervention_summary', 'field_report_summary', 'appendix_sources'],
      }),
    })
    const template = await templateResponse.json()
    const scheduleResponse = await fetch(`${baseUrl}/api/v1/report-schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: template.data.id,
        timezone: 'Africa/Nairobi',
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        auto_distribute: false,
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)
    assert.equal(schedule.data.status, 'active')

    const runDueResponse = await fetch(`${baseUrl}/api/v1/report-schedules/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.reports.length, 1)
    assert.equal(runDue.data[0].status, 'completed')
    assert.ok(Date.parse(runDue.reports[0].generated_at) > 0)

    const scheduleRuns = await fetchJson(`${baseUrl}/api/v1/report-schedule-runs`)
    const createdRun = scheduleRuns.data.find((run) => run.schedule_id === schedule.data.id)
    assert.ok(createdRun)

    const retryResponse = await fetch(`${baseUrl}/api/v1/report-schedule-runs/${createdRun.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const retry = await retryResponse.json()
    assert.equal(retryResponse.status, 201)
    assert.equal(retry.data.status, 'completed')
  })

  it('auto-distributes reports from due report schedules', async () => {
    const templateResponse = await fetch(`${baseUrl}/api/v1/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Auto distribution digest',
        report_type: 'alert_digest',
        default_filters: { country: 'KE' },
        sections: ['executive_summary', 'alert_summary', 'appendix_sources'],
        distribution_defaults: [{ channel: 'markdown_download' }],
      }),
    })
    const template = await templateResponse.json()
    assert.equal(templateResponse.status, 201)

    const scheduleResponse = await fetch(`${baseUrl}/api/v1/report-schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: template.data.id,
        recurrence: { type: 'interval', minutes: 60 },
        next_run_at: '2026-01-01T00:00:00.000Z',
        auto_distribute: true,
        distribution_defaults: [{ channel: 'markdown_download' }],
      }),
    })
    const schedule = await scheduleResponse.json()
    assert.equal(scheduleResponse.status, 201)

    const runDueResponse = await fetch(`${baseUrl}/api/v1/report-schedules/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    const runDue = await runDueResponse.json()
    assert.equal(runDueResponse.status, 201)
    assert.equal(runDue.data.length, 1)
    assert.equal(runDue.data[0].schedule_id, schedule.data.id)
    assert.equal(runDue.reports[0].status, 'distributed')
    assert.equal(runDue.distributions.length, 1)
    assert.equal(runDue.distributions[0].status, 'prepared')
  })

})

async function fetchJson(url) {
  const response = await fetch(url)
  return response.json()
}

function rawGet(baseUrl, requestPath) {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: 'GET',
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function rapidProEnv() {
  return {
    RAPIDPRO_API_TOKEN: process.env.RAPIDPRO_API_TOKEN,
    RAPIDPRO_BASE_URL: process.env.RAPIDPRO_BASE_URL,
    RAPIDPRO_ALERT_FLOW_UUID: process.env.RAPIDPRO_ALERT_FLOW_UUID,
    RAPIDPRO_ALERT_MODE: process.env.RAPIDPRO_ALERT_MODE,
    RAPIDPRO_ALERT_URNS: process.env.RAPIDPRO_ALERT_URNS,
    RAPIDPRO_ALERT_CONTACTS: process.env.RAPIDPRO_ALERT_CONTACTS,
    RAPIDPRO_ALERT_GROUPS: process.env.RAPIDPRO_ALERT_GROUPS,
    RAPIDPRO_WEBHOOK_SECRET: process.env.RAPIDPRO_WEBHOOK_SECRET,
  }
}

function restoreRapidProEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
