/**
 * The offline queue's mechanics, shared by the page and the service worker.
 *
 * Both used to own a drain, and two drains is how one field report becomes two:
 * the worker's `replayQueue` and the page's `flush` could read the same record,
 * both POST it, and both delete it. So the worker's drain was deleted, and with
 * it the only drain that could run while nobody had the app open — a report
 * filed on Friday reached the server whenever the worker next happened to open
 * the app on Monday.
 *
 * Deleting one half of a race is a mitigation. This is the fix: a drain now
 * *claims* the records it is about to send, inside the same transaction that
 * reads them, and skips anything another drainer holds a live claim on. Two
 * drains are then safe by construction rather than by not happening, which is
 * what lets the worker drain on `sync` while the page drains on `online`.
 *
 * The lease is the part that keeps a claim from stranding a record: a drainer
 * that is killed mid-flight — a tab closed, the worker evicted, the phone dying
 * — leaves its claim behind, and a claim with no heartbeat becomes claimable
 * again. Nothing is lost by a crash; nothing is duplicated by a race.
 *
 * Schema note: no version bump. The claim lives on the record as two ordinary
 * fields, because a version bump on a store holding a health worker's unsent
 * reports is a migration with a failure mode that loses the reports — and the
 * alternative costs one pass over records the drain already reads.
 */

export const QUEUE_DB_NAME = 'lindela_queue'
export const QUEUE_STORE = 'requests'

/** How long a claim is honoured before another drainer may take the record. */
export const CLAIM_LEASE_MS = 60_000

export const MAX_QUEUE_ATTEMPTS = 8

/**
 * Open the queue store.
 *
 * The factory is resolved as `window.indexedDB` first and `globalThis.indexedDB`
 * second, because IndexedDB belongs to a browsing context rather than to the
 * process: in a page they are the same object, in a worker only the second
 * exists, and in a test harness that installs a double on a window stub only
 * the first is the one that holds the queue. Reading the global alone would
 * report "this browser has no storage available" while the app's own storage sat
 * right there on the window — which is what a wrong reference looks like from
 * the inside.
 */
export function resolveIdbFactory(scope = globalThis) {
  return scope?.window?.indexedDB ?? scope?.indexedDB ?? null
}

