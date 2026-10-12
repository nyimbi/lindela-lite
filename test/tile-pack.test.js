import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { PILOT_DISTRICTS } from '../public/shared/basemap.js'
import { MERCATOR_MAX_LAT, lonToTileX, tilesForRect } from '../public/shared/tiles.js'
import {
	PMTILES_HEADER_BYTES,
	PMTILES_ROOT_MAX_BYTES,
	archiveTileIds,
	buildPackManifest,
	buildPmtilesArchive,
	decodePmtilesDirectory,
	encodePmtilesDirectory,
	packFilename,
	planTilePack,
	readPmtilesArchive,
	readPmtilesHeader,
	tileRangeForRect,
	tileIdToZxy,
	uncoveredCorners,
	verifyPackManifest,
	zxyToTileId,
} from '../public/shared/tile-pack.js'

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Turkana (Lodwar) is the pilot district the 2026-10-07 tile arithmetic got
// wrong; a box around it is the bbox these tests plan against. It is a real
// district, not a round number, because a pack exists for a ward and not for a
// rectangle chosen to make the arithmetic easy.
const turkana = PILOT_DISTRICTS.find((d) => d.slug === 'turkana')
const [lon, lat] = turkana.center
const WARD = { west: lon - 0.25, east: lon + 0.25, south: lat - 0.2, north: lat + 0.2 }

const fakePng = (n) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: n }, (_, i) => (i + n) % 251)])

/** Fetch nothing: a tile list with deterministic bytes standing in for the raster. */
const materialise = (tiles) => tiles.map((t) => ({ z: t.z, x: t.x, y: t.y, bytes: fakePng(64 + (t.x % 7)) }))

describe('tile-pack — Hilbert tile ids (PMTiles spec §4.1)', () => {
	it('matches the spec table: z0=0, the four z1 tiles=1..4, z2/x0/y0=5', () => {
		assert.equal(zxyToTileId(0, 0, 0), 0)
		assert.equal(zxyToTileId(1, 0, 0), 1)
		assert.equal(zxyToTileId(1, 0, 1), 2)
		assert.equal(zxyToTileId(1, 1, 1), 3)
		assert.equal(zxyToTileId(1, 1, 0), 4)
		assert.equal(zxyToTileId(2, 0, 0), 5)
	})

	it('matches the spec table at z12: x3423 y1763 is 19078479', () => {
		assert.equal(zxyToTileId(12, 3423, 1763), 19078479)
	})

	it('round-trips every tile of a small zoom exhaustively', () => {
		for (let z = 0; z <= 5; z += 1) {
			const n = 2 ** z
			for (let x = 0; x < n; x += 1) {
				for (let y = 0; y < n; y += 1) {
					const back = tileIdToZxy(zxyToTileId(z, x, y))
					assert.deepEqual(back, { z, x, y }, `z${z}/${x}/${y} did not round-trip`)
				}
			}
		}
	})

	it('refuses a coordinate that is not a tile', () => {
		assert.throws(() => zxyToTileId(2, 4, 0), /not a tile at zoom 2/)
		assert.throws(() => zxyToTileId(27, 0, 0), /outside 0\.\.26/)
	})
})

