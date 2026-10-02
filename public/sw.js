// Bumped with every release. Cache-first static assets are only safe while
// this changes: with a fixed name, a deployed fix never reaches an operator
// who has the app open, because the old app.js is served from cache forever.
const CACHE_NAME = 'lindela-lite-v2'
const APP_SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/i18n/en.json']

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			return cache.addAll(APP_SHELL).catch(() => {
				// Partial caching is ok; app shell may not all be available yet
				return Promise.resolve()
			})
		})
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((cacheNames) => {
			return Promise.all(
				cacheNames
					.filter((name) => name !== CACHE_NAME)
					.map((name) => caches.delete(name))
			)
		})
	)
})

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url)

	// Network-first for API calls with stale-while-revalidate fallback
	if (url.pathname.startsWith('/api/v1/') && event.request.method === 'GET') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					if (response.ok) {
						caches.open(CACHE_NAME).then((cache) => {
							cache.put(event.request, response.clone())
						})
					}
					return response
				})
				.catch(() => {
					return caches.match(event.request).then((cached) => {
						return cached || new Response(JSON.stringify({ error: 'Offline' }), {
							status: 503,
							headers: { 'content-type': 'application/json' },
						})
					})
				})
		)
		return
	}

	// Stale-while-revalidate for static assets: serve immediately from cache,
	// then refresh in the background so the next load picks up a deploy.
	// Previously cache-first with no revalidation, so app.js was pinned to
	// whatever was cached first.
	event.respondWith(
		caches.open(CACHE_NAME).then((cache) =>
			cache.match(event.request).then((cached) => {
				const network = fetch(event.request)
					.then((response) => {
						if (response.ok) cache.put(event.request, response.clone())
						return response
					})
					.catch(() => cached || Promise.reject(new Error('offline and not cached')))
				return cached || network
			})
		)
	)
})

self.addEventListener('sync', (event) => {
	if (event.tag === 'lindela-queue') {
		event.waitUntil(replayQueue())
	}
})

self.addEventListener('message', (event) => {
	if (event.data.type === 'flushQueue') {
		event.waitUntil(replayQueue())
	}
})

/**
 * Replay the offline queue.
 *
 * There was a second queue here under a different database name
 * (`lindela-queue`) that nothing ever wrote to and nothing ever registered a
 * sync tag for, alongside the page's own queue (`lindela_queue`). Two
 * implementations, one of them dead, and neither replaying anything: a report
 * queued offline sat in IndexedDB until the tab was closed.
 *
 * This now reads the page's queue, so there is exactly one set of pending
 * requests and the service worker and the page cannot disagree about what is
 * outstanding. The page also flushes on `online`, on an interval and on load;
 * this path covers the case the tab was closed, which no in-page event can.
 */
async function replayQueue() {
	const db = await openQueueDb()
	const tx = db.transaction('requests', 'readonly')
	const records = await new Promise((resolve, reject) => {
		const req = tx.objectStore('requests').getAll()
		req.onsuccess = () => resolve(req.result || [])
		req.onerror = () => reject(req.error)
	})

	const succeeded = []
	for (const item of records) {
		try {
			const response = await fetch(item.path, item.options)
			if (response.ok) succeeded.push(item.id)
		} catch {
			// Still failing: keep it queued and try again on the next sync.
		}
	}

	if (succeeded.length) {
		const deleteTx = db.transaction('requests', 'readwrite')
		const deleteStore = deleteTx.objectStore('requests')
		for (const id of succeeded) deleteStore.delete(id)
		await new Promise((resolve, reject) => {
			deleteTx.oncomplete = () => resolve()
			deleteTx.onerror = () => reject(deleteTx.error)
		})
	}
	return succeeded.length
}

function openQueueDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('lindela_queue', 1)
		req.onupgradeneeded = (event) => {
			const db = event.target.result
			if (!db.objectStoreNames.contains('requests')) {
				db.createObjectStore('requests', { keyPath: 'id', autoIncrement: true })
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}
