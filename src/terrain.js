import { fetchWithRetry } from './connectors/http.js'
import { clamp } from './utils.js'
import { inflateSync } from 'node:zlib'

/**
 * Terrain elevation from AWS "Terrarium" tiles.
 *
 * Source: https://registry.opendata.aws/terrain-tiles/ — SRTM, NED, GMTED and
 * friends reprojected into a single RGB encoding, served as PNG. No API key,
 * no account, no rate-limit negotiation. That last point matters for a
 * humanitarian deployment: an unauthenticated public bucket will not fail
 * because someone's key expired mid-crisis.
 *
 * Encoding: elevation_m = (R * 256 + G + B / 256) - 32768
 *
 * Vertical error is roughly ±15 m where SRTM applies, which is fine for
 * "is this valley floor under water" and NOT fine for centimetre-level
 * engineering. Every function here is explicit about which it is doing.
 *
 * Tiles are fetched lazily and cached in-process. A flood-depth query for one
 * point needs a handful of tiles, not the whole region.
 */

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const TILE_SIZE = 256
const NO_DATA = -32768
const DEFAULT_TIMEOUT_MS = 15000

// Beyond z13 the payload is no longer worth the request: 1 pixel covers
// ~19 m at the equator, which is finer than the vertical accuracy of the
// underlying DEM for flood purposes.
export const MAX_ZOOM = 13
export const MIN_ZOOM = 5

const tileCache = new Map()

/** Slippy-map tile coordinates for a point at a given zoom. */
export function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom
  const latRad = (clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y, z: zoom }
}

/** Geographic bounds covered by one tile. */
export function tileBounds(x, y, zoom) {
  const n = 2 ** zoom
  const lon = (x / n) * 360 - 180
  const lonNext = ((x + 1) / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  const lat = (latRad * 180) / Math.PI
  const latNext = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)))
  const latNextDeg = (latNext * 180) / Math.PI
  return { west: lon, east: lonNext, south: Math.min(lat, latNextDeg), north: Math.max(lat, latNextDeg) }
}

/**
 * Decodes a Terrarium PNG into an elevation grid.
 *
 * PNG decoding is done in-process rather than by shelling out to an image
 * library: Terrarium is a fixed, simple case (8-bit RGB, non-interlaced), and
 * adding an image dependency for it would be a poor trade. Handles the five
 * PNG filter types so it works against real tiles, not just synthetic ones.
 */
export function decodeTerrarium(pngBuffer) {
  const { width, height, pixels } = decodePngRgb(pngBuffer)
  const grid = new Float64Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const r = pixels[i * 3]
    const g = pixels[i * 3 + 1]
    const b = pixels[i * 3 + 2]
    const elevation = r * 256 + g + b / 256 - 32768
    grid[i] = elevation <= NO_DATA ? NaN : elevation
  }
  return { width, height, grid }
}

/** Minimal PNG reader: 8-bit truecolour, non-interlaced. */
function decodePngRgb(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG')
  }
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }

  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(`unsupported PNG: depth=${bitDepth} colorType=${colorType} interlace=${interlace}`)
  }

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 3
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let prevRow = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = Buffer.from(src)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prevRow[x]
      const c = x >= bpp ? prevRow[x - bpp] : 0
      if (filter === 1) row[x] = (row[x] + a) & 0xff
      else if (filter === 2) row[x] = (row[x] + b) & 0xff
      else if (filter === 3) row[x] = (row[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) row[x] = (row[x] + paeth(a, b, c)) & 0xff
    }
    row.copy(out, y * stride)
    prevRow = row
  }

  return { width, height, pixels: out }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Fetches (and caches) one decoded tile.
 */
export async function loadTile(x, y, zoom, options = {}) {
  const key = `${zoom}/${x}/${y}`
  if (!options.noCache && tileCache.has(key)) return tileCache.get(key)

  const url = TILE_URL.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y))
  const response = await fetchWithRetry(url, {
    retries: options.retries ?? 2,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: 'buffer',
  })
  // fetchWithRetry returns text unless told otherwise; re-read as bytes.
  const buffer = Buffer.isBuffer(response) ? response : Buffer.from(String(response), 'binary')
  const decoded = decodeTerrarium(buffer)
  tileCache.set(key, decoded)
  return decoded
}

/** Resets the tile cache. Used by tests. */
export function clearTileCache() {
  tileCache.clear()
}

