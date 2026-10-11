#!/usr/bin/env node
/**
 * ENH-51: every published number traces to its inputs and the run that made it.
 *
 * `src/analytics.js:417` already notices the case this suite is about — a
 * derived value that moved while its input counts stood still — and writes it
 * as a `logger.error` and an `unexpected_changes` row. A log line is a thing an
 * operator may see; a reconcilable event is a thing a donor can be answered on.
 * `src/reconciliation.js` is the ledger that turns the first into the second,
 * and this suite is the guard on the four distinctions that ledger could get
 * wrong.
 *
 * Each of the four outcomes is a way the ledger could lie, and the fourth is the
 * one this repository has actually paid for:
 *
 *   - changed over changed inputs is the system working, and flagging it is how
 *     a signal becomes noise;
 *   - changed over unchanged inputs is the engine, or an input nobody declared;
 *   - unchanged over changed inputs is an input that is not wired in;
 *   - no provenance at all is *not* reconciled. A check that measures nothing
 *     must not report success.
 *
 * The provenance envelopes are built with the real `buildProvenance`, not a
 * hand-written object, so the trace fields this ledger reads are the fields the
 * provenance layer actually writes.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  RECONCILIATION_OUTCOMES,
  ReconciliationLedger,
  observationMap,
  publishedKey,
  reconcileNumber,
  reconcileRun,
} from '../src/reconciliation.js'
import { buildProvenance } from '../src/provenance.js'
import { derivedKey } from '../src/analytics.js'

const RUN_A = 'run_2026_10_03_a'
const RUN_B = 'run_2026_10_04_b'

/** A real provenance envelope for one record, produced by the real builder. */
function envelopeFor(record, { runId = RUN_A, retrievedAt = '2026-10-03T08:00:12.000Z' } = {}) {
  const [envelope] = buildProvenance({
    sourceRun: { id: runId, source: 'gdacs', started_at: '2026-10-03T08:00:00.000Z' },
    connector: { id: 'gdacs' },
    records: [record],
    retrieval: { url: 'https://www.gdacs.org/xml/rss.xml', retrieved_at: retrievedAt },
    transform: () => {},
  })
  return envelope
}

/** A derived risk row, the shape `refreshAnalytics` stores, carrying its provenance. */
function riskRow({ value = 40, inputCounts = { hazard_events: 5, climate_observations: 3 }, region = 'Turkana', runId = RUN_A } = {}) {
  const record = { id: `risk-${region}`, type: 'flood_risk', region, score: value, input_counts: inputCounts }
  record._provenance = envelopeFor(record, { runId })
  return record
}

/** A derived observation: a row, its provenance, and any input it declared but does not record. */
function observed(record, options = {}) {
  return {
    collection: 'risk_scores',
    record,
    provenance: options.provenance ?? envelopeFor(record, { runId: options.runId ?? RUN_A }),
    undeclared_inputs: options.undeclared_inputs,
  }
}

describe('ENH-51 — the four outcomes, each a way the ledger could lie', () => {
  it('changed with changed inputs is reconciled, not a finding', () => {
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } })),
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 9 } }), { runId: RUN_B }),
      now: '2026-10-04T08:00:00.000Z',
    })
    assert.equal(result.outcome, 'reconciled')
    assert.equal(result.finding, false)
    assert.equal(result.reconciled, true)
    assert.equal(result.changed, true)
    assert.equal(result.inputs_changed, true)
    assert.equal(result.delta, 28)
  })

  it('changed with unchanged inputs is the finding, and names the cause', () => {
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } })),
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 5 } }), { runId: RUN_B }),
      now: '2026-10-04T08:00:00.000Z',
    })
    assert.equal(result.outcome, 'changed_without_input_change')
    assert.equal(result.finding, true)
    assert.equal(result.reconciled, false)
    assert.equal(result.changed, true)
    assert.equal(result.inputs_changed, false)
    // No undeclared input was named, so the cause is unknown rather than
    // asserted. The ledger does not guess.
    assert.equal(result.cause, 'unknown')
    assert.deepEqual(result.attributable_to, [])
  })

  it('changed with unchanged inputs names an undeclared input when one was supplied', () => {
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } }), { undeclared_inputs: ['clock'] }),
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 5 } }), { runId: RUN_B, undeclared_inputs: ['clock'] }),
    })
    assert.equal(result.outcome, 'changed_without_input_change')
    assert.equal(result.cause, 'undeclared_input')
    assert.deepEqual(result.attributable_to, ['clock'])
    assert.match(result.reason, /clock/)
  })

  it('unchanged with changed inputs is a finding: the input is not wired in', () => {
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5, climate_observations: 3 } })),
      after: observed(riskRow({ value: 40, inputCounts: { hazard_events: 9, climate_observations: 3 } }), { runId: RUN_B }),
    })
    assert.equal(result.outcome, 'unchanged_with_input_change')
    assert.equal(result.finding, true)
    assert.equal(result.changed, false)
    assert.equal(result.inputs_changed, true)
    assert.deepEqual(result.inputs, ['hazard_events'])
    assert.match(result.reason, /hazard_events/)
  })

  it('unchanged with unchanged inputs is reconciled, and the only true agreement', () => {
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } })),
      after: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } }), { runId: RUN_B }),
    })
    assert.equal(result.outcome, 'reconciled')
    assert.equal(result.finding, false)
    assert.equal(result.changed, false)
    assert.equal(result.inputs_changed, false)
  })
})

