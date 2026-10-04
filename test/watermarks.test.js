#!/usr/bin/env node
/**
 * ENH-08: the watermark arithmetic, made checkable.
 *
 * `open-meteo-archive` and `open-meteo-flood` build their record id from
 * `[source, region, startDate, endDate]` while `endDate` defaults to today, and
 * both re-download the whole history each run. The id therefore moves every day
 * over identical bytes — ~16,000 records per region per day per source, none of
 * it new — and because the duplication is invisible from outside (every run
 * succeeds, every record validates) there is no event to subscribe to. The only
 * observable is the *window* those two runs request, which is why almost every
 * test here is about the window and not about the watermark.
 *
 * The other guards are the ones that keep a fix honest:
 * - `backfillProgress` returning 0 for an unstarted backfill would satisfy every
 *   number-shaped assertion while being false, so there is a test that fails
 *   specifically on 0.
 * - The cursor tests pin the *stated fallback* for a junk cursor. "Never
 *   inverted" is a property an implementation can satisfy by accident, by
 *   clamping in the other direction; the fallback has to be the documented one.
 * - `WATERMARK_SOURCES` is checked against the connector sources on disk. An
 *   exported list nobody re-checks is a list that rots the first time a source
 *   is renamed, and the rot is invisible: the renamed source just keeps
 *   re-downloading its history.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { getConnector } from '../src/ingestion.js'

import {
  WATERMARK_SOURCES,
  SERIES_FLOOR,
  createWatermarkState,
  readWatermark,
  fetchWindow,
  advanceWatermark,
  beginBackfill,
  advanceBackfill,
  completeBackfill,
  failBackfill,
  resumeBackfill,
  backfillProgress,
} from '../src/watermarks.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE = 'open_meteo_archive'
// Days in a 45-year lookback; the archive series runs 1981 → today.
const FULL_LOOKBACK = 45 * 365

/** The id the archive connector would mint for a window. Mirrors stableId's inputs. */
function derivedId(source, region, startDate, endDate) {
  return JSON.stringify([source, region, startDate, endDate])
}

/** The part of a window the connector actually sends upstream. */
function request(w) {
  return { startDate: w.startDate, endDate: w.endDate, days: w.days, skip: w.skip, mode: w.mode }
}

function win(state, source = ARCHIVE, lookback = FULL_LOOKBACK, now = '2026-10-02') {
  return fetchWindow({ source, watermark: readWatermark(state, source), defaultWindowDays: lookback, now })
}

describe('fetchWindow — id stability', () => {
  it('two consecutive days with nothing new request an identical window', () => {
    // The headline. A watermark that already covers both run days means neither
    // run has anything to fetch, so neither should mint a window whose end is
    // the run date — that is the daily id churn, ~16,000 records per region per
    // day per source over bytes already stored.
    //
    // This test fails if fetchWindow returns today for `endDate` no matter what
    // the watermark says: on 2026-10-08 the broken version ends the window on
    // the 8th, on the 9th on the 9th, and the derived id changes for no reason.
    const state = {
      [ARCHIVE]: { last_success_at: '2026-10-09T02:00:00.000Z', last_cursor: '2026-10-09', last_record_date: '2026-10-09' },
    }

    const first = win(state, ARCHIVE, FULL_LOOKBACK, '2026-10-08')
    const second = win(state, ARCHIVE, FULL_LOOKBACK, '2026-10-09')

    assert.equal(first.skip, true)
    // Identity is the request, not the diagnosis. The two runs disagree about
    // *why* the window is empty — the first sees a cursor ahead of its clock,
    // the second sees a caught-up mark — and that difference belongs in the log,
    // not in the window. Only the fields the connector sends are compared.
    assert.deepEqual(request(first), request(second))
    assert.deepEqual(derivedId(ARCHIVE, 'Turkana', first.startDate, first.endDate),
      derivedId(ARCHIVE, 'Turkana', second.startDate, second.endDate))
    assert.notEqual(first.reason, second.reason, 'the two runs really do have different diagnoses')
  })

  it('is a pure function of its inputs, so a retried run reuses the same id', () => {
    // A retry after a timeout must land on the same record id as the run it is
    // retrying. Anything reading the clock inside the module — Date.now() in the
    // default, say — makes this fail across a midnight boundary.
    const state = { [ARCHIVE]: { last_cursor: '2026-09-30', last_record_date: '2026-09-30' } }
    const a = win(state, ARCHIVE, 30, '2026-10-02')
    const b = win(state, ARCHIVE, 30, '2026-10-02')
    assert.deepEqual(a, b)
    assert.equal(a.startDate, '2026-10-01')
    assert.equal(a.endDate, '2026-10-02')
    assert.equal(a.days, 2)
  })
})

