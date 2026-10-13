import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  enqueueRecord, readAll, MAX_QUEUE_RECORDS,
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
          const at = records.findIndex((r) => r.id === id)
          if (at >= 0) records.splice(at, 1)
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
