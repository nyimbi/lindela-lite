import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BASELINE_TOLERANCE,
  MIN_ARM_UNITS,
  RADIUS_RATIO_MAX,
  counterfactualImpact,
  differenceInDifferences,
  matchComparisonSet,
  seededRng,
} from '../src/counterfactual.js'

/**
 * ENH-58 — counterfactual impact evaluation.
 *
 * The estimate is difference-in-differences over a matched comparison arm, and
 * the tests here are written against the two things that make it trustworthy:
 * the arithmetic (a closed-form DiD a reader can recompute by hand) and the
 * refusals (a comparison set too thin or too mismatched returns no number).
 *
 * The bootstrap interval is asserted for *structure and reproducibility*, not
 * for a hand-computed bound: the seed makes two calls identical, and the point
 * estimate is closed-form so it can be asserted exactly. A test that pinned a
 * percentile to four decimals would be testing the RNG, not the estimator.
 */

/** A treated/comparison unit with explicit structure, so the arms are legible. */
const unit = (code, before, after, { country = 'KE', level = 2, radius_km = 150 } = {}) => ({
  unit_code: code,
  country,
  level,
  radius_km,
  outcome_before: before,
  outcome_after: after,
})

/**
 * A clean case: four treated and four comparison units, same country, level and
 * radius. Treated arms rise by ~15, comparison by ~2.5, so the DiD is 12.5.
 */
const TREATED = [
  unit('KE-T1', 40, 55),
  unit('KE-T2', 45, 62),
  unit('KE-T3', 38, 50),
  unit('KE-T4', 42, 58),
]
const COMPARISON = [
  unit('KE-C1', 40, 43),
  unit('KE-C2', 44, 46),
  unit('KE-C3', 39, 41),
  unit('KE-C4', 41, 44),
]

