import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COMPARISON_REFUSALS,
  DIRECTIONS,
  compareScenarios,
  intervalFromOutcomes,
} from '../src/scenario-compare.js'

/**
 * ENH-55 — scenario comparison workbench.
 *
 * The tests are written against the three ways the entry says a comparison
 * lies. First, that a comparison is only valid over the same region and window,
 * so a mismatch is *refused* rather than differenced. Second, that uncertainty
 * is compared and not just the point estimate, so two scenarios whose intervals
 * overlap are reported as not distinguishable rather than ranked by mean.
 * Third, that a refused scenario is a refusal and not a worse score, so it
 * sorts to the end and is labelled rather than read as zero.
 *
 * Every number below is hand-derivable from the intervals, so a reader can
 * recompute the difference and its bound without running the code.
 */

const WINDOW = { start: '2026-03-01', end: '2026-05-31' }
const REGION = 'Turkana'

/** A scored scenario: an estimate with the interval its model reported. */
const scored = (name, estimate, low, high, over = {}) => ({
  name,
  region: REGION,
  window: WINDOW,
  estimate,
  interval: { low, high, level: 0.95 },
  ...over,
})

const CONVOY = scored('Convoy to Lodwar', 120, 100, 140)
const ALT = scored('Convoy to Maralal', 200, 190, 210)

const compare = (over = {}) => compareScenarios({
  scenarios: [CONVOY, ALT],
  metric: 'expected_unmet',
  ...over,
})

describe('a comparison over one region and window (ENH-55)', () => {
  it('differences two scenarios with the interval of the difference', () => {
    const result = compare()
    assert.equal(result.refusal, null)
    assert.equal(result.region, REGION)
    assert.deepEqual(result.window, WINDOW)

    // Best first under the default direction: the lower expected unmet leads.
    assert.deepEqual(result.scenarios.map((s) => s.name), ['Convoy to Lodwar', 'Convoy to Maralal'])
    assert.deepEqual(result.scenarios.map((s) => s.rank), [1, 2])

    // The difference is closed-form: 120 − 200.
    assert.equal(result.differences.length, 1)
    const [pair] = result.differences
    assert.equal(pair.difference, -80)
    // The bound is interval arithmetic: [100 − 210, 140 − 190].
    assert.equal(pair.interval.low, -110)
    assert.equal(pair.interval.high, -50)
    // It lies entirely below zero, so the two are distinguishable and the
    // lower-cost scenario is favoured.
    assert.equal(pair.distinguishable, true)
    assert.equal(pair.favours, 'Convoy to Lodwar')
    // The intervals are disjoint, so no overlap.
    assert.equal(pair.overlap_fraction, 0)
  })

  it('states the decision the data supports, separately from the difference', () => {
    const result = compare()
    assert.equal(result.decision.supported, true)
    assert.equal(result.decision.better, 'Convoy to Lodwar')
    assert.deepEqual(result.decision.not_supported, [])
    // The decision is its own object, not read off a difference.
    assert.equal(typeof result.decision.statement, 'string')
  })

  it('is deterministic, so a stored comparison is re-derivable', () => {
    const a = compare()
    const b = compare()
    assert.equal(a.id, b.id)
    assert.deepEqual(a.scenarios, b.scenarios)
    assert.deepEqual(a.differences, b.differences)
  })

  it('ranks by the stated direction, not by the sign of the number', () => {
    // The same two estimates, read as a higher-is-better metric, rank in the
    // opposite order — the direction is the caller's claim, not the module's
    // inference.
    const result = compareScenarios({
      scenarios: [CONVOY, ALT],
      metric: 'people_reached',
      direction: DIRECTIONS.HIGHER_IS_BETTER,
    })
    assert.equal(result.decision.supported, true)
    assert.equal(result.decision.better, 'Convoy to Maralal')
    assert.deepEqual(result.scenarios.map((s) => s.name), ['Convoy to Maralal', 'Convoy to Lodwar'])
  })
})

