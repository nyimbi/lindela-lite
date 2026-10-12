/**
 * ENH-42 — offline map tile packs: the planner, the PMTiles writer's pure half,
 * and the manifest a client verifies a download against.
 *
 * The console's map (`shared/basemap.js`) is inline polygons that fetch nothing,
 * so the offline map is a fixed asset. A community health worker in a ward with
 * no connection needs the *raster terrain* for their ward, not the country
 * outline, and the server's tile proxy (`src/basemap-tiles.js`, ADR-013) is only
 * reachable when there is a connection to it. A pack is the answer: an operator
 * names a bbox, the server enumerates every tile that bbox needs, and the result
 * is one file the phone holds.
 *
 * **This file is the pure half and carries no Node built-in.** Enumeration is
 * index arithmetic, the PMTiles directory is a byte layout, and the manifest is
 * a check over a tile id list — none of it needs `node:crypto` or the network.
 * The one thing it cannot do itself is a sha256, so `buildPmtilesArchive` takes
 * the digest function as an argument, exactly as `shared/audit-chain-core.js`
 * takes one for the audit chain. `src/tile-pack.js` supplies `crypto.createHash`
 * and the tile fetcher; there is no second copy of the format anywhere.
 *
 * **Three claims this file is built to keep, and each is a failure the naive
 * version ships silently.**
 *
 * 1. *The enumeration is exact.* A pack that misses a tile renders a hole at the
 *    edge of a ward and says nothing — the map just ends. `tilesForRect` in
 *    `shared/tiles.js` owns the index arithmetic (it was written after a
 *    hardcoded tile believed to be "East Africa" turned out to be the North Sea,
 *    so the arithmetic is asserted there and reused here, never re-derived).
 *    `planTilePack` enumerates through it and then checks that all four corners
 *    of the bbox are inside the tile set — an explicit guard, because the failure
 *    it catches is invisible on screen.
 *
 * 2. *Over-budget is refused, with the numbers.* A truncated pack is a map with
 *    holes the operator cannot see, so a plan that exceeds its tile or byte
 *    budget returns `{ ok: false, reason, tileCount, maxTiles, … }` and never a
 *    shorter list. The exact count is computed before anything is materialised,
 *    so the refusal names the real number rather than a lower bound.
 *
 * 3. *The manifest can detect a missing tile.* A manifest that carries only a
 *    count cannot say *which* tile is absent, which is the only thing a client
 *    holding a partial download needs to know. This one carries the sorted tile
 *    id list, so `verifyPackManifest` names the missing tiles rather than
 *    reporting a number that disagrees.
 */

import {
  MERCATOR_MAX_LAT,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
  latToTileY,
  lonToTileX,
  tilesForRect,
} from './tiles.js'

export { TILE_MAX_ZOOM, TILE_MIN_ZOOM }

/** PMTiles v3. The archived spec is `docs/research/tile-packs/sources/pmtiles-v3-spec.md`. */
export const PMTILES_VERSION = 3
export const PMTILES_MAGIC = 'PMTiles'
/** Fixed header length, and the ceiling the spec puts on header + root directory. */
export const PMTILES_HEADER_BYTES = 127
export const PMTILES_ROOT_MAX_BYTES = 16384

/** The manifest's own version, separate from the archive's, so the two can move apart. */
export const PACK_MANIFEST_VERSION = 1

/**
 * Tile compression values from the spec (§3.3). OSM and CARTO serve PNG, so the
 * tiles are stored uncompressed and the archive declares "none" for both the
 * internal sections and the tile data.
 */
export const PMTILES_COMPRESSION = Object.freeze({ UNKNOWN: 0x00, NONE: 0x01, GZIP: 0x02, BROTLI: 0x03, ZSTD: 0x04 })
export const PMTILES_TILE_TYPE = Object.freeze({ UNKNOWN: 0x00, MVT: 0x01, PNG: 0x02, JPEG: 0x03, WEBP: 0x04, AVIF: 0x05 })

/**
 * The default budget. `maxTiles` bounds the request count against the public
 * tile services the proxy reads (OSM's usage policy asks proxies to stay
 * modest); `maxBytes` bounds the file a field phone stores. `tileBytes` is the
 * planning average — a 256px raster tile is 10–40 KB — so the byte refusal is a
 * prediction the build then confirms against the real sizes.
 */
