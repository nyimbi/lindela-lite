import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  enqueueRecord, readAll, MAX_QUEUE_RECORDS, claimBatch, drainQueue, CLAIM_LEASE_MS,
} from '../public/shared/queue-core.js'

/**
 * R-60's surviving claim: a queue with no cap grows without bound.
 *
 * `MAX_QUEUE_ATTEMPTS` bounds attempts *per record*; nothing bounded the record
 * count. A phone out of signal for a season accumulated every report filed on
 * it, and the failure arrived as a quota refusal at write time — after the
 * health worker had been told the report was saved. The cap moves that refusal
 * to a number that is known, where it can be said out loud.
 *
 * The behavioural half drives the real module against an in-memory store. The
 * source half asserts the two call sites the module cannot reach — the write
 * path in `runtime.js` and the surface in `chw/app.js` — because a cap nothing
 * consults is not a cap. `enqueueRecord` being correct and unreached is exactly
 * the shape R-60 already recorded once: `list({failed:true})` and `retry` were
 * correct, tested, and called from nowhere.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

/**
 * Source with comments stripped.
 *
 * The comments here quote the code they replaced — "this used to `put(this.db,
 * record)`" — so a substring assertion over raw source matches the explanation
 * of the fix and the test passes forever on a comment. Same guard as
 * `offline-delivery.test.js`, for the same reason.
 */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** A store of exactly the shape `queue-core.js` writes through. */
function memoryDb({ readFails = false } = {}) {
  const records = []
  let nextId = 1
  return {
    records,
    transaction() {
      const tx = { error: null }
      // `queue-core.put` settles on `oncomplete`, not on the request's
      // `onsuccess` — a double that fires only the request leaves `put`'s
      // promise pending forever, and the test hangs rather than failing.
      const settle = (req, result) => {
        req.result = result
        req.onsuccess?.()
        tx.oncomplete?.()
      }
      tx.objectStore = () => ({
        put(value) {
          const req = {}
          setTimeout(() => {
            if (value.id === undefined || value.id === null) {
              const id = nextId
              nextId += 1
              records.push({ id, ...value })
              settle(req, id)
            } else {
              const at = records.findIndex((r) => r.id === value.id)
              if (at >= 0) records[at] = { ...value }
              else records.push({ ...value })
              settle(req, value.id)
            }
          }, 0)
          return req
        },
        delete(id) {
          // `queue-core.del` settles on the transaction's `oncomplete`, exactly
          // as `put` does. A double that splices and returns leaves the promise
          // pending forever, and the drain that deleted the record hangs.
          setTimeout(() => {
            const at = records.findIndex((r) => r.id === id)
            if (at >= 0) records.splice(at, 1)
            tx.oncomplete?.()
          }, 0)
        },
        getAll() {
          const req = {}
          setTimeout(() => {
            // `readAll` reads `req.result`. A double that passes the rows as
            // the *event* reports an empty store forever, and every count in
            // this file then reads zero — a test that passes on a bug.
            if (readFails) { req.onerror?.(new Error('blocked')); return }
            req.result = records.slice()
            req.onsuccess?.()
          }, 0)
          return req
        },
      })
      return tx
    },
  }
}

describe('R-59 — two drains, one claim', () => {
  // `flush()` (the page, on the 30 s tick and on `online`) and `replayQueue()`
  // (the service worker, on Background Sync) both read the same store and both
  // deleted independently. Two drains meant two field reports for one
  // observation, and the idempotency key does not cover it: the key makes the
  // *server* collapse a duplicate, it does not stop the second drain from
  // sending. Latent only while the worker could not install at all — fixing
  // that activated this, which is why the claim landed with it.
  const queued = (db) => enqueueRecord(db, { path: '/api/v1/reports', what: 'one', options: { method: 'POST' } })

  it('the second drainer takes nothing while the first holds the record', async () => {
    const db = memoryDb()
    await queued(db)

    const first = await claimBatch(db, { owner: 'page' })
    assert.equal(first.length, 1, 'the first claim took the record')

    const second = await claimBatch(db, { owner: 'worker' })
    assert.equal(second.length, 0,
      'the worker claimed a record the page is already sending — two drains, two reports')

    // The same owner may re-claim: a drain that crashed mid-send must be able
    // to pick its own records up again.
    const again = await claimBatch(db, { owner: 'page' })
    assert.equal(again.length, 1, 'a drainer could not re-claim its own record')
  })

  it('the lease expires, so a drainer that died does not strand the record', async () => {
    const db = memoryDb()
    await queued(db)
    const t0 = 1_000_000

    await claimBatch(db, { owner: 'page', now: t0 })
    const during = await claimBatch(db, { owner: 'worker', now: t0 + CLAIM_LEASE_MS - 1 })
    assert.equal(during.length, 0, 'the claim did not hold for the length of its lease')

    const after = await claimBatch(db, { owner: 'worker', now: t0 + CLAIM_LEASE_MS + 1 })
    assert.equal(after.length, 1,
      'a claim outlived its lease, so a drainer that died mid-send stranded the record forever')
  })

  it('a drained record is deleted, and only by the drainer that holds it', async () => {
    const db = memoryDb()
    await queued(db)
    await claimBatch(db, { owner: 'page' })

    const sent = []
    const result = await drainQueue(db, {
      owner: 'page',
      send: async (record) => { sent.push(record.path) },
    })
    assert.equal(result.sent, 1)
    assert.deepEqual(sent, ['/api/v1/reports'])
    assert.equal((await readAll(db)).length, 0, 'the delivered record was not removed from the queue')

    // And the worker, which holds no claim, sends nothing and deletes nothing.
    await queued(db)
    await claimBatch(db, { owner: 'page' })
    const workerSends = []
    const workerResult = await drainQueue(db, {
      owner: 'worker',
      send: async (record) => { workerSends.push(record.path) },
    })
    assert.equal(workerResult.attempted, 0, 'the worker attempted a record the page holds')
    assert.deepEqual(workerSends, [], 'the same report was sent twice')
    assert.equal((await readAll(db)).length, 1, 'the worker deleted a record it did not send')
  })
})

