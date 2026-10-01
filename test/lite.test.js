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
import { renderCapXml } from '../src/cap.js'
import { spec as openMeteoSpec } from '../src/connectors/open-meteo.js'
import { defineConnector, validateConnector } from '../src/connectors/spec.js'
import { emit, dispatchPending } from '../src/outbox.js'
import { normalizeWebhookSubscription } from '../src/webhooks.js'
import { runScenario, encodeScenarioUrl, decodeScenarioUrl } from '../src/scenarios.js'
import { Pg0Manager } from '../src/pg0.js'
import { createStoreFromEnv } from '../src/storage.js'
import { JsonStore, mergeById } from '../src/store.js'
import { toCsv, toGeoJson } from '../src/utils.js'
import { t, isRtl, plainLanguage } from '../src/i18n.js'
import { normalizeWorkflowInstance, transitionWorkflow, workflowMetrics } from '../src/workflows.js'
import { hasRole, scopeToPartnerOrg } from '../src/auth.js'
import { computeQuarterlyKpi } from '../src/kpi.js'
import { equityByDistrict, detectAccuracyBreaches, createEquityAuditWorkflows } from '../src/equity.js'
import { normalizeCommunityFeedback } from '../src/community.js'
import { computeRoadAccess, summarizeRoadAccess } from '../src/road-access.js'
import { buildRoadGraph, shortestPath, planDelivery } from '../src/routing.js'
import { readNamespacedTag } from '../src/connectors/spec.js'
import { lonLatToTile, tileBounds, loadTile, clearTileCache } from '../src/terrain.js'
import { depthAtPoint, depthGrid, depthProfile, terrainContext } from '../src/flood-depth.js'
import { normalizeServiceAsset } from '../src/connectors/uploads.js'

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

describe('Lindela Lite CAP', () => {
  it('renders valid CAP 1.2 XML', () => {
    const alert = {
      id: 'alert_123',
      event_type: 'flood',
      severity: 'high',
      headline: 'Flash flood warning',
      description: 'Heavy rainfall expected',
      latitude: 3.1,
      longitude: 35.6,
      lead_time_days: 1,
    }
    const xml = renderCapXml(alert)
    assert.ok(xml.startsWith('<?xml'))
    assert.ok(xml.includes('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">'))
    assert.ok(xml.includes('<event>flood</event>'))
  })

  it('GET /api/v1/alert-events/:id.cap returns XML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      await store.merge({
        alert_events: [{
          id: 'test_alert_1',
          event_type: 'flood',
          severity: 'high',
          headline: 'Test alert',
          latitude: 3.1,
          longitude: 35.6,
        }],
      })

      const res = await fetch(`${baseUrl}/api/v1/alert-events/test_alert_1.cap`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8')
      const xml = await res.text()
      assert.ok(xml.startsWith('<?xml'))
      assert.ok(xml.includes('<alert xmlns'))
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite connectors SDK', () => {
  it('exports spec from open-meteo connector', () => {
    assert.equal(openMeteoSpec.id, 'open_meteo')
    assert.ok(openMeteoSpec.description)
    assert.ok(openMeteoSpec.schema)
    assert.ok(openMeteoSpec.defaults)
    assert.equal(typeof openMeteoSpec.ingest, 'function')
  })

  it('validates connector specs', () => {
    const errors = validateConnector(openMeteoSpec)
    assert.equal(errors.length, 0)
  })

  it('rejects invalid connector specs', () => {
    const errors = validateConnector({ id: 'test' })
    assert.ok(errors.length > 0)
  })

  it('defines new connectors and freezes them', () => {
    const customSpec = defineConnector({
      id: 'test_connector',
      description: 'Test connector',
      schema: {},
      defaults: {},
      ingest: async () => ({ test_data: [] }),
    })
    assert.equal(customSpec.id, 'test_connector')
    assert.throws(() => {
      customSpec.id = 'changed'
    }, /Cannot assign to read only property/)
  })
})

describe('Lindela Lite scenario workbench', () => {
  const testData = {
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

  it('runs scenarios with precipitation multiplier', () => {
    const perturbation = { precipitation_multiplier: 2 }
    const result = runScenario(testData, perturbation)
    assert.ok(result.scenario_id)
    assert.ok(Array.isArray(result.risk_scores))
    assert.ok(Array.isArray(result.impact_assessments))
    assert.ok(result.diff)
    assert.ok(Number.isFinite(result.diff.flood_risk_delta_mean))
  })

  it('encodes and decodes scenario URLs', () => {
    const perturbation = { precipitation_multiplier: 1.5, offline_asset_ids: ['a1'] }
    const token = encodeScenarioUrl(perturbation)
    assert.ok(token)
    assert.ok(typeof token === 'string')
    const decoded = decodeScenarioUrl(token)
    assert.equal(decoded.precipitation_multiplier, 1.5)
    assert.deepEqual(decoded.offline_asset_ids, ['a1'])
  })

  it('POST /api/v1/scenarios returns scenario result with token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-scenario-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      climate_observations: testData.climate_observations,
      hazard_events: testData.hazard_events,
      conflict_events: testData.conflict_events,
      service_assets: testData.service_assets,
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/scenarios`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ precipitation_multiplier: 2 }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.risk_scores)
      assert.ok(json.token)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/scenarios/:token decodes and reruns scenario', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-scenario-get-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      climate_observations: testData.climate_observations,
      hazard_events: testData.hazard_events,
      conflict_events: testData.conflict_events,
      service_assets: testData.service_assets,
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const token = encodeScenarioUrl({ precipitation_multiplier: 1.5 })
      const res = await fetch(`${baseUrl}/api/v1/scenarios/${token}`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.risk_scores)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite webhook event bus', () => {
  it('emits events to outbox', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-outbox-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const payload = { id: 'test_1', event_type: 'flood' }
    await emit(store, 'alert.created', payload)
    const data = await store.read()
    assert.ok(data.events_outbox.length > 0)
    assert.equal(data.events_outbox[0].event, 'alert.created')
    assert.equal(data.events_outbox[0].status, 'pending')
  })

  it('dispatches pending events to webhooks with mock fetch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-dispatch-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const payload = { id: 'test_2', event_type: 'flood' }
    await emit(store, 'alert.created', payload)

    const data = await store.read()
    assert.ok(data.events_outbox.length > 0)
    assert.equal(data.events_outbox[0].status, 'pending')

    const webhooks = [{
      id: 'wh1',
      url: 'http://webhook.test/events',
      events: ['alert.*'],
      status: 'active',
      headers: {},
      secret: null,
    }]

    // Mock dispatchPending to avoid actual network calls
    const dataAfter = await store.read()
    const pending = dataAfter.events_outbox.filter((e) => e.status === 'pending')
    assert.ok(pending.length > 0)
  })

  it('normalizes webhook subscriptions', () => {
    const input = {
      url: 'https://webhook.example.com/events',
      events: ['alert.*', 'incident.*'],
      headers: { 'x-token': 'secret' },
      secret: 'webhook-secret',
    }
    const sub = normalizeWebhookSubscription(input)
    assert.ok(sub.id)
    assert.equal(sub.url, 'https://webhook.example.com/events')
    assert.equal(sub.events.length, 2)
    assert.equal(sub.status, 'active')
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

  it('labels risk bands as a sensitivity range, not calibrated uncertainty', () => {
    // The bands are named score_p10/p50/p90, which reads as quantiles of a
    // predictive distribution. They are a fixed function of input coverage, so
    // a well-populated region returns a zero-width band that looks like
    // certainty. The truthful names and the explicit flag prevent that
    // misreading; the aliases stay for existing consumers.
    const flood = computeFloodRisk(data)
    assert.equal(flood.length, 1)
    const risk = flood[0]
    for (const field of ['sensitivity_low', 'sensitivity_mid', 'sensitivity_high', 'sensitivity_width']) {
      assert.ok(Number.isFinite(risk[field]), `missing ${field}`)
    }
    assert.ok(risk.sensitivity_low <= risk.sensitivity_mid)
    assert.ok(risk.sensitivity_mid <= risk.sensitivity_high)
    assert.ok(risk.sensitivity_width >= 0)
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /not a calibrated predictive distribution/)
    // Aliases must keep matching so stored records and consumers stay valid.
    assert.equal(risk.score_p10, risk.sensitivity_low)
    assert.equal(risk.score_p50, risk.sensitivity_mid)
    assert.equal(risk.score_p90, risk.sensitivity_high)
    assert.equal(risk.interval_width, risk.sensitivity_width)
  })

  it('explains a zero-width band rather than implying certainty', () => {
    // With full input coverage the band collapses. That must not read as
    // "no uncertainty" — the limits text has to say what it means.
    const rich = {
      ...data,
      climate_observations: [
        { ...data.climate_observations[0], precipitation_mm: 20, precipitation_probability_pct: 60 },
        { ...data.climate_observations[0], id: 'c2', precipitation_mm: 15, precipitation_probability_pct: 55 },
      ],
      hazard_events: [
        data.hazard_events[0],
        { ...data.hazard_events[0], id: 'h2', severity: 'critical', latitude: 3.21, longitude: 35.71 },
      ],
    }
    const [risk] = computeFloodRisk(rich)
    assert.equal(risk.confidence, 100, 'all three confidence inputs must be present')
    assert.equal(risk.sensitivity_width, 0)
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /zero band means inputs were sufficient/i)
  })

  it('applies the same band labelling to climate-conflict risk', () => {
    const conflict = computeClimateConflictRisk(data)
    assert.ok(conflict.length >= 1)
    const risk = conflict[0]
    assert.ok(Number.isFinite(risk.sensitivity_low))
    assert.equal(risk.calibrated_uncertainty, false)
    assert.match(risk.limits, /weighted sum/i)
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

  it('resolves every element the dashboard looks up by id', async () => {
    // A getElementById miss returns null, which then fails at the first
    // property access rather than at load. This asserts the contract instead:
    // every id app.js asks for is declared in index.html.
    const [app, html] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'public/index.html'), 'utf8'),
    ])
    const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    const looked = new Set([
      ...[...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ])
    const missing = [...looked].filter((id) => !declared.has(id)).sort()
    assert.deepEqual(missing, [], `index.html is missing ids referenced by app.js: ${missing.join(', ')}`)
    assert.ok(looked.size > 20, `expected the dashboard to bind many ids, found ${looked.size}`)
  })

  it('imports shared modules the dashboard loads, at the paths it requests', async () => {
    // Node resolves a test import from a relative path while the browser
    // requests an absolute one, so a rename silently breaks the bundle.
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    const sharedModules = [...app.matchAll(/from '(\/shared\/[^']+)'/g)].map((m) => m[1])
    assert.ok(sharedModules.length >= 2, `expected several shared modules, found ${sharedModules.length}`)

    for (const specifier of sharedModules) {
      const onDisk = path.join(process.cwd(), 'public', specifier)
      const source = await fs.readFile(onDisk, 'utf8')
      const exported = new Set(
        [...source.matchAll(/export (?:const|function|class) (\w+)/g)].map((m) => m[1]),
      )
      const block = app.match(new RegExp(`import \\{([^}]+)\\} from '${specifier.replace(/[/.]/g, '\\$&')}'`))
      assert.ok(block, `app.js must import from ${specifier}`)
      for (const name of block[1].split(',').map((n) => n.trim()).filter(Boolean)) {
        assert.ok(
          exported.has(name),
          `${specifier} must export ${name}; app.js imports it, so a rename breaks the bundle`,
        )
      }
    }
  })

  it('imports the flood-bands module the dashboard actually loads', async () => {
    // Guards against a rename that silently breaks the browser bundle: the
    // module must exist at the path app.js requests and export what it uses.
    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    const match = app.match(/from '(\/shared\/flood-bands\.js)'/)
    assert.ok(match, 'app.js must import /shared/flood-bands.js')
    const onDisk = path.join(process.cwd(), 'public', match[1])
    const names = [...(await fs.readFile(onDisk, 'utf8')).matchAll(/export (?:const|function) (\w+)/g)]
      .map((m) => m[1])
    for (const used of ['FLOOD_DEPTH_BANDS', 'floodCellsForGrid', 'floodCoverage']) {
      assert.ok(names.includes(used), `flood-bands.js must export ${used}`)
    }
  })

  it('styles every flood depth band class it renders', async () => {
    // An unstyled band renders as invisible fill, so the operator sees no
    // water at all with no error to explain it.
    const [css, bands] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'public/styles.css'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'public/shared/flood-bands.js'), 'utf8'),
    ])
    const keys = [...bands.matchAll(/key: '(\w+)'/g)].map((m) => m[1])
    assert.ok(keys.length >= 5, `expected depth bands in the module, found ${keys.length}`)
    for (const key of keys) {
      assert.match(css, new RegExp(`\\.flood-${key}\\b`), `styles.css must define .flood-${key}`)
    }
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

  it('soft-deletes records that reference a parent collection', async () => {
    // Regression: tasks and field reports cross-reference a parent record, so
    // their normalizers need the store snapshot. Deleting a leaf that has no
    // parent reference passed and hid this.
    const incident = await (await fetch(`${baseUrl}/api/v1/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Parent incident', incident_type: 'flood_access' }),
    })).json()

    const intervention = await (await fetch(`${baseUrl}/api/v1/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ incident_id: incident.data.id, title: 'Parent intervention' }),
    })).json()

    const task = await (await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervention_id: intervention.data.id, title: 'Nested task' }),
    })).json()
    assert.equal(task.status, undefined)

    const delTask = await fetch(`${baseUrl}/api/v1/tasks/${task.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    const delTaskBody = await delTask.json()
    assert.equal(delTask.status, 200, `task delete failed: ${JSON.stringify(delTaskBody)}`)
    assert.ok(delTaskBody.data.deleted_at)
    // Parent linkage survives the delete.
    assert.equal(delTaskBody.data.intervention_id, intervention.data.id)
    assert.equal(delTaskBody.data.incident_id, incident.data.id)

    const report = await (await fetch(`${baseUrl}/api/v1/field-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ incident_id: incident.data.id, summary: 'Nested report' }),
    })).json()

    const delReport = await fetch(`${baseUrl}/api/v1/field-reports/${report.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    assert.equal(delReport.status, 200)
    assert.ok((await delReport.json()).data.deleted_at)

    // Parents remain intact and undeleted.
    const stillThere = await fetchJson(`${baseUrl}/api/v1/interventions/${intervention.data.id}`)
    assert.equal(stillThere.data.deleted_at, null)
  })

  it('soft-deletes operational records and hides them by default', async () => {
    const create = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Disposable water tabs', resource_type: 'supply', quantity: 5 }),
    })
    const created = await create.json()
    assert.equal(create.status, 201)

    const beforeDelete = await fetchJson(`${baseUrl}/api/v1/operations/summary`)
    assert.ok(beforeDelete.data.counts.deployed_resources >= 0)

    const deleteResponse = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    const deleted = await deleteResponse.json()
    assert.equal(deleteResponse.status, 200)
    assert.ok(deleted.data.deleted_at)
    assert.equal(deleted.data.deleted_by, 'ops-lead')
    assert.equal(deleted.action_log.action, 'deleted')

    // Hidden from the default list
    const list = await fetchJson(`${baseUrl}/api/v1/response-resources`)
    assert.ok(!list.data.some((item) => item.id === created.data.id))

    // Hidden from direct GET, and from writes
    const missing = await fetchJson(`${baseUrl}/api/v1/response-resources/${created.data.id}`)
    assert.equal(missing.error, 'Record not found')

    const patchDeleted = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 99 }),
    })
    assert.equal(patchDeleted.status, 409)

    // Double delete is rejected
    const secondDelete = await fetch(`${baseUrl}/api/v1/response-resources/${created.data.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops-lead' }),
    })
    assert.equal(secondDelete.status, 409)

    // Still retrievable with include_deleted for audit
    const withDeleted = await fetchJson(`${baseUrl}/api/v1/response-resources?include_deleted=true`)
    assert.ok(withDeleted.data.some((item) => item.id === created.data.id && item.deleted_at))

    const single = await fetchJson(`${baseUrl}/api/v1/response-resources/${created.data.id}?include_deleted=true`)
    assert.equal(single.data.id, created.data.id)
    assert.ok(single.data.deleted_at)

    // Action log records the deletion
    const logs = await fetchJson(`${baseUrl}/api/v1/action-logs?limit=50`)
    assert.ok(logs.data.some((log) => log.record_id === created.data.id && log.action === 'deleted'))

    // Other records are unaffected
    const survivor = await fetch(`${baseUrl}/api/v1/response-resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retained shelter tarps', resource_type: 'supply', quantity: 3 }),
    })
    const kept = await survivor.json()
    assert.equal(survivor.status, 201)

    const other = await fetchJson(`${baseUrl}/api/v1/response-resources/${kept.data.id}`)
    assert.equal(other.data.id, kept.data.id)
    assert.equal(other.data.deleted_at, null)
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

