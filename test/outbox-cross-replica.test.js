import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { emit, emitMany, redriveOutbox, dispatchPending, DISPATCH_CLAIM_TTL_MS } from '../src/outbox.js'
import { PostgresStore } from '../src/postgres-store.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * CON-01 and CON-07, against a real PostgreSQL.
 *
 * Both defects only exist *between* processes: within one, the in-process
 * dispatch chain and `JsonStore`'s write chain already serialise the
 * read-modify-write. So the only honest test is two `PostgresStore` instances —
 * two connection pools, two Node objects, exactly what two replicas are —
 * against one database. A single store would pass against the broken code, and
 * a file store cannot be shared between two instances at all.
 *
 * CON-01 — `emit` reads the store, decides from that snapshot, and merges, with
 *   the read and the merge in two transactions. Two replicas both read a row as
 *   absent (or as carrying the backoff they are about to overwrite), both
 *   decide, and both write. An event re-emitted mid-dispatch resurrects a row
 *   whose backoff was just set.
 *
 * CON-07 — the dispatch lock is a `WeakMap` keyed on the store object, so it is
 *   per-process. Two replicas both read the same pending rows and both POST
 *   them. The fix is a claim written under the store's cross-replica lock, so a
 *   second replica's read no longer sees the row as deliverable.
 *
 * The interleavings are forced, not hoped for: `store.withLock` is held open on
 * one store while the other tries to proceed. A test that merely ran two calls
 * concurrently would pass on the broken code whenever the timing did not
 * collide — the canary on the CON-02 suite proved exactly that failure mode.
 */

