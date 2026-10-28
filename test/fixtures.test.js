import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { chirpsConnector } from '../src/connectors/chirps.js'
import { conflictCsvConnector } from '../src/connectors/uploads.js'
import { gzipSync } from 'node:zlib'
import { buildChirpsShapedTiff } from './tiff-fixture.mjs'
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

  it('reads an unreadable FIRMS day count as the default rather than putting NaN in the path', async () => {
    // `Math.min(Math.max(Number(days || 1), 1), 10)` clamps a number, and NaN
    // survives both bounds because every comparison against it is false. A
    // schedule configured with `days: "7d"` therefore built
    // `/…/{bbox}/NaN`, which FIRMS answers with a 400 — and a typo in an
    // option was recorded as a source outage. The clamp only makes sense over
    // a value that is absent when it cannot be read.
    const urlsFor = async (days) => {
      const urls = []
      globalThis.fetch = async (url) => {
        urls.push(String(url))
        return { ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => '', json: async () => ({}) }
      }
      await nasaFirmsConnector.ingest({
        nasa_firms_key: 'k', days, retries: 0,
        firms_bboxes: [{ name: 'x', bbox: '33,-5,52,15', country: 'KE' }],
      })
      return urls[0]
    }
    assert.match(await urlsFor('abc'), /\/33,-5,52,15\/1$/, 'an unreadable day count reached the request path')
    assert.match(await urlsFor(''), /\/33,-5,52,15\/1$/)
    assert.match(await urlsFor('3'), /\/33,-5,52,15\/3$/, 'a readable day count was not honoured')
    assert.match(await urlsFor('99'), /\/33,-5,52,15\/10$/, 'the cap was not applied')
  })

  it('drops an undated FIRMS detection and says so, rather than stamping it today', async () => {
    // D21. `row.acq_date || new Date()…` gave a detection the provider could
    // not date today's date, which put it at the top of every "recent fire
    // activity" query and inside every freshness window — a row with no time
    // reading as the newest thing on the map. Dropping it silently would trade
    // one lie for another (a run with a smaller count and no note), so the
    // count is reported and the run reads degraded.
    const csv = 'latitude,longitude,brightness,frp,acq_date,acq_time,satellite,confidence\n'
      + '3.1,35.6,320,12.5,2026-10-26,0412,N,VIIRS\n'
      + '3.2,35.7,310,9.0,,,N,VIIRS\n'
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map([['content-type', 'text/csv']]), text: async () => csv, json: async () => ({}),
    })
    const result = await nasaFirmsConnector.ingest({
      nasa_firms_key: 'k', retries: 0,
      firms_bboxes: [{ name: 'x', bbox: '33,-5,52,15', country: 'KE' }],
    })
    assert.equal(result.hazard_events.length, 1, 'an undated detection was published')
    assert.equal(result.hazard_events[0].occurred_at, '2026-10-26T04:12:00Z')
    assert.equal(result.errors.length, 1, 'the drop was silent')
    assert.match(result.errors[0], /1 detection\(s\) carried no acq_date/)
  })

  it('keeps an unreadable FIRMS FRP unmeasured rather than publishing it as 0 MW', async () => {
    // `toNumber(row.frp, 0)` graded a blank, a whitespace cell and `'abc'` as
    // 0, which the severity ladder read as `low` and the title announced as
    // "(0 MW FRP)" — an unmeasured detection published as a measured faint one.
    // The detection itself is real, so it is kept with a null FRP.
    const header = 'latitude,longitude,brightness,frp,acq_date,acq_time,satellite,confidence\n'
    const read = async (frp) => {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/csv']]),
        text: async () => header + ['3.1', '35.6', '320', frp, '2026-10-26', '0412', 'N', 'VIIRS'].join(',') + '\n',
        json: async () => ({}),
      })
      const result = await nasaFirmsConnector.ingest({
        nasa_firms_key: 'k', retries: 0,
        firms_bboxes: [{ name: 'x', bbox: '33,-5,52,15', country: 'KE' }],
      })
      return result.hazard_events[0]
    }
    for (const blank of ['', '  ', 'abc']) {
      const event = await read(blank)
      assert.equal(event.metadata.frp, null, `FRP ${JSON.stringify(blank)} was read as a measurement`)
      assert.equal(event.severity, null, 'an unmeasured FRP must not be graded')
      assert.doesNotMatch(event.title, /0 MW/)
    }
    // A genuine 0 MW detection is a real reading and still grades low.
    const zero = await read('0')
    assert.equal(zero.metadata.frp, 0)
    assert.equal(zero.severity, 'low')
    assert.match(zero.title, /0 MW FRP/)
    const strong = await read('120')
    assert.equal(strong.severity, 'high')
  })

  it('marks FIRMS as requiring credentials in the source catalog', async () => {
    // The catalog is what an operator reads to decide what needs configuring.
    const { publicSourceCatalog } = await import('../src/schema.js')
    const firms = publicSourceCatalog().find((s) => s.id === 'nasa_firms')
    assert.equal(firms.requires_credentials, true)
    assert.match(firms.credential_hint, /NASA_FIRMS_MAP_KEY/)
  })

  it('binds the CHIRPS date cap whatever form the limit arrives in', async () => {
    // `options.limit || 30` kept any truthy value, and the cap is compared as
    // `datesKept >= limit`. A schedule whose `default_options` carried
    // `"limit": "2"` — a string, which is what a JSON form field produces —
    // made every comparison false, so the cap did not bind and the walk kept
    // every date the index offered. That is the only bound on a run that
    // downloads multi-megabyte rasters, removed by a quoting mistake. A
    // negative limit did the opposite and kept nothing; both now take the
    // default, which is the direction where the cap still applies.
    const datesFor = async (limit) => {
      mockChirpsIndex()
      const result = await chirpsConnector.ingest({
        chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_read_values: false, limit,
      })
      return { dates: new Set(result.climate_observations.map((o) => o.observed_at)).size, cap: result.completeness.cap }
    }

    assert.deepEqual(await datesFor('2'), { dates: 2, cap: 2 }, 'a string limit did not bind')
    assert.deepEqual(await datesFor(2), { dates: 2, cap: 2 })
    for (const unreadable of ['abc', '', 0, -5]) {
      const { cap } = await datesFor(unreadable)
      assert.equal(cap, 30, `limit ${JSON.stringify(unreadable)} left the run with cap ${cap}`)
    }
  })

  it('walks CHIRPS year directories to find daily files', async () => {
    // The product root lists year directories, not files. Matching filenames
    // on the root listing returned zero records while reporting no error, so
    // the connector looked healthy and ingested nothing.
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_read_values: false,
    })
    assert.equal(result.errors.length, 0)
    // Five dates the index offered, one record per date per default region —
    // the region split is what makes a CHIRPS record joinable against an
    // Open-Meteo one, and it is why the count is no longer the date count.
    assert.equal(result.climate_observations.length, 15)
    assert.equal(result.completeness.counts_found, 5)
    assert.equal(result.completeness.records_kept, 5)
    // Newest first: the connector exists to find recent daily files.
    assert.equal(result.climate_observations[0].observed_at, '2026-08-31')
    assert.equal(result.climate_observations[0].source, 'chirps')
    // `limit` bounds dates, not records: 30 days at three regions is still a
    // 30-day window, not a 10-day one.
    assert.equal(result.completeness.cap, 30)
    const dates = [...new Set(result.climate_observations.map((o) => o.observed_at))]
    assert.deepEqual([...dates].sort().reverse(), dates, 'observations must be newest first')
  })

  it('records the CHIRPS raster URL and reads a rainfall value out of it', async () => {
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_days: 1,
    })
    // One date decoded, three regions: the newest record is the newest date's
    // first region, and it carries a real figure rather than the availability
    // shape this connector used to emit.
    const newest = result.climate_observations[0]
    assert.equal(
      newest.metadata.file_url,
      'https://fixture.test/chirps/2026/chirps-v2.0.2026.08.31.tif.gz',
    )
    assert.equal(newest.observed_at, '2026-08-31')
    assert.equal(newest.region_name, 'Turkana')
    assert.equal(newest.precipitation_mm, 12.5)
    assert.equal(newest.metadata.values_included, true)
    assert.equal(newest.type, 'rainfall_observation')
    // Every region on a decoded date carries its own value, not one shared one.
    const day = result.climate_observations.filter((o) => o.observed_at === '2026-08-31')
    assert.deepEqual(day.map((o) => [o.region_name, o.precipitation_mm]),
      [['Turkana', 12.5], ['Mogadishu', 0], ['Juba', 4.25]])
  })

  it('reports a region whose CHIRPS cell is nodata as null, with the reason on the record', async () => {
    // Ocean and outside-the-extent cells are -9999 in the raster. That is not
    // zero rainfall, and a record must not let a reader think it is.
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_days: 1,
      chirps_regions: [{ name: 'Mid-Atlantic', country: null, lat: 0, lon: -30 }],
    })
    const [record] = result.climate_observations
    assert.equal(record.precipitation_mm, null)
    assert.equal(record.metadata.values_included, false)
    assert.match(record.metadata.values_note, /nodata/i)
    assert.equal(record.type, 'rainfall_dataset_available')
  })

  it('caps how many rasters it downloads, and says how many it decoded', async () => {
    // Reading pixels is a download, not a listing: ~3 MB a day. The cap has to
    // reach the return value or a three-day run and a thirty-day run truncated
    // to three look identical.
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_days: 2,
    })
    assert.equal(result.completeness.days_decoded, 2)
    assert.equal(result.completeness.decode_cap, 2)
    assert.equal(result.completeness.decode_failures, 0)
    // Five dates offered, two decoded: the other three keep the availability
    // shape rather than carrying a stale or invented value.
    const withValues = new Set(result.climate_observations.filter((o) => o.precipitation_mm !== null).map((o) => o.observed_at))
    assert.equal(withValues.size, 2)
  })

  it('reports a decode failure on the record rather than a silent zero', async () => {
    // A raster that is not a GeoTIFF at all. The date is still one the index
    // offered, so the records go out — but every one of them says the value is
    // missing and why, and the run carries the failure.
    mockChirpsIndex({ raster: Buffer.from('this is not a tiff') })
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_days: 1,
    })
    assert.equal(result.completeness.decode_failures, 1)
    assert.ok(result.errors.some((e) => /raster unreadable/.test(e)))
    assert.ok(result.errors.some((e) => /failed to decode/.test(e)))
    const [record] = result.climate_observations
    assert.equal(record.precipitation_mm, null)
    assert.match(record.metadata.values_note, /did not decode/i)
  })

  it('still reports availability only when pixel reading is switched off', async () => {
    mockChirpsIndex()
    const result = await chirpsConnector.ingest({
      chirps_index_url: 'https://fixture.test/chirps/', retries: 0, chirps_read_values: false,
    })
    assert.equal(result.completeness.decode_cap, 0)
    assert.equal(result.climate_observations[0].precipitation_mm, null)
    assert.equal(result.climate_observations[0].metadata.values_included, false)
    assert.match(result.climate_observations[0].metadata.values_note, /switched off/i)
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

  it('omits a fabricated point when the GDACS bbox is regional', async () => {
    // GDACS attaches a country- or region-scale box to many green alerts, and
    // its centre can be hundreds of km from the event: a live green flood alert
    // for France carried a box spanning ~40 degrees, putting its centre at
    // 27.8E, in Chad. A point there plots a French event in the Sahel and feeds
    // risk scoring and road-access matching a confidently wrong location.
    const regional = '<item><title>Green flood alert in France</title>'
      + '<pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate>'
      + '<gdacs:eventtype>FL</gdacs:eventtype><gdacs:alertlevel>green</gdacs:alertlevel>'
      + '<gdacs:bbox>-0.29 7.71 39.93 47.93</gdacs:bbox><gdacs:country>France</gdacs:country></item>';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/xml']]),
      text: async () => `<rss><channel>${regional}</channel></rss>`,
      json: async () => ({}),
    });
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 });
    const event = result.hazard_events[0];
    assert.equal(event.latitude, null, 'a regional bbox must not yield a point');
    assert.equal(event.longitude, null);
    assert.deepEqual(event.bbox, { west: 7.71, south: -0.29, east: 47.93, north: 39.93 });
    assert.match(event.metadata.geolocation_note, /regional/i);
  });

  it('keeps the bbox centre when the box is a local footprint', async () => {
    const local = '<item><title>Flash flood</title>'
      + '<pubDate>Mon, 18 May 2026 00:00:00 GMT</pubDate>'
      + '<gdacs:eventtype>FL</gdacs:eventtype><gdacs:alertlevel>orange</gdacs:alertlevel>'
      + '<gdacs:bbox>35.4 3.0 35.8 3.3</gdacs:bbox><gdacs:country>KE</gdacs:country></item>';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/xml']]),
      text: async () => `<rss><channel>${local}</channel></rss>`,
      json: async () => ({}),
    });
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 });
    const event = result.hazard_events[0];
    assert.ok(Number.isFinite(event.latitude), 'a small box centre is a usable location');
    assert.ok(Number.isFinite(event.longitude));
    assert.equal(event.metadata.geolocation_note, null);
  });

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

  it('drops an undated quake rather than stamping it with the fetch time', async () => {
    // `new Date().toISOString()` for an unreadable `time` put the quake at the
    // top of every "most recent" query and inside every freshness window — a
    // record the source could not date reading as the newest thing on the map.
    const feature = (time) => JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        id: 'us7000abcd',
        properties: { mag: 5.8, place: 'Somewhere', time, tsunami: 0 },
        geometry: { type: 'Point', coordinates: [35.6, 3.1, 10] },
      }],
    })
    for (const time of [undefined, null, '', 'abc']) {
      globalThis.fetch = async () => new Response(feature(time), { status: 200, headers: { 'content-type': 'application/geo+json' } })
      const result = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
      assert.equal(result.hazard_events.length, 0, `time ${JSON.stringify(time)} must not be dated`)
      assert.match(result.errors.join(' '), /no readable origin time/)
    }
    globalThis.fetch = async () => new Response(feature(1793140000000), { status: 200, headers: { 'content-type': 'application/geo+json' } })
    const dated = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
    assert.equal(dated.hazard_events[0].occurred_at, '2026-10-27T22:26:40.000Z')
    assert.equal(dated.errors.length, 0)
  })

  it('drops a quake whose magnitude it cannot read rather than calling it M0.0', async () => {
    // `toNumber(props.mag, 0)` graded a null, a blank and `'abc'` as M0.0 low —
    // a detection published as a measured microquake, inside the [-2, 10]
    // assertion so nothing flagged it.
    const feature = (mag) => JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        id: 'us7000abcd',
        properties: { mag, place: 'Somewhere', time: 1793140000000, tsunami: 0 },
        geometry: { type: 'Point', coordinates: [35.6, 3.1, 10] },
      }],
    })
    for (const mag of [null, '', '  ', 'abc', undefined]) {
      globalThis.fetch = async () => new Response(feature(mag), { status: 200, headers: { 'content-type': 'application/geo+json' } })
      const result = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
      assert.equal(result.hazard_events.length, 0, `mag ${JSON.stringify(mag)} must not be graded`)
      assert.match(result.errors.join(' '), /no readable magnitude/)
    }
    // A genuine small quake is still a measurement.
    globalThis.fetch = async () => new Response(feature(0.4), { status: 200, headers: { 'content-type': 'application/geo+json' } })
    const real = await usgsEarthquakeConnector.ingest({ usgs_feed: 'https://fixture.test/usgs.json', retries: 0 })
    assert.equal(real.hazard_events[0].metadata.magnitude, 0.4)
    assert.equal(real.hazard_events[0].severity, 'low')
  })
})