describe('fetchWindow — first run vs later run', () => {
  it('first run with no watermark fetches the full series', () => {
    const w = win(createWatermarkState(), ARCHIVE, FULL_LOOKBACK, '2026-10-02')
    assert.equal(w.mode, 'full')
    assert.equal(w.reason, 'no-watermark')
    assert.equal(w.startDate, '1981-01-01')
    assert.equal(w.endDate, '2026-10-02')
    assert.equal(w.skip, false)
  })

  it('a later run fetches only what is new', () => {
    const state = { [ARCHIVE]: { last_cursor: '2026-09-30', last_record_date: '2026-09-30' } }
    const w = win(state, ARCHIVE, FULL_LOOKBACK, '2026-10-02')
    assert.equal(w.mode, 'incremental')
    assert.equal(w.startDate, '2026-10-01')
    assert.equal(w.endDate, '2026-10-02')
    // Two days, not forty-five years. This is the whole saving.
    assert.equal(w.days, 2)
  })

  it('a watermark at the window edge skips instead of re-fetching', () => {
    const state = { [ARCHIVE]: { last_cursor: '2026-10-02', last_record_date: '2026-10-02' } }
    const w = win(state, ARCHIVE, FULL_LOOKBACK, '2026-10-02')
    assert.equal(w.skip, true)
    assert.equal(w.mode, 'empty')
    assert.equal(w.reason, 'caught-up')
    assert.equal(w.days, 0)
    // A null range, not an inverted one. `start_date=2026-10-03&end_date=2026-10-02`
    // goes out to the API and comes back empty, which reads as a source outage.
    assert.equal(w.startDate, null)
    assert.equal(w.endDate, null)
  })

  it('an absent watermark is not a zero watermark', () => {
    // '1970-01-01' is the epoch of a cursor that was never written, not a
    // statement that we hold every reading since 1970. Read literally it turns a
    // five-decade series into a fifty-five-decade download, and for a source
    // whose data begins in 1981 there are no readings to find in the extra
    // eleven years — only requests.
    const absent = win(createWatermarkState(), ARCHIVE, 365, '2026-10-02')
    const zeroed = win({ [ARCHIVE]: { last_cursor: '1970-01-01', last_record_date: '1970-01-01' } }, ARCHIVE, 365, '2026-10-02')

    assert.notDeepEqual(absent, zeroed)
    assert.equal(absent.reason, 'no-watermark')
    assert.equal(zeroed.reason, 'cursor-before-window-start')
    // Never run → ask for the series. Junk cursor → ask for a bounded window.
    assert.equal(absent.startDate, SERIES_FLOOR[ARCHIVE])
    assert.equal(zeroed.startDate, '2025-10-02')
    assert.ok(zeroed.startDate > '1970-01-01', 'a zero watermark must not reach back to the epoch')
  })
})