export const DEFAULT_PACK_BUDGET = Object.freeze({
  maxTiles: 20000,
  maxBytes: 64 * 1024 * 1024,
  tileBytes: 24 * 1024,
})

/** A ward is a few kilometres; z14 shows its street pattern. Deep enough to be useful, shallow enough to fit. */
export const DEFAULT_PACK_MAX_ZOOM = 14
export const DEFAULT_PACK_MIN_ZOOM = TILE_MIN_ZOOM

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// ── Hilbert tile ids (PMTiles spec §4.1) ────────────────────────────────────
//
// The spec defines a TileID as "a cumulative position on the series of Hilbert
// curves starting at zoom level 0" and supplies a table rather than a formula.
// This is the same z-order/Hilbert pair the reference implementation uses, and
// the spec's own table is a test: z0/x0/y0 = 0, the four z1 tiles = 1..4,
// z2/x0/y0 = 5, and z12/x3423/y1763 = 19078479. A Hilbert id is *not* a
// row-major index, so `tilesForRect`'s (x, y) grid is not the write order — the
// ids are, which is why the archive sorts on them.

function rotate(n, x, y, rx, ry) {
  if (ry === 0) {
    if (rx !== 0) return [n - 1 - y, n - 1 - x]
    return [y, x]
  }
  return [x, y]
}

/** Hilbert TileID for (z, x, y). Throws on a zoom or coordinate the id cannot represent. */
export function zxyToTileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 26) throw new Error(`tile-pack: zoom ${z} is outside 0..26, where a TileID is exact`)
  const n = 1 << z
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    throw new Error(`tile-pack: (${z}/${x}/${y}) is not a tile at zoom ${z}`)
  }
  let acc = (n * n - 1) / 3
  let a = z - 1
  let tx = x
  let ty = y
  for (let s = 1 << a; s > 0; s >>= 1) {
    const rx = tx & s
    const ry = ty & s
    acc += ((3 * rx) ^ ry) * (1 << a)
    ;[tx, ty] = rotate(s, tx, ty, rx, ry)
    a -= 1
  }
  return acc
}

function zoomForTileId(i) {
  const c = 3 * i + 1
  return c < 0x100000000 ? 31 - Math.clz32(c) : 63 - Math.clz32(c / 0x100000000)
}

/** Inverse of `zxyToTileId`. */
export function tileIdToZxy(i) {
  if (!Number.isInteger(i) || i < 0) throw new Error(`tile-pack: tile id ${i} is not a non-negative integer`)
  const z = zoomForTileId(i) >> 1
  if (z > 26) throw new Error(`tile-pack: tile id ${i} decodes past zoom 26`)
  const acc = ((1 << z) * (1 << z) - 1) / 3
  let t = i - acc
  let x = 0
  let y = 0
  const n = 1 << z
  for (let s = 1; s < n; s <<= 1) {
    const rx = s & Math.floor(t / 2)
    const ry = s & (t ^ rx)
    ;[x, y] = rotate(s, x, y, rx, ry)
    t = Math.floor(t / 2)
    x += rx
    y += ry
  }
  return { z, x, y }
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/**
 * The tile range `tilesForRect` will cover for a rect, as indices and an exact
 * count, without materialising the tiles.
 *
 * This exists so an over-budget refusal can name the real number: `tilesForRect`
 * returns `[]` once a grid exceeds its `maxTiles`, which collapses "over budget"
 * and "nothing here" into one answer and makes the refusal say nothing useful.
 * The index arithmetic here uses the same `lonToTileX`/`latToTileY` primitives
 * and the same clamping `tilesForRect` uses — never a re-derived formula — and
 * `test/tile-pack.test.js` pins the two together across rects and zooms, so a
 * change to one that the other does not follow is a failing test.
 */
export function tileRangeForRect({ west, east, south, north }, zoom) {
  if (!Number.isInteger(zoom) || zoom < 0 || east <= west || north <= south) return null
  const n = 2 ** zoom
  const x0 = clamp(Math.floor(lonToTileX(west, zoom)), 0, n - 1)
  const x1 = clamp(Math.ceil(lonToTileX(east, zoom)) - 1, x0, n - 1)
  const y0 = clamp(Math.ceil(latToTileY(north, zoom)) - 1, 0, n - 1)
  const y1 = clamp(Math.floor(latToTileY(south, zoom)), y0, n - 1)
  return { zoom, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) }
}

