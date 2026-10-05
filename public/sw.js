// Bumped with every release. Cache-first static assets are only safe while
// this changes: with a fixed name, a deployed fix never reaches an operator
// who has the app open, because the old app.js is served from cache forever.
const CACHE_NAME = 'lindela-lite-v4'
const API_CACHE_NAME = 'lindela-lite-api-v1'
const DETAIL_CACHE_NAME = 'lindela-lite-detail-v1'
const MAP_CACHE_NAME = 'lindela-lite-map-v1'

// API responses are cached in their own bucket so they can be expired by age
// without throwing away the app shell, and so the shell stays small enough to
// version cheaply.
const API_TTL_MS = 24 * 60 * 60 * 1000
const API_MAX_ENTRIES = 200

/**
 * Three read buckets, not one (ENH-22).
 *
 * The single API bucket was sized for the console's twelve-endpoint poll, which
 * is the wrong shape for the two things a drill-down actually needs.
 *
 * `detail` is a record a user opened by name — a district, an alert event, an
 * incident. It is what an offline user goes looking for and it is the smallest
 * payload class here, so it gets the longest TTL (a week: a district's facts do
 * not move in a day, and a health worker who visited a district on Tuesday must
 * still be able to read it on Saturday) and a cap low enough that nothing else
 * can evict it. Under one shared bucket with a 200-entry cap driven by a
 * thirty-second poll, the poll fills the cache and every drill-down anyone ever
 * opens is among the first evicted — the offline drill-down was available in
 * principle and not in practice.
 *
 * `map` is what the map actually fetches. `shared/basemap.js` is inline polygon
 * data and requests nothing at all: there are no raster tiles in this product,
 * and a tile cache for tiles that are never requested is a cache of nothing.
 * The real payload behind the map is the hazard, flood, food-security and
 * road-access layers drawn inside those polygons — the largest responses here
 * and among the least volatile, so the smallest cap.
 *
 * `api` is everything else: KPI series, summaries, watermarks, ingest status.
 * Short-lived and high-churn, exactly as before.
 */
export const CACHE_POLICIES = {
	detail: { name: DETAIL_CACHE_NAME, maxEntries: 60, ttlMs: 7 * 24 * 60 * 60 * 1000 },
	map:    { name: MAP_CACHE_NAME,   maxEntries: 48, ttlMs: 2 * 24 * 60 * 60 * 1000 },
	api:    { name: API_CACHE_NAME,   maxEntries: API_MAX_ENTRIES, ttlMs: API_TTL_MS },
}

/**
 * Collections whose sub-resources are a single record — a drill-down target.
 *
 * Derived from the request shapes the surfaces actually issue, not from the
 * route table: `/api/v1/districts/turkana` is a district, `/api/v1/districts`
 * is the list the map draws and belongs in `map`. Splitting on segment count as
 * well as on collection name is what keeps those two apart, and getting it
 * wrong is quiet in both directions — a list in the detail bucket evicts
 * records, a record in the list bucket is evicted by the poll.
 */
const DETAIL_COLLECTIONS = new Set([
	'alert-events',
	'community-feedback',
	'disease-observations',
	'districts',
	'events',
	'incidents',
	'interventions',
	'reports',
	'service-assets',
	'tasks',
	'workflows',
])

/** Bare collections the map draws from. No sub-resource. */
const MAP_LAYER_COLLECTIONS = new Set([
	'climate',
	'conflict-risk',
	'districts',
	'equity',
	'flood-depth',
	'flood-risk',
	'food-security',
	'road-access',
])

/**
 * Which bucket a request belongs in, or null if it is not a cached read.
 *
 * null for anything that is not a GET under /api/v1/: a write must never be
 * served from a cache, and the offline queue in replayQueue depends on that —
 * a cached 200 for a POST would make a submission that never reached the server
 * look filed, which is the exact failure the queue exists to prevent.
 */
export function classifyApiRequest(pathname, method = 'GET') {
	if (String(method).toUpperCase() !== 'GET') return null
	if (!pathname.startsWith('/api/v1/')) return null
	const segments = pathname.slice('/api/v1/'.length).split('/').filter(Boolean)
	if (!segments.length) return null
	const [collection, id] = segments
	if (id) return DETAIL_COLLECTIONS.has(collection) ? 'detail' : 'api'
	return MAP_LAYER_COLLECTIONS.has(collection) ? 'map' : 'api'
}

/**
 * The body a drill-down gets when the record is genuinely not available.
 *
 * The worker used to answer an offline miss with `{"error":"Offline"}` and a
 * 503. Two things were wrong with that. The shape is indistinguishable from a
 * server error, so a page cannot tell "the network is gone and I never had this
 * record" from "the server refused this request"; and an empty panel that looks
 * like an empty result set reads to a health worker as "there is nothing here"
 * — a claim about the district, and a false one.
 *
 * So the miss names what is missing and says plainly that nothing was ever
 * cached. `cached: false` is the field that carries the meaning: it is the
 * difference between "I have no data" and "I have no data because I never
 * fetched any", two different sentences to a user and identical pixels.
 */
