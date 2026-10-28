#!/usr/bin/env node
/**
 * Every Open-Meteo connector must refuse a region whose coordinates it cannot
 * read, rather than fetching at 0/0.
 *
 * There are four of them — forecast, flood, archive, and the connector in
 * `open-meteo.js` — and all four built a request out of `region.lat` and
 * stamped the same values onto the record. `Number('')`, `Number(null)` and
 * `Number('  ')` are all 0, and `String(null)` is `'null'`, so a region whose
 * coordinates were never filled in was either fetched at 0/0 — a real position
 * in the Gulf of Guinea — or handed the API a literal `null` and let it choose
 * a default. Either way the series was published under the district's name.
 *
 * The refusal has to be about an *unreadable* coordinate, not a zero one. A
 * region genuinely at 0/0 is legal, and a guard that rejected it would be the
 * falsy-zero bug wearing the guard's clothes — so each connector is tested
 * against both.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { openMeteoConnector } from '../src/connectors/open-meteo.js'
import { openMeteoForecastConnector } from '../src/connectors/open-meteo-forecast.js'
import { openMeteoFloodConnector } from '../src/connectors/open-meteo-flood.js'
import { openMeteoArchiveConnector } from '../src/connectors/open-meteo-archive.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const BLANK = { name: 'Turkana', country: 'KE', lat: '', lon: null }
const ZERO = { name: 'Turkana', country: 'KE', lat: 0, lon: 0 }

/** Records every URL asked for, and answers each with a body the caller chose. */
function stubFetch(bodyFor) {
  const seen = []
  globalThis.fetch = async (url) => {
    const target = String(url instanceof URL ? url.href : url)
    seen.push(target)
    const body = bodyFor(target)
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    }
  }
  return seen
}

const FORECAST_BODY = {
  current: { time: '2026-10-28T10:00', temperature_2m: 30, precipitation: 0, weather_code: 0 },
  daily: {
    time: ['2026-10-28'],
    temperature_2m_max: [33],
    precipitation_sum: [2],
    precipitation_probability_max: [20],
    weather_code: [1],
  },
}

const DISCHARGE_BODY = { daily: { time: ['2026-09-01', '2026-09-02'], river_discharge: [10, 12] } }
const PRECIP_BODY = { daily: { time: ['2026-09-01', '2026-09-02'], precipitation_sum: [4, 0] } }

/** Each connector, how to invoke it, and the collection its records land in. */
const CASES = [
  {
    id: 'open_meteo',
    run: (region) => openMeteoConnector.ingest({ regions: [region], retries: 0 }),
    collection: 'climate_observations',
    body: FORECAST_BODY,
  },
  {
    id: 'open_meteo_forecast',
    run: (region) => openMeteoForecastConnector.ingest({ regions: [region], retries: 0 }),
    collection: 'weather_forecasts',
    body: FORECAST_BODY,
  },
  {
    id: 'open_meteo_flood',
    run: (region) => openMeteoFloodConnector.ingest({
      regions: [region],
      flood_start_date: '2026-09-01',
      flood_end_date: '2026-09-02',
      retries: 0,
    }),
    collection: 'climate_observations',
    body: DISCHARGE_BODY,
  },
  {
    id: 'open_meteo_archive',
    run: (region) => openMeteoArchiveConnector.ingest({
      regions: [region],
      archive_start_date: '2026-09-01',
      archive_end_date: '2026-09-02',
      retries: 0,
    }),
    collection: 'climate_observations',
    body: PRECIP_BODY,
  },
]

describe('an Open-Meteo region with no readable coordinates', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}: is refused before any request is made`, async () => {
      const seen = stubFetch(() => testCase.body)
      const out = await testCase.run(BLANK)
      assert.equal(seen.length, 0, `a request was made at ${seen.join(', ')} for a region with no coordinates`)
      assert.deepEqual(out[testCase.collection], [])
      assert.ok(
        out.errors.some((e) => /no readable coordinates/.test(e) && /0\/0/.test(e)),
        `expected the refusal to name the cause, got: ${out.errors.join('; ')}`,
      )
    })

    it(`${testCase.id}: still queries a region whose coordinates really are zero`, async () => {
      // 0/0 is a legal position. The refusal is about an unreadable coordinate,
      // not a zero one, and a guard that could not tell them apart would reject
      // a real request while looking correct.
      const seen = stubFetch(() => testCase.body)
      const out = await testCase.run(ZERO)
      assert.equal(out.errors.length, 0, out.errors.join('; '))
      assert.ok(seen.length > 0, 'a stated 0/0 was refused as if it were absent')
      const records = out[testCase.collection]
      assert.ok(records.length > 0, 'a stated 0/0 produced no record')
      assert.ok(records.every((r) => r.latitude === 0 && r.longitude === 0),
        `records carried ${JSON.stringify(records.map((r) => [r.latitude, r.longitude]))}`)
    })
  }

  it('whitespace is unreadable too, in every connector', async () => {
    for (const testCase of CASES) {
      const seen = stubFetch(() => testCase.body)
      const out = await testCase.run({ name: 'Turkana', country: 'KE', lat: '  ', lon: '\t' })
      assert.equal(seen.length, 0, `${testCase.id} fetched for a whitespace coordinate`)
      assert.deepEqual(out[testCase.collection], [], `${testCase.id} produced a record for a whitespace coordinate`)
    }
  })
})
