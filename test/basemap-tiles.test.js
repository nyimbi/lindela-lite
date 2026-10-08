import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { clearRasterTileCache, upstreamTileUrl } from '../src/basemap-tiles.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

// The upstream URL mapping is asserted at all because it has been wrong before:
// the 2026-10-07 selector hardwired a single `6/30/20` tile as "Turkana". The
// mapping is a pure function here, so the test needs no network.
describe('basemap tile upstream mapping', () => {
	it('maps a valid tile to its provider URL', () => {
		assert.equal(upstreamTileUrl('osm', 0, 0, 0), 'https://tile.openstreetmap.org/0/0/0.png')
		assert.equal(upstreamTileUrl('osm', 6, 38, 31), 'https://tile.openstreetmap.org/6/38/31.png')
		assert.equal(upstreamTileUrl('carto', 6, 38, 31), 'https://a.basemaps.cartocdn.com/light_all/6/38/31.png')
	})

	it('rejects what should never reach a public tile service', () => {
		// Unknown provider — the regex on the route already limits to osm|carto,
		// but the validator is the gate the tests and future callers lean on.
		assert.equal(upstreamTileUrl('stamen', 6, 38, 31), null, 'the retired Stamen hosts are gone, not merely unpopular')
		assert.equal(upstreamTileUrl(undefined, 6, 38, 31), null)
		// Non-integers, negatives, out-of-range coordinates.
		assert.equal(upstreamTileUrl('osm', 1.5, 0, 0), null)
		assert.equal(upstreamTileUrl('osm', -1, 0, 0), null)
		assert.equal(upstreamTileUrl('osm', 16, 0, 0), null, 'zoom is policy-capped, not capability-capped')
		assert.equal(upstreamTileUrl('osm', 6, -1, 31), null)
		assert.equal(upstreamTileUrl('osm', 6, 64, 31), null, 'x must be within 2^z')
		assert.equal(upstreamTileUrl('osm', 6, 38, 64), null, 'y must be within 2^z')
		// Boundary values that must be accepted, so the cap does not over-tighten.
		assert.notEqual(upstreamTileUrl('osm', 15, 2 ** 15 - 1, 2 ** 15 - 1), null)
	})
})

describe('basemap tile proxy route', () => {
	// No live upstream fetch in tests: a tile route's invalid-input behaviour is
	// the part this process guarantees without network; a live-fetching test
	// here would be a flakiness generator pointed at a shared public service.
	// Each it boots its own throwaway server, exactly like the other route tests.
	async function withServer(fn) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-tiles-'))
		const store = new JsonStore(path.join(dir, 'store.json'))
		const server = createServer({ store })
		const listener = server.listen(0)
		const base = `http://localhost:${listener.address().port}`
		try {
			return await fn(base)
		} finally {
			listener.close()
			clearRasterTileCache()
		}
	}

	it('400s a malformed tile path instead of fetching anything', async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}/api/v1/basemap/tiles/osm/99/999999/999999.png`)
			assert.equal(res.status, 400)
			const body = await res.json()
			assert.equal(body.success, false)
		})
	})

	it('404s an unknown source — retired providers are not silently remapped', async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}/api/v1/basemap/tiles/stamen/6/38/31.png`)
			// The route table only admits osm|carto, so an unknown provider is an
			// unknown route, not a malformed tile: the standard 404, never a fetch.
			assert.equal(res.status, 404)
			const body = await res.json()
			assert.equal(body.success, false)
		})
	})

	it('400s an out-of-range coordinate pair', async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}/api/v1/basemap/tiles/carto/6/64/31.png`)
			assert.equal(res.status, 400)
		})
	})
})