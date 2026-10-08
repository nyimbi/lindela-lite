/**
 * Raster basemap tiles, projected into the SVG map's viewport units.
 *
 * Extracted from app.js's map render for the same reason `map-frame.js` was:
 * this geometry is testable in Node without a DOM, and it has been wrong
 * before — the 2026-10-07 "tile service selector" pointed one hardcoded
 * `<image>` at `https://tile.openstreetmap.org/6/30/20.png` believing that
 * tile to be "East Africa for the pilot region". It is the North Sea off
 * Denmark. Turkana at zoom 6 is x=38, y=31. Slippy-map index arithmetic is
 * exactly the kind of thing that must be asserted, not eyeballed.
 *
 * Geometry: web-mercator tiles are drawn as rectangles in the frame's
 * equirectangular (plate carrée) coordinate system. A mercator tile covers a
 * constant-longitude strip of exactly `(x+1, x)` bounds, so a tile drawn as a
 * lon/lat rectangle is geometrically exact in longitude; in latitude the
 * mercator tile is *not* uniformly stretched in degrees (it covers more
 * degrees of latitude at its bottom edge than its top), so a linear placement
 * slightly compresses each tile's content vertically. The error is
 * `1 - cos(lat)`: ≤ 0.7% for the whole Horn of Africa frame and imperceptible
 * at district zoom. The alternative — reprojecting image contents — needs
 * canvas work no layer here has, for a third decimal of accuracy.
 *
 * URLs are same-origin (`/api/v1/basemap/tiles/…`) because the console sends
 * `content-security-policy: img-src 'self' data:` and the deployment story is
 * "the browser may not reach the internet at all; the server may" (ADR-013).
 * There is no third-party tile host anywhere in this file or its caller, by
 * construction: that is what made the previous attempt unrenderable.
 */

/** Below z2 one tile already spans half a hemisphere; there is nothing to show. */
export const TILE_MIN_ZOOM = 2
/**
 * OSM's tile usage policy asks proxies to stay modest; z15 shows a zonal
 * street pattern over a district and the console's markers, not a navigation
 * map, is what sits on top. The server rejects z>15 outright, so a future
 * client bug cannot turn into a 200-tile burst against a public good.
 */
export const TILE_MAX_ZOOM = 15

/** Web mercator's own edge. Tiles past it do not exist; clamp before indexing. */
export const MERCATOR_MAX_LAT = 85.05112878

/**
 * Tile providers reachable through the server's proxy route. The keys are the
 * `source` the `<select>` offers; `none` intentionally has no entry — it is
 * the vector-basemap fallback, and an absent key is how renderMapTiles
 * detects it.
 */
export const TILE_SOURCES = Object.freeze({
	osm: '/api/v1/basemap/tiles/osm',
	carto: '/api/v1/basemap/tiles/carto',
})

/**
 * Attribution requirements travel with the source, not the page: OSM's tile
 * usage policy requires visible "© OpenStreetMap contributors" credit, CARTO
 * adds their own line on top, and the vector-only fallback names itself so an
 * offline operator knows what they are looking at and why it has no streets.
 */
export const TILE_ATTRIBUTION = Object.freeze({
	osm: 'Basemap © OpenStreetMap contributors',
	carto: 'Basemap © OpenStreetMap contributors © CARTO',
	none: 'Offline vector basemap',
})

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/** Slippy-map x for a longitude, fractional. Callers floor it. */
export function lonToTileX(lon, zoom) {
	return ((clamp(lon, -180, 180) + 180) / 360) * 2 ** zoom
}

/**
 * Slippy-map y for a latitude, fractional. The mercator formula, in the
 * numerically kinder atanh form; the log-tan variant loses precision near the
 * poles, which are irrelevant here but not worth a subtly different formula.
 */
export function latToTileY(lat, zoom) {
	const latRad = (clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI) / 180
	const s = Math.sin(latRad)
	const capped = clamp(s, -1 + 1e-12, 1 - 1e-12)
	return ((1 - Math.atanh(capped) / Math.PI) / 2) * 2 ** zoom
}

/** Inverse: mercator y (0..2^z) back to degrees of latitude down to ±85.051. */
export function tileYToLat(y, zoom) {
	const g = (2 * y) / 2 ** zoom - 1
	return (Math.atan(Math.sinh(-Math.PI * g)) * 180) / Math.PI
}