describe('advanceWatermark', () => {
  it('moves the mark forward', () => {
    const state = { [ARCHIVE]: { last_cursor: '2026-09-30', last_record_date: '2026-09-30' } }
    const next = advanceWatermark(state, ARCHIVE, { cursor: '2026-10-02', recordDate: '2026-10-02', at: '2026-10-02T03:00:00.000Z' })
    assert.equal(next[ARCHIVE].last_record_date, '2026-10-02')
    assert.equal(next[ARCHIVE].last_cursor, '2026-10-02')
    assert.equal(next[ARCHIVE].last_success_at, '2026-10-02T03:00:00.000Z')
    // Pure: the input state is untouched.
    assert.equal(state[ARCHIVE].last_record_date, '2026-09-30')
  })

  it('never moves the mark backward', () => {
    // A stale run answering after a newer one — a lagging replica, a backfill
    // completing late. Rewinding the mark makes the next incremental fetch
    // re-request the whole gap, which is the duplicate history this module
    // exists to stop, arriving by the back door.
    const state = { [ARCHIVE]: { last_cursor: '2026-10-02', last_record_date: '2026-10-02', last_success_at: 'x' } }
    const next = advanceWatermark(state, ARCHIVE, { cursor: '2026-09-01', recordDate: '2026-09-01', at: '2026-09-01T00:00:00.000Z' })
    assert.equal(next[ARCHIVE].last_record_date, '2026-10-02')
    assert.equal(next[ARCHIVE].last_cursor, '2026-10-02')
  })

  it('leaves an in-progress backfill alone', () => {
    // Two independent things are tracked by one entry: the incremental mark and
    // a running crawl. Finishing a fetch is not finishing a backfill.
    const begun = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    const next = advanceWatermark(begun, ARCHIVE, { cursor: '2026-10-02', recordDate: '2026-10-02', at: 't1' })
    assert.equal(next[ARCHIVE].in_progress.job_id, 'j1')
  })
})

describe('resumable backfill', () => {
  it('resumes from its cursor and does not re-request the completed chunk', () => {
    // The spec's motivating case: a district server loses power mid-crawl.
    // A restart that begins from `from` re-downloads every chunk it already
    // finished — on a 45-year quarter-by-quarter walk, most of a day.
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    const first = resumeBackfill(state, ARCHIVE)
    assert.equal(first.from, '1981-01-01')
    assert.equal(first.to, '1990-01-01')
    assert.equal(first.cursor, null, 'a fresh backfill has completed nothing')

    state = advanceBackfill(state, ARCHIVE, { cursor: '1985-06-30', at: 't1' })
    const second = resumeBackfill(state, ARCHIVE)
    assert.equal(second.from, '1985-07-01', 'the completed chunk must not be requested again')
    assert.equal(second.to, '1990-01-01')
    assert.equal(second.chunksDone, 1)
    assert.ok(second.from <= second.to, 'a resume must never hand back an inverted range')
  })

  it('resumeBackfill is null once the range is exhausted', () => {
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1981-01-05', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1981-01-05' })
    assert.equal(resumeBackfill(state, ARCHIVE), null)
  })

  it('a failed crawl keeps its cursor so the retry resumes', () => {
    // The cursor is copied to last_backfill and in_progress is cleared: a job
    // that has stopped is not in progress, and reporting it as such makes a dead
    // crawl look live on every dashboard.
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1985-06-30', at: 't1' })
    state = failBackfill(state, ARCHIVE, { at: 't2', error: 'upstream 503' })

    assert.equal(state[ARCHIVE].in_progress, null)
    assert.equal(state[ARCHIVE].last_failure.error, 'upstream 503')
    const retry = resumeBackfill(state, ARCHIVE)
    assert.equal(retry.from, '1985-07-01')
    assert.equal(retry.to, '1990-01-01')
  })

  it('a crash leaves in_progress intact and resumes from it', () => {
    // No failBackfill call — the process is simply gone. The distinction from the
    // case above is the whole reason both paths exist.
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1985-06-30', at: 't1' })
    assert.equal(resumeBackfill(state, ARCHIVE).from, '1985-07-01')
  })

  it('completing a backfill lifts the mark to the end of the range', () => {
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1990-01-01' })
    state = completeBackfill(state, ARCHIVE, { at: 't2' })
    assert.equal(state[ARCHIVE].in_progress, null)
    assert.equal(state[ARCHIVE].last_record_date, '1990-01-01')
  })

  it('a backfill over old history does not drag the incremental mark back', () => {
    // The mark is a high-water mark. Finishing a 1981–1990 crawl must not leave
    // it at 1990 — the next run would then re-request thirty-six years.
    let state = { [ARCHIVE]: { last_cursor: '2026-10-02', last_record_date: '2026-10-02' } }
    state = beginBackfill(state, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1990-01-01' })
    state = completeBackfill(state, ARCHIVE, { at: 't2' })
    assert.equal(state[ARCHIVE].last_record_date, '2026-10-02')
  })

  it('rejects an inverted backfill range', () => {
    assert.throws(() => beginBackfill({}, ARCHIVE, { from: '1990-01-01', to: '1981-01-01', jobId: 'j1' }), RangeError)
  })
})