describe('an RSS item with no readable date is dropped, not dated now, and does not take the feed with it', () => {
  // `new Date(pubDate).toISOString()` throws `RangeError: Invalid time value`
  // from inside the item loop, which sits inside the *feed's* try — so one bad
  // date discarded every item after it and reported the feed as unreadable. An
  // absent date took the other branch and stamped the item with `new Date()`.
  const rss = (dates) => '<?xml version="1.0"?><rss><channel>'
    + dates.map((d, i) => `<item><title>Flood ${i}</title><link>https://fixture.test/${i}</link><pubDate>${d}</pubDate><description>d</description></item>`).join('')
    + '</channel></rss>'
  const serve = (dates) => {
    globalThis.fetch = async () => new Response(rss(dates), { status: 200, headers: { 'content-type': 'application/xml' } })
  }
  const DATES = ['Mon, 18 May 2026 00:00:00 GMT', 'Tue, 19 May 2026 00:00:00 GMT', 'Wed, 20 May 2026 00:00:00 GMT']

  it('keeps every item after a bad date in the GDACS feed', async () => {
    serve([DATES[0], 'not-a-date', DATES[1], DATES[2]])
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 })
    assert.equal(result.hazard_events.length, 3, 'the three dated items survive')
    assert.deepEqual(
      result.hazard_events.map((event) => event.occurred_at),
      ['2026-05-18T00:00:00.000Z', '2026-05-19T00:00:00.000Z', '2026-05-20T00:00:00.000Z'],
    )
    assert.match(result.errors.join(' '), /1 item\(s\) carried no readable pubDate/)
  })

  it('keeps every item after a bad date in the GloFAS feed', async () => {
    serve([DATES[0], 'not-a-date', DATES[1], DATES[2]])
    const result = await glofasConnector.ingest({ glofas_feeds: ['https://fixture.test/glofas.xml'], retries: 0 })
    assert.equal(result.hazard_events.length, 3)
    assert.match(result.errors.join(' '), /1 item\(s\) carried no readable pubDate/)
  })

  it('does not stamp an undated item with the current time', async () => {
    const before = Date.now()
    serve([DATES[0], ''])
    const result = await gdacsConnector.ingest({ gdacs_feeds: ['https://fixture.test/gdacs.xml'], retries: 0 })
    assert.equal(result.hazard_events.length, 1)
    for (const event of result.hazard_events) {
      assert.ok(
        Date.parse(event.occurred_at) < before,
        `${event.occurred_at} must not be the fetch time`,
      )
    }
    assert.match(result.errors.join(' '), /carried no readable pubDate/)
  })
})

