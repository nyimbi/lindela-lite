import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  DEFAULT_CLAIM_TTL_MS,
  createDurableIdempotencyStore,
  createIdempotencyFor,
  idempotencyRowId,
} from '../src/idempotency.js'
import { PostgresStore } from '../src/postgres-store.js'
import { JsonStore } from '../src/store.js'
import { createIdempotencyStore } from '../src/utils.js'
import { postgresCluster } from './pg-harness.mjs'

/**
 * CON-06 — the idempotency guarantee has to outlive the process that made it.
 *
 * The store this replaces was an in-process `Map`. Two bounds were wrong, and
 * they were wrong in opposite directions:
 *
 *   - a restart forgot every key, so a client that retried after a deploy
 *     re-ran the write it was retrying — the case a phone on a flaky link
 *     produces by itself;
 *   - a 1,000-entry cap evicted keys still inside their window, so a queue drain
 *     of more than 1,000 mutations silently shortened the guarantee it reported.
 *
 * Both are asserted here as behaviour rather than as code shape. "Is there a
 * table" would pass on a table nothing writes to; the tests below drive a claim
 * and a settle and then look for the receipt through a *different* store
 * instance, which is the only way to tell durability from a Map that happens to
 * still be warm.
 *
 * The in-process half is tested too, because it is still load-bearing: a
 * concurrent same-process retry must *await* the first attempt rather than be
 * told 409. A durable store that dropped that would be trading a behaviour
 * regression for durability, which is not a trade this codebase makes.
 */

