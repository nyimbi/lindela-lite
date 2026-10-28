import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULT_ENSEMBLE_MODEL,
  ENSEMBLE_ATTRIBUTION,
  ENSEMBLE_CALL_WEIGHT,
  ensembleMemberValues,
  openMeteoConnector,
} from '../src/connectors/open-meteo.js'
import { computeEnsembleStats } from '../src/analytics/ensemble.js'
import { computeFloodRisk } from '../src/analytics.js'

/**
 * The ensemble path, wired.
 *
 * `src/analytics/ensemble.js` was written, tested, and unreachable: nothing set
 * `ensemble_source`, which is the field `src/analytics.js` gates the read path
 * on, so `drivers.ensemble_used` could never be true. The connector's `useEnsemble`
 * flag was computed from `include_ensemble` and then never read, and the comment
 * where the ensemble fetch belonged said "for now fall back to deterministic".
 *
 * What the wiring must not do is reintroduce the defect it replaced. The
 * connector used to *invent* p10/p50/p90 from the point value with a spread of
 * `0.25 + (1 - probability/100) * 0.75`, published under the field names a real
 * ensemble uses, and the flood scorer preferred p90 over the point value — so
 * the score was inflated by a made-up coefficient. Every assertion below is
 * about the difference between a percentile that came from members and one that
 * did not.
 */

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const REGION = { name: 'Turkana', country: 'KE', lat: 3.1, lon: 35.6 }
const DATES = ['2026-10-15', '2026-10-16']

/** The deterministic response the connector always fetches first. */
const deterministic = {
  current: { time: '2026-10-15T00:00', precipitation: 3.5, temperature_2m: 27.1, relative_humidity_2m: 68 },
  daily: {
    time: DATES,
    precipitation_sum: [12.4, 2.1],
    precipitation_probability_max: [80, 30],
    temperature_2m_max: [31, 30],
    temperature_2m_min: [22, 21],
  },
}

/**
 * An ensemble response shaped the way the API actually shapes one.
 *
 * Members are extra keys in the same `daily` object, suffixed `_memberNN`, and
 * the unsuffixed `precipitation_sum` key is the control run — verified against
 * live responses. `members` is a parameter rather than a constant because the
 * real count differs by model (39 for ICON, 30 for GFS, 51 for ECMWF IFS) and a
 * parser that assumed one would read a truncated ensemble.
 */
function ensembleResponse({ members = 5, dates = DATES, control = [1.0, 0.5] } = {}) {
  // A member's value depends on the *date* it belongs to, not on its position in
  // the array: member `i` is `i` on DATES[0] and `2i` on DATES[1]. So a column
  // identifies the day it was written for, and a fixture whose columns were the
  // same across dates could not tell a date-matched pairing from an
  // index-matched one — the assertion would pass either way, which is exactly
  // the failure it exists to catch.
  const valueOn = (member, date) => (date === DATES[0] ? member : member * 2)
  const daily = { time: dates, precipitation_sum: dates.map((date, i) => control[i]) }
  for (let i = 1; i <= members; i += 1) {
    daily[`precipitation_sum_member${String(i).padStart(2, '0')}`] = dates.map((date) => valueOn(i, date))
  }
  return { daily, daily_units: { time: 'iso8601', precipitation_sum: 'mm' } }
}

/** Routes by host, because the ensemble lives on a different one. */
function mockTwoHosts({ ensemble = ensembleResponse(), ensembleFails = false, seen = [] } = {}) {
  globalThis.fetch = async (url) => {
    const target = String(url instanceof URL ? url.href : url)
    seen.push(target)
    if (target.includes('ensemble-api.open-meteo.com')) {
      if (ensembleFails) return { ok: false, status: 500, text: async () => 'upstream down', json: async () => ({}) }
      return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ensemble }
    }
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => deterministic }
  }
  return seen
}

