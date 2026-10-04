#!/usr/bin/env node
/**
 * Model-drift monitoring (ENH-05).
 *
 * The distinction every test here defends: **drift detected** is not **no
 * drift**, and neither is **not enough data to tell**. A monitor that reported
 * "stable" from two observations would be asserting a negative about a sample
 * too small to support any statement, and the archive backfill means these
 * coefficients will move substantially as the labels grow — so the failure this
 * guards is not hypothetical.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DRIFT_BASIS,
  MIN_DRIFT_EVENTS,
  MIN_DRIFT_WINDOW_MONTHS,
  PSI_DRIFT,
  PSI_WATCH,
  detectDrift,
  detectInputShift,
  detectOutcomeDivergence,
  driftReport,
  populationStabilityIndex,
} from '../src/drift.js'

/** `count` monthly samples whose features sit at `offset` and drift cyclically. */
const window = (count, offset, { eventEvery = 5 } = {}) => Array.from({ length: count }, (_, i) => ({
  month: `20${String(10 + Math.floor(i / 12)).slice(-2)}-${String((i % 12) + 1).padStart(2, '0')}`,
  features: {
    max_7_day: 50 + offset + (i % 7),
    sum_30_day: 200 + offset * 2 + (i % 11),
    sum_90_day: 500 + offset * 3,
  },
  label: eventEvery ? i % eventEvery === 0 : false,
}))

const stubModel = { intercept: -3, coefficients: [{ feature: 'max_7_day', value: 0.4 }], standardization: [{ feature: 'max_7_day', mean: 50, sd: 10 }] }

describe('population stability index', () => {
  it('is near zero for two windows of the same distribution', () => {
    const result = populationStabilityIndex(window(200, 0).map((s) => s.features.max_7_day), window(200, 0).map((s) => s.features.max_7_day))
    assert.ok(result.psi < PSI_WATCH, `${result.psi} should not read as a shift between identical distributions`)
  })

  it('rises past the drift band when the window moves', () => {
    const result = populationStabilityIndex(window(200, 0).map((s) => s.features.max_7_day), window(200, 400).map((s) => s.features.max_7_day))
    assert.ok(result.psi >= PSI_DRIFT, `${result.psi} should read as material drift`)
  })

  it('refuses a window too small to bin', () => {
    const result = populationStabilityIndex([1, 2], [1, 2, 3, 4, 5, 6])
    assert.equal(result.psi, null)
    assert.match(result.reason, /need at least 5 finite values/)
  })

  it('drops non-finite values rather than binning NaN', () => {
    const result = populationStabilityIndex([...Array.from({ length: 20 }, (_, i) => i), NaN, null], Array.from({ length: 20 }, (_, i) => i))
    assert.equal(result.psi, 0)
    assert.equal(result.reference_count, 20)
  })

  it('quantifies a bin the reference never populated instead of returning infinity', () => {
    // The current window fills a bin the reference left empty. That is a shift
    // the measure can express, and a division by zero would refuse to.
    const reference = Array.from({ length: 40 }, (_, i) => i)
    const current = [...reference.slice(0, 20), ...Array.from({ length: 20 }, (_, i) => 100 + i)]
    const result = populationStabilityIndex(reference, current)
    assert.ok(Number.isFinite(result.psi))
    assert.ok(result.psi > PSI_WATCH)
  })
})

describe('input distribution shift', () => {
  it('reports drift when the features have moved', () => {
    const result = detectInputShift(window(40, 0), window(40, 400))
    assert.equal(result.verdict, 'drift')
    assert.equal(result.reason, null)
    assert.ok(result.features.max_7_day.psi >= PSI_DRIFT)
  })

  it('reports stable for two windows of the same distribution', () => {
    assert.equal(detectInputShift(window(40, 0), window(40, 0)).verdict, 'stable')
  })

  it('refuses rather than reporting stable when a window is too short', () => {
    const result = detectInputShift(window(MIN_DRIFT_WINDOW_MONTHS - 1, 0), window(40, 400))
    assert.equal(result.verdict, 'not_measurable')
    assert.equal(result.worst_psi, undefined)
    assert.match(result.reason, new RegExp(`>= ${MIN_DRIFT_WINDOW_MONTHS} months`))
  })

  it('reports no drift at all from a single observation in the current window', () => {
    const result = detectInputShift(window(40, 0), window(1, 5000))
    assert.equal(result.verdict, 'not_measurable')
    assert.match(result.reason, /1 current/)
  })
})