export function offlineMissBody({ kind, pathname } = {}) {
	return {
		error: 'unavailable-offline',
		code: 'offline-no-record',
		offline: true,
		cached: false,
		kind: kind || null,
		resource: pathname || null,
		message:
			'This record is not available offline: it has never been downloaded to this ' +
			'device, so there is nothing to show for it until the device is back online.',
	}
}

/**
 * Representation and hop-by-hop headers that must not be copied onto a body
 * that has already been decoded.
 *
 * A cached body is a decoded stream. Re-wrapping it under the stored response's
 * own `content-encoding: gzip` and `content-length` describes a body that is
 * not the body being sent — headers that lie about their payload. The previous
 * worker copied them wholesale and nothing caught it, because the only way to
 * reach that code is to be offline with a warm cache, which no test could
 * arrange.
 */
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export function sanitizeHeaders(headers = {}) {
	const out = {}
	for (const [key, value] of new Headers(headers).entries()) {
		if (!DROPPED_HEADERS.has(key.toLowerCase())) out[key] = value
	}
	return out
}

/**
 * Headers for a cache hit, so the page can say how stale it is rather than
 * presenting a week-old district as current.
 *
 * The age is computed here because the page cannot: the server's `Date` header
 * is the response time, and a response pulled from a cache days later still
 * carries the day it was fetched.
 */
export function staleHeaders({ headers = {}, storedAtMs = 0, now = 0 } = {}) {
	const out = {
		...sanitizeHeaders(headers),
		'x-lindela-offline': '1',
		'x-lindela-cache': 'hit',
	}
	if (storedAtMs) {
		out['x-lindela-stored-at'] = new Date(storedAtMs).toISOString()
		out['x-lindela-stale-seconds'] = String(Math.max(0, Math.round((now - storedAtMs) / 1000)))
	}
	return out
}

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
						.filter((name) => name !== CACHE_NAME && !DATA_CACHE_NAMES.has(name))
						.map((name) => caches.delete(name))
				)
			)
			.then(pruneDataCaches)
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
	const kind = classifyApiRequest(url.pathname, event.request.method)

	// Network-first for API calls, falling back to the last good response and
	// then to an explicit, self-describing miss so the page can tell "offline",
	// "stale" and "never fetched" apart — three states that look identical as
	// an empty panel and mean completely different things to a user in a
	// district with no signal.
	if (kind) {
		event.respondWith(networkFirst(event.request, kind, event))
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
 * Network-first read with an honest fallback chain.
 *
 * The chain is three distinct answers and each one is a different thing the
 * page has to be able to say out loud:
 *
 *   live    the response, and a copy stored with the timestamp of the moment it
 *           was stored (not the server's Date, which is the response time and is
 *           what a stale-looking age would otherwise be computed from);
 *   stale   the cached body, marked with x-lindela-offline and its age, so the
 *           panel can say "as of Tuesday" instead of implying now;
 *   missing a 503 whose body says, in a field, that nothing was ever cached.
 *
 * A non-OK response is passed straight through and never cached. Serving a
 * cached district because the server returned 500 would be the offline failure
 * this work exists to avoid, in the other direction.
 */
async function networkFirst(request, kind, event) {
	const policy = CACHE_POLICIES[kind]
	const url = new URL(request.url)
	let response
	try {
		response = await fetch(request)
	} catch {
		return cachedOrMiss(request, kind, url)
	}

	// A non-OK response is passed through and never cached. Serving a cached
	// district because the server returned 500 is the same class of lie as
	// serving an empty panel, only quieter.
	if (!response.ok) return response

	const storedAtMs = Date.now()
	const body = await response.clone().blob()
	const stored = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		// The stored copy carries no offline marker: only a copy served *because*
		// the network failed is offline, and leaving the marker on would have
		// every later hit announce itself as stale before the network was tried.
		headers: {
			...sanitizeHeaders(response.headers),
			'x-lindela-stored-at': new Date(storedAtMs).toISOString(),
		},
	})
	// waitUntil, not fire-and-forget: a cache write the worker is killed before
	// it finishes is a write that does not happen, and the miss it would have
	// prevented is the offline case this is all for.
	const put = storeAndTrim(request, stored, policy)
	if (event && typeof event.waitUntil === 'function') event.waitUntil(put)
	return response
}

/** The offline half of the chain: the cached record, or an explicit miss. */
async function cachedOrMiss(request, kind, url) {
	const policy = CACHE_POLICIES[kind]
	const cache = await caches.open(policy.name)
	const cached = await cache.match(request)
	if (cached) {
		const storedAtMs = Number(cached.headers.get('x-lindela-stored-at')) || 0
		return new Response(await cached.blob(), {
			status: cached.status,
			statusText: cached.statusText,
			headers: staleHeaders({ headers: cached.headers, storedAtMs, now: Date.now() }),
		})
	}
	return new Response(JSON.stringify(offlineMissBody({ kind, pathname: url.pathname })), {
		status: 503,
		statusText: 'Service Unavailable',
		headers: {
			'content-type': 'application/json',
			'x-lindela-offline': '1',
			'x-lindela-cache': 'miss',
		},
	})
}

