export function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
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
    },
    async flush() {
      if (!this.db || !navigator.onLine) return
      const tx = this.db.transaction(['requests'], 'readonly')
      const store = tx.objectStore('requests')
      const req = store.getAll()
      return new Promise((resolve) => {
        req.onsuccess = async () => {
          const records = req.result
          for (const record of records) {
            try {
              await apiFetch(record.path, record.options)
              const delTx = this.db.transaction(['requests'], 'readwrite')
              delTx.objectStore('requests').delete(record.id)
            } catch {
              // Retry in next cycle
            }
          }
          resolve(records.length)
        }
        req.onerror = () => resolve(0)
      })
    },
  }
  await window.lindelaQueue.init()
}

export async function apiFetch(path, { method = 'GET', body, headers = {}, token } = {}) {
  const opts = { method, headers }
  if (body) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body)
    opts.headers['content-type'] = 'application/json'
  }
  if (token) {
    opts.headers['authorization'] = `Bearer ${token}`
  }
  const res = await fetch(path, opts)
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    try {
      err.json = await res.json()
    } catch {
      err.json = null
    }
    throw err
  }
  return res.json()
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
    async set(locale) {
      try {
        const res = await fetch(`/i18n/${locale}.json`)
        if (res.ok) {
          const newCatalog = await res.json()
          Object.assign(catalog, newCatalog)
          this.current = locale
          applyI18n()
        }
      } catch {
        // Stay on current locale
      }
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
