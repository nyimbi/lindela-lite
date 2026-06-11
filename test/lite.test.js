import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { computeClimateConflictRisk, computeFloodRisk, computeServiceImpacts } from '../src/analytics.js'
import { getConnector, runIngestion } from '../src/ingestion.js'
import { createServer } from '../src/server.js'
import { Pg0Manager } from '../src/pg0.js'
import { createStoreFromEnv } from '../src/storage.js'
import { JsonStore } from '../src/store.js'
import { toCsv, toGeoJson } from '../src/utils.js'

describe('Lindela Lite open-source boundary', () => {
  it('rejects gdelt ingestion', () => {
    assert.throws(() => getConnector('gdelt'), /excluded/)
  })

  it('rejects gdelt in ingestion requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await assert.rejects(() => runIngestion(store, { sources: ['gdelt'] }), /excluded/)
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
  })

  it('computes service delivery impacts', () => {
    const risks = [...computeFloodRisk(data), ...computeClimateConflictRisk(data)]
    const impacts = computeServiceImpacts(data, risks)
    assert.equal(impacts.length, 1)
    assert.equal(impacts[0].asset_name, 'Clinic A')
    assert.ok(impacts[0].impact_score > 0)
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
    assert.equal(health.success, true)
    assert.ok(health.exclusions.includes('gdelt'))
    assert.equal(health.storage.mode, 'json')
    assert.ok(sources.data.some((source) => source.id === 'open_meteo'))
    assert.ok(!sources.data.some((source) => source.id === 'gdelt'))
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

})

async function fetchJson(url) {
  const response = await fetch(url)
  return response.json()
}
