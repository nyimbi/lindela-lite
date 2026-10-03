/**
 * DATA-09: depthGrid had no no-data floor and no vertical datum.
 *
 * The terrain here is synthetic Terrarium PNGs built in-process and served
 * through a stubbed fetch, because the defect is only reachable with a coastal
 * shelf under the tiles — a real point is never negative.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

import { clearTileCache } from '../src/terrain.js'
import * as floodDepth from '../src/flood-depth.js'

const { depthAtPoint, depthGrid, depthProfile, terrainContext } = floodDepth

// Pinned as a literal rather than read from the source constant: a renamed
// constant would otherwise move the target and the test would keep passing.
const DATUM = 'terrarium_mean_sea_level'

// Below the terrain data floor (NO_DATA_FLOOR_M = -400 in src/flood-depth.js):
// the sentinel the point function has always refused.
const VOID_M = -450
// Below mean sea level but above the floor — ordinary data by the agreed rule.
const BELOW_SEA_M = -30
const SEA_LEVEL_M = 0
const DRY_M = 5

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real 8-bit truecolour PNG encoding a constant elevation, as Terrarium does. */
function terrariumPng(elevationM, size = 256) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let p = 0
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0
    p += 1
    const packed = Math.round((elevationM + 32768) * 256)
    const rgb = [Math.floor(packed / 65536) & 0xff, Math.floor(packed / 256) & 0xff, packed & 0xff]
    for (let x = 0; x < size; x += 1) {
      raw[p] = rgb[0]
      raw[p + 1] = rgb[1]
      raw[p + 2] = rgb[2]
      p += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Serves `elevationM` for every tile whose x matches `serveX`, 404s the rest. */
function serveTerrain(elevationM, { serveX = null } = {}) {
  clearTileCache()
  const png = terrariumPng(elevationM)
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const x = Number(String(url).match(/\/terrarium\/\d+\/(\d+)\//)[1])
    if (serveX !== null && x !== serveX) return new Response('no tile', { status: 404 })
    return new Response(png, { status: 200 })
  }
  return () => { globalThis.fetch = original }
}

const BOX = { south: 3.05, west: 35.55, north: 3.15, east: 35.65, zoom: 10, gridSize: 8 }

test('depthGrid reports a below-floor coastal cell as no-data, not as flood depth', async () => {
  const restore = serveTerrain(VOID_M)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 0 })

    // A water surface at mean sea level over a -450 m cell used to come back as
    // 450 m of water, 100% coverage, and a filled extent polygon.
    assert.equal(grid.coverage_pct, 0)
    assert.equal(grid.void_cells, BOX.gridSize * BOX.gridSize)
    assert.equal(grid.elevation_range_m, null)
    assert.ok(grid.depth_grid.every((d) => d === null))
    assert.equal(grid.extent_geojson.features.length, 0)
    assert.equal(grid.per_level[0].flooded_cells, 0)
    assert.equal(grid.per_level[0].area_sq_km, 0)
  } finally {
    restore()
  }
})

test('depthAtPoint already refused that terrain, so the two now agree', async () => {
  const restore = serveTerrain(VOID_M)
  try {
    const point = await depthAtPoint(3.1, 35.6, 0, { zoom: 10, noCache: true })
    assert.equal(point.data_available, false)
    assert.equal(point.depth_m, null)
    assert.match(point.reason, /void/i)

    const grid = await depthGrid({ ...BOX, levelM: 0 })
    assert.equal(grid.coverage_pct, 0)
  } finally {
    restore()
  }
})

test('the floor is inclusive, and land just above it is still measured', async () => {
  const atFloor = serveTerrain(-400)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 0 })
    assert.equal(grid.coverage_pct, 0)
    assert.ok(grid.depth_grid.every((d) => d === null))
  } finally {
    atFloor()
  }

  const above = serveTerrain(-30)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 0 })
    // -30 m of bathymetry is below sea level but is data, and reads as 30 m.
    assert.equal(grid.coverage_pct, 100)
    assert.equal(grid.void_cells, 0)
    assert.ok(grid.depth_grid.every((d) => d === 30))
  } finally {
    above()
  }
})

test('a cell at exactly 0 m is data, and 0 is not confused with no-data', async () => {
  const restore = serveTerrain(SEA_LEVEL_M)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 2 })
    assert.equal(grid.coverage_pct, 100)
    assert.equal(grid.void_cells, 0)
    assert.ok(grid.depth_grid.every((d) => d === 2))

    const point = await depthAtPoint(3.1, 35.6, 0, { zoom: 10, noCache: true })
    assert.equal(point.data_available, true)
    assert.equal(point.elevation_m, 0)
    assert.equal(point.depth_m, 0)
    assert.equal(point.flooded, false)
    assert.equal(point.passability, 'dry')
  } finally {
    restore()
  }
})

test('zero depth serialises as 0, never as -0 or null', async () => {
  const restore = serveTerrain(DRY_M)
  try {
    const point = await depthAtPoint(3.1, 35.6, 5, { zoom: 10, noCache: true })
    assert.equal(point.depth_m, 0)
    assert.ok(Object.is(point.depth_m, 0), 'depth_m must not be -0')
    assert.ok(Object.is(point.elevation_m, 0) === false, 'elevation_m is 5, not zero')

    const grid = await depthGrid({ ...BOX, levelM: 5 })
    assert.ok(grid.depth_grid.every((d) => Object.is(d, 0)), 'every cell is exactly 0 m deep')
  } finally {
    restore()
  }
})