describe('backfillProgress', () => {
  it('reports a real crawl as a real fraction', () => {
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1981-12-31', jobId: 'j1', at: 't0' })
    state = advanceBackfill(state, ARCHIVE, { cursor: '1981-03-31' })
    const p = backfillProgress(state, ARCHIVE)
    assert.equal(p.started, true)
    assert.equal(p.total, 365)
    assert.equal(p.done, 90)
    assert.equal(p.remaining, 275)
    assert.equal(p.ratio, 90 / 365)
  })

  it('reports an unstarted backfill as null, not zero', () => {
    // 0 is a measurement — "measured, and the answer is none of it". An unstarted
    // crawl has not been measured at all, and the number 0 is indistinguishable
    // from a crawl that started and stalled at its first day. Those two want
    // opposite responses: start one, or kill the hung one. So this is null with
    // started:false, and the next test is what stops it decaying back to 0.
    const begun = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    const p = backfillProgress(begun, ARCHIVE)

    assert.equal(p.started, false)
    assert.equal(p.ratio, null)
    assert.equal(p.done, null)
    assert.equal(p.remaining, null)
    assert.equal(p.total, null)
  })

  it('never reports 0 for a backfill that has not been evaluated', () => {
    // The guard proper. Every assertion in the test above passes against a
    // `ratio: 0` implementation that also sets done:0 and remaining:0 — the
    // values look right and the claim is false. So assert the negation
    // explicitly, across every shape of "not started".
    let finished = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' })
    finished = advanceBackfill(finished, ARCHIVE, { cursor: '1990-01-01' })
    finished = completeBackfill(finished, ARCHIVE, { at: 't2' })

    const shapes = [
      createWatermarkState(),
      { [ARCHIVE]: { last_cursor: null, last_record_date: null } },
      { [ARCHIVE]: { last_record_date: '2026-10-02' } }, // an incremental mark, no backfill
      beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1', at: 't0' }),
      finished, // a completed crawl is not a crawl in progress
    ]
    for (const state of shapes) {
      const p = backfillProgress(state, ARCHIVE)
      assert.notEqual(p.ratio, 0, `unstarted backfill reported ratio 0 for ${JSON.stringify(state[ARCHIVE] ?? null)}`)
    }
  })

  it('reports 0 only alongside started: true, and so never reports 0 at all', () => {
    // The distinction the guard is really about. `started` means a chunk has come
    // back and moved the cursor — so a crawl that has measured nothing is
    // unmeasured, and a crawl that has measured something has done something.
    // 0 is unreachable, which is the point: the number a stall would have to
    // masquerade as is never on offer.
    let state = beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1981-01-01', jobId: 'j1', at: 't0' })
    const opened = backfillProgress(state, ARCHIVE)
    assert.equal(opened.started, false)
    assert.equal(opened.ratio, null)

    state = advanceBackfill(state, ARCHIVE, { cursor: '1981-01-01' })
    const done = backfillProgress(state, ARCHIVE)
    assert.equal(done.started, true)
    assert.equal(done.ratio, 1, 'a finished one-day crawl is complete, not empty')

    for (const shape of [createWatermarkState(), opened && beginBackfill({}, ARCHIVE, { from: '1981-01-01', to: '1990-01-01', jobId: 'j1' })]) {
      assert.notEqual(backfillProgress(shape, ARCHIVE).ratio, 0)
    }
  })
})

