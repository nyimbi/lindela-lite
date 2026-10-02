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
    async enqueue(path, options) {
      if (!this.db) return
      const tx = this.db.transaction(['requests'], 'readwrite')
      const store = tx.objectStore('requests')
      store.add({ path, options, timestamp: Date.now() })
      window.dispatchEvent(new CustomEvent('lindela-queue-changed'))
      // Ask the service worker to register a Background Sync. The page flushes
      // on `online`, on an interval and on load, but none of those fire if the
      // tab is closed before connectivity returns — and a health worker closing
      // the app is normal, not an edge case. Best effort: unsupported in some
      // browsers and non-secure contexts, where the in-page flush still applies.
      try {
        const reg = await navigator.serviceWorker?.ready
        if (reg?.sync) await reg.sync.register('lindela-queue')
      } catch {
        // No Background Sync here; the periodic in-page flush covers it.
      }
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
 * the page's own flush. Returns `{queued: true}` rather than throwing, because a
 * queued write is a success the user should be told about plainly.
 */
export async function submitOrQueue(path, body, { headers } = {}) {
  if (navigator.onLine) return apiFetch(path, { method: 'POST', body, headers })
  if (window.lindelaQueue) {
    await window.lindelaQueue.enqueue(path, { method: 'POST', body, headers })
    return { queued: true }
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
    async set(locale) {
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