describe('ENH-51 — cannot-trace is a refusal, not an agreement', () => {
  it('a number with no provenance refuses rather than reporting agreement', () => {
    const result = reconcileNumber({
      before: { collection: 'risk_scores', record: riskRow({ value: 40, inputCounts: { hazard_events: 5 } }), provenance: null },
      after: { collection: 'risk_scores', record: riskRow({ value: 40, inputCounts: { hazard_events: 5 } }), provenance: null },
    })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reconciled, false, 'a value that agreed with itself is not reconciled when nothing can trace it')
    assert.equal(result.finding, false)
    assert.equal(result.reason_code, 'no_provenance')
    assert.equal(result.trace.traced, false)
  })

  it('a half-written envelope is not a trace either', () => {
    const envelope = envelopeFor(riskRow())
    delete envelope.source_run_id
    const result = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } }), { provenance: envelope }),
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 5 } }), { runId: RUN_B }),
    })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reason_code, 'incomplete')
    assert.deepEqual(result.trace.missing, ['source_run_id'])
  })

  it('refuses when only the later number has no provenance', () => {
    const row = riskRow({ value: 40, inputCounts: { hazard_events: 5 } })
    const result = reconcileNumber({
      before: observed(row),
      after: { collection: 'risk_scores', record: { ...row, score: 68 }, provenance: null },
    })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reason_code, 'no_provenance')
  })

  it('refuses when only the earlier number has no provenance', () => {
    // The prior side is the one easy to forget: the number a caller is asking
    // about is the current one, but an event names the run that produced *each*
    // value, so an untraceable prior is not a trace either.
    const row = riskRow({ value: 40, inputCounts: { hazard_events: 5 } })
    const result = reconcileNumber({
      before: { collection: 'risk_scores', record: row, provenance: null },
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 5 } }), { runId: RUN_B }),
    })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reason_code, 'no_provenance')
  })

  it('provenance without inputs refuses: there is nothing to hold the value against', () => {
    const bare = { id: 'risk-x', type: 'flood_risk', region: 'X', score: 40 }
    const result = reconcileNumber({
      before: observed(bare),
      after: observed({ ...bare, score: 68 }, { runId: RUN_B }),
    })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reason_code, 'missing_inputs')
    assert.equal(result.reconciled, false)
  })

  it('a number with no prior observation is a first sight, not a reconciliation', () => {
    const result = reconcileNumber({ before: null, after: observed(riskRow()) })
    assert.equal(result.outcome, 'cannot_trace')
    assert.equal(result.reason_code, 'no_prior_observation')
    assert.equal(result.reconciled, false)
  })

  it('every outcome is in the exported vocabulary, so a consumer iterates it', () => {
    assert.deepEqual([...RECONCILIATION_OUTCOMES].sort(), [
      'cannot_trace', 'changed_without_input_change', 'reconciled', 'unchanged_with_input_change',
    ])
  })
})

describe('ENH-51 — the key is the same one analytics reconciles on', () => {
  it('a published number is keyed the way the derived rows are', () => {
    const row = riskRow({ region: 'Turkana' })
    assert.equal(publishedKey('risk_scores', row), derivedKey('risk_scores', row))
    assert.equal(publishedKey('risk_scores', row), 'risk_scores:flood_risk:Turkana')
  })
})