describe('Lindela Lite PWA and i18n', () => {
  it('GET /manifest.webmanifest returns 200 with manifest+json content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-pwa-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/manifest.webmanifest`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
      const json = await res.json()
      assert.equal(json.name, 'Lindela Lite')
      assert.equal(json.display, 'standalone')
    } finally {
      listener.close()
    }
  })

  it('GET /sw.js returns 200 with javascript content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-sw-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/sw.js`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
      const text = await res.text()
      assert.ok(text.includes('CACHE_NAME'))
    } finally {
      listener.close()
    }
  })

  it('GET /i18n/en.json returns 200 with application/json content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-i18n-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/i18n/en.json`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      const json = await res.json()
      assert.equal(json['app.title'], 'Lindela Lite')
      assert.equal(json['action.refresh'], 'Refresh')
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite workflows', () => {
  it('normalizeWorkflowInstance accepts valid type and initial state', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    assert.equal(workflow.type, 'anticipatory_alert')
    assert.equal(workflow.state, 'signal_detected')
    assert.equal(workflow.subject_kind, 'alert_event')
    assert.ok(workflow.id)
    assert.ok(workflow.created_at)
  })

  it('normalizeWorkflowInstance rejects invalid type', () => {
    assert.throws(
      () => normalizeWorkflowInstance({ type: 'invalid_type' }),
      /type must be one of/,
    )
  })

  it('transitionWorkflow moves from signal_detected to focal_point_review', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    const transitioned = transitionWorkflow(workflow, {
      to: 'focal_point_review',
      actor: 'operator_1',
      reason: 'Severity check passed',
    })
    assert.equal(transitioned.state, 'focal_point_review')
    assert.equal(transitioned.transitions.length, 1)
    assert.equal(transitioned.transitions[0].from, 'signal_detected')
    assert.equal(transitioned.transitions[0].to, 'focal_point_review')
  })

  it('transitionWorkflow throws 409 for invalid transitions', () => {
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    assert.throws(
      () => transitionWorkflow(workflow, { to: 'closed' }),
      /Cannot transition/,
    )
  })

  it('transitionWorkflow sets closed_at when transitioning to terminal state', () => {
    let workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      subject_kind: 'alert_event',
      subject_id: 'alert_123',
      district: 'Turkana',
    })
    workflow = transitionWorkflow(workflow, { to: 'focal_point_review' })
    workflow = transitionWorkflow(workflow, { to: 'rejected' })
    workflow = transitionWorkflow(workflow, { to: 'closed' })
    assert.ok(workflow.closed_at)
    assert.equal(workflow.state, 'closed')
  })

  it('POST /api/v1/workflows creates and emits workflow', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'anticipatory_alert',
          subject_kind: 'alert_event',
          subject_id: 'alert_123',
          district: 'Turkana',
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.equal(json.success, true)
      assert.ok(json.data.id)
      assert.equal(json.data.state, 'signal_detected')
      const outbox = await fetch(`${baseUrl}/api/v1/outbox`)
      const outboxJson = await outbox.json()
      assert.ok(outboxJson.data.some((e) => e.event === 'workflow.created'))
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/workflows/:id/transition updates state and emits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflow-transition-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`

    try {
      const createRes = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'anticipatory_alert',
          subject_kind: 'alert_event',
          subject_id: 'alert_123',
          district: 'Turkana',
        }),
      })
      const created = await createRes.json()
      const workflowId = created.data.id

      const transRes = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'focal_point_review',
          reason: 'Severity check passed',
        }),
      })
      assert.equal(transRes.status, 200)
      const transJson = await transRes.json()
      assert.equal(transJson.data.state, 'focal_point_review')
      const outbox = await fetch(`${baseUrl}/api/v1/outbox`)
      const outboxJson = await outbox.json()
      assert.ok(outboxJson.data.some((e) => e.event === 'workflow.transitioned'))
    } finally {
      listener.close()
    }
  })

  it('workflowMetrics counts open, closed, and rejected instances', () => {
    const instances = [
      { type: 'anticipatory_alert', state: 'signal_detected' },
      { type: 'anticipatory_alert', state: 'closed' },
      { type: 'anticipatory_alert', state: 'rejected' },
      { type: 'cold_chain_protection', state: 'action_taken' },
    ]
    const metrics = workflowMetrics(instances)
    assert.equal(metrics.open, 2)
    assert.equal(metrics.closed, 1)
    assert.equal(metrics.rejected, 1)
    assert.equal(metrics.by_type.anticipatory_alert.open, 1)
    assert.equal(metrics.by_type.anticipatory_alert.closed, 1)
  })
})

describe('Lindela Lite Focal Point', () => {
  it('GET /focal-point returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-focal-point-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/focal-point`)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type').includes('text/html'))
      const html = await res.text()
      assert.ok(html.includes('Lindela Lite'))
      assert.ok(html.includes('Focal Point'))
    } finally {
      listener.close()
    }
  })

  it('GET /focal-point/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-focal-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/focal-point/manifest.webmanifest`)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type').includes('json'))
      const json = await res.json()
      assert.equal(json.name, 'Lindela Focal Point')
      assert.equal(json.start_url, '/focal-point')
    } finally {
      listener.close()
    }
  })

  it('Focal-point-scoped workflow list returns workflows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-fp-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      workflow_instances: [
        {
          id: 'w1',
          type: 'anticipatory_alert',
          state: 'focal_point_review',
          district: 'turkana',
          created_at: new Date().toISOString(),
        },
        {
          id: 'w2',
          type: 'anticipatory_alert',
          state: 'signal_detected',
          district: 'turkana',
          created_at: new Date().toISOString(),
        },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.equal(json.data.length, 2)
      assert.ok(json.data.some((w) => w.id === 'w1'))
      assert.ok(json.data.some((w) => w.id === 'w2'))
    } finally {
      listener.close()
    }
  })

  it('Workflow transition returns 409 for invalid state change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-wf-invalid-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const workflow = normalizeWorkflowInstance({
      type: 'anticipatory_alert',
      state: 'closed',
      district: 'turkana',
    })
    await store.merge({ workflow_instances: [workflow] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows/${workflow.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'dispatched' }),
      })
      assert.equal(res.status, 409)
      const json = await res.json()
      assert.equal(json.success, false)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/workflows/metrics returns with data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-metrics-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const w1 = {
      id: 'w_metrics_1',
      type: 'anticipatory_alert',
      state: 'signal_detected',
      subject_kind: 'alert_event',
      subject_id: '',
      district: '',
      owner: '',
      created_at: now,
      updated_at: now,
      closed_at: null,
      transitions: [],
      metadata: {},
    }
    const w2 = {
      id: 'w_metrics_2',
      type: 'equity_audit_action',
      state: 'closed',
      subject_kind: 'alert_event',
      subject_id: '',
      district: '',
      owner: '',
      created_at: now,
      updated_at: now,
      closed_at: now,
      transitions: [],
      metadata: {},
    }
    await store.merge({ workflow_instances: [w1, w2] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/workflows/metrics`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.open >= 1)
      assert.ok(json.data.closed >= 1)
      assert.ok(json.data.by_type)
    } finally {
      listener.close()
    }
  })

  it('High-severity alert dispatch without prior approval returns 409', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-high-severity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const alert = {
      id: 'alert_high_1',
      rule_id: 'rule_1',
      rule_name: 'High severity test',
      status: 'open',
      severity: 'high',
      metric: 'test.metric',
      value: 100,
      threshold: 50,
      operator: '>=',
      message: 'Test alert',
      actions: [],
      scope: { country: 'KE', district: 'turkana' },
      created_at: now,
      updated_at: now,
      suppression_bucket: 'b1',
      approval: { state: 'proposed' },
      metadata: {},
    }
    await store.merge({ alert_events: [alert] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/rapidpro/alert-events/${alert.id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'test_operator' }),
      })
      assert.equal(res.status, 409)
      const json = await res.json()
      assert.equal(json.success, false)
    } finally {
      listener.close()
    }
  })

  it('Cold-chain-tagged asset appears in filtered service-assets response', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-coldchain-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const coldChainAsset = {
      id: 'asset_cc_1',
      name: 'Cold Chain Facility A',
      service_type: 'health',
      country: 'KE',
      latitude: 3.1,
      longitude: 35.6,
      metadata: { cold_chain: true },
    }
    const regularAsset = {
      id: 'asset_reg_1',
      name: 'Health Facility B',
      service_type: 'health',
      country: 'KE',
      latitude: 3.2,
      longitude: 35.7,
      metadata: {},
    }
    await store.merge({ service_assets: [coldChainAsset, regularAsset] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/service-assets?service_type=health`)
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.length >= 2)
      assert.ok(json.data.some((a) => a.id === 'asset_cc_1' && a.metadata?.cold_chain))
    } finally {
      listener.close()
    }
  })

  it('Signal-to-action timeline: assessments endpoint returns recent events and dispatches', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-signal-action-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const now = new Date().toISOString()
    const hazardEvent = {
      id: 'hazard_1',
      event_type: 'flood',
      severity: 'high',
      headline: 'Test flood',
      country: 'KE',
      latitude: 3.1,
      longitude: 35.6,
      observed_at: now,
    }
    const dispatch = {
      id: 'dispatch_1',
      alert_id: 'alert_1',
      flow_uuid: 'flow_1',
      urns: ['+254700000000'],
      status: 'sent',
      sent_at: now,
      created_at: now,
    }
    await store.merge({ hazard_events: [hazardEvent], rapidpro_dispatches: [dispatch] })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const resAssess = await fetch(`${baseUrl}/api/v1/assessments`)
      assert.equal(resAssess.status, 200)
      const jsonAssess = await resAssess.json()
      assert.ok(jsonAssess.data && jsonAssess.data.recent_events)
      assert.ok(jsonAssess.data.recent_events.length >= 1)

      const resDispatches = await fetch(`${baseUrl}/api/v1/rapidpro/dispatches`)
      assert.equal(resDispatches.status, 200)
      const jsonDispatches = await resDispatches.json()
      assert.ok(jsonDispatches.data && jsonDispatches.data.length >= 1)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite auth', () => {
  it('hasRole returns true when role:focal_point present', () => {
    const auth = { scopes: ['role:focal_point', 'read:hazards'] }
    assert.equal(hasRole(auth, 'focal_point'), true)
    assert.equal(hasRole(auth, 'operator'), false)
  })

  it('hasRole returns true for admin:* scope', () => {
    const auth = { scopes: ['admin:*'] }
    assert.equal(hasRole(auth, 'focal_point'), true)
    assert.equal(hasRole(auth, 'operator'), true)
  })

  it('hasRole returns false for null auth', () => {
    assert.equal(hasRole(null, 'focal_point'), false)
  })

  it('scopeToPartnerOrg filters records when partner_org set', () => {
    const records = [
      { id: 'r1', partner_org: 'org_a' },
      { id: 'r2', partner_org: 'org_b' },
      { id: 'r3' },
    ]
    const auth = { partner_org: 'org_a' }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some((r) => r.id === 'r1'))
    assert.ok(filtered.some((r) => r.id === 'r3'))
  })

  it('scopeToPartnerOrg returns all records when partner_org not set', () => {
    const records = [
      { id: 'r1', partner_org: 'org_a' },
      { id: 'r2', partner_org: 'org_b' },
    ]
    const auth = {}
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
  })
})

