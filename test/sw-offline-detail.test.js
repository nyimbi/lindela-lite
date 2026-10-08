#!/usr/bin/env node
/**
 * Offline drill-down, and the three answers a cached read has to give (ENH-22).
 *
 * The worker already precached the whole module graph and bounded one API
 * cache. What it did not do was cache anything a drill-down could use, so
 * opening a district with no signal returned `{"error":"Offline"}` with a 503 —
 * a shape indistinguishable from a server error, rendered by every surface as an
 * empty panel. An empty panel in a flood product is a claim about the district,
 * and it was being made by a network failure.
 *
 * These are the decisions, asserted as decisions:
 *   - which bucket a request lands in, and why detail is not evicted by a poll;
 *   - what a cache hit says about its own age;
 *   - what a miss says, and that it is never a 200.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  CACHE_POLICIES,
  classifyApiRequest,
  evictionPlan,
  offlineMissBody,
  sanitizeHeaders,
  shellGraph,
  staleHeaders,
} from '../public/sw.js'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const readPublic = (p) => readFile(path.join(PUBLIC, p), 'utf8')
const textResponse = (body) => ({ ok: true, clone: () => ({ text: async () => body }) })
const loadFromDisk = async (url) => {
	try {
		return textResponse(await readPublic(url.pathname))
	} catch {
		return null
	}
}

describe('offline drill-down: routing', () => {
	it('raster basemap tiles are immutable imagery in their own bucket (ADR-013)', () => {
		// A panning session issues ~two dozen tiles per repaint — if they shared
		// the api bucket they would evict the poll payloads it exists to serve,
		// and if they shared the map bucket they would evict the vector layers.
		// Their own bucket has the largest cap and the longest TTL of the read
		// buckets, because a tile never changes meaning once downloaded.
		assert.equal(classifyApiRequest('/api/v1/basemap/tiles/osm/6/38/31.png'), 'tiles')
		assert.equal(classifyApiRequest('/api/v1/basemap/tiles/carto/10/300/120.png'), 'tiles')
		assert.ok(CACHE_POLICIES.tiles.maxEntries >= CACHE_POLICIES.api.maxEntries)
		assert.ok(CACHE_POLICIES.tiles.ttlMs >= CACHE_POLICIES.map.ttlMs)
	})
	it('a named record goes to the detail bucket, the list behind it does not', () => {
		// The same collection is both a map layer and a drill-down target. One
		// segment is the layer the map draws; two is the district the user
		// opened. Getting it wrong either way is silent: a list in the detail
		// bucket evicts records, a record in the layer bucket is evicted by
		// the poll that fills it.
		assert.equal(classifyApiRequest('/api/v1/districts'), 'map')
		assert.equal(classifyApiRequest('/api/v1/districts/turkana'), 'detail')
		assert.equal(classifyApiRequest('/api/v1/alert-events/evt_123'), 'detail')
		assert.equal(classifyApiRequest('/api/v1/incidents/inc_9?detail=full'), 'detail')
	})

	it('map layers and everything else are separated', () => {
		for (const path of ['/api/v1/flood-risk', '/api/v1/flood-depth', '/api/v1/conflict-risk', '/api/v1/road-access', '/api/v1/climate']) {
			assert.equal(classifyApiRequest(path), 'map', path)
		}
		for (const path of ['/api/v1/kpi/monthly-series', '/api/v1/ingest/status', '/api/v1/sources', '/api/v1/alerts/evaluate']) {
			assert.equal(classifyApiRequest(path), 'api', path)
		}
	})

	it('nothing that is not a cached GET is ever classified', () => {
		// A cached 200 for a POST would make a submission that never reached the
		// server look filed, which is the one thing the offline queue exists to
		// make impossible.
		assert.equal(classifyApiRequest('/api/v1/chw/report', 'POST'), null)
		assert.equal(classifyApiRequest('/api/v1/reports/r1/approve', 'POST'), null)
		assert.equal(classifyApiRequest('/api/v1/ingest/run', 'POST'), null)
		assert.equal(classifyApiRequest('/shared/app.js'), null)
		assert.equal(classifyApiRequest('/api/v2/districts/turkana'), null)
		assert.equal(classifyApiRequest('/api/v1/'), null)
	})

	it('a detail record is not evicted by the console poll', () => {
		// The whole reason for a second bucket. Under one 200-entry bucket
		// driven by a thirty-second poll, every drill-down a user opens is
		// among the first evicted.
		assert.ok(CACHE_POLICIES.detail.maxEntries < CACHE_POLICIES.api.maxEntries)
		assert.ok(CACHE_POLICIES.detail.ttlMs > CACHE_POLICIES.api.ttlMs)
		assert.ok(CACHE_POLICIES.map.maxEntries < CACHE_POLICIES.api.maxEntries)
		// Four distinct caches, not one cache with four comments — the tiles
		// bucket exists so a panning session cannot evict this (ADR-013).
		assert.ok(CACHE_POLICIES.tiles.maxEntries > CACHE_POLICIES.api.maxEntries)
		assert.equal(new Set(Object.values(CACHE_POLICIES).map((p) => p.name)).size, 4)
	})
})

describe('offline drill-down: what the user is told', () => {
	it('a miss says it was never fetched, and never returns an empty 200', () => {
		const body = offlineMissBody({ kind: 'detail', pathname: '/api/v1/districts/turkana' })
		assert.equal(body.error, 'unavailable-offline')
		assert.equal(body.cached, false, 'the field that separates "no data" from "never fetched"')
		assert.equal(body.offline, true)
		assert.equal(body.kind, 'detail')
		assert.equal(body.resource, '/api/v1/districts/turkana')
		// The message has to survive being rendered as the whole panel, so it
		// states the situation rather than describing an absence.
		assert.match(body.message, /not available offline/i)
		assert.doesNotMatch(body.message, /no data/i, 'an empty panel that reads as "no data" is the defect being fixed')
	})

	it('a hit says how stale it is, from when it was stored rather than from Date', () => {
		const storedAtMs = Date.parse('2026-10-01T09:00:00.000Z')
		const headers = staleHeaders({
			headers: { 'content-type': 'application/json', date: 'Wed, 01 Oct 2026 09:00:00 GMT' },
			storedAtMs,
			now: Date.parse('2026-10-04T09:00:00.000Z'),
		})
		assert.equal(headers['x-lindela-offline'], '1')
		assert.equal(headers['x-lindela-cache'], 'hit')
		assert.equal(headers['x-lindela-stored-at'], '2026-10-01T09:00:00.000Z')
		assert.equal(headers['x-lindela-stale-seconds'], String(3 * 24 * 3600))
		assert.equal(headers['content-type'], 'application/json')
	})

	it('an unstamped entry reports an unknown age instead of a wrong one', () => {
		// Entries written before this header existed have no timestamp. The
		// alternatives are both lies: reporting 0 says "just now" about a
		// month-old district.
		const headers = staleHeaders({ headers: {}, storedAtMs: 0, now: Date.now() })
		assert.equal(headers['x-lindela-stale-seconds'], undefined)
		assert.equal(headers['x-lindela-stored-at'], undefined)
		assert.equal(headers['x-lindela-cache'], 'hit')
	})

	it('headers that lie about the body are dropped, not copied', () => {
		// A cached body is already decoded. Re-wrapping it under the stored
		// response's own content-encoding and content-length describes a body
		// that is not the body being sent.
		const clean = sanitizeHeaders({
			'content-type': 'application/json',
			'content-encoding': 'gzip',
			'content-length': '812',
			connection: 'keep-alive',
		})
		assert.deepEqual(Object.keys(clean), ['content-type'])
	})
})

describe('offline drill-down: the cap still holds', () => {
	it('a detail bucket over its cap is trimmed oldest-first', () => {
		const now = Date.parse('2026-10-04T12:00:00.000Z')
		const policy = CACHE_POLICIES.detail
		const entries = Array.from({ length: policy.maxEntries + 5 }, (_, i) => ({
			id: `/api/v1/districts/d${i}`,
			storedAtMs: now - (i + 1) * 1000,
		}))
		const doomed = evictionPlan(entries, { now, ttlMs: policy.ttlMs, maxEntries: policy.maxEntries })
		assert.equal(doomed.length, 5)
		assert.equal(new Set(doomed).size, 5, 'no request is deleted twice')
		// The five most recently stored survive: they are the districts someone
		// opened, and the cap takes the oldest rather than an arbitrary five.
		assert.ok(!doomed.includes('/api/v1/districts/d59'))
		assert.ok(!doomed.includes('/api/v1/districts/d55'))
	})
})

describe('offline drill-down: the theme travels with the shell', () => {
  it('the theme control needs no request the offline graph has not already got', async () => {
    const graph = await shellGraph(loadFromDisk, 'https://app.test')
    assert.ok(graph.includes('/shared/navbar.js'))
    assert.ok(graph.includes('/tokens.css'))
    // The theme code lives inside the navbar rather than beside it, so the
    // graph has one fewer entry to miss and a device that never reconnects has
    // one fewer request to fail.
    assert.ok(!graph.includes('/shared/theme.js'))
  })
})
