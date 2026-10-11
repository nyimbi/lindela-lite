import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RANKINGS, rankingFor, explainRanking, isOrderedBy } from '../public/shared/rank-explain.js'
import { rankAlerts } from '../src/triage.js'

describe('explainable ranking everywhere (ENH-72)', () => {
  it('declares the ordering of every registered list', () => {
    for (const [key, rule] of Object.entries(RANKINGS)) {
      assert.ok(rule.ordersBy, `${key} does not say what it orders by`)
      assert.ok(rule.direction, `${key} does not say which direction`)
      assert.ok(rule.because, `${key} does not say why that ordering`)
      assert.ok(rule.not, `${key} does not say what the ordering is not entitled to claim`)
      assert.ok(rule.source, `${key} does not name the module the ordering lives in`)
    }
  })

  it('says a recency ordering is a clock, not an importance ranking', () => {
    // The failure this prevents: a list sorted by `created_at` looks exactly
    // like one sorted by severity, and an operator who assumes the wrong one
    // makes a different decision than the product intended.
    const rule = rankingFor('district-field-reports')
    assert.equal(rule.kind, 'recency')
    assert.match(rule.not, /not a ranking by importance/)
    assert.match(rule.not, /clock/)
  })

  it('says the triage proxy is not an expected value', () => {
    const rule = rankingFor('alert-events/triage')
    assert.equal(rule.kind, 'proxy')
    assert.match(rule.not, /not an expected value/)
    assert.match(rule.not, /does not price them/)
  })

  it('returns an honest null for a list with no registered ordering', () => {
    // A fabricated rationale would be the exact defect this module exists to
    // prevent, so an undeclared ordering says so rather than inventing one.
    const explanation = explainRanking('some-list-nobody-declared')
    assert.equal(explanation.known, false)
    assert.match(explanation.reason, /does not state why one entry is above another/)
    assert.equal(explanation.orders_by, undefined)
  })

  it('carries the entry count when the caller passes the list', () => {
    const withEntries = explainRanking('risk-scores', { entries: [{}, {}] })
    assert.equal(withEntries.entry_count, 2)
    // Absent rather than defaulted to 0, which would read as "the list was empty".
    assert.equal(explainRanking('risk-scores').entry_count, undefined)
  })

  it('holds a list to the order it claims', () => {
    const descending = [{ v: 5 }, { v: 3 }, { v: 1 }]
    const ascending = [{ v: 1 }, { v: 3 }, { v: 5 }]
    assert.equal(isOrderedBy(descending, 'v'), true)
    assert.equal(isOrderedBy(ascending, 'v'), false)
    assert.equal(isOrderedBy(ascending, 'v', { direction: 'ascending' }), true)
  })

  it('treats an unmeasured value as last in either direction, never first', () => {
    // A null is not a low value, so the only place it may sit is after every
    // measured entry — which is what the triage list does and what the
    // registry's `gaps` field declares. Anywhere earlier is a claim about it.
    assert.equal(isOrderedBy([{ v: 5 }, { v: 1 }, { v: null }], 'v'), true, 'unmeasured last is the declared order')
    assert.equal(isOrderedBy([{ v: 5 }, { v: null }, { v: 1 }], 'v'), false, 'unmeasured in the middle is not last')
    assert.equal(isOrderedBy([{ v: null }, { v: 5 }], 'v'), false, 'an unmeasured first is a claim')
  })

  it('compares timestamps, so a recency claim can be checked at all', () => {
    // Without this the module cannot hold the recency orderings to anything:
    // `created_at` is a string, every value reads as unmeasured, and the check
    // returns true for any list. Both directions, so the assertion cannot be
    // satisfied by an implementation that compares nothing.
    const newestFirst = [{ t: '2026-10-11T00:00:00Z' }, { t: '2026-10-10T00:00:00Z' }]
    const oldestFirst = [{ t: '2026-10-10T00:00:00Z' }, { t: '2026-10-11T00:00:00Z' }]
    assert.equal(isOrderedBy(newestFirst, 't'), true)
    assert.equal(isOrderedBy(oldestFirst, 't'), false, 'oldest-first is not the declared recency order')
    assert.equal(isOrderedBy(oldestFirst, 't', { direction: 'ascending' }), true)
  })

  it('refuses to certify an ordering of fewer than two entries', () => {
    assert.equal(isOrderedBy([], 'v'), null)
    assert.equal(isOrderedBy([{ v: 1 }], 'v'), null)
  })

  it('the live district payload declares both of its orderings', async () => {
    const { districtOverview } = await import('../src/districts.js')
    const overview = districtOverview({
      hazard_events: [
        { id: 'h1', district: 'turkana', severity: 'low', event_type: 'flood' },
        { id: 'h2', district: 'turkana', severity: 'critical', event_type: 'flood' },
      ],
      field_reports: [
        { id: 'f1', district: 'turkana', created_at: '2026-10-10T00:00:00Z' },
        { id: 'f2', district: 'turkana', created_at: '2026-10-11T00:00:00Z' },
      ],
    }, 'turkana')
    assert.equal(overview.rankings.active_hazards.kind, 'severity')
    assert.equal(overview.rankings.field_reports.kind, 'recency')
    assert.match(overview.rankings.field_reports.not, /not a ranking by importance/)
    // Both are held to the order they declare, against the live payload.
    assert.equal(isOrderedBy(overview.active_hazards, (h) => 4 - ['critical', 'high', 'medium', 'low', 'unknown'].indexOf(h.severity)), true)
    assert.equal(isOrderedBy(overview.field_reports, 'created_at'), true)
  })

  it('the live triage payload carries its declaration, and is in the order it claims', () => {
    const data = {
      hazard_events: [{ id: 'h1', event_type: 'flood', latitude: 6.8, longitude: -1.5 }],
      service_assets: [{ id: 'a1', name: 'Clinic A', latitude: 6.8, longitude: -1.5, population_served: 5000 }],
      alert_events: [
        { id: 'e1', status: 'open', severity: 'critical', created_at: '2026-10-11T00:00:00Z', location: { latitude: 6.8, longitude: -1.5 }, derivation: { input_record_ids: ['h1'] } },
        { id: 'e2', status: 'open', severity: 'low', created_at: '2026-10-11T04:00:00Z', location: { latitude: 6.8, longitude: -1.5 }, derivation: { input_record_ids: ['h1'] } },
      ],
    }
    const result = rankAlerts(data, null, { now: '2026-10-11T05:00:00Z' })
    assert.equal(result.ranking.known, true)
    assert.equal(result.ranking.orders_by, 'expected_loss = severity_weight × population_exposed')
    assert.equal(isOrderedBy(result.ranked, 'expected_loss'), true, 'the list must be in the order it declares')
  })
})
