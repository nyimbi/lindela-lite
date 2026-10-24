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
 * Meanwhile the app process has run its own driver since SAE-05: ingestion
 * schedules, alert evaluation, outbox dispatch, each recorded on a heartbeat
 * that `/health` reads. So the sidecar's first job ran twice per interval, and
 * the second job — report schedules — was the only periodic item the driver
 * did not own.
 *
 * The fix is the one SAE-05 named: one driver, and no shell loop. Report
 * schedules moved into the driver first, so removing the sidecar costs nothing.
 */

const DAY = 24 * 60 * 60 * 1000
const feedback = (id, ageDays) => ({
  id,
  type: 'community_feedback',
  reporter_urn_hash: 'sha256:abc',
  message: 'the borehole at Kilima has been dry',
  created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
})

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

describe('SCL-02 a tick reads the store once, not once per item', () => {
  /**
   * A store that counts how many times its whole table was materialised.
   *
   * The defect is invisible from outside: a tick that reads seven times returns
   * exactly what a tick that reads once returns, and the only evidence is the
   * cost. So the seam is the read itself — a full read is one with no manifest,
   * which is the shape every item used to call.
   */
  class CountingStore extends JsonStore {
    fullReads = 0
    manifestReads = 0
    // `JsonStore.merge` reads the whole file for itself, so a counter that did
    // not exclude the reads inside a mutation would measure the JSON store's
    // merge implementation rather than the tick. A read that happens while a
    // mutation is in flight is part of that mutation.
    #mutating = false

    async read(options) {
      if (!this.#mutating) {
        const manifest = Array.isArray(options) ? options : (options?.collections ?? null)
        if (manifest === null) this.fullReads += 1
        else this.manifestReads += 1
      }
      return super.read(options)
    }

    async #mutate(fn) {
      this.#mutating = true
      try {
        return await fn()
      } finally {
        this.#mutating = false
      }
    }

    merge(partial) { return this.#mutate(() => super.merge(partial)) }
    remove(doomed) { return this.#mutate(() => super.remove(doomed)) }
    write(data) { return this.#mutate(() => super.write(data)) }
  }

  it('materialises the whole store once for a tick of seven items', async () => {
    await withStore(async (store) => {
      await store.merge({ community_feedback: [feedback('one', 0)] })
      const counting = new CountingStore(store.filePath)
      await runPeriodicTick(counting)
      assert.equal(counting.fullReads, 1,
        `a tick of ${7} items materialised the whole store ${counting.fullReads} times`)
    })
  })

  it('still shows an item what the item before it wrote', async () => {
    // The reason this is a refreshed snapshot rather than one frozen object:
    // ingestion writes `source_runs`, and the reconcile item reads them. A tick
    // that handed every item the same object would answer from state that
    // predates its own writes, which is the failure the per-item read was there
    // to avoid.
    await withStore(async (store) => {
      await store.merge({ community_feedback: [feedback('ancient', 900)] })
      const heartbeat = await runPeriodicTick(store)
      const retention = heartbeat.items.find((item) => item.id === 'retention')
      assert.equal(retention.summary.expired, 1)
      const after = await store.read()
      assert.equal(after.community_feedback.length, 0,
        'the retention item reported an expiry the store never saw')
    })
  })
})

describe('the outbox item delivers, and the heartbeat says what it did', () => {
  /**
   * The driver's outbox item called `dispatchPending(store)` with no options.
   * `webhooks` defaults to `[]` there, so every due row matched no subscriber
   * and was rewritten `undeliverable: true` with "no active webhook is
   * subscribed to this event" — false whenever a subscriber existed. Nothing
   * was ever delivered by the periodic driver; only the HTTP route, which does
   * pass `webhooks`, could send.
   *
   * The second half is the summary. `dispatchPending` returns
   * `{ dispatched, failed, undeliverable, deferred }` and `summarise` read
   * `Number(value)`, which is `NaN` for an object — so `sent` read 0 on every
   * tick that sent anything.
   *
   * The assertion is the row's own delivery state, not the receiver's count:
   * the SSRF guard refuses a loopback URL, so a test that stood up a real
   * listener would be testing the guard. A subscriber that exists and a
   * delivery that fails is `deferred` with a retry floor — a subscriber that
   * was never seen at all is `undeliverable` with none. That difference is
   * exactly what the missing option produced, and it is readable from the row.
   */
  const due = (id) => ({
    id, event: 'incident.created', payload: { id },
    status: 'pending', attempts: 0, next_attempt_at: '2020-01-01T00:00:00.000Z',
  })

  it('sees the subscription the store holds, so a due event is attempted', async () => {
    await withStore(async (store) => {
      await store.merge({
        webhook_subscriptions: [{ id: 'wh-1', url: 'http://127.0.0.1:1/hook', status: 'active', events: ['incident.created'] }],
        events_outbox: [due('ob-1')],
      })
      await runPeriodicTick(store)
      const after = await store.read(['events_outbox'])
      const row = after.events_outbox[0]
      assert.equal(row.undeliverable, false,
        'the row says nobody is subscribed, and the store holds an active subscription ' +
        'for this exact event — the driver called dispatchPending with no webhooks')
      assert.notEqual(row.status, 'sent', 'the guard refused the URL, so nothing was delivered')
      assert.equal(row.attempts, 1, 'and it was tried, which is the difference')
      assert.ok(row.next_attempt_at, 'a failed attempt gets a retry floor')
    })
  })

  it('reports a missing subscription as undeliverable rather than as sent', async () => {
    // The control: with no subscriber, `undeliverable` is the correct answer,
    // so the test above cannot be satisfied by a row that never sets it.
    await withStore(async (store) => {
      await store.merge({ webhook_subscriptions: [], events_outbox: [due('ob-2')] })
      const heartbeat = await runPeriodicTick(store)
      const item = heartbeat.items.find((entry) => entry.id === 'outbox')
      assert.equal(item.summary.dispatched, 0)
      assert.equal(item.summary.undeliverable, 1)
      assert.equal(item.summary.deferred, 0)
      assert.ok(!('sent' in item.summary),
        '`sent` was `Number(result)` — `NaN` for the object `dispatchPending` returns')
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