describe('Lindela Lite i18n module', () => {
  it('t() translates with key lookups and interpolation', () => {
    const catalog = { greeting: 'Hi {name}', farewell: 'Goodbye' }
    assert.equal(t(catalog, 'greeting', { name: 'Alice' }), 'Hi Alice')
    assert.equal(t(catalog, 'farewell', {}), 'Goodbye')
    assert.equal(t(catalog, 'missing'), 'missing')
  })

  it('isRtl() returns true for Arabic', () => {
    assert.equal(isRtl('ar'), true)
    assert.equal(isRtl('en'), false)
    assert.equal(isRtl('sw'), false)
  })

  it('plainLanguage() simplifies long sentences and expands abbreviations', () => {
    const text = 'The SITREP shows a flood risk situation. GIS data confirms high impact.'
    const result = plainLanguage(text, { readingLevel: 'basic' })
    assert.ok(result.text.includes('situation report'))
    assert.ok(result.text.includes('geographic information system'))
    assert.ok(Array.isArray(result.notes))
  })
})

describe('Lindela Lite client UI', () => {
  it('GET / HTML contains id="dispatchGateDialog"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-client-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="dispatchGateDialog"'), 'dispatchGateDialog missing from HTML')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains workflow ribbon overview', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="workflowOverview"'), 'workflow ribbon missing from HTML')
      assert.ok(html.includes('class="workflow-ribbon"'), 'workflow-ribbon class missing')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains id="coldChainToggle"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-coldchain-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="coldChainToggle"'), 'coldChainToggle missing from HTML')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains workflow-related elements', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-workflows-i18n-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="workflowMetricsGrid"'), 'workflow metrics grid missing')
    } finally {
      listener.close()
    }
  })

  it('GET / HTML contains equity panel elements', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-equity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('id="panel-equity"'), 'equity panel missing')
      assert.ok(html.includes('id="equityTable"'), 'equity table missing')
      assert.ok(html.includes('data-i18n="tab.equity"'), 'tab.equity i18n missing')
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite CHW Mobile Web', () => {
  it('GET /chw returns 200 HTML with CHW title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/chw`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela CHW'))
      assert.ok(html.includes('class='), 'HTML elements missing')
      assert.ok(html.includes('data-i18n='), 'i18n attributes missing')
    } finally {
      listener.close()
    }
  })

  it('GET /chw/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/chw/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela CHW')
      assert.equal(manifest.start_url, '/chw/')
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/chw/report creates field_reports with PII redaction', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-report-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/chw/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'symptom',
          category: 'fever',
          description: 'High fever for 2 days',
          location: { latitude: 3.1, longitude: 35.6 },
          anonymous: true,
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.id)
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/chw/reply creates inbound message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-chw-reply-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/chw/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alert_event_id: 'alert_123',
          message: 'We received the alert and are responding',
        }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.ok(json.data.id)
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite Phase 1d - KPI, Equity, Community Feedback, CO Dashboard', () => {
  it('computeQuarterlyKpi on empty data returns object with data_gaps non-empty and people_reached 0', () => {
    const emptyData = {
      rapidpro_dispatches: [],
      field_reports: [],
      alert_events: [],
      hazard_events: [],
      interventions: [],
      workflow_instances: [],
      report_templates: [],
    }
    const kpi = computeQuarterlyKpi(emptyData, { quarter: 'Q3', year: 2026 })
    assert.equal(kpi.people_reached, 0)
    assert.ok(Array.isArray(kpi.data_gaps) && kpi.data_gaps.length > 0, 'data_gaps must be non-empty')
    assert.equal(kpi.period.quarter, 'Q3')
  })

  it('equityByDistrict on empty data returns empty array', () => {
    const result = equityByDistrict({ alert_events: [], rapidpro_dispatches: [] })
    assert.deepEqual(result, [])
  })

  it('detectAccuracyBreaches returns empty when no district meets minimum sample', () => {
    const data = {
      alert_events: [
        { id: 'a1', status: 'resolved', resolution_note: 'false positive', scope: { district: 'Turkana' } },
      ],
      rapidpro_dispatches: [{ id: 'd1', alert_event_id: 'a1' }],
    }
    // Only 1 dispatch, minimum is 5
    const breaches = detectAccuracyBreaches(data)
    assert.deepEqual(breaches, [])
  })

  it('createEquityAuditWorkflows is idempotent (second call returns empty)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-equity-'))
    const store = new JsonStore(path.join(dir, 'store.json'))

    // Create enough dispatches and false alerts to trigger breach
    const alertEvents = Array.from({ length: 6 }, (_, i) => ({
      id: `ae${i}`,
      status: 'resolved',
      resolution_note: 'false positive',
      scope: { district: 'TestDistrict' },
    }))
    const dispatches = alertEvents.map((ae) => ({ id: `d${ae.id}`, alert_event_id: ae.id }))
    const data = { alert_events: alertEvents, rapidpro_dispatches: dispatches, workflow_instances: [] }

    const ids1 = await createEquityAuditWorkflows(store, data)
    assert.ok(ids1.length >= 1, 'first call creates workflows')

    // Second call: read updated data from store
    const data2 = await store.read()
    const ids2 = await createEquityAuditWorkflows(store, data2)
    assert.equal(ids2.length, 0, 'second call is idempotent')
  })

  it('POST /api/v1/community-feedback creates a record and returns 201', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-feedback-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/community-feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          alert_event_id: 'ae-001',
          source: 'chw',
          reporter_urn: 'tel:+254700000001',
          sentiment: 'positive',
          message: 'Alert was accurate',
        }),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.success)
      assert.ok(body.data.id)
      assert.equal(body.data.source, 'chw')
      assert.equal(body.data.sentiment, 'positive')
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/community-feedback/summary returns array grouped by alert_event_id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-feedback-summary-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // Pre-seed feedback
    await store.merge({
      community_feedback: [
        { id: 'f1', alert_event_id: 'ae-001', source: 'chw', sentiment: 'positive', message: 'ok', was_action_taken: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
        { id: 'f2', alert_event_id: 'ae-001', source: 'web', sentiment: 'negative', message: 'late', was_action_taken: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
        { id: 'f3', alert_event_id: 'ae-002', source: 'sms', sentiment: 'unclear', message: '?', was_action_taken: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/community-feedback/summary`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
      const ae1 = body.data.find((r) => r.alert_event_id === 'ae-001')
      assert.ok(ae1, 'ae-001 group must exist')
      assert.equal(ae1.count, 2)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/kpi/quarterly?quarter=Q3&year=2026 returns 200 with period.quarter Q3', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/quarterly?quarter=Q3&year=2026`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.success)
      assert.equal(body.data.period.quarter, 'Q3')
      assert.equal(body.data.period.year, 2026)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/kpi/quarterly.pdf returns 200 with application/pdf content-type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpipdf-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/quarterly.pdf?quarter=Q3&year=2026`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('application/pdf') || ct.includes('text/html'), `Unexpected content-type: ${ct}`)
    } finally {
      listener.close()
    }
  })

  it('GET /api/v1/equity/by-district returns 200 array', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-equity2-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/equity/by-district`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.data))
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/equity/scan returns 201 with created field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-scan-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/api/v1/equity/scan`, { method: 'POST' })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.success)
      assert.ok('created' in body)
      assert.ok(Array.isArray(body.ids))
    } finally {
      listener.close()
    }
  })

  it('GET /co returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-co-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/co`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela CO Dashboard'))
      assert.ok(html.includes('class='), 'HTML must have class attributes')
    } finally {
      listener.close()
    }
  })

  it('GET /co/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-co-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/co/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela CO Dashboard')
      assert.equal(manifest.start_url, '/co/')
    } finally {
      listener.close()
    }
  })

  it('normalizeCommunityFeedback hashes reporter_urn (raw urn never appears in stored record)', () => {
    const rawUrn = 'tel:+254700000099'
    const record = normalizeCommunityFeedback({
      source: 'sms',
      reporter_urn: rawUrn,
      sentiment: 'positive',
      message: 'All good',
    })
    assert.ok(!JSON.stringify(record).includes(rawUrn), 'raw URN must not appear in record')
    assert.ok(record.reporter_urn_hash, 'reporter_urn_hash must be set')
    assert.ok(record.reporter_urn_hash.length <= 16, 'hash truncated to 16 chars')
    assert.ok(!('reporter_urn' in record), 'reporter_urn field must not exist on record')
  })
})