/** The lon/lat rectangle web-mercator tile (x, y) at `zoom` covers. */
export function tileToBounds(x, y, zoom) {
	const n = 2 ** zoom
	return {
		west: (x / n) * 360 - 180,
		east: ((x + 1) / n) * 360 - 180,
		north: tileYToLat(y, zoom),
		south: tileYToLat(y + 1, zoom),
	}
}

/**
 * The zoom level that shows a visible lon/lat rect at its natural resolution.
 *
 * The frame is anchored on the horizontal axis: the map's viewBox is 1.6:1 and
 * its frames are data-fitted along the Horn's longitudes, so the horizontal
 * demand (`log2(360 · viewBoxW ÷ lonSpan ÷ tilePx)`) is the binding one — a
 * district focus then lands at street level instead of fetching a wall of
 * horizontally redundant tiles. The minimum of the two demands was tried and
 * is wrong here: for the default Horn frame it picks the vertical zoom and
 * renders a 35° of longitude across ~1.6 stretched, blurry tiles.
 *
 * The result is then stepped *down* only, until the tile budget fits. A tall
 * thin rect at high zoom would fetch hundreds of tiles; stepping down costs
 * resolution, never correctness, while a fetch storm against a free public
 * service is exactly what this proxy must not produce. The 2026-10-07
 * hardcoded "one tile for the region" is what happens without an enforced
 * budget: it chose a zoom no arithmetic supported.
 */
export function zoomForRect(rect, viewBoxW, viewBoxH, tilePx = 256, maxTiles = 64) {
	const lonSpan = (rect?.east ?? 0) - (rect?.west ?? 0)
	const zX = Math.log2((360 * viewBoxW) / (Math.max(lonSpan, 1e-4) * tilePx))
	let zoom = clamp(Math.round(zX), TILE_MIN_ZOOM, TILE_MAX_ZOOM)
	while (zoom > TILE_MIN_ZOOM && tilesForRect(rect, zoom, Infinity).length > maxTiles) zoom--
	return zoom
}

/**
 * Every tile covering a lon/lat rect at `zoom`, row-major, with each tile's
 * own bounds attached. Returns [] when the rect covers more than
 * `maxTiles` — never silently fetches a storm past the guard; the caller keeps
 * its previous grid instead, which for a sit-down console means the last good
 * imagery while the operator pans at a zoom level that is out of range.
 */
export function tilesForRect({ west, east, south, north }, zoom, maxTiles = 64) {
	if (!(zoom >= 0) || east <= west || north <= south) return []
	const n = 2 ** zoom
	const x0 = clamp(Math.floor(lonToTileX(west, zoom)), 0, n - 1)
	const x1 = clamp(Math.ceil(lonToTileX(east, zoom)) - 1, x0, n - 1)
	const y0 = clamp(Math.ceil(latToTileY(north, zoom)) - 1, 0, n - 1)
	const y1 = clamp(Math.floor(latToTileY(south, zoom)), y0, n - 1)
	if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles) return []
	const tiles = []
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			tiles.push({ z: zoom, x, y, ...tileToBounds(x, y, zoom) })
		}
	}
	return tiles
}

const round1 = (v) => Math.round(v * 10) / 10

/**
 * Aspect-preserving plate carrée projection of a bbox into a viewBox.
 *
 * The naive projection stretches longitude and latitude independently to fill
 * the viewBox, which deforms the map whenever the frame's aspect differs from
 * the viewBox's (1.6:1) — most visibly the near-square Africa frame, which
 * rendered the continent stretched east–west and its Mercator tiles with it.
 * A real map keeps ONE scale for both axes and centres the frame, so this
 * takes the limiting axis and centres the rest, leaving honest letterbox bands
 * on the shorter axis. Every layer that turns lon/lat into viewBox units —
 * vector rings, markers, and these raster tiles — goes through here, so they
 * cannot drift apart.
 */
export function mapProjection(bbox, viewBoxW, viewBoxH) {
	const lonSpan = bbox.maxLon - bbox.minLon
	const latSpan = bbox.maxLat - bbox.minLat
	const scale = Math.min(viewBoxW / lonSpan, viewBoxH / latSpan)
	return {
		scale,
		offsetX: (viewBoxW - lonSpan * scale) / 2,
		offsetY: (viewBoxH - latSpan * scale) / 2,
		minLon: bbox.minLon,
		maxLat: bbox.maxLat,
	}
}