/**
 * The bbox corners not covered by `tiles` at `zoom`, named.
 *
 * The containing tile of a corner is found the same way `tilesForRect` finds its
 * range, so this agrees with the enumerator by construction — and disagrees
 * loudly if the enumerator is ever wrong. A corner outside the set is a hole at
 * the edge of the frame, which renders as "the map ends here" and never as an
 * error, so it is checked rather than assumed.
 */
export function uncoveredCorners({ west, east, south, north }, tiles, zoom) {
  const n = 2 ** zoom
  const present = new Set(tiles.map((t) => `${t.x},${t.y}`))
  const clampIndex = (v) => clamp(v, 0, n - 1)
  // The corner tile is derived exactly as `tilesForRect` derives its own range
  // bounds, not with a bare `floor`. At an exact tile boundary the two differ by
  // one: `north = 0` (the equator) is an exact boundary at every zoom, and the
  // enumerator places the top edge in tile `ceil(·) - 1` while a `floor` would
  // name the tile below it — reporting a complete pack as holed at the corner.
  const x0 = clampIndex(Math.floor(lonToTileX(west, zoom)))
  const x1 = clampIndex(Math.ceil(lonToTileX(east, zoom)) - 1)
  const y0 = clampIndex(Math.ceil(latToTileY(north, zoom)) - 1)
  const y1 = clampIndex(Math.floor(latToTileY(south, zoom)))
  const corners = [
    ['northwest', x0, y0],
    ['northeast', x1, y0],
    ['southwest', x0, y1],
    ['southeast', x1, y1],
  ]
  return corners.filter(([, x, y]) => !present.has(`${x},${y}`)).map(([name]) => name)
}

/**
 * Plan a pack for a bbox: every tile, or a refusal that names why.
 *
 * Returns `{ ok: true, bbox, minZoom, maxZoom, tiles, tileCount, estimatedBytes }`
 * or `{ ok: false, reason, … }` where the reason is one of `invalid_bbox`,
 * `outside_mercator`, `invalid_zoom`, `empty_enumeration`, `corner_uncovered`,
 * `tile_budget`, `byte_budget`. A refusal is a value, not a throw: the operator
 * surface renders it, and a thrown error would become a 500 with no numbers in
 * it.
 */
