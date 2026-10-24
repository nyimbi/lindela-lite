import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { JsonStore } from '../src/store.js'
import { ingestionStatus, runIngestion } from '../src/ingestion.js'

/**
 * Watermark state has to survive a run.
 *
 * The contract existed — a connector reads `options.watermark_state` and returns
 * `output.watermark_state` — and nothing supplied either end, so a 40-year
 * archive walked its whole series on every run and re-downloaded it to discover
 * nothing was new.
 */

function scratchStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-wm-'))
  return new JsonStore(path.join(dir, 'store.json'))
}

/** A connector that records the state it was handed and returns a new one. */
function watermarkConnector(received, next) {
  return {
    id: 'open_meteo_archive',
    async ingest(options) {
      received.push(options.watermark_state)
      return {
        climate_observations: [{ id: `obs-${received.length}`, value: 1 }],
        errors: [],
        watermark_state: next,
      }
    },
  }
}

describe('watermark state survives a run', () => {
  it('hands the second run what the first stored', async () => {
    const store = scratchStore()
    await store.write({})

    const first = []
    const next = { sources: { open_meteo_archive: { last_success_at: '2026-01-01T00:00:00Z' } } }
    await runIngestion(
      store,
      { sources: ['open_meteo_archive'] },
      { connectors: { open_meteo_archive: watermarkConnector(first, next) } },
    )

    assert.deepEqual(first[0], {}, 'the first run has nothing stored to resume from')
    const stored = await store.read()
    assert.equal(stored.watermark_state.length, 1)
    assert.deepEqual(stored.watermark_state[0].state, next)

    const second = []
    await runIngestion(
      store,
      { sources: ['open_meteo_archive'] },
      { connectors: { open_meteo_archive: watermarkConnector(second, next) } },
    )
    assert.deepEqual(second[0], next, 'the second run resumes from the stored position')
  })

  it('keeps a source\'s position when a run does not report one', async () => {
    const store = scratchStore()
    await store.write({})

    const seeded = { sources: { open_meteo_archive: { last_success_at: '2026-01-01T00:00:00Z' } } }
    await store.merge({ watermark_state: [{ id: 'watermark_open_meteo_archive', source: 'open_meteo_archive', state: seeded }] })

    // A connector that has not been wired up returns no state at all.
    const silent = { id: 'open_meteo_archive', async ingest() { return { climate_observations: [], errors: [] } } }
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: silent } })

    const after = await store.read()
    assert.equal(after.watermark_state.length, 1, 'the row is not cleared')
    assert.deepEqual(
      after.watermark_state[0].state,
      seeded,
      'an unwired connector keeps the position it had rather than resetting it',
    )
  })

  it('does not share one source\'s position with another', async () => {
    const store = scratchStore()
    await store.write({})
    // Real source ids: runIngestion validates against SOURCE_IDS, and a fake one
    // fails the run before the watermark is ever handed over.
    const A = 'open_meteo_archive'
    const B = 'gdacs_archive'
    await store.merge({
      watermark_state: [
        { id: `watermark_${A}`, source: A, state: { sources: { [A]: { last_success_at: '2026-01-01T00:00:00Z' } } } },
        { id: `watermark_${B}`, source: B, state: { sources: { [B]: { last_success_at: '2026-02-02T00:00:00Z' } } } },
      ],
    })

    const received = []
    const conn = (id) => ({ id, async ingest(o) { received.push([id, o.watermark_state]); return { hazard_events: [], errors: [] } } })
    await runIngestion(store, { sources: [A, B] }, { connectors: { [A]: conn(A), [B]: conn(B) } })

    assert.deepEqual(received[0][1], { sources: { [A]: { last_success_at: '2026-01-01T00:00:00Z' } } })
    assert.deepEqual(received[1][1], { sources: { [B]: { last_success_at: '2026-02-02T00:00:00Z' } } })
  })

  it('declares the collection, so its rows are not dropped on write', async () => {
    const store = scratchStore()
    await store.merge({ watermark_state: [{ id: 'watermark_x', source: 'x', state: {} }] })
    const data = await store.read()
    assert.equal(data.watermark_state.length, 1,
      'an undeclared collection is dropped silently — the bug this declaration exists to prevent')
  })
})