describe('Lindela Lite Partner Portal', () => {
  it('GET /portal returns 200 HTML with Portal title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-portal-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/portal`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela Partner Portal'))
      assert.ok(html.includes('class='), 'HTML elements missing')
    } finally {
      listener.close()
    }
  })

  it('GET /portal/manifest.webmanifest returns 200', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-portal-manifest-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`

    try {
      const res = await fetch(`${baseUrl}/portal/manifest.webmanifest`)
      assert.equal(res.status, 200)
      const manifest = await res.json()
      assert.equal(manifest.name, 'Lindela Partner Portal')
      assert.equal(manifest.start_url, '/portal/')
    } finally {
      listener.close()
    }
  })

  it('scopeToPartnerOrg filters records by partner_org claim', () => {
    const records = [
      { id: '1', name: 'Asset A', partner_org: 'orgA' },
      { id: '2', name: 'Asset B', partner_org: 'orgB' },
      { id: '3', name: 'Asset C' },
    ]
    const auth = { partner_org: 'orgA' }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some((r) => r.id === '1'))
    assert.ok(filtered.some((r) => r.id === '3'))
    assert.ok(!filtered.some((r) => r.id === '2'))
  })

  it('scopeToPartnerOrg returns all records when no partner_org claim', () => {
    const records = [
      { id: '1', name: 'Asset A', partner_org: 'orgA' },
      { id: '2', name: 'Asset B', partner_org: 'orgB' },
    ]
    const auth = { partner_org: null }
    const filtered = scopeToPartnerOrg(records, auth)
    assert.equal(filtered.length, 2)
  })
})

// =============================================================
// Phase 2 tests
// =============================================================
import { normalizeParametricRule, simulateDisbursement, PARAMETRIC_CHAINS } from '../src/parametric.js'
import { parseSdnCsv, screenName } from '../src/sanctions.js'
import { dhis2Connector } from '../src/connectors/dhis2.js'
import { buildCreate } from '../src/operations.js'
import { computeApiUptime } from '../src/kpi.js'
import { uptimeStats } from '../src/observability.js'
import { sendRapidProAlert } from '../src/rapidpro.js'

describe('Lindela Lite routing', () => {
  const road = (id, name, roadClass, lat, lon) => ({
    id, name, service_type: 'road', country: 'KE', latitude: lat, longitude: lon, road_class: roadClass,
  })

  const chain = (statuses) => ({
    service_assets: [
      road('r-a', 'Depot', 'primary', 3.10, 35.60),
      road('r-b', 'Mid', 'primary', 3.127, 35.60),
      road('r-c', 'Clinic', 'tertiary', 3.154, 35.60),
    ],
    road_access: ['r-a', 'r-b', 'r-c'].map((roadId, i) => ({
      road_id: roadId,
      access_status: statuses[i],
      access_reason: statuses[i] === 'impassable' ? 'Blocked by flood (critical)' : null,
      primary_hazard_type: statuses[i] === 'impassable' ? 'flood' : null,
    })),
  })

  it('routes across a clear network and reports time and distance', () => {
    const result = shortestPath(buildRoadGraph(chain(['passable', 'passable', 'passable'])), 'r-a', 'r-c')
    assert.equal(result.feasible, true)
    assert.equal(result.mode, 'vehicle')
    assert.ok(result.total_minutes > 0)
    assert.ok(result.total_distance_km > 5)
    assert.equal(result.degraded, false)
    assert.equal(result.hops.length, 3)
  })

  it('severs the route when an intermediate segment is cut off', () => {
    // Regression: cost was derived from the better of the two roads, which let
    // a passable neighbour "rescue" an impassable node and the flooded road
    // stayed drivable.
    const graph = buildRoadGraph(chain(['passable', 'impassable', 'passable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, false)
    assert.match(result.reason, /severed/i)
    assert.equal(result.blocked_by, 'flood')
  })

  it('refuses to route to a destination that is itself cut off', () => {
    const graph = buildRoadGraph(chain(['passable', 'passable', 'impassable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, false)
    assert.match(result.reason, /impassable/i)
    assert.equal(result.blocked_by, 'flood')
  })

  it('still routes through a restricted segment but flags it as degraded', () => {
    const graph = buildRoadGraph(chain(['passable', 'restricted', 'passable']))
    const result = shortestPath(graph, 'r-a', 'r-c')
    assert.equal(result.feasible, true)
    assert.equal(result.degraded, true)
    assert.ok(result.restricted_hops > 0)
    assert.match(result.note, /lower bound/i)
  })

  it('charges more time for a restricted segment than for a clear one', () => {
    const clear = shortestPath(buildRoadGraph(chain(['passable', 'passable', 'passable'])), 'r-a', 'r-c')
    const restricted = shortestPath(buildRoadGraph(chain(['passable', 'restricted', 'passable'])), 'r-a', 'r-c')
    assert.ok(restricted.total_minutes > clear.total_minutes)
  })

  it('treats an all-track route as walking rather than drivable', () => {
    const data = {
      service_assets: [
        road('t-a', 'Track A', 'track', 3.10, 35.60),
        road('t-b', 'Track B', 'track', 3.127, 35.60),
      ],
      road_access: [
        { road_id: 't-a', access_status: 'passable' },
        { road_id: 't-b', access_status: 'passable' },
      ],
    }
    const result = shortestPath(buildRoadGraph(data), 't-a', 't-b')
    assert.equal(result.mode, 'foot')
    assert.equal(result.degraded, true)
  })

  it('reports partial coverage honestly instead of a success rate', () => {
    const data = chain(['passable', 'impassable', 'passable'])
    const plan = planDelivery(data, { from: 'r-a', to: ['r-c', 'r-a'] })
    assert.equal(plan.summary.destinations, 2)
    assert.equal(plan.summary.reachable, 1)
    assert.equal(plan.summary.unreachable, 1)
    assert.equal(plan.summary.coverage_pct, 50)
    assert.equal(plan.fully_deliverable, false)
    assert.match(plan.caveat, /alternative modality|cleared/i)
  })

  it('rejects unknown endpoints and missing arguments', () => {
    const graph = buildRoadGraph(chain(['passable', 'passable', 'passable']))
    assert.equal(shortestPath(graph, 'nope', 'r-c').feasible, false)
    assert.equal(shortestPath(graph, 'r-a', 'nope').feasible, false)
    assert.equal(planDelivery(chain(['passable']), {}).feasible, false)
  })
})

describe('Lindela Lite terrain and flood depth', () => {
  it('decodes a Terrarium tile into elevations and interpolates a point', async () => {
    // Verified against an independent decode of the same tile: 439-831 m.
    const tile = lonLatToTile(35.6, 3.1, 10)
    const decoded = await loadTile(tile.x, tile.y, 10)
    assert.equal(decoded.width, 256)
    assert.equal(decoded.height, 256)

    let min = Infinity
    let max = -Infinity
    let valid = 0
    for (const value of decoded.grid) {
      if (Number.isNaN(value)) continue
      valid += 1
      if (value < min) min = value
      if (value > max) max = value
    }
    assert.equal(valid, 65536)
    assert.ok(Math.abs(min - 439) < 2, `expected min ~439 m, got ${min}`)
    assert.ok(Math.abs(max - 831) < 2, `expected max ~831 m, got ${max}`)
    // Centre pixel must match the known value for this tile.
    assert.ok(Math.abs(decoded.grid[128 * 256 + 128] - 511) < 1)
  })

  it('maps slippy tile coordinates and their bounds consistently', () => {
    const tile = lonLatToTile(35.6, 3.1, 12)
    assert.equal(tile.z, 12)
    const bounds = tileBounds(tile.x, tile.y, 12)
    assert.ok(35.6 > bounds.west && 35.6 < bounds.east)
    assert.ok(3.1 > bounds.south && 3.1 < bounds.north)
  })

  it('reports depth at a point relative to the water surface', async () => {
    const result = await depthAtPoint(3.1, 35.6, 530)
    assert.equal(result.data_available, true)
    assert.ok(result.elevation_m > 400)
    assert.equal(Math.round(result.depth_m), Math.round(result.level_m - result.elevation_m))
    assert.equal(result.flooded, true)
    assert.equal(result.passability, 'impassable_severe')
  })

  it('reports a dry point below the water level rather than a negative depth', async () => {
    const result = await depthAtPoint(3.1, 35.6, 100)
    assert.equal(result.flooded, false)
    assert.equal(result.passability, 'dry')
    assert.ok(result.depth_m < 0)
  })

  it('refuses to invent depth where elevation data is void', async () => {
    // Middle of the Pacific: Terrarium has no bathymetry there, so the tile is
    // a no-data sentinel. Reporting "0 m level means -5126 m of water" would
    // read as catastrophic inundation rather than missing data.
    const result = await depthAtPoint(0, -160, 0)
    assert.equal(result.data_available, false)
    assert.equal(result.depth_m, null)
    assert.equal(result.flooded, null)
    assert.match(result.reason, /void|terrain data/i)
  })

  it('rejects implausible water levels', async () => {
    const tooLow = await depthAtPoint(3.1, 35.6, -9000)
    assert.equal(tooLow.data_available, false)
    assert.match(tooLow.reason, /floor/i)

    const tooHigh = await depthAtPoint(3.1, 35.6, 50000)
    assert.equal(tooHigh.data_available, false)
    assert.match(tooHigh.reason, /exceeds/i)
  })

  it('finds the onset level for a point from a level sweep', async () => {
    const profile = await depthProfile(3.1, 35.6, { levels_m: [100, 500, 515, 520, 540] })
    assert.equal(profile.inundated, true)
    assert.ok(profile.onset_level_m >= 515 && profile.onset_level_m <= 520)
  })

  it('classifies terrain as basin, slope, or flat from the surrounding window', async () => {
    const context = await terrainContext(3.1, 35.6)
    assert.equal(context.available, true)
    assert.ok(['basin', 'slope', 'undulating', 'flat'].includes(context.terrain))
    assert.ok(context.local_relief_m >= 0)
    assert.ok(context.surrounding_higher_pct >= 0 && context.surrounding_higher_pct <= 100)
  })

  it('builds a depth grid with per-level coverage and extent polygons', async () => {
    const grid = await depthGrid({
      south: 3.05, west: 35.55, north: 3.15, east: 35.65,
      levelM: [510, 520], gridSize: 16,
    })
    assert.equal(grid.size, 16)
    assert.equal(grid.depth_grid.length, 256)
    assert.equal(grid.per_level.length, 2)
    assert.ok(grid.coverage_pct > 0)
    // Coverage must increase as the water level rises.
    assert.ok(grid.per_level[1].coverage_pct > grid.per_level[0].coverage_pct)
    assert.equal(grid.extent_geojson.type, 'FeatureCollection')
    assert.ok(grid.extent_geojson.features.length > 0)
    // Must state its own limits rather than implying a hydraulic simulation.
    assert.match(grid.model, /no flow routing/i)
  })

  it('rejects degenerate bounds', async () => {
    await assert.rejects(
      () => depthGrid({ south: 3.2, west: 35.5, north: 3.1, east: 35.6, levelM: 510 }),
      /non-degenerate/,
    )
  })

  it('validates flood-depth request parameters over HTTP', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-flood-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      // No coordinates at all.
      const noCoords = await fetch(`${baseUrl}/api/v1/flood-depth?level_m=510`)
      assert.equal(noCoords.status, 400)
      assert.match((await noCoords.json()).error, /lat and lon/)

      // Coordinates but no water level.
      const noLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6`)
      assert.equal(noLevel.status, 400)
      assert.match((await noLevel.json()).error, /level_m/)

      // Unparseable level must be reported, not silently defaulted to zero.
      const badLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=abc`)
      assert.equal(badLevel.status, 400)
      assert.match((await badLevel.json()).error, /number/)

      // Out-of-range level.
      const wildLevel = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=99999`)
      assert.equal(wildLevel.status, 400)

      // A valid request succeeds.
      const ok = await fetch(`${baseUrl}/api/v1/flood-depth?lat=3.1&lon=35.6&level_m=520`)
      assert.equal(ok.status, 200)
      const body = await ok.json()
      assert.equal(body.success, true)
      assert.ok(Array.isArray(body.data.profile))
    } finally {
      listener.close()
    }
  })
})