export function planTilePack({
  bbox,
  minZoom = DEFAULT_PACK_MIN_ZOOM,
  maxZoom = DEFAULT_PACK_MAX_ZOOM,
  budget = DEFAULT_PACK_BUDGET,
} = {}) {
  const limits = { ...DEFAULT_PACK_BUDGET, ...(budget || {}) }
  const refusal = (reason, detail = {}) => ({ ok: false, reason, bbox: bbox ?? null, minZoom, maxZoom, ...detail })

  const { west, east, south, north } = bbox ?? {}
  if (![west, east, south, north].every(Number.isFinite)) {
    return refusal('invalid_bbox', { detail: 'bbox must name finite west, east, south and north' })
  }
  // A zero-area bbox, and a bbox written west>east to cross the antimeridian,
  // both land here. Neither has a tile enumeration, and answering either with an
  // empty pack would be a download that renders nothing.
  if (east <= west) {
    return refusal('invalid_bbox', { detail: `east ${east} must be greater than west ${west}; a zero-area or antimeridian-crossing bbox has no tile enumeration` })
  }
  if (north <= south) {
    return refusal('invalid_bbox', { detail: `north ${north} must be greater than south ${south}` })
  }
  // Past mercator's edge there are no tiles, so the pack cannot cover what was
  // asked for. Clamping instead would hand back a pack that silently stops at
  // 85.05° and calls it the operator's bbox.
  if (Math.abs(north) > MERCATOR_MAX_LAT || Math.abs(south) > MERCATOR_MAX_LAT) {
    return refusal('outside_mercator', {
      detail: `latitudes beyond ±${MERCATOR_MAX_LAT} have no tiles; the pack cannot cover this bbox`,
      mercatorMaxLat: MERCATOR_MAX_LAT,
    })
  }
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom > maxZoom) {
    return refusal('invalid_zoom', { detail: `zoom range ${minZoom}..${maxZoom} is not an ascending pair of integers` })
  }
  if (minZoom < TILE_MIN_ZOOM || maxZoom > TILE_MAX_ZOOM) {
    return refusal('invalid_zoom', {
      detail: `zoom range ${minZoom}..${maxZoom} is outside ${TILE_MIN_ZOOM}..${TILE_MAX_ZOOM}, the range the tile proxy serves`,
      tileMinZoom: TILE_MIN_ZOOM,
      tileMaxZoom: TILE_MAX_ZOOM,
    })
  }

  const rect = { west, east, south, north }
  const tiles = []
  let tileCount = 0
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForRect(rect, z)
    if (!range || range.count === 0) {
      return refusal('empty_enumeration', { detail: `zoom ${z} covers no tile of this bbox`, zoom: z })
    }
    tileCount += range.count
    // The budget is checked against the running exact count *before* the grid is
    // materialised, so a bbox that would need a million tiles refuses in
    // constant memory instead of building the array first.
    if (tileCount > limits.maxTiles) {
      return refusal('tile_budget', {
        tileCount,
        maxTiles: limits.maxTiles,
        detail: `this bbox needs ${tileCount} tiles across z${minZoom}..z${maxZoom}, over the ${limits.maxTiles}-tile budget; lower maxZoom or shrink the bbox`,
      })
    }
    const atZoom = tilesForRect(rect, z, limits.maxTiles)
    if (atZoom.length !== range.count) {
      return refusal('empty_enumeration', { detail: `the enumerator returned ${atZoom.length} tiles for zoom ${z}, expected ${range.count}`, zoom: z })
    }
    const uncovered = uncoveredCorners(rect, atZoom, z)
    if (uncovered.length) {
      return refusal('corner_uncovered', {
        zoom: z,
        corners: uncovered,
        detail: `zoom ${z} left the ${uncovered.join(', ')} corner outside the tile set; a pack with this gap renders a hole and no error`,
      })
    }
    tiles.push(...atZoom)
  }

  const estimatedBytes = tileCount * limits.tileBytes
  if (estimatedBytes > limits.maxBytes) {
    return refusal('byte_budget', {
      tileCount,
      estimatedBytes,
      maxBytes: limits.maxBytes,
      detail: `this pack is about ${Math.round(estimatedBytes / 1024)} KB, over the ${Math.round(limits.maxBytes / 1024)} KB budget`,
    })
  }

  return { ok: true, bbox: rect, minZoom, maxZoom, tiles, tileCount, estimatedBytes, tileIds: tiles.map((t) => zxyToTileId(t.z, t.x, t.y)) }
}

// ── PMTiles byte layout (spec §3–§4) ────────────────────────────────────────

function writeVarint(out, value) {
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v & 0x7f)
}

function readVarint(bytes, cursor) {
  let result = 0
  let shift = 0
  for (;;) {
    if (cursor.i >= bytes.length) throw new Error('tile-pack: varint ran past the end of the buffer')
    const b = bytes[cursor.i]
    cursor.i += 1
    result += (b & 0x7f) * 2 ** shift
    if (b < 0x80) return result
    shift += 7
    if (shift > 63) throw new Error('tile-pack: varint is longer than 10 bytes')
  }
}

/**
 * Encode a directory (spec §4.2): entry count, then delta-encoded TileIDs,
 * RunLengths, Lengths and Offsets, each a little-endian varint. Offsets are
 * written as `0` when the entry continues straight from the previous one, so a
 * clustered archive costs one byte per tile after the first.
 */
export function encodePmtilesDirectory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('tile-pack: a directory must hold at least one entry')
  const out = []
  writeVarint(out, entries.length)
  let lastId = 0
  for (const entry of entries) {
    writeVarint(out, entry.tileId - lastId)
    lastId = entry.tileId
  }
  for (const entry of entries) writeVarint(out, entry.runLength)
  for (const entry of entries) {
    if (!(entry.length > 0)) throw new Error(`tile-pack: tile ${entry.tileId} has length ${entry.length}; the spec requires a length greater than 0`)
    writeVarint(out, entry.length)
  }
  let nextByte = 0
  entries.forEach((entry, index) => {
    writeVarint(out, index > 0 && entry.offset === nextByte ? 0 : entry.offset + 1)
    nextByte = entry.offset + entry.length
  })
  return Uint8Array.from(out)
}

