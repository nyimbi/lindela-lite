import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { chirpsConnector } from '../src/connectors/chirps.js'
import { gdacsConnector } from '../src/connectors/gdacs.js'
import { glofasConnector } from '../src/connectors/glofas.js'
import { nasaFirmsConnector } from '../src/connectors/nasa-firms.js'
import { openMeteoConnector } from '../src/connectors/open-meteo.js'
import { usgsEarthquakeConnector } from '../src/connectors/usgs-earthquake.js'

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

  it('parses GDACS disaster alerts with bbox, alert level, and event type code', async () => {
    mockFetch('gdacs.xml', 'application/xml')
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.hazard_events.length, 2)

    const flood = result.hazard_events[0]
    assert.equal(flood.event_type, 'flood')
    assert.equal(flood.severity, 'high')
    assert.equal(flood.country, 'Kenya')
    assert.equal(flood.metadata.event_type_code, 'FL')
    assert.equal(flood.metadata.alert_level, 'orange')
    assert.equal(flood.metadata.alert_score, 2)
    // gdacs:bbox is "south west north east"; the centre becomes the point.
    assert.deepEqual(flood.bbox, { west: 35.2, south: 2.9, east: 35.9, north: 3.5 })
    assert.ok(Math.abs(flood.latitude - 3.2) < 0.001)
    assert.ok(Math.abs(flood.longitude - 35.55) < 0.001)

    // Landslide must be recognised from the LS code, not keyword sniffing.
    const slide = result.hazard_events[1]
    assert.equal(slide.event_type, 'landslide')
    assert.equal(slide.metadata.event_type_code, 'LS')
    assert.ok(Number.isFinite(slide.latitude))
  })

  it('falls back to keyword detection when GDACS omits the event type code', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => `<?xml version="1.0"?><rss><channel><item>
        <title>Mudslide warning in Nepal</title>
        <pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate>
        <guid>MS1</guid>
      </item></channel></rss>`,
    })
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/x.xml'], retries: 0 })
    assert.equal(result.hazard_events.length, 1)
    assert.equal(result.hazard_events[0].event_type, 'landslide')
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

  it('parses USGS earthquake GeoJSON features', async () => {
    mockFetch('usgs-earthquake.json', 'application/geo+json')
    const result = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.hazard_events.length, 2)

    const [moderate, major] = result.hazard_events
    assert.equal(moderate.event_type, 'earthquake')
    assert.equal(moderate.source, 'usgs_earthquake')
    assert.equal(moderate.severity, 'medium')
    assert.equal(major.severity, 'critical')
    assert.equal(moderate.latitude, 2.19)
    assert.equal(moderate.longitude, 44.31)
    assert.equal(major.metadata.tsunami, true)
    assert.equal(major.metadata.alert, 'red')
    assert.equal(major.metadata.magnitude, 7.2)
    assert.equal(major.metadata.felt_reports, 310)
  })

  it('reports connector errors instead of throwing on upstream failure', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
    const result = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
    assert.equal(result.hazard_events.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /usgs_earthquake/)
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
