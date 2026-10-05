import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { describeWatermarkState, advanceWatermark, readWatermark } from '../src/watermarks.js'

/**
 * R-52 — a backfill that died three weeks ago was fully recoverable from the
 * store and completely invisible.
 *
 * Every source's high-water mark is written on every successful run. There was no
 * route, no page and no export for it, so the only way to find out where an
 * ingest had stopped was to open the JSON file and read it. The state that makes
 * a dead backfill resumable is the same state nobody can look at.
 *
 * The projection answers the question an operator actually has — how far did each
 * source get, and is that current — and two details carry the weight:
 *
 *   - a source that has never completed a run reports `covered_through: null`,
 *     not today and not zero. Zero reads as "caught up to the epoch", which is a
 *     different and wrong claim.
 *   - staleness is judged against *that source's* cadence, at two intervals. One
 *     global threshold is wrong for an hourly source and for a weekly one, and
 *     the first version of this reported `stale: false` for a daily source
 *     fifteen days behind — the exact dead pipeline it was written to reveal.
 */

const NOW = new Date('2026-10-05T12:00:00Z')

const withWatermarks = (state) => {
  let out = {}
  for (const [source, opts] of Object.entries(state)) out = advanceWatermark(out, source, opts)
  return out
}

describe('the watermark projection says where each source got to', () => {
  it('a completed source reports the day it covered and how old that is', () => {
    const state = withWatermarks({
      gdacs: { recordDate: '2026-10-05', at: '2026-10-05T01:00:00Z' },
    })
    const row = describeWatermarkState(state, { now: NOW }).sources[0]
    assert.equal(row.source, 'gdacs')
    assert.equal(row.covered_through, '2026-10-05')
    assert.equal(row.age_days, 0)
    assert.equal(row.stale, false, 'a source that ran this morning is not stale')
  })

  it('a source that has never completed reports nothing rather than today', () => {
    const state = withWatermarks({ fresh: { recordDate: null, at: null } })
    const row = describeWatermarkState(state, { now: NOW }).sources[0]
    assert.equal(row.covered_through, null,
      'today would read as "caught up as of today" on the one source it is not')
    assert.equal(row.age_days, null)
    assert.equal(row.stale, true)
  })

  it('staleness follows the source cadence, not one global number', () => {
    // The failure this exists to prevent: a fifteen-day-old *daily* source reads
    // as current under a threshold tuned for an hourly one.
    const state = withWatermarks({
      chirps: { recordDate: '2026-09-20', at: '2026-09-20T06:00:00Z' },
      gdacs: { recordDate: '2026-10-05', at: '2026-10-05T01:00:00Z' },
    })
    const rows = Object.fromEntries(describeWatermarkState(state, { now: NOW }).sources.map((r) => [r.source, r]))
    assert.equal(rows.chirps.age_days, 15)
    assert.equal(rows.chirps.stale, true,
      'a daily source fifteen days behind is a stopped pipeline, and a global ' +
      'threshold would call it current')
    assert.equal(rows.gdacs.stale, false, 'an hourly source that ran today is fine')

    // Same age, two cadences, opposite verdicts. Two days is exactly two
    // intervals for a daily source and forty-eight for an hourly one.
    //
    // (My first version of this assertion used `chirps` for the "daily" case and
    // a ten-day gap for "inside two intervals". Its declared cadence is 720
    // minutes — twelve hours — and ten days is ten intervals on any daily
    // source. Both halves were wrong and the assertion still read as reasonable,
    // which is the argument for running the numbers rather than eyeballing them.)
    const both = withWatermarks({
      who_gho: { recordDate: '2026-10-03', at: '2026-10-03T06:00:00Z' },
      gdacs: { recordDate: '2026-10-03', at: '2026-10-03T06:00:00Z' },
    })
    const pair = Object.fromEntries(describeWatermarkState(both, { now: NOW }).sources.map((r) => [r.source, r]))
    assert.equal(pair.who_gho.age_days, 2)
    assert.equal(pair.who_gho.stale, false, 'two days on a daily schedule is two intervals, not more')
    assert.equal(pair.gdacs.stale, true, 'two days on an hourly schedule is forty-eight intervals')
    assert.equal(pair.who_gho.age_days, pair.gdacs.age_days,
      'same age, and the two rows say different things about it — that is the cadence rule working')
  })

  it('counts what is known and names what is not', () => {
    const state = withWatermarks({
      gdacs: { recordDate: '2026-10-05', at: '2026-10-05T01:00:00Z' },
      never_ran: { recordDate: null, at: null },
    })
    const view = describeWatermarkState(state, { now: NOW })
    assert.equal(view.with_watermark, 1)
    assert.deepEqual(view.never_completed, ['never_ran'])
  })

  it('an empty store is an empty projection, not an error', () => {
    const view = describeWatermarkState({}, { now: NOW })
    assert.deepEqual(view.sources, [])
    assert.equal(view.with_watermark, 0)
  })
})

describe('and it is readable without opening the store file', () => {
  it('GET /api/v1/watermarks answers it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r52-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({
      watermark_state: [{
        id: 'watermark_gdacs',
        type: 'watermark_state',
        source: 'gdacs',
        state: { last_record_date: '2026-10-04', last_cursor: '2026-10-04', last_success_at: '2026-10-04T06:00:00Z' },
      }],
    })
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/watermarks`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      const row = body.data.sources.find((r) => r.source === 'gdacs')
      assert.equal(row.covered_through, '2026-10-04')
      assert.ok(row.interval_minutes, 'the cadence it was judged against travels with the verdict')
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('the route is documented, because a route nobody can find is not a route', () => {
    const spec = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')
    assert.match(spec, /\/api\/v1\/watermarks:/)
    assert.match(spec, /security: \[\{ apiKey: \[\] \}\]/)
  })

  it('the state is still what ingestion reads — the route observes, it does not own', () => {
    // The projection is a read of the same state the connectors advance. A route
    // that computed its own numbers would be a second answer to "where did this
    // source get to".
    const state = withWatermarks({ gdacs: { recordDate: '2026-10-05', at: '2026-10-05T01:00:00Z' } })
    assert.equal(readWatermark(state, 'gdacs').last_record_date, '2026-10-05')
    assert.equal(describeWatermarkState(state, { now: NOW }).sources[0].covered_through, '2026-10-05')
  })
})