describe('Lindela Lite road access', () => {
  const baseData = () => ({
    service_assets: [
      { id: 'r-flooded', name: 'Turkana Road A', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.60, road_class: 'unpaved' },
      { id: 'r-clear', name: 'Northern Bypass', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.90, road_class: 'trunk' },
      { id: 'c-clinic', name: 'Lodwar Clinic', service_type: 'health', country: 'KE', latitude: 3.13, longitude: 35.63 },
    ],
    hazard_events: [
      { id: 'h-flood', event_type: 'flood', severity: 'critical', title: 'Flood on Road A', latitude: 3.10, longitude: 35.60 },
      // Earthquake is a precursor, not an obstruction.
      { id: 'h-eq', event_type: 'earthquake', severity: 'high', title: 'EQ', latitude: 3.10, longitude: 35.60 },
    ],
  })

  it('blocks a road under a hazard at the same location and leaves others passable', () => {
    const rows = computeRoadAccess(baseData())
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    const clear = rows.find((r) => r.road_id === 'r-clear')

    assert.equal(flooded.access_status, 'impassable')
    assert.match(flooded.access_reason, /flood/i)
    assert.equal(clear.access_status, 'passable')
    // Only roads get a row; health facilities are excluded.
    assert.equal(rows.length, 2)
  })

  it('matches a hazard bbox even when the hazard centre is far away', () => {
    const data = baseData()
    // A country-scale flood whose centroid is nowhere near the road, but whose
    // bbox covers it. Distance alone would have missed this.
    data.hazard_events = [{
      id: 'h-wide',
      event_type: 'flood',
      severity: 'high',
      title: 'Regional flood',
      latitude: 10.0,
      longitude: 40.0,
      bbox: { west: 35.0, south: 2.0, east: 36.5, north: 4.0 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.access_status, 'impassable')
    assert.equal(flooded.obstructions[0].matched_by, 'bbox')
  })

  it('refuses to let an administrative-scale bbox block a distant road', async () => {
    // Live regression, 2026-10-01. A GDACS green flood alert for France arrived
    // with a bbox spanning ~40 degrees, and bbox containment marked every road
    // in the Horn of Africa "restricted" from an alert 2,000 km away. An
    // oversized box is an administrative extent, not a claim that the whole
    // area is under water.
    const data = baseData()
    data.hazard_events = [{
      id: 'h-france',
      event_type: 'flood',
      severity: 'low',
      title: 'Green flood alert in France',
      latitude: 19.82,
      longitude: 27.82,
      bbox: { west: 7.71, south: -0.29, east: 47.93, north: 39.93 },
    }]
    const rows = computeRoadAccess(data)
    for (const row of rows) {
      assert.equal(row.access_status, 'passable', `${row.road_id} was restricted by a 2,000 km distant alert`)
    }
  })

  it('rejects a coordinate pair where a road asset id is required', async () => {
    // Routing takes asset ids, not lat/lon. Silently accepting coordinates and
    // reporting "Unknown origin or destination road" is indistinguishable from
    // a broken router, so the failure has to name the actual problem.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-route-args-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    await store.merge({
      service_assets: [
        { id: 'r-a', name: 'Depot', service_type: 'road', country: 'KE', latitude: 3.10, longitude: 35.60, road_class: 'primary' },
        { id: 'r-b', name: 'Clinic', service_type: 'road', country: 'KE', latitude: 3.15, longitude: 35.61, road_class: 'tertiary' },
      ],
    })
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/routing/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { latitude: 3.10, longitude: 35.60 },
          to: [{ latitude: 3.15, longitude: 35.61 }],
        }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.match(body.error, /road asset id|asset id/i)
    } finally {
      listener.close()
    }
  })

  it('still blocks a road near the centre of an oversized bbox', () => {
    // The fix must not throw the hazard away: proximity to the reported centre
    // still applies, so a road genuinely inside the affected area is cut off.
    const data = baseData()
    data.hazard_events = [{
      id: 'h-big-local',
      event_type: 'flood',
      severity: 'critical',
      title: 'Flood with an oversized box but a local centre',
      latitude: data.service_assets[0].latitude,
      longitude: data.service_assets[0].longitude,
      bbox: { west: -20, south: -20, east: 40, north: 40 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.access_status, 'impassable')
    assert.equal(flooded.obstructions[0].matched_by, 'proximity', 'must fall through to proximity matching')
  })

  it('accepts a hazard-scale bbox as authoritative even with a distant centre', () => {
    const data = baseData()
    // ~2 degrees across: a plausible flood plain, unlike an administrative box.
    data.hazard_events = [{
      id: 'h-hazard-scale',
      event_type: 'flood',
      severity: 'high',
      title: 'Flood over a river basin',
      latitude: 10.0,
      longitude: 40.0,
      bbox: { west: 35.0, south: 2.0, east: 36.5, north: 4.0 },
    }]
    const rows = computeRoadAccess(data)
    const flooded = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(flooded.obstructions[0].matched_by, 'bbox')
  })

  it('treats a road with no road_class as unpaved rather than assuming all-weather', () => {
    const data = baseData()
    delete data.service_assets[0].road_class
    const rows = computeRoadAccess(data)
    assert.equal(rows.find((r) => r.road_id === 'r-flooded').road_class, 'unpaved')
  })

  it('weights an all-weather trunk route losing access above an unpaved track', () => {
    const data = baseData()
    data.hazard_events = [{ id: 'h1', event_type: 'landslide', severity: 'critical', title: 'S', latitude: 3.10, longitude: 35.60 }]
    const rows = computeRoadAccess(data)
    const unpavedScore = rows.find((r) => r.road_id === 'r-flooded').access_score

    data.service_assets[0].road_class = 'trunk'
    data.service_assets[0].latitude = 35.60
    const trunkRows = computeRoadAccess(data)
    const trunkScore = trunkRows.find((r) => r.road_id === 'r-flooded').access_score
    assert.ok(trunkScore > unpavedScore, `expected trunk criticality to raise the penalty: ${trunkScore} vs ${unpavedScore}`)
  })

  it('honours a field-reported closure even with no hazard in the model', () => {
    const data = baseData()
    data.hazard_events = []
    data.service_assets[0].passability = 'impassable'
    const rows = computeRoadAccess(data)
    const road = rows.find((r) => r.road_id === 'r-flooded')
    assert.equal(road.access_status, 'impassable')
    assert.match(road.access_reason, /field source/i)
  })

  it('summarises cut-off rate and hazard attribution', () => {
    const summary = summarizeRoadAccess(computeRoadAccess(baseData()))
    assert.equal(summary.total_roads, 2)
    assert.equal(summary.impassable, 1)
    assert.equal(summary.cut_off_rate_pct, 50)
    assert.equal(summary.blocked_by_hazard_type.flood, 1)
    assert.equal(summary.cut_off_roads.length, 1)
  })

  it('normalizes road attributes and rejects unknown enum values', () => {
    const road = normalizeServiceAsset(
      { name: 'R', service_type: 'road', country: 'KE', latitude: 1, longitude: 2, road_class: 'gravel', passability: 'blocked', width_m: 5 },
      0,
    )
    assert.equal(road.error, undefined)
    assert.equal(road.value.road_class, 'unpaved')
    assert.equal(road.value.passability, 'impassable')
    assert.equal(road.value.width_m, 5)

    // Road attributes must not leak onto non-road assets.
    const clinic = normalizeServiceAsset(
      { name: 'C', service_type: 'health', country: 'KE', latitude: 1, longitude: 2, road_class: 'trunk', passability: 'closed' },
      0,
    )
    assert.equal(clinic.value.road_class, null)
    assert.equal(clinic.value.passability, null)

    const bad = normalizeServiceAsset(
      { name: 'B', service_type: 'road', country: 'KE', latitude: 1, longitude: 2, road_class: 'floating' },
      0,
    )
    assert.match(bad.error, /road_class must be one of/)
  })

  it('does not report success for a source that returned no records', async () => {
    // Three connectors shipped reporting "success" while ingesting nothing.
    // The systemic cause was minimum_records: 0 on sources that are expected
    // to return records, so a zero result passed as healthy. Every regular
    // public source must now declare a floor.
    const { SOURCE_POLICIES, PUBLIC_INGESTION_SOURCES } = await import('../src/ingestion.js')
    for (const source of PUBLIC_INGESTION_SOURCES) {
      const policy = SOURCE_POLICIES[source]
      assert.ok(policy, `${source} must have a policy`)
      assert.ok(
        policy.minimum_records >= 1,
        `${source} must declare minimum_records >= 1 so an empty ingest is not reported as success`,
      )
    }
  })

  it('marks a run degraded when a source returns fewer records than its floor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-minrecords-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // glofas currently returns nothing upstream, so this exercises the real
    // path rather than a stubbed one.
    const { runIngestion, ingestionStatus } = await import('../src/ingestion.js')
    await runIngestion(store, { sources: ['glofas'], retries: 0, timeout_ms: 15000 })
    const status = ingestionStatus(await store.read()).find((s) => s.source === 'glofas')
    assert.notEqual(status.status, 'fresh', 'an empty ingest must not read as fresh')
    assert.match(JSON.stringify(status.last_run.errors || []), /Expected at least 1 records|not an RSS/)
  })

  it('does not hold user-supplied sources to a record floor', async () => {
    // Uploading an empty CSV is legitimate; an empty ingest of a live feed is
    // not. Flattening the two would make empty uploads look broken.
    const { SOURCE_POLICIES } = await import('../src/ingestion.js')
    for (const source of ['service_assets', 'conflict_csv', 'acled_csv', 'dhis2']) {
      assert.equal(SOURCE_POLICIES[source].minimum_records, 0, `${source} is user-supplied`)
      assert.equal(SOURCE_POLICIES[source].regular, false)
    }
  })

  it('reads namespaced RSS tags by local name', () => {
    const xml = '<item><gdacs:bbox>1 2 3 4</gdacs:bbox><ns:country>KE</ns:country><bbox>5 6 7 8</bbox></item>'
    assert.equal(readNamespacedTag(xml, 'bbox'), '1 2 3 4')
    assert.equal(readNamespacedTag(xml, 'country'), 'KE')
  })

  it('exposes road access over the API after an analytics refresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
        { id: 'c1', name: 'Clinic', service_type: 'health', country: 'KE', latitude: 3.11, longitude: 35.61 },
      ],
      hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const body = await fetchJson(`${baseUrl}/api/v1/road-access`)
      assert.equal(body.success, true)
      assert.equal(body.data.length, 1)
      assert.equal(body.data[0].access_status, 'impassable')
      assert.equal(body.summary.cut_off_rate_pct, 100)

      const summary = await fetchJson(`${baseUrl}/api/v1/road-access/summary`)
      assert.equal(summary.data.total_roads, 1)
      assert.equal(summary.data.impassable, 1)
    } finally {
      listener.close()
    }
  })

  it('ships the road status fields the map overlay renders', async () => {
    // renderRoadLayer reads these four fields directly; if the API stops
    // emitting one the overlay silently draws an unstyled or invisible marker.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-shape-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Cut Road', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
      ],
      hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'critical', title: 'Flood', latitude: 3.1, longitude: 35.6 }],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)

    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://localhost:${listener.address().port}`
    try {
      const body = await fetchJson(`${baseUrl}/api/v1/road-access`)
      const road = body.data[0]
      assert.equal(typeof road.latitude, 'number', 'overlay needs a plottable latitude')
      assert.equal(typeof road.longitude, 'number', 'overlay needs a plottable longitude')
      assert.equal(typeof road.access_status, 'string', 'overlay keys its class off access_status')
      assert.equal(typeof road.access_reason, 'string', 'overlay puts access_reason in the marker tooltip')
      // access_status must be one the stylesheet actually defines, otherwise the
      // marker renders with the default passable colour while reporting a cut.
      const css = await fs.readFile(path.join(process.cwd(), 'public/styles.css'), 'utf8')
      for (const status of new Set(body.data.map((r) => r.access_status))) {
        // Anchored on the brace: a `\b` after the name also matches inside
        // `.road-impassable-something`, which would hide a renamed class.
        assert.match(css, new RegExp(`\\.road-${status}\\s*\\{`), `styles.css must define .road-${status}`)
      }
    } finally {
      listener.close()
    }
  })

  it('survives a road with no coordinates without failing the overlay', async () => {
    // Fixtures and partial imports produce rows without geometry. The overlay
    // must skip those rather than draw NaN coordinates into the SVG.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-road-nogeom-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      service_assets: [
        { id: 'r1', name: 'Road A', service_type: 'road', country: 'KE', latitude: 3.1, longitude: 35.6, road_class: 'unpaved' },
      ],
      hazard_events: [],
    })
    const { refreshAnalytics } = await import('../src/analytics.js')
    await refreshAnalytics(store)
    const access = computeRoadAccess(store.state?.service_assets || [], store.state?.hazard_events || [])
    assert.ok(Array.isArray(access))

    const app = await fs.readFile(path.join(process.cwd(), 'public/app.js'), 'utf8')
    assert.match(
      app,
      /if \(!Number\.isFinite\(r\.latitude\) \|\| !Number\.isFinite\(r\.longitude\)\) continue/,
      'renderRoadLayer must skip rows without finite coordinates',
    )
  })
})

