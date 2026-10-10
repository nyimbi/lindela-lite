import crypto from 'node:crypto'

import { createIdempotencyStore } from './utils.js'

/**
 * CON-06 — idempotency that survives a restart and a second replica.
 *
 * The store this replaces was an in-process `Map` with a 24-hour TTL and a
 * 1,000-entry cap, and both bounds were wrong in opposite directions. A restart
 * forgot every key, so a client that retried after a deploy re-ran the write it
 * was retrying — the exact case a mobile client on a flaky link produces. And a
 * queue drain of more than 1,000 mutations evicted keys that were still inside
 * their window, so the cap silently shortened the guarantee it was reporting.
 *
 * The repair is not a bigger Map. It is to put the *outcome* where the thing it
 * describes already lives: one row per key in the store, written under the same
 * cross-replica lock the outbox uses (`store.withLock`, ENH-63). A retry from a
 * second replica, or from a process that started after the first one died, then
 * finds the receipt the first attempt left behind.
 *
 * Two pieces, deliberately separate, because they have different natural homes:
 *
 *   - **The claim**, which is a promise that the work is happening right now.
 *     A promise cannot cross a process boundary, so this stays in-process. It
 *     is what lets a concurrent second request *await* the first and replay its
 *     answer rather than being told to retry.
 *   - **The outcome**, which is `{status, body}`. That is durable state and it
 *     goes in the store.
 *
 * The durable half alone would answer a concurrent same-process retry with a
 * 409 where it used to answer with the first attempt's body — a regression in
 * behaviour in exchange for durability, which is not a trade this codebase
 * makes. The in-process half alone is the defect. Together they are what the
 * guarantee claims to be.
 *
 * **The bound is the TTL, and the TTL is swept.** There is no entry cap here.
 * A cap that evicts a live key is not a bound on memory, it is a bound on the
 * guarantee — and the guarantee is the product. Rows past their `expires_at`
 * are deleted, so the collection holds one row per distinct key used in the
 * last 24 hours, which is the bound the old comment claimed and the old code
 * did not deliver.
 */

/** The declared collection the outcomes live in. Must match `SCHEMA` in store.js. */
export const IDEMPOTENCY_COLLECTION = 'idempotency_keys'

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a claim with no outcome behind it is honoured.
 *
 * The durable analogue of a promise that is still pending. A claim is written
 * before the work and cleared after it, so a claim with no outcome means either
 * "in flight right now" or "the process that made it died". The first must be
 * left alone and the second must not wedge the key for its whole 24-hour TTL,
 * and the only thing separating them is how long ago the claim was stamped.
 */
export const DEFAULT_CLAIM_TTL_MS = 60 * 1000

/**
 * The row id for a key.
 *
 * Hashed rather than used directly, for two reasons. The key is
 * `subject \0 METHOD \0 path \0 key` — PostgreSQL `text` cannot hold a NUL, so
 * the raw form is not storable at all, and a store that works on JSON and
 * throws on Postgres is the defect class this codebase keeps paying for. The
 * digest also bounds the row id, where the raw key is up to 255 characters
 * after a scope prefix that is longer still.
 *
 * The full SHA-256, not the 16-character truncation `stableId` uses. A
 * collision here is not a duplicate row, it is one caller's response replayed
 * to a different caller under a different key — the cross-partner read the key
 * scoping exists to prevent. At 64 bits and ten million keys the birthday
 * probability is already ~3e-6; at 256 it is not a number worth writing down.
 */
export function idempotencyRowId(key) {
  return `idem_${crypto.createHash('sha256').update(String(key)).digest('hex')}`
}

const conflictBody = (message) => ({ conflict: true, status: 409, body: { success: false, error: message } })

/**
 * An idempotency store backed by the store's own rows.
 *
 * `store` must implement `withLock(fn)`, handing `fn` a `{ read, merge, remove,
 * readOne }` view of one transaction. `JsonStore` and `PostgresStore` both do;
 * `createIdempotencyFor` below is the capability check for the ones that do not.
 *
 * Every method is async, including the ones the in-process store answers
 * synchronously. The two are interchangeable behind `createIdempotencyFor`, and
 * a caller that had to know which one it held — by awaiting one and not the
 * other — would be the two-stores-disagreeing bug in a new place.
 */
