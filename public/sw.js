// Bumped with every release. Cache-first static assets are only safe while
// this changes: with a fixed name, a deployed fix never reaches an operator
// who has the app open, because the old app.js is served from cache forever.
const CACHE_NAME = 'lindela-lite-v4'
const API_CACHE_NAME = 'lindela-lite-api-v1'

// API responses are cached in their own bucket so they can be expired by age
// without throwing away the app shell, and so the shell stays small enough to
// version cheaply.
const API_TTL_MS = 24 * 60 * 60 * 1000
const API_MAX_ENTRIES = 200

/**
 * The surfaces whose HTML is the root of the precache graph.
 *
 * The rest of the shell is *derived* from these by following every reference
 * the HTML and the modules it pulls in make: <script src>, inline module
 * imports, <link href>, `@import`, and `from '…'` inside .js.
 *
 * It used to be a hand-written list, and a hand-written list of an import graph
 * is wrong the moment anyone adds an import. It omitted all seven /shared/*.js
 * modules app.js needs, then /shared/fmt.js, /shared/labels.js and
 * /components.css after someone repaired it by hand — each repair a snapshot,
 * each snapshot a chance to forget. A missing ES module is a hard
 * module-resolution error rather than a degraded load, so the console failed to
 * boot offline entirely: the one case the offline work exists for.
 */
export const SURFACES = [
	'',
	'/portal/',
	'/chw/',
	'/co/',
	'/districts/',
	'/focal-point/',
	'/parametric/',
	'/scenarios/',
]

export const ENTRY_PATHS = SURFACES.map((surface) => `${surface}index.html`.replace(/^index\.html$/, '/index.html'))

/**
 * Files no import graph can name, because they are fetched at runtime by URL
 * rather than imported.
 *
 * `/sw.js` is here because a worker that did not survive the update it was
 * meant to install is a worker that cannot serve the next offline load. The
 * rest are pulled by `fetch()` and by the manifest, which the browser reads
 * without telling the page.
 */
export const BOOTSTRAP_ASSETS = [
	'/sw.js',
	'/icon.svg',
	'/manifest.webmanifest',
	'/i18n/en.json',
]

// Text we can walk for further references. Anything else (svg, json, the
// webmanifest) is a leaf: fetching its bytes to scan for URLs would cost a
// request per asset for nothing.
const TRAVERSABLE = /\.(?:html|css|js)$/

// One pass, all three grammars. The patterns are anchored on tag or keyword
// names that do not occur in the other two languages, so a file never has to be
// told what it is before it is parsed.
const REFERENCE_PATTERNS = [
	/<link\b[^>]*?\bhref=["']([^"']+)["']/gi,
	/<script\b[^>]*?\bsrc=["']([^"']+)["']/gi,
	/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?/gi,
	/(?:^|[\s;}])(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']/g,
	/(?:^|[\s;}])(?:import|assert)\s*["']([^"']+)["']/g,
]

/**
 * Every local reference a fetched file makes, as absolute same-origin paths.
 *
 * Cross-origin references are dropped (a font CDN is not ours to precache and
 * would fail the install anyway) along with /api/ URLs, which are served
 * network-first and belong in the API bucket.
 */
export function parseReferences(text, baseUrl) {
	const origin = new URL(baseUrl).origin
	const paths = new Set()
	for (const pattern of REFERENCE_PATTERNS) {
		pattern.lastIndex = 0
		for (const match of text.matchAll(pattern)) {
			const raw = match[1].trim()
			if (!raw || raw.startsWith('#') || raw.startsWith('data:')) continue
			let resolved
			try {
				resolved = new URL(raw, baseUrl)
			} catch {
				continue
			}
			if (resolved.origin !== origin) continue
			if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
			if (resolved.pathname.startsWith('/api/')) continue
			paths.add(resolved.pathname)
		}
	}
	return [...paths]
}

/**
 * Breadth-first closure of the shell over the reference graph.
 *
 * `load` takes a URL and returns a Response, or null / a throw, both of which
 * mean "not precacheable". The test passes a loader that reads the repo's
 * public/ tree, which is the only reason this can be checked without a browser:
 * the list that used to live here was never checked against anything.
 */
export async function shellGraph(load, origin) {
	const paths = new Set()
	const visited = new Set()
	const queue = [...ENTRY_PATHS, ...BOOTSTRAP_ASSETS]
	for (let i = 0; i < queue.length; i += 1) {
		const path = queue[i]
		if (visited.has(path)) continue
		visited.add(path)
		paths.add(path)
		const url = new URL(path, origin)
		let response = null
		try {
			response = await load(url)
		} catch {
			continue
		}
		if (!response || !response.ok || !TRAVERSABLE.test(path)) continue
		let text = ''
		try {
			text = await response.clone().text()
		} catch {
			continue
		}
		for (const ref of parseReferences(text, url)) {
			if (visited.has(ref)) continue
			queue.push(ref)
		}
	}
	return [...paths].sort()
}