describe('the open-meteo connector reads a real ensemble', () => {
  it('carries members and percentiles when the ensemble is asked for', async () => {
    const seen = mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    assert.equal(result.errors.length, 0)
    // Two requests per region: the deterministic forecast and the ensemble, on
    // two different hosts. One request would mean the ensemble was never fetched.
    assert.equal(seen.filter((u) => u.includes('ensemble-api')).length, 1)
    assert.equal(seen.filter((u) => u.includes('api.open-meteo.com/v1/forecast')).length, 1)

    const day = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === DATES[0])
    assert.ok(day, 'the first forecast day was not emitted')
    assert.equal(day.ensemble_members.length, 5)
    assert.deepEqual(day.ensemble_members.map((m) => m.value), [1, 2, 3, 4, 5])
    assert.equal(day.ensemble_p50, 3)
    assert.equal(day.ensemble_source, 'open_meteo_ensemble')
    assert.equal(day.ensemble_model, DEFAULT_ENSEMBLE_MODEL)
    assert.match(day.model_limit, /CC BY 4\.0/)
  })

  it('is off unless asked for, and costs nothing when off', async () => {
    const seen = mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [REGION], retries: 0 })
    // The default run must not double this source's API cost against a shared
    // free tier. One host touched, not two.
    assert.deepEqual(seen.filter((u) => u.includes('ensemble-api')), [])
    for (const record of result.climate_observations) {
      assert.equal(record.ensemble_source, undefined)
      assert.equal(record.ensemble_p90, null)
      assert.match(record.model_limit, /Deterministic point forecast only/)
    }
  })

  it('states the limit that is true of the record it is on', async () => {
    // One string cannot be both "no ensemble members are produced" and the note
    // on a record holding thirty of them. Publishing real percentiles under the
    // deterministic limit would be the invented-uncertainty defect wearing the
    // honesty note as cover.
    const seen = mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    const withMembers = result.climate_observations.filter((r) => r.ensemble_members.length > 0)
    const without = result.climate_observations.filter((r) => r.ensemble_members.length === 0)
    assert.ok(withMembers.length, 'no record carried members')
    assert.ok(without.length, 'no record carried the deterministic limit')
    for (const r of withMembers) assert.equal(r.model_limit, ENSEMBLE_ATTRIBUTION)
    for (const r of without) assert.match(r.model_limit, /Deterministic point forecast only/)
  })

  it('publishes the call weight, because widening the region list multiplies it', async () => {
    mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    const day = result.climate_observations.find((r) => r.type === 'precipitation_forecast')
    assert.equal(day.ensemble_call_weight, ENSEMBLE_CALL_WEIGHT)
    assert.equal(ENSEMBLE_CALL_WEIGHT, 4)
  })

  it('keeps the deterministic forecast when the ensemble endpoint fails', async () => {
    // The point reading is what the map and the scorers need. Losing it because
    // the probabilistic half was unreachable is an availability regression
    // dressed as a feature.
    mockTwoHosts({ ensembleFails: true })
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /ensemble \(ecmwf_ifs025\)/, 'the failure must name the model it asked for')
    const day = result.climate_observations.find((r) => r.type === 'precipitation_forecast')
    assert.ok(day, 'the deterministic forecast was lost with the ensemble')
    assert.equal(day.precipitation_mm, 12.4)
    assert.equal(day.ensemble_p90, null)
  })

  it('names the model it asked for, and refuses an unknown one rather than falling back', async () => {
    const seen = mockTwoHosts()
    await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, ensemble_model: 'gfs_seamless', retries: 0 })
    const ensembleUrl = seen.find((u) => u.includes('ensemble-api'))
    assert.match(ensembleUrl, /models=gfs_seamless/)
    // The API refuses an omitted model — "Model 'best_match' is not supported by
    // the Ensemble API" — so the connector must never send an empty one.
    assert.ok(!/models=(&|$)/.test(ensembleUrl), 'the models parameter was sent empty')
  })

  it('pairs members to days by date, not by array position', async () => {
    // The two requests go to different hosts and nothing guarantees the arrays
    // align. Pairing by index would attach one day's members to another day's
    // point value — a wrong number that looks entirely plausible.
    mockTwoHosts({ ensemble: ensembleResponse({ dates: ['2026-10-16', '2026-10-15'] }) })
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    const fifteenth = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === '2026-10-15')
    const sixteenth = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === '2026-10-16')
    // The ensemble returned its dates reversed, so position 0 holds the 16th.
    // The 15th must take the column the *date* selects — member values 1..5, so
    // a median of 3 — and an index-matched pairing would hand it 2..10 instead.
    assert.equal(fifteenth.ensemble_p50, 3)
    assert.equal(sixteenth.ensemble_p50, 6)
    assert.deepEqual(fifteenth.ensemble_members.map((m) => m.value), [1, 2, 3, 4, 5])
  })

  it('leaves a day absent from the ensemble with null percentiles, not zeros', async () => {
    // The ensemble carries a shorter horizon than the deterministic forecast.
    // A day with no members has no percentiles, and 0 would read as a certain
    // forecast of no rain.
    mockTwoHosts({ ensemble: ensembleResponse({ dates: [DATES[0]] }) })
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    const second = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === DATES[1])
    assert.equal(second.ensemble_p90, null)
    assert.equal(second.ensemble_source, undefined)
    assert.deepEqual(second.ensemble_members, [])
  })

  it('reads the member count off the response rather than assuming one', async () => {
    // 51 is ECMWF, 39 is ICON, 30 is GFS. A hardcoded count reads a truncated
    // ensemble for every other model and reports a narrower spread — the one
    // error a spread index exists to catch.
    for (const members of [3, 30, 51]) {
      mockTwoHosts({ ensemble: ensembleResponse({ members }) })
      const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
      const day = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === DATES[0])
      assert.equal(day.ensemble_members.length, members, `read ${day.ensemble_members.length} members, expected ${members}`)
      assert.equal(day.ensemble_members_reported, members)
      // p90 of the sorted members 1..N with linear interpolation is not N
      // exactly; it is what `computeEnsembleStats` returns for that array. The
      // assertion that matters is that it was computed over all N, which the
      // count beside it states.
      assert.equal(day.ensemble_p90, computeEnsembleStats(Array.from({ length: members }, (_, i) => i + 1)).p90)
    }
  })
})