describe('tile-pack — enumeration is exact', () => {
	it('names exactly the tiles tilesForRect names, and covers all four corners', () => {
		const plan = planTilePack({ bbox: WARD, minZoom: 12, maxZoom: 13 })
		assert.equal(plan.ok, true)
		const expected = [
			...tilesForRect(WARD, 12, 100000),
			...tilesForRect(WARD, 13, 100000),
		]
		assert.equal(plan.tileCount, expected.length)
		assert.deepEqual(
			plan.tiles.map((t) => `${t.z}/${t.x}/${t.y}`).sort(),
			expected.map((t) => `${t.z}/${t.x}/${t.y}`).sort(),
		)
		for (let z = 12; z <= 13; z += 1) {
			assert.deepEqual(uncoveredCorners(WARD, plan.tiles.filter((t) => t.z === z), z), [], `zoom ${z} left a corner uncovered`)
		}
	})

	it('tileRangeForRect agrees with tilesForRect across rects and zooms', () => {
		const rects = [
			WARD,
			{ west: -1, east: 1, south: -1, north: 1 },
			{ west: 27, east: 52, south: -6, north: 15 },
		]
		for (const rect of rects) {
			for (let z = 2; z <= 8; z += 1) {
				const range = tileRangeForRect(rect, z)
				const tiles = tilesForRect(rect, z, 1e9)
				assert.equal(range.count, tiles.length, `${JSON.stringify(rect)} z${z}: range ${range.count} vs enumerated ${tiles.length}`)
			}
		}
	})

	it('the four bbox corners are inside the enumerated set at every zoom', () => {
		const plan = planTilePack({ bbox: WARD, minZoom: 2, maxZoom: 8 })
		assert.equal(plan.ok, true)
		for (let z = 2; z <= 8; z += 1) {
			assert.deepEqual(uncoveredCorners(WARD, plan.tiles.filter((t) => t.z === z), z), [])
		}
	})

	it('names a corner whose containing tile has been dropped', () => {
		const tiles = tilesForRect(WARD, 12, 100000)
		const minX = Math.min(...tiles.map((t) => t.x))
		const minY = Math.min(...tiles.map((t) => t.y))
		const holed = tiles.filter((t) => !(t.x === minX && t.y === minY))
		const missing = uncoveredCorners(WARD, holed, 12)
		assert.ok(missing.includes('northwest'), `expected the northwest corner to be named, got ${JSON.stringify(missing)}`)
	})

	it('does not flag a complete pack whose eastern edge falls on a tile boundary', () => {
		// `east = 0` is a tile boundary at z8 (lonToTileX(0, 8) = 128 exactly). The
		// enumerator places the eastern edge in tile `ceil(·) - 1` = 127; a bare
		// `floor` names tile 128, which the set does not contain, and a correct pack
		// is reported as holed on its eastern corners.
		const edgeOnBoundary = { west: -2, east: 0, south: -1, north: 1 }
		assert.equal(lonToTileX(0, 8), 128, 'precondition: east=0 is an exact tile boundary at z8')
		for (let z = 4; z <= 8; z += 1) {
			const tiles = tilesForRect(edgeOnBoundary, z, 100000)
			assert.deepEqual(uncoveredCorners(edgeOnBoundary, tiles, z), [], `z${z} falsely flagged a complete pack`)
		}
	})
})

describe('tile-pack — over-budget is refused with the numbers', () => {
	it('refuses a tile-budget overrun and names the count and the budget', () => {
		const plan = planTilePack({ bbox: WARD, minZoom: 12, maxZoom: 14, budget: { maxTiles: 10 } })
		assert.equal(plan.ok, false)
		assert.equal(plan.reason, 'tile_budget')
		assert.ok(plan.tileCount > 10, `expected a count over the budget, got ${plan.tileCount}`)
		assert.equal(plan.maxTiles, 10)
		assert.match(plan.detail, /tiles across z12\.\.z14/)
		assert.equal(plan.tiles, undefined, 'a refused plan must not carry a truncated tile list')
	})

	it('refuses a byte-budget overrun and names the size', () => {
		const plan = planTilePack({ bbox: WARD, minZoom: 12, maxZoom: 13, budget: { maxTiles: 1e6, maxBytes: 1024, tileBytes: 4096 } })
		assert.equal(plan.ok, false)
		assert.equal(plan.reason, 'byte_budget')
		assert.ok(plan.estimatedBytes > 1024)
		assert.equal(plan.maxBytes, 1024)
	})

	it('a refusal is a value, not a throw, so the operator surface can render it', () => {
		assert.doesNotThrow(() => planTilePack({ bbox: WARD, budget: { maxTiles: 1 } }))
	})
})

