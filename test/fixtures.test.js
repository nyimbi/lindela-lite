import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { chirpsConnector } from '../src/connectors/chirps.js'
import { gdacsConnector } from '../src/connectors/gdacs.js'
import { glofasConnector } from '../src/connectors/glofas.js'
import { nasaFirmsConnector } from '../src/connectors/nasa-firms.js'
import { openMeteoConnector } from '../src/connectors/open-meteo.js'

const fixtureDir = new URL('./fixtures/', import.meta.url)
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('public source connector fixtures', () => {
  it('parses Open-Meteo current and forecast observations', async () => {
    mockFetch('open-meteo.json', 'application/json')
    const result = await openMeteoConnector.ingest({ regions: [{ name: 'Turkana', country: 'KE', lat: 3.1, lon: 35.6 }], retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.climate_observations.length, 3)
    assert.equal(result.climate_observations[0].source, 'open_meteo')
  })

  it('parses GDACS disaster alerts', async () => {
    mockFetch('gdacs.xml', 'application/xml')
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.hazard_events.length, 1)
    assert.equal(result.hazard_events[0].event_type, 'flood')
    assert.equal(result.hazard_events[0].severity, 'high')
  })

  it('parses GloFAS flood forecast RSS', async () => {
    mockFetch('glofas.xml', 'application/xml')
    const result = await glofasConnector.ingest({ glofas_feeds: ['https://fixture.test/glofas.xml'], retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.hazard_events.length, 1)
    assert.equal(result.hazard_events[0].event_type, 'flood_forecast')
  })

  it('parses CHIRPS dataset index entries', async () => {
    mockFetch('chirps.html', 'text/html')
    const result = await chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.climate_observations.length, 2)
    assert.equal(result.climate_observations[0].source, 'chirps')
  })

  it('parses NASA FIRMS CSV rows', async () => {
    mockFetch('firms.csv', 'text/csv')
    const result = await nasaFirmsConnector.ingest({ firms_bboxes: [{ name: 'Fixture', bbox: '33,-5,52,15', country: 'KE' }], retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.hazard_events.length, 1)
    assert.equal(result.hazard_events[0].event_type, 'fire')
  })
})

function mockFetch(fileName, contentType) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', contentType]]),
    text: async () => fs.readFileSync(path.join(fixtureDir.pathname, fileName), 'utf8'),
    json: async () => JSON.parse(fs.readFileSync(path.join(fixtureDir.pathname, fileName), 'utf8')),
  })
}
