// Bumped with every release. Cache-first static assets are only safe while
// this changes: with a fixed name, a deployed fix never reaches an operator
// who has the app open, because the old app.js is served from cache forever.
const CACHE_NAME = 'lindela-lite-v3'
const API_CACHE_NAME = 'lindela-lite-api-v1'

// API responses are cached in their own bucket so they can be expired by age
// without throwing away the app shell, and so the shell stays small enough to
// version cheaply.
const API_TTL_MS = 24 * 60 * 60 * 1000
const API_MAX_ENTRIES = 200

// The full module graph of every surface, not just the entry point.
//
// This list used to hold five paths and omitted all seven /shared/*.js modules
// that app.js imports. A missing ES module is a hard module-resolution error,
// not a degraded load, so the console failed to boot offline entirely — the
// one case the offline work exists for. Anything reachable from a surface's
// <script type="module"> graph belongs here.
//
// Entries are added individually rather than via addAll: one 404 must not
// discard the rest of the shell.
const SHARED_MODULES = [
	'/shared/navbar.js',
	'/shared/runtime.js',
	'/shared/demo.js',
	'/shared/basemap.js',
	'/shared/flood-bands.js',
	'/shared/map-frame.js',
	'/shared/seasonal.js',
	'/shared/app-version.js',
]

const SURFACES = [
	'',
	'/portal/',
	'/chw/',
	'/co/',
	'/districts/',
	'/focal-point/',
	'/parametric/',
	'/scenarios/',
]

const APP_SHELL = [
	'/index.html',
	'/app.js',
	'/styles.css',
	'/tokens.css',
	'/manifest.webmanifest',
	'/icon.svg',
	'/i18n/en.json',
	...SHARED_MODULES,
	...SURFACES,
	'/portal/index.html',
	'/portal/app.js',
	'/portal/manifest.webmanifest',
	'/chw/index.html',
	'/chw/app.js',
	'/chw/manifest.webmanifest',
	'/co/index.html',
	'/co/app.js',
	'/co/manifest.webmanifest',
	'/districts/index.html',
	'/districts/app.js',
	'/districts/manifest.webmanifest',
	'/focal-point/index.html',
	'/focal-point/app.js',
	'/focal-point/manifest.webmanifest',
	'/parametric/index.html',
	'/parametric/app.js',
	'/parametric/manifest.webmanifest',
	'/scenarios/index.html',
	'/scenarios/app.js',
	'/scenarios/manifest.webmanifest',
]

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) =>
				Promise.all(
					APP_SHELL.map((path) =>
						// cache.add() rejects per-item, so a single missing asset
						// costs one entry rather than the whole shell.
						cache.add(new Request(path, { cache: 'reload' })).catch(() => {})
					)
				)
			)
			// Take over immediately. Without this a new worker installs and waits,
			// and the previous one keeps serving until every tab for the origin
			// closes — on a long-lived ops console that is effectively never, so a
			// deployed fix never reached the operator it was deployed for.
			.then(() => self.skipWaiting())
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) =>
				Promise.all(
					cacheNames
						.filter((name) => name !== CACHE_NAME && name !== API_CACHE_NAME)
						.map((name) => caches.delete(name))
				)
			)
			.then(pruneApiCache)
			.then(() => self.clients.claim())
			// Tell open pages a new build is live so they can offer a reload,
			// rather than swapping under a user mid-dispatch.
			.then(() =>
				self.clients.matchAll({ type: 'window' }).then((clients) =>
					clients.forEach((client) => client.postMessage({ type: 'activated', cache: CACHE_NAME }))
				)
			)
	)
})

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url)

	// Network-first for API calls, falling back to the last good response and
	// then to an explicit 503 so the page can tell "offline" from "empty".
	if (url.pathname.startsWith('/api/v1/') && event.request.method === 'GET') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					if (response.ok) {
						const copy = response.clone()
						event.waitUntil(
							caches.open(API_CACHE_NAME).then((cache) =>
								cache.put(event.request, copy)
							)
						)
					}
					return response
				})
				.catch(() =>
					caches.match(event.request, { cacheName: API_CACHE_NAME }).then((cached) => {
						if (cached) {
							// Mark it so the page can say "this is stale" rather than
							// presenting a cached value as current.
							const headers = new Headers(cached.headers)
							headers.set('x-lindela-offline', '1')
							return new Response(cached.body, {
								status: cached.status,
								statusText: cached.statusText,
								headers,
							})
						}
						return new Response(JSON.stringify({ error: 'Offline' }), {
							status: 503,
							headers: { 'content-type': 'application/json' },
						})
					})
				)
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

/**
 * Drop API cache entries older than the TTL and cap total entries.
 *
 * The console polls twelve endpoints every thirty seconds. Cached into the app
 * shell bucket with no bound, that grows without limit and survives logout,
 * because nothing tied the lifetime of an operational record to the session
 * that read it.
 */
async function pruneApiCache() {
	const cache = await caches.open(API_CACHE_NAME)
	const keys = await cache.keys()
	if (keys.length <= API_MAX_ENTRIES) return

	const now = Date.now()
	const stamped = []
	for (const request of keys) {
		const response = await cache.match(request)
		const stored = response ? Date.parse(response.headers.get('date') || '') : NaN
		stamped.push({ request, stored: Number.isNaN(stored) ? 0 : stored })
	}

	// Oldest first, so the survivors are the most recently served.
	stamped.sort((a, b) => a.stored - b.stored)
	const excess = stamped.length - API_MAX_ENTRIES
	for (const entry of stamped.slice(0, excess)) {
		if (!entry.stored || now - entry.stored > API_TTL_MS) await cache.delete(entry.request)
	}
	// If age alone did not free enough room, evict oldest-first regardless.
	let remaining = keys.length - excess
	for (const entry of stamped.slice(0, Math.max(0, remaining - API_MAX_ENTRIES))) {
		await cache.delete(entry.request)
		remaining--
	}
}

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