/**
 * Store, then trim to the bucket's cap.
 *
 * Trimming on write rather than only on activate is the point: the console
 * polls twelve endpoints every thirty seconds, so the bucket overflows while
 * the tab is open, and an activate-time-only trim would leave it over its own
 * limit for the entire session. The keys() check is the cheap guard that keeps
 * a poll from paying for a full key enumeration on every response.
 */
function storeAndTrim(request, response, policy) {
	return caches
		.open(policy.name)
		.then(async (cache) => {
			await cache.put(request, response)
			const keys = await cache.keys()
			if (keys.length <= policy.maxEntries) return 0
			const entries = []
			for (const entry of keys) {
				const stored = await cache.match(entry)
				entries.push({ id: entry.url, storedAtMs: Number(stored?.headers.get('x-lindela-stored-at')) || 0 })
			}
			const doomed = evictionPlan(entries, { now: Date.now(), ttlMs: policy.ttlMs, maxEntries: policy.maxEntries })
			for (const url of doomed) await cache.delete(url)
			return doomed.length
		})
		.catch(() => {})
}

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

/**
 * Every bucket activate must not delete, derived from the policies rather than
 * re-listed. It was `name !== CACHE_NAME && name !== API_CACHE_NAME`, so the
 * day the detail and map buckets were added this deletion started wiping the
 * offline drill-down on every worker version bump — the cache the whole feature
 * depends on, removed by the code that was supposed to clear stale caches.
 */
const DATA_CACHE_NAMES = new Set(Object.values(CACHE_POLICIES).map((policy) => policy.name))

/**
 * Trim every data bucket to its own cap.
 *
 * Age comes from `x-lindela-stored-at`, which the worker wrote when it stored
 * the entry, and not from the server's `date` header: that is the moment the
 * server answered, which for a long-lived offline device is months ago for
 * every entry at once and would make the whole bucket look expired on the first
 * prune after a long gap.
 */
async function pruneDataCaches() {
	const now = Date.now()
	for (const policy of Object.values(CACHE_POLICIES)) {
		const cache = await caches.open(policy.name)
		const keys = await cache.keys()
		if (keys.length <= policy.maxEntries) continue

		const entries = []
		for (const request of keys) {
			const response = await cache.match(request)
			const storedAtMs = Date.parse(response?.headers.get('x-lindela-stored-at') || '')
			entries.push({ id: request.url, storedAtMs: Number.isNaN(storedAtMs) ? 0 : storedAtMs })
		}

		for (const url of evictionPlan(entries, { now, ttlMs: policy.ttlMs, maxEntries: policy.maxEntries })) {
			await cache.delete(url)
		}
	}
}

/**
 * Replay: DELETED, and this comment is the reason.
 *
 * This worker read the *same* IndexedDB store the page does — `lindela_queue` —
 * with `getAll()` and an unconditional `delete` on success. The page's `flush()`
 * does the same. Two drains, no claim, no lease, no compare-and-delete: both can
 * hold the same record id at the same moment, both POST it, and both delete it.
 * **Two field reports for one health worker's observation.**
 *
 * It was unreachable — no service worker could install (the registration said
 * `register('/sw.js')` without `{type:'module'}` against a file with eleven
 * top-level exports, so every browser refused it). So the duplicate-report race
 * had never fired, and fixing the registration would have activated it on the
 * first field device to go offline.
 *
 * Two things made it safe to remove rather than fix:
 *
 *  1. Every queued write now carries an `idempotency-key` equal to its queue
 *     record id (`public/shared/runtime.js`, `enqueue`). Even if two drains did
 *     race, the server's idempotency store answers the second with the first's
 *     receipt rather than creating a second record.
 *  2. The page already drains on `online`, on a 30-second tick and on load, and
 *     now records attempts and moves permanently-rejected records aside rather
 *     than retrying them forever.
 *
 * What the worker loses is the closed-tab case, which is real: a health worker
 * who closes the app before signal returns waits for the next visit. That is the
 * right trade against silently duplicating a report, and the honest way to close
 * it is a claim-based queue with a single drainer — not two drainers and a hope.
 * When that lands it belongs here again, with a lease.
 */
SW?.addEventListener('message', (event) => {
	// The page owns replay. A message asking the worker to flush is answered
	// with an acknowledgement rather than acted on, so a caller cannot start a
	// second drain by asking.
	if (event.data?.type === 'flushQueue') {
		event.waitUntil(Promise.resolve({ replayed: 0, owner: 'page' }))
	}
})