describe('conflict uploads preserve the difference between no toll and a zero toll', () => {
  // `toNumber(row.fatalities, 0)` folded `''`, `'  '`, `'12 dead'` and a missing
  // column into 0. Zero is the most common real value in a conflict export, so
  // the `value_range` assertion passed it and `analytics.js` contributed the
  // 4-point base with no fatality term — a district with a broken fatalities
  // column scored exactly like one where nothing happened. `null` is the value
  // both the assertion engine and the risk scorer already read as "no toll
  // recorded".
  const toll = async (fatalities) => {
    const result = await conflictCsvConnector.ingest({
      conflict_events: [{ event_date: '2026-05-01', title: 'x', severity: 'low', fatalities }],
    })
    return result.conflict_events[0]
  }

  it('stores a toll it cannot read as absent, not as zero', async () => {
    for (const value of ['', '  ', 'abc', '12 dead', undefined, null]) {
      const event = await toll(value)
      assert.equal(event.fatalities, null, `${JSON.stringify(value)} became a death toll of ${event.fatalities}`)
    }
  })

  it('keeps a genuine zero and a genuine count', async () => {
    assert.equal((await toll('0')).fatalities, 0, 'a protest with no deaths is a real observation')
    assert.equal((await toll(0)).fatalities, 0)
    assert.equal((await toll('7')).fatalities, 7)
    assert.equal((await toll(7)).fatalities, 7)
  })

  it('grades severity from a toll it can read', async () => {
    assert.equal((await toll('12')).severity, 'high')
    assert.equal((await toll('3')).severity, 'medium')
    assert.equal((await toll('0')).severity, 'low', 'the row severity stands when the toll is a real zero')
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
    // Not 'ONI': the feed is the monthly anomaly, and the ONI is the three-month
    // running mean of it. Naming the series accurately is the point.
    assert.equal(latest.metadata.index_used, 'monthly nino34 sst anomaly')
    assert.match(latest.metadata.index_note, /not an ONI/i)
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
function mockChirpsIndex({ raster = null } = {}) {
  // The real product is `chirps-v2.0.YYYY.MM.DD.tif.gz` — a TIFF inside a
  // gzip — and the connector gunzips before decoding. A mock serving raw TIFF
  // bytes would fail the same way the real file would if the container changed.
  const bytes = raster || gzipSync(buildChirpsShapedTiff({
    values: [[3.1167, 35.6, 12.5], [2.0469, 45.3182, 0], [4.8594, 31.5713, 4.25]],
  }))
  globalThis.fetch = async (url) => {
    const target = String(url)
    // The rasters are fetched with `parse: 'buffer'`, so the mock has to serve
    // bytes as well as markup. A mock that only speaks text would leave the
    // whole decode path untested.
    if (target.endsWith('.tif.gz')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/gzip']]),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }
    }
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
