/**
 * R-86/R-87 — the falsy-zero class, eleven instances.
 *
 * `Number(null) === 0`, `Number([]) === 0`, `x || 0`, `?? 0` on a nullable, and
 * `Number.isFinite(Number(null))` (which is *true*, because `Number(null)` is
 * `0`, which is finite) all convert "not measured" into "measured, and the
 * value is zero". In a humanitarian dashboard the resulting figure is not
 * merely wrong, it is optimistically wrong.
 *
 * The worst instance was `src/analytics/impact.js:9-12`:
 *
 *   function servedPopulation(asset) {
 *     if (Number.isFinite(Number(asset.population_served))) return Number(asset.population_served)
 *     if (Number.isFinite(Number(asset.beneficiaries))) return Number(asset.beneficiaries)
 *     return 0
 *   }
 *
 * The first branch takes `Number(null)`, which is finite, so it returns 0 and
 * the `beneficiaries` fallback below it is dead code. Measured on the live
 * store: **0 of 34 service assets carry `population_served` and 0 carry
 * `beneficiaries`**, and the result was 105 hazard rows every one reading
 * `population_at_risk: 0`. "13 facilities affected, 0 people at risk" is a
 * published claim that nobody is exposed, derived from a field no connector
 * populates.
 *
 * The comment above that function named the exact hazard class — "a real answer
 * from a facility that serves nobody" — and fixed it for `0` while leaving
 * `null` broken. That is the pattern this file exists to end.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { median, numericOr, numericOrNull, sumMeasured } from '../src/analytics/numeric.js'
import { computeFacilitiesAtRisk, computePopulationAtRisk } from '../src/analytics/impact.js'
import { population_at_risk } from '../src/analytics/metrics.js'
import { haversineKm } from '../src/utils.js'

describe('R-86 — numericOrNull returns null for everything it cannot vouch for', () => {
  it('rejects the five spellings of "absent" that all evaluate to 0', () => {
    for (const absent of [null, undefined, '', [], NaN, Infinity, -Infinity, {}, true, false]) {
      assert.equal(numericOrNull(absent), null,
        `${JSON.stringify(absent) ?? String(absent)} is not a measurement`)
    }
  })

  it('keeps a real zero', () => {
    // A facility that serves nobody today reports 0, and 0 is the answer. This
    // is the distinction the old `asset.population_served || asset.beneficiaries`
    // threw away: it read 0 as "absent" and substituted the other field.
    assert.equal(numericOrNull(0), 0)
    assert.equal(numericOrNull('0'), 0)
  })

  it('accepts a numeric string, because half the store arrives from connectors as text', () => {
    assert.equal(numericOrNull('42'), 42)
    assert.equal(numericOrNull('-3.5'), -3.5)
  })

  it('numericOr is the accumulator variant and defaults to zero', () => {
    assert.equal(numericOr(null), 0)
    assert.equal(numericOr(null, -1), -1)
    assert.equal(numericOr('7'), 7)
  })
})

describe('R-87 — computePopulationAtRisk does not publish 0 people from no data', () => {
  // The live-store shape: real coordinates, no population field anywhere.
  const assets = [
    { id: 'clinic-1', name: 'Lokichogio clinic', service_type: 'clinic', latitude: 3.12, longitude: 35.61 },
    { id: 'clinic-2', name: 'Lodwar clinic', service_type: 'clinic', latitude: 3.15, longitude: 35.60 },
    { id: 'water-1', name: 'Kangari borehole', service_type: 'water', latitude: 3.20, longitude: 35.70 },
  ]
  const hazard = { id: 'hz-1', event_type: 'flood', severity: 'high', latitude: 3.14, longitude: 35.62 }

  it('reports the affected facilities and says the population is not measured', () => {
    const rows = computePopulationAtRisk({ service_assets: assets, hazard_events: [hazard] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].service_assets_affected, 3, 'all three assets are within 25 km')
    assert.equal(rows[0].population_at_risk, null,
      'no asset records a population, so the exposed population is not zero — it is unknown')
    assert.equal(rows[0].assets_without_recorded_population, 3)
    assert.equal(rows[0].assets_with_recorded_population, 0)
  })

  it('the per-facility rows carry null, not 0, for an unrecorded population', () => {
    const rows = computePopulationAtRisk({ service_assets: assets, hazard_events: [hazard] })
    for (const facility of rows[0].facilities) {
      assert.equal(facility.population_served, null,
        'a facility that records no population is not a facility serving zero people')
    }
  })

  it('still adds a recorded population, and still respects a real zero', () => {
    const withData = [
      { ...assets[0], population_served: 1200 },
      { ...assets[1], population_served: 0 },
      assets[2],
    ]
    const rows = computePopulationAtRisk({ service_assets: withData, hazard_events: [hazard] })
    assert.equal(rows[0].population_at_risk, 1200)
    assert.equal(rows[0].assets_with_recorded_population, 2)
    assert.equal(rows[0].assets_without_recorded_population, 1)
    assert.equal(rows[0].facilities.find((f) => f.id === 'clinic-2').population_served, 0,
      'a facility serving nobody is a measurement of zero, not an absence')
  })

  it('falls through to beneficiaries when population_served is absent', () => {
    // The branch that `Number(null) === 0` made dead code.
    const rows = computePopulationAtRisk({
      service_assets: [{ ...assets[0], beneficiaries: 800 }],
      hazard_events: [hazard],
    })
    assert.equal(rows[0].population_at_risk, 800)
  })

  it('computeFacilitiesAtRisk reports the null population rather than summing zeros', () => {
    const rows = computeFacilitiesAtRisk({ service_assets: assets, hazard_events: [hazard] })
    const clinic = rows.find((r) => r.service_type === 'clinic')
    assert.equal(clinic.at_risk_count, 2)
    assert.equal(clinic.total_population_served, null)
    assert.equal(clinic.assets_without_recorded_population, 2)
  })
})

describe('R-95 — the union total does not double-count an asset in two hazards', () => {
  const assets = [
    { id: 'clinic-1', service_type: 'clinic', latitude: 3.12, longitude: 35.61, population_served: 1200 },
    { id: 'clinic-2', service_type: 'clinic', latitude: 3.15, longitude: 35.60, population_served: 800 },
  ]
  // Two hazards 2 km apart. Every asset is inside both, which is the normal
  // regime for a flood cluster, not an edge case.
  const hazards = [
    { id: 'hz-1', latitude: 3.12, longitude: 35.61 },
    { id: 'hz-2', latitude: 3.13, longitude: 35.62 },
  ]

  it('the per-hazard rows each carry their own exposed population', () => {
    const rows = computePopulationAtRisk({ service_assets: assets, hazard_events: hazards })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].population_at_risk, 2000)
    assert.equal(rows[1].population_at_risk, 2000)
    assert.equal(rows[0].population_at_risk + rows[1].population_at_risk, 4000,
      'this is the number a surface must NOT publish as a total')
  })

  it('the union counts each asset once and flags the overlap', () => {
    const total = population_at_risk.compute({ assets, hazards, radiusKm: 25, haversineKm })
    assert.equal(total.value, 2000)
    assert.equal(total.assets_at_risk, 2)
    assert.equal(total.hazards_overlap, true,
      'overlap is why the per-hazard rows must not be summed')
  })

  it('says so on the payload, so a consumer is told rather than left to guess', () => {
    const rows = computePopulationAtRisk({ service_assets: assets, hazard_events: hazards })
    assert.match(rows[0].overlap, /must not be summed/i)
  })
})

describe('R-93 — the median is the median, at even n', () => {
  it('averages the middle pair instead of taking the upper one', () => {
    // `sorted[Math.floor(n/2)]` gives 3 for [1,2,3,4]. That expression was on
    // `src/districts.js:178` and `src/kpi.js:69`, so it biased every
    // even-length median high by up to half the central gap.
    assert.equal(median([1, 2, 3, 4]), 2.5)
    assert.equal(median([4, 3, 2, 1]), 2.5)
    assert.equal(median([1, 2, 3]), 2)
    assert.equal(median([10]), 10)
    assert.equal(median([1, 2]), 1.5)
  })

  it('is null for nothing, and null for only non-numbers', () => {
    assert.equal(median([]), null)
    assert.equal(median(null), null)
    assert.equal(median([null, undefined, NaN]), null)
  })
})

describe('sumMeasured — an absent term is skipped, and the skip is countable', () => {
  it('sums only measured values and reports how many were measured', () => {
    const rows = [{ n: 5 }, { n: null }, { n: 0 }, { n: undefined }, { n: 7 }]
    const result = sumMeasured(rows, 'n')
    assert.equal(result.total, 12)
    assert.equal(result.measured, 3)
    assert.equal(result.of, 5)
  })
})