/** lon/lat → viewBox point. Inverse of viewBoxToWorld. */
export function projectToViewBox(p, lat, lon) {
	return {
		x: (lon - p.minLon) * p.scale + p.offsetX,
		y: (p.maxLat - lat) * p.scale + p.offsetY,
	}
}

/** viewBox point → lon/lat. Inverse of projectToViewBox. */
export function viewBoxToWorld(p, x, y) {
	return {
		lon: (x - p.offsetX) / p.scale + p.minLon,
		lat: p.maxLat - (y - p.offsetY) / p.scale,
	}
}

/**
 * Where a tile sits in the SVG viewBox: a rectangle in the frame's plate
 * carrée space, the same coordinate the vector layers are drawn in. Returns
 * null for a tile whose rect has no area over the bbox (fully outside the
 * frame), so the caller does not append invisible elements.
 */
export function svgPlacement(tile, bbox, viewBoxW, viewBoxH) {
	if (!tile || !bbox) return null
	const p = mapProjection(bbox, viewBoxW, viewBoxH)
	if (!(p.scale > 0)) return null
	const tl = projectToViewBox(p, tile.north, tile.west)
	const width = (tile.east - tile.west) * p.scale
	const height = (tile.north - tile.south) * p.scale
	if (!(width > 0) || !(height > 0)) return null
	// A tile fully outside the frame would paint nothing; say null rather than
	// emit an element the vector layers would be alone in covering.
	if (tl.x + width <= 0 || tl.x >= viewBoxW || tl.y + height <= 0 || tl.y >= viewBoxH) return null
	return { x: round1(tl.x), y: round1(tl.y), width: round1(width), height: round1(height) }
}

/**
 * The part of the frame a transform actually shows, as a lon/lat rect.
 *
 * `#mapTransform` carries translate/scale in viewBox units, so the visible
 * viewBox region is the frame rect pulled back through that transform. Tiles
 * are enumerated for this rect only — enumerating for the whole frame at
 * deep zoom would fetch hundreds of tiles to show a few, the mistake the
 * original "one static tile" commit tried to avoid by fetching one that
 * covered none of the visible area.
 */
export function visibleWorldRect(bbox, transform, viewBoxW, viewBoxH) {
	if (!bbox || !transform) return null
	const p = mapProjection(bbox, viewBoxW, viewBoxH)
	if (!(p.scale > 0)) return null
	const { x, y, scale } = transform
	const s = Math.max(scale || 1, 0.05)
	const vx0 = -(x || 0) / s
	const vy0 = -(y || 0) / s
	const vx1 = vx0 + viewBoxW / s
	const vy1 = vy0 + viewBoxH / s
	const nw = viewBoxToWorld(p, vx0, vy0)
	const se = viewBoxToWorld(p, vx1, vy1)
	const west = clamp(nw.lon, bbox.minLon, bbox.maxLon)
	const east = clamp(se.lon, bbox.minLon, bbox.maxLon)
	const north = clamp(nw.lat, bbox.minLat, bbox.maxLat)
	const south = clamp(se.lat, bbox.minLat, bbox.maxLat)
	return { west, east, north, south, lonSpan: Math.max(0, east - west), latSpan: Math.max(0, north - south) }
}

/** Same-origin URL for a tile under the server's proxy route. */
export function tileUrlFor(source, tile) {
	const prefix = TILE_SOURCES[source]
	if (!prefix || !tile || !Number.isInteger(tile.z) || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) return null
	// Range-check like the server's route does: a nonsense z/x/y would build a
	// URL the proxy 400s on, and a broken-image element would never say why.
	const n = 2 ** tile.z
	if (tile.z < 0 || tile.z > TILE_MAX_ZOOM || tile.x < 0 || tile.x >= n || tile.y < 0 || tile.y >= n) return null
	return `${prefix}/${tile.z}/${tile.x}/${tile.y}.png`
}

/** Stable identity for "this exact grid", so unchanged pans do not repaint. */
export function tileGridKey(source, tiles) {
	const coords = tiles.map((t) => `${t.x},${t.y}`).sort()
	return `${source}:${tiles.length ? tiles[0].z : 'none'}:[${coords.join('|')}]`
}