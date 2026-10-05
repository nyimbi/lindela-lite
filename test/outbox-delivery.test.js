/**
 * R-20, R-47: the outbox, which had a retry budget no event could ever spend.
 *
 * The trap this file is built around: `maxRetries = 5` was unreachable for any
 * re-emitted event, because `emit` derives the id from `(event, payload)` and
 * then writes `attempts: 0` over the failed row. A permanently failing webhook
 * therefore retried forever and the `failed` state — which existed, and which
 * `outboxRollup` now counts — was dead code for the whole life of the product.
 *
 * Every test drives the real `emit`/`dispatchPending` against a real
 * `JsonStore`, because a stubbed store cannot produce the merge that resets the
 * counter, which is the bug.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { dispatchPending, emit, outboxRollup, OUTBOX_MAX_RETRIES } from '../src/outbox.js'
import { JsonStore } from '../src/store.js'

let dir
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-outbox-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

let seq = 0
async function freshStore() {
  const store = new JsonStore(path.join(dir, `store-${process.pid}-${seq++}.json`))
  return store
}

const allowLoopback = async () => {}
const webhook = (overrides = {}) => ({
  id: 'wh_1',
  status: 'active',
  url: 'https://example.invalid/hook',
  events: ['*'],
  ...overrides,
})

describe('an outbox event that keeps failing eventually dead-letters', () => {
  it('reaches `failed` after the declared retry budget', async () => {
    const store = await freshStore()
    await emit(store, 'alert.created', { alert_id: 'a1' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('connection refused') }
    try {
      // Re-emit on every cycle, exactly as the platform does: every retry path
      // in the product re-emits the event it is retrying. The clock advances
      // past each backoff, because the backoff is real and a test that does not
      // wait it out is testing the filter, not the budget.
      for (let cycle = 0; cycle < OUTBOX_MAX_RETRIES + 2; cycle += 1) {
        await emit(store, 'alert.created', { alert_id: 'a1' })
        await dispatchPending(store, {
          webhooks: [webhook()],
          checkUrl: allowLoopback,
          now: () => Date.now() + cycle * 10 * 60_000,
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    const rows = (await store.read()).events_outbox
    assert.equal(rows.length, 1, 're-emitting must not create a second row for the same event')
    assert.equal(rows[0].status, 'failed', 'a permanently failing endpoint must stop being retried')
    assert.equal(rows[0].attempts, OUTBOX_MAX_RETRIES)
    assert.ok(rows[0].last_error, 'the last error travels with the dead letter')
  })

  it('honours the backoff instead of retrying on the next tick', async () => {
    const store = await freshStore()
    await emit(store, 'alert.created', { alert_id: 'a2' })

    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls += 1; throw new Error('boom') }
    try {
      const first = await dispatchPending(store, { webhooks: [webhook()], checkUrl: allowLoopback })
      assert.equal(calls, 1)
      assert.equal(first.failed, 0, 'the first failure is a retry, not a dead letter')
      assert.equal(first.deferred, 1)

      // Second cycle, immediately. The row is inside its backoff window.
      const second = await dispatchPending(store, { webhooks: [webhook()], checkUrl: allowLoopback })
      assert.equal(calls, 1, 'a second dispatch inside the cooldown must not issue a request')
      assert.equal(second.dispatched + second.failed + second.deferred, 0)

      // Third, after the window. It retries.
      await dispatchPending(store, {
        webhooks: [webhook()],
        checkUrl: allowLoopback,
        now: () => Date.now() + 60_000,
      })
      assert.equal(calls, 2, 'the event retries once the backoff has elapsed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not re-deliver an event that already went out', async () => {
    const store = await freshStore()
    await emit(store, 'alert.created', { alert_id: 'a3' })
    globalThis.fetch = async () => new Response('{}', { status: 200 })
    try {
      await dispatchPending(store, { webhooks: [webhook()], checkUrl: allowLoopback })
      const replay = await emit(store, 'alert.created', { alert_id: 'a3' })
      assert.equal(replay.status, 'sent', 're-emitting a delivered event is a replay request, not a reset')
      const again = await dispatchPending(store, { webhooks: [webhook()], checkUrl: allowLoopback })
      assert.equal(again.dispatched, 0, 'a delivered event is not sent twice')
    } finally {
      delete globalThis.fetch
    }
  })
})

describe('an event nobody is subscribed to is not a delivery', () => {
  it('leaves it pending and undeliverable rather than marking it sent', async () => {
    const store = await freshStore()
    await emit(store, 'alert.created', { alert_id: 'a4' })

    const result = await dispatchPending(store, { webhooks: [], checkUrl: allowLoopback })
    assert.equal(result.undeliverable, 1)
    assert.equal(result.dispatched, 0)

    const row = (await store.read()).events_outbox[0]
    assert.notEqual(row.status, 'sent', 'nothing was delivered, so nothing may read as delivered')
    assert.equal(row.undeliverable, true)
    assert.match(row.last_error, /no active webhook/u)

    // A subscription created later still delivers it.
    let called = false
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }) }
    try {
      await dispatchPending(store, { webhooks: [webhook()], checkUrl: allowLoopback })
      assert.ok(called, 'an undeliverable event must stay deliverable')
    } finally {
      delete globalThis.fetch
    }
  })
})

describe('the dead-letter surface exists (R-47)', () => {
  it('counts what stopped getting through', async () => {
    const store = await freshStore()
    await emit(store, 'alert.created', { alert_id: 'a5' })
    // Not subscribed to, so it stays pending rather than dead-lettering: the
    // two states have to be distinguishable or the rollup is decoration.
    await emit(store, 'workflow.created', { workflow_id: 'w1' })

    globalThis.fetch = async () => { throw new Error('down') }
    try {
      for (let cycle = 0; cycle < OUTBOX_MAX_RETRIES; cycle += 1) {
        await dispatchPending(store, {
          webhooks: [webhook({ events: ['alert.created'] })],
          checkUrl: allowLoopback,
          now: () => Date.now() + cycle * 10 * 60_000,
        })
      }
    } finally {
      delete globalThis.fetch
    }

    const rollup = outboxRollup(await store.read())
    assert.equal(rollup.failed_count, 1, 'the alert dead-lettered; the workflow had no subscriber')
    assert.equal(rollup.degraded, true, 'a dead letter is what /ready needs a boolean for')
    assert.equal(rollup.failed[0].event, 'alert.created')
    assert.equal(rollup.failed[0].attempts, OUTBOX_MAX_RETRIES)
    assert.ok(rollup.failed[0].failed_at)
    assert.equal(rollup.undeliverable, 1, 'unsubscribed events are counted separately, not as failures')
    assert.equal(rollup.total, 2)
  })

  it('reports clean on an empty queue rather than guessing', () => {
    const rollup = outboxRollup({})
    assert.equal(rollup.total, 0)
    assert.equal(rollup.degraded, false)
    assert.equal(rollup.next_attempt_at, null)
  })
})