/** Decode a directory. The inverse of `encodePmtilesDirectory`, used by a client reading an archive. */
export function decodePmtilesDirectory(bytes) {
  const cursor = { i: 0 }
  const count = readVarint(bytes, cursor)
  const entries = []
  let lastId = 0
  for (let i = 0; i < count; i += 1) {
    lastId += readVarint(bytes, cursor)
    entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 1 })
  }
  for (let i = 0; i < count; i += 1) entries[i].runLength = readVarint(bytes, cursor)
  for (let i = 0; i < count; i += 1) entries[i].length = readVarint(bytes, cursor)
  for (let i = 0; i < count; i += 1) {
    const v = readVarint(bytes, cursor)
    if (v === 0 && i > 0) entries[i].offset = entries[i - 1].offset + entries[i - 1].length
    else entries[i].offset = v - 1
  }
  return entries
}

function writeU64(view, offset, value) {
  view.setUint32(offset, value >>> 0, true)
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true)
}

function readU64(view, offset) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32
}

/** A Position (spec §3.4): longitude then latitude, each ×1e7 as a little-endian int32. */
function writePosition(view, offset, lon, lat) {
  view.setInt32(offset, Math.round(lon * 1e7), true)
  view.setInt32(offset + 4, Math.round(lat * 1e7), true)
}

function readPosition(view, offset) {
  return { lon: view.getInt32(offset, true) / 1e7, lat: view.getInt32(offset + 4, true) / 1e7 }
}

/**
 * The 127-byte header (spec §3). Field order and widths are the spec's table
 * byte for byte; the layout is asserted against the spec's own offsets in the
 * tests, because an off-by-one here produces a file every reader rejects.
 */