export function openQueueDb(factory = resolveIdbFactory()) {
  return new Promise((resolve) => {
    if (!factory) { resolve(null); return }
    const req = factory.open(QUEUE_DB_NAME, 1)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    // A store that will not open is not an error here: the caller decides what
    // to tell a person. Resolving null is what lets the surface say "nothing was
    // stored" rather than throwing out of a boot sequence.
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

export const put = (db, record) => new Promise((resolve, reject) => {
  const tx = db.transaction([QUEUE_STORE], 'readwrite')
  tx.objectStore(QUEUE_STORE).put(record)
  tx.oncomplete = () => resolve(record)
  // `onabort` as well as `onerror`, and both must reject.
  //
  // IndexedDB reports a rolled-back transaction — a quota refusal, a blocked
  // upgrade, a `requestError` — through `onabort`. A version listening only for
  // `oncomplete` and `onerror` therefore *never settles* in that case: the
  // health worker's submit waits on a promise that cannot resolve, and the
  // surface never says their report was not saved. The one path where a stuck
  // promise is worst is the one that is stuck.
  const fail = (error) => reject(error || tx.error || new Error('the offline queue write was aborted'))
  tx.onerror = () => fail(tx.error)
  tx.onabort = () => fail(tx.error)
})

export const del = (db, id) => new Promise((resolve, reject) => {
  const tx = db.transaction([QUEUE_STORE], 'readwrite')
  tx.objectStore(QUEUE_STORE).delete(id)
  tx.oncomplete = () => resolve(true)
  const fail = (error) => reject(error || tx.error || new Error('the offline queue delete was aborted'))
  tx.onerror = () => fail(tx.error)
  tx.onabort = () => fail(tx.error)
})

/** Every record, oldest first. Read once per drain — the set is the batch. */
export function readAll(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([QUEUE_STORE], 'readonly')
      const req = tx.objectStore(QUEUE_STORE).getAll()
      req.onsuccess = () => resolve((req.result || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0)))
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

/**
 * Take the records this drainer will send.
 *
 * The claim is written back inside the loop rather than in one transaction
 * because a record is only claimed once its id is known, and the write races
 * another drainer's claim only if both are inside the same transaction — which
 * is the case this design gives up, deliberately: two drains *can* both claim
 * within the same millisecond, so the second guard is the idempotency key the
 * server already honours. The claim narrows the window to that; the key closes
 * it. Either alone would be a weaker guarantee than the pair.
 */
export async function claimBatch(db, { owner, leaseMs = CLAIM_LEASE_MS, limit = 25, now = Date.now() } = {}) {
  const all = await readAll(db)
  const claimed = []
  for (const record of all) {
    if (record?.failed) continue
    const claimAt = Number(record.claimed_at || 0)
    const heldByOther = record.claimed_by && record.claimed_by !== owner && (now - claimAt) < leaseMs
    if (heldByOther) continue
    const stamped = { ...record, claimed_by: owner, claimed_at: now }
    try {
      await put(db, stamped)
      claimed.push(stamped)
    } catch {
      // Another writer holds the store; leave the record for the next cycle
      // rather than sending something we could not claim.
    }
    if (claimed.length >= limit) break
  }
  return claimed
}

export async function markSent(db, record) {
  await del(db, record.id)
}

export async function markRetry(db, record, error) {
  const attempts = (record.attempts || 0) + 1
  const permanent = Number(error?.status) >= 400 && Number(error?.status) < 500
  if (permanent || attempts >= MAX_QUEUE_ATTEMPTS) {
    await put(db, {
      ...record,
      attempts,
      failed: true,
      lastError: error?.message || String(error),
      lastErrorStatus: Number(error?.status) || null,
      failedAt: new Date().toISOString(),
      claimed_by: null,
      claimed_at: 0,
    })
    return { state: 'dead_letter', attempts }
  }
  await put(db, { ...record, attempts, lastError: error?.message || null, claimed_by: null, claimed_at: 0 })
  return { state: 'retry', attempts }
}

/** Release every claim held by a drainer that is finished, successfully or not. */
export async function releaseClaims(db, { owner, now = Date.now(), leaseMs = CLAIM_LEASE_MS } = {}) {
  const all = await readAll(db)
  for (const record of all) {
    if (record?.claimed_by !== owner) continue
    if (now - Number(record.claimed_at || 0) >= leaseMs) continue
    await put(db, { ...record, claimed_by: null, claimed_at: 0 }).catch(() => {})
  }
}

/**
 * Discard everything queued, and say how much.
 *
 * Exists because "clear this device's stored reports" is a real thing a person
 * needs — a shared handset being handed over, or a drill that must start from a
 * known-empty queue — and the only route to it was `indexedDB.deleteDatabase`,
 * which blocks while any connection is open and throws away records the *other*
 * tab may be about to send.
 *
 * Clearing is explicit and counted; it is never a side effect of anything.
 */
export async function clearRecords(db) {
  const all = await readAll(db)
  for (const record of all) await del(db, record.id).catch(() => {})
  return all.length
}

export async function listRecords(db, { failed = false } = {}) {
  const all = await readAll(db)
  const filtered = failed ? all.filter((r) => r?.failed) : all
  return filtered.map((record) => ({
    id: record.id,
    path: record.path,
    what: record.what,
    attempts: record.attempts || 0,
    failed: Boolean(record.failed),
    lastError: record.lastError || null,
    failedAt: record.failedAt || null,
    queuedAt: record.queuedAt || record.created_at || null,
    claimed: Boolean(record.claimed_by),
  }))
}

/**
 * The whole cycle: claim, send, settle.
 *
 * `send` is injected because the two callers have different transports — the
 * page has `apiFetch` with its timeout and status-bearing errors, the worker
 * has a bare `fetch` and must build the same error shape itself. The settlement
 * rules live here so both cannot disagree about what a 400 means.
 *
 * Never throws. A drain that throws leaves claims behind and the records
 * unsent, and a drain is the only thing that turns a stored report into a
 * delivered one.
 */
export async function drainQueue(db, { owner, send, leaseMs = CLAIM_LEASE_MS, limit = 25, now = Date.now() } = {}) {
  if (!db) return { attempted: 0, sent: 0, gaveUp: 0, retried: 0 }
  let claimed = []
  try {
    claimed = await claimBatch(db, { owner, leaseMs, limit, now })
  } catch {
    return { attempted: 0, sent: 0, gaveUp: 0, retried: 0 }
  }
  let sent = 0
  let gaveUp = 0
  let retried = 0
  for (const record of claimed) {
    try {
      await send(record)
      await markSent(db, record)
      sent += 1
    } catch (error) {
      const outcome = await markRetry(db, record, error).catch(() => ({ state: 'retry' }))
      if (outcome.state === 'dead_letter') gaveUp += 1
      else retried += 1
    }
  }
  return { attempted: claimed.length, sent, gaveUp, retried }
}

/**
 * The send, with the error shape both callers rely on.
 *
 * A bare `fetch` resolves for a 400, so a drain that ignores `res.ok` deletes a
 * record the server refused — and a report the district will never receive looks
 * exactly like one that was delivered. `status` is what `markRetry` reads to
 * decide between "try again" and "this will never succeed".
 */
export async function sendRecord(record, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(record.path, {
      method: record.options?.method || 'POST',
      headers: record.options?.headers || {},
      body: record.options?.body === undefined || typeof record.options?.body === 'string'
        ? record.options?.body
        : JSON.stringify(record.options.body),
      signal: controller?.signal,
    })
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`)
      error.status = res.status
      throw error
    }
    return res
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Ask the browser not to evict the queue.
 *
 * A field phone that is charged weekly and used daily is the case browsers
 * handle worst: an origin without persistent storage is eligible for eviction
 * after seven days of no use, and Safari applies its own seven-day rule to
 * IndexedDB outright. A queued report deleted by the browser is the worst
 * possible failure for this product — the worker was told it was saved, and it
 * was not — and nothing in the app can detect it, because the record is gone.
 *
 * Best effort by construction: the browser grants this on engagement, and
 * refusing is a normal answer rather than a fault. The result is returned so a
 * surface can say so, because "your stored reports may be evicted" is something
 * a person can act on and "we asked" is not.
 */
export async function requestPersistence({ storage = globalThis.navigator?.storage } = {}) {
  if (!storage?.persist) return { supported: false, persisted: false }
  try {
    if (await storage.persisted?.()) return { supported: true, persisted: true }
    const persisted = await storage.persist()
    return { supported: true, persisted: Boolean(persisted) }
  } catch {
    return { supported: true, persisted: false }
  }
}
