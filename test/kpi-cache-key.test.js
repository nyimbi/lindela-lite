import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeQuarterlyKpi, kpiCacheKey } from '../src/kpi.js'

/**
 * R-34 — the quarterly KPI cache key is a digest of content, not of cardinality.
 *
 * The defect the key carried was a strict subset: seven array *lengths*. A
 * revision that preserves every length — the common case, since a correction
 * changes a value rather than a count — digested identically, and the caller was
 * served the pre-revision figure for the whole TTL. These tests are written
 * around that shape rather than around "the key changed", because a key can
 * change for a reason that does not fix it: hashing lengths *and* the newest id
 * would pass a naive "different data, different key" test and still miss a
 * correction to a row in the middle.
 */

const EMPTY = {
  rapidpro_dispatches: [], field_reports: [], alert_events: [], hazard_events: [],
  interventions: [], workflow_instances: [], report_templates: [],
}

/** One field report, optionally carrying demographics, so a revision keeps the count. */
function dataWith(status = 'pending') {
  return {
    ...EMPTY,
    field_reports: [{
      id: 'f1',
      created_at: '2026-08-01T00:00:00.000Z',
      reported_by: 'reporter-1',
      status,
    }],
  }
}

/** Two reports, one of them carrying demographics — so coverage is 50%. */
function dataWithDemographics(demographics) {
  return {
    ...EMPTY,
    field_reports: [
      { id: 'f1', created_at: '2026-08-01T00:00:00.000Z', reported_by: 'r1', demographics },
      { id: 'f2', created_at: '2026-08-01T00:00:00.000Z', reported_by: 'r2' },
    ],
  }
}

describe('R-34 the quarterly KPI cache key covers content, not cardinality', () => {
  it('digests a same-length in-place revision to a different key', () => {
    const before = kpiCacheKey('Q3', 2026, dataWith('pending'))
    const after = kpiCacheKey('Q3', 2026, dataWith('verified'))
    assert.notEqual(before, after, 'a record revised in place kept the same key')
    // The count is what the old key hashed. Asserting it is unchanged is what
    // makes this a test of the defect rather than of any difference at all.
    assert.equal(dataWith('pending').field_reports.length, dataWith('verified').field_reports.length)
  })

  it('serves a fresh figure after a same-length in-place revision', () => {
    // The end-to-end half. A key test alone would pass on a key nothing reads.
    //
    // The revision moves `demographics_coverage_pct`, which is a function of the
    // rows' *content* and not of their count — so the figure below is the
    // observable consequence of the fix, and it is the figure a dashboard
    // reader would have seen five minutes stale before it.
    const now = Date.now()
    const data = dataWithDemographics(null)
    const first = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026, now })
    assert.equal(first.demographics_coverage_pct, 0)

    // In place, same array, same length.
    data.field_reports[0].demographics = { age_band: 'u5', gender: 'female', pwd: false, refugee_or_idp: false }
    const second = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026, now })

    assert.equal(second.demographics_coverage_pct, 50, 'the cached figure was replayed over a revision')
    assert.notEqual(first, second, 'the same object came back, so the revision was not seen')
  })

  it('still serves a live entry unchanged, so the fix did not disable the cache', () => {
    const now = Date.now()
    const data = dataWith('pending')
    const first = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026, now })
    const second = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026, now })
    assert.equal(first, second, 'an unrevised payload was recomputed, so nothing is cached')
  })

  it('separates a collection boundary, so two arrays cannot digest alike', () => {
    // `['ab','c']` and `['a','bc']` are the same bytes without a terminator.
    const a = { ...EMPTY, field_reports: [{ id: 'ab' }, { id: 'c' }] }
    const b = { ...EMPTY, field_reports: [{ id: 'a' }, { id: 'bc' }] }
    assert.notEqual(kpiCacheKey('Q3', 2026, a), kpiCacheKey('Q3', 2026, b))
  })

  it('separates a field moved between two collections', () => {
    const inReports = { ...EMPTY, field_reports: [{ id: 'x' }] }
    const inAlerts = { ...EMPTY, alert_events: [{ id: 'x' }] }
    assert.notEqual(kpiCacheKey('Q3', 2026, inReports), kpiCacheKey('Q3', 2026, inAlerts))
  })

  it('separates two quarters over identical data', () => {
    assert.notEqual(kpiCacheKey('Q3', 2026, dataWith()), kpiCacheKey('Q4', 2026, dataWith()))
  })

  it('covers every collection the computation reads, not a subset of them', () => {
    // The general form of the defect. Each collection is revised in place, one
    // at a time, and each revision must move the key — a key that covered six of
    // the seven would pass every test above and miss the seventh.
    const base = {
      rapidpro_dispatches: [{ id: 'd', sent_at: '2026-08-01T00:00:00.000Z' }],
      field_reports: [{ id: 'f', created_at: '2026-08-01T00:00:00.000Z' }],
      alert_events: [{ id: 'a', created_at: '2026-08-01T00:00:00.000Z' }],
      hazard_events: [{ id: 'h', observed_at: '2026-08-01T00:00:00.000Z' }],
      interventions: [{ id: 'i', created_at: '2026-08-01T00:00:00.000Z' }],
      workflow_instances: [{ id: 'w', created_at: '2026-08-01T00:00:00.000Z' }],
      report_templates: [{ id: 't', name: 'Quarterly' }],
    }
    const baseline = kpiCacheKey('Q3', 2026, base)
    for (const name of Object.keys(base)) {
      const revised = structuredClone(base)
      revised[name][0].note = 'revised'
      assert.notEqual(
        kpiCacheKey('Q3', 2026, revised),
        baseline,
        `a revision to ${name} did not move the key, so the cache cannot see it`,
      )
    }
  })

  it('answers rather than throwing when a row will not serialise', () => {
    // A cache key is not a validation boundary. A payload carrying a BigInt or a
    // cycle used to compute fine and must keep computing; only the key degrades,
    // and it degrades toward a miss.
    const cyclic = { id: 'c' }
    cyclic.self = cyclic
    const data = { ...EMPTY, field_reports: [cyclic] }
    assert.doesNotThrow(() => kpiCacheKey('Q3', 2026, data))
    // Two calls over the same un-serialisable payload need not agree, and a
    // disagreement is a recomputation — the safe direction.
    assert.equal(typeof kpiCacheKey('Q3', 2026, data), 'string')
  })

  it('tolerates an absent collection, which is the shape a partial store read has', () => {
    assert.equal(typeof kpiCacheKey('Q3', 2026, {}), 'string')
    assert.equal(typeof kpiCacheKey('Q3', 2026, undefined), 'string')
  })
})
