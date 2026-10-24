import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { mintSubmissionId, recordIdForSubmission, stampSubmissionId, submissionIdOf } from '../src/submission-id.js'
import { installBrowserEnv } from './browser-env.mjs'

/**
 * ENH-39 — one submission, one record, however many times it is delivered.
 *
 * The load-bearing tests here are the ones that deliver a submission **twice**
 * and count rows, and the one that files two *genuinely separate* reports with
 * identical content and asserts both survive. The first fails on the old
 * implementation (the id hashed the server's arrival time, so the retry was a
 * new record). The second is the test that would fail if someone "fixed" the
 * first by dropping the time from the content hash — a health worker filing for
 * a second child in the same household writes an identical body, and that report
 * must not be swallowed as a duplicate.
 *
 * Neither property alone is the requirement, which is why both are here.
 */

const REPORT = {
  description: 'child with fever for 2 days',
  category: 'fever',
  location: { latitude: 3.1, longitude: 36.5, source: 'gps', accuracy_m: 12 },
  form_id: 'chw_symptom_report',
  form_version: 1,
  answers: { who: 'child', symptom: 'fever', duration_value: 2, duration_unit: 'days' },
  captured_at: '2026-10-11T08:00:00.000Z',
}

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-submission-id-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const post = (body, submissionId) => fetch(`${base}/api/v1/chw/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(submissionId ? { 'idempotency-key': submissionId } : {}),
    },
    body: JSON.stringify(body),
  })
  try {
    return await run({ post, store, base })
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
}

const reports = async (store) => (await store.read()).field_reports || []

/**
 * An IndexedDB handle just real enough for `queue-core.put` to commit into.
 *
 * `put` opens a readwrite transaction, calls `objectStore(...).put(record)` and
 * resolves on `oncomplete`. Every record that reaches this object is one the
 * real `enqueue` decided to store, which is exactly what the test needs to
 * observe — including the headers `enqueue` wrote, which is where the defect was.
 */
function fakeQueueDb(records) {
  return {
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null }
      return {
        ...tx,
        objectStore: () => ({
          put: (record) => {
            records.push({ path: record.path, options: record.options, what: record.what })
            queueMicrotask(() => tx.oncomplete?.())
            return { onsuccess: null, onerror: null }
          },
        }),
        get oncomplete() { return tx.oncomplete },
        set oncomplete(fn) { tx.oncomplete = fn },
        get onerror() { return tx.onerror },
        set onerror(fn) { tx.onerror = fn },
        get onabort() { return tx.onabort },
        set onabort(fn) { tx.onabort = fn },
      }
    },
  }
}

describe('ENH-39 — the client mints one identity per act of filing', () => {
  it('mints a distinct id every time, because two filings are two acts', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintSubmissionId()))
    assert.equal(ids.size, 200, 'a minting function that repeats is not minting an identity')
  })

  it('mints a v4-shaped UUID', () => {
    assert.match(mintSubmissionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('builds the v4 shape by hand when randomUUID is absent', () => {
    // The path that runs on a plain-HTTP LAN origin, where `randomUUID` is
    // undefined in some browsers and only `getRandomValues` is available.
    const scope = { crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i += 1) a[i] = i; return a } } }
    assert.match(mintSubmissionId(scope), /^00010203-0405-4607-8809-0a0b0c0d0e0f$/)
  })

  it('falls back to bytes when randomUUID throws rather than failing the filing', () => {
    const scope = {
      crypto: {
        randomUUID: () => { throw new Error('not a secure origin') },
        getRandomValues: (a) => { for (let i = 0; i < a.length; i += 1) a[i] = i; return a },
      },
    }
    assert.match(mintSubmissionId(scope), /^00010203-0405-4607-8809-0a0b0c0d0e0f$/)
  })

  it('refuses rather than minting from Math.random', () => {
    // A collision here is a report the server silently merges away. Refusing
    // fails the filing loudly, which is the survivable direction.
    assert.throws(() => mintSubmissionId({ crypto: {} }), /no cryptographic source/)
    assert.throws(() => mintSubmissionId({}), /no cryptographic source/)
  })

  it('stamps a body without mutating it, and reuses the id it finds', () => {
    const body = { description: 'x' }
    const first = stampSubmissionId(body)
    assert.equal(body.submission_id, undefined, 'the caller\'s body was mutated')
    assert.equal(first.body.submission_id, first.submission_id)

    const again = stampSubmissionId(first.body)
    assert.equal(again.submission_id, first.submission_id,
      'a second stamp of an already-stamped body minted a new identity, so a retry would duplicate')
  })

  it('derives a record id from the submission id alone, and refuses an empty one', () => {
    assert.equal(recordIdForSubmission('report', 'abc'), recordIdForSubmission('report', 'abc'))
    assert.notEqual(recordIdForSubmission('report', 'abc'), recordIdForSubmission('report', 'abd'))
    assert.equal(recordIdForSubmission('report', null), null)
    assert.equal(recordIdForSubmission('report', ''), null)
    assert.match(recordIdForSubmission('report', 'abc'), /^report_[0-9a-f]{16}$/)
  })
})

describe('ENH-39 — a delivery retried is one record', () => {
  it('writes one record for a submission delivered three times', async () => {
    await withServer(async ({ post, store }) => {
      const { body, submission_id } = stampSubmissionId(REPORT)
      for (let i = 0; i < 3; i += 1) {
        const res = await post(body, submission_id)
        assert.equal(res.status, 201, `delivery ${i} was refused`)
      }
      assert.equal((await reports(store)).length, 1,
        'one submission delivered three times wrote more than one record')
    })
  })

  it('writes one record when the retry carries a key the first attempt never used', async () => {
    // The historical sequence, reproduced exactly: the first attempt goes out
    // with **no** key, its response is lost, and the queued retry arrives with a
    // key the server has never seen — because `enqueue` minted one at the moment
    // it queued. The idempotency store has nothing to match, so the only thing
    // that can dedupe this pair is the identity in the *body*.
    //
    // This is the test that fails if the identity is removed, and it is
    // deliberately not the same-key test above: with one key on both attempts
    // the idempotency store closes the window on its own, and the identity would
    // look load-bearing when it was not.
    await withServer(async ({ post, store }) => {
      const { body } = stampSubmissionId(REPORT)
      const first = await post(body)
      assert.equal(first.status, 201, 'the first attempt, which carries no key at all')
      const retry = await post(body, 'a-key-minted-only-when-the-queue-took-it')
      assert.equal(retry.status, 201)
      assert.equal(retry.headers.get('idempotency-replayed'), null,
        'the retry was replayed by the key, so this test is not exercising the identity')
      const rows = await reports(store)
      assert.equal(rows.length, 1, 'a lost response followed by a queue drain wrote the report twice')
      assert.equal(rows[0].id, recordIdForSubmission('report', body.submission_id))
    })
  })

  it('still files two genuinely separate reports with identical content', async () => {
    // The test that would fail if the fix had been "drop the timestamp from the
    // content hash". Two children in one household, the same symptom, the same
    // coordinates, the same day: two reports.
    await withServer(async ({ post, store }) => {
      const a = stampSubmissionId(REPORT)
      const b = stampSubmissionId(REPORT)
      assert.notEqual(a.submission_id, b.submission_id)
      await post(a.body, a.submission_id)
      await post(b.body, b.submission_id)
      const rows = await reports(store)
      assert.equal(rows.length, 2, 'a genuinely second report was swallowed as a duplicate')
      assert.equal(new Set(rows.map((r) => r.id)).size, 2)
    })
  })

  it('carries the submission id onto the record, so a later reader can see it', async () => {
    await withServer(async ({ post, store }) => {
      const { body, submission_id } = stampSubmissionId(REPORT)
      await post(body, submission_id)
      const [row] = await reports(store)
      assert.equal(submissionIdOf(row), submission_id)
      assert.equal(row.id, recordIdForSubmission('report', submission_id))
    })
  })

  it('files a report with no submission id at all, under a content-derived id', async () => {
    // An older client still files. Its record says `null` rather than claiming
    // an identity it did not have, and it is what makes the pre-ENH-39 records
    // identifiable — the same shape CAP-01 used for `form_version`.
    await withServer(async ({ post, store }) => {
      const res = await post(REPORT)
      assert.equal(res.status, 201)
      const [row] = await reports(store)
      assert.equal(submissionIdOf(row), null)
      assert.match(row.id, /^report_[0-9a-f]{16}$/)
    })
  })
})

describe('ENH-39 — submitOrQueue stamps one identity for both attempts', () => {
  /**
   * Drive the real `submitOrQueue` against a recorded fetch.
   *
   * Behavioural rather than a source assertion, because the property is what the
   * function *sends*, and the previous round of offline tests asserted only that
   * a queue record carries an `idempotency-key` — which was true while the
   * duplicate was live. A canary that removes the stamp has to fail here, and it
   * does not fail anywhere else in the suite.
   */
  const drive = async (failFirst) => {
    const sent = []
    // Captured **before** `installBrowserEnv`, which replaces `globalThis.fetch`
    // with its own stub. Reading it afterwards captures the stub, and restoring
    // that leaves every later test in this file answering real HTTP requests
    // from a literal — which is how this first failed: zero rows, and no error
    // from a server that was never reached.
    const realFetch = globalThis.fetch
    installBrowserEnv({ online: true })
    // Both stubs are installed on `globalThis` and put back afterwards.
    const realQueue = globalThis.window.lindelaQueue
    const queued = []
    try {
      globalThis.fetch = async (url, opts) => {
        sent.push({ url: String(url), headers: opts?.headers || {}, body: JSON.parse(opts?.body || '{}') })
        // The first attempt loses its response. `apiFetch` sees a throw, which is
        // indistinguishable from a request that never arrived — the state the
        // defect was found in.
        if (failFirst && sent.length === 1) throw new Error('the response was lost')
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ success: true }), text: async () => '{}' }
      }
      // The **real** `enqueue`, backed by a fake IndexedDB, not a stub that
      // echoes its argument back.
      //
      // A stub here hid a live defect for one round: `enqueue` overwrote the
      // caller's `idempotency-key` with one it minted itself, so the retry named
      // a submission the server had never seen. A stub that returns what it was
      // handed cannot see that — the record it stores is the thing under test,
      // so the store has to be real enough to hold it.
      const { initOfflineQueue } = await import(new URL('../public/shared/runtime.js', import.meta.url).href)
      await initOfflineQueue()
      globalThis.window.lindelaQueue.db = fakeQueueDb(queued)
      const { submitOrQueue } = await import(new URL('../public/shared/runtime.js', import.meta.url).href)
      await submitOrQueue('/api/v1/chw/report', { description: 'child with fever' }, { what: 'symptom report' })
      return { sent, queued }
    } finally {
      globalThis.fetch = realFetch
      globalThis.window.lindelaQueue = realQueue
    }
  }

  it('stamps the body and the key on the online attempt', async () => {
    const { sent } = await drive(false)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].body.submission_id, 'the body carried no submission id')
    assert.equal(sent[0].headers['idempotency-key'], sent[0].body.submission_id,
      'the key and the body named different submissions, so the server cannot dedupe on either')
  })

  it('carries the same identity into the queue, so the retry is not a new submission', async () => {
    const { sent, queued } = await drive(true)
    assert.equal(sent.length, 1, 'the online attempt did not run')
    assert.equal(queued.length, 1, 'the failed attempt was not queued')
    const queuedBody = queued[0].options.body
    assert.equal(queuedBody.submission_id, sent[0].body.submission_id,
      'the queue minted a new identity for the retry, which is the duplicate-submission defect')
    assert.equal(queued[0].options.headers['idempotency-key'], sent[0].body.submission_id,
      'the queued retry carried a key the first attempt never used')
  })
})

describe('ENH-39 — the operational door honours the same identity', () => {
  it('writes one record for a submission delivered twice through the API', async () => {
    // `field_reports` has two doors and ENH-44 already found that a gate at one
    // of them is not a gate. The same is true of the identity.
    await withServer(async ({ base, store }) => {
      const body = { submission_id: 'op-door-1', summary: 'Borehole dry', incident_id: 'inc-1' }
      const post = () => fetch(`${base}/api/v1/field-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await post()
      await post()
      const rows = await reports(store)
      assert.equal(rows.length, 1, 'the operational door appended a second record for one submission')
      assert.equal(rows[0].id, recordIdForSubmission('report', 'op-door-1'))
    })
  })
})