describe('score and outcome divergence', () => {
  it('reports drift when the observed rate falls outside the interval around the predicted mean', () => {
    const current = window(200, 0, { eventEvery: 2 })
    const result = detectOutcomeDivergence(current, stubModel)
    assert.equal(result.verdict, 'drift')
    assert.equal(result.direction, 'under_predicted')
    assert.ok(result.mean_predicted < result.observed_rate_wilson.low)
  })

  it('reports aligned when the observed rate sits inside its own interval around the prediction', () => {
    // 10 events in 200 months: the observed 5% brackets the stub model's ~5.3%
    // mean prediction, so the interval covers it and there is nothing to report.
    const result = detectOutcomeDivergence(window(200, 0, { eventEvery: 20 }), stubModel)
    assert.equal(result.verdict, 'stable')
    assert.equal(result.direction, 'aligned')
    assert.ok(result.gap !== null)
  })

  it('refuses on too few months, naming the count it has', () => {
    const result = detectOutcomeDivergence(window(5, 0, { eventEvery: 1 }), stubModel)
    assert.equal(result.verdict, 'not_measurable')
    assert.match(result.reason, new RegExp(`>= ${MIN_DRIFT_WINDOW_MONTHS} months`))
  })

  it('refuses on too few events however many months there are', () => {
    // One observed event is that event, not a rate.
    const result = detectOutcomeDivergence(window(40, 0, { eventEvery: 0 }), stubModel)
    assert.equal(result.verdict, 'not_measurable')
    assert.equal(result.events, 0)
    assert.match(result.reason, new RegExp(`>= ${MIN_DRIFT_EVENTS} observed events`))
  })

  it('refuses when any month carries a non-finite feature the model cannot score', () => {
    const current = window(200, 0, { eventEvery: 2 })
    current[3] = { ...current[3], features: { ...current[3].features, max_7_day: NaN } }
    const result = detectOutcomeDivergence(current, stubModel)
    assert.equal(result.verdict, 'not_measurable')
    assert.match(result.reason, /non-finite feature/)
  })

  it('refuses without a model, and still reports the observed rate it did measure', () => {
    const result = detectOutcomeDivergence(window(40, 0, { eventEvery: 2 }), null)
    assert.equal(result.verdict, 'not_measurable')
    assert.match(result.reason, /no model was supplied/)
    assert.equal(result.observed_rate, 0.5)
    assert.ok(result.observed_rate_wilson.low > 0)
  })
})

describe('drift record', () => {
  it('carries both signals and takes the worse verdict', () => {
    const record = detectDrift({ region: 'Turkana', referenceSamples: window(40, 0), currentSamples: window(40, 400) })
    assert.equal(record.type, 'model_drift')
    assert.equal(record.verdict, 'drift')
    assert.equal(record.measurable, true)
    assert.equal(record.input_shift.verdict, 'drift')
    assert.equal(record.honesty.limits.kind, 'drift_verdict')
  })

  it('distinguishes not_measurable from stable on the record itself', () => {
    const thin = detectDrift({ region: 'Juba', referenceSamples: window(40, 0), currentSamples: window(3, 0) })
    assert.equal(thin.verdict, 'not_measurable')
    assert.equal(thin.measurable, false)
    assert.ok(thin.honesty.refused.length > 0)
    assert.match(thin.honesty.refused.join(' '), /not a finding that the model has not drifted/)

    const clean = detectDrift({ region: 'Juba', referenceSamples: window(40, 0), currentSamples: window(40, 0) })
    assert.equal(clean.verdict, 'stable')
    assert.equal(clean.measurable, true)
  })

  it('reports drift on input shift alone, and says the second signal could not be measured', () => {
    // Divergence needs events; a window can shift its rainfall distribution and
    // still contain too few of them. The absence of the second measurement is
    // not evidence of its absence of a finding.
    const current = window(40, 400, { eventEvery: 100 })
    const record = detectDrift({ region: 'Turkana', referenceSamples: window(40, 0), currentSamples: current, model: stubModel })
    assert.equal(record.verdict, 'drift')
    assert.equal(record.outcome_divergence.verdict, 'not_measurable')
    assert.ok(record.honesty.refused.some((r) => /observed events/.test(r)))
  })

  it('states that it diagnoses no cause and changes no coefficient', () => {
    const record = detectDrift({ region: 'Turkana', referenceSamples: window(40, 0), currentSamples: window(40, 400) })
    assert.ok(record.honesty.not_included.some((n) => /the cause/.test(n)))
    assert.ok(record.honesty.not_included.some((n) => /any refit/.test(n)))
    assert.match(DRIFT_BASIS.what_a_drift_verdict_is_not, /^a cause/)
  })

  it('names no scale word for its tiers', () => {
    const record = detectDrift({ region: 'Turkana', referenceSamples: window(40, 0), currentSamples: window(40, 400) })
    assert.deepEqual(Object.keys(record.uncertainty), ['model_parameter', 'sampling', 'coverage'])
    assert.doesNotMatch(JSON.stringify(record.uncertainty), /confidence interval|predictive interval/i)
  })
})

describe('drift report', () => {
  it('counts each verdict and lists the regions it could not measure', () => {
    const report = driftReport({
      regions: [
        { region: 'Turkana', referenceSamples: window(40, 0), currentSamples: window(40, 400) },
        { region: 'Mogadishu', referenceSamples: window(40, 0), currentSamples: window(40, 0) },
        { region: 'Juba', referenceSamples: window(40, 0), currentSamples: window(2, 0) },
      ],
    })
    assert.equal(report.regions, 3)
    assert.equal(report.drift, 1)
    assert.equal(report.stable, 1)
    assert.equal(report.not_measurable, 1)
    assert.deepEqual(report.records.filter((r) => r.verdict === 'not_measurable').map((r) => r.region_name), ['Juba'])
  })

  it('is empty rather than clean when no region was passed', () => {
    const report = driftReport({})
    assert.equal(report.regions, 0)
    assert.equal(report.drift, 0)
    assert.equal(report.not_measurable, 0)
  })
})