/**
 * A caught-up run is not a failed one.
 *
 * `fetchWindow` returns `mode: 'empty'` with `reason: 'caught-up'` when the
 * watermark already covers today. The connector then makes no request at all —
 * which is the point of the watermark — and returns an empty batch with no
 * errors. `runIngestion` read only `watermark_state`, never `watermark`, so it
 * saw "0 records from a source with a floor of 1" and wrote a fabricated
 * shortfall, then ran the count assertion against the trailing median and
 * tripped it too. `freshness` treats a tripped assertion as `broken`, so every
 * run after a backfill finishes reported a fully up-to-date source as down.
 *
 * The distinction the connector already states and the pipeline has to keep:
 *
 *   - `mode: 'empty'`, `reason: 'caught-up'` — we did not ask, because there
 *     was nothing to ask for. Nothing to measure, nothing to assert.
 *   - anything else that returns 0 — we asked and got nothing, which is the
 *     collapse the floor and the count assertion exist to catch.
 */
describe('a watermark-caught-up run is not a degraded one', () => {
  const caughtUp = (state) => ({
    id: 'open_meteo_archive',
    async ingest() {
      return {
        climate_observations: [],
        errors: [],
        watermark_state: state,
        watermark: { source: 'open_meteo_archive', mode: 'empty', reason: 'caught-up', windows: 0, chunks: 0 },
      }
    },
  })

  /** A first run that delivers, so the trailing median is a real number. */
  const delivering = (count) => ({
    id: 'open_meteo_archive',
    async ingest() {
      return {
        climate_observations: Array.from({ length: count }, (_, i) => ({
          id: `obs-${i}`,
          region_name: 'Turkana',
          observed_at: '2026-10-01T00:00:00.000Z',
          series_start: '1981-01-01',
          series_end: '2026-10-01',
          series_days: 30,
          daily: [],
        })),
        errors: [],
      }
    },
  })

  it('records the run as a success rather than inventing a shortfall', async () => {
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: delivering(5) } })
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: caughtUp({ sources: {} }) } })

    const run = (await store.read()).source_runs[0]
    assert.equal(run.status, 'success',
      `a run that made no request because there was nothing to fetch was recorded "${run.status}"`)
    assert.deepEqual(run.errors, [],
      `a caught-up run invented an error: ${JSON.stringify(run.errors)}`)
    assert.equal(run.assertions_failed, 0,
      'a count assertion was judged against an empty batch the connector never fetched')
  })

  it('is not reported broken by the freshness verdict', async () => {
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: delivering(5) } })
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: caughtUp({ sources: {} }) } })

    const status = ingestionStatus(await store.read()).find((s) => s.source === 'open_meteo_archive')
    assert.notEqual(status.verdict.verdict, 'broken',
      `a caught-up source reads as down: ${status.verdict.reason}`)
    assert.equal(status.verdict.verdict, 'quiet', 'the honest word is "nothing was due"')
    assert.match(status.verdict.reason, /caught up|nothing (new|was due)/u)
  })

  it('stays quiet across repeated caught-up runs instead of becoming empty_response', async () => {
    // `empty_response` means "the source answers and has had nothing for us".
    // A caught-up connector never asked, so that sentence is false here, and
    // two consecutive no-op runs must not accumulate into it.
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: delivering(5) } })
    for (let i = 0; i < 3; i += 1) {
      await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: caughtUp({ sources: {} }) } })
    }
    const status = ingestionStatus(await store.read()).find((s) => s.source === 'open_meteo_archive')
    assert.equal(status.verdict.verdict, 'quiet',
      `three caught-up runs read as "${status.verdict.verdict}": ${status.verdict.reason}`)
  })

  it('still degrades a run that fetched and got nothing', async () => {
    // The control. Without it, "records === 0 is fine" would satisfy every test
    // above and quietly delete the record floor for every source.
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: delivering(5) } })
    const fetchedNothing = {
      id: 'open_meteo_archive',
      async ingest() {
        return {
          climate_observations: [],
          errors: [],
          watermark_state: { sources: {} },
          watermark: { source: 'open_meteo_archive', mode: 'backfill', reason: 'no-watermark', windows: 0, chunks: 0 },
        }
      },
    }
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: fetchedNothing } })

    const run = (await store.read()).source_runs[0]
    assert.equal(run.status, 'degraded', 'a fetch that returned nothing is not a caught-up run')
    assert.match(JSON.stringify(run.errors), /Expected at least 1 records/u)
    assert.equal(run.assertions_failed, 1, 'the count assertion must still fire on a genuinely empty batch')
  })

  it('does not exempt a cursor that is ahead of the clock', async () => {
    // `cursor-ahead-of-now` is a broken watermark, not a finished backfill. It
    // is also `mode: 'empty'`, so a reason-blind exemption would hide exactly
    // the state an operator has to correct by hand.
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: delivering(5) } })
    const ahead = {
      id: 'open_meteo_archive',
      async ingest() {
        return {
          climate_observations: [],
          errors: [],
          watermark_state: { sources: {} },
          watermark: { source: 'open_meteo_archive', mode: 'empty', reason: 'cursor-ahead-of-now', windows: 0, chunks: 0 },
        }
      },
    }
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: ahead } })

    const run = (await store.read()).source_runs[0]
    assert.equal(run.status, 'degraded', 'a watermark ahead of the clock was reported as a healthy no-op')
  })
})

