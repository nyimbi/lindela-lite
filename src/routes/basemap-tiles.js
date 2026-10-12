import { loadRasterTile, upstreamTileUrl } from '../basemap-tiles.js'

/**
 * The raster basemap tile proxy (ADR-013).
 *
 * Extracted from `src/server.js` for the reason the export and tile-pack
 * families were: **the route reads no collection, and it sat below the store
 * read.** Every pan of the map is a fresh tile, so the whole store was
 * materialised — every collection, every row — to answer a request that reads
 * none of it. That is the "silently expensive" failure `ENH-07`'s table exists
 * to prevent, and it went unnoticed because the route was invisible to the
 * route-surface parser: it was written `/<literal>/.exec(url.pathname)`, a
 * spelling the parser did not read, so it appeared in no manifest, no document,
 * and no check.
 *
 * The parser reads that spelling now, and the family is dispatched above the
 * read, which is where a route that touches no collection belongs.
 *
 * The shape is deliberately strict. `upstreamTileUrl` range-checks every field,
 * so a malformed z/x/y is a 400 rather than a fetch against a public tile
 * service with a nonsense path — and the caller never supplies a URL, only a
 * source name from a closed set, which is this route's whole SSRF story.
 */

/**
 * `GET /api/v1/basemap/tiles/{osm|carto}/{z}/{x}/{y}.png` → a descriptor, else
 * `null`.
 *
 * The regex is written inline in this body rather than hoisted to a constant,
 * and that is load-bearing: `scripts/route-surface.mjs` reads a family's paths
 * out of its `match*Route` body, so a literal it cannot see is a family
 * reported as *no paths* — which passes the document comparison by contributing
 * nothing. The whole reason this route was invisible for its entire life is that
 * a parser could not read its spelling; hoisting the literal back out of the
 * matcher would reintroduce the same blindness by a different door.
 *
 * A non-GET is `null` rather than a descriptor the handler refuses, so the
 * dispatcher's 405 table stays the one place that answers "wrong verb". HEAD
 * never arrives here: the request pipeline rewrites HEAD to GET before dispatch
 * and suppresses the body on the response instead.
 */
export function matchTileRoute(pathname, method = 'GET') {
  if (String(method).toUpperCase() !== 'GET') return null
  const match = /^\/api\/v1\/basemap\/tiles\/(osm|carto)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(pathname || ''))
  if (!match) return null
  return { kind: 'basemap-tile', source: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) }
}

/** `true` when the route was handled, `false` when it was not this family's. */
export async function handleTileRoute(route, { req, res, url, jsonResponse }) {
  if (!route || route.kind !== 'basemap-tile') return false
  const { source, z, x, y } = route
  // Range-checked before the fetch, not after: `upstreamTileUrl` is the one
  // place that knows a tile coordinate is in bounds for its zoom.
  if (!upstreamTileUrl(source, z, x, y)) {
    jsonResponse(res, 400, { success: false, error: `Invalid basemap tile: ${url.pathname}` })
    return true
  }
  const tile = await loadRasterTile(source, z, x, y)
  if (!tile) {
    jsonResponse(res, 502, { success: false, error: 'Basemap tile upstream fetch failed' })
    return true
  }
  // Immutable imagery: max-age with no ETag revalidation, the same caching rule
  // the browser's own HTTP layer applies to a tile it fetched itself.
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': tile.bytes.length,
    'cache-control': 'public, max-age=86400, immutable',
  })
  res.end(req.method === 'HEAD' ? undefined : tile.bytes)
  return true
}
