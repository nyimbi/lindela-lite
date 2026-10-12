import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { clearRasterTileCache, loadPackTile, packTileTemplate, packTileUrl, upstreamTileUrl } from '../src/basemap-tiles.js'
import { matchTileRoute } from '../src/routes/basemap-tiles.js'
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

	// The matcher, called directly. The three tests above prove the route answers
	// through the server; this one proves the *shape* the rest of the surface
	// depends on — that the two spellings of the source are two paths, and that a
	// non-GET is refused here rather than reaching a fetch. It is also what keeps
	// the module reachable from the suite (check-module-coverage), which is the
	// cheap half of the argument: a route module nobody imports is a route whose
	// behaviour is asserted only through a server that might not dispatch it.
	it('parses both sources into their own path, and refuses every other verb', () => {
		assert.deepEqual(matchTileRoute('/api/v1/basemap/tiles/osm/6/38/31.png'),
			{ kind: 'basemap-tile', source: 'osm', z: 6, x: 38, y: 31 })
		assert.deepEqual(matchTileRoute('/api/v1/basemap/tiles/carto/6/38/31.png'),
			{ kind: 'basemap-tile', source: 'carto', z: 6, x: 38, y: 31 })
		// Coordinates are numbers, not the strings the regex captured: a handler
		// that range-checked `'6' > 2 ** '38'` would coerce and pass anything.
		assert.equal(typeof matchTileRoute('/api/v1/basemap/tiles/osm/6/38/31.png').z, 'number')
		// The closed source set. `stamen` is not a malformed tile, it is not a route.
		assert.equal(matchTileRoute('/api/v1/basemap/tiles/stamen/6/38/31.png'), null)
		assert.equal(matchTileRoute('/api/v1/basemap/tiles/osm/6/38/31.jpg'), null, 'the extension is part of the route')
		assert.equal(matchTileRoute('/api/v1/basemap/tiles/osm/6/38/31.png', 'POST'), null)
		assert.equal(matchTileRoute('/api/v1/basemap/tiles/osm/6/38/31.png', 'head'), null, 'HEAD arrives as GET; the pipeline rewrites it')
	})

	it('answers without reading the store, on a store too small to read', async () => {
		// The route reads no collection, and it sat below `store.read` for its
		// whole life — so every pan of the map materialised the store to answer a
		// request that reads none of it. The budget here is 10 rows against 100, so
		// a materialising read refuses *by name* rather than quietly succeeding on
		// a fixture small enough to hide the cost. Same instrument
		// `test/streaming-export.test.js` uses for the export family, for the same
		// reason: the route's own guarantee is the only thing that can be asserted
		// about a cost, and a store that refuses to be read is how you assert it.
		//
		// A 400 rather than a 200 on purpose: the coordinate is out of range, so
		// the answer is this route's own refusal and provably not a store read
		// that happened to be cheap. Reaching the range check at all is the proof.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-tile-budget-'))
		const store = new JsonStore(path.join(dir, 'store.json'), { readRowBudget: 10 })
		await store.merge({ hazard_events: Array.from({ length: 100 }, (_, i) => ({ id: `h${i}` })) })
		const listener = createServer({ store }).listen(0)
		const base = `http://127.0.0.1:${listener.address().port}`
		try {
			const res = await fetch(`${base}/api/v1/basemap/tiles/osm/99/999999/999999.png`)
			assert.equal(res.status, 400, 'the tile route must not read the store it does not use')
		} finally {
			await new Promise((resolve) => listener.close(resolve))
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

// ENH-42. The pack source is operator configuration and shares the proxy's
// fetch path, so the two properties worth asserting are its validation and the
// fact that it *is* the same path — a second copy of the fetch would drop the
// PNG-signature check, and a pack assembled from unverified bodies is a pack
// whose holes are invisible until a phone is offline in a ward.
describe('offline pack tile source', () => {
	it('is null when unset, and the reason the public upstreams are not a fallback', () => {
		// Not a default. OSM's Tile Usage Policy §4 prohibits building tile
		// archives and CARTO's terms §9.c prohibit bulk extraction; both are
		// archived under `docs/research/tile-packs/sources/`.
		assert.equal(packTileTemplate({}), null)
		assert.equal(packTileTemplate({ LINDELA_LITE_PACK_TILE_URL: '   ' }), null)
	})

	it('refuses a template that is not a tile template, naming the variables', () => {
		assert.throws(
			() => packTileTemplate({ LINDELA_LITE_PACK_TILE_URL: 'https://tiles.example.test/all.png' }),
			/\{z\}, \{x\} and \{y\}/,
		)
		// A template missing one placeholder is the same defect with two thirds
		// of the evidence, so each is checked rather than the first.
		for (const missing of ['{z}', '{x}', '{y}']) {
			const template = ['{z}', '{x}', '{y}'].filter((p) => p !== missing).join('/')
			assert.throws(
				() => packTileTemplate({ LINDELA_LITE_PACK_TILE_URL: `https://t.example.test/${template}.png` }),
				/tile URL template/,
				`a template without ${missing} was accepted`,
			)
		}
	})

	it('substitutes the coordinates and range-checks each against 2^z', () => {
		const template = 'https://tiles.example.test/{z}/{x}/{y}.png'
		assert.equal(packTileUrl(template, 10, 612, 502), 'https://tiles.example.test/10/612/502.png')
		// The same bounds `upstreamTileUrl` enforces, because the template is a
		// prefix and the coordinates are the caller's.
		assert.equal(packTileUrl(template, 10, 1024, 0), null, 'x must be within 2^z')
		assert.equal(packTileUrl(template, 10, 0, 1024), null, 'y must be within 2^z')
		assert.equal(packTileUrl(template, 16, 0, 0), null, 'zoom is policy-capped')
		assert.equal(packTileUrl(template, 1.5, 0, 0), null)
		assert.equal(packTileUrl(null, 10, 612, 502), null)
	})

	it('fetches from the template and verifies the PNG signature, like the proxy', async () => {
		// A local server, not a public one: the property under test is the shared
		// fetch path, and reaching a real tile service to test it would be a
		// flakiness generator pointed at somebody's infrastructure.
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
		const server = http.createServer((req, res) => {
			if (req.url === '/10/612/502.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return }
			if (req.url === '/10/613/502.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('not a png at all'); return }
			res.writeHead(404); res.end()
		})
		const listener = server.listen(0)
		await new Promise((resolve) => listener.once('listening', resolve))
		const template = `http://127.0.0.1:${listener.address().port}/{z}/{x}/{y}.png`
		try {
			clearRasterTileCache()
			const tile = await loadPackTile(template, 10, 612, 502)
			assert.ok(tile?.bytes, 'a real PNG came back as nothing')
			assert.equal(tile.bytes.length, png.length)

			// 200 with a non-PNG body is the case the signature check exists for:
			// it would reach the browser as a broken image and nothing would say why.
			assert.equal(await loadPackTile(template, 10, 613, 502), null, 'a non-PNG body was accepted')
			// And a 404 is null, not a thrown error: a hole is a fact to record.
			assert.equal(await loadPackTile(template, 10, 614, 502), null)
		} finally {
			clearRasterTileCache()
			listener.close()
		}
	})
})