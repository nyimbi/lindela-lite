import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { computeNextIngestionRunAt, scheduleSlip, ingestionStatus } from '../src/ingestion.js'

/**
 * R-53 — the schedule drifted and the status route said `ok`.
 *
 * `computeNextIngestionRunAt` anchored on `completed_at`, so "every 30 minutes"
 * meant "thirty minutes after the last run finished". A source that reliably
 * took fifty minutes slipped fifty minutes every cycle, indefinitely, and the
 * only symptom anywhere was data that was quietly older than the interval
 * claimed. `ingestionStatus` reported `ok` the whole time, because every run
 * did succeed — the lateness was in the schedule, not the run.
 *
 * Two properties, and the second is the one that matters operationally:
 * the anchor stops drifting, and the drift becomes *visible* on the route an
 * operator opens when a source looks wrong.
 */

// One clock read for the whole file. Each `at()` was reading `Date.now()` at
// call time, so two calls a millisecond apart produced two bases and every
// equality assertion against an ISO string was a coin flip.
const T0 = Date.now()
const at = (minutesFromNow) => new Date(T0 + minutesFromNow * 60 * 1000).toISOString()

describe('R-53 — the next run is a fixed rate, not a function of how long the last one took', () => {
  it('anchors on the due time, not on when the run finished', () => {
    // A run that finished at +50 on a 30-minute schedule is due next at +30 —
    // which is in the past by the time it finishes, so the answer is "now". What
    // must never happen is +80: that is the run's duration added to the
    // interval, which is the drift, and it repeats every cycle.
    const schedule = { interval_minutes: 30, next_run_at: at(0) }
    const next = computeNextIngestionRunAt(schedule, at(50), { now: at(50) })
    assert.equal(next, at(50),
      'due at +30, already past when the run finished at +50: due now. Anchoring on ' +
      'completion gives +80, and then +130, and the schedule never catches up.')

    // The arithmetic itself, with the clock before the run started: exactly one
    // interval on from when it was due.
    const ahead = computeNextIngestionRunAt(schedule, at(-1), { now: at(-1) })
    assert.equal(ahead, at(30), 'a schedule is due again one interval after it was due')
  })

  it('does not accumulate drift over successive slow runs', () => {
    // The property, as a series: 30-minute interval, each run taking 50 minutes.
    // Anchored on due time the schedule stays on its cadence forever.
    let due = at(0)
    const cadence = []
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const startedAt = new Date(new Date(due).getTime() + 50 * 60 * 1000).toISOString()
      const next = computeNextIngestionRunAt(
        { interval_minutes: 30, next_run_at: due }, startedAt, { now: startedAt },
      )
      cadence.push(new Date(next).getTime() - new Date(startedAt).getTime())
      due = next
    }
    // Each cycle the next run is due immediately (the due time has passed), so
    // the gap is zero and the schedule is permanently caught up rather than
    // permanently behind. What must not happen is the gap growing by 50 minutes
    // per cycle, which is what anchoring on completion produces.
    const drifting = cadence.some((gapMs) => gapMs > 5 * 60 * 1000)
    assert.equal(drifting, false,
      `gaps between a slow run finishing and the next one due: ${cadence.map((g) => Math.round(g / 60000)).join(', ')} minutes. ` +
      'Each one is the run duration being added to the interval, once per cycle.')
  })

  it('a run that is long overdue is due now, not in the past', () => {
    // The guard against the opposite failure: fixed-rate scheduling that
    // catches up by firing a missed hour of runs in a burst.
    const overdue = at(-120)
    const next = computeNextIngestionRunAt({ interval_minutes: 30, next_run_at: overdue }, at(0), { now: at(0) })
    assert.equal(next, at(0), 'the process was down for two hours; the next run is immediately, not two hours ago')
  })

  it('a schedule edited to a longer interval does not rewind', () => {
    const due = at(120)
    const next = computeNextIngestionRunAt({ interval_minutes: 30, next_run_at: due }, at(0), { now: at(0) })
    assert.equal(new Date(next).getTime() > new Date(at(120)).getTime(), true,
      'a future due time is a better anchor than completion, or an early run rewinds the clock')
  })
})

describe('R-53 — a slipping schedule is visible', () => {
  it('one interval of lateness is a slip; a run on time is not', () => {
    const onTime = scheduleSlip({ dueAt: at(0), startedAt: at(1), intervalMinutes: 30 })
    assert.equal(onTime.slip_ms, 60 * 1000)
    assert.equal(onTime.slipping, false, 'a minute late on a 30-minute schedule is not a problem')

    const late = scheduleSlip({ dueAt: at(0), startedAt: at(45), intervalMinutes: 30 })
    assert.equal(late.slip_ms, 45 * 60 * 1000)
    assert.equal(late.slipping, true, '45 minutes late on a 30-minute schedule means the source cannot keep its cadence')
  })

  it('the threshold scales with the interval, not a fixed duration', () => {
    // A 12-hour schedule is allowed an hour of lateness and a 30-minute schedule
    // is allowed a minute. One number for both would be wrong in one direction
    // for every source but one.
    const hourly = scheduleSlip({ dueAt: at(0), startedAt: at(70), intervalMinutes: 60 })
    assert.equal(hourly.slipping, true)
    const daily = scheduleSlip({ dueAt: at(0), startedAt: at(70), intervalMinutes: 720 })
    assert.equal(daily.slipping, false, 'an hour late on a twelve-hour schedule is normal')
  })

  it('a schedule with no due time says so rather than reporting zero slip', () => {
    const unknown = scheduleSlip({ dueAt: null, startedAt: at(0), intervalMinutes: 30 })
    assert.equal(unknown.slip_ms, null, 'zero would read as "on time"')
    assert.match(unknown.reason, /no due time/)
  })

  it('the status route carries the slip, so "ok" cannot mean "drifting"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r53-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    // A schedule whose last run started 45 minutes into a 30-minute interval:
    // the shape the old code produced every cycle and reported as healthy.
    await store.merge({
      ingestion_schedules: [{
        id: 'sched-slip',
        type: 'ingestion_schedule',
        source: 'gdacs',
        status: 'active',
        interval_minutes: 30,
        last_run_at: at(-1),
        last_slip_at: at(-1),
        last_slip_ms: 45 * 60 * 1000,
        next_run_at: at(29),
      }],
    })
    try {
      const data = await store.read()
      // `ingestionStatus` is a bare array of per-source objects, not an
      // envelope — the route wraps it.
      const status = ingestionStatus(data)
      assert.ok(Array.isArray(status), 'ingestionStatus returns the per-source array itself')
      const gdacs = status.find((s) => s.source === 'gdacs')
      assert.ok(gdacs.cadence, 'the status route does not describe the schedule cadence at all')
      assert.equal(gdacs.cadence.last_slip_ms, 45 * 60 * 1000)
      assert.equal(gdacs.cadence.slipping, true,
        'a 30-minute schedule that ran 45 minutes late must not read as on-cadence')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