describe('CON-06 — a durable idempotency store', () => {
  let dir
  let filePath

  const fresh = async () => {
    await fs.rm(filePath, { force: true })
    return new JsonStore(filePath)
  }

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-idem-'))
    filePath = path.join(dir, 'store.json')
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('replays a receipt through a store instance that never saw the request', async () => {
    // The defect, exactly. A restart is a second `JsonStore` over the same file,
    // which is what a redeploy is — and the old store had nothing to hand it.
    const first = createDurableIdempotencyStore(await fresh())
    await first.claim('key-a', 'fp')
    await first.settle('key-a', 201, { id: 'created' }, 'fp')

    const afterRestart = createDurableIdempotencyStore(new JsonStore(filePath))
    const replay = await afterRestart.claim('key-a', 'fp')
    assert.equal(replay.proceed, false, 'a retry after a restart ran the work again')
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.body, { id: 'created' })
  })

  it('still awaits a concurrent same-process retry rather than answering 409', async () => {
    // The in-process half. Two requests, one key, arriving together: the second
    // must get the first's answer. Answering 409 here would be a regression in
    // exchange for durability, and the test that would miss it is one that only
    // ever retries after the first request has finished.
    const idem = createDurableIdempotencyStore(await fresh())
    const held = await idem.claim('key-b', 'fp')
    assert.equal(held.proceed, true)

    const second = await idem.claim('key-b', 'fp')
    assert.equal(second.inFlight, true, 'the concurrent retry did not see the attempt in flight')
    assert.ok(second.promise, 'there is no promise to await, so the caller cannot be answered')

    await idem.settle('key-b', 202, { ok: true }, 'fp')
    assert.deepEqual(await second.promise, { status: 202, body: { ok: true } })
  })

  it('refuses a key reused with a different body, and runs nothing', async () => {
    // The check the old store had in `lookup` and lost when the server moved to
    // `claim`. Replaying here would answer with a receipt for work never done —
    // an import count describing a batch the caller did not send.
    const idem = createDurableIdempotencyStore(await fresh())
    await idem.claim('key-c', 'fingerprint-1')
    await idem.settle('key-c', 201, { id: 'x' }, 'fingerprint-1')

    const clash = await idem.claim('key-c', 'fingerprint-2')
    assert.equal(clash.conflict, true)
    assert.equal(clash.status, 409)
    assert.match(clash.body.error, /different request body/)
  })

  it('reclaims a claim abandoned by a process that died', async () => {
    // A claim is written before the work and cleared after it, so a claim with
    // no outcome is either "in flight now" or "the process is gone". The age is
    // the only thing that separates them, and without the TTL the second reading
    // wedges the key for the full 24 hours.
    const idem = createDurableIdempotencyStore(await fresh(), { claimTtlMs: 30 })
    await idem.claim('key-d', 'fp')
    // The second caller, inside the claim's life, is told to wait.
    assert.equal((await idem.claim('key-d', 'fp')).inFlight, true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Past it, the claim is taken over rather than left standing.
    const taken = await idem.claim('key-d', 'fp')
    assert.equal(taken.proceed, true, 'an abandoned claim was not reclaimed')
    assert.equal(taken.claim, true)
  })

  it('releases a failed attempt so the key is retryable at once', async () => {
    const idem = createDurableIdempotencyStore(await fresh())
    await idem.claim('key-e', 'fp')
    await idem.release('key-e')
    const again = await idem.claim('key-e', 'fp')
    assert.equal(again.proceed, true, 'a released key was not retryable')
    assert.equal(again.claim, true)
  })

  it('does not delete a settled receipt when a later attempt is released', async () => {
    // `release` is only ever about a claim. Deleting a settled row would turn
    // the next retry into a second execution, which is the whole defect.
    const idem = createDurableIdempotencyStore(await fresh())
    await idem.claim('key-f', 'fp')
    await idem.settle('key-f', 201, { id: 'kept' }, 'fp')
    await idem.release('key-f')
    const replay = await idem.claim('key-f', 'fp')
    assert.equal(replay.proceed, false, 'a release destroyed the receipt')
    assert.deepEqual(replay.body, { id: 'kept' })
  })

  it('bounds the collection by sweeping expired rows, not by evicting live ones', async () => {
    // The second half of the defect. The old cap evicted the *oldest* entry
    // whether or not it had expired, so a drain of 1,001 mutations lost the
    // first one's receipt while it was still inside its window. A sweep removes
    // only what is past its expiry, so the live set is bounded by the TTL and
    // the traffic, and never by an arbitrary count.
    const idem = createDurableIdempotencyStore(await fresh(), { ttlMs: 20, sweepEvery: 1 })
    await idem.settle('old-1', 201, { id: 'old' }, 'fp')
    await idem.settle('old-2', 201, { id: 'old' }, 'fp')
    await new Promise((resolve) => setTimeout(resolve, 40))
    // A live key written after the two above; the sweep this settle triggers
    // must take the expired pair and leave this one.
    await idem.settle('live-1', 201, { id: 'live' }, 'fp')

    assert.equal(await idem.count(), 1, 'the sweep did not bound the collection')
    const live = await idem.claim('live-1', 'fp')
    assert.equal(live.proceed, false, 'the sweep evicted a key still inside its window')
  })

  it('keys the row on a digest, so a NUL-bearing key is storable', async () => {
    // The scoped key is `subject \0 METHOD \0 path \0 key`. PostgreSQL `text`
    // cannot hold a NUL, so a store that worked on JSON and threw on Postgres is
    // the two-backends-disagree defect this codebase keeps paying for. Asserted
    // on the id rather than on a round trip, because the round trip passes for
    // the wrong reason when the row is never written.
    const id = idempotencyRowId('anonymous\u0000POST\u0000/api/v1/x\u0000k')
    assert.match(id, /^idem_[0-9a-f]{64}$/)
    assert.equal(id.includes('\u0000'), false)
    // Distinct keys stay distinct, which is the cross-partner read the scoping
    // exists to prevent.
    assert.notEqual(id, idempotencyRowId('anonymous\u0000POST\u0000/api/v1/x\u0000k2'))
  })

  it('the in-process fallback is chosen only for a store that cannot lock', async () => {
    // The capability check, and the reason it is a check rather than a switch:
    // nothing in the environment selects between the two, so they cannot
    // silently disagree about which deployment they describe.
    const lockable = createIdempotencyFor(new JsonStore(filePath))
    assert.equal(lockable.mode, 'durable')
    assert.equal(lockable.collection, 'idempotency_keys')

    const notLockable = createIdempotencyFor({ read: async () => ({}), merge: async () => {} })
    assert.equal(notLockable.mode, 'in-process')
    assert.equal(notLockable.collection, null)
    // And it still answers, because a test double should not have to implement
    // a lock to exercise a route.
    assert.equal((await notLockable.claim('k', 'fp')).proceed, true)
  })

  it('the fallback keeps the behaviour the durable one has', async () => {
    // The two are interchangeable behind `createIdempotencyFor`, and the way
    // that stops being true is a method one implements and the other does not.
    const fallback = createIdempotencyFor({ read: async () => ({}), merge: async () => {} }, { ttlMs: 1 })
    await fallback.settle('k', 201, { id: 'v' }, 'fp')
    const replay = await fallback.claim('k', 'fp')
    assert.equal(replay.proceed, false)
    assert.deepEqual(replay.body, { id: 'v' })
    assert.equal(await fallback.count(), 1)
  })

  it('the default claim TTL is a minute, and is what a caller may rely on', () => {
    // Named rather than inlined so the /ready report and the docs have one
    // source. A claim TTL longer than a request is a key wedged for that long.
    assert.equal(DEFAULT_CLAIM_TTL_MS, 60 * 1000)
    assert.ok(DEFAULT_CLAIM_TTL_MS < 24 * 60 * 60 * 1000)
  })

  it('the in-process store it replaces still exists, for the fallback', () => {
    // `createIdempotencyStore` is not deleted: it is the fallback's engine, and
    // the two tests above would pass on a stub that happened to answer.
    const inner = createIdempotencyStore({ maxEntries: 2 })
    assert.equal(typeof inner.claim, 'function')
    assert.equal(typeof inner.settle, 'function')
  })
})