describe('R-60 — the queue has a record cap', () => {
  it('writes while there is room', async () => {
    const db = memoryDb()
    const result = await enqueueRecord(db, { path: '/a', what: 'one' }, { cap: 3 })
    assert.equal(result.queued, true)
    assert.equal(result.count, 1)
    assert.equal(result.cap, 3)
    assert.equal(db.records.length, 1)
  })

  it('refuses at the cap rather than growing without bound', async () => {
    const db = memoryDb()
    for (let i = 0; i < 3; i += 1) {
      await enqueueRecord(db, { path: '/a', what: `report ${i}` }, { cap: 3 })
    }
    const refused = await enqueueRecord(db, { path: '/a', what: 'one too many' }, { cap: 3 })
    assert.equal(refused.queued, false)
    assert.equal(refused.reason, 'full')
    assert.equal(refused.cap, 3)
    // The refusal is a refusal: nothing was written.
    assert.equal(db.records.length, 3)
  })

  it('counts failed records, because they are the ones that never leave', async () => {
    const db = memoryDb()
    await enqueueRecord(db, { path: '/a', what: 'refused', failed: true }, { cap: 2 })
    await enqueueRecord(db, { path: '/a', what: 'pending', failed: false }, { cap: 2 })
    const refused = await enqueueRecord(db, { path: '/a', what: 'third' }, { cap: 2 })
    assert.equal(refused.queued, false)
    // The way to make room is the Remove button on a refused report, so the
    // held list is load-bearing rather than cosmetic.
    assert.equal(db.records.filter((r) => r.failed).length, 1)
  })

  it('fails open when the store cannot be read', async () => {
    // `readAll` resolves `[]` for a store it cannot read. Counting that as "not
    // full" costs bytes when it is wrong; counting it as "full" loses a report
    // the worker has already been told is safe. The store is a *full* one whose
    // reads fail, so the premise is the real question — a genuinely empty store
    // would pass whether or not the refusal exists.
    const db = memoryDb({ readFails: true })
    for (let i = 0; i < 3; i += 1) db.records.push({ id: i + 1, path: '/a' })
    const result = await enqueueRecord(db, { path: '/a' }, { cap: 3 })
    assert.equal(result.queued, true)
    assert.equal(db.records.length, 4)
  })

  it('holds the cap at a number, not at a condition', () => {
    assert.equal(Number.isInteger(MAX_QUEUE_RECORDS), true)
    assert.ok(MAX_QUEUE_RECORDS > 0)
  })

  it('runtime.js enqueues through the bounded write', () => {
    const src = code('public/shared/runtime.js')
    assert.match(src, /enqueueRecord\s*\(\s*this\.db\s*,\s*record\s*\)/)
    // The unbounded write must be gone from the enqueue path. `put` is still
    // imported for `retry`, which is a bounded update to a row that exists.
    const enqueueBody = src.slice(src.indexOf('async enqueue('), src.indexOf('async list('))
    assert.doesNotMatch(enqueueBody, /await put\(this\.db, record\)/)
  })

  it('runtime.js reports a full queue as a result, not a throw', () => {
    const src = code('public/shared/runtime.js')
    assert.match(src, /reason:\s*'full'/)
    assert.match(src, /if\s*\(!written\.queued\)/)
  })

  it('the CHW surface says "full" rather than "the queue did not confirm"', () => {
    const src = code('public/chw/app.js')
    assert.match(src, /result\?\.reason\s*===\s*'full'/)
    assert.match(src, /chw\.queue_full/)
  })

  it('the full message is translated, not an English literal', () => {
    for (const locale of ['en', 'so', 'sw']) {
      const catalog = JSON.parse(read(`public/i18n/${locale}.json`))
      assert.ok(catalog['chw.queue_full'], `${locale} must carry chw.queue_full`)
      assert.match(catalog['chw.queue_full'], /\{cap\}/, `${locale} must name the cap`)
    }
  })
})
