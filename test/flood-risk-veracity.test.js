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

import { computeFloodRisk } from '../src/analytics.js'

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