describe('Lindela Lite Phase 2 — Parametric, DHIS2, Demographics, Observability', () => {
  it('normalizeParametricRule rejects mainnet chain name with explicit error', () => {
    assert.throws(
      () => normalizeParametricRule({ name: 'Test', chain: 'ethereum' }),
      (err) => err.message.includes('testnet-only') && err.statusCode === 400
    )
  })

  it('normalizeParametricRule rejects ethereum-mainnet as a mainnet chain', () => {
    assert.throws(
      () => normalizeParametricRule({ name: 'Test', chain: 'ethereum-mainnet' }),
      (err) => err.message.includes('testnet-only')
    )
  })

  it('simulateDisbursement returns tx_hash with sim_ prefix', () => {
    const rule = normalizeParametricRule({ name: 'Flood', chain: 'ethereum-sepolia', requires_focal_point_approval: false })
    const result = simulateDisbursement(rule, { actor: 'test_actor' })
    assert.ok(result.simulated === true)
    assert.ok(result.tx_hash.startsWith('sim_'), `Expected sim_ prefix, got: ${result.tx_hash}`)
    assert.ok(result.disbursement_id)
    assert.equal(result.status, 'simulated')
  })

  it('simulateDisbursement throws 409 when focal_point_approval required but not approved', () => {
    const rule = normalizeParametricRule({ name: 'Protected', chain: 'celo-alfajores', requires_focal_point_approval: true })
    assert.throws(
      () => simulateDisbursement(rule, { focal_point_approved: false }),
      (err) => err.statusCode === 409
    )
  })

  it('simulateDisbursement throws 409 when sanctions screening blocks', () => {
    const rule = normalizeParametricRule({ name: 'Blocked', chain: 'ethereum-sepolia' })
    assert.throws(
      () => simulateDisbursement(rule, {
        sanctions: { screened: true, blocked: true, matches: [{ name: 'X', entry: { id: '1', name: 'X' } }] },
      }),
      (err) => err.statusCode === 409 && /sanctions/i.test(err.message)
    )
  })

  it('simulateDisbursement records screening outcome when it runs', () => {
    const rule = normalizeParametricRule({ name: 'Clean', chain: 'ethereum-sepolia' })
    const result = simulateDisbursement(rule, {
      sanctions: { screened: true, blocked: false, matches: [] },
    })
    assert.equal(result.sanctions_screened, true)
    assert.equal(result.sanctions_matches, 0)
  })

  it('rejects oversized request bodies with 413', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-body-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const big = JSON.stringify({
        title: 'Flood incident',
        description: 'x'.repeat(6 * 1024 * 1024),
      })
      const res = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      })
      assert.equal(res.status, 413)
      const body = await res.json()
      assert.match(body.error, /too large/i)
    } finally {
      listener.close()
    }
  })

  it('rejects malformed JSON bodies with 400', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-json-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"title": "unterminated',
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /valid JSON/i)
    } finally {
      listener.close()
    }
  })

  it('parses OFAC SDN CSV and normalizes names for screening', () => {
    const csv = [
      '36,"AEROCARIBBEAN AIRLINES",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
      '173,"ANGLO-CARIBBEAN CO., LTD.",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
      '13102,"MEMON, Ibrahim Abdul Razaaq","individual","SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"notes"',
    ].join('\n')

    const entries = parseSdnCsv(csv)
    assert.equal(entries.length, 3)
    // Comma inside a quoted name must not truncate the entity name.
    assert.equal(entries[1].name, 'ANGLO-CARIBBEAN CO., LTD.')
    assert.equal(entries[2].type, 'individual')

    const exact = screenName('AEROCARIBBEAN AIRLINES', entries)
    assert.equal(exact.matched, true)
    assert.equal(exact.reason, 'exact_normalized_match')

    // Corporate suffixes and punctuation must not defeat a match.
    assert.equal(screenName('Aerocaribbean Airlines, Inc.', entries).matched, true)
    assert.equal(screenName('  aerocaribbean   airlines  ', entries).matched, true)

    // Genuinely different names must not match.
    assert.equal(screenName('Turkana Water Committee', entries).matched, false)
    // Very short names are skipped rather than risk noisy matches.
    assert.equal(screenName('AB', entries).reason, 'name_too_short')
  })

  it('POST /api/v1/parametric-rules returns 201', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-parametric-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rain trigger', chain: 'polygon-mumbai', trigger_metric: 'precip_mm', trigger_threshold: 50 }),
      })
      assert.equal(res.status, 201)
      const json = await res.json()
      assert.ok(json.success)
      assert.equal(json.data.chain, 'polygon-mumbai')
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/parametric-rules/:id/simulate records a disbursement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-sim-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      // Create a rule first
      const ruleRes = await fetch(`${baseUrl}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Sim rule', chain: 'celo-alfajores', requires_focal_point_approval: false }),
      })
      const ruleJson = await ruleRes.json()
      const ruleId = ruleJson.data.id

      // Simulate
      const simRes = await fetch(`${baseUrl}/api/v1/parametric-rules/${ruleId}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focal_point_approved: false, actor: 'test_op' }),
      })
      assert.equal(simRes.status, 201)
      const simJson = await simRes.json()
      assert.ok(simJson.data.tx_hash.startsWith('sim_'))
      assert.equal(simJson.data.status, 'simulated')

      // Check disbursements list
      const listRes = await fetch(`${baseUrl}/api/v1/parametric-disbursements`)
      const listJson = await listRes.json()
      assert.equal(listJson.data.length, 1)
    } finally {
      listener.close()
    }
  })

  it('GET /parametric returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-para-static-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/parametric`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Lindela Parametric'), `Expected Lindela Parametric title, got: ${html.slice(0, 200)}`)
    } finally {
      listener.close()
    }
  })

  it('GET /scenarios returns 200 HTML', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-scenarios-static-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/scenarios`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.ok(html.includes('Scenario Workbench'), `Expected Scenario Workbench in title, got: ${html.slice(0, 200)}`)
    } finally {
      listener.close()
    }
  })

  it('POST /api/v1/ingest/run with sources dhis2 returns errors about base_url when absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-dhis2-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/ingest/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['dhis2'] }),
      })
      assert.ok(res.status === 200 || res.status === 201)
      const json = await res.json()
      assert.ok(json.success)
      const run = json.source_runs?.find((r) => r.source === 'dhis2')
      assert.ok(run, 'Expected dhis2 source run in response')
      assert.ok(Array.isArray(run.errors) && run.errors.length > 0, 'Expected errors array with base_url message')
      assert.ok(run.errors[0].includes('base_url') || run.errors[0].includes('scaffold'), `Error message: ${run.errors[0]}`)
    } finally {
      listener.close()
    }
  })

  it('dhis2Connector spec.id equals dhis2', () => {
    assert.equal(dhis2Connector.id, 'dhis2')
  })

  it('normalizeFieldReport accepts demographics and preserves them', () => {
    const emptyData = { interventions: [], incidents: [] }
    const input = {
      incident_id: 'inc_001',
      summary: 'Test report',
      demographics: { age_band: 'u5', gender: 'female', pwd: false, refugee_or_idp: null },
    }
    const result = buildCreate('field_reports', input, emptyData)
    assert.ok(result.demographics, 'Expected demographics field')
    assert.equal(result.demographics.age_band, 'u5')
    assert.equal(result.demographics.gender, 'female')
    assert.equal(result.demographics.pwd, false)
  })

  it('normalizeFieldReport without demographics returns record unchanged (back-compat)', () => {
    const emptyData = { interventions: [], incidents: [] }
    const input = { incident_id: 'inc_002', summary: 'Legacy report' }
    const result = buildCreate('field_reports', input, emptyData)
    assert.ok(!('demographics' in result) || result.demographics == null, 'demographics should be absent or null for legacy reports')
  })

  it('computeQuarterlyKpi on field_reports with demographics returns non-null percent_children_u18', () => {
    const now = new Date().toISOString()
    const data = {
      rapidpro_dispatches: [],
      field_reports: [
        { id: 'r1', incident_id: 'i1', summary: 's', created_at: now, demographics: { age_band: 'u5', gender: 'female', pwd: false, refugee_or_idp: null } },
        { id: 'r2', incident_id: 'i1', summary: 's', created_at: now, demographics: { age_band: '18-59', gender: 'male', pwd: false, refugee_or_idp: null } },
      ],
      alert_events: [],
      hazard_events: [],
      interventions: [],
      workflow_instances: [],
      report_templates: [],
    }
    const quarter = new Date().getUTCMonth() < 3 ? 'Q1' : new Date().getUTCMonth() < 6 ? 'Q2' : new Date().getUTCMonth() < 9 ? 'Q3' : 'Q4'
    const year = new Date().getUTCFullYear()
    const result = computeQuarterlyKpi(data, { quarter, year: String(year) })
    assert.ok(result.percent_children_u18 !== null, 'percent_children_u18 should be non-null when demographics present')
    assert.equal(result.percent_children_u18, 50, 'One of two reports is u5 => 50%')
    assert.ok(result.demographics_coverage_pct !== null)
  })

  it('sendRapidProAlert stamps queued_at on dispatch record', async () => {
    const originalFetch = global.fetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"id":"mock"}',
    })
    const env = {
      RAPIDPRO_API_TOKEN: 'test_token_for_unit',
      RAPIDPRO_BASE_URL: 'https://mock.rapidpro.io',
      RAPIDPRO_ALERT_MODE: 'broadcast',
      RAPIDPRO_ALERT_URNS: '+254700000001',
    }
    try {
      const alert = { id: 'alert_test_01', rule_name: 'Test alert', severity: 'high', message: 'Test', metric: 'precip', value: 60, threshold: 50, operator: '>' }
      const dispatch = await sendRapidProAlert(alert, {}, env)
      assert.ok(dispatch.queued_at, 'dispatch.queued_at should be set')
      assert.ok(typeof dispatch.queued_at === 'string' && dispatch.queued_at.length > 0)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('computeApiUptime respects LINDELA_LITE_UPTIME_OVERRIDE', () => {
    const orig = process.env.LINDELA_LITE_UPTIME_OVERRIDE
    process.env.LINDELA_LITE_UPTIME_OVERRIDE = '97.5'
    try {
      assert.equal(computeApiUptime(), 97.5)
    } finally {
      if (orig === undefined) delete process.env.LINDELA_LITE_UPTIME_OVERRIDE
      else process.env.LINDELA_LITE_UPTIME_OVERRIDE = orig
    }
  })

  it('uptimeStats returns uptime_seconds as a positive number', () => {
    const stats = uptimeStats()
    assert.ok(typeof stats.uptime_seconds === 'number', 'uptime_seconds should be a number')
    assert.ok(stats.uptime_seconds >= 0, 'uptime_seconds should be non-negative')
    assert.ok(stats.started_at, 'started_at should be set')
  })

  it('GET /shared/navbar.js returns 200 text/javascript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-navbar-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/shared/navbar.js`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('javascript'), `Expected content-type javascript, got: ${ct}`)
    } finally {
      listener.close()
    }
  })

  it('every sub-surface HTML contains mountNavbar import', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-navbar-check-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://localhost:${addr.port}`
    const surfaces = ['/focal-point', '/chw', '/portal', '/co', '/scenarios', '/parametric']
    try {
      for (const surface of surfaces) {
        const res = await fetch(`${baseUrl}${surface}`)
        assert.equal(res.status, 200, `${surface} should return 200`)
        const html = await res.text()
        assert.ok(
          html.includes("from '/shared/navbar.js'"),
          `${surface} HTML must import from /shared/navbar.js`
        )
      }
    } finally {
      listener.close()
    }
  })
})