describe('cursor arithmetic is defensive', () => {
  it('an unparseable cursor falls back to a stated window, not an inverted one', () => {
    for (const junk of ['not-a-date', '', null, '2026-13-01', '2026-02-30', 1756]) {
      const w = win({ [ARCHIVE]: { last_cursor: junk, last_record_date: junk } }, ARCHIVE, 365, '2026-10-02')
      assert.equal(w.mode, 'full', `cursor ${JSON.stringify(junk)} should take the conservative fallback`)
      assert.equal(w.reason, 'cursor-unusable')
      assert.equal(w.startDate, '2025-10-02')
      assert.equal(w.endDate, '2026-10-02')
      assert.ok(w.startDate < w.endDate)
    }
  })

  it('a cursor before the window start clamps forward to it', () => {
    // Not backward, and not all the way to 1970. 'Never inverted' is satisfiable
    // by clamping the wrong way; the fallback is pinned to the lookback window.
    const w = win({ [ARCHIVE]: { last_cursor: '1979-06-01', last_record_date: '1979-06-01' } }, ARCHIVE, 365, '2026-10-02')
    assert.equal(w.reason, 'cursor-before-window-start')
    assert.equal(w.startDate, '2025-10-02')
    assert.ok(w.startDate < w.endDate)
  })

  it('a cursor ahead of the clock skips rather than fetching backwards', () => {
    // Clock skew, a bad write, a watermark copied off a later deployment. The
    // range that would be "correct" here runs backwards through history.
    const w = win({ [ARCHIVE]: { last_cursor: '2027-01-01', last_record_date: '2027-01-01' } }, ARCHIVE, FULL_LOOKBACK, '2026-10-02')
    assert.equal(w.skip, true)
    assert.equal(w.reason, 'cursor-ahead-of-now')
    assert.equal(w.startDate, null)
    assert.equal(w.endDate, null)
    assert.equal(w.asOf, '2027-01-01')
  })

  it('a non-finite or non-positive lookback is a loud error', () => {
    // Silently defaulting it is how a source ends up asking for 45 years.
    assert.throws(() => win({}, ARCHIVE, 0, '2026-10-02'), TypeError)
    assert.throws(() => win({}, ARCHIVE, NaN, '2026-10-02'), TypeError)
    assert.throws(() => fetchWindow({ source: ARCHIVE, watermark: null, defaultWindowDays: 30, now: 'not-a-date' }), TypeError)
  })
})

describe('WATERMARK_SOURCES', () => {
  it('covers the sources the spec names', () => {
    // ENH-08 names three. A source missing from the list keeps re-downloading
    // its history forever and nothing reports it, so the list is checked against
    // the spec rather than trusted.
    assert.deepEqual([...WATERMARK_SOURCES].sort(), ['gdacs_archive', 'open_meteo_archive', 'open_meteo_flood'])
    assert.equal(Object.isFrozen(WATERMARK_SOURCES), true)
  })

  it('every listed source exists as a connector on disk', () => {
    // A source-text guard, and the right one here: the thing compared is a list
    // of string literals against another list of string literals, and the
    // failure being caught is a rename in `spec.js` that leaves this list
    // pointing at a connector that no longer ingests under that name.
    // Asked of the runtime registry rather than of the source text.
    //
    // The previous version grepped each file for `id: 'open_meteo_archive'`, and
    // a connector that hoisted its id into a `SOURCE` constant stopped matching —
    // a refactor that changed no behaviour at all failed the guard. A text guard
    // here can only ever test spelling. `getConnector` is the thing ingestion
    // actually calls, so asserting on it tests the thing that matters, and it
    // cannot pass vacuously: a missing id throws rather than matching nothing.
    for (const source of WATERMARK_SOURCES) {
      const connector = getConnector(source)
      assert.ok(connector, `no connector is registered under id '${source}'`)
      assert.equal(connector.id, source, `'${source}' resolves to a connector with a different id`)
      assert.equal(typeof connector.ingest, 'function', `'${source}' has no ingest()`)
    }
  })

  it('the flood series floor matches the connector default', () => {
    // Duplicated knowledge, so it gets checked: `open-meteo-flood.js` starts at
    // 1984 for the GloFAS v4 reanalysis start. If that moves and this does not,
    // the watermark invites a fetch for years the source cannot answer.
    const flood = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'open-meteo-flood.js'), 'utf8')
    assert.ok(flood.includes(SERIES_FLOOR.open_meteo_flood), 'flood series floor drifted from the connector')
    const archive = fs.readFileSync(path.join(ROOT, 'src', 'connectors', 'open-meteo-archive.js'), 'utf8')
    assert.ok(archive.includes(SERIES_FLOOR.open_meteo_archive), 'archive series floor drifted from the connector')
  })
})