// Bumped with every release. Cache-first static assets are only safe while
// this changes: with a fixed name, a deployed fix never reaches an operator
// who has the app open, because the old app.js is served from cache forever.
const CACHE_NAME = 'lindela-lite-v6'
const API_CACHE_NAME = 'lindela-lite-api-v1'
const DETAIL_CACHE_NAME = 'lindela-lite-detail-v1'
const MAP_CACHE_NAME = 'lindela-lite-map-v1'
const TILE_CACHE_NAME = 'lindela-lite-tiles-v1'

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
 * `map` is what the map actually fetches for its vector payload.
 * `shared/basemap.js` is inline polygon data and requests nothing at all:
 * the payload behind the map is the hazard, flood, food-security and
 * road-access layers drawn inside those polygons — the largest responses here
 * and among the least volatile, so the smallest cap.
 *
 * Raster basemap tiles are *not* here (ADR-013): they are immutable imagery
 * served same-origin under `/api/v1/basemap/tiles/`, and they would flood a
 * 48-entry bucket at about two dozen tiles per pan, evicting the one class
 * that actually needs the offline lifeline. They read from their own bucket
 * with a large cap and a week's TTL, and a tile that failed to fetch is
 * simply not painted — the vector rings underneath show through instead.
 *
 * `api` is everything else: KPI series, summaries, watermarks, ingest status.
 * Short-lived and high-churn, exactly as before.
 */
import { openQueueDb, drainQueue, sendRecord } from './shared/queue-core.js'
export const CACHE_POLICIES = {
	detail: { name: DETAIL_CACHE_NAME, maxEntries: 60, ttlMs: 7 * 24 * 60 * 60 * 1000 },
	map:    { name: MAP_CACHE_NAME,   maxEntries: 48, ttlMs: 2 * 24 * 60 * 60 * 1000 },
	api:    { name: API_CACHE_NAME,   maxEntries: API_MAX_ENTRIES, ttlMs: API_TTL_MS },
	tiles:  { name: TILE_CACHE_NAME,  maxEntries: 400, ttlMs: 7 * 24 * 60 * 60 * 1000 },
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
	'disease-observations',
	// The weather and river-discharge overlays' roll-ups: same shape as the
	// other layers (a bare collection the map draws whole), so they share the
	// 48-entry map bucket and two-day TTL rather than churning in the poll bucket.
	'weather',
	'river-discharge',
])

/**
 * Which bucket a request belongs in, or null if it is not a cached read.
 *
 * null for anything that is not a GET under /api/v1/: a write must never be
 * served from a cache, and the offline queue in replayQueue depends on that —
 * a cached 200 for a POST would make a submission that never reached the server
 * look filed, which is the exact failure the queue exists to prevent.
 */
/**
 * Endpoints that must never be answered from cache.
 *
 * Found by `scripts/check-offline-roundtrip.mjs`: with the server genuinely
 * stopped, `fetch('/api/v1/health')` returned **200** — a cached answer from
 * before it died. Everything else in the API cache is data a surface can label
 * as stale; these three are claims, and a claim served from cache is a lie:
 *
 *   - `/health` and `/ready` answer "is the server up?", which is precisely the
 *     question a cache cannot answer truthfully;
 *   - `/auth-info` answers "is authentication configured, and what is this token's
 *     scope", which is a statement about the server's current configuration. The
 *     partner portal read it to decide whether to tell someone their token was
 *     wrong, and a cached answer would have it blaming the wrong thing.
 *
 * They are excluded from the API buckets entirely rather than marked
 * uncacheable, so they cannot be written into a bucket by another route's
 * response either.
 */
export const NEVER_CACHED = Object.freeze([
	'/api/v1/health',
	'/api/v1/ready',
	'/api/v1/readyz',
	'/api/v1/auth-info',
])

export function isNeverCached(pathname) {
	return NEVER_CACHED.includes(String(pathname))
}

