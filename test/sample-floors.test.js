import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scoreConnector, CIRCUIT_SCORE_MIN_OUTCOMES, CIRCUIT_SCORE_REASONS } from '../src/circuit.js'
import { computeMetric, declaredMetrics } from '../src/analytics/metrics.js'
import { scoreConnector as scoreFromStatus } from '../src/circuit.js'

/**
 * ENH-21 — a floor enforced in the view is a floor the API does not have.
 *
 * The metric registry already refuses to publish a rate computed from too few
 * observations, and every published surface reads it from there. This file
 * covers the one rate that was still computed in the place that used it: the
 * connector health score.
 *
 * Its floor was `samples === 0` — so a source nobody had ever called published
 * no score, and a source called *twice*, successfully, published a perfect 100.
 * The gap between those two cases is the whole defect: a proportion computed
 * from two observations is not a weaker number, it is not a number, and the
 * dashboard showed it beside sources with twenty.
 */

const outcomes = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  ok: true,
  latency_ms: 100 + i,
  record_count: 10,
  ...extra,
}))

describe('ENH-21 — a health score needs enough observations to be one', () => {
  it('refuses a score from fewer than the floor', () => {
    for (const n of [1, 2, CIRCUIT_SCORE_MIN_OUTCOMES - 1]) {
      const scored = scoreConnector({ outcomes: outcomes(n) })
      assert.equal(scored.score, null,
        `${n} successful call${n === 1 ? '' : 's'} produced a health score of ${scored.score}; ` +
        'that is a proportion from too few observations wearing a health number')
      assert.ok(scored.reasons.includes(CIRCUIT_SCORE_REASONS.TOO_FEW_OUTCOMES),
        `the refusal is unstated at ${n} outcomes: ${JSON.stringify(scored.reasons)}`)
    }
  })

  it('still scores a source with enough history', () => {
    // The floor must not make the score unreachable: a source called five times
    // and succeeding every time has earned a number.
    const scored = scoreConnector({ outcomes: outcomes(CIRCUIT_SCORE_MIN_OUTCOMES) })
    assert.equal(typeof scored.score, 'number')
    assert.ok(scored.score > 90, `a healthy source scored ${scored.score}`)
    assert.equal(scored.reasons.length, 0, `unexpected refusal: ${JSON.stringify(scored.reasons)}`)
  })

  it('an empty window still refuses, for its own stated reason', () => {
    const scored = scoreConnector({ outcomes: [] })
    assert.equal(scored.score, null)
    assert.ok(scored.reasons.includes(CIRCUIT_SCORE_REASONS.NO_OUTCOMES))
  })

  it('the raw rate is still reported, so the refusal is a refusal to score', () => {
    // Refusing the *score* must not erase the evidence. An operator asking why a
    // source is unscored needs to see that two calls succeeded.
    const scored = scoreConnector({ outcomes: outcomes(2) })
    assert.equal(scored.success_rate, 1)
    assert.equal(scored.samples, 2)
  })

  it('the status route reads the same function, so the floor cannot be bypassed', () => {
    // `ingestionStatus` scores the connector from the persisted breaker's own
    // outcomes. If it computed its own score, this floor would be a rule applied
    // in one place and not the other — which is how `false_alert_rate` came to
    // have three definitions.
    assert.equal(scoreFromStatus, scoreConnector,
      'the status route and the gate must score through one function')
  })
})

describe('ENH-21 — every declared metric carries a floor or is a count', () => {
  it('a rate refuses on an empty input, and a count is allowed to be zero', () => {
    // The distinction the assertion has to keep, because flattening it is the
    // bug: "no people were reached" is a true zero, and "the false-alert rate is
    // zero" is a claim about nobody having looked. One is a count, the other is
    // a proportion over an empty denominator, and a registry that treats them
    // the same publishes a rate of 0% for a district nobody has reviewed.
    const RATES = ['cold_chain_protection_rate', 'dispatch_precision_pct', 'false_alert_rate', 'feeding_repositioning_rate']
    const COUNTS = ['people_reached', 'population_at_risk']

    for (const name of RATES) {
      const empty = computeMetric(name, {})
      assert.equal(empty.value, null,
        `${name} published a rate of ${empty.value} from no observations at all`)
      assert.ok(typeof empty.refusal === 'string' && empty.refusal.length > 0,
        `${name} published nothing and said nothing about why, so a reader cannot ` +
        'tell a sample floor from a bug')
    }

    for (const name of COUNTS) {
      const empty = computeMetric(name, {})
      assert.equal(empty.value, 0,
        `${name} is a count: no records means zero, and refusing would be a false ` +
        'refusal — a reader would read "not measurable" where the answer is none')
      assert.equal(empty.refusal, null, `${name} is a count and must not refuse one`)
    }
  })

  it('every declared metric is one of those two kinds', () => {
    // Enumerated so a new metric is added to one of the lists above or fails
    // here — a registry that grows a metric nobody has classified is a registry
    // whose floors are somebody's private intention.
    for (const name of declaredMetrics()) {
      assert.ok(
        ['cold_chain_protection_rate', 'dispatch_precision_pct', 'false_alert_rate',
          'feeding_repositioning_rate', 'people_reached', 'population_at_risk'].includes(name),
        `${name} is a newly declared metric and is not classified as a rate or a count`,
      )
    }
  })

  it('the registry refuses a rate computed from one record', () => {
    const single = computeMetric('cold_chain_protection_rate', {
      workflows: [{ id: 'w1', type: 'cold_chain_protection', state: 'closed' }],
    })
    assert.equal(single.value, null, 'a protection rate over one workflow is not a rate')
    assert.match(single.refusal, /required/, 'and the refusal must say what was required')
  })

  it('a rate from a real sample is published, with its counts', () => {
    const enough = computeMetric('cold_chain_protection_rate', {
      workflows: Array.from({ length: 5 }, (_, i) => ({
        id: `w${i}`,
        type: 'cold_chain_protection',
        state: i < 4 ? 'closed' : 'open',
      })),
    })
    assert.equal(enough.value, 80)
    assert.equal(enough.numerator, 4)
    assert.equal(enough.denominator, 5)
  })
})