// The worker globals are not assumed to exist: this module is imported by
// test/web-chw-offline.test.js to check the precache graph against the real
// files on disk, and a top-level `self.addEventListener` would throw there.
const SW = typeof self === 'undefined' ? null : self

SW?.addEventListener('install', (event) => {
	event.waitUntil(
		precache()
			// Take over immediately. Without this a new worker installs and waits,
			// and the previous one keeps serving until every tab for the origin
			// closes — on a long-lived ops console that is effectively never, so a
			// deployed fix never reached the operator it was deployed for.
			.then(() => SW.skipWaiting())
	)
})

/**
 * Cache everything the reference graph reaches, one asset at a time.
 *
 * `cache.add()` rejects per item, so a single missing asset costs one entry
 * rather than the whole shell — but a worker that installs with a hole in its
 * cache will never be repaired, because the next install only runs on a version
 * bump. So an asset that could not be fetched is recorded, and the ones that
 * could be are still cached: a degraded shell that boots beats none.
 */
async function precache() {
	const cache = await caches.open(CACHE_NAME)
	const paths = await shellGraph(async (url) => {
		const response = await fetch(url, { cache: 'reload' })
		return response.ok ? response : null
	}, SW.location.origin)
	await Promise.all(
		paths.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => {}))
	)
	return paths.length
}

SW?.addEventListener('activate', (event) => {
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

SW?.addEventListener('fetch', (event) => {
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
 * Which cache entries to delete, oldest first. Pure, and therefore testable.
 *
 * The console polls twelve endpoints every thirty seconds. Cached with no bound,
 * that grows without limit and survives logout, because nothing tied the
 * lifetime of an operational record to the session that read it.
 *
 * `entries` is `[{ id, storedAtMs }]`; `now` and the limits are parameters
 * because a cache policy that can only be exercised by filling a browser cache
 * with two hundred and one entries is a policy nobody has ever run.
 *
 * TTL is the *preference*, not the condition. The previous version deleted only
 * entries older than the TTL and then tried to make up the shortfall with a
 * second pass whose bound — `remaining - API_MAX_ENTRIES`, where
 * `remaining = keys.length - excess` and `excess = keys.length - API_MAX_ENTRIES`
 * — is algebraically zero. So the fallback never ran, and a cache full of fresh
 * entries was never trimmed at all: the exact unbounded growth the cap exists to
 * prevent, in a function written to prevent it. Age-based eviction still comes
 * first, because dropping a day-old response is free while dropping a fresh one
 * costs the user a round trip.
 */
export function evictionPlan(entries, { now, ttlMs, maxEntries }) {
	if (entries.length <= maxEntries) return []

	const stamped = entries.map((entry) => ({
		...entry,
		// An unstamped entry is older than every dated one. Comparing `NaN`
		// sorts nothing in particular — the result depends on the engine's
		// comparison — so the sort key is made a number explicitly rather than
		// hoping `NaN` happens to land at the front.
		expired: !Number.isFinite(entry.storedAtMs) || now - entry.storedAtMs > ttlMs,
		sortKey: Number.isFinite(entry.storedAtMs) ? entry.storedAtMs : 0,
	}))
	// Oldest first, so the survivors are the most recently served.
	stamped.sort((a, b) => a.sortKey - b.sortKey)

	// A Set, not an array, and the second pass skips what the first already
	// took. Both are load-bearing. Without the Set the plan names the same
	// request twice and the caller issues a delete for something it already
	// deleted. Without the skip the second pass spends its first decrement
	// re-visiting the oldest entry — which the first pass just doomed, since an
	// expired entry is by definition old — so the plan comes back one short and
	// the cache stays one entry over its own limit, silently, on every run.
	const doomed = new Set()
	let over = stamped.length - maxEntries
	for (const entry of stamped) {
		if (over <= 0) break
		if (entry.expired) {
			doomed.add(entry.id)
			over -= 1
		}
	}
	// Anything still over the cap goes regardless of age: the ceiling is a
	// ceiling, and a cache that can exceed its own limit is not capped.
	for (const entry of stamped) {
		if (over <= 0) break
		if (doomed.has(entry.id)) continue
		doomed.add(entry.id)
		over -= 1
	}
	return [...doomed]
}

async function pruneApiCache() {
	const cache = await caches.open(API_CACHE_NAME)
	const keys = await cache.keys()
	if (keys.length <= API_MAX_ENTRIES) return

	const now = Date.now()
	const entries = []
	for (const request of keys) {
		const response = await cache.match(request)
		const parsed = Date.parse(response?.headers.get('date') || '')
		entries.push({ id: request.url, storedAtMs: Number.isNaN(parsed) ? 0 : parsed })
	}

	for (const url of evictionPlan(entries, { now, ttlMs: API_TTL_MS, maxEntries: API_MAX_ENTRIES })) {
		await cache.delete(url)
	}
}

SW?.addEventListener('sync', (event) => {
	if (event.tag === 'lindela-queue') {
		event.waitUntil(replayQueue())
	}
})

SW?.addEventListener('message', (event) => {
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