/**
 * A report with one coordinate axis is not a report with a location.
 *
 * `hasFix` tested `Number.isFinite(Number(body.location?.latitude))`, and
 * `Number(null)` is 0 — so a report carrying a longitude and no latitude passed
 * the test and was stored at (0, lon). The `!(lat === 0 && lon === 0)` guard
 * beside it only catches both axes absent, which is the one case that was never
 * going to happen: a device that loses its latitude fix usually keeps the other.
 *
 * The same expression made an unreported accuracy into `0`, which `assessAccuracy`
 * bands as `precise` — "precise enough to place the report at a household".
 */
describe('a partial fix is not a fix', () => {
  it('does not place a report that carries only a longitude', async () => {
    await withServer(async ({ post, store }) => {
      // `latitude: null`, explicitly. An *omitted* latitude is `undefined`, and
      // `Number(undefined)` is `NaN` — which fails the old `isFinite` test and
      // so never reproduced the bug. A device that loses its fix sends `null`,
      // and `Number(null)` is 0: finite, on the equator, and placed.
      const res = await post({
        description: 'flooding at the school',
        category: 'fever',
        location: { latitude: null, longitude: 36.5, source: 'gps' },
      })
      assert.equal(res.status, 201)
      const [row] = await reports(store)
      assert.equal(row.latitude, null,
        `a report with no latitude was placed at latitude ${row.latitude} — the equator, not where the health worker was`)
      assert.equal(row.longitude, null, 'a half-fix is not a fix, so neither axis is placed')
      // `location_source` still echoes what the device *claimed*. That field is
      // the device's own statement, and the route keeps it so an operator can
      // see a device that reports `gps` while sending one axis — which is the
      // condition this test exists to stop acting on. What must not happen is
      // the coordinate being written.
      assert.equal(row.location_source, 'gps')
    })
  })

  it('does not place a report whose latitude arrived as an empty string', async () => {
    // The other spelling. `Number('')` is 0 as well, so a device that serialised
    // an absent fix as `""` was placed on the equator by the same expression.
    await withServer(async ({ post, store }) => {
      await post({
        description: 'empty latitude',
        category: 'fever',
        location: { latitude: '', longitude: 36.5, source: 'gps' },
      })
      const [row] = await reports(store)
      assert.equal(row.latitude, null, `an empty-string latitude was placed at ${row.latitude}`)
      assert.equal(row.longitude, null)
    })
  })

  it('still places a genuine fix, and still refuses the both-zero placeholder', async () => {
    // The control, both directions. A null-coalescing fix would leave a real fix
    // unplaced; a fix that stopped rejecting the 0/0 placeholder would undo the
    // Null Island guard this route was written with.
    await withServer(async ({ post, store }) => {
      await post({
        description: 'real fix',
        category: 'fever',
        location: { latitude: -1.29, longitude: 36.82, source: 'gps', accuracy_m: 12 },
      })
      await post({
        description: 'placeholder fix',
        category: 'fever',
        location: { latitude: 0, longitude: 0, source: 'gps' },
      })
      const rows = await reports(store)
      const real = rows.find((r) => r.summary === 'real fix')
      const placeholder = rows.find((r) => r.summary === 'placeholder fix')
      // Coarsened to 1/8 of a degree by `coarsenGeoToH3Cell: 3` in the route's
      // request policy, so the assertion is "a fix is placed near here", not the
      // raw device value. `-1.29 / 0.125 = -10.32` → `-10` → `-1.25`; `36.82 / 0.125
      // = 294.56` → `295` → `36.875`.
      assert.equal(real.latitude, -1.25, 'a real fix is placed (coarsened for privacy)')
      assert.equal(real.longitude, 36.875)
      assert.equal(real.location_accuracy_m, 12)
      assert.equal(placeholder.latitude, null, 'the 0/0 placeholder is not a fix')
      assert.equal(placeholder.longitude, null)
    })
  })

  it('records an unreported accuracy as absent, not as zero metres', async () => {
    // `accuracy_m: null` is the device saying it does not know how good the fix
    // is. Stored as 0 it bands as `precise`, the strongest claim the field makes.
    await withServer(async ({ post, store }) => {
      await post({
        description: 'fix with no accuracy',
        category: 'fever',
        location: { latitude: -1.29, longitude: 36.82, source: 'gps', accuracy_m: null },
      })
      const [row] = await reports(store)
      assert.equal(row.latitude, -1.25, 'the fix itself is real')
      assert.equal(row.location_accuracy_m, null,
        `an unreported accuracy was stored as ${row.location_accuracy_m} m, which bands as "precise"`)
    })
  })
})