/**
 * SAE-27 — the archive's walk is resumable, not restarted.
 *
 * `gdacs_archive` is listed in `WATERMARK_SOURCES` and its connector read no
 * watermark at all: every run walked 1985 → now quarter by quarter, 168
 * requests to rediscover that nothing had changed. The list was the declaration
 * and the walk was the fact, and only one of them was checked.
 *
 * The cursor is quarter-granular because the walk is. A date cursor would put
 * the boundary mid-quarter and the next run would re-request a quarter it had
 * already read, which is the daily-id churn the watermark exists to stop, one
 * level up.
 */
describe('gdacs_archive resumes rather than restarting', () => {
  const archiveResponse = (count, from) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      features: Array.from({ length: count }, (_, i) => ({
        geometry: { coordinates: [35.0, 3.5] },
        properties: {
          eventtype: 'FL', iso3: 'KEN', eventid: `${from}-${i}`,
          eventname: `Flood ${i}`, alertlevel: 'Green',
          fromdate: '2026-01-02T00:00:00Z', todate: '2026-01-09T00:00:00Z',
          severitydata: { severity: 0.0, severitytext: 'Magnitude 0.00' },
        },
      })),
    }),
  })

  /** Every window answered with `count` floods; the calls are recorded. */
  function stubbedArchive(count) {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      const target = new URL(String(url))
      const from = target.searchParams.get('fromDate')
      calls.push(from)
      return archiveResponse(count, from)
    }
    return { calls, restore: () => { globalThis.fetch = original } }
  }

  const THIS_YEAR = new Date().getUTCFullYear()
  const connector = () => import('../src/connectors/gdacs-archive.js').then((m) => m.gdacsArchiveConnector)

  it('reports the quarters it read and the state to resume from', async () => {
    const stub = stubbedArchive(2)
    try {
      const { ingest } = await connector()
      const out = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0 })
      assert.ok(out.watermark_state, 'the connector returned no watermark state; nothing can resume')
      const entry = out.watermark_state.gdacs_archive
      assert.ok(entry, 'the state carries no entry for its own source')
      // Clamped to today, not to the current quarter's calendar end: the
      // quarter is open, and a cursor on 12-31 would claim days that have not
      // happened — which the next run reads as ahead-of-now and refuses.
      assert.equal(entry.last_cursor, new Date().toISOString().slice(0, 10),
        'the cursor did not land on the last day the walk could actually have covered')
      assert.ok(out.watermark, 'the connector reported no watermark block for the run to record')
      assert.equal(out.watermark.mode, 'backfill')
      // 2025 has four quarters and the current year has one per quarter so far.
      assert.equal(out.completeness.windows_planned, 4 + (Math.floor(new Date().getUTCMonth() / 3) + 1))
      assert.ok(stub.calls.length >= 4, `the first walk read only ${stub.calls.length} windows`)
    } finally { stub.restore() }
  })

  it('does not re-read a quarter the cursor already covers', async () => {
    // The whole point. Run two re-reads only the quarter still open — a
    // partial quarter gains events until it ends — and none of the finished
    // quarters behind it. That is 168 requests becoming 1.
    const stub = stubbedArchive(2)
    try {
      const { ingest } = await connector()
      const first = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0 })
      const firstCalls = [...stub.calls]
      stub.calls.length = 0

      const second = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0, watermark_state: first.watermark_state })
      const q = Math.floor(new Date().getUTCMonth() / 3) + 1
      const openQuarter = `${THIS_YEAR}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`
      assert.deepEqual(stub.calls, [openQuarter],
        `the second run re-requested ${stub.calls.length} window(s) instead of only the one still open`)
      assert.ok(firstCalls.includes(openQuarter))
      assert.ok(second.watermark_state, 'the resumed run returned no state')
    } finally { stub.restore() }
  })

  it('re-reads only the quarter still open, not the archive behind it', async () => {
    // The current quarter is partial and gains events until it ends, so it is
    // read again — one request. Everything behind it is finished and is not.
    // That is the whole saving: 168 requests become 1.
    const stub = stubbedArchive(2)
    try {
      const { ingest } = await connector()
      const first = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0 })
      assert.ok(stub.calls.length > 1, 'the first walk read only one window; nothing to save')
      stub.calls.length = 0
      const second = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0, watermark_state: first.watermark_state })
      assert.equal(stub.calls.length, 1,
        `a caught-up archive made ${stub.calls.length} request(s) instead of re-reading the open quarter`)
      const q = Math.floor(new Date().getUTCMonth() / 3) + 1
      assert.equal(stub.calls[0], `${THIS_YEAR}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`,
        'the one request was not for the quarter still open')
      assert.equal(second.watermark.mode, 'backfill')
      assert.deepEqual(second.errors, [], 'a resumed archive reported an error')
    } finally { stub.restore() }
  })

  it('refuses to walk when the cursor is past the current quarter', async () => {
    // Ahead of the clock is a bad write or a copied state, and it must be said
    // rather than skipped: a cursor past now silently ends the walk forever,
    // and nothing else would report it. Deliberately *not* exempted from the
    // record floor by `runIngestion` — the same reason `fetchWindow` does not
    // call this case `caught-up`.
    const stub = stubbedArchive(2)
    try {
      const { ingest } = await connector()
      const ahead = { gdacs_archive: { last_cursor: `${THIS_YEAR + 1}-12-31` } }
      const out = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0, watermark_state: ahead })
      assert.equal(stub.calls.length, 0, 'a cursor ahead of the clock was walked anyway')
      assert.equal(out.watermark.mode, 'empty')
      assert.equal(out.watermark.reason, 'cursor-ahead-of-now')
      assert.ok(out.errors.some((e) => /past the current quarter/.test(e)),
        `the run did not say why it stopped: ${JSON.stringify(out.errors)}`)
    } finally { stub.restore() }
  })

  it('does not move the cursor past a quarter that failed to read', async () => {
    // The control that matters most. A cursor that advances over an unread
    // window is worse than no cursor: that quarter is never requested again and
    // nothing reports the hole.
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (url) => {
      calls += 1
      const target = new URL(String(url))
      const from = target.searchParams.get('fromDate')
      if (calls === 2) return { ok: false, status: 503, text: async () => '' }
      return archiveResponse(2, from)
    }
    try {
      const { ingest } = await connector()
      const out = await ingest({ archive_start_year: THIS_YEAR - 1, retries: 0 })
      const entry = out.watermark_state.gdacs_archive
      // Quarter 1 read clean, quarter 2 failed. The cursor must sit at the end
      // of Q1, not at the end of Q2.
      assert.equal(entry.last_cursor, `${THIS_YEAR - 1}-03-31`,
        `the cursor advanced to ${entry.last_cursor} across a window that was never read`)
    } finally { globalThis.fetch = original }
  })

  it('is not reported as a collapse when it resumes', async () => {
    // The interaction that made the cursor worth less than it looked. A
    // resumed walk reads one quarter where the run before it read eight, so its
    // batch is a fraction of the trailing median — and `min_count_vs_trailing`
    // read that as the feed collapsing, quarantined a perfectly good batch and
    // marked the run degraded. Every run after the first backfill would have
    // reported the archive as broken.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lindela-gdacs-scope-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.write({})
    const stub = stubbedArchive(2)
    try {
      const request = { sources: ['gdacs_archive'], archive_start_year: THIS_YEAR - 1, retries: 0 }
      await runIngestion(store, request, {})
      const first = (await store.read()).source_runs[0]
      assert.equal(first.status, 'success', `the full walk failed: ${JSON.stringify(first.errors)}`)
      assert.equal(first.watermark.reason, 'full-walk',
        'a first walk that skipped nothing called itself a resume')

      await runIngestion(store, request, {})
      const second = (await store.read()).source_runs[0]
      assert.equal(second.watermark.reason, 'resumed-walk')
      assert.ok(second.records_processed < first.records_processed,
        'the resumed run read as many records as the full walk; the fixture proves nothing')
      assert.equal(second.status, 'success',
        `a resumed walk was recorded "${second.status}": ${JSON.stringify(second.errors)}`)
      assert.equal(second.assertions_failed, 0,
        'the count assertion judged a one-quarter batch against a whole-archive baseline')
    } finally { stub.restore() }
  })
})

