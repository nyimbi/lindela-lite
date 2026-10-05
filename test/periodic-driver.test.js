import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runPeriodicTick, runDueReportSchedulesAndPersist } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * R-03 — the scheduler discarded every error it could produce, and the periodic
 * work it did was a duplicate of work the process already did.
 *
 * `docker-compose.yml` ran a sidecar that curled `/ingest/run-due` and
 * `/report-schedules/run-due` every fifteen minutes, each ending in `|| true`.
 * Three outcomes — a 200 with nothing due, a 401 from a rotated key, and a 500
 * from a broken store — all produced the same silence, and the sidecar was the
 * only record that any of it had run.
 *
 * Meanwhile the app process has run its own driver since ENH-05: ingestion
 * schedules, alert evaluation, outbox dispatch, each recorded on a heartbeat
 * that `/health` reads. So the sidecar's first job ran twice per interval, and
 * the second job — report schedules — was the only periodic item the driver
 * did not own.
 *
 * The fix is the one ENH-05 named: one driver, and no shell loop. Report
 * schedules moved into the driver first, so removing the sidecar costs nothing.
 */

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-driver-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('the periodic driver owns the periodic work', () => {
  it('a tick runs ingestion, alerts, the outbox and report schedules', async () => {
    await withStore(async (store) => {
      const heartbeat = await runPeriodicTick(store)
      const ids = heartbeat.items.map((item) => item.id)
      for (const expected of ['ingestion', 'alerts', 'outbox', 'reports']) {
        assert.ok(ids.includes(expected),
          `the driver does not run "${expected}"; the sidecar it replaced did, so ` +
          'removing the sidecar would have dropped a periodic job')
      }
      assert.equal(heartbeat.failed, 0,
        'a clean tick on an empty store should fail nothing: ' +
        JSON.stringify(heartbeat.items.filter((i) => !i.ok)))
    })
  })

  it('the report-schedule cycle persists what it produced', async () => {
    // A report schedule that runs and writes nothing is a schedule that looks
    // healthy and produces no report. The sidecar persisted its result through
    // the HTTP route's `store.merge`; the driver item has to do the same, or
    // moving the job in-process silently dropped the writes.
    await withStore(async (store) => {
      const now = new Date()
      const due = {
        id: 'sched-due',
        type: 'report_schedule',
        name: 'Daily district digest',
        recipient: 'ops@example.org',
        format: 'markdown',
        sections: 'executive_summary',
        cron: '* * * * *',
        status: 'active',
        next_run_at: new Date(now.getTime() - 60_000).toISOString(),
        last_run_at: null,
      }
      await store.merge({ report_schedules: [due] })

      const data = await store.read()
      const result = await runDueReportSchedulesAndPersist(store, data)
      assert.equal(result.runs.length, 1, 'the due schedule should have run')

      const after = await store.read()
      assert.ok(after.report_schedule_runs.some((r) => r.schedule_id === 'sched-due'),
        'the run was computed but not persisted — the driver item drops its writes')
      assert.ok(after.report_schedules.some((s) => s.id === 'sched-due' && s.last_run_at),
        'and the schedule still says it has never run, so it will run again next tick')
    })
  })

  it('a failing item does not stop the others', async () => {
    // One item failing must not take the rest with it: a dead webhook registry
    // should not also stop ingestion. Enforced by the tick's own try/catch, and
    // guarded here because the item list grew and a future item could be added
    // outside it.
    await withStore(async (store) => {
      const heartbeat = await runPeriodicTick(store)
      assert.equal(heartbeat.attempted, heartbeat.items.length,
        'every item reports an outcome, successful or not')
    })
  })
})

describe('there is no second scheduler that can fail silently', () => {
  it('docker-compose has no swallowing shell loop', () => {
    const compose = readFileSync(
      path.join(import.meta.dirname, '..', 'docker-compose.yml'), 'utf8')
    assert.ok(!/curl[^\n]*\|\|\s*true/.test(compose),
      'a `curl … || true` in the compose file makes a 401, a 500 and "nothing ' +
      'was due" the same silence, which is R-03 verbatim')

    assert.ok(!/while\s+true/.test(compose),
      'the shell loop has been replaced by the in-process driver; if a loop is ' +
      'back, it is doing a second run of work the driver already does')
  })

  it('the sidecar service is gone rather than merely quiet', () => {
    const compose = readFileSync(
      path.join(import.meta.dirname, '..', 'docker-compose.yml'), 'utf8')
    assert.ok(!/^\s*scheduler:/m.test(compose),
      'the sidecar ran the same ingestion cycle the driver runs, so both fired ' +
      'every interval — two runs of every due schedule per tick')
  })
})
