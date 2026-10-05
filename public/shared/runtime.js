import { applyLocaleToDocument } from './fmt.js'
let _swRegistration = null

/**
 * Register the service worker once.
 *
 * Exported but previously imported by nobody: the console and focal-point both
 * hand-rolled `navigator.serviceWorker.register('/sw.js')`, and focal-point then
 * called this as well — two registrations for one worker, which the second
 * silently deduplicated, so the bug hid behind working code.
 */
export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (_swRegistration) return _swRegistration
  // `type: 'module'` is load-bearing, not decoration.
  //
  // `sw.js` carries eleven top-level `export` statements (CACHE_POLICIES,
  // classifyApiRequest, shellGraph, evictionPlan, …). Registered as a classic
  // script the browser rejects it at evaluation time, so **no service worker was
  // ever installed**: `precache()` never ran, the three read buckets never
  // existed, Background Sync never registered and `replayQueue()` was
  // unreachable code. Verified in a browser at a secure origin:
  //
  //     register('/sw.js')                  → ServiceWorker script evaluation failed
  //     getRegistrations()                  → 0
  //     register('/sw.js',{type:'module'})  → registered
  //
  // Three later offline commits hardened that worker, one of them shipped
  // ENH-22. Nothing caught it because `.catch(() => null)` made the failure
  // indistinguishable from "this browser has no service workers", and because
  // the test suite imports `sw.js` as a Node ESM module — which works, since
  // Node honours the module syntax the browser rejects.
  //
  // Floor: module workers need Chrome 91 / Safari 15.4 / Firefox 111. Every
  // module in this codebase is ESM and `sw.js` is already written to be
  // importable from Node, so this is the aligned choice — but the floor is
  // real, so the failure is now reported rather than swallowed.
  _swRegistration = navigator.serviceWorker
    .register('/sw.js', { type: 'module' })
    .then((registration) => {
      window.__lindelaSW = { state: 'registered', scope: registration.scope }
      return registration
    })
    .catch((error) => {
      // Recorded, not swallowed. A device with no offline support must be able
      // to say so, or an operator has no way to explain to a health worker why
      // their reports are not waiting for signal.
      window.__lindelaSW = {
        state: 'failed',
        error: error?.message || String(error),
        moduleWorkersUnsupported: /module|import|export/i.test(error?.message || ''),
      }
      console.error('Service worker registration failed; offline support is unavailable.', error)
      return null
    })
  return _swRegistration
}

export function initOfflineBanner() {
  const banner = document.getElementById('offlineBanner')
  const updateStatus = () => {
    if (banner) {
      banner.hidden = navigator.onLine
    }
  }
  window.addEventListener('online', updateStatus)
  window.addEventListener('offline', updateStatus)
  updateStatus()
}