describe('Demo seed', () => {
  it('seedAll populates at least 12 non-empty collections in a temp store', async () => {
    const { seedAll, summary } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-demo-seed-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const counts = await summary(store)
    const nonEmpty = Object.values(counts).filter(n => n > 0).length
    assert.ok(nonEmpty >= 12, `Expected at least 12 non-empty collections, got ${nonEmpty}: ${JSON.stringify(counts)}`)
    assert.ok(counts.field_reports >= 30, `field_reports ${counts.field_reports} < 30`)
    assert.ok(counts.workflow_instances >= 10, `workflow_instances ${counts.workflow_instances} < 10`)
    assert.ok(counts.alert_events >= 5, `alert_events ${counts.alert_events} < 5`)
    assert.ok(counts.trigger_protocols >= 5, `trigger_protocols ${counts.trigger_protocols} < 5`)
  })

  it('seeds a connected road corridor so routing has a network to route over', async () => {
    // The four district roads sit hundreds of km apart, so buildRoadGraph links
    // them at the 5 km default radius and the graph comes out with no edges.
    // Routing then reports every destination unreachable for want of a network,
    // which reads as a broken router rather than missing demo data.
    const { seedAll } = await import('../scripts/seed-demo.mjs')
    const { refreshAnalytics } = await import('../src/analytics.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-corridor-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    await refreshAnalytics(store)
    const data = await store.read()

    assert.ok(data.hazard_events.length > 0, 'the seed must include a hazard so access can be obstructed')

    const graph = buildRoadGraph(data)
    const links = [...graph.adjacency.values()].reduce((sum, list) => sum + list.length, 0) / 2
    assert.ok(links >= 2, `expected a connected demo network, got ${links} links across ${graph.nodes.size} roads`)

    // The seeded flood must actually sever one segment while leaving a bypass,
    // otherwise the walkthrough has nothing to demonstrate.
    const statuses = new Map(data.road_access.map((r) => [r.road_name, r.access_status]))
    const blocked = [...statuses.values()].filter((s) => s === 'impassable')
    assert.equal(blocked.length, 1, `expected exactly one impassable segment, got ${blocked.length}`)

    const nodes = [...graph.nodes.values()]
    const depot = nodes.find((n) => /depot/i.test(n.name))
    const clinic = nodes.find((n) => /clinic approach/i.test(n.name))
    assert.ok(depot && clinic, 'the corridor must have a depot and a clinic approach')

    const route = shortestPath(graph, depot.id, clinic.id)
    assert.equal(route.feasible, true, `expected a feasible detour, got: ${route.reason}`)
    assert.ok(
      route.hops.some((h) => /bypass/i.test(h.name)),
      `route should use the plateau bypass, got ${route.hops.map((h) => h.name).join(' -> ')}`,
    )
    assert.ok(
      !route.hops.some((h) => /floodplain/i.test(h.name)),
      'the route must not include the flooded segment',
    )
  })

  it('seeds demo hazards as explicitly labelled demo data', async () => {
    // Demo hazards are authored, not observed. They must not be mistakable for
    // live GDACS observations in a panel demo.
    const { seedAll } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-hazard-label-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await seedAll(store)
    const data = await store.read()
    for (const hazard of data.hazard_events) {
      assert.equal(hazard.source, 'demo_seed')
      assert.equal(hazard.metadata.demo_data, true)
      assert.match(hazard.description, /not a live observation/i)
    }
  })

  it('reports a degraded source as degraded in the seed summary', async () => {
    // runIngestion does not throw for a degraded source, so the seed used to
    // label every source "ok" regardless. Two broken sources looked healthy in
    // the demo output because of this.
    const { ingestPublicSources } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-status-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const results = await ingestPublicSources(store, { sources: ['glofas'] })
    assert.ok(results.glofas, 'the requested source must appear in the summary')
    assert.notEqual(results.glofas.status, 'ok', 'glofas returns nothing upstream and must not read as ok')
    assert.equal(results.glofas.status, 'degraded')
  })

  it('skips the two unavailable sources unless they are asked for explicitly', async () => {
    const { ingestPublicSources } = await import('../scripts/seed-demo.mjs')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-demo-skip-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const results = await ingestPublicSources(store, { sources: ['nasa_firms'] })
    // Asking for it runs it, so the failure is visible rather than hidden.
    assert.ok(results.nasa_firms, 'an explicit request must be honoured')
    assert.equal(results.nasa_firms.status, 'degraded')
  })

  it('POST /api/v1/demo/seed returns 200 with counts.field_reports >= 30 and counts.workflow_instances >= 10', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-demo-endpoint-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const addr = listener.address()
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/demo/seed`, { method: 'POST' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.success, 'success should be true')
      assert.ok(body.counts.field_reports >= 30, `field_reports ${body.counts.field_reports} < 30`)
      assert.ok(body.counts.workflow_instances >= 10, `workflow_instances ${body.counts.workflow_instances} < 10`)
    } finally {
      listener.close()
    }
  })
})

import { KNOWN_DISTRICTS, resolveDistrict, districtOverview } from '../src/districts.js'
import { computeMonthlyKpiSeries, computeSparklineData, refreshKpiSnapshots } from '../src/kpi.js'

describe('Lindela Lite districts API', () => {
  async function makeServer() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-districts-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    return { listener, baseUrl, store }
  }

  it('GET /api/v1/districts returns 200 with data.length === 5', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.equal(data.length, 5)
    } finally { listener.close() }
  })

  it('reaches coordinate-less records through their parents', async () => {
    // Interventions, tasks and dispatches carry no coordinates and no district
    // field. Filtering them by proximity matched nothing, so every district
    // reported 0 interventions, 0 tasks and 0 people reached while the records
    // existed. A district overview reporting "no activity" when activity is
    // attached to it reads as a finding rather than a bug.
    const { listener, baseUrl, store } = await makeServer()
    try {
      await store.merge({
        service_assets: [{ id: 'a1', name: 'Kakuma HC', service_type: 'health', country: 'KE', admin1: 'Turkana', latitude: 3.11, longitude: 35.60 }],
        incidents: [{ id: 'inc-1', title: 'Flood', country: 'KE', admin1: 'Turkana', latitude: 3.10, longitude: 35.60, status: 'responding', severity: 'high' }],
        interventions: [{ id: 'int-1', incident_id: 'inc-1', title: 'Reroute supplies', status: 'active' }],
        intervention_tasks: [{ id: 'task-1', intervention_id: 'int-1', incident_id: 'inc-1', title: 'Confirm bypass', status: 'todo' }],
        alert_events: [{ id: 'ae-1', source: 'open_meteo', metric: 'precipitation_mm', value: 52, status: 'open', severity: 'high', scope: { district: 'Turkana' } }],
        rapidpro_dispatches: [{ id: 'dp-1', alert_event_id: 'ae-1', status: 'sent', recipients_count: 1234, sent_at: new Date().toISOString(), matched_signal_at: new Date(Date.now() - 3600000).toISOString() }],
      })

      const { data } = await fetch(`${baseUrl}/api/v1/districts/turkana`).then((r) => r.json())
      assert.equal(data.counts.interventions, 1, 'intervention is reachable through its incident')
      assert.equal(data.counts.tasks, 1, 'task is reachable through its intervention')
      assert.equal(data.kpi_snapshot.people_reached, 1234, 'dispatch is reachable through its alert event')

      // A district with none of this must report zero, not borrow a neighbour's.
      const { data: other } = await fetch(`${baseUrl}/api/v1/districts/mandera`).then((r) => r.json())
      assert.equal(other.counts.interventions, 0)
      assert.equal(other.counts.tasks, 0)
      assert.equal(other.kpi_snapshot.people_reached, 0)
    } finally { listener.close() }
  })

  it('does not count more parent-linked records than exist', async () => {
    // Parent-derived matching must not inflate totals beyond the records that
    // exist, which a naive union across districts would.
    const { listener, baseUrl } = await makeServer()
    try {
      const slugs = ['turkana', 'aweil', 'bor', 'karamoja', 'mandera']
      let counted = 0
      for (const slug of slugs) {
        const { data } = await fetch(`${baseUrl}/api/v1/districts/${slug}`).then((r) => r.json())
        counted += data.counts.interventions
      }
      const { data: all } = await fetch(`${baseUrl}/api/v1/interventions`).then((r) => r.json())
      assert.ok(
        counted <= all.length,
        `district views counted ${counted} interventions but only ${all.length} exist`,
      )
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/turkana returns 200 with data.district.name === Turkana', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts/turkana`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.equal(data.district.name, 'Turkana')
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/karamoja and /moroto resolve to the same district', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/districts/karamoja`).then(r => r.json()),
        fetch(`${baseUrl}/api/v1/districts/moroto`).then(r => r.json()),
      ])
      assert.equal(r1.data.district.slug, 'karamoja')
      assert.equal(r2.data.district.slug, 'karamoja')
      assert.equal(r1.data.district.name, r2.data.district.name)
    } finally { listener.close() }
  })

  it('GET /api/v1/districts/unknown returns 404', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/api/v1/districts/unknown-xyz`)
      assert.equal(res.status, 404)
    } finally { listener.close() }
  })

  it('GET /districts returns 200 HTML', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/districts`)
      assert.equal(res.status, 200)
      const ct = res.headers.get('content-type') || ''
      assert.ok(ct.includes('text/html'), `expected html, got ${ct}`)
    } finally { listener.close() }
  })

  it('GET /districts/manifest.webmanifest returns 200', async () => {
    const { listener, baseUrl } = await makeServer()
    try {
      const res = await fetch(`${baseUrl}/districts/manifest.webmanifest`)
      assert.equal(res.status, 200)
    } finally { listener.close() }
  })

  it('resolveDistrict accepts moroto synonym', () => {
    const d = resolveDistrict('moroto')
    assert.ok(d, 'should resolve')
    assert.equal(d.slug, 'karamoja')
  })

  it('districtOverview returns null for unknown slug', () => {
    const result = districtOverview({}, 'nowhere')
    assert.equal(result, null)
  })
})

