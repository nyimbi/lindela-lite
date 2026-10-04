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
  _swRegistration = navigator.serviceWorker.register('/sw.js').catch(() => null)
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
    async enqueue(path, options) {
      if (!this.db) {
        throw new Error('This device has no offline storage, so the report was not saved')
      }
      let id
      try {
        const tx = this.db.transaction(['requests'], 'readwrite')
        const store = tx.objectStore('requests')
        id = await new Promise((resolve, reject) => {
          let key
          // Transaction completion, not the request's own success: a quota
          // error or a constraint violation aborts the transaction after the
          // request has already reported success, and a record the store then
          // drops must not read as saved.
          tx.oncomplete = () => resolve(key)
          tx.onabort = () => reject(tx.error || new Error('The offline queue write was aborted'))
          tx.onerror = () => reject(tx.error || new Error('The offline queue write failed'))
          const req = store.add({ path, options, timestamp: Date.now() })
          req.onsuccess = () => {
            key = req.result
          }
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
      if (!this.db || !navigator.onLine) return 0
      let records
      try {
        const tx = this.db.transaction(['requests'], 'readonly')
        records = await new Promise((resolve) => {
          const req = tx.objectStore('requests').getAll()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => resolve([])
        })
      } catch {
        return 0
      }
      let sent = 0
      for (const record of records) {
        try {
          await apiFetch(record.path, record.options)
          const delTx = this.db.transaction(['requests'], 'readwrite')
          delTx.objectStore('requests').delete(record.id)
          sent += 1
        } catch {
          // Still failing: keep it queued and try again next cycle.
        }
      }
      this.lastFlush = { at: new Date().toISOString(), attempted: records.length, sent }
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
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    // The service worker marks a response it served from its offline cache.
    // Callers need to say "this is the last known state" rather than "this is
    // current", so the flag is carried through rather than discarded.
    err.offline = res.headers.get('x-lindela-offline') === '1'
    try {
      err.json = await res.json()
    } catch {
      err.json = null
    }
    throw err
  }
  return res.json()
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
export async function submitOrQueue(path, body, { headers } = {}) {
  if (navigator.onLine) return apiFetch(path, { method: 'POST', body, headers })
  if (window.lindelaQueue) {
    return window.lindelaQueue.enqueue(path, { method: 'POST', body, headers })
  }
  throw new Error('Offline and no queue is available')
}

export async function initI18n(defaultLocale = 'en') {
  const catalog = {}
  try {
    const res = await fetch(`/i18n/${defaultLocale}.json`)
    if (res.ok) {
      Object.assign(catalog, await res.json())
    }
  } catch {
    // Fallback
  }

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

  applyI18n()
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