describe('CON-06 — durable idempotency across two replicas', () => {
  let cluster
  let a
  let b

  const needsPostgres = (t) => {
    const reason = cluster?.skipped
    if (!reason) return false
    if (process.env.CI) {
      throw new Error(
        `CI ran the durable-idempotency suite without a database: ${reason}. Every test here `
        + 'would have passed without executing a single statement.',
      )
    }
    t.skip(`no PostgreSQL: ${reason}`)
    return true
  }

  before(async () => {
    cluster = await postgresCluster({ name: 'lindela-idempotency' })
    if (cluster.skipped) {
      process.stderr.write(`idempotency-durable: ${cluster.skipped}\n`)
      return
    }
    a = new PostgresStore({ databaseUrl: cluster.url })
    b = new PostgresStore({ databaseUrl: cluster.url })
    await a.ensureSchema()
    await a.write({ idempotency_keys: [] })
  })

  after(async () => {
    await a?.close()
    await b?.close()
    await cluster?.stop()
  })

  it('one replica replays a receipt another replica wrote', async (t) => {
    // The claim the audit makes and the old store could not: exactly-once across
    // a fleet. Two pools, two Node objects, one database — the definition of two
    // replicas, and the only shape in which the defect exists at all.
    if (needsPostgres(t)) return
    const first = createDurableIdempotencyStore(a)
    await first.claim('shared-key', 'fp')
    await first.settle('shared-key', 201, { id: 'from-a' }, 'fp')

    const second = createDurableIdempotencyStore(b)
    const replay = await second.claim('shared-key', 'fp')
    assert.equal(replay.proceed, false, 'a second replica ran work the first had already done')
    assert.deepEqual(replay.body, { id: 'from-a' })
  })

  it('a claim in flight on one replica is refused rather than duplicated on another', async (t) => {
    // A promise cannot cross a process boundary, so the second replica has
    // nothing to await and is told to retry. What it must *not* do is proceed:
    // that is the duplicate write, and it is what the old in-process Map did by
    // having no memory of the other process at all.
    if (needsPostgres(t)) return
    const first = createDurableIdempotencyStore(a)
    await first.claim('in-flight-key', 'fp')

    const second = createDurableIdempotencyStore(b)
    const seen = await second.claim('in-flight-key', 'fp')
    assert.equal(seen.proceed, undefined, 'the second replica proceeded on a claim it could not see')
    assert.equal(seen.inFlight, true)
    assert.equal(seen.promise, undefined, 'a promise cannot cross a process boundary')
  })

  it('two concurrent same-key claims on two replicas produce exactly one winner', async (t) => {
    // Forced rather than hoped for. Both replicas claim at once through the
    // advisory lock, so the transactions queue and the second one reads what the
    // first committed. A test that merely issued them in sequence would pass on
    // a store with no lock at all, which is the canary failure this suite was
    // written to avoid.
    if (needsPostgres(t)) return
    const first = createDurableIdempotencyStore(a)
    const second = createDurableIdempotencyStore(b)
    const results = await Promise.all([
      first.claim('race-key', 'fp'),
      second.claim('race-key', 'fp'),
    ])
    const winners = results.filter((r) => r.proceed === true)
    assert.equal(winners.length, 1, `exactly one claim should have won, got ${winners.length}`)
  })

  it('the sweep removes expired rows for every replica, not just the sweeper', async (t) => {
    if (needsPostgres(t)) return
    await a.write({ idempotency_keys: [] })
    const short = createDurableIdempotencyStore(a, { ttlMs: 20, sweepEvery: 1 })
    await short.settle('stale-1', 201, { id: 'stale' }, 'fp')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await short.settle('fresh-1', 201, { id: 'fresh' }, 'fp')

    const seen = await b.withLock((locked) => locked.read(['idempotency_keys']))
    assert.equal(seen.idempotency_keys.length, 1, 'the sweep did not bound the table')
    assert.equal(seen.idempotency_keys[0].body.id, 'fresh')
  })
})
