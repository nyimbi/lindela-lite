#!/usr/bin/env node
/**
 * Four gaps the modules had after their first pass, each of which was a way for
 * the platform to look healthy while saying nothing.
 *
 * Each test here corresponds to a specific defect, and each defect was verified
 * against the code before the fix: every "was" comment below was observed by
 * running the pre-fix module, not inferred from reading it. That matters more
 * than usual, because two of the four were absence of a field rather than a
 * wrong value, and an absence cannot be caught by a test written from the
 * source alone — the test and the bug agree perfectly.
 *
 *   1. `compareSeries` reported "unmatched_months: 0" for two products covering
 *      entirely disjoint months, because it compared two *sizes* rather than
 *      two *sets*. Two 12-month series with no months in common differ by zero.
 *      It also reported `series_b_length` from A's index.
 *   2. "these two disagree" and "only one of them covers this" both arrived as
 *      `unavailable`. No coverage vocabulary existed at all.
 *   3. `scoreConnector` had no production caller. It scored the breaker's
 *      in-memory window, and `runIngestion` builds that window per run and
 *      discards it — so the one number ENH-10 exists to produce was produced
 *      nowhere outside tests.
 *   4. A connector's completeness verdict reached the direct caller and nobody
 *      else. It reached the run record as a line of prose inside `errors`,
 *      counted into the same `degraded` flag as a parser warning.
 *
 * Plus the 429 half of ENH-11: a provider answering 429 with no `Retry-After`
 * got the 150/300ms backoff, ignoring a token bucket that had already worked
 * out it was running above budget.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COVERAGE_VERDICTS,
  AGREEMENT_VERDICTS,
  agreementReport,
  compareSeries,
} from '../src/agreement.js'
import { COMPLETENESS_VERDICTS, completenessVerdictName } from '../src/completeness.js'
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_STATES,
  allowRequest,
  createCircuitState,
  outcomesFromRuns,
  recordOutcome,
  scoreConnector,
} from '../src/circuit.js'
import { ingestionStatus, runIngestion } from '../src/ingestion.js'
import { fetchWithRetry, resetRateLimiters } from '../src/connectors/http.js'
import { createRateLimiter } from '../src/rate-limit.js'

const record = (period, precipitation_mm) => ({ period, precipitation_mm })

// ------------------------------------------------------------------ ENH-09

describe('coverage is a different question from agreement', () => {
  it('does not report a clean bill of health for two disjoint series', () => {
    // The bug this closes. Twelve months against twelve months, no month in
    // common. The size difference is zero, so the old expression reported
    // "no unmatched months" for two products that agreed about nothing at all —
    // and `unavailable` was the only hint, which reads as "not enough data"
    // rather than "these two have never overlapped".
    const result = compareSeries({
      district: 'Turkana',
      period: '2019',
      productA: 'chirps',
      productB: 'era5',
      recordsA: Array.from({ length: 12 }, (_, i) => record(`2019-${String(i + 1).padStart(2, '0')}`, i)),
      recordsB: Array.from({ length: 12 }, (_, i) => record(`2020-${String(i + 1).padStart(2, '0')}`, i)),
    })

    assert.equal(result.paired_months, 0)
    assert.equal(result.unmatched_months, 24, 'every month is unmatched, and the count says so')
    assert.equal(result.coverage, 'disjoint')
    assert.equal(result.verdict, 'unavailable', 'and no verdict is invented from an empty comparison')
    assert.equal(result.only_in_a.length, 12)
    assert.equal(result.only_in_b.length, 12)
  })

  it('names the months rather than counting them', () => {
    // A count of two is unreadable. "CHIRPS stops in March" is the finding, and
    // it is the difference between going to look at a source and going to look
    // at a comparison.
    const result = compareSeries({
      district: 'Turkana',
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-02', 30), record('2019-03', 40)],
      recordsB: [record('2019-01', 6)],
    })

    assert.deepEqual(result.only_in_a, ['2019-02', '2019-03'])
    assert.deepEqual(result.only_in_b, [])
    assert.equal(result.coverage, 'partial')
    assert.equal(result.unmatched_months, 2)
  })

  it('reads each side length from its own index', () => {
    // `series_b_length` was `indexA.size`. On any asymmetric pair the field
    // named for B reported A, so a caller reconciling the two lengths — the
    // obvious use for them — reconciled a number against itself.
    const result = compareSeries({
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-02', 30), record('2019-03', 40)],
      recordsB: [record('2019-01', 6)],
    })

    assert.equal(result.series_a_length, 3)
    assert.equal(result.series_b_length, 1)
  })

  it('classifies every combination, and never calls two empty series "both"', () => {
    const both = compareSeries({
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-02', 30), record('2019-03', 40)],
      recordsB: [record('2019-01', 6), record('2019-02', 31), record('2019-03', 38)],
    })
    const bOnly = compareSeries({
      period: '2019',
      recordsA: [],
      recordsB: [record('2019-01', 6), record('2019-02', 31)],
    })
    const neither = compareSeries({ period: '2019', recordsA: [], recordsB: [] })

    assert.equal(both.coverage, 'both')
    assert.equal(bOnly.coverage, 'b_only')
    assert.equal(neither.coverage, 'neither')
    // Neither product reporting anything is not two products in agreement about
    // nothing. `both` there would be a clean bill of health for zero evidence.
    assert.equal(neither.paired_months, 0)
  })

  it('exposes a frozen coverage vocabulary', () => {
    assert.ok(Object.isFrozen(COVERAGE_VERDICTS))
    assert.equal(new Set(COVERAGE_VERDICTS).size, COVERAGE_VERDICTS.length)
  })

  it('keeps coverage out of the verdict vocabulary', () => {
    // They are orthogonal axes and one list cannot hold both. Folding `both`
    // into AGREEMENT_VERDICTS would make "both cover it" answer a question
    // about whether they agree.
    for (const name of COVERAGE_VERDICTS) {
      assert.ok(!AGREEMENT_VERDICTS.includes(name), `${name} leaked into the verdict vocabulary`)
    }
  })

  it('keeps "not covered" out of "disagreed" in the report', () => {
    // The report is what a score reads. Before this, a district where one
    // product covers nothing reported disputed_count: 0 and any_disputed:
    // false — indistinguishable from a district where two products agreed on
    // every month. The reader would conclude the products agree.
    const agreed = compareSeries({
      period: '2019',
      recordsA: [record('2019-01', 5), record('2019-02', 30), record('2019-03', 40), record('2019-04', 20)],
      recordsB: [record('2019-01', 6), record('2019-02', 31), record('2019-03', 38), record('2019-04', 21)],
    })
    const uncovered = compareSeries({
      period: '2020',
      recordsA: [record('2020-01', 5)],
      recordsB: [record('2021-01', 6)],
    })

    const clean = agreementReport([agreed])
    const blind = agreementReport([uncovered])

    assert.equal(clean.any_disputed, false)
    assert.equal(clean.coverage.fully_covered_periods, 1)
    assert.equal(clean.coverage.fully_covered_rate, 1)

    assert.equal(blind.any_disputed, null, 'nothing was comparable, so nothing was found')
    assert.equal(blind.disputed_count, 0)
    assert.equal(blind.coverage.fully_covered_periods, 0)
    assert.equal(blind.coverage.partial_or_one_sided_periods, 1)
    // The gap counts even though the period is `unavailable` as a verdict. A
    // period the two products never shared is unavailable because there is
    // nothing to compare — but the coverage answer is measured and negative,
    // and the point of this field is that it survives the filter that removed
    // the period from `comparisons`.
    assert.equal(blind.coverage.fully_covered_rate, 0)
    assert.deepEqual(blind.coverage.gaps, [{ period: '2020', coverage: 'disjoint', unmatched_months: 2 }])
  })

  it('reports a measured zero when the comparison ran and covered nothing', () => {
    // Zero, not null — and the asymmetry with `any_disputed` is the point.
    // `any_disputed` is null because no comparison ran, so there was nothing to
    // find. Here a comparison *did* run and reported `neither`: coverage was
    // measured, and the measurement is zero. Reporting null would file the
    // clearest coverage failure there is under "we have no idea".
    const report = agreementReport([compareSeries({ period: '2019', recordsA: [], recordsB: [] })])
    assert.equal(report.periods_compared, 0, 'nothing was comparable')
    assert.equal(report.any_disputed, null, 'so nothing was found')
    assert.equal(report.coverage.fully_covered_periods, 0)
    assert.equal(report.coverage.fully_covered_rate, 0, 'but the coverage question *was* answered')
    assert.deepEqual(report.coverage.gaps, [{ period: '2019', coverage: 'neither', unmatched_months: 0 }])
  })

  it('reports null coverage when no comparison was offered at all', () => {
    const report = agreementReport([])
    assert.equal(report.coverage.fully_covered_rate, null)
    assert.equal(report.coverage.fully_covered_periods, 0)
  })
})

// ------------------------------------------------------------------ ENH-10

describe('the health score is produced by the run loop, not only by tests', () => {
  it('scores from stored run history', () => {
    // `scoreConnector` had no production caller. Its only input was the
    // breaker's in-memory window, which `runIngestion` creates per run and
    // throws away — so the score ENH-10 exists to produce was null everywhere
    // outside a test that built the window by hand.
    const runs = Array.from({ length: 6 }, (_, i) => ({
      status: 'success',
      records_processed: 100 + i,
      diagnostics: { duration_ms: 400 + i * 10 },
      completed_at: `2026-10-0${i + 1}T00:00:00.000Z`,
    }))

    const scored = scoreConnector({ outcomes: outcomesFromRuns(runs) })
    assert.equal(scored.samples, 6)
    assert.equal(scored.success_rate, 1)
    assert.notEqual(scored.score, null, 'six measured runs are enough to score')
  })

  it('reads the window oldest-first, so drift compares against the right baseline', () => {
    // `ingestionStatus` reads runs newest-first and the drift baseline is the
    // mean of everything before the newest. Reversed wrongly, a source whose
    // volume tripled would show a baseline including the tripling and report
    // no drift at all — the direction that hides a broken feed.
    const runs = [
      { status: 'success', records_processed: 1000, diagnostics: { duration_ms: 100 } },
      { status: 'success', records_processed: 100, diagnostics: { duration_ms: 100 } },
      { status: 'success', records_processed: 100, diagnostics: { duration_ms: 100 } },
    ]
    const scored = scoreConnector({ outcomes: outcomesFromRuns(runs) })
    assert.equal(scored.record_drift_ratio, 9, '1000 against a baseline of 100 is a 9x drift')
  })

  it('does not count a breaker skip as a success', () => {
    // A source skipped every run for a week made zero requests. Counting those
    // as successes reports a perfect success rate off no evidence, which is
    // the anti-vacuous rule defeated by one missing filter.
    const runs = Array.from({ length: 5 }, () => ({ status: 'skipped', records_processed: 0 }))
    const scored = scoreConnector({ outcomes: outcomesFromRuns(runs) })
    assert.equal(scored.success_rate, 0, 'skipped is not ok; the breaker declined to ask')
  })

  it('leaves the score null when the run records carry no latency to measure', () => {
    const runs = [{ status: 'success', records_processed: 10 }, { status: 'success', records_processed: 11 }]
    const scored = scoreConnector({ outcomes: outcomesFromRuns(runs) })
    assert.equal(scored.p95_latency_ms, null)
    assert.equal(scored.score, null, 'a score from two of three signals is not a score')
    assert.ok(CIRCUIT_STATES.length === 3)
  })

  it('scores null rather than 100 for a source nobody has run', () => {
    const scored = scoreConnector({ outcomes: outcomesFromRuns([]) })
    assert.equal(scored.score, null)
    assert.equal(scored.success_rate, null)
    assert.equal(CIRCUIT_FAILURE_THRESHOLD, 3)
  })
})

describe('the breaker opens, and comes back', () => {
  it('walks closed → open → half_open → closed and can be probed again after', () => {
    // A breaker that opens on one failure and never closes is a denial of
    // service you administer yourself. The recovery has to be reachable, which
    // means asserting the whole path rather than only that it opened.
    const T0 = 1_700_000_000_000
    const MINUTE = 60_000
    let state = createCircuitState()

    assert.equal(allowRequest(state, 'chingo', { now: T0 }).reason, 'ok')

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      assert.equal(allowRequest(state, 'chingo', { now: T0 + i }).allowed, true)
      state = recordOutcome(state, 'chingo', { ok: false, now: T0 + i })
    }

    const open = allowRequest(state, 'chingo', { now: T0 + 10 })
    assert.equal(open.allowed, false)
    assert.equal(open.reason, 'skipped_circuit_open', 'a skip is neither ok nor broken')

    // Still denied before the cooldown: opening does not mean the clock is
    // already spent.
    assert.equal(allowRequest(state, 'chingo', { now: T0 + 10 }).allowed, false)

    // Half-open after it, and exactly one probe is permitted.
    const probe = allowRequest(state, 'chingo', { now: T0 + 31 * MINUTE })
    assert.equal(probe.allowed, true)
    assert.equal(probe.probe, true)
    assert.equal(probe.reason, 'probing_half_open')

    const second = allowRequest(state, 'chingo', { now: T0 + 31 * MINUTE })
    assert.equal(second.allowed, false, 'a half-open circuit admits one probe, not a stampede')
    assert.equal(second.reason, 'skipped_circuit_probe_in_flight')

    state = recordOutcome(state, 'chingo', { ok: true, now: T0 + 31 * MINUTE })
    assert.equal(allowRequest(state, 'chingo', { now: T0 + 31 * MINUTE }).reason, 'ok')
  })

  it('re-opens on a failed probe rather than closing on it', () => {
    // The other half of recovery. A probe that fails must put the circuit back
    // to open with the cooldown restarted, or "recovery" would mean a source
    // gets one request per cooldown forever while never being called again.
    const T0 = 1_700_000_000_000
    const MINUTE = 60_000
    let state = createCircuitState()

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      state = recordOutcome(state, 'chingo', { ok: false, now: T0 + i })
    }
    const probeAt = T0 + 31 * MINUTE
    assert.equal(allowRequest(state, 'chingo', { now: probeAt }).probe, true)
    state = recordOutcome(state, 'chingo', { ok: false, now: probeAt })

    assert.equal(allowRequest(state, 'chingo', { now: probeAt + 1 }).allowed, false)
    assert.equal(allowRequest(state, 'chingo', { now: probeAt + 31 * MINUTE }).probe, true,
      'the cooldown restarted, so recovery is reachable again')
  })

  it('does not probe a circuit whose open time was never recorded', () => {
    // `opened_at: null` means the trip time was lost. Treating the cooldown as
    // elapsed would let any source with a corrupt record through once per run
    // forever; a breaker that cannot say how long it has been open has no
    // licence to start asking.
    const state = {
      version: 1,
      sources: { chingo: { state: 'open', consecutive_failures: 3, opened_at: null, probe_in_flight: false, history: [] } },
    }
    assert.equal(allowRequest(state, 'chingo', { now: 9_999_999_999_999 }).allowed, false)
  })

  it('keeps a zero record count rather than dropping the run from the baseline', () => {
    // A source returning a valid empty page has said something. Truthiness
    // files 0 as "no measurement" and quietly excludes it from the drift
    // baseline, which is the falsy-zero conflation at a new address.
    const state = recordOutcome(createCircuitState(), 'chingo', { ok: true, recordCount: 0 })
    assert.equal(state.sources.chingo.history[0].record_count, 0)
  })
})

// ------------------------------------------------------------------ ENH-14

describe('a truncated walk says so where an operator will see it', () => {
  const store = { merge: async (data) => data, write: async () => {} }

  const connectorReturning = (completeness, errors) => ({
    id: 'chirps',
    transform: () => ({}),
    ingest: async () => ({
      climate_observations: [{ id: 'x', district_id: 'D1', observed_at: '2020-01-01T00:00:00Z', precipitation_mm: 1 }],
      errors,
      completeness,
    }),
  })

  it('puts the verdict on the run record rather than only in the caller', async () => {
    // The gap. The verdict existed on the connector's return value, and on the
    // run record only as prose inside `errors` — folded into the same
    // `degraded` flag as a parser warning, so a walk that fetched 30 of 730
    // files and a walk that fetched all 730 with a warning were one field.
    const out = await runIngestion(
      store,
      { sources: ['chirps'] },
      {
        connectors: {
          chirps: connectorReturning(
            { complete: false, possibly_incomplete: true, reason: 'capped at 30 of 730', counts_found: 730 },
            ['chirps: walk is possibly_incomplete — capped at 30 of 730'],
          ),
        },
      },
    )

    const run = out.source_runs[0]
    assert.equal(run.completeness, 'possibly_incomplete')
    assert.equal(run.diagnostics.completeness_verdict, 'possibly_incomplete')
    assert.equal(run.diagnostics.possible_incomplete, true, 'the flag an operator scans is set')
  })

  it('says "not measurable" for a connector that reports no completeness', async () => {
    // Null, not `complete`. A single-request source walks no pages and has
    // nothing to be truncated by; calling that `complete` puts it in the same
    // column as a walk that was checked and found whole.
    const out = await runIngestion(store, { sources: ['chirps'] }, {
      connectors: { chirps: connectorReturning(undefined, []) },
    })
    assert.equal(out.source_runs[0].completeness, null)
    assert.equal(out.source_runs[0].diagnostics.possible_incomplete, false)
  })

  it('does not let a complete walk set the incomplete flag', async () => {
    const out = await runIngestion(store, { sources: ['chirps'] }, {
      connectors: { chirps: connectorReturning({ complete: true, counts_found: 730 }, []) },
    })
    assert.equal(out.source_runs[0].completeness, 'complete')
    assert.equal(out.source_runs[0].diagnostics.possible_incomplete, false)
  })

  it('surfaces the last verdict and a health score on the status route', () => {
    // Four runs, because three is the floor at which a latency percentile means
    // anything. With one run the score is correctly null, and asserting a score
    // here would either fail or — worse, if someone "fixed" it by widening the
    // score to two of three signals — pin a number that describes no
    // distribution.
    const now = new Date().toISOString()
    const status = ingestionStatus({
      source_runs: Array.from({ length: 4 }, (_, i) => ({
        source: 'chirps',
        status: i === 0 ? 'degraded' : 'success',
        started_at: now,
        completed_at: now,
        records_processed: 30 + i,
        completeness: 'possibly_incomplete',
        diagnostics: { duration_ms: 500 + i * 10 },
      })),
    })
    const chirps = status.find((s) => s.source === 'chirps')
    assert.equal(chirps.completeness, 'possibly_incomplete')
    assert.equal(chirps.health.samples, 4, 'the score is measured from stored history, not from nothing')
    assert.notEqual(chirps.health.score, null, 'and the health score is now produced in production')
  })

  it('reads the booleans back into the frozen vocabulary from one place', () => {
    assert.equal(completenessVerdictName({ complete: true }), 'complete')
    assert.equal(completenessVerdictName({ complete: false, possibly_incomplete: true }), 'possibly_incomplete')
    assert.equal(completenessVerdictName({ complete: false }), 'incomplete')
    // `complete: true` wins even when the other flag is also set, because a
    // met provider total clears a full last page and both can be true.
    assert.equal(completenessVerdictName({ complete: true, possibly_incomplete: true }), 'complete')
    // Null in, `incomplete` out. A caller that passes nothing is told it has no
    // evidence rather than handed a pass.
    assert.equal(completenessVerdictName(null), 'incomplete')
    for (const name of ['complete', 'possibly_incomplete', 'incomplete']) {
      assert.ok(COMPLETENESS_VERDICTS.includes(name))
    }
  })
})

// ------------------------------------------------------------------ ENH-11

describe('a 429 waits for the limiter, not just for the backoff', () => {
  it('does not spend a token when asked how long the next one is', async () => {
    // `tryAcquire` takes a token to find out, so a caller probing before
    // deciding whether to sleep would empty its own bucket one probe at a time.
    const now = { t: 0 }
    // The fake sleep advances the clock it is asked to wait for. One that
    // resolved immediately instead would spin the drain loop forever: the
    // limiter wakes, finds the clock unmoved, and queues the same wake again.
    const limiter = createRateLimiter({
      ratePerWindow: 1,
      windowMs: 60_000,
      concurrency: 4,
      now: () => now.t,
      sleep: async (ms) => { now.t += ms },
    })

    const release = await limiter.acquire()
    assert.equal(limiter.inFlight(), 1)
    for (let i = 0; i < 5; i += 1) {
      assert.ok(limiter.nextTokenMs() > 0, 'the probe is read-only, so it stays the same answer')
      assert.equal(limiter.tokens(), 0, 'five probes spent five tokens')
    }
    now.t += 60_000
    assert.equal(limiter.nextTokenMs(), 0, 'a token has refilled')
    release()
  })

  it('widens a headerless 429 to the refill interval', async () => {
    // Observed before the fix: a limiter-declared source answering 429 with no
    // `Retry-After` slept 150ms then 300ms, while its own token bucket sat
    // empty. That is a source being run above its declared budget, retried on a
    // schedule that knows nothing about the budget.
    resetRateLimiters()
    const sleeps = []
    const now = { t: 0 }
    globalThis.fetch = async () => new Response('busy', { status: 429 })

    try {
      await fetchWithRetry('https://fixture.test/ipc', {
        source: 'ipc_hdx',
        retries: 2,
        ratePerWindow: 1,
        windowMs: 60_000,
        concurrency: 1,
        now: () => now.t,
        sleep: async (ms) => { sleeps.push(ms); now.t += ms },
      })
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.status, 429)
    }

    assert.equal(sleeps.length, 2)
    for (const waited of sleeps) {
      assert.ok(waited >= 60_000, `expected the refill interval to widen the backoff, got ${waited}ms`)
    }
  })

  it('leaves a 500 on its own backoff, because a failure is not a rate limit', async () => {
    // A provider that is failing is usually not also rate-limiting, and the
    // bucket already paces us for whatever does come back. Widening these to
    // the refill interval would make an outage slower to clear for no reason.
    //
    // The budget is wide here so the limiter's own acquire never blocks: at
    // 1/min the retry's own `acquire()` waits a full refill interval, and this
    // assertion would then be measuring the limiter rather than the backoff it
    // is about. The 429 case above is the one where that wait is the point.
    resetRateLimiters()
    const sleeps = []
    const now = { t: 0 }
    globalThis.fetch = async () => new Response('boom', { status: 500 })

    try {
      await fetchWithRetry('https://fixture.test/gdacs', {
        source: 'gdacs',
        retries: 2,
        ratePerWindow: 1000,
        windowMs: 60_000,
        concurrency: 1,
        now: () => now.t,
        sleep: async (ms) => { sleeps.push(ms); now.t += ms },
      })
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.status, 500)
    }

    assert.deepEqual(sleeps, [150, 300], 'the backoff this function always used')
  })

  it('still honours Retry-After as the longer of the two', async () => {
    resetRateLimiters()
    const sleeps = []
    const now = { t: 0 }
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
        : new Response('ok', { status: 200 })
    }

    const body = await fetchWithRetry('https://fixture.test/gdacs', {
      source: 'gdacs',
      retries: 2,
      ratePerWindow: 100,
      windowMs: 60_000,
      concurrency: 1,
      now: () => now.t,
      sleep: async (ms) => { sleeps.push(ms); now.t += ms },
    })

    assert.equal(body, 'ok')
    assert.deepEqual(sleeps, [120_000], 'the provider asked for two minutes and got them')
  })
})