export function createDurableIdempotencyStore(store, {
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  claimTtlMs = DEFAULT_CLAIM_TTL_MS,
  now = () => Date.now(),
  // Sweeping is a full read of the collection, so it is amortised rather than
  // paid per write. The claim, settle and release paths each read one row by
  // id; only the sweep reads the set. Lowered in tests to force it.
  sweepEvery = 100,
} = {}) {
  /** key -> { promise, settle, fingerprint }. In-process, and deliberately so. */
  const inFlight = new Map()
  let settles = 0

  const claimLocally = (key, fingerprint) => {
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    // Nothing awaits this until a second request arrives, so it must not
    // surface as an unhandled rejection when the first request finishes.
    promise.catch(() => {})
    // Stamped, and checked against the same TTL the durable claim uses. Without
    // the stamp a local claim is immortal: `settle` and `release` are the only
    // things that clear it, so a handler that threw before either — or a claim
    // whose durable row was reclaimed after its TTL — left this process
    // answering "in flight" forever. That is strictly worse than the durable
    // half it was backing up, and it is invisible from outside because the row
    // says the key is free.
    inFlight.set(key, { promise, settle, fingerprint: fingerprint ?? null, at: now() })
    return inFlight.get(key)
  }

  /** The local claim for `key`, if one is live. Clears one that is not. */
  const liveLocal = (key) => {
    const local = inFlight.get(key)
    if (!local) return null
    if (now() - local.at >= claimTtlMs) {
      inFlight.delete(key)
      if (local.settle) local.settle({ error: new Error('idempotent attempt expired') })
      return null
    }
    return local
  }

  const expire = (row, nowMs) => !row || Date.parse(row.expires_at) <= nowMs

  return {
    mode: 'durable',
    collection: IDEMPOTENCY_COLLECTION,
    ttlMs,
    claimTtlMs,

    /**
     * Claim a key before the work runs.
     *
     * The local check comes first: if this process is already running the work,
     * the honest answer is the first attempt's promise, not a 409. Everything
     * after it is the durable half, and it is what a second replica sees.
     */
    async claim(key, fingerprint) {
      if (!key) return { proceed: true }
      const local = liveLocal(key)
      if (local) {
        if (fingerprint && local.fingerprint && fingerprint !== local.fingerprint) {
          return conflictBody('Idempotency-Key is in flight with a different request body')
        }
        return { inFlight: true, promise: local.promise }
      }

      const id = idempotencyRowId(key)
      return store.withLock(async (locked) => {
        const nowMs = now()
        const row = await locked.readOne(IDEMPOTENCY_COLLECTION, id)

        // A settled row inside its window is the replay. The fingerprint check
        // comes first because the same key with a different body is a client
        // bug, and answering it with a receipt for work that was never done is
        // how a caller reads an import count for a batch they did not send.
        if (row && !expire(row, nowMs) && row.status !== null && row.status !== undefined) {
          if (fingerprint && row.fingerprint && fingerprint !== row.fingerprint) {
            return conflictBody('Idempotency-Key was already used with a different request body')
          }
          return { proceed: false, status: row.status, body: row.body }
        }

        // A claim with no outcome: either in flight somewhere else, or
        // abandoned by a process that died. The age is the only thing that
        // separates them, and a claim past its TTL is taken over rather than
        // left to wedge the key for the rest of the day.
        if (row && !expire(row, nowMs) && (row.status === null || row.status === undefined)) {
          if (fingerprint && row.fingerprint && fingerprint !== row.fingerprint) {
            return conflictBody('Idempotency-Key is in flight with a different request body')
          }
          if (nowMs - Date.parse(row.claimed_at) < claimTtlMs) return { inFlight: true }
        }

        await locked.merge({
          [IDEMPOTENCY_COLLECTION]: [{
            id,
            fingerprint: fingerprint ?? null,
            status: null,
            body: null,
            claimed_at: new Date(nowMs).toISOString(),
            settled_at: null,
            expires_at: new Date(nowMs + ttlMs).toISOString(),
          }],
        })
        claimLocally(key, fingerprint)
        return { proceed: true, claim: true }
      })
    },

    /**
     * Record the outcome, so a later retry replays it.
     *
     * Sweeps here rather than on a timer, because this is the only path that
     * writes an expiry and therefore the only one that can create the garbage.
     * Amortised over `sweepEvery` calls so the full-collection read is not paid
     * per mutation.
     */
    async settle(key, status, body, fingerprint) {
      if (!key) return
      const id = idempotencyRowId(key)
      const pending = inFlight.get(key)
      if (pending) {
        inFlight.delete(key)
        if (pending.settle) pending.settle({ status, body })
      }
      settles += 1
      const sweeping = settles % sweepEvery === 0
      const nowMs = now()
      await store.withLock(async (locked) => {
        await locked.merge({
          [IDEMPOTENCY_COLLECTION]: [{
            id,
            fingerprint: fingerprint ?? null,
            status,
            body,
            claimed_at: null,
            settled_at: new Date(nowMs).toISOString(),
            expires_at: new Date(nowMs + ttlMs).toISOString(),
          }],
        })
        if (!sweeping) return
        const rows = (await locked.read([IDEMPOTENCY_COLLECTION]))[IDEMPOTENCY_COLLECTION] || []
        const doomed = rows.filter((row) => expire(row, nowMs)).map((row) => row.id)
        if (doomed.length) await locked.remove({ collection: { [IDEMPOTENCY_COLLECTION]: doomed } })
      })
    },

    /**
     * Drop a claim without recording an outcome, so the key is retryable now.
     *
     * A failure must not be cached — a client's typo would become a day-long
     * failure — and the row is deleted rather than stamped expired, so a caller
     * that retries immediately is not racing the sweep.
     */
    async release(key) {
      if (!key) return
      const pending = inFlight.get(key)
      if (pending) {
        inFlight.delete(key)
        if (pending.settle) pending.settle({ error: new Error('idempotent attempt failed') })
      }
      const id = idempotencyRowId(key)
      await store.withLock(async (locked) => {
        const row = await locked.readOne(IDEMPOTENCY_COLLECTION, id)
        // Only a claim. A settled row is the receipt and outlives the request
        // that produced it — deleting one here would turn the next retry into a
        // second execution.
        if (row && (row.status === null || row.status === undefined)) {
          await locked.remove({ collection: { [IDEMPOTENCY_COLLECTION]: [id] } })
        }
      })
    },

    async lookup(key, fingerprint) {
      if (!key) return undefined
      const local = liveLocal(key)
      if (local) return { inFlight: true, promise: local.promise }
      const id = idempotencyRowId(key)
      const row = await store.withLock((locked) => locked.readOne(IDEMPOTENCY_COLLECTION, id))
      if (expire(row, now())) return undefined
      if (row.status === null || row.status === undefined) return { inFlight: true }
      if (fingerprint && row.fingerprint && fingerprint !== row.fingerprint) {
        return { conflict: true, status: 409, body: { success: false, error: 'Idempotency-Key was already used with a different request body' } }
      }
      return { replay: true, status: row.status, body: row.body }
    },

    async run(key, status, fn, fingerprint) {
      if (!key) return await fn()
      const outcome = await fn()
      await this.settle(key, status, outcome, fingerprint)
      return outcome
    },

    /** How many rows the collection holds. A full read, so not on any hot path. */
    async count() {
      const rows = await store.withLock((locked) => locked.read([IDEMPOTENCY_COLLECTION]))
      return (rows[IDEMPOTENCY_COLLECTION] || []).length
    },
  }
}

/**
 * The idempotency store for a store, chosen by what the store can do.
 *
 * A store with `withLock` gets the durable implementation. One without — a test
 * double, or a store this build does not know — gets the in-process one, and
 * says so through `mode`. That is a capability check rather than a configuration
 * switch: nothing in the environment selects between them, so the two cannot
 * silently disagree about which deployment they are describing.
 */
export function createIdempotencyFor(store, options = {}) {
  if (typeof store?.withLock === 'function') return createDurableIdempotencyStore(store, options)
  const inner = createIdempotencyStore(options)
  return {
    mode: 'in-process',
    collection: null,
    ttlMs: options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    claimTtlMs: 0,
    lookup: (key, fingerprint) => inner.lookup(key, fingerprint),
    claim: async (key, fingerprint) => inner.claim(key, fingerprint),
    settle: async (key, status, body, fingerprint) => inner.settle(key, status, body, fingerprint),
    release: async (key) => inner.release(key),
    run: (key, status, fn, fingerprint) => inner.run(key, status, fn, fingerprint),
    count: async () => inner.size,
  }
}