describe('ensembleMemberValues reads the response shape the API actually sends', () => {
  it('excludes the control run, which is already one of the members', () => {
    // The unsuffixed key equals a member exactly on most days and is nowhere
    // near the mean — verified against live responses for ecmwf_ifs025. It is
    // the control run, and counting it twice biases the distribution toward it.
    const daily = { time: DATES, precipitation_sum: [1, 2], precipitation_sum_member01: [1, 2], precipitation_sum_member02: [3, 4] }
    const { keys, values } = ensembleMemberValues(daily)
    assert.deepEqual(keys, ['precipitation_sum_member01', 'precipitation_sum_member02'])
    assert.deepEqual(values, [[1, 2], [3, 4]])
  })

  it('orders members by number, not by key order', () => {
    const daily = { precipitation_sum_member10: [10], precipitation_sum_member02: [2], precipitation_sum_member01: [1] }
    const { keys } = ensembleMemberValues(daily)
    assert.deepEqual(keys, ['precipitation_sum_member01', 'precipitation_sum_member02', 'precipitation_sum_member10'])
  })

  it('does not mistake another variable for a member', () => {
    const daily = { precipitation_sum: [1], precipitation_sum_member01: [1], temperature_2m_member01: [9], precipitation_sum_units: ['mm'] }
    const { keys } = ensembleMemberValues(daily)
    assert.deepEqual(keys, ['precipitation_sum_member01'])
  })

  it('returns nothing for a model that sends a control run and no members', () => {
    // `ecmwf_ifs04` does exactly this: one key, zero members. A percentile of
    // one number is not a percentile, and `computeEnsembleStats` says so with
    // nulls rather than fabricating a spread of zero.
    const { values } = ensembleMemberValues({ time: DATES, precipitation_sum: [1, 2] })
    assert.deepEqual(values, [])
    assert.deepEqual(computeEnsembleStats([]), { p10: null, p50: null, p90: null, mean: null, stddev: null, count: 0 })
  })
})

