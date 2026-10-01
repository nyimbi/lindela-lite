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
import {
  OCEANIC_NINO_THRESHOLD_C,
  classifyNino34,
  noaaNinoConnector,
  parseNino34,
} from '../src/connectors/noaa-enso.js'

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

  it('reports an error when the GloFAS feed returns a web page', async () => {
    // Verified live 2026-10-01: the published rss.xml path served the EFAS
    // single-page app. HTTP 200, so the connector parsed zero items and
    // reported success. A web app at a feed URL must be an error, not an
    // empty result, or "no floods forecast" is indistinguishable from
    // "nothing ingested".
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => '<!doctype html>\n<html lang="en"><head><title>EFAS</title></head><body></body></html>',
      json: async () => ({}),
    })
    const result = await glofasConnector.ingest({ glofas_feeds: ['https://fixture.test/glofas.xml'], retries: 0 })
    assert.equal(result.hazard_events.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /not an RSS or Atom feed/)
    assert.match(result.errors[0], /HTML page/)
  })

  it('accepts Atom and RDF feeds, not only RSS', async () => {
    // Rejecting "not <rss>" would be a second silent failure waiting to
    // happen if the provider switches feed format.
    const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Flood watch</title><link href="https://example/1"/></entry></feed>'
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/atom+xml']]),
      text: async () => atom,
      json: async () => ({}),
    })
    const result = await glofasConnector.ingest({ glofas_feeds: ['https://fixture.test/glofas.atom'], retries: 0 })
    assert.equal(result.errors.length, 0, 'an Atom feed must not be rejected as a web page')
  })

  it('reports an error when FIRMS has no MAP_KEY configured', async () => {
    // FIRMS has no keyless access. The old code sent a placeholder key and
    // got HTTP 400 per region, while the catalog claimed no credentials were
    // required.
    const previous = process.env.NASA_FIRMS_MAP_KEY
    delete process.env.NASA_FIRMS_MAP_KEY
    try {
      let called = false
      globalThis.fetch = async () => {
        called = true
        return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({}) }
      }
      const result = await nasaFirmsConnector.ingest({ retries: 0 })
      assert.equal(called, false, 'must not make a request without a key')
      assert.equal(result.hazard_events.length, 0)
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /NASA_FIRMS_MAP_KEY is not set/)
      assert.match(result.errors[0], /no keyless access/i)
    } finally {
      if (previous !== undefined) process.env.NASA_FIRMS_MAP_KEY = previous
    }
  })

  it('marks FIRMS as requiring credentials in the source catalog', async () => {
    // The catalog is what an operator reads to decide what needs configuring.
    const { publicSourceCatalog } = await import('../src/schema.js')
    const firms = publicSourceCatalog().find((s) => s.id === 'nasa_firms')
    assert.equal(firms.requires_credentials, true)
    assert.match(firms.credential_hint, /NASA_FIRMS_MAP_KEY/)
  })

  it('walks CHIRPS year directories to find daily files', async () => {
    // The product root lists year directories, not files. Matching filenames
    // on the root listing returned zero records while reporting no error, so
    // the connector looked healthy and ingested nothing.
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 })
    assert.equal(result.errors.length, 0)
    assert.equal(result.climate_observations.length, 5)
    // Newest first: the connector exists to find recent daily files.
    assert.equal(result.climate_observations[0].observed_at, '2026-08-31')
    assert.equal(result.climate_observations[0].source, 'chirps')
    const dates = result.climate_observations.map((o) => o.observed_at)
    assert.deepEqual([...dates].sort().reverse(), dates, 'observations must be newest first')
  })

  it('records the CHIRPS raster URL and admits it holds no rainfall values', async () => {
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 })
    const newest = result.climate_observations[0]
    assert.equal(
      newest.metadata.file_url,
      'https://fixture.test/chirps/2026/chirps-v2.0.2026.08.31.tif.gz',
    )
    // A null must never read as "no rainfall fell".
    assert.equal(newest.precipitation_mm, null)
    assert.equal(newest.metadata.values_included, false)
    assert.match(newest.metadata.values_note, /not pixel values/i)
    assert.equal(newest.type, 'rainfall_dataset_available')
  })

  it('reports an error when the CHIRPS index has no year directories', async () => {
    // Guards the silent-zero failure mode: an empty result with no error reads
    // as "no recent rainfall data", which is a different and wrong claim.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => '<html><body>maintenance</body></html>',
      json: async () => ({}),
    })
    const result = await chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 })
    assert.equal(result.climate_observations.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /no year directories/)
  })

  it('reports an error when year directories exist but hold no daily files', async () => {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => (String(url).includes('2026')
        ? '<html><body><a href="something-else.tif">something-else.tif</a></body></html>'
        : '<html><body><a href="2026/">2026/</a></body></html>'),
      json: async () => ({}),
    })
    const result = await chirpsConnector.ingest({ chirps_index_url: 'https://fixture.test/chirps/', retries: 0 })
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /found no daily files/)
  })

  it('parses NASA FIRMS CSV rows', async () => {
    // Passes a key explicitly: FIRMS requires one, and a missing key now
    // short-circuits with an error rather than attempting the request.
    mockFetch('firms.csv', 'text/csv')
    const result = await nasaFirmsConnector.ingest({
      nasa_firms_key: 'test_key',
      firms_bboxes: [{ name: 'Fixture', bbox: '33,-5,52,15', country: 'KE' }],
      retries: 0,
    })
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

describe('NOAA CPC Nino 3.4 index', () => {
  it('parses the fixed-width CPC rows and ignores the header', () => {
    const rows = parseNino34(fs.readFileSync(path.join(fixtureDir.pathname, 'nino34.txt'), 'utf8'))
    assert.equal(rows.length, 10)
    assert.deepEqual(rows[0], { year: 1949, month: 12, anomaly_c: -1.15 })
    assert.deepEqual(rows.at(-1), { year: 2026, month: 8, anomaly_c: 2.17 })
  })

  it('returns no rows for empty or non-string input', () => {
    assert.deepEqual(parseNino34(''), [])
    assert.deepEqual(parseNino34(null), [])
    assert.deepEqual(parseNino34(undefined), [])
    assert.deepEqual(parseNino34('not a table'), [])
  })

  it('ingests recent monthly anomalies and reports an advisory phase', async () => {
    mockFetch('nino34.txt', 'text/plain')
    const result = await noaaNinoConnector.ingest({
      enso_feed: 'https://fixture.test/nino34.txt',
      enso_window_months: 4,
      retries: 0,
    })
    assert.equal(result.errors.length, 0)
    assert.equal(result.climate_observations.length, 4)
    const latest = result.climate_observations[0]
    assert.equal(latest.source, 'noaa_enso')
    assert.equal(latest.source_id, '2026-08')
    assert.equal(latest.value, 2.17)
    assert.equal(latest.unit, 'degC')
    assert.equal(latest.metadata.phase, 'el_nino_advisory')
    assert.equal(latest.metadata.index_used, 'ONI')
  })

  it('leaves coordinates null so the index is not attributed to a district', async () => {
    mockFetch('nino34.txt', 'text/plain')
    const result = await noaaNinoConnector.ingest({ enso_feed: 'https://fixture.test/nino34.txt', retries: 0 })
    for (const observation of result.climate_observations) {
      // Nino 3.4 is a basin-wide Pacific index. Assigning nearest-region
      // coordinates would make a global signal look like a district reading.
      assert.equal(observation.latitude, null)
      assert.equal(observation.longitude, null)
    }
  })

  it('does not declare an episode from a short warm run', async () => {
    mockFetch('nino34.txt', 'text/plain')
    const result = await noaaNinoConnector.ingest({ enso_feed: 'https://fixture.test/nino34.txt', retries: 0 })
    // The fixture's newest run is 4 months (2026-05 to 2026-08), which is 2
    // overlapping seasons. CPC needs five, so nothing may claim an episode.
    for (const observation of result.climate_observations) {
      assert.equal(observation.metadata.episode_declared, false)
      assert.match(observation.metadata.episode_note, /CPC declares an ENSO episode/)
    }
    assert.equal(classifyNino34(parseNino34('2026 7 29.0 27.2 1.78')).episode_declared, false)
  })

  it('breaks runs and seasons at a gap in the series', () => {
    // Three warm months in 2021 and three in 2024 are not one six-month run.
    // Treating them as contiguous would let two unrelated warm periods
    // manufacture an ENSO episode.
    const gapped = parseNino34([
      '2021 11 29.0 27.0 0.90',
      '2021 12 29.0 27.0 0.90',
      '2022 1 29.0 27.0 0.90',
      '2024 1 29.0 27.0 0.90',
      '2024 2 29.0 27.0 0.90',
      '2024 3 29.0 27.0 0.90',
    ].join('\n'))
    const classification = classifyNino34(gapped)
    assert.equal(classification.advisory_run_months, 3, 'the 2021 months must not extend the run')
    assert.equal(classification.overlapping_seasons, 1)
    assert.equal(classification.episode_declared, false)
  })

  it('handles a run that crosses a year boundary', () => {
    const wrapped = parseNino34([
      '2021 10 29.0 27.0 0.90',
      '2021 11 29.0 27.0 0.90',
      '2021 12 29.0 27.0 0.90',
      '2022 1 29.0 27.0 0.90',
    ].join('\n'))
    const classification = classifyNino34(wrapped)
    assert.equal(classification.advisory_run_months, 4, 'December to January is consecutive')
    assert.equal(classification.period, '2022-01')
  })

  it('counts overlapping three-month seasons, not consecutive months', () => {
    // CPC's rule is five consecutive overlapping seasons, and five seasons
    // span seven distinct months because consecutive seasons share two.
    // Counting months instead would wrongly require fifteen.
    const seven = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9].map((v, i) => ({ year: 2020, month: i + 1, anomaly_c: v }))
    assert.equal(classifyNino34(seven).overlapping_seasons, 5)
    assert.equal(classifyNino34(seven).episode_declared, true)

    const six = seven.slice(0, 6)
    assert.equal(classifyNino34(six).overlapping_seasons, 4, 'six months is only four seasons')
    assert.equal(classifyNino34(six).episode_declared, false)
  })

  it('survives a neutral latest month without inventing a run length', () => {
    const rows = [0.9, 0.9, 0.1].map((v, i) => ({ year: 2020, month: i + 1, anomaly_c: v }))
    const classification = classifyNino34(rows)
    assert.equal(classification.phase, 'neutral')
    // "One consecutive month above threshold" would be a false statement when
    // the latest month is below it.
    assert.equal(classification.advisory_run_months, 0)
    assert.equal(classification.overlapping_seasons, 0)
  })

  it('cannot declare an episode from fewer than three months of history', () => {
    const short = [1.5, 1.5].map((v, i) => ({ year: 2020, month: i + 1, anomaly_c: v }))
    assert.equal(classifyNino34(short).phase, 'el_nino')
    assert.equal(classifyNino34(short).overlapping_seasons, 0, 'no complete three-month season exists')
    assert.equal(classifyNino34(short).episode_declared, false)
  })

  it('counts the advisory run in months and stops at the threshold', () => {
    const rows = parseNino34([
      '2026 3 29.0 27.0 0.03',
      '2026 4 29.0 27.0 0.43',
      '2026 5 29.0 27.0 0.94',
      '2026 6 29.0 27.0 1.47',
      '2026 7 29.0 27.0 1.78',
      '2026 8 29.0 27.0 2.17',
    ].join('\n'))
    const classification = classifyNino34(rows)
    assert.equal(classification.phase, 'el_nino')
    assert.equal(classification.advisory_run_months, 4, 'April 0.43 is below the 0.5 threshold')
    assert.equal(classification.period, '2026-08')
  })

  it('classifies La Nina and neutral against CPC threshold', () => {
    const laNina = classifyNino34(parseNino34('2020 10 27.0 26.0 -0.60\n2020 11 27.0 26.0 -0.70'))
    assert.equal(laNina.phase, 'la_nina')
    assert.equal(laNina.advisory_run_months, 2)
    assert.equal(classifyNino34(parseNino34('2020 10 27.0 26.0 -0.20')).phase, 'neutral')
  })

  it('treats exactly +/-0.5 as meeting the threshold, per CPC wording', () => {
    assert.equal(OCEANIC_NINO_THRESHOLD_C, 0.5)
    assert.equal(classifyNino34(parseNino34('2020 10 27.0 26.0 0.50')).phase, 'el_nino')
    assert.equal(classifyNino34(parseNino34('2020 10 27.0 26.0 -0.50')).phase, 'la_nina')
  })

  it('reports unknown for an empty series rather than defaulting to neutral', () => {
    // "neutral" is a real reading and must not be used as a stand-in for
    // "no data", which would quietly assert conditions that were never measured.
    assert.equal(classifyNino34([]).phase, 'unknown')
    assert.equal(classifyNino34([]).anomaly_c, null)
  })

  it('surfaces an upstream failure as an error instead of zero records', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
    const result = await noaaNinoConnector.ingest({ enso_feed: 'https://fixture.test/nino34.txt', retries: 0 })
    assert.equal(result.climate_observations.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /noaa_enso/)
  })

  it('reports a parse failure when the feed is reachable but unreadable', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map([['content-type', 'text/html']]),
      text: async () => '<html><body>maintenance</body></html>', json: async () => ({}),
    })
    const result = await noaaNinoConnector.ingest({ enso_feed: 'https://fixture.test/nino34.txt', retries: 0 })
    assert.equal(result.climate_observations.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /no parseable/)
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

/**
 * Mocks the two-level CHIRPS layout: the root lists year directories, and each
 * year directory lists daily rasters.
 */
function mockChirpsIndex() {
  globalThis.fetch = async (url) => {
    const target = String(url)
    const file = target.includes('2026')
      ? 'chirps-2026.html'
      : target.includes('2025')
        ? 'chirps-2025.html'
        : 'chirps-index.html'
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => fs.readFileSync(path.join(fixtureDir.pathname, file), 'utf8'),
      json: async () => ({}),
    }
  }
}