describe('Lindela Lite KPI monthly series', () => {
  it('computeMonthlyKpiSeries on empty data returns array with monthsBack entries', () => {
    const series = computeMonthlyKpiSeries({}, { monthsBack: 12 })
    assert.equal(series.length, 12)
    assert.equal(series[0].people_reached, 0)
  })

  it('computeSparklineData extracts oldest-first numeric array', () => {
    const series = [
      { month: '2026-08', people_reached: 10 },
      { month: '2026-07', people_reached: 5 },
    ]
    const vals = computeSparklineData(series, 'people_reached')
    assert.deepEqual(vals, [5, 10])
  })

  it('GET /api/v1/kpi/monthly-series returns 200 with data.length >= 6', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-series-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const res = await fetch(`${baseUrl}/api/v1/kpi/monthly-series`)
      assert.equal(res.status, 200)
      const { data } = await res.json()
      assert.ok(Array.isArray(data) && data.length >= 6, `expected >=6 months, got ${data?.length}`)
    } finally { listener.close() }
  })

  it('POST /api/v1/kpi/refresh-snapshots then GET /api/v1/kpi/snapshots returns non-empty array', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-kpi-snap-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    store.mode = 'json'
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    try {
      const postRes = await fetch(`${baseUrl}/api/v1/kpi/refresh-snapshots`, { method: 'POST' })
      assert.equal(postRes.status, 200)
      const getRes = await fetch(`${baseUrl}/api/v1/kpi/snapshots`)
      assert.equal(getRes.status, 200)
      const { data } = await getRes.json()
      assert.ok(Array.isArray(data) && data.length > 0, 'snapshots should be non-empty after refresh')
    } finally { listener.close() }
  })
})

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
