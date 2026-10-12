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

/**
 * The tile server an offline pack is built from, or `null` when there is none.
 *
 * ENH-42 does not build packs from `TILE_UPSTREAMS`, and this variable exists
 * rather than a default because both public upstreams prohibit exactly that, by
 * name. The OSM Tile Usage Policy §4 is titled "Prohibited: bulk downloading
 * ("scraping") and offline use" and lists *"Building tile archives (e.g. `.zip`,
 * `.mbtiles`) for later distribution"* and *"Offline use is not permitted on
 * tile.openstreetmap.org"*; the CARTO Basemap Terms §9.c prohibit *"downloading
 * or extracting map content in bulk"*. Both are archived verbatim with
 * citations under `docs/research/tile-packs/sources/`.
 *
 * OSM names the remedy — *"use self-hosted tiles or a provider that explicitly
 * allows offline/prefetching"* — and that remedy is this variable. So unset is
 * the shipped default, and a pack request without it is refused by name rather
 * than served from a server whose terms forbid it. The plan route still works
 * unconfigured: it is arithmetic over a bbox, and an operator sizes a pack
 * before standing a tile server up.
 *
 * The template is operator configuration, not caller input, which is the same
 * jurisdiction as `RAPIDPRO_BASE_URL` — and it is why the route validates it
 * with `assertConnectorUrl` (metadata ranges refused, RFC-1918 permitted: a
 * district office's own tile server is on its LAN).
 */
export function packTileTemplate(env = process.env) {
	const raw = String(env.LINDELA_LITE_PACK_TILE_URL || '').trim()
	if (!raw) return null
	if (!/\{z\}/.test(raw) || !/\{x\}/.test(raw) || !/\{y\}/.test(raw)) {
		throw new Error('LINDELA_LITE_PACK_TILE_URL must be a tile URL template containing {z}, {x} and {y}')
	}
	return raw
}

/**
 * The URL for one tile of an operator-configured pack source, or null when the
 * request is malformed.
 *
 * Range-checked field by field exactly as `upstreamTileUrl` is, and for the
 * same reason: the template is a prefix and the coordinates are the caller's,
 * so a pack request must not be able to aim the server at a path it did not
 * mean. `{z}`/`{x}`/`{y}` are substituted as *text*, so a caller-supplied
 * string can never become part of the path.
 */
export function packTileUrl(template, z, x, y) {
	if (!template) return null
	if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null
	if (z < 0 || z > MAX_TILE_ZOOM) return null
	const n = 2 ** z
	if (x < 0 || x >= n || y < 0 || y >= n) return null
	return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

/** Same bytes, same headers, for the same immutable tile (ADR-013). */
export async function loadRasterTile(source, z, x, y) {
	const url = upstreamTileUrl(source, z, x, y)
	if (!url) return null
	return loadTileAt(`${source}/${z}/${x}/${y}`, url)
}

/**
 * One tile of a pack source. Shares `loadTileAt` with the proxy above rather
 * than repeating the fetch, because the PNG-signature check is the part a
 * second copy would drop — and a pack assembled from bodies nobody verified is
 * a pack whose holes are invisible until a phone is offline in a ward.
 */
export async function loadPackTile(template, z, x, y) {
	const url = packTileUrl(template, z, x, y)
	if (!url) return null
	return loadTileAt(`pack:${z}/${x}/${y}`, url)
}

/** The fetch, the signature check and the LRU, shared by both entry points. */
async function loadTileAt(cacheKey, url) {
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
		} catch {
			// `null`, not a throw — and this is load-bearing for both callers.
			//
			// `fetchWithRetry` raises an `HttpError` on any non-2xx, so without
			// this every upstream 404 became an exception thrown out of the
			// route. Both callers already branch on a null tile: the proxy
			// answers 502 and the pack builder records a hole. Those branches
			// were unreachable for any non-2xx — a missing tile took the whole
			// request down instead of being reported, which is precisely the
			// defect ENH-42 exists to prevent ("a pack built with holes that
			// ships as complete renders a blank square in a ward and says
			// nothing" — this was the louder version: no pack at all).
			//
			// A timeout and a connection refusal land here too, which is right:
			// for a tile, "the server did not answer" and "the server answered
			// 404" are the same fact — this tile is not available — and neither
			// should be an unhandled rejection.
			return null
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