describe('a real ensemble reaches the flood scorer, and an invented one does not', () => {
  const base = {
    regions: [{ name: 'Turkana', lat: 3.1167, lon: 35.6 }],
    climate_observations: [{
      id: 'obs-1', region_name: 'Turkana', latitude: 3.12, longitude: 35.6,
      precipitation_mm: 10, precipitation_probability_pct: 10,
      ensemble_p90: 19.25, ensemble_p10: 0, ensemble_p50: 10,
    }],
    hazard_events: [], conflict_events: [], service_assets: [], impact_assessments: [],
    incidents: [], interventions: [], intervention_tasks: [], field_reports: [],
    response_resources: [], data_quality: [],
  }

  it('uses a percentile the connector fetched, and says so', () => {
    const risk = computeFloodRisk({
      ...base,
      climate_observations: [{ ...base.climate_observations[0], ensemble_source: 'open_meteo_ensemble' }],
    })[0]
    assert.equal(risk.drivers.ensemble_used, true)
    assert.ok(Math.abs(risk.drivers.precipitation_mm - 19.25) < 0.1)
  })

  it('ignores a percentile with no ensemble behind it', () => {
    const risk = computeFloodRisk(base)[0]
    assert.ok(!risk.drivers.ensemble_used)
    assert.equal(risk.drivers.precipitation_mm, 10)
  })

  it('end to end: the connector\'s own record drives ensemble_used', async () => {
    // The join the defect lived in. `ensemble_source` is set by the connector
    // and read by the scorer, and nothing between them may drop it — the field
    // travelled from the fetch to the record in this test and nowhere else
    // before this change.
    mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [REGION], include_ensemble: true, retries: 0 })
    const day = result.climate_observations.find((r) => r.type === 'precipitation_forecast' && r.observed_at === DATES[0])
    assert.equal(day.ensemble_source, 'open_meteo_ensemble')
    const risk = computeFloodRisk({
      ...base,
      regions: [{ name: 'Turkana', lat: REGION.lat, lon: REGION.lon }],
      climate_observations: [day],
    })[0]
    assert.equal(risk.drivers.ensemble_used, true)
    // The score is computed from the fetched p90, not the deterministic point
    // value of 12.4 — that substitution is the whole reason the field exists.
    assert.equal(risk.drivers.precipitation_mm, computeEnsembleStats([1, 2, 3, 4, 5]).p90)
    assert.notEqual(risk.drivers.precipitation_mm, 12.4)
  })
})

describe('a region with no readable coordinates is refused, not queried at 0/0', () => {
  // `Number(null)` and `Number('')` are both 0, so a region whose coordinates
  // were never filled in was queried at 0/0 — a real position in the Gulf of
  // Guinea — and every record it produced carried that position while being
  // named for the district the region was configured for. The map layers were
  // fixed for exactly this coercion; this is the place that *creates* the
  // records rather than filtering them, so the same guard has to exist here.
  const regionWith = (lat, lon) => ({ name: 'Turkana', country: 'KE', lat, lon })

  it('records the region in errors and makes no request for it', async () => {
    const seen = mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [regionWith('', null)], retries: 0 })
    assert.equal(seen.length, 0, 'a request was made for a region with no coordinates')
    assert.equal(result.climate_observations.length, 0)
    assert.ok(result.errors.some((e) => /no readable coordinates/.test(e) && /0\/0/.test(e)),
      `expected the refusal to name the cause, got: ${result.errors.join('; ')}`)
  })

  it('still queries a region whose coordinates really are zero', async () => {
    // 0/0 is a legal position, however unlikely for a Kenyan district. The
    // refusal must be about an unreadable coordinate, not about a zero one —
    // otherwise the fix is the falsy-zero bug wearing the guard's clothes.
    const seen = mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [regionWith('0', 0)], retries: 0 })
    assert.equal(result.errors.length, 0, result.errors.join('; '))
    assert.ok(seen.length > 0, 'a stated 0/0 was refused as if it were absent')
    assert.ok(result.climate_observations.every((r) => r.latitude === 0 && r.longitude === 0))
  })

  it('keeps the readable regions in the same run', async () => {
    mockTwoHosts()
    const result = await openMeteoConnector.ingest({ regions: [regionWith('', ''), REGION], retries: 0 })
    assert.ok(result.climate_observations.length > 0, 'one bad region cost the good one its forecast')
    assert.ok(result.climate_observations.every((r) => r.latitude === REGION.lat))
    assert.equal(result.errors.length, 1)
  })
})
