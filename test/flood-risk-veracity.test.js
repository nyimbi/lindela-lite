/**
 * VER-01, VER-02, VER-07 — three ways the flood score measured something other
 * than the weather.
 *
 * All three are in `computeFloodRisk` / `collectRegions`, and all three are the
 * same failure at different scales: a number was published from an input the
 * code had not actually read. Summing point readings measures sensor density.
 * Coercing an absent forecast to 0 measures the forecast feed. Bucketing by
 * integer degree measures where the district boundary fell.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeClimateConflictRisk, computeFloodRisk } from '../src/analytics.js'

const EMPTY = {
  regions: [], hazard_events: [], conflict_events: [], service_assets: [], impact_assessments: [],
  incidents: [], interventions: [], intervention_tasks: [], field_reports: [],
  response_resources: [], data_quality: [],
}

const station = (id, latitude, longitude, precipitation_mm, probability = 10) => ({
  id, latitude, longitude, precipitation_mm, precipitation_probability_pct: probability,
})

// ---------------------------------------------------------------- VER-01

describe('VER-01 — precipitation is the mean of the readings, not their sum', () => {
  it('scores one station and five stations reading the same 20 mm identically', () => {
    // `nearby` collects every station within 125 km, each reporting the rainfall
    // at its own point. Summing added the same storm once per station, so the
    // score rose with sensor density: five stations reading 20 mm scored 3x one
    // station reading the identical 20 mm. A coordinator reading this map
    // pre-positions assets in the well-instrumented district and starves the
    // identical under-instrumented one.
    const one = computeFloodRisk({ ...EMPTY, climate_observations: [station('a', 3.12, 35.6, 20)] })[0]
    const five = computeFloodRisk({
      ...EMPTY,
      climate_observations: [
        station('a', 3.12, 35.60, 20), station('b', 3.10, 35.62, 20), station('c', 3.14, 35.58, 20),
        station('d', 3.08, 35.55, 20), station('e', 3.16, 35.63, 20),
      ],
    })[0]

    assert.equal(one.drivers.precipitation_mm, 20)
    assert.equal(five.drivers.precipitation_mm, 20, 'the mean of five 20 mm readings is 20 mm')
    assert.equal(five.score, one.score, `same weather must score the same: ${five.score} vs ${one.score}`)
  })

  it('reports the reading count beside the mean, so a single station is visible', () => {
    const many = computeFloodRisk({
      ...EMPTY,
      climate_observations: [station('a', 3.12, 35.6, 30), station('b', 3.10, 35.62, 10)],
    })[0]
    assert.equal(many.drivers.precipitation_mm, 20, 'the mean of 30 and 10 is 20')
    assert.equal(many.drivers.precipitation_readings_used, 2)
  })

  it('does not divide by zero when no reading was usable', () => {
    const none = computeFloodRisk({ ...EMPTY, climate_observations: [station('a', 3.12, 35.6, null)] })[0]
    assert.equal(none.drivers.precipitation_mm, null)
    assert.equal(none.drivers.precipitation_readings_used, 0)
    assert.equal(Number.isFinite(none.score), true, 'the score is still a number, drawn from the terms that exist')
  })
})

// ---------------------------------------------------------------- VER-02

describe('VER-02 — an absent forecast is named, not folded in as a dry one', () => {
  it('flags the score when no observation carried a probability forecast', () => {
    const noForecast = computeFloodRisk({
      ...EMPTY,
      climate_observations: [{ id: 'a', latitude: 3.12, longitude: 35.6, precipitation_mm: 20, precipitation_probability_pct: null }],
    })[0]
    // The comment three lines above the score promises "an absent forecast is
    // not a 0% chance of rain"; the arithmetic then did exactly that. The term
    // still contributes nothing — changing the scale of every published score is
    // a domain decision for ENH-46 — but the omission is now on the payload with
    // its direction, so a reader cannot take the shortfall for a dry forecast.
    assert.equal(noForecast.drivers.probability_term_omitted, true)
    assert.equal(noForecast.drivers.precipitation_probability_pct, null)
    assert.match(noForecast.limits, /missing forecast rather than a dry one/)
    assert.match(noForecast.limits, /up to 35 points/)
  })

  it('does not flag a genuine dry forecast', () => {
    const dry = computeFloodRisk({
      ...EMPTY,
      climate_observations: [station('a', 3.12, 35.6, 0, 0)],
    })[0]
    // 0% is a reading. It is not the same thing as no reading, and the payload
    // must not conflate them.
    assert.equal(dry.drivers.probability_term_omitted, false)
    assert.equal(dry.drivers.precipitation_probability_pct, 0)
    assert.doesNotMatch(dry.limits, /missing forecast/)
  })

  it('a region with a forecast scores above the same region without one', () => {
    // The direction the old coercion got wrong: losing the forecast feed lowered
    // the score, so a data outage read as lower risk.
    const base = { id: 'a', latitude: 3.12, longitude: 35.6, precipitation_mm: 20 }
    const withForecast = computeFloodRisk({ ...EMPTY, climate_observations: [{ ...base, precipitation_probability_pct: 90 }] })[0]
    const withoutForecast = computeFloodRisk({ ...EMPTY, climate_observations: [{ ...base, precipitation_probability_pct: null }] })[0]
    assert.ok(withoutForecast.score < withForecast.score,
      `an absent forecast must not read as a wet one: ${withoutForecast.score} vs ${withForecast.score}`)
    // And the reason is stated, rather than left for the reader to infer.
    assert.equal(withoutForecast.drivers.probability_term_omitted, true)
  })
})

// ---------------------------------------------------------------- VER-07

describe('VER-07 — a region is a district, not an integer-degree cell', () => {
  // Turkana (3.12, 35.48) and Karamoja (2.53, 34.55) are 122 km apart. Both
  // round to the cell `3:35`, so the old key merged them into one region whose
  // coordinate was whichever station arrived first — and each was then scored
  // against the other's rainfall.
  const TURKANA = station('t', 3.12, 35.48, 20)
  const KARAMOJA = station('k', 2.53, 34.55, 5)

  it('keeps two districts in one integer cell apart', () => {
    const regions = computeFloodRisk({ ...EMPTY, climate_observations: [TURKANA, KARAMOJA] })
    assert.equal(regions.length, 2,
      `two districts 122 km apart must not merge; got ${regions.map((r) => r.region_name).join(', ')}`)
    assert.deepEqual(regions.map((r) => r.region_name).sort(), ['Karamoja', 'Turkana'])
  })

  it('gives each district its own coordinate rather than the first one seen', () => {
    // The old key produced one region whose coordinate was whichever station
    // arrived first, so both districts were reported at one district's location.
    // The climate radius is 125 km and these stations are 122 km apart, so each
    // region legitimately collects the other's reading — what must not happen is
    // the two regions sharing one centre.
    const regions = computeFloodRisk({ ...EMPTY, climate_observations: [TURKANA, KARAMOJA] })
    const turkana = regions.find((r) => r.region_name === 'Turkana')
    const karamoja = regions.find((r) => r.region_name === 'Karamoja')
    assert.equal(turkana.latitude, 3.12)
    assert.equal(turkana.longitude, 35.48)
    assert.equal(karamoja.latitude, 2.53)
    assert.equal(karamoja.longitude, 34.55)
    assert.notDeepEqual(
      [turkana.latitude, turkana.longitude],
      [karamoja.latitude, karamoja.longitude],
      'two districts must not be reported at one coordinate',
    )
  })

  it('reports each district under its own name', () => {
    const regions = computeFloodRisk({ ...EMPTY, climate_observations: [TURKANA, KARAMOJA] })
    // A merged cell took its name from the first point, so Karamoja's stations
    // were reported as Turkana.
    assert.deepEqual(regions.map((r) => r.region_name).sort(), ['Karamoja', 'Turkana'])
    assert.deepEqual(regions.map((r) => r.country).sort(), ['KE', 'UG'])
  })

  it('does not split one district into two half-regions', () => {
    // Two stations either side of an integer boundary but inside one district.
    // The old key split them, so each half-region was scored against part of the
    // district's data and the district page showed two contradictory numbers.
    const west = station('w', 3.40, 35.40, 30)
    const east = station('e', 2.60, 35.40, 30)
    const regions = computeFloodRisk({ ...EMPTY, climate_observations: [west, east] })
    const turkana = regions.filter((r) => r.region_name === 'Turkana')
    assert.equal(turkana.length, 1, `one district is one region; got ${regions.length}`)
    assert.equal(turkana[0].drivers.precipitation_readings_used, 2, 'both stations belong to the one district')
  })

  it('falls back to a half-degree cell where no district claims the point', () => {
    // Outside every curated radius: still grouped, so a cluster of stations near
    // one town is one region rather than one region per station.
    const a = station('a', 0.10, 30.10, 10)
    const b = station('b', 0.12, 30.12, 10)
    const regions = computeFloodRisk({ ...EMPTY, climate_observations: [a, b] })
    assert.equal(regions.length, 1, 'two stations in one town are one region')
    assert.equal(regions[0].drivers.precipitation_readings_used, 2)
  })
})

// ---------------------------------------------------------------- DATA-04

describe('DATA-04 — hazard pressure is about now, not about how much archive was ingested', () => {
  // A fixed clock, so the window can be tested at a chosen age instead of
  // waiting for real time to pass. Same argument `computeRoadAccess` makes for
  // its injectable `now`.
  const NOW = new Date('2026-10-18T12:00:00.000Z')
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
  const flood = (id, occurred_at, severity = 'critical') => ({
    id, event_type: 'flood', severity, occurred_at, latitude: 3.12, longitude: 35.60,
  })
  const withFloods = (events) => ({ ...EMPTY, climate_observations: [station('s', 3.12, 35.60, 0, 0)], hazard_events: events })

  it('scores four floods from 2019 below four from this week', () => {
    // The defect: `hazards` was every alert within 250 km whatever its date, so
    // backfilling `gdacs-archive` raised every covered district toward 100 with
    // no change in conditions. Both sets below are four critical floods 250 km
    // from the same station; only the date differs.
    const archive = computeFloodRisk(withFloods([1, 2, 3, 4].map((n) => flood(`a${n}`, '2019-04-0' + n))), { now: NOW })[0]
    const current = computeFloodRisk(withFloods([1, 2, 3, 4].map((n) => flood(`c${n}`, daysAgo(n)))), { now: NOW })[0]

    assert.equal(archive.drivers.flood_hazard_events, 0, 'a 2019 flood is not current evidence')
    assert.equal(current.drivers.flood_hazard_events, 4)
    assert.ok(archive.score < current.score,
      `history must not score as present: ${archive.score} vs ${current.score}`)
    assert.equal(archive.drivers.flood_hazard_events_stale, 4, 'and the record says how much it set aside')
    assert.equal(current.drivers.flood_hazard_events_stale, 0)
  })

  it('does not fall as the archive grows, which is what made it a count of ingestion', () => {
    // The published failure was that a backfill *raised* a score. Twenty 2019
    // floods and four 2019 floods must score identically, because neither says
    // anything about this week.
    const four = computeFloodRisk(withFloods([1, 2, 3, 4].map((n) => flood(`a${n}`, '2019-04-0' + n))), { now: NOW })[0]
    const twenty = computeFloodRisk(withFloods(Array.from({ length: 20 }, (_, n) => flood(`b${n}`, '2019-05-01'))), { now: NOW })[0]
    assert.equal(twenty.score, four.score, 'archive size is not a risk signal')
    assert.equal(twenty.drivers.flood_hazard_events_stale, 20)
  })

  it('keeps an undated hazard, and says the record cannot vouch for its age', () => {
    // The direction a risk score must not fail: dropping an undated hazard
    // lowers the score on missing evidence. `road-access.js` settled this the
    // same way — unknown age is not old age.
    const undated = computeFloodRisk(withFloods([flood('u', null), flood('v', 'last Tuesday')]), { now: NOW })[0]
    assert.equal(undated.drivers.flood_hazard_events, 2, 'an undated hazard is not safe to dismiss')
    assert.equal(undated.drivers.flood_hazard_events_undated, 2)
    assert.match(undated.limits, /no usable date/)
  })

  it('counts a forecast, because a forecast is about the present', () => {
    const forecast = computeFloodRisk(withFloods([flood('f', new Date(NOW.getTime() + 2 * 86_400_000).toISOString())]), { now: NOW })[0]
    assert.equal(forecast.drivers.flood_hazard_events, 1)
    assert.equal(forecast.drivers.flood_hazard_events_undated, 0, 'a future date is a date')
  })

  it('names the window on the record, so the score cannot be read as all-time', () => {
    const risk = computeFloodRisk(withFloods([flood('a1', '2019-04-01')]), { now: NOW })[0]
    assert.equal(risk.drivers.hazard_recency_days, 7)
    assert.match(risk.methodology, /7 days/)
    assert.match(risk.limits, /7 days/)
    assert.equal(risk.honesty.limits.sample.hazard_recency_days, undefined, 'the window is in drivers and prose, not duplicated in the sample')
    assert.equal(risk.honesty.limits.sample.flood_hazard_events_stale, 1)
  })

  it('applies the same rule to the climate-conflict scorer', () => {
    // The second instance, one function away in the same module — the argument
    // ENH-45 made for a registry rather than a third fix.
    const data = (events) => ({ ...EMPTY, climate_observations: [station('s', 3.12, 35.60, 0, 0)], hazard_events: events })
    const archive = computeClimateConflictRisk(data([1, 2, 3, 4].map((n) => flood(`a${n}`, '2019-04-0' + n))), { now: NOW })[0]
    const current = computeClimateConflictRisk(data([1, 2, 3, 4].map((n) => flood(`c${n}`, daysAgo(n)))), { now: NOW })[0]
    assert.equal(archive.drivers.hazard_events, 0)
    assert.equal(current.drivers.hazard_events, 4)
    assert.ok(archive.score < current.score, `history must not score as present: ${archive.score} vs ${current.score}`)
  })

  it('takes the window as a parameter, so the rule is not a hardcoded seven', () => {
    // A canary against the fix being a literal: with a 400-day window the same
    // 2019 floods come back in. If this passes, the window is genuinely read.
    const wide = computeFloodRisk(withFloods([flood('a1', daysAgo(100))]), { now: NOW, hazardRecencyDays: 400 })[0]
    const narrow = computeFloodRisk(withFloods([flood('a1', daysAgo(100))]), { now: NOW })[0]
    assert.equal(wide.drivers.flood_hazard_events, 1)
    assert.equal(narrow.drivers.flood_hazard_events, 0)
    assert.equal(wide.drivers.hazard_recency_days, 400)
  })
})