export async function initOfflineQueue() {
  window.lindelaQueue = {
    pending: [],
    db: null,
    async init() {
      return new Promise((resolve) => {
        if (!('indexedDB' in window)) {
          resolve()
          return
        }
        const req = window.indexedDB.open('lindela_queue', 1)
        req.onupgradeneeded = (e) => {
          const db = e.target.result
          if (!db.objectStoreNames.contains('requests')) {
            db.createObjectStore('requests', { keyPath: 'id', autoIncrement: true })
          }
        }
        req.onsuccess = () => {
          this.db = req.result
          resolve()
        }
        req.onerror = () => resolve()
      })
    },
    /**
     * Persist a request for later replay.
     *
     * This used to be `if (!this.db) return` followed by a fire-and-forget
     * `store.add`, so both an unavailable IndexedDB (private mode, storage
     * pressure, a blocked upgrade) and a failed write resolved successfully:
     * the caller showed the health worker "Report queued", reset the wizard,
     * and the report existed nowhere. `flush()` had already been hardened
     * against exactly this; the write path had not.
     *
     * It now throws unless the record is committed, and returns
     * `{ queued: true, id }` when it is. A queued report is a report the user
     * still has to send, and the only way to say so honestly is for the store
     * to confirm it before anyone is told anything.
     */
    async enqueue(path, options, meta = {}) {
      if (!this.db) {
        throw new Error('This device has no offline storage, so the report was not saved')
      }
      // Minted here, before the write, and carried into the request headers.
      //
      // The queue used to rely on IndexedDB's autoIncrement key, which is only
      // known after the write completes — so the id could not be sent with the
      // request. It is now the idempotency key, which is what makes replay
      // safe: two drains that both hold this record send the same key, and the
      // server answers the second with the first's receipt instead of creating
      // a second field report for one health worker's observation.
      //
      // `randomUUID` rather than a counter: the key leaves the device and is
      // compared by a server that has never seen this client, so it has to be
      // unique rather than merely locally sequential.
      const id = (globalThis.crypto?.randomUUID
        ? crypto.randomUUID()
        : `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
      const headers = { ...(options?.headers || {}), 'idempotency-key': id }
      const record = {
        id,
        path,
        options: { ...options, headers },
        timestamp: Date.now(),
        what: meta.what || null,
        attempts: 0,
        lastError: null,
      }
      try {
        const tx = this.db.transaction(['requests'], 'readwrite')
        const store = tx.objectStore('requests')
        await new Promise((resolve, reject) => {
          // Transaction completion, not the request's own success: a quota
          // error or a constraint violation aborts the transaction after the
          // request has already reported success, and a record the store then
          // drops must not read as saved.
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error || new Error('The offline queue write was aborted'))
          tx.onerror = () => reject(tx.error || new Error('The offline queue write failed'))
          const req = store.add(record)
          req.onerror = () => reject(req.error || new Error('The offline queue write failed'))
        })
      } catch (error) {
        throw new Error(error?.message || 'The offline queue write failed')
      }
      window.dispatchEvent(new CustomEvent('lindela-queue-changed'))
      // Ask the service worker to register a Background Sync. The page flushes
      // on `online`, on an interval and on load, but none of those fire if the
      // tab is closed before connectivity returns — and a health worker closing
      // the app is normal, not an edge case. Best effort: unsupported in some
      // browsers and non-secure contexts, where the in-page flush still applies.
      // Best effort, and bounded.
      //
      // This used to `await navigator.serviceWorker.ready` with no timeout. On a
      // device whose worker is not yet controlling the page — which is every
      // device, offline, before the first claim — `ready` does not settle, so
      // `enqueue` never returned. A health worker filing a report with no
      // signal got no save, no toast and no screen change: the press did
      // nothing at all.
      //
      // The IndexedDB write above is what matters and has already committed.
      // Registering a background sync is an optimisation on top of it, so it
      // gets a bounded wait and its failure is ignored.
      await Promise.race([
        (async () => {
          const reg = await navigator.serviceWorker?.ready
          if (reg?.sync) await reg.sync.register('lindela-queue')
        })().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ])
      return { queued: true, id }
    },

    /**
     * What is waiting, and what has given up.
     *
     * The count was the entire surface: a health worker whose reports had not
     * sent had a number and no way to learn what it referred to, when it was
     * filed, or why it was stuck. Returns the records themselves so the surface
     * can list them, oldest first — a week offline produces a week of rows and
     * the oldest is the one most likely to have been forgotten.
     */
    async list({ failed = false } = {}) {
      if (!this.db) return []
      try {
        const tx = this.db.transaction(['requests'], 'readonly')
        const records = await new Promise((resolve, reject) => {
          const req = tx.objectStore('requests').getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => reject(req.error || new Error('The offline queue could not be read'))
        })
        return records
          .filter((r) => Boolean(r?.failed) === Boolean(failed))
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      } catch {
        return []
      }
    },

    /** Put a failed record back in the queue for another attempt. */
    async retry(id) {
      if (!this.db) return false
      const tx = this.db.transaction(['requests'], 'readwrite')
      const store = tx.objectStore('requests')
      await new Promise((resolve, reject) => {
        const get = store.get(id)
        get.onsuccess = () => {
          if (!get.result) { resolve(); return }
          store.put({ ...get.result, failed: false, attempts: 0, lastError: null })
        }
        get.onerror = () => reject(get.error)
      })
      window.dispatchEvent(new CustomEvent('lindela-queue-changed'))
      return true
    },

    /** Discard a record. The worker asked for this; it is not a quiet removal. */
    async discard(id) {
      if (!this.db) return false
      const tx = this.db.transaction(['requests'], 'readwrite')
      tx.objectStore('requests').delete(id)
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      window.dispatchEvent(new CustomEvent('lindela-queue-changed'))
      return true
    },
    /** How many reports are waiting to send. Surfaced so the promise is visible. */
    async pendingCount() {
      if (!this.db) return 0
      try {
        const tx = this.db.transaction(['requests'], 'readonly')
        return await new Promise((resolve) => {
          const req = tx.objectStore('requests').count()
          req.onsuccess = () => resolve(req.result || 0)
          req.onerror = () => resolve(0)
        })
      } catch {
        return 0
      }
    },

    /**
     * Replay queued requests.
     *
     * This existed but was never called from anywhere, so a report queued while
     * offline sat in IndexedDB forever. The CHW app told the health worker
     * "Queued (will send when connected)" and the report was silently lost —
     * the UI made a promise the code never kept.
     *
     * Returns the number of records attempted, and never throws: a failing
     * request must stay queued for the next cycle rather than break the cycle.
     */
    async flush() {
      // `navigator.onLine` is a link-layer flag, not reachability. A captive
      // portal, an uplink that answers TCP but not HTTP, or a blackholed
      // resolver all report `onLine === true`, and gating the drain on it
      // meant the queue sat full while the browser insisted it was online.
      // Kept as a cheap early-out only — never as the condition for *saving*,
      // which is `submitOrQueue`'s job and no longer reads this flag.
      if (!this.db || navigator.onLine === false) return 0
      // One drain at a time. The service worker's own replay path was removed
      // precisely because two drains could hold the same record, both POST it,
      // and both delete it — two field reports for one observation. A second
      // guard here costs nothing and closes the same hole from this side.
      if (this._draining) return 0
      this._draining = true
      let records
      try {
        const tx = this.db.transaction(['requests'], 'readonly')
        records = await new Promise((resolve) => {
          const req = tx.objectStore('requests').getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => resolve([])
        })
      } catch {
        this._draining = false
        return 0
      }
      let sent = 0
      let gaveUp = 0
      for (const record of records) {
        if (record?.failed) continue
        const attempts = (record.attempts || 0) + 1
        try {
          await apiFetch(record.path, record.options)
          const delTx = this.db.transaction(['requests'], 'readwrite')
          delTx.objectStore('requests').delete(record.id)
          sent += 1
        } catch (error) {
          // Still failing: keep it, count the attempt, and — after enough of
          // them, or on a rejection that will never succeed — move it aside
          // rather than retrying forever.
          //
          // A record the server permanently rejects (a 400 on a bad district
          // slug, a 422 on a stale schema) used to be retried on every 30s tick
          // for the life of the install, was never surfaced, and could not be
          // discarded — so `pendingCount` stayed inflated permanently and the
          // banner kept promising delivery of something that would never go.
          const permanent = Number(error?.status) >= 400 && Number(error?.status) < 500
          if (permanent || attempts >= MAX_QUEUE_ATTEMPTS) {
            const failTx = this.db.transaction(['requests'], 'readwrite')
            failTx.objectStore('requests').put({
              ...record,
              attempts,
              failed: true,
              lastError: error?.message || String(error),
              failedAt: new Date().toISOString(),
            })
            gaveUp += 1
            continue
          }
          const retryTx = this.db.transaction(['requests'], 'readwrite')
          retryTx.objectStore('requests').put({ ...record, attempts, lastError: error?.message || null })
        }
      }
      this._draining = false
      this.lastFlush = { at: new Date().toISOString(), attempted: records.length, sent, gaveUp }
      window.dispatchEvent(new CustomEvent('lindela-queue-flushed', { detail: this.lastFlush }))
      return records.length
    },
  }
  await window.lindelaQueue.init()

  // Replay on reconnect, and periodically while connected, because a link can
  // come back without the browser firing `online` — and because a request queued
  // while the tab was closed has no event to wait for at all.
  const queue = window.lindelaQueue
  window.addEventListener('online', () => { queue.flush() })
  setInterval(() => { queue.flush() }, 30_000)
  queue.flush()
}

/**
 * Attempts before a queued record is moved aside.
 *
 * Not infinite, and not few: a health worker's report failing eight times over
 * days is usually a link that has been down, and a record that gave up after
 * three would lose a week's work to one bad afternoon.
 */
export const MAX_QUEUE_ATTEMPTS = 8

/**
 * How long to try before assuming the link is down.
 *
 * Short, because the record is going into a durable queue either way and the
 * health worker is waiting on a tap. Long enough to cover a slow cell handover.
 */
export const QUEUE_TRY_TIMEOUT_MS = 8_000

/** Default request timeout. Long enough for a satellite hop, short enough
 *  that a dead link surfaces as an error rather than a spinner that never ends. */
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * The one HTTP call in the codebase.
 *
 * Every surface had its own copy of this, and `parametric/app.js:5-10` was a
 * verbatim clone under the same name. The copies that skipped `res.ok` — the
 * console's own `fetchJson`, and every call in `co` and `districts` — treated a
 * 503 from the service worker's offline fallback as a valid body, so a
 * disconnected console rendered silently stale data with no error shown.
 *
 * `signal` combines a caller-supplied signal with the timeout, so a caller can
 * still cancel a refresh that is no longer wanted.
 */
export async function apiFetch(path, { method = 'GET', body, headers = {}, token, timeout = REQUEST_TIMEOUT_MS, signal } = {}) {
  const opts = { method, headers: { ...headers } }
  if (body !== undefined && body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body)
    opts.headers['content-type'] = 'application/json'
  }
  if (token) {
    opts.headers['authorization'] = `Bearer ${token}`
  }
  if (timeout > 0 || signal) {
    // AbortSignal.any rejects a non-signal member, and `signal` is undefined on
    // every ordinary call — so the caller's signal is filtered, not passed bare.
    const signals = []
    if (signal) signals.push(signal)
    if (timeout > 0) signals.push(AbortSignal.timeout(timeout))
    opts.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  }

  const res = await fetch(path, opts)
  // Read the staleness before the ok check. The service worker marks a response
  // it served from its offline cache, and that marker is the only difference
  // between "the server said this" and "this is what the server last said" —
  // so a caller that cannot see it makes confident claims from old data.
  //
  // It was read on the error path and dropped on the success path, which is
  // backwards: the failure was already visible (the request threw) and the cached
  // success was not. Found by the dead-server gate, where the partner portal
  // answered "Authentication is not configured" — a claim about the server's
  // configuration — while the server was dead and the service worker was
  // cheerfully answering from its API bucket.
  // `?.get?.` rather than `.get`: a caller may pass a response-shaped object
  // rather than a Response — the test suite's router does, and any caller of
  // `apiFetch` behind a service worker may. `sanitizeHeaders` and
  // `parseRetryAfter` in this codebase read headers the same way for the same
  // reason, and reading them strictly broke three CO dashboard tests the moment
  // this was added.
  const servedFromCache = res.headers?.get?.('x-lindela-offline') === '1'
    || res.headers?.get?.('x-lindela-cache') === 'hit'
  const storedAt = res.headers?.get?.('x-lindela-stored-at') || null

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    err.offline = servedFromCache
    err.storedAt = storedAt
    try {
      err.json = await res.json()
    } catch {
      err.json = null
    }
    throw err
  }
  const payload = await res.json()
  return markReadProvenance(payload, { servedFromCache, storedAt })
}

/**
 * Say where a payload came from, without changing its shape for callers that
 * ignore it.
 *
 * Non-enumerable, because these payloads are spread, serialised and compared all
 * over the front end: an enumerable `_fromCache` would turn up in `JSON.stringify`
 * of a rendered record and in every deep-equality assertion downstream. A caller
 * that wants to know asks.
 */
export function markReadProvenance(body, { servedFromCache = false, storedAt = null } = {}) {
  if (!body || typeof body !== 'object') return body
  try {
    Object.defineProperty(body, '__provenance', {
      value: { servedFromCache, storedAt },
      enumerable: false,
      configurable: true,
    })
  } catch {
    // A frozen payload from a worker is not worth failing a read over.
  }
  return body
}

/** What a caller can say about a payload's origin, if it asks. */
export function readProvenance(body) {
  const provenance = body?.__provenance
  return {
    servedFromCache: Boolean(provenance?.servedFromCache),
    storedAt: provenance?.storedAt || null,
    live: !provenance?.servedFromCache,
  }
}

/**
 * apiFetch that reports failure as null instead of throwing.
 *
 * For the console and CO dashboard, where twelve independent panels render and
 * one dead endpoint must not blank the other eleven.
 */
export async function apiSettled(path, options) {
  try {
    return await apiFetch(path, options)
  } catch {
    return null
  }
}

/**
 * Submit now, or queue for replay when there is no connection.
 *
 * Online writes go straight through. Offline writes go to IndexedDB, where the
 * service worker's `replayQueue` picks them up — either on Background Sync or on
 * the page's own flush. Returns `{queued: true, id}` only once the store has
 * committed the record; a queue that could not take it throws, because the
 * caller has a report in hand that has not been filed and must be told so.
 */
export async function submitOrQueue(path, body, { headers, what = null } = {}) {
  // Try first; queue on failure.
  //
  // This was `if (navigator.onLine) return apiFetch(...)` else queue. That reads
  // the browser's opinion of the link, and on a captive portal, an uplink that
  // completes the TCP handshake but returns nothing for HTTP, or a field handset
  // with a blackholed resolver, `onLine` is `true` and the request throws —
  // after which the caller told the health worker the report "will wait on this
  // phone". Nothing had been written. The worker was told a promise the code
  // had not made.
  // Skip the *attempt* when the browser already says there is no link — to avoid
  // spending the timeout on a request that cannot leave. `onLine === false` is
  // reliable in the direction it is used for here, and unreliable in the other,
  // which is why it never decides anything about whether to save.
  if (navigator.onLine === false) {
    return queueTheReport(path, body, headers, what, 'the device reports no connection')
  }
  try {
    return await apiFetch(path, { method: 'POST', body, headers, timeout: QUEUE_TRY_TIMEOUT_MS })
  } catch (error) {
    return queueTheReport(path, body, headers, what, error?.message || 'the request did not get through')
  }
}

/** The one place a report that could not be sent becomes a durable record. */
async function queueTheReport(path, body, headers, what, reason) {
  if (window.lindelaQueue) {
    const queued = await window.lindelaQueue.enqueue(
      path, { method: 'POST', body, headers }, { what },
    )
    return { ...queued, queuedBecause: reason }
  }
  throw new Error(
    `The report could not be sent (${reason}) and this device has no offline queue, so it was not saved.`,
  )
}

export async function initI18n(defaultLocale = 'en') {
  const catalog = {}
  const i18n = {
    current: defaultLocale,
    catalog,
    t(key, params = {}) {
      let text = catalog[key] || key
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), value)
      }
      return text
    },
    /**
     * Switch locale, layering it over English.
     *
     * This used to merge the new locale into whatever was already in the shared
     * catalogue, so switching en -> so -> fr left Somali strings behind for every
     * key French did not define: switching was neither idempotent nor reversible.
     * English is now re-read as the base each time, so the result depends only on
     * which locale is selected and not on the path taken to get there.
     */
    /**
     * Apply `lang` and `dir` on every switch, not just at load. A locale change
     * that left `dir="ltr"` on an Arabic page produced a right-to-left language
     * laid out left-to-right — which is worse than not offering Arabic at all,
     * because it looks finished.
     */
    async set(locale) {
      // Apply lang and dir on every switch, not just at load. A locale change
      // that left dir="ltr" on an Arabic page produced a right-to-left
      // language laid out left-to-right, which is worse than not offering
      // Arabic at all because it looks finished.
      applyLocaleToDocument(locale)
      const base = {}
      try {
        const res = await fetch('/i18n/en.json')
        if (res.ok) Object.assign(base, await res.json())
      } catch {
        // Keep whatever we have.
      }
      for (const key of Object.keys(catalog)) delete catalog[key]
      Object.assign(catalog, base)
      if (locale !== 'en') {
        try {
          const res = await fetch(`/i18n/${locale}.json`)
          if (res.ok) Object.assign(catalog, await res.json())
        } catch {
          // Keep the English layer.
        }
      }
      this.current = locale
      applyI18n()
    },
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      el.textContent = i18n.t(key)
    })
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title')
      el.title = i18n.t(key)
    })
  }

  // R-62/R-63. Boot goes through the same two-step as a locale switch, so
  // English is the base layer even at load: a partial catalogue falls back to
  // English rather than to its own key ids, and `lang`/`dir` are set from the
  // first paint. Loading the requested locale alone left a Somali or Amharic
  // page rendering raw key names for everything that file had not translated —
  // which is also what `scripts/check-i18n-offers.mjs`'s floor assumes and
  // never got.
  await i18n.set(defaultLocale)
  window.__i18n = i18n
  return i18n
}

export function t(key, params = {}) {
  if (!window.__i18n) return key
  return window.__i18n.t(key, params)
}

/**
 * Make every horizontally scrollable region reachable by keyboard.
 *
 * `overflow-x: auto` gives a mouse wheel and a scrollbar and nothing else: with
 * no focusable descendant the region is unreachable from the keyboard, so a wide
 * table can be seen but not read. WCAG 2.1.1, and axe reports it as
 * `scrollable-region-focusable` on every surface with a wide table.
 *
 * Done as a sweep rather than at each construction site because the wrappers are
 * created in eight places and this is a property of the rendered result.
 *
 * Skips a region that already holds something focusable — an interactive table
 * does not need a tab stop of its own, and adding one is noise in the tab ring.
 */
/**
 * Keep the sweep running, so a table added by the next refresh is covered.
 *
 * `markScrollableRegions` existed and was imported by nobody: eight surfaces
 * each call it never, and axe reported `scrollable-region-focusable` on ten
 * regions across the product — a table a keyboard can see and cannot reach.
 * Calling it once at boot fixes the tables that exist at boot and nothing that
 * arrives afterwards, which on a console that redraws every thirty seconds is
 * almost nothing.
 *
 * So it observes, debounced. A mutation burst is one sweep, not one per node:
 * a 30-second refresh replaces a panel's contents in a few hundred mutations,
 * and sweeping each would be work proportional to the wrong thing. The sweep
 * itself is cheap and skips anything already marked, so an unchanged region is
 * two attribute lookups.
 */
let _scrollObserver = null

export function autoMarkScrollableRegions(root = typeof document !== 'undefined' ? document.body : null) {
  // No MutationObserver, or no body to watch: nothing to do.
  //
  // Not defensive for its own sake. `test/falsy-zero.test.js` loads `app.js`
  // into a `vm` to pull `evaluateMapFilters` out of it, and this module is
  // evaluated at the top level there. A boot-time `new MutationObserver(...)`
  // threw `ReferenceError: MutationObserver is not defined` inside that test's
  // `before` hook, which failed the whole map-filter suite for a reason that had
  // nothing to do with what it tests. A shared helper that assumes a browser
  // cannot be imported by a Node test, and this one has to be.
  if (typeof MutationObserver === 'undefined') return
  if (!root || !root.addEventListener) return
  if (_scrollObserver) return
  let pending = false
  const sweep = () => {
    if (pending) return
    pending = true
    // A microtask would coalesce one task's mutations; a short timer also
    // coalesces across the synchronous innerHTML writes a render performs, and
    // runs after the browser has laid the new table out — which is when the
    // overflow that decides whether it needs a tab stop actually exists.
    setTimeout(() => {
      pending = false
      markScrollableRegions(document)
    }, 0)
  }
  _scrollObserver = new MutationObserver(sweep)
  _scrollObserver.observe(root, { childList: true, subtree: true })
  sweep()
}

/** Stop the sweep. Exported for tests; nothing in the product needs it. */
export function stopAutoMarkScrollableRegions() {
  _scrollObserver?.disconnect()
  _scrollObserver = null
}

export function markScrollableRegions(root = document) {
  const candidates = root.querySelectorAll('.table-wrap, .chart-table, [data-scrollable]')
  for (const el of candidates) {
    if (el.hasAttribute('tabindex')) continue
    if (el.querySelector('a[href], button, input, select, textarea, [tabindex]')) continue

    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    if (!/(auto|scroll)/.test(style.overflowX)) continue

    el.setAttribute('tabindex', '0')
    el.setAttribute('role', 'region')
    if (!el.hasAttribute('aria-label')) {
      const heading = el.querySelector('caption, h2, h3')
      const label = heading?.textContent?.trim()
      el.setAttribute('aria-label', label
        ? `${label} — scrollable table`
        : 'Scrollable table')
    }
  }
}