describe('ENH-51 — reconciling a whole run', () => {
  it('measures only the numbers it could compare, and says how many it could not', () => {
    const before = observationMap({
      risk_scores: [
        riskRow({ region: 'Turkana', value: 40 }),
        riskRow({ region: 'Marsabit', value: 30 }),
        // Present in both runs, but carrying no provenance in either: it cannot
        // be traced, and it must not be counted as measured.
        Object.assign(riskRow({ region: 'Isiolo', value: 12 }), { _provenance: null }),
      ],
    })
    const after = observationMap({
      risk_scores: [
        // Same key, moved value, unchanged inputs: a finding.
        riskRow({ region: 'Turkana', value: 68, runId: RUN_B }),
        // Unmoved, so no finding — but it still counts as measured.
        riskRow({ region: 'Marsabit', value: 30, runId: RUN_B }),
        Object.assign(riskRow({ region: 'Isiolo', value: 12, runId: RUN_B }), { _provenance: null }),
      ],
    })
    const report = reconcileRun({ before, after, now: '2026-10-04T08:00:00.000Z' })
    assert.equal(report.findings, 1)
    assert.equal(report.measured, 2, 'a number with no provenance was not measured, whatever its value')
    assert.equal(report.untraced, 1)
    assert.equal(report.outcomes.changed_without_input_change, 1)
    assert.equal(report.outcomes.cannot_trace, 1)
  })

  it('a run that compared nothing reports zero measured, not a clean bill of health', () => {
    const report = reconcileRun({ before: new Map(), after: observationMap({ risk_scores: [] }) })
    assert.equal(report.measured, 0)
    assert.equal(report.findings, 0)
    // Zero findings over zero measurements is the shape of a check that measures
    // nothing reporting success, so the report carries the measurement count too.
    assert.equal(report.results.length, 0)
  })

  it('a number new to the run is counted as a first sight, not as untraced', () => {
    const before = observationMap({ risk_scores: [riskRow({ region: 'Turkana' })] })
    const after = observationMap({ risk_scores: [riskRow({ region: 'Turkana' }), riskRow({ region: 'Isiolo' })] })
    const report = reconcileRun({ before, after })
    assert.equal(report.first_sight, 1)
    assert.equal(report.untraced, 0)
    assert.equal(report.measured, 1)
  })
})

describe('ENH-51 — the ledger is tamper-evident', () => {
  const finding = () => reconcileNumber({
    before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } })),
    after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 5 } }), { runId: RUN_B }),
    now: '2026-10-04T08:00:00.000Z',
  })

  it('chains findings and verifies cleanly against its own head', () => {
    const ledger = new ReconciliationLedger()
    ledger.append([finding(), finding()])
    assert.equal(ledger.size, 2)
    const result = ledger.verify({ expectedHead: ledger.head.hash })
    assert.equal(result.verified, true)
    assert.equal(result.anchored, true)
    assert.equal(result.entry_count, 2)
    assert.deepEqual(result.defects, [])
  })

  it('does not chain the reconciled non-findings by default', () => {
    const ledger = new ReconciliationLedger()
    const reconciled = reconcileNumber({
      before: observed(riskRow({ value: 40, inputCounts: { hazard_events: 5 } })),
      after: observed(riskRow({ value: 68, inputCounts: { hazard_events: 9 } }), { runId: RUN_B }),
    })
    ledger.append([reconciled, finding()])
    assert.equal(ledger.size, 1, 'the events a reader trusts are the ones that mean something')
  })

  it('an edited event breaks the chain, because the hash is recomputed not compared', () => {
    const ledger = new ReconciliationLedger()
    ledger.append([finding()])
    assert.equal(ledger.verify().verified, true)
    // Tamper with a chained field. The stored hash still says what it said; the
    // recomputation is what disagrees.
    ledger.events[0].metadata.value_after = 41
    const result = ledger.verify()
    assert.equal(result.verified, false)
    assert.ok(result.defects.some((defect) => defect.type === 'entry_hash_mismatch'))
  })

  it('a rewritten head is caught only by the out-of-band anchor', () => {
    const ledger = new ReconciliationLedger()
    ledger.append([finding(), finding()])
    // The chain recomputes against itself — an internal rewrite is invisible —
    // so the published head is the only thing that catches it.
    const rewritten = ledger.verify({ expectedHead: 'f'.repeat(64) })
    assert.equal(rewritten.verified, false)
    assert.ok(rewritten.defects.some((defect) => defect.type === 'head_mismatch'))
  })

  it('re-reconciling the same pair produces the same event id, so a merge does not duplicate', () => {
    const first = reconcileRun({
      before: observationMap({ risk_scores: [riskRow({ value: 40 })] }),
      after: observationMap({ risk_scores: [riskRow({ value: 68 })] }),
      now: '2026-10-04T08:00:00.000Z',
    })
    const second = reconcileRun({
      before: observationMap({ risk_scores: [riskRow({ value: 40 })] }),
      after: observationMap({ risk_scores: [riskRow({ value: 68 })] }),
      now: '2026-10-04T09:30:00.000Z',
    })
    assert.equal(first.events.length, 1)
    assert.equal(first.events[0].id, second.events[0].id, 'the id carries no clock, so a re-report is the same event')
  })
})