describe('counterfactual impact evaluation (ENH-58)', () => {
  it('reports the difference-in-differences with an interval', () => {
    const result = counterfactualImpact({ treated: TREATED, comparison: COMPARISON, metric: 'people_reached' })
    assert.equal(result.estimator, 'difference-in-differences')
    // Treated delta 15, comparison delta 2.5, so the effect is 12.5.
    assert.equal(result.estimate, 12.5)
    assert.equal(result.refusal, null)
    assert.equal(result.arms.treated_units, 4)
    assert.equal(result.arms.comparison_units, 4)
    assert.equal(result.arms.treated_delta, 15)
    assert.equal(result.arms.comparison_delta, 2.5)
  })

  it('carries uncertainty as a bootstrap interval that brackets the estimate', () => {
    const { interval } = counterfactualImpact({ treated: TREATED, comparison: COMPARISON })
    assert.equal(interval.level, 0.95)
    assert.match(interval.method, /bootstrap/)
    assert.ok(Number.isFinite(interval.low) && Number.isFinite(interval.high))
    assert.ok(interval.low <= interval.high)
    assert.ok(interval.low <= 12.5 && interval.high >= 12.5, 'the interval must bracket the point estimate')
  })

  it('is reproducible for a seed and stable in the point estimate', () => {
    const a = counterfactualImpact({ treated: TREATED, comparison: COMPARISON, seed: 42 })
    const b = counterfactualImpact({ treated: TREATED, comparison: COMPARISON, seed: 42 })
    assert.deepEqual(a.interval, b.interval)
    assert.equal(a.estimate, b.estimate)
    // A different seed resamples differently; the point estimate is unaffected.
    const c = counterfactualImpact({ treated: TREATED, comparison: COMPARISON, seed: 7 })
    assert.equal(c.estimate, a.estimate)
    assert.equal(c.interval.seed, 7)
  })

  it('states the identifying assumption and that it is untestable here', () => {
    const { assumptions } = counterfactualImpact({ treated: TREATED, comparison: COMPARISON })
    assert.match(assumptions.identifying_assumption, /parallel trends/)
    assert.equal(assumptions.testable, false)
    assert.ok(assumptions.baseline_balance.imbalance <= assumptions.baseline_balance.tolerance)
  })

  it('computes the pooled DiD directly', () => {
    assert.equal(differenceInDifferences([10, 20], [1, 3]), 13)
    assert.equal(differenceInDifferences([], [1]), null)
  })

  it('refuses a comparison arm thinner than the floor, rather than returning a number', () => {
    const result = counterfactualImpact({
      treated: TREATED,
      comparison: [unit('KE-C1', 40, 43), unit('KE-C2', 44, 46)],
    })
    assert.equal(result.estimate, null)
    assert.equal(result.interval, null)
    assert.equal(typeof result.refusal, 'string')
    assert.match(result.refusal, /thin_comparison_arm/)
    // The refusal names the count it refused on.
    assert.match(result.refusal, new RegExp(String(MIN_ARM_UNITS)))
    assert.equal(result.detail.comparison_units, 2)
  })

  it('refuses a treated arm below the floor', () => {
    const result = counterfactualImpact({
      treated: [unit('KE-T1', 40, 55), unit('KE-T2', 45, 62)],
      comparison: COMPARISON,
    })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /thin_treated_arm/)
  })

  it('refuses a comparison set that matches no treated unit on country', () => {
    const result = counterfactualImpact({
      treated: TREATED,
      comparison: COMPARISON.map((u, i) => unit(`SS-C${i}`, u.outcome_before, u.outcome_after, { country: 'SS' })),
    })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
  })

  it('refuses a comparison set that matches no treated unit on radius', () => {
    const result = counterfactualImpact({
      treated: TREATED,
      comparison: COMPARISON.map((u, i) => unit(`KE-C${i}`, u.outcome_before, u.outcome_after, { radius_km: 600 })),
    })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
  })

  it('refuses a baseline the two arms do not share', () => {
    // Comparison units start near 200 against a treated baseline near 40. The
    // arms are not comparable at the start, so parallel trends cannot be assumed.
    const result = counterfactualImpact({
      treated: TREATED,
      comparison: [
        unit('KE-C1', 200, 203),
        unit('KE-C2', 210, 214),
        unit('KE-C3', 195, 198),
        unit('KE-C4', 205, 210),
      ],
    })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /baseline_imbalance/)
    assert.ok(result.detail.imbalance > BASELINE_TOLERANCE)
  })

  it('refuses when every unit moved identically, so the interval would be a point', () => {
    const flat = (prefix, n) => Array.from({ length: n }, (_, i) => unit(`${prefix}${i}`, 10, 15))
    const result = counterfactualImpact({ treated: flat('KE-T', 4), comparison: flat('KE-C', 4) })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /no_variation/)
  })

  it('refuses a treated unit with no finite outcome rather than shrinking the treated set', () => {
    const result = counterfactualImpact({
      treated: [...TREATED, { unit_code: 'KE-T5', country: 'KE', level: 2, radius_km: 150, outcome_before: 40 }],
      comparison: COMPARISON,
    })
    assert.equal(result.estimate, null)
    assert.match(result.refusal, /thin_treated_arm/)
    assert.equal(result.detail.treated_incomplete, 1)
  })

  it('matches on country, level and radius and records the decision', () => {
    const matching = matchComparisonSet({
      treated: [unit('KE-T1', 40, 55)],
      comparison: [
        unit('KE-C1', 40, 43),
        unit('SS-C1', 40, 43, { country: 'SS' }),
        unit('KE-C2', 40, 43, { radius_km: 600 }),
      ],
    })
    assert.equal(matching.matched.length, 1)
    assert.equal(matching.matched[0].unit_code, 'KE-C1')
    assert.equal(matching.refusal, null)
    const [entry] = matching.audit
    assert.equal(entry.treated, 'KE-T1')
    assert.deepEqual(entry.matched.map((m) => m.key), ['KE-C1'])
  })

  it('refuses when a treated unit has no match at all, naming it', () => {
    const matching = matchComparisonSet({
      treated: [unit('KE-T1', 40, 55)],
      comparison: [unit('SS-C1', 40, 43, { country: 'SS' })],
    })
    assert.equal(matching.matched.length, 0)
    assert.deepEqual(matching.unmatched, ['KE-T1'])
    assert.match(matching.refusal, /no comparison unit/)
  })

  it('reads structure from the org-units registry when the record omits it', () => {
    // SS-BOR and SS-AWEIL are both level-2 units with a 150 km radius in South
    // Sudan, so they match on the registry alone. KE-TURKANA is Kenyan and does
    // not.
    const matching = matchComparisonSet({
      treated: [{ unit_code: 'SS-BOR' }],
      comparison: [{ unit_code: 'SS-AWEIL' }, { unit_code: 'KE-TURKANA' }],
    })
    assert.deepEqual(matching.matched.map((u) => u.unit_code), ['SS-AWEIL'])
    const axes = matching.audit[0].matched[0].axes
    assert.equal(axes.country, true)
    assert.equal(axes.level, true)
    assert.equal(axes.radius, true)
  })

  it('honours the radius ratio constant at its boundary', () => {
    const atLimit = counterfactualImpact({
      treated: TREATED.map((u) => ({ ...u, radius_km: 150 })),
      comparison: COMPARISON.map((u) => ({ ...u, radius_km: 150 * RADIUS_RATIO_MAX })),
    })
    assert.equal(atLimit.refusal, null)
    const past = counterfactualImpact({
      treated: TREATED.map((u) => ({ ...u, radius_km: 150 })),
      comparison: COMPARISON.map((u) => ({ ...u, radius_km: 150 * RADIUS_RATIO_MAX + 1 })),
    })
    assert.match(past.refusal, /mismatched_comparison_set/)
  })

  it('produces a reproducible seeded stream in [0, 1)', () => {
    const stream = (seed, n) => {
      const rng = seededRng(seed)
      return Array.from({ length: n }, () => rng())
    }
    const head = stream(1, 20)
    for (const value of head) assert.ok(value >= 0 && value < 1)
    // Same seed, same stream; different seed, different stream.
    assert.deepEqual(stream(1, 20), head)
    assert.notDeepEqual(stream(2, 20), head)
  })
})