/**
 * A connector that reports no window count says "my batch size is not a
 * function of scope", and that has to survive the round trip.
 *
 * `windows` is the ground a count assertion compares over: two batches are
 * comparable only if they were taken over the same number of windows.
 * `Number.isFinite(Number(null))` is `true` — `Number(null)` is 0 — so a
 * connector that reported `windows: null` was recorded as having covered
 * *zero* windows, which is a scope rather than an absence. `scopeTrailing` then
 * compared that run against a resumed walk's one window, found them different,
 * and dropped the run from the baseline: the recorded history emptied, and the
 * assertion fell back to "no trailing window to judge against".
 */
describe('a connector that does not page records no window count', () => {
  const nonPaging = (windows) => ({
    id: 'open_meteo_archive',
    async ingest() {
      return {
        // The full record shape, so no field-coverage assertion fires. A failed
        // assertion rebuilds `output` from the output collections alone and
        // drops `watermark` with it, which would make this test measure the
        // quarantine path rather than the window count.
        climate_observations: [{
          id: 'obs-1',
          region_name: 'Turkana',
          observed_at: '2026-10-01T00:00:00.000Z',
          series_start: '1981-01-01',
          series_end: '2026-10-01',
          series_days: 30,
          daily: [],
        }],
        errors: [],
        watermark: { source: 'open_meteo_archive', mode: 'backfill', reason: 'no-watermark', windows },
      }
    },
  })

  it('stores null rather than zero when the connector reports null', async () => {
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: nonPaging(null) } })
    const run = (await store.read()).source_runs[0]
    assert.equal(run.watermark.windows, null,
      'a connector that does not page covered no scope, which is not the same as covering zero windows')
  })

  it('still stores a real count, and a real zero', async () => {
    // The control, both ways. A null-coalescing fix (`windows || null`) would
    // turn a genuine zero-window run — a walk that found nothing due — into an
    // absent one, and a `?? 0` would undo the fix entirely.
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: nonPaging(1) } })
    const first = (await store.read()).source_runs[0]
    assert.equal(first.watermark.windows, 1, 'a one-window walk records one window')

    const second = scratchStore()
    await runIngestion(second, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: nonPaging(0) } })
    const zero = (await second.read()).source_runs[0]
    assert.equal(zero.watermark.windows, 0, 'a zero-window walk is a measurement and must survive as zero')
  })

  it('stores null when the connector states no window field at all', async () => {
    const store = scratchStore()
    await runIngestion(store, { sources: ['open_meteo_archive'] }, { connectors: { open_meteo_archive: nonPaging(undefined) } })
    const run = (await store.read()).source_runs[0]
    assert.equal(run.watermark.windows, null, 'an omitted field is an absence, not a zero-window walk')
  })
})

