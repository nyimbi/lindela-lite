#!/usr/bin/env node
/**
 * ENH-06: a verdict per source, and the difference between quiet and broken.
 *
 * The defect this guards is not "the wrong number came back". It is that two
 * genuinely different states produced the same string, so an operator had no
 * way to tell a feed that had nothing to say from a feed that had stopped
 * answering:
 *
 *   - `minimum_records: 1` is applied to every source regardless of cadence, so
 *     a quiet GDACS week — no new disasters anywhere in the watch region, which
 *     is good news — appended "Expected at least 1 records for gdacs" and came
 *     back `degraded`, the same word a connector emits when it got a login
 *     page instead of a feed.
 *   - One global staleness window judged an annual WHO national statistic and a
 *     daily CHIRPS raster with the same clock, so a source silent for correct
 *     reasons and a source dead for a week were both `stale`.
 *
 * Neither is observable from the outside without knowing what the source is
 * supposed to do, so the test has to name the cadence and the expected record
 * count itself. That is why every case below constructs a run row by hand
 * rather than reaching for the ingestion path: the point is the judgement, not
 * the fetch.
 *
 * The two anti-vacuous guards at the end are the ones worth arguing for. A
 * source with no `CADENCE_DAYS` entry would fall through to a default verdict
 * and report `ok` forever — a dead source rendered healthy by an omission, the
 * same shape as the silent-key-list bug this repository has hit twice. A
 * `FRESHNESS_VERDICTS` list that lost an entry, or gained a duplicate, would be
 * caught by a route iterating it and rendering a blank cell. Both fail loudly
 * here instead.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SOURCE_IDS } from '../src/schema.js'
import { SOURCE_POLICIES } from '../src/ingestion.js'
import {
  CADENCE_DAYS,
  FRESHNESS_VERDICTS,
  explainVerdict,
  freshnessReport,
  verdictFor,
} from '../src/freshness.js'

const NOW = Date.parse('2026-10-03T00:00:00.000Z')

const daysAgo = (count) => new Date(NOW - count * 86400000).toISOString()

function run({
  status = 'success',
  records = 10,
  at = daysAgo(0),
  errors = [],
  extra = {},
} = {}) {
  return {
    source: 'gdacs',
    status,
    started_at: at,
    completed_at: at,
    records_processed: records,
    errors,
    ...extra,
  }
}

function forSource(source, input = {}) {
  return {
    source,
    policy: SOURCE_POLICIES[source] || {},
    now: NOW,
    ...input,
  }
}

describe('freshness verdicts', () => {
  it('covers every source in SOURCE_IDS with a cadence entry', () => {
    // The silent-key-list shape: an id added to SOURCE_IDS and forgotten
    // downstream gets a default verdict rather than a complaint, and a dead
    // source renders as healthy because nobody wrote its row.
    const missing = SOURCE_IDS.filter((source) => !CADENCE_DAYS[source])
    assert.deepEqual(missing, [], `no CADENCE_DAYS entry for: ${missing.join(', ')}`)

    const extra = Object.keys(CADENCE_DAYS).filter((source) => !SOURCE_IDS.includes(source))
    assert.deepEqual(extra, [], `CADENCE_DAYS names sources that do not exist: ${extra.join(', ')}`)
  })

  it('lists five distinct verdicts for callers to iterate', () => {
    assert.equal(FRESHNESS_VERDICTS.length, 5)
    assert.equal(new Set(FRESHNESS_VERDICTS).size, 5)
    for (const verdict of FRESHNESS_VERDICTS) {
      assert.equal(typeof verdict, 'string')
      assert.ok(verdict.length > 0)
    }
  })

  it('reports ok when a run succeeded on schedule with new records', () => {
    const verdict = verdictFor(forSource('chirps', {
      lastRun: run({ records: 240 }),
      lastSuccessRun: run({ records: 240, at: daysAgo(0.2) }),
      recentRecordCounts: [240],
    }))
    assert.equal(verdict, 'ok')
    assert.ok(FRESHNESS_VERDICTS.includes(verdict))
  })

  it('reports quiet for an event feed with nothing new inside cadence', () => {
    // The spec's case. GDACS is hourly and returns 0 records in a quiet week.
    // That is a working feed reporting no disasters, not a broken one.
    const verdict = verdictFor(forSource('gdacs', {
      lastRun: run({ records: 0, at: daysAgo(0.1) }),
      lastSuccessRun: run({ records: 0, at: daysAgo(0.1) }),
      recentRecordCounts: [0],
    }))
    assert.equal(verdict, 'quiet')

    const explained = explainVerdict(forSource('gdacs', {
      lastRun: run({ records: 0, at: daysAgo(0.1) }),
      lastSuccessRun: run({ records: 0, at: daysAgo(0.1) }),
      recentRecordCounts: [0],
    }))
    assert.match(explained.reason, /0 records/u)
    assert.equal(explained.records_last_run, 0)
    assert.equal(explained.cadence_days, 1)
    assert.equal(explained.age_days, 0.1)
  })

  it('keeps quiet distinguishable from broken when both returned zero', () => {
    // Same source, same record count, same day. The only difference is whether
    // the fetch answered. The old code reported `degraded` for both.
    const quiet = verdictFor(forSource('gdacs', {
      lastRun: run({
        status: 'degraded',
        records: 0,
        at: daysAgo(0.2),
        errors: ['Expected at least 1 records for gdacs; received 0.'],
      }),
      lastSuccessRun: run({ records: 0, at: daysAgo(0.2) }),
    }))

    const broken = verdictFor(forSource('gdacs', {
      lastRun: run({
        status: 'failed',
        records: 0,
        at: daysAgo(0.2),
        errors: ['Fetch failed: 401 Unauthorized'],
      }),
      lastSuccessRun: null,
    }))

    assert.equal(quiet, 'quiet')
    assert.equal(broken, 'broken')
    assert.notEqual(quiet, broken)

    const quietReason = explainVerdict(forSource('gdacs', {
      lastRun: run({
        status: 'degraded',
        records: 0,
        at: daysAgo(0.2),
        errors: ['Expected at least 1 records for gdacs; received 0.'],
      }),
      lastSuccessRun: run({ records: 0, at: daysAgo(0.2) }),
    })).reason
    assert.match(quietReason, /nothing new/u)
    assert.doesNotMatch(quietReason, /did not answer/u)
  })

  it('reports broken when a connector error rides along with the quiet run', () => {
    // The record-count message must not absorb the real error next to it. This
    // is the fetch that returned an HTML login page and parsed zero events.
    const verdict = verdictFor(forSource('gdacs', {
      lastRun: run({
        status: 'degraded',
        records: 0,
        at: daysAgo(0.1),
        errors: ['Expected at least 1 records for gdacs; received 0.', 'gdacs: feed returned HTML, not RSS'],
      }),
      lastSuccessRun: null,
    }))
    assert.equal(verdict, 'broken')
  })

  it('reports broken when assertions tripped', () => {
    // ENH-07 will attach these. Read now so that shipping it needs no edit.
    const verdict = verdictFor(forSource('chirps', {
      lastRun: run({ records: 12, at: daysAgo(0.1), extra: { assertions_failed: ['raster index had no daily files'] } }),
      lastSuccessRun: null,
    }))
    assert.equal(verdict, 'broken')
    assert.match(explainVerdict(forSource('chirps', {
      lastRun: run({ records: 12, at: daysAgo(0.1), extra: { assertions_failed: ['raster index had no daily files'] } }),
      lastSuccessRun: null,
    })).reason, /assertion/u)
  })

  it('reports never_run when nothing has ever run', () => {
    const verdict = verdictFor(forSource('glofas', { lastRun: null, lastSuccessRun: null }))
    assert.equal(verdict, 'never_run')
    const explained = explainVerdict(forSource('glofas', { lastRun: null, lastSuccessRun: null }))
    assert.equal(explained.last_success_at, null)
    assert.equal(explained.age_days, null)
    assert.match(explained.reason, /ever been measured/u)
  })

  it('does not call an annual source stale for 200 days of silence', () => {
    // WHO GHO publishes national annual aggregates. Two hundred days of
    // nothing is roughly two thirds of a publication cycle.
    const verdict = verdictFor(forSource('who_gho', {
      lastRun: run({ records: 40, at: daysAgo(200) }),
      lastSuccessRun: run({ records: 40, at: daysAgo(200) }),
      recentRecordCounts: [40],
    }))
    assert.equal(verdict, 'ok')
    assert.ok(CADENCE_DAYS.who_gho.cadence_days > 200)
  })

  it('calls a daily source stale for 200 days of silence', () => {
    const verdict = verdictFor(forSource('chirps', {
      lastRun: run({ records: 365, at: daysAgo(200) }),
      lastSuccessRun: run({ records: 365, at: daysAgo(200) }),
      recentRecordCounts: [365],
    }))
    assert.equal(verdict, 'stale')
    assert.match(explainVerdict(forSource('chirps', {
      lastRun: run({ records: 365, at: daysAgo(200) }),
      lastSuccessRun: run({ records: 365, at: daysAgo(200) }),
    })).reason, /200 days ago, cadence 1 day/u)
  })

  it('separates on-demand sources from scheduled ones', () => {
    // Same 200 days, same silence. One source is on a schedule and one is not,
    // and a clock cannot tell them apart — which is how the two-week window
    // came to judge a quarterly backfill.
    const stale = verdictFor(forSource('chirps', {
      lastRun: run({ records: 5, at: daysAgo(200) }),
      lastSuccessRun: run({ records: 5, at: daysAgo(200) }),
    }))
    const onDemand = verdictFor(forSource('gdacs_archive', {
      lastRun: run({ records: 0, at: daysAgo(200) }),
      lastSuccessRun: null,
    }))
    assert.equal(stale, 'stale')
    assert.equal(onDemand, 'quiet')
  })

  it('never calls an on-demand source stale', () => {
    // interval_minutes: 0 marks the backfills, null marks the upload
    // connectors. Neither has a publisher to be late against, and both carry
    // minimum_records: 0, so a zero-record run is the expected outcome.
    for (const source of ['gdacs_archive', 'open_meteo_archive', 'open_meteo_flood']) {
      assert.equal(SOURCE_POLICIES[source].interval_minutes, 0)
      assert.equal(CADENCE_DAYS[source].cadence_days, null)
      assert.equal(verdictFor(forSource(source, {
        lastRun: run({ records: 0, at: daysAgo(900) }),
        lastSuccessRun: null,
      })), 'quiet', `${source} must not go stale for silence`)
    }

    for (const source of ['service_assets', 'acled_csv', 'conflict_csv', 'dhis2']) {
      assert.equal(SOURCE_POLICIES[source].interval_minutes, null)
      assert.equal(CADENCE_DAYS[source].cadence_days, null)
      assert.equal(verdictFor(forSource(source, {
        lastRun: run({ records: 0, at: daysAgo(900) }),
        lastSuccessRun: null,
      })), 'quiet', `${source} must not go stale for silence`)
    }
  })

  it('still calls an on-demand source broken when its run failed', () => {
    // No cadence does not mean no judgement. A failed backfill is a failed
    // backfill.
    const verdict = verdictFor(forSource('gdacs_archive', {
      lastRun: run({ status: 'failed', records: 0, at: daysAgo(1), errors: ['GDACS 503'] }),
      lastSuccessRun: null,
    }))
    assert.equal(verdict, 'broken')
  })

  it('treats the cadence deadline as on time and the day after as late', () => {
    const atDeadline = verdictFor(forSource('chirps', {
      lastRun: run({ records: 100, at: daysAgo(1) }),
      lastSuccessRun: run({ records: 100, at: daysAgo(1) }),
    }))
    assert.equal(atDeadline, 'ok')

    const oneDayPast = verdictFor(forSource('chirps', {
      lastRun: run({ records: 100, at: daysAgo(1.01) }),
      lastSuccessRun: run({ records: 100, at: daysAgo(1.01) }),
    }))
    assert.equal(oneDayPast, 'stale')
  })

  it('keeps zero, absent and unmeasured apart', () => {
    // The falsy-zero rule at the heart of this module. A zero count, a run with
    // no count field, and a source that has never run are three facts.
    const zero = explainVerdict(forSource('gdacs', {
      lastRun: run({ records: 0, at: daysAgo(0.1) }),
      lastSuccessRun: run({ records: 0, at: daysAgo(0.1) }),
      recentRecordCounts: [0],
    }))
    assert.equal(zero.verdict, 'quiet')
    assert.equal(zero.records_last_run, 0)
    assert.match(zero.reason, /0 records/u)

    const noCount = explainVerdict(forSource('gdacs', {
      lastRun: { source: 'gdacs', status: 'success', completed_at: daysAgo(0.1), errors: [] },
      lastSuccessRun: null,
    }))
    assert.equal(noCount.verdict, 'quiet')
    assert.equal(noCount.records_last_run, null)
    assert.match(noCount.reason, /no record count/u)

    const never = explainVerdict(forSource('gdacs', { lastRun: null, lastSuccessRun: null }))
    assert.equal(never.verdict, 'never_run')
    assert.equal(never.records_last_run, null)

    // The verdicts coincide — a run that read nothing and a run that counted
    // zero are both "succeeded, nothing new" — but the counts must not. A
    // single `count || 0` here collapses a measured zero and an absent
    // measurement into one number, and the zero is the one that means something.
    assert.notEqual(zero.records_last_run, noCount.records_last_run)
    assert.notEqual(zero.reason, noCount.reason)
  })

  it('does not report ok for a source that delivered nothing', () => {
    // `ok` claims data arrived. Zero is not an arrival.
    const verdict = verdictFor(forSource('gdacs_archive', {
      lastRun: run({ records: 0, at: daysAgo(2) }),
      lastSuccessRun: null,
    }))
    assert.equal(verdict, 'quiet')
    assert.doesNotMatch(explainVerdict(forSource('gdacs_archive', {
      lastRun: run({ records: 0, at: daysAgo(2) }),
      lastSuccessRun: null,
    })).reason, /arrived on schedule/u)
  })

  it('reads the best count from several recent runs without trusting order', () => {
    const verdict = verdictFor(forSource('gdacs', {
      lastRun: run({ records: 0, at: daysAgo(0.1) }),
      lastSuccessRun: null,
      recentRecordCounts: [0, 7],
    }))
    assert.equal(verdict, 'ok')
  })
})

describe('freshnessReport', () => {
  it('returns one entry per SOURCE_IDS member, not per run', () => {
    const report = freshnessReport({ sourceRuns: [], now: NOW })
    assert.equal(report.length, SOURCE_IDS.length)
    assert.deepEqual(report.map((entry) => entry.source), [...SOURCE_IDS])
    assert.ok(report.every((entry) => entry.verdict === 'never_run'))
  })

  it('carries the numbers a human needs to act on', () => {
    const report = freshnessReport({
      now: NOW,
      sourceRuns: [
        { ...run({ records: 0, at: daysAgo(0.5) }), source: 'gdacs' },
        { ...run({ status: 'failed', records: 0, at: daysAgo(0.2), errors: ['boom'] }), source: 'chirps' },
        { ...run({ records: 40, at: daysAgo(120) }), source: 'who_gho' },
      ],
    })
    const bySource = Object.fromEntries(report.map((entry) => [entry.source, entry]))

    assert.equal(bySource.gdacs.verdict, 'quiet')
    assert.equal(bySource.gdacs.records_last_run, 0)
    assert.equal(bySource.gdacs.age_days, 0.5)
    assert.equal(bySource.gdacs.cadence_days, 1)
    assert.match(bySource.gdacs.reason, /0 records/u)

    assert.equal(bySource.chirps.verdict, 'broken')
    assert.equal(bySource.who_gho.verdict, 'ok')
    assert.equal(bySource.who_gho.age_days, 120)

    // A run for a source that no longer exists must not leak into the report.
    assert.equal(report.length, SOURCE_IDS.length)
    assert.equal(bySource.gdelt, undefined)

    for (const entry of report) {
      assert.ok(FRESHNESS_VERDICTS.includes(entry.verdict), `${entry.source} returned ${entry.verdict}`)
      assert.ok(entry.reason.length > 0, `${entry.source} returned an empty reason`)
    }
  })

  it('treats a quiet run as the clock anchor so silence does not age into stale', () => {
    // The quiet run is the most recent proof the source answered, so it holds
    // the clock. Anchoring on the last *status: success* row instead would let
    // a feed that is running fine age into `stale` purely because it had
    // nothing to report.
    const report = freshnessReport({
      now: NOW,
      sourceRuns: [
        { ...run({ status: 'degraded', records: 0, at: daysAgo(0.5), errors: ['Expected at least 1 records for gdacs; received 0.'] }), source: 'gdacs' },
      ],
    })
    const gdacs = report.find((entry) => entry.source === 'gdacs')
    assert.equal(gdacs.verdict, 'quiet')
    assert.equal(gdacs.age_days, 0.5)
  })
})