/**
 * Bilinearly-interpolated elevation at a point, in metres.
 * Returns null when no tile covers the point or the tile has no data there.
 *
 * Zoom 12 is the default: ~38 m/px at the equator, inside the ±15 m vertical
 * accuracy of the underlying DEM. Higher zoom interpolates more finely than
 * the source data actually resolves, which is confidence theatre.
 */
export async function elevationAt(lat, lon, options = {}) {
  const zoom = clamp(Math.floor(options.zoom ?? 12), MIN_ZOOM, MAX_ZOOM)
  const tile = lonLatToTile(lon, lat, zoom)
  let decoded
  try {
    decoded = await loadTile(tile.x, tile.y, zoom, options)
  } catch {
    return null
  }
  return elevationFromTile(decoded, tile, zoom, lat, lon)
}

/** Pure interpolation against an already-decoded tile. */
export function elevationFromTile(decoded, tile, zoom, lat, lon) {
  const bounds = tileBounds(tile.x, tile.y, zoom)
  const xFraction = (lon - bounds.west) / (bounds.east - bounds.west)
  const yFraction = (lat - bounds.north) / (bounds.south - bounds.north)
  const fx = clamp(xFraction * decoded.width, 0, decoded.width - 1)
  const fy = clamp(yFraction * decoded.height, 0, decoded.height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, decoded.width - 1)
  const y1 = Math.min(y0 + 1, decoded.height - 1)
  const dx = fx - x0
  const dy = fy - y0

  const g = decoded.grid
  const e00 = g[y0 * decoded.width + x0]
  const e10 = g[y0 * decoded.width + x1]
  const e01 = g[y1 * decoded.width + x0]
  const e11 = g[y1 * decoded.width + x1]

  const values = [e00, e10, e01, e11]
  if (values.some((v) => Number.isNaN(v))) return null

  return (e00 * (1 - dx) * (1 - dy)) + (e10 * dx * (1 - dy)) + (e01 * (1 - dx) * dy) + (e11 * dx * dy)
}

/**
 * Sample a window against an already-decoded tile. Pure; no fetch.
 *
 * Split out from `elevationWindow` so the void-cell rule below is testable
 * without a network. A DEM tile's nodata region is ocean, or coverage the
 * provider did not have, and both are places where the platform has no idea
 * what the ground does — so a void sample is `NaN`, not `0`. It used to be
 * written as the `null` that `elevationFromTile` returns, into a `Float64Array`,
 * and a typed array coerces `null` to zero: every uncovered sample came back as
 * sea level. `terrainContext`'s `.filter(Number.isFinite)` was the guard that
 * should have caught it, and it was dead code because a zero is a perfectly
 * finite elevation.
 *
 * `NaN` also serialises to `null`, which is the platform's convention for an
 * absent value, so this needs no special case at the HTTP boundary.
 */
export function elevationWindowFromTile(decoded, tile, zoom, lat, lon, { radiusDeg = 0.02, size = 33 } = {}) {
  const stepLat = (radiusDeg * 2) / (size - 1)
  const stepLon = (radiusDeg * 2) / (size - 1)
  const values = new Float64Array(size * size).fill(NaN)

  for (let row = 0; row < size; row += 1) {
    const sampleLat = lat + radiusDeg - row * stepLat
    for (let col = 0; col < size; col += 1) {
      const sampleLon = lon - radiusDeg + col * stepLon
      const value = elevationFromTile(decoded, tile, zoom, sampleLat, sampleLon)
      values[row * size + col] = value === null ? NaN : value
    }
  }

  return { values, size, step_degrees: { lat: stepLat, lon: stepLon }, center: { lat, lon }, bounds: tileBounds(tile.x, tile.y, zoom) }
}

/** Fetch the covering tile and sample a window around a point, or null if unavailable. */
export async function elevationWindow(lat, lon, options = {}) {
  const zoom = clamp(Math.floor(options.zoom ?? 12), MIN_ZOOM, MAX_ZOOM)
  const radiusDeg = options.radiusDeg ?? 0.02
  const size = clamp(Math.floor(options.size ?? 33), 3, 129)

  const tile = lonLatToTile(lon, lat, zoom)
  let decoded
  try {
    decoded = await loadTile(tile.x, tile.y, zoom, options)
  } catch {
    return null
  }

  return elevationWindowFromTile(decoded, tile, zoom, lat, lon, { radiusDeg, size })
}

export function elevationAtCacheInfo() {
  return { tiles: tileCache.size, url_template: TILE_URL }
}