describe('a comparison of two different things is refused, not differenced (ENH-55)', () => {
  it('refuses scenarios over different regions', () => {
    const result = compareScenarios({
      scenarios: [CONVOY, scored('Convoy to Maralal', 200, 190, 210, { region: 'Marsabit' })],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.equal(result.differences, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
    // It says so by the rule counterfactual.js states, because it is that rule.
    assert.match(result.reason, /counterfactual\.js/)
    assert.match(result.reason, /region/)
  })

  it('refuses scenarios over different windows', () => {
    const result = compareScenarios({
      scenarios: [
        CONVOY,
        scored('Convoy to Maralal', 200, 190, 210, { window: { start: '2026-06-01', end: '2026-08-31' } }),
      ],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
    // A difference over two windows includes the difference in windows.
    assert.match(result.reason, /two windows/)
  })

  it('refuses when the comparison names a region the scenarios are not over', () => {
    const result = compare({ region: 'Marsabit' })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
  })

  it('refuses a scenario that names no window', () => {
    const result = compareScenarios({
      scenarios: [{ name: 'A', region: REGION, estimate: 120, interval: { low: 100, high: 140 } }, CONVOY],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /mismatched_comparison_set/)
    assert.match(result.reason, /no window/)
  })
})

describe('overlapping uncertainty is reported, not ranked away (ENH-55)', () => {
  it('marks two scenarios whose intervals overlap as not distinguishable', () => {
    // The point estimates differ by 10, but the intervals are 100–140 and
    // 110–150: the difference could be zero, so no order between them is
    // supported.
    const result = compareScenarios({
      scenarios: [scored('Convoy to Lodwar', 120, 100, 140), scored('Convoy to Maralal', 130, 110, 150)],
      metric: 'expected_unmet',
    })
    assert.equal(result.refusal, null)

    const [pair] = result.differences
    assert.equal(pair.difference, -10)
    // [100 − 150, 140 − 110] straddles zero.
    assert.equal(pair.interval.low, -50)
    assert.equal(pair.interval.high, 30)
    assert.equal(pair.distinguishable, false)
    assert.equal(pair.favours, null)
    // 30 units of overlap against a 40-unit narrower interval.
    assert.equal(pair.overlap_fraction, 0.75)

    // The decision is that there is none: the means are not an order.
    assert.equal(result.decision.supported, false)
    assert.equal(result.decision.better, null)
    assert.equal(result.decision.not_supported.length, 1)
    assert.match(result.decision.statement, /does not support ranking/)
  })

  it('still ranks when the intervals are disjoint, so the two cases are distinct', () => {
    // The mirror of the overlap case: same shape, intervals pulled apart. If
    // both cases read the same, the overlap test would be passing for the wrong
    // reason.
    const result = compareScenarios({
      scenarios: [scored('Convoy to Lodwar', 120, 100, 140), scored('Convoy to Maralal', 130, 1000, 1100)],
      metric: 'expected_unmet',
    })
    assert.equal(result.decision.supported, true)
    assert.equal(result.decision.better, 'Convoy to Lodwar')
    assert.equal(result.differences[0].distinguishable, true)
  })

  it('does not narrow the difference interval as an independence assumption would', () => {
    // The bound is interval arithmetic, so it holds for any correlation — the
    // two scenarios share a region and a window and are not independent draws.
    const result = compare()
    assert.match(result.differences[0].interval.method, /interval arithmetic/)
    assert.match(result.differences[0].interval.assumes, /correlation/)
  })
})

describe('a refused scenario is a refusal, not a worse score (ENH-55)', () => {
  const REFUSED = {
    name: 'Convoy via Maralal road',
    region: REGION,
    window: WINDOW,
    refusal: 'thin_comparison_arm: 2 matched comparison unit(s) with a usable outcome; 3 are needed, and a counterfactual from fewer is worse than none',
  }

  it('sorts the refused scenario last and labels it rather than scoring it', () => {
    const result = compareScenarios({
      scenarios: [REFUSED, CONVOY],
      metric: 'expected_unmet',
    })
    assert.equal(result.refusal, null)
    // The scored scenario ranks; the refused one follows with no rank.
    assert.equal(result.scenarios.length, 2)
    assert.equal(result.scenarios[0].name, 'Convoy to Lodwar')
    assert.equal(result.scenarios[0].rank, 1)
    assert.equal(result.scenarios[1].name, 'Convoy via Maralal road')
    assert.equal(result.scenarios[1].refused, true)
    assert.equal(result.scenarios[1].rank, null)
    // Never scored as zero or infinity — the estimate is absent, not small.
    assert.equal(result.scenarios[1].estimate, null)
    assert.equal(result.scenarios[1].interval, null)
    // It carries the model's own sentence, so the surface renders the refusal.
    assert.match(result.scenarios[1].refusal, /thin_comparison_arm/)
    assert.deepEqual(result.refused, ['Convoy via Maralal road'])
    assert.equal(result.not_compared.length, 1)
  })

  it('does not difference a refused scenario against the scored ones', () => {
    const result = compareScenarios({ scenarios: [REFUSED, CONVOY], metric: 'expected_unmet' })
    // One scored scenario yields no pairs, so no difference mentions the refusal.
    assert.deepEqual(result.differences, [])
    assert.equal(result.decision.supported, false)
    assert.equal(result.decision.better, null)
  })

  it('renders a refusal with no sentence through the model registry', () => {
    const viaRegistry = {
      name: 'Convoy via Maralal road',
      region: REGION,
      window: WINDOW,
      refused: true,
      model: 'counterfactual',
      refusal_code: 'thin_comparison_arm',
    }
    const result = compareScenarios({ scenarios: [viaRegistry, CONVOY], metric: 'expected_unmet' })
    // The registry supplies the model's own basis sentence where the number is.
    assert.equal(result.scenarios[1].refused, true)
    assert.equal(typeof result.scenarios[1].refusal, 'string')
    assert.ok(result.scenarios[1].refusal.length > 0)
  })
})

describe('inputs that cannot support a comparison are refused (ENH-55)', () => {
  it('refuses fewer than two scenarios', () => {
    const result = compareScenarios({ scenarios: [CONVOY], metric: 'expected_unmet' })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /too_few_scenarios/)
  })

  it('refuses an estimate with no uncertainty', () => {
    const result = compareScenarios({
      scenarios: [
        { name: 'A', region: REGION, window: WINDOW, estimate: 120 },
        { name: 'B', region: REGION, window: WINDOW, estimate: 200, interval: { low: 190, high: 210 } },
      ],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /unmeasured_uncertainty/)
  })

  it('refuses two scenarios sharing a name', () => {
    const result = compareScenarios({
      scenarios: [CONVOY, scored('Convoy to Lodwar', 200, 190, 210)],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /duplicate_scenario_name/)
  })

  it('exposes its refusal vocabulary', () => {
    assert.ok(COMPARISON_REFUSALS.includes('mismatched_comparison_set'))
    assert.ok(COMPARISON_REFUSALS.includes('too_few_scenarios'))
  })
})

describe('a prepositioning plan is a first-class scenario (ENH-55)', () => {
  it('reads expected_unmet as the estimate and derives the interval from the outcomes', () => {
    // The shape `planPrepositioning` returns carries `expected_unmet` as a
    // number; the spread across the futures it was computed over is the
    // uncertainty. This scenario supplies both and drops straight in.
    const plan = {
      name: 'Stage at Lodwar',
      region: REGION,
      window: WINDOW,
      expected_unmet: 75,
      outcomes: [0, 100, 200],
    }
    const result = compareScenarios({ scenarios: [plan, ALT], metric: 'expected_unmet' })
    assert.equal(result.refusal, null)
    const staged = result.scenarios.find((s) => s.name === 'Stage at Lodwar')
    assert.equal(staged.estimate, 75)
    // The percentile interval of [0, 100, 200] at 95%.
    assert.equal(staged.interval.low, 5)
    assert.equal(staged.interval.high, 195)
  })

  it('derives no interval from a single outcome, and so refuses the scenario', () => {
    assert.equal(intervalFromOutcomes([42]), null)
    const result = compareScenarios({
      scenarios: [
        { name: 'Stage at Lodwar', region: REGION, window: WINDOW, expected_unmet: 75, outcomes: [75] },
        ALT,
      ],
      metric: 'expected_unmet',
    })
    assert.equal(result.scenarios, null)
    assert.match(result.refusal, /unmeasured_uncertainty/)
  })
})
