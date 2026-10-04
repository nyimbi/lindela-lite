#!/usr/bin/env node
/**
 * Per-region calibration and trust score (ENH-03).
 *
 * The permanent `false_alert: null` was the platform's largest unknown. This
 * module performs the join that resolves it where the evidence exists, and the
 * tests below are mostly about where it refuses to. The failure being guarded
 * is specific: a district with four resolved alerts reporting a trust score of
 * 12 would be read as a measurement of that district rather than as the absence
 * of one, and a focal point acting on it would be acting on nothing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CALIBRATION_BASIS,
  MIN_DETERMINED_ALERTS,
  alertOutcomeCalibration,
  calibrationByRegion,
  modelSkillCalibration,
  trustScore,
} from '../src/calibration.js'
import { MIN_EVENTS, MIN_MONTHS } from '../src/flood-probability.js'

const alerts = (region, { count, falseCount, unresolved = 0 }) => [
  ...Array.from({ length: count }, (_, i) => ({ id: `${region}-ok-${i}`, region_name: region, false_alert: i < falseCount })),
  ...Array.from({ length: unresolved }, (_, i) => ({ id: `${region}-un-${i}`, region_name: region, false_alert: null })),
]

describe('alert outcome calibration', () => {
  it('measures a false-alert rate once the sample clears the floor', () => {
    const { regions, refusals } = alertOutcomeCalibration(alerts('Turkana', { count: 40, falseCount: 8 }))
    assert.equal(refusals.length, 0)
    assert.equal(regions[0].resolved, 40)
    assert.equal(regions[0].false_alert_rate, 0.2)
    const wilson = regions[0].false_alert_rate_wilson
    assert.ok(wilson.low < 0.2 && wilson.high > 0.2, 'the point estimate sits inside its own interval')
  })

  it('refuses below the sample floor rather than reporting a rate off a few alerts', () => {
    const { regions, refusals } = alertOutcomeCalibration(alerts('Juba', { count: 4, falseCount: 1 }))
    assert.equal(regions[0].false_alert_rate, null)
    assert.equal(regions[0].false_alert_rate_wilson, null)
    assert.equal(refusals.length, 1)
    assert.match(regions[0].refusal, new RegExp(`of the ${MIN_DETERMINED_ALERTS} required`))
  })

  it('refuses an all-one-class region, where the rate would be a confident 0 or 1', () => {
    for (const falseCount of [0, 40]) {
      const { regions } = alertOutcomeCalibration(alerts('Mogadishu', { count: 40, falseCount }))
      assert.equal(regions[0].false_alert_rate, null)
      assert.match(regions[0].refusal, /no contrast/)
    }
  })

  it('counts an unresolved alert as coverage, never as a miss', () => {
    // An alert nobody reviewed is unknown. Folding it into the numerator would
    // state a false-alert rate the store cannot support; folding it into the
    // denominator would dilute a real rate with unrecorded outcomes.
    const { regions } = alertOutcomeCalibration(alerts('Turkana', { count: 40, falseCount: 8, unresolved: 60 }))
    const row = regions[0]
    assert.equal(row.raised, 100)
    assert.equal(row.resolved, 40)
    assert.equal(row.unresolved, 60)
    assert.equal(row.false_alert_rate, 0.2, 'the rate is over resolved alerts only')
    assert.equal(row.outcome_coverage, 0.4)
  })

  it('treats an absent determination as unresolved rather than false', () => {
    const { regions } = alertOutcomeCalibration([
      ...alerts('Turkana', { count: 40, falseCount: 8 }),
      { id: 'no-field', region_name: 'Turkana' },
      { id: 'string-null', region_name: 'Turkana', false_alert: 'null' },
    ])
    assert.equal(regions[0].raised, 42)
    assert.equal(regions[0].resolved, 40)
    assert.equal(regions[0].unresolved, 2)
  })

  it('groups on the district field when region_name is absent', () => {
    const { regions } = alertOutcomeCalibration([
      ...Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, district: 'Wajir', false_alert: i < 4 })),
    ])
    assert.equal(regions[0].region, 'Wajir')
    assert.equal(regions[0].false_alert_rate, 0.1)
  })

  it('produces nothing for no alerts at all', () => {
    const { regions, refusals } = alertOutcomeCalibration([])
    assert.deepEqual(regions, [])
    assert.deepEqual(refusals, [])
  })
})

describe('model skill calibration', () => {
  const card = (over = {}) => ({
    region_name: 'Turkana',
    country: 'KE',
    model: { training: { months: 300, flood_months: 12 } },
    folds: { folds: { brier_score: 0.08, brier_of_base_rate: 0.1, skill_over_base_rate: 0.2, validated_months: 250, n_folds: 30 } },
    ...over,
  })

  it('reads held-out skill off the card rather than refitting it', () => {
    const { regions } = modelSkillCalibration([card()])
    assert.equal(regions[0].skill_over_base_rate, 0.2)
    assert.equal(regions[0].validated_months, 250)
    assert.equal(regions[0].refusal, null)
  })

  it('keeps a negative skill negative rather than clamping it to zero', () => {
    // A model worse than always predicting the base rate is actively misleading.
    // Clamped, it would read as "no better than chance".
    const { regions } = modelSkillCalibration([card({ folds: { folds: { brier_score: 0.2, skill_over_base_rate: -0.5, validated_months: 250 } } })])
    assert.equal(regions[0].skill_over_base_rate, -0.5)
  })

  it("refuses a card trained below the model's own floors", () => {
    const short = card({ model: { training: { months: MIN_MONTHS - 1, flood_months: 12 } } })
    const { regions, refusals } = modelSkillCalibration([short])
    assert.equal(regions.length, 0)
    assert.match(refusals[0].refusal, new RegExp(`floor of ${MIN_MONTHS}`))
  })

  it('refuses a card trained below the model event floor', () => {
    const { refusals } = modelSkillCalibration([card({ model: { training: { months: 300, flood_months: MIN_EVENTS - 1 } } })])
    assert.match(refusals[0].refusal, new RegExp(`floor of ${MIN_EVENTS}`))
  })

  it('refuses a card with no folds and repeats why', () => {
    const { regions, refusals } = modelSkillCalibration([card({ folds: { refusal: 'need at least 3 calendar years to validate, have 2' } })])
    assert.equal(regions.length, 0)
    assert.match(refusals[0].refusal, /calendar years/)
  })

  it('refuses a card whose folds carry no finite skill number', () => {
    const { refusals } = modelSkillCalibration([card({ folds: { folds: { brier_score: 0.08, skill_over_base_rate: null, validated_months: 250 } } })])
    assert.match(refusals[0].refusal, /no finite skill number/)
  })
})

describe('trust score', () => {
  it('is null when any term is unmeasurable, rather than scoring the gap as zero', () => {
    const result = trustScore({ measuredRate: 0.9, sampleAdequacy: null, outcomeCoverage: 0.5 })
    assert.equal(result.score, null)
    assert.match(result.refusal, /sample_sufficiency not measurable/)
    assert.equal(result.terms.sample_sufficiency, null)
    assert.equal(result.terms.measured_rate, 0.9, 'the measurable terms are still reported')
  })

  it('is null with no terms at all', () => {
    assert.equal(trustScore().score, null)
    assert.equal(trustScore({}).score, null)
  })

  it('refuses a non-finite term', () => {
    const result = trustScore({ measuredRate: NaN, sampleAdequacy: 1, outcomeCoverage: 1 })
    assert.equal(result.score, null)
    assert.match(result.refusal, /measured_rate not measurable/)
  })

  it('weights a well-measured, well-covered region above a small one', () => {
    const big = trustScore({ measuredRate: 0.85, sampleAdequacy: 1, outcomeCoverage: 1 })
    const small = trustScore({ measuredRate: 0.85, sampleAdequacy: 0.2, outcomeCoverage: 1 })
    assert.ok(big.score > small.score)
    assert.equal(big.score, 93)
  })

  it('penalises a system nobody reviews', () => {
    const reviewed = trustScore({ measuredRate: 0.9, sampleAdequacy: 1, outcomeCoverage: 1 })
    const unreviewed = trustScore({ measuredRate: 0.9, sampleAdequacy: 1, outcomeCoverage: 0.1 })
    assert.ok(unreviewed.score < reviewed.score, 'an unreviewed system\'s accuracy is untested, and scores accordingly')
  })

  it('reports its weights so a reader can decompose the composite', () => {
    const result = trustScore({ measuredRate: 0.9, sampleAdequacy: 1, outcomeCoverage: 1 })
    const sum = Object.values(result.weights).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9)
    assert.ok(result.score >= 0 && result.score <= 100)
  })
})

describe('calibration by region', () => {
  const card = {
    region_name: 'Juba',
    country: 'SS',
    model: { training: { months: 300, flood_months: 20 } },
    folds: { folds: { brier_score: 0.09, brier_of_base_rate: 0.1, skill_over_base_rate: 0.1, validated_months: 250 } },
  }

  it('scores a region with enough resolved outcomes', () => {
    const [row] = calibrationByRegion({ alert_events: alerts('Turkana', { count: 40, falseCount: 8 }) })
    assert.equal(row.alerts_resolved, 40)
    assert.equal(row.false_alert_rate, 0.2)
    assert.equal(row.trust_refusal, null)
    assert.ok(row.trust_score > 0)
    assert.equal(row.honesty.value, row.trust_score)
    assert.equal(row.honesty.limits.kind, 'trust_score')
  })

  it('keeps the trust score null for a region short of outcomes, and says so on the record', () => {
    const [row] = calibrationByRegion({ alert_events: alerts('Juba', { count: 3, falseCount: 1 }) })
    assert.equal(row.trust_score, null)
    assert.match(row.trust_refusal, /not measurable/)
    assert.match(row.honesty.refused.join(' '), /of the 30 required/)
  })

  it('falls back to model skill when no alert outcome is recorded', () => {
    const [row] = calibrationByRegion({
      alert_events: alerts('Juba', { count: 5, unresolved: 5 }),
      flood_probability_models: [card],
    })
    assert.equal(row.false_alert_rate, null)
    assert.ok(row.trust_score !== null)
    assert.match(row.basis, /leave-one-year-out skill/)
  })

  it('stays null when neither alert outcomes nor a model exist', () => {
    const [row] = calibrationByRegion({ alert_events: alerts('Mogadishu', { count: 10, unresolved: 90 }) })
    assert.equal(row.trust_score, null)
    assert.match(row.trust_refusal, /measured_rate, sample_sufficiency/)
    assert.equal(row.basis, 'no measured rate available')
  })

  it('states on every record what a trust score is not', () => {
    const [row] = calibrationByRegion({ alert_events: alerts('Turkana', { count: 40, falseCount: 8 }) })
    assert.match(CALIBRATION_BASIS.what_a_trust_score_is_not, /not a property of the risk score/)
    assert.ok(row.honesty.not_included.some((n) => /future alert/.test(n)))
    assert.ok(row.honesty.not_included.some((n) => /risk score itself/.test(n)))
  })

  it('never claims the risk score itself is calibrated by an alert outcome', () => {
    // The refusals list in docs/improvements/enhancements.md rejected clearing
    // `calibrated_uncertainty` on the risk score from this work. Alert-outcome
    // calibration and score calibration are different quantities, and a score
    // flagged by one would be validated by a measurement of the other.
    const [row] = calibrationByRegion({ alert_events: alerts('Turkana', { count: 40, falseCount: 8 }) })
    assert.equal(row.calibrated_uncertainty, undefined)
    assert.equal(row.honesty.limits.calibrated_uncertainty, false)
  })
})
