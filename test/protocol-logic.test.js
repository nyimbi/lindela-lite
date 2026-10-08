#!/usr/bin/env node
/**
 * Protocol logical composition and the agreement date.
 *
 * Protocols are pre-authorised conditions, and districts phrase conditions in
 * full logic: "heat AND cold-chain breach", "flood OR landslide", "exactly
 * one gauge reading high" (xor), and their negations. The condition set is
 * the whole practical space — a flat term list with one combinator, per-term
 * negation, and group inversion — and it fails closed: a term that cannot be
 * resolved is a non-answer, and a non-answer must never become a fire,
 * whatever the combinator.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeTriggerProtocol, evaluateConditionSet } from '../src/alerts.js'

function protocol(overrides = {}) {
  return normalizeTriggerProtocol({
    name: 'Demo protocol',
    metric: 'counts.hazard_events',
    operator: '>=',
    threshold: 1,
    ...overrides,
  })
}

describe('normalizeTriggerProtocol — condition_set', () => {
  it('derives a single-term condition set from the flat fields', () => {
    const p = protocol()
    assert.deepEqual(p.condition_set, {
      combinator: 'and', negate: false,
      terms: [{ metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false }],
    })
    // Flat fields mirror the first term for backtest/derivation parity.
    assert.equal(p.metric, 'counts.hazard_events')
    assert.equal(p.threshold, 1)
  })

  it('accepts a multi-term condition set and mirrors its first term flat', () => {
    const p = protocol({
      condition_set: {
        combinator: 'or',
        terms: [
          { metric: 'counts.hazard_events', operator: '>=', threshold: 3 },
          { metric: 'counts.climate_observations', operator: '<', threshold: 10, negate: true },
        ],
      },
    })
    assert.equal(p.condition_set.terms.length, 2)
    assert.equal(p.metric, 'counts.hazard_events')
    assert.equal(p.condition_set.terms[1].negate, true)
  })

  it('rejects an unknown combinator and more than five terms', () => {
    assert.throws(() => protocol({ condition_set: { combinator: 'nand', terms: [{ metric: 'a', threshold: 1 }] } }), /combinator/)
    const six = { combinator: 'and', terms: Array.from({ length: 6 }, (_, i) => ({ metric: `m${i}`, threshold: 1 })) }
    assert.throws(() => protocol({ condition_set: six }), /at most 5/)
  })

  it('validates every term, naming the offending index', () => {
    assert.throws(
      () => protocol({ condition_set: { terms: [{ metric: 'a', threshold: 1 }, { threshold: 1 }] } }),
      /terms\[1\]\.metric/,
    )
  })

  it('carries agreed_at and rejects a non-date', () => {
    const p = protocol({ agreed_at: '2026-06-15' })
    assert.equal(p.agreed_at, '2026-06-15')
    assert.throws(() => protocol({ agreed_at: 'last Tuesday' }), /agreed_at/)
  })
})

describe('evaluateConditionSet — truth tables', () => {
  const ctx = { counts: { hazard_events: 5, climate_observations: 2, field_reports: 0 } }

  it('AND requires every term', () => {
    const both = evaluateConditionSet({ combinator: 'and', negate: false, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.climate_observations', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(both.firing, true)
    const one = evaluateConditionSet({ combinator: 'and', negate: false, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(one.firing, false)
  })

  it('OR fires when any term passes', () => {
    const r = evaluateConditionSet({ combinator: 'or', negate: false, terms: [
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(r.firing, true)
  })

  it('XOR fires on exactly one passing term, not zero and not two', () => {
    const xor = (terms) => evaluateConditionSet({ combinator: 'xor', negate: false, terms }, ctx).firing
    assert.equal(xor([
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
    ]), true, 'exactly one passes')
    assert.equal(xor([
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.climate_observations', operator: '>=', threshold: 1, negate: false },
    ]), false, 'two pass — xor is not or')
    assert.equal(xor([
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.iot_observations', operator: '>=', threshold: 1, negate: false },
    ]), false, 'zero pass')
  })

  it('per-term negation and group inversion compose (NAND, NOR, XNOR)', () => {
    // NAND: not (hazards >= 1 AND reports >= 1) — reports is 0, so the AND is
    // false and the inversion fires.
    const nand = evaluateConditionSet({ combinator: 'and', negate: true, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(nand.firing, true)
    // Per-term NOT: "hazard_events NOT >= 100" is satisfied (5 < 100).
    const notTerm = evaluateConditionSet({ combinator: 'and', negate: false, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 100, negate: true },
    ] }, ctx)
    assert.equal(notTerm.firing, true)
    // XNOR: not(xor of two passing) = true — equivalence means the terms AGREE,
    // and two passing terms agree.
    const xnor = evaluateConditionSet({ combinator: 'xor', negate: true, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.climate_observations', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(xnor.firing, true)
    // …and one-pass-one-fail disagrees, so XNOR does not fire.
    const xnorSplit = evaluateConditionSet({ combinator: 'xor', negate: true, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(xnorSplit.firing, false)
  })

  it('fails closed: an unresolvable term never fires, whatever the logic', () => {
    // OR with one passing term and one missing metric: the pass is real but
    // the set is unevaluable — silence must not read as a positive.
    const r = evaluateConditionSet({ combinator: 'or', negate: false, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.no_such_collection', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(r.firing, false)
    assert.equal(r.evaluable, false)
    // The dangerous case: group inversion of a set with a missing term.
    // NOT(false) would be true; fail-closed keeps it false.
    const inverted = evaluateConditionSet({ combinator: 'and', negate: true, terms: [
      { metric: 'counts.no_such_collection', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(inverted.firing, false)
  })

  it('reports each term reading so the feed shows evidence, not just verdicts', () => {
    const r = evaluateConditionSet({ combinator: 'and', negate: false, terms: [
      { metric: 'counts.hazard_events', operator: '>=', threshold: 1, negate: false },
      { metric: 'counts.field_reports', operator: '>=', threshold: 1, negate: false },
    ] }, ctx)
    assert.equal(r.results[0].observed_value, 5)
    assert.equal(r.results[0].satisfied, true)
    assert.equal(r.results[1].observed_value, 0)
    assert.equal(r.results[1].satisfied, false)
    assert.equal(r.primary.metric, 'counts.hazard_events')
  })
})
