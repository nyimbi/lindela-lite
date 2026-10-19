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