describe('tile-pack — degenerate bboxes do not produce an empty or absurd pack', () => {
	it('a zero-area bbox is refused, not enumerated as empty', () => {
		const plan = planTilePack({ bbox: { west: 35, east: 35, south: 3, north: 3 } })
		assert.equal(plan.ok, false)
		assert.equal(plan.reason, 'invalid_bbox')
	})

	it('an antimeridian bbox written west>east is refused rather than silently empty', () => {
		const plan = planTilePack({ bbox: { west: 170, east: -170, south: -10, north: 10 } })
		assert.equal(plan.ok, false)
		assert.equal(plan.reason, 'invalid_bbox')
	})

	it('a bbox past MERCATOR_MAX_LAT is refused rather than clamped to a smaller pack', () => {
		const plan = planTilePack({ bbox: { west: 0, east: 10, south: 0, north: MERCATOR_MAX_LAT + 3 } })
		assert.equal(plan.ok, false)
		assert.equal(plan.reason, 'outside_mercator')
		assert.equal(plan.mercatorMaxLat, MERCATOR_MAX_LAT)
	})

	it('a non-finite bbox is refused', () => {
		assert.equal(planTilePack({ bbox: { west: NaN, east: 1, south: 0, north: 1 } }).reason, 'invalid_bbox')
	})

	it('a zoom range outside what the proxy serves is refused', () => {
		assert.equal(planTilePack({ bbox: WARD, minZoom: 1, maxZoom: 3 }).reason, 'invalid_zoom')
		assert.equal(planTilePack({ bbox: WARD, minZoom: 15, maxZoom: 20 }).reason, 'invalid_zoom')
	})
})

describe('tile-pack — PMTiles archive round-trip', () => {
	const plan = planTilePack({ bbox: WARD, minZoom: 11, maxZoom: 12 })

	it('writes a header the reader reads back', () => {
		const built = buildPmtilesArchive({
			tiles: materialise(plan.tiles),
			bbox: plan.bbox,
			minZoom: plan.minZoom,
			maxZoom: plan.maxZoom,
			metadata: { name: 'Turkana ward pack', attribution: '© OpenStreetMap contributors', type: 'baselayer' },
		})
		assert.equal(built.ok, true)
		const header = readPmtilesHeader(built.bytes)
		assert.ok(header, 'the header did not read back')
		assert.equal(header.version, 3)
		assert.equal(header.addressedTiles, plan.tileCount)
		assert.equal(header.minZoom, 11)
		assert.equal(header.maxZoom, 12)
		assert.equal(header.tileDataOffset + header.tileDataLength, built.bytes.length)
		assert.ok(PMTILES_HEADER_BYTES + header.rootLength <= PMTILES_ROOT_MAX_BYTES)
		assert.ok(Math.abs(header.bounds.west - WARD.west) < 1e-6)
	})

	it('the directory round-trips and its tile ids are exactly the planned tiles', () => {
		const built = buildPmtilesArchive({ tiles: materialise(plan.tiles), bbox: plan.bbox, minZoom: plan.minZoom, maxZoom: plan.maxZoom })
		assert.equal(built.ok, true)
		assert.deepEqual(archiveTileIds(built.bytes), [...plan.tileIds].sort((a, b) => a - b))
		const entries = readPmtilesArchive(built.bytes).entries
		assert.deepEqual(decodePmtilesDirectory(encodePmtilesDirectory(entries)), entries)
	})

	it('stores tiles clustered, so entry N+1 continues from entry N', () => {
		const built = buildPmtilesArchive({ tiles: materialise(plan.tiles), bbox: plan.bbox, minZoom: plan.minZoom, maxZoom: plan.maxZoom })
		const ids = archiveTileIds(built.bytes)
		assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'tiles must be written in ascending TileID order')
	})

	it('refuses an archive whose root directory would not fit the 16 KiB ceiling', () => {
		const many = []
		for (let i = 0; i < 9000; i += 1) many.push({ z: 14, x: i % 16384, y: Math.floor(i / 16384), bytes: fakePng(4) })
		const built = buildPmtilesArchive({ tiles: many, bbox: WARD, minZoom: 14, maxZoom: 14 })
		assert.equal(built.ok, false)
		assert.equal(built.reason, 'root_directory_too_large')
		assert.ok(built.rootLength > built.limit)
	})
})