export function buildPmtilesHeader({
  rootOffset,
  rootLength,
  metadataOffset,
  metadataLength,
  tileDataOffset,
  tileDataLength,
  addressedTiles,
  tileEntries,
  tileContents,
  minZoom,
  maxZoom,
  bbox,
  centerZoom,
  clustered = true,
  internalCompression = PMTILES_COMPRESSION.NONE,
  tileCompression = PMTILES_COMPRESSION.NONE,
  tileType = PMTILES_TILE_TYPE.PNG,
}) {
  const bytes = new Uint8Array(PMTILES_HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < PMTILES_MAGIC.length; i += 1) bytes[i] = PMTILES_MAGIC.charCodeAt(i)
  view.setUint8(7, PMTILES_VERSION)
  writeU64(view, 8, rootOffset)
  writeU64(view, 16, rootLength)
  writeU64(view, 24, metadataOffset)
  writeU64(view, 32, metadataLength)
  writeU64(view, 40, 0) // leaf directories: none — the root directory holds every entry
  writeU64(view, 48, 0)
  writeU64(view, 56, tileDataOffset)
  writeU64(view, 64, tileDataLength)
  writeU64(view, 72, addressedTiles)
  writeU64(view, 80, tileEntries)
  writeU64(view, 88, tileContents)
  view.setUint8(96, clustered ? 0x01 : 0x00)
  view.setUint8(97, internalCompression)
  view.setUint8(98, tileCompression)
  view.setUint8(99, tileType)
  view.setUint8(100, minZoom)
  view.setUint8(101, maxZoom)
  writePosition(view, 102, bbox.west, bbox.south)
  writePosition(view, 110, bbox.east, bbox.north)
  view.setUint8(118, centerZoom)
  writePosition(view, 119, (bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2)
  return bytes
}

/** Read a PMTiles v3 header back, or `null` when the bytes are not one. */
export function readPmtilesHeader(bytes) {
  if (!bytes || bytes.length < PMTILES_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let magic = ''
  for (let i = 0; i < PMTILES_MAGIC.length; i += 1) magic += String.fromCharCode(bytes[i])
  if (magic !== PMTILES_MAGIC || view.getUint8(7) !== PMTILES_VERSION) return null
  return {
    version: view.getUint8(7),
    rootOffset: readU64(view, 8),
    rootLength: readU64(view, 16),
    metadataOffset: readU64(view, 24),
    metadataLength: readU64(view, 32),
    tileDataOffset: readU64(view, 56),
    tileDataLength: readU64(view, 64),
    addressedTiles: readU64(view, 72),
    tileEntries: readU64(view, 80),
    tileContents: readU64(view, 88),
    clustered: view.getUint8(96) === 1,
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    tileType: view.getUint8(99),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    bounds: (() => {
      const min = readPosition(view, 102)
      const max = readPosition(view, 110)
      return { west: min.lon, south: min.lat, east: max.lon, north: max.lat }
    })(),
    centerZoom: view.getUint8(118),
    center: readPosition(view, 119),
  }
}

/**
 * Assemble a PMTiles v3 archive from fetched tiles.
 *
 * `tiles` is `[{ z, x, y, bytes }]`; `digest` is a function `(Uint8Array) => hex
 * string` or `null`, injected because a browser may not import `node:crypto`.
 * The archive is clustered — tiles are written in ascending TileID order, so the
 * directory's offsets are contiguous and the reader can stream it — and every
 * tile is its own entry with RunLength 1.
 *
 * Returns `{ ok: true, bytes, digest, entries }`, or `{ ok: false, reason }`
 * when the root directory would not fit the spec's 16 KiB ceiling. That refusal
 * is not decoration: a root directory past the limit is an archive a
 * latency-optimised reader cannot open, and the spec says so in MUST.
 */
export function buildPmtilesArchive({ tiles, metadata = {}, bbox, minZoom, maxZoom, digest = null } = {}) {
  if (!Array.isArray(tiles) || tiles.length === 0) return { ok: false, reason: 'no_tiles' }
  if (!bbox || ![bbox.west, bbox.east, bbox.south, bbox.north].every(Number.isFinite)) return { ok: false, reason: 'invalid_bbox' }

  const ordered = [...tiles]
    .map((tile) => ({ ...tile, tileId: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.tileId - b.tileId)

  const entries = []
  let offset = 0
  for (const tile of ordered) {
    const length = tile.bytes.length
    if (!(length > 0)) return { ok: false, reason: 'empty_tile', tile: { z: tile.z, x: tile.x, y: tile.y } }
    entries.push({ tileId: tile.tileId, offset, length, runLength: 1 })
    offset += length
  }

  const root = encodePmtilesDirectory(entries)
  if (PMTILES_HEADER_BYTES + root.length > PMTILES_ROOT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'root_directory_too_large',
      rootLength: root.length,
      limit: PMTILES_ROOT_MAX_BYTES - PMTILES_HEADER_BYTES,
      detail: `the root directory is ${root.length} bytes; the spec caps header plus root directory at ${PMTILES_ROOT_MAX_BYTES}`,
    }
  }

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata))
  const rootOffset = PMTILES_HEADER_BYTES
  const metadataOffset = rootOffset + root.length
  const tileDataOffset = metadataOffset + metadataBytes.length
  const tileDataLength = offset

  const header = buildPmtilesHeader({
    rootOffset,
    rootLength: root.length,
    metadataOffset,
    metadataLength: metadataBytes.length,
    tileDataOffset,
    tileDataLength,
    addressedTiles: entries.length,
    tileEntries: entries.length,
    tileContents: entries.length,
    minZoom,
    maxZoom,
    bbox,
    centerZoom: Math.round((minZoom + maxZoom) / 2),
  })

  const bytes = new Uint8Array(tileDataOffset + tileDataLength)
  bytes.set(header, 0)
  bytes.set(root, rootOffset)
  bytes.set(metadataBytes, metadataOffset)
  let cursor = tileDataOffset
  for (const tile of ordered) {
    bytes.set(tile.bytes, cursor)
    cursor += tile.bytes.length
  }

  return { ok: true, bytes, digest: typeof digest === 'function' ? digest(bytes) : null, entries, metadata: metadataBytes.length }
}

/**
 * Read an archive's own tile directory: `{ header, entries }`, or `null` when
 * the bytes are not a PMTiles v3 archive.
 *
 * A client that has the whole file can therefore recover the tile id list the
 * manifest claims — the manifest is checked against the artefact, not trusted
 * beside it.
 */
export function readPmtilesArchive(bytes) {
  const header = readPmtilesHeader(bytes)
  if (!header) return null
  const end = header.rootOffset + header.rootLength
  if (end > bytes.length) return null
  return { header, entries: decodePmtilesDirectory(bytes.subarray(header.rootOffset, end)) }
}

/** The sorted tile ids an archive addresses, from its own directory. */
export function archiveTileIds(bytes) {
  const archive = readPmtilesArchive(bytes)
  if (!archive) return null
  const ids = []
  for (const entry of archive.entries) {
    for (let r = 0; r < Math.max(1, entry.runLength); r += 1) ids.push(entry.tileId + r)
  }
  return ids.sort((a, b) => a - b)
}

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * The manifest that travels with a pack.
 *
 * It carries the sorted tile id list rather than a count, because a count can
 * only tell a client that *something* is missing. The list lets
 * `verifyPackManifest` name the tile, which is what a resumable download needs.
 */
export function buildPackManifest({
  bbox,
  minZoom,
  maxZoom,
  tiles,
  bytes,
  digest,
  source = null,
  attribution = null,
  createdAt = null,
  extra = null,
} = {}) {
  const tileIds = tiles.map((t) => zxyToTileId(t.z, t.x, t.y)).sort((a, b) => a - b)
  return {
    manifest_version: PACK_MANIFEST_VERSION,
    format: 'pmtiles',
    pmtiles_version: PMTILES_VERSION,
    bbox: { west: bbox.west, east: bbox.east, south: bbox.south, north: bbox.north },
    min_zoom: minZoom,
    max_zoom: maxZoom,
    tile_count: tileIds.length,
    tile_ids: tileIds,
    bytes,
    digest,
    source,
    attribution,
    created_at: createdAt,
    ...(extra || {}),
  }
}

function normalisePresent(present) {
  if (!present) return []
  const out = []
  for (const item of present) {
    if (typeof item === 'number') out.push(item)
    else if (item && Number.isInteger(item.z) && Number.isInteger(item.x) && Number.isInteger(item.y)) {
      out.push(zxyToTileId(item.z, item.x, item.y))
    }
  }
  return out
}

/**
 * Verify a pack against its manifest: `{ ok: true }`, or `{ ok: false, reason }`.
 *
 * Checks in the order a client can act on them: the manifest is well-formed, the
 * digest matches the bytes on disk (a truncated or corrupted download), the byte
 * size matches, and every tile the manifest names is present. `present` may be a
 * list of tile ids or of `{z,x,y}` objects; a superset is accepted, because a
 * client holding more than the manifest promises is not missing anything.
 *
 * **The digest is a string comparison, not a signature.** It detects a partial
 * or corrupted download; it does not authenticate the pack. Saying so here keeps
 * a later reader from mistaking it for provenance.
 */
export function verifyPackManifest(manifest, { present, digest, bytes } = {}) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'no_manifest' }
  if (!Array.isArray(manifest.tile_ids) || manifest.tile_ids.length !== manifest.tile_count) {
    return {
      ok: false,
      reason: 'malformed_manifest',
      detail: `tile_count is ${manifest.tile_count} but tile_ids holds ${Array.isArray(manifest.tile_ids) ? manifest.tile_ids.length : 'no'} ids; a manifest must list the tiles it promises`,
    }
  }
  if (typeof digest === 'string' && digest !== manifest.digest) {
    return { ok: false, reason: 'digest_mismatch', expected: manifest.digest, actual: digest }
  }
  if (Number.isFinite(bytes) && bytes !== manifest.bytes) {
    return { ok: false, reason: 'size_mismatch', expected: manifest.bytes, actual: bytes }
  }
  const have = new Set(normalisePresent(present))
  const missing = manifest.tile_ids.filter((id) => !have.has(id))
  if (missing.length) {
    return {
      ok: false,
      reason: 'missing_tiles',
      missing,
      missing_count: missing.length,
      tile_count: manifest.tile_count,
      detail: `${missing.length} of ${manifest.tile_count} tiles are absent; the map would render holes with no error`,
    }
  }
  return { ok: true, tile_count: manifest.tile_count, digest: manifest.digest ?? null, bytes: manifest.bytes ?? null }
}

/** A filename that names the bbox and zoom range, so two packs on disk are distinguishable. */
export function packFilename(bbox, minZoom, maxZoom) {
  const fix = (v) => v.toFixed(4).replace('-', 'm')
  return `tile-pack_z${minZoom}-${maxZoom}_${fix(bbox.west)}_${fix(bbox.south)}_${fix(bbox.east)}_${fix(bbox.north)}.pmtiles`
}

/** Asserted at import so a broken export cannot look like a working one. */
if (typeof planTilePack !== 'function' || typeof buildPmtilesArchive !== 'function' || typeof verifyPackManifest !== 'function') {
  throw new Error('public/shared/tile-pack.js did not export the planner, builder and verifier')
}