export function classifyApiRequest(pathname, method = 'GET') {
	if (String(method).toUpperCase() !== 'GET') return null
	if (!pathname.startsWith('/api/v1/')) return null
	if (isNeverCached(pathname)) return null
	const segments = pathname.slice('/api/v1/'.length).split('/').filter(Boolean)
	if (!segments.length) return null
	// Raster basemap tiles (ADR-013): immutable imagery, ~two dozen per paint,
	// never operator data. Their own bucket keeps a panning session from
	// evicting the record and poll payloads the offline path exists to serve.
	if (segments[0] === 'basemap' && segments[1] === 'tiles') return 'tiles'
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
	// Fetched by string construction — `/i18n/${locale}.json` — so no pattern can
	// see it, and a locale switch while offline has to work. Every shipped
	// catalogue is listed; `test/sw-bootstrap-assets.test.js` fails if one is
	// added and not registered here.
	'/i18n/am.json',
	'/i18n/ar.json',
	'/i18n/din.json',
	'/i18n/en.json',
	'/i18n/fr.json',
	'/i18n/km.json',
	'/i18n/nk.json',
	'/i18n/pt.json',
	'/i18n/so.json',
	'/i18n/sw.json',
	// The stylesheet a script injects at runtime (`link.href = …` in
	// workflow/panel.js:15). A stylesheet added by script is invisible to any
	// scan of source text, and the panel renders unstyled rather than not at
	// all, which is the harder failure to report.
	'/workflow/panel.css',
	// The four deferred rail panels, fetched by `mountPanel`. They were moved
	// out of the shell to keep them out of the first load; a deferred panel
	// that is not precached is a tab that fails exactly when it is opened
	// offline.
	'/panels/equity.html',
	'/panels/ingestion.html',
	'/panels/reports.html',
	'/panels/settings.html',
	// ENH-19. The determination dialog is deferred out of the shell, which makes
	// it unavailable offline unless it is listed here — and offline is precisely
	// when a worker has a freshly-received alert to judge. A missing entry here
	// is not a slower dialog; it is the whole outcome channel, closed, on the
	// devices it exists for.
	'/panels/outcome.html',
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
	// Everything above is a *static* reference, so the closure stopped exactly
	// where the code stopped being static. The console defers eleven modules
	// through `lazy()` and `import()` — including workflow/panel.js, the offline
	// drill-down, which was therefore unreachable offline: the one module a
	// field user is most likely to want when there is no connection.
	//
	// The comment-tolerant form matters: `import(/* chunk */ '/x.js')` is
	// ordinary bundler output, and a pattern without it fixes the reported case
	// and leaves the next one. The comment body is `([^*]|\*(?!/))*` and not
	// `[\s\S]*?` because a lazy any-char match happily spans from an `import(`
	// inside a *prose comment* to the next `*/` and a quote — this file's own
	// comment about `import()` produced a path through the middle of a sentence,
	// and the worker then tried to precache a URL that 404s. A precache entry
	// that 404s fails the install, so a parser that guesses is worse than a
	// parser that misses.
	/(?:import|require)\s*\(\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/\s*)?[`'"]([^`'"]+)[`'"]\s*\)/g,
	// This repo's own deferred-module helper, `lazy()` in public/app.js. Named
	// separately because it is a local convention, not a language feature: a
	// reader looking for why workflow/panel.js is missing will not find it
	// under `import`.
	/\blazy\s*\(\s*[`'"]([^`'" ]+)[`'"]\s*\)/g,
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
	// Comments out, before anything is matched.
	//
	// This was reading source *prose* as references: a comment explaining that
	// the import-from pattern "reads the rest of the sentence as a module path"
	// produced thirty-odd precache entries — `/,%20and%20the%20import-from…` —
	// fetched at install time from a server that answers unknown paths with the
	// shell, so the shell was cached thirty times over. It also made install slow
	// enough that the service worker sometimes failed to activate, which is how a
	// cold start with no server produced the browser's error page rather than the
	// app.
	//
	// Block comments always; line comments only when the line *starts* with one,
	// so a `//` inside a string — `https://…` — cannot truncate the rest of a
	// line and take a real import with it.
	const scanable = String(text)
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.split('\n')
		.map((line) => (/^\s*\/\//.test(line) ? ' ' : line))
		.join('\n')
	for (const pattern of REFERENCE_PATTERNS) {
		pattern.lastIndex = 0
		for (const match of scanable.matchAll(pattern)) {
			const raw = match[1].trim()
			if (!raw || raw.startsWith('#') || raw.startsWith('data:')) continue
			// A reference is a path. Anything carrying a space or a percent-escape
			// is prose that leaked past the comment stripper, and a precache entry
			// built from one is a request for a document that does not exist.
			if (/\s|%[0-9A-Fa-f]{2}/.test(raw)) continue
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
	// Roots and references are not the same kind of claim, and conflating them is
	// a denial of service against the offline capability: a reference that 404s
	// in the precache list fails the whole install, taking the worker with it.
	//
	// The pattern scanner is a scanner, not a parser, and it will occasionally
	// read a path out of a string literal — `ingest-gates.js` has a confirmation
	// label ending "…and import", and the import-from pattern reads the rest of
	// the sentence as a module path. So a reference is admitted only once it has
	// actually loaded. Roots are kept either way: a hand-listed bootstrap entry
	// that does not exist is a bug in the list, and `test/sw-bootstrap-assets.test.js`
	// says so by name rather than by silently vanishing from the graph.
	const queue = [...ENTRY_PATHS, ...BOOTSTRAP_ASSETS].map((path) => ({ path, root: true }))
	for (let i = 0; i < queue.length; i += 1) {
		const { path, root } = queue[i]
		if (visited.has(path)) continue
		visited.add(path)
		const url = new URL(path, origin)
		let response = null
		try {
			response = await load(url)
		} catch {
			response = null
		}
		if (!response || !response.ok) {
			if (root) paths.add(path)
			continue
		}
		paths.add(path)
		if (!TRAVERSABLE.test(path)) continue
		let text = ''
		try {
			text = await response.clone().text()
		} catch {
			continue
		}
		for (const ref of parseReferences(text, url)) {
			if (visited.has(ref)) continue
			queue.push({ path: ref, root: false })
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
	// Requests that do not come from this origin: browser extensions run code
	// inside the page and their fetches arrive here too. The static branch
	// below answered one with cache.put, which throws for schemes a Cache
	// cannot store (chrome-extension), and the throw propagated as an uncaught
	// promise rejection in the console. A request this app does not own is also
	// not its to respond to — fall through untouched, and the browser does the
	// normal thing.
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return
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

	// Health, readiness and the auth-configuration probe go straight to the
	// network and are never stored.
	//
	// Excluding them from the API buckets above was not enough on its own: they
	// then fell through to the static branch, whose whole job is to cache what
	// it fetches — so the first online visit wrote a copy of "the server is
	// healthy" into the shell cache and served it back for the next seven
	// minutes after the server died. Measured by the round-trip drill.
	if (isNeverCached(url.pathname)) {
		event.respondWith(
			fetch(event.request).catch(() => new Response(
				JSON.stringify(offlineMissBody({ kind: 'never-fetched', pathname: url.pathname })),
				{
					status: 503,
					headers: { 'content-type': 'application/json', 'x-lindela-offline': '1', 'x-lindela-cache': 'never' },
				},
			))
		)
		return
	}

	// Code the page executes, and the documents loading it: network first,
	// cache only when the network fails. Stale-while-revalidate was the wrong
	// trade for code. The first load after a deploy ran the previous module; the
	// revalidate fetch consulted the browser's HTTP cache; so a module served
	// with max-age re-stored ITS OWN STALE BODY, and a deploy took an hour of
	// HTTP-cache expiry or luck to reach the console at all. Offline support is
	// unchanged — the cache is still what answers when the network is gone —
	// and a fix now reaches an open console at the next reload.
	if (event.request.mode === 'navigate' || isCodeAsset(url.pathname)) {
		event.respondWith(codeFirst(event, url))
		return
	}

	// Stale-while-revalidate for the remaining static assets: serve immediately
	// from cache, then refresh in the background so the next load picks up a
	// deploy. Previously cache-first with no revalidation, so app.js was pinned
	// to whatever was cached first. The refresh fetch carries cache: 'reload'
	// for the same reason the code path above does: a revalidation that can be
	// answered from the HTTP cache revalidates nothing.
	//
	// The second lookup ignores the query string, and that is not a nicety: the
	// precache is keyed by the paths the graph found (`/chw/index.html`) while a
	// navigation carries whatever the app put in the URL (`/chw/?cold=1`, every
	// filter, every share link). `cache.match` compares the whole URL, so an exact
	// lookup missed every navigation that had a query — and the app appeared to
	// work offline only in the one case nobody uses, a bare URL.
	//
	// Exact first, so two genuinely different assets that differ only by query
	// are still distinguished when both are cached.
	event.respondWith(
		caches.open(CACHE_NAME).then((cache) =>
			cache.match(event.request).then((exact) =>
				(exact ? Promise.resolve(exact) : cache.match(event.request, { ignoreSearch: true }))
			).then((cached) => {
				const network = fetch(event.request, { cache: 'reload' })
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

/** Code and markup the page executes or renders: these must be current. */
function isCodeAsset(pathname) {
	return /\.(js|mjs|css)(\?|$)/.test(String(pathname))
}

/**
 * Network first for code, with the cache as the offline half.
 * The fetch carries cache: 'reload' so the revalidation cannot be answered
 * from the HTTP cache — the browser's max-age entry for a module would
 * otherwise be re-stored over and over as if it were fresh.
 */
async function codeFirst(event, url) {
	const cache = await caches.open(CACHE_NAME)
	try {
		const response = await fetch(event.request, { cache: 'reload' })
		if (response.ok) {
			const put = cache.put(event.request, response.clone())
			if (event && typeof event.waitUntil === 'function') event.waitUntil(put)
		}
		return response
	} catch {
		const cached = await cache.match(event.request)
			.then((hit) => hit || cache.match(event.request, { ignoreSearch: true }))
		if (cached) return cached
		return new Response(JSON.stringify(offlineMissBody({ kind: 'static-miss', pathname: url.pathname })), {
			status: 503,
			headers: { 'content-type': 'application/json', 'x-lindela-offline': '1', 'x-lindela-cache': 'miss' },
		})
	}
}

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
/**
 * The worker's drain.
 *
 * This is the half that was deleted, and the comment above it said what would
 * replace it: "the honest way to close it is a claim-based queue with a single
 * drainer — not two drainers and a hope." That is `queue-core.js`: a drain
 * claims the records it is about to send, and a record another drainer holds a
 * live claim on is skipped. Two drains are then safe by construction, which is
 * what lets this exist again beside the page's.
 *
 * Without it, a report filed on Friday reached the server when the health worker
 * next opened the app — which on a phone that is charged weekly is Monday, or
 * never.
 *
 * The claim narrows the race to two drains claiming inside the same
 * millisecond; the `idempotency-key` on every queued record closes it, because
 * the server replays a repeat rather than writing a second report. Either guard
 * alone would be weaker than the pair, and this is why the record's key is
 * minted before the write rather than at send time.
 */
async function drainFromWorker(reason) {
	const db = await openQueueDb()
	if (!db) return { attempted: 0, sent: 0, gaveUp: 0, retried: 0, reason }
	const owner = `sw-${Date.now().toString(36)}`
	// Closed on every path out, including the failure one.
	//
	// This was found by the round-trip drill: the worker opened the queue store
	// and kept the connection for the life of the worker, and an open connection
	// blocks `deleteDatabase` — so the *page* then failed to open the same store
	// and reported "this browser has no storage available", with the queue's own
	// `onblocked` handler resolving null. A worker that holds a database open
	// makes that database undeletable, and a store holding a health worker's
	// unsent reports has to stay deletable.
	let result
	try {
		result = await drainQueue(db, { owner, send: (record) => sendRecord(record) })
	} finally {
		try { db.close() } catch { /* already closed */ }
	}
	if (result.sent) {
		// A record delivered while nobody is looking changes what the next surface
		// should show, and a page that is open has a `lindela-queue-flushed`
		// listener shape to match.
		for (const client of await self.clients.matchAll({ includeUncontrolled: true })) {
			client.postMessage({ type: 'lindela-queue-flushed', detail: { ...result, reason, at: new Date().toISOString() } })
		}
	}
	return { ...result, reason }
}

// Background Sync: the browser wakes the worker when connectivity returns, which
// is the only way a report is delivered while the app is closed. Chrome and
// Edge support it; where it is absent the page's `online` listener and its
// 30-second poll remain the path, which is why they were never removed either.
SW?.addEventListener('sync', (event) => {
	if (event.tag === 'lindela-queue') event.waitUntil(drainFromWorker('sync'))
})

SW?.addEventListener('message', (event) => {
	// A page asking the worker to flush is a second drainer, and the claim makes
	// that safe — so this now acts rather than acknowledging. It is answered with
	// the outcome either way, so a caller can see what happened rather than
	// inferring it from an empty queue.
	if (event.data?.type === 'flushQueue') {
		event.waitUntil((async () => {
			const result = await drainFromWorker('message')
			const reply = { replayed: result.sent, owner: 'worker', ...result }
			if (event.ports?.[0]) event.ports[0].postMessage(reply)
			return reply
		})())
	}
})