test('a cell with no tile is null, not a fabricated 0 of depth', async () => {
  // Two tiles across at z10; only the first is served, so the rest are NaN.
  const restore = serveTerrain(DRY_M, { serveX: 613 })
  try {
    const grid = await depthGrid({
      south: 3.05, west: 35.55, north: 3.15, east: 36.05, zoom: 10, gridSize: 8, levelM: 0,
    })
    assert.ok(grid.depth_grid.includes(null), 'the unserved half is null')
    assert.ok(!grid.depth_grid.includes(0), 'no cell may report 0 m depth it never measured')
    assert.ok(grid.coverage_pct > 0 && grid.coverage_pct < 100)
  } finally {
    restore()
  }
})

test('every response names the datum it is measured in, and the default is documented', async () => {
  assert.equal(floodDepth.SOURCE_DATUM, DATUM, 'the source datum is a named, exported constant')
  const restore = serveTerrain(DRY_M)
  try {
    const point = await depthAtPoint(3.1, 35.6, 10, { zoom: 10, noCache: true })
    const profile = await depthProfile(3.1, 35.6, { levels_m: [10, 20], zoom: 10, noCache: true })
    const context = await terrainContext(3.1, 35.6, { zoom: 10, noCache: true })
    const grid = await depthGrid({ ...BOX, levelM: 10 })

    for (const vertical of [point.vertical_reference, profile.vertical_reference, context.vertical_reference, grid.vertical_reference]) {
      assert.equal(vertical.datum, DATUM)
      assert.equal(vertical.declared_by, 'source_default')
      assert.equal(vertical.resolved, true)
      assert.equal(vertical.offset_applied_m, null)
      assert.match(vertical.note, /no geoid or ellipsoid model/i)
    }
    assert.equal(profile.datum_resolved, true)
    assert.equal(grid.datum_resolved, true)
    assert.equal(context.datum_resolved, true)
  } finally {
    restore()
  }
})

test('a datum with no derivable shift returns no number and says why', async () => {
  const restore = serveTerrain(DRY_M)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 10, datum: 'site_local_datum' })
    assert.equal(grid.datum_resolved, false)
    assert.match(grid.reason, /site_local_datum.*offset_m/is)
    assert.equal(grid.coverage_pct, null)
    assert.equal(grid.elevation_range_m, null)
    assert.ok(grid.depth_grid.every((d) => d === null))
    assert.equal(grid.extent_geojson.features.length, 0)
    assert.deepEqual(grid.per_level[0], { level_m: 10, flooded_cells: null, coverage_pct: null, area_sq_km: null })

    const point = await depthAtPoint(3.1, 35.6, 10, { zoom: 10, noCache: true, datum: 'site_local_datum' })
    assert.equal(point.datum_resolved, false)
    assert.equal(point.depth_m, null)
    assert.equal(point.elevation_m, null)
    assert.equal(point.flooded, null)
    // The terrain is there. It is the datum that is missing, and the two are
    // not the same fact.
    assert.equal(point.data_available, true)

    const profile = await depthProfile(3.1, 35.6, { levels_m: [10, 20], zoom: 10, noCache: true, datum: 'site_local_datum' })
    assert.equal(profile.datum_resolved, false)
    // Not "not inundated" — unevaluated.
    assert.equal(profile.inundated, null)
    assert.match(profile.reason, /offset_m/)
  } finally {
    restore()
  }
})

test('an explicit offset shifts every height and is recorded as caller-supplied', async () => {
  const restore = serveTerrain(DRY_M)
  try {
    const grid = await depthGrid({ ...BOX, levelM: 0, datum: 'site_local_datum', datumOffsetM: 12 })
    assert.equal(grid.datum_resolved, true)
    assert.equal(grid.vertical_reference.offset_applied_m, 12)
    assert.equal(grid.vertical_reference.offset_source, 'caller_supplied')
    assert.equal(grid.elevation_range_m.min, 17)
    assert.ok(grid.depth_grid.every((d) => d === -17))

    const point = await depthAtPoint(3.1, 35.6, 0, { zoom: 10, noCache: true, datum: 'site_local_datum', datum_offset_m: 12 })
    assert.equal(point.elevation_m, 17)
    assert.equal(point.depth_m, -17)
    assert.equal(point.flooded, false)
  } finally {
    restore()
  }
})

test('an offset of 0 is an offset', async () => {
  const restore = serveTerrain(DRY_M)
  try {
    const point = await depthAtPoint(3.1, 35.6, 10, {
      zoom: 10, noCache: true, datum: 'site_local_datum', datum_offset_m: 0,
    })
    assert.equal(point.datum_resolved, true)
    assert.equal(point.vertical_reference.offset_applied_m, 0)
    assert.equal(point.elevation_m, DRY_M)
    assert.equal(point.depth_m, 5)
  } finally {
    restore()
  }
})