describe('tile-pack — the manifest detects a missing tile', () => {
	const plan = planTilePack({ bbox: WARD, minZoom: 11, maxZoom: 12 })
	const built = buildPmtilesArchive({
		tiles: materialise(plan.tiles),
		bbox: plan.bbox,
		minZoom: plan.minZoom,
		maxZoom: plan.maxZoom,
		digest: sha256Hex,
		metadata: { name: 'Turkana ward pack' },
	})
	const manifest = buildPackManifest({
		bbox: plan.bbox,
		minZoom: plan.minZoom,
		maxZoom: plan.maxZoom,
		tiles: plan.tiles,
		bytes: built.bytes.length,
		digest: built.digest,
		source: 'osm',
		attribution: '© OpenStreetMap contributors',
	})

	it('accepts a complete pack', () => {
		const result = verifyPackManifest(manifest, { present: plan.tileIds, digest: sha256Hex(built.bytes), bytes: built.bytes.length })
		assert.equal(result.ok, true)
		assert.equal(result.tile_count, plan.tileCount)
	})

	it('names the missing tile when one is removed', () => {
		const present = plan.tileIds.filter((_, i) => i !== 3)
		const result = verifyPackManifest(manifest, { present, digest: sha256Hex(built.bytes), bytes: built.bytes.length })
		assert.equal(result.ok, false)
		assert.equal(result.reason, 'missing_tiles')
		assert.deepEqual(result.missing, [plan.tileIds[3]])
		assert.equal(result.missing_count, 1)
	})

	it('accepts {z,x,y} objects as well as ids', () => {
		const objects = plan.tiles.map((t) => ({ z: t.z, x: t.x, y: t.y }))
		assert.equal(verifyPackManifest(manifest, { present: objects }).ok, true)
	})

	it('detects a corrupted download by digest', () => {
		const result = verifyPackManifest(manifest, { present: plan.tileIds, digest: 'deadbeef', bytes: built.bytes.length })
		assert.equal(result.ok, false)
		assert.equal(result.reason, 'digest_mismatch')
	})

	it('detects a size mismatch', () => {
		const result = verifyPackManifest(manifest, { present: plan.tileIds, digest: sha256Hex(built.bytes), bytes: built.bytes.length - 1 })
		assert.equal(result.ok, false)
		assert.equal(result.reason, 'size_mismatch')
	})

	it('refuses a manifest that does not list its tiles', () => {
		const bad = { ...manifest, tile_ids: undefined }
		const result = verifyPackManifest(bad, { present: plan.tileIds })
		assert.equal(result.ok, false)
		assert.equal(result.reason, 'malformed_manifest')
	})

	it('accepts a superset: a client holding more than promised is not missing anything', () => {
		const result = verifyPackManifest(manifest, { present: [...plan.tileIds, zxyToTileId(0, 0, 0)] })
		assert.equal(result.ok, true)
	})
})

describe('tile-pack — filename', () => {
	it('names the bbox and zoom range so two packs on disk are distinguishable', () => {
		const name = packFilename(WARD, 11, 12)
		assert.match(name, /^tile-pack_z11-12_/)
		assert.match(name, /\.pmtiles$/)
		assert.match(packFilename({ west: -1.5, east: 1, south: -1, north: 1 }, 2, 3), /m1\.5000/)
	})
})