/**
 * The reader end of `windows`, and the reason it had to change with the writer.
 *
 * `runSourceAssertions` read the connector's own window count with
 * `Number(output?.watermark?.windows)` behind an `isFinite` test. `Number(null)`
 * is 0, so a connector that reports `windows: null` — the ordinary way of saying
 * "I did not page" — was scoped as a *zero-window* walk. The run record stores
 * `null` for that now, so this reader was the last place turning the absence
 * back into a zero.
 *
 * The consequence is not cosmetic. `scopeTrailing` keeps a trailing run whose
 * scope is absent and drops one whose scope differs. A zero-window scope
 * therefore filtered out the full-walk history, the baseline became null, and
 * the count assertion reported itself unmeasured — the collapse detector
 * silently off. With the coercion in place this fixture's 2-of-40 collapse
 * comes back `success`.
 *
 * The fixture needs a *paging* source: `scope: 'windows'` is declared only on
 * `gdacs_archive`'s count assertion, so a non-paging connector never reaches the
 * scoped path and cannot tell the two spellings apart. That is what the first
 * version of this test got wrong — it passed under both, which is a test that
 * measured nothing.
 */
describe('a run that reports no window count is scoped as absent, not as zero windows', () => {
  const event = (i) => ({
    id: `ev-${i}`,
    event_type: 'FL',
    country: 'KEN',
    latitude: 1,
    longitude: 35,
    severity: 0.5,
    occurred_at: '2026-10-01T00:00:00.000Z',
    source: 'gdacs_archive',
    source_id: `g-${i}`,
  })
  const paging = (count, windows) => ({
    id: 'gdacs_archive',
    async ingest() {
      return {
        hazard_events: Array.from({ length: count }, (_, i) => event(i)),
        errors: [],
        watermark: { windows },
      }
    },
  })

  it('reports a collapse against full walks even when this run states no window count', async () => {
    const store = scratchStore()
    // Three full walks of 40 events over 8 windows each.
    for (let i = 0; i < 3; i += 1) {
      await runIngestion(store, { sources: ['gdacs_archive'] }, { connectors: { gdacs_archive: paging(40, 8) } })
    }
    // Then a run that reports `windows: null` and returns 2 events.
    await runIngestion(store, { sources: ['gdacs_archive'] }, { connectors: { gdacs_archive: paging(2, null) } })

    const run = (await store.read()).source_runs[0]
    assert.equal(run.assertions_failed, 1,
      `a 2-of-40 collapse reported no failure: ${JSON.stringify(run.errors)}`)
    const message = run.errors.join(' ')
    assert.match(message, /trailing median of 40/,
      `the baseline was not the full-walk history: ${message}`)
    assert.match(message, /3 prior run\(s\)/,
      `the full walks were filtered out of the comparison: ${message}`)
  })

  it('still treats a stated zero as a real scope, distinct from an absent one', async () => {
    // The control. `windows: 0` is a measurement — a walk that found nothing due
    // — and must still be filtered against a one-window run. A null-coalescing
    // fix (`?? 0`) would erase the distinction in the other direction.
    const store = scratchStore()
    await runIngestion(store, { sources: ['gdacs_archive'] }, { connectors: { gdacs_archive: paging(40, 8) } })
    await runIngestion(store, { sources: ['gdacs_archive'] }, { connectors: { gdacs_archive: paging(2, 0) } })

    const run = (await store.read()).source_runs[0]
    const stored = (await store.read()).source_runs
    // The zero-window run is a different scope, so the 8-window history is
    // filtered out and the assertion has nothing to compare against.
    assert.equal(run.assertions_failed, 0,
      `a zero-window run was judged against an eight-window baseline: ${JSON.stringify(run.errors)}`)
    assert.ok(stored.length >= 2, 'both runs were recorded')
  })
})