describe('CON-01 / CON-07 — two replicas on one database', () => {
  let cluster
  let a
  let b

  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran the cross-replica suite without a database: ${reason}. Every test here `
        + 'would have passed without executing a single statement.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  const reset = async () => {
    await a.write({ events_outbox: [] })
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-cross-replica' })
    if (cluster.skipped) {
      process.stderr.write(`outbox-cross-replica: ${cluster.skipped}\n`)
      return
    }
    // Two independent pools against one database — the definition of two
    // replicas, without needing two processes.
    a = new PostgresStore({ databaseUrl: cluster.url })
    b = new PostgresStore({ databaseUrl: cluster.url })
    await a.ensureSchema()
    await reset()
  })

  after(async () => {
    await a?.close()
    await b?.close()
    await cluster?.stop()
  })

  it('the second replica sees a row the first committed inside its lock', async (t) => {
    // The primitive itself, before the defects that ride on it. If a locked
    // merge were not visible to a later locked read on the other store, nothing
    // below could work — and this isolates that from the outbox logic.
    if (needsPostgres(t)) return
    await reset()
    await a.withLock(async (locked) => locked.merge({ events_outbox: [{ id: 'visible', status: 'pending' }] }))
    const seen = await b.withLock(async (locked) => (await locked.read()).events_outbox.map((r) => r.id))
    assert.deepEqual(seen, ['visible'], 'a committed write was not visible to the other replica')
  })

  it('a re-emit cannot clobber a backoff another replica set concurrently', async (t) => {
    // CON-01, and the reason the defect is a lost update rather than a duplicate
    // row: `emit` keys on a derived id, so two writers of the same event share a
    // row and `ON CONFLICT (collection, id)` already collapses them. What the
    // race loses is the *content* — replica A reads `attempts: 0, no backoff`,
    // replica B writes `attempts: 3, backoff`, replica A merges its stale
    // snapshot over it, and the endpoint gets a free request per cycle.
    //
    // Forced, not hoped for: B holds the lock and writes the backoff while A's
    // re-emit is issued and blocks. With the lock A reads what B committed and
    // carries it forward; without it A read the pre-B snapshot and clobbers.
    if (needsPostgres(t)) return
    await reset()
    const payload = { id: 'ev-race' }
    const created = await emit(a, 'hazard.created', payload)
    const cooldown = new Date(Date.now() + 60_000).toISOString()

    let aEmit = null
    await b.withLock(async (locked) => {
      // Issued inside B's lock, so it queues until B releases.
      aEmit = emit(a, 'hazard.created', payload)
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      const data = await locked.read()
      const row = data.events_outbox.find((r) => r.id === created.id)
      await locked.merge({ events_outbox: [{ ...row, attempts: 3, next_attempt_at: cooldown }] })
    })

    const result = await aEmit
    assert.equal(result.next_attempt_at, cooldown,
      'the re-emit clobbered a backoff another replica set concurrently')
    assert.equal(result.attempts, 3, 'the re-emit clobbered the attempt count')
  })

  it('emitMany is atomic across replicas too', async (t) => {
    // The batch path carries the same defect as `emit`; it is tested separately
    // because it takes its snapshot once for the whole batch rather than per
    // event, so a fix that only covered the single-event path would miss it.
    // Asserted on content, not row count: the batch must carry a concurrent
    // backoff forward exactly as `emit` does.
    if (needsPostgres(t)) return
    await reset()
    const payloads = [{ i: 0 }, { i: 1 }, { i: 2 }]
    const created = await emitMany(a, payloads.map((payload) => ({ event: 'hazard.created', payload })))
    const cooldown = new Date(Date.now() + 60_000).toISOString()
    const target = created[0].id

    let bBatch = null
    await a.withLock(async (locked) => {
      bBatch = emitMany(b, payloads.map((payload) => ({ event: 'hazard.created', payload })))
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      const data = await locked.read()
      const row = data.events_outbox.find((r) => r.id === target)
      await locked.merge({ events_outbox: [{ ...row, attempts: 3, next_attempt_at: cooldown }] })
    })

    const result = await bBatch
    const first = result.find((r) => r.id === target)
    assert.equal(first.next_attempt_at, cooldown,
      'the batch re-emit clobbered a backoff another replica set concurrently')
  })

  it('a claim by one replica hides the row from the other while delivery is in flight', async (t) => {
    // CON-07, and the interleaving that makes the claim load-bearing. Running
    // A to completion and then B proves nothing: B skips because the row is
    // `sent`. The claim matters only *while A is mid-delivery*, when the row is
    // still `pending` — the exact window in which the in-process WeakMap lock
    // does nothing across replicas and both POST the same event.
    //
    // A's fetch is held open on a gate, so its claim is committed and its
    // outcome is not. B runs in that window. Without the claim filter B sees
    // `pending` and delivers a second copy.
    if (needsPostgres(t)) return
    await reset()
    const webhook = { id: 'w1', url: 'http://example.test/hook', status: 'active', events: ['hazard.created'] }
    const opts = { webhooks: [webhook], checkUrl: async () => {} }
    await emit(a, 'hazard.created', { seed: 2 })

    const posts = []
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      posts.push(url)
      // Only the first delivery blocks; the second (if the bug is present)
      // returns at once so the test finishes rather than hanging.
      if (posts.length === 1) await gate
      return { ok: true, status: 200 }
    }
    try {
      const aRun = dispatchPending(a, opts)
      // Wait until A has claimed and is inside its fetch, then let B try.
      while (posts.length === 0) await new Promise((r) => setTimeout(r, 5))
      const bRun = await dispatchPending(b, opts)
      assert.equal(bRun.dispatched, 0,
        'a second replica delivered a row the first had claimed and was mid-delivery on')
      release()
      const aResult = await aRun
      assert.equal(aResult.dispatched, 1, 'the claiming replica must complete its delivery')
      assert.equal(posts.length, 1, `the endpoint was POSTed ${posts.length} times for one event`)
    } finally {
      release?.()
      globalThis.fetch = originalFetch
    }
  })

  it('a stale claim is reclaimed so a crashed replica does not strand a row', async (t) => {
    // The TTL. A claim whose owner died must become deliverable again, or one
    // crash silently stops that event forever — a worse failure than a duplicate.
    if (needsPostgres(t)) return
    await reset()
    const stale = new Date(Date.now() - DISPATCH_CLAIM_TTL_MS - 60_000).toISOString()
    await a.merge({
      events_outbox: [{
        id: 'stale-1',
        event: 'hazard.created',
        payload: {},
        status: 'pending',
        attempts: 0,
        dispatching_at: stale,
      }],
    })
    const originalFetch = globalThis.fetch
    let posts = 0
    globalThis.fetch = async () => { posts += 1; return { ok: true, status: 200 } }
    try {
      const result = await dispatchPending(b, {
        webhooks: [{ id: 'w', url: 'http://example.test/h', status: 'active', events: ['hazard.created'] }],
        checkUrl: async () => {},
      })
      assert.equal(result.dispatched, 1, 'a claim older than the TTL was not reclaimed')
      assert.equal(posts, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('redriveOutbox revives a dead letter once, across replicas', async (t) => {
    // The same read-modify-write shape as `emit`, on the recovery path.
    if (needsPostgres(t)) return
    await reset()
    await a.merge({ events_outbox: [{ id: 'dead-1', event: 'hazard.created', payload: {}, status: 'failed', attempts: 5, failed_at: '2026-01-01T00:00:00.000Z' }] })
    const result = await redriveOutbox(a, { ids: ['dead-1'] })
    assert.equal(result.length, 1)
    assert.equal(result[0].status, 'pending')
    assert.equal(result[0].attempts, 0, 'a redrive must reset the counter or it has one try left')
    // A second replica redriving sees the row already pending and revives nothing.
    const again = await redriveOutbox(b, { ids: ['dead-1'] })
    assert.deepEqual(again, [], 'a second replica revived a row that was no longer a dead letter')
  })
})
