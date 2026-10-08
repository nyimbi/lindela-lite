import { readFileSync } from 'node:fs'
import { fetchWithRetry } from './connectors/http.js'

/**
 * Raster basemap tile proxy for the console's situation map (ADR-013).
 *
 * The map draws OpenStreetMap/CARTO raster tiles under its data layers. The
 * tiles are fetched *server-side* and served same-origin, exactly the
 * pattern `terrain.js` established for elevation tiles — and for the same
 * three reasons:
 *
 * 1. The console's own CSP is `img-src 'self' data:`. A browser-direct
 *    `https://tile.openstreetmap.org/…` `<image>` is refused before the
 *    network layer is ever consulted — which is precisely what happened to
 *    the 2026-10-07 "tile service selector": its URLs were outside 'self', so
 *    even the one request its handler could have produced would have been
 *    blocked silently.
 * 2. A deployment (`deploy/one-click.sh`) is a machine in a district office:
 *    the *server* may have clean upstream connectivity where the browser may
 *    have none beyond the console itself.
 * 3. In-process caching turns one upstream identity with a modest rate
 *    footprint into the correct behaviour toward a free, shared public
 *    service. OSM tile policy requires a descriptive User-Agent; requests
 *    without one are indistinguishable from abuse.
 *
 * The proxy here is deliberately narrower than terrain.js: it stores bytes
 * and answers them. It does not decode, does not derive, and does not know
 * what a district is.
 */

/**
 * Upstream raster sources. Keys are the same strings `shared/tiles.js`
 * offers the operator. Both are unauthenticated, and both are static imagery:
 * a z/x/y tile never changes meaning (only OSM's editors change the pixels),
 * so every layer of caching between here and the browser is correct.
 *
 * `carto.light_all` is CARTO's attribution-licensed raster of the OSM data —
 * a quieter basemap under coloured data layers. `stamen` was in the 2026
 * selector and is gone: those Fastly hosts were retired in 2023 and served
 * 404s to anyone who clicked it.
 */
const TILE_UPSTREAMS = {
	osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
	carto: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
}

export const MAX_TILE_ZOOM = 15

const TILE_TIMEOUT_MS = 15000
const MAX_TILE_BYTES = 1024 * 1024
const TILE_CACHE_LIMIT = 600

/** Descriptive UA is an OSM tile usage policy requirement, not a nicety. */
const USER_AGENT = `Lindela-Lite/${appVersion()} (situational dashboard; basemap tile proxy)`

function appVersion() {
	try {
		return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0'
	} catch {
		// A proxy is still served without a version string; it is only the
		// upstream identity that coarsens. Never an exception path for tiles.
		return '0'
	}
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/**
 * The upstream URL for a tile, or null when the request is malformed in a way
 * that should be a 400 rather than a fetch. Bounds the numbers so the route
 * can never be talked into a path that surprises the upstream (x/y past 2^z,
 * absurd zoom) — every field is range-checked here rather than trusting the
 * regex that matched it.
 */
export function upstreamTileUrl(source, z, x, y) {
	const template = TILE_UPSTREAMS[source]
	if (!template) return null
	if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null
	if (z < 0 || z > MAX_TILE_ZOOM) return null
	const n = 2 ** z
	if (x < 0 || x >= n || y < 0 || y >= n) return null
	return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

// In-process LRU, keyed `source/z/x/y`: an operator panning a district reuses
// its handful of tiles hundreds of times per minute of operation, so the first
// view's cost is amortised within the process — same shape of cache as
// terrain.js's tile cache, for bytes instead of decoded elevations.
const tileCache = new Map()
// The map's first paint issues ~a dozen tile requests in parallel; coalescing
// them is what keeps a cold operator opening two frames from issuing that
// twice against the upstream.
const tileInflight = new Map()

/** Same bytes, same headers, for the same immutable tile (ADR-013). */
export async function loadRasterTile(source, z, x, y) {
	const url = upstreamTileUrl(source, z, x, y)
	if (!url) return null
	const cacheKey = `${source}/${z}/${x}/${y}`
	const hit = tileCache.get(cacheKey)
	if (hit) {
		tileCache.delete(cacheKey)
		tileCache.set(cacheKey, hit)
		return hit
	}
	const existing = tileInflight.get(cacheKey)
	if (existing) return existing

	const promise = (async () => {
		try {
			const bytes = await fetchWithRetry(url, {
				parse: 'buffer',
				retries: 1,
				timeoutMs: TILE_TIMEOUT_MS,
				headers: { 'user-agent': USER_AGENT, accept: 'image/png,image/*;q=0.8,*/*;q=0.5' },
			})
			// An upstream that answers 200 with a non-PNG body would reach the
			// browser as a broken image and nothing would say why. Verify the
			// signature — four bytes, not a parse.
			const looksPng = bytes?.length >= 8 && bytes.subarray(0, 4).equals(PNG_MAGIC)
			if (!bytes?.length || bytes.length > MAX_TILE_BYTES || !looksPng) return null
			const entry = { bytes, fetchedAt: Date.now() }
			tileCache.set(cacheKey, entry)
			if (tileCache.size > TILE_CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value)
			return entry
		} finally {
			tileInflight.delete(cacheKey)
		}
	})()
	tileInflight.set(cacheKey, promise)
	return promise
}

/** Test seam: upstream state must not leak between tests through the LRU. */
export function clearRasterTileCache() {
	tileCache.clear()
	tileInflight.clear()
}