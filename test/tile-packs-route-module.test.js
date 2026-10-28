import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { describe, it } from 'node:test'

import {
  handleTilePackRoute,
  matchTilePackRoute,
  parseBboxParam,
} from '../src/routes/tile-packs.js'
import { clearRasterTileCache } from '../src/basemap-tiles.js'
import { readPmtilesArchive } from '../public/shared/tile-pack.js'

/**
 * ENH-42 — the offline tile-pack family, asserted where it now lives.
 *
 * `public/shared/tile-pack.js` shipped the format and was called by nothing.
 * This is the HTTP surface that materialises a pack, and the properties worth
 * asserting here are the ones no end-to-end test through a real tile server
 * could hold steady:
 *
 *   - **the upstream is refused by name when unconfigured.** The obvious wiring
 *     — build packs from the OSM/CARTO basemap proxy — is prohibited by both of
 *     those upstreams' own policies, by name, and both policies are archived
 *     verbatim under `docs/research/tile-packs/sources/`. A test that reached a
 *     real tile server would be a flakiness generator pointed at somebody's
 *     infrastructure *and* it would be exercising the prohibited path.
 *   - **the tile source is injected.** `fetchTile` is a seam, so the arithmetic
 *     and the assembly are tested with deterministic bytes and nothing leaves
 *     the process.
 *   - **a refusal names its reason.** Over-budget, unconfigured and
 *     answered-nothing are three different facts and each carries the word for
 *     itself rather than a generic 400.
 */

/** A response double that records what was written and never blocks. */
function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.body = () => Buffer.concat(res.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))
  res.json = () => JSON.parse(res.body().toString('utf8'))
  return res
}

/** `jsonResponse` is a dependency of the module, so the double has to provide it. */
function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(Buffer.from(JSON.stringify(body), 'utf8'))
  return res
}

const req = (accept) => ({ method: 'GET', headers: accept ? { accept } : {} })
const url = (query) => new URL(`http://127.0.0.1/api/v1/tile-packs${query}`)

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** Every tile the server has. Deterministic bytes, no network, no upstream. */
const allTiles = async (template, z, x, y) => ({ bytes: PNG, fetchedAt: 0 })

/** A tile server that is missing one tile, to see the hole reported. */
const missingOne = (skip) => async (template, z, x, y) => (
  z === skip.z && x === skip.x && y === skip.y ? null : { bytes: PNG, fetchedAt: 0 }
)

/** A small real ward: Lodwar, the pilot district the 2026-10-07 tile arithmetic got wrong. */
const WARD = '35.5,2.9,36.0,3.3'
const TEMPLATE = 'https://tiles.example.test/{z}/{x}/{y}.png'

const run = async (pathname, query, { accept, env = {}, fetchTile } = {}) => {
  const res = fakeResponse()
  const handled = await handleTilePackRoute(
    matchTilePackRoute(pathname, 'GET'),
    { req: req(accept), res, url: url(query), jsonResponse, env, fetchTile },
  )
  assert.equal(handled, true, `${pathname}${query} was not handled`)
  return res
}

describe('ENH-42 — matchTilePackRoute is a pure function of the pathname', () => {
  it('matches the two paths it serves and nothing else', () => {
    assert.deepEqual(matchTilePackRoute('/api/v1/tile-packs/plan', 'GET'), { kind: 'plan' })
    assert.deepEqual(matchTilePackRoute('/api/v1/tile-packs', 'GET'), { kind: 'pack' })
    // The near misses. A prefix match would swallow the whole `/api/v1/tile-packs…`
    // subtree, and a trailing-slash tolerance would make one path two.
    for (const pathname of ['/api/v1/tile-pack', '/api/v1/tile-packs/', '/api/v1/tile-packs/plan/', '/api/v1/tile-packs/plan/x']) {
      assert.equal(matchTilePackRoute(pathname, 'GET'), null, `${pathname} matched`)
    }
  })

  it('refuses every verb but GET, so a write falls through to the 404', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchTilePackRoute('/api/v1/tile-packs', method), null, `${method} matched`)
      assert.equal(matchTilePackRoute('/api/v1/tile-packs/plan', method), null, `${method} matched`)
    }
  })

  it('is pathname-only — no bbox segment, which is what keeps the spec honest', () => {
    // The obvious shape puts the bbox in the path, and `check-openapi.mjs` turns
    // every capture group into `{id}`, so it documents as
    // `/api/v1/tile-packs/{id}/{id}/{id}.pmtiles` — three path parameters named
    // `id` and nothing saying the first is a bbox. Served, and meaningless.
    assert.equal(matchTilePackRoute('/api/v1/tile-packs/35.5,2.9,36.0,3.3/10/12.pmtiles', 'GET'), null)
  })
})

describe('ENH-42 — parseBboxParam reads west,south,east,north', () => {
  it('parses the four numbers in the documented order', () => {
    const parsed = parseBboxParam('35.5,2.9,36.0,3.3')
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.bbox, { west: 35.5, south: 2.9, east: 36.0, north: 3.3 })
  })

  it('refuses a count that is not four, naming what it got', () => {
    const parsed = parseBboxParam('35.5,2.9,36.0')
    assert.equal(parsed.ok, false)
    assert.match(parsed.detail, /four numbers, got 3/)
  })

  it('refuses a non-number rather than letting NaN reach the plan', () => {
    // `Number('')` is 0 and `Number('x')` is NaN — the first would silently
    // become the equator, so the check is `Number.isFinite`, not truthiness.
    assert.equal(parseBboxParam('35.5,2.9,36.0,x').ok, false)
    assert.equal(parseBboxParam('35.5,2.9,36.0,').ok, false)
    assert.equal(parseBboxParam(undefined).ok, false)
  })
})

describe('ENH-42 — the plan route sizes a pack without touching an upstream', () => {
  it('answers with the tile count and the estimate, and works unconfigured', async () => {
    // `env: {}` — no `LINDELA_LITE_PACK_TILE_URL`. Sizing is arithmetic, and an
    // operator sizes a pack before standing a tile server up.
    const res = await run('/api/v1/tile-packs/plan', `?bbox=${WARD}&min_zoom=10&max_zoom=12`, { env: {} })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.success, true)
    assert.equal(body.data.tile_count, 53)
    assert.equal(body.data.min_zoom, 10)
    assert.equal(body.data.max_zoom, 12)
    assert.ok(body.data.estimated_bytes > 0)
    // The download path is the same request spelled the way the pack route
    // spells it — a client pastes what it just sized instead of transposing a
    // pair of coordinates into a 400.
    assert.equal(body.data.download_path, `/api/v1/tile-packs?bbox=35.5,2.9,36,3.3&min_zoom=10&max_zoom=12`)
  })

  it('refuses an over-budget bbox by name, with the count and the ceiling', async () => {
    // Kenya at z10..z14 is 68,903 tiles against a 20,000-tile budget. Refused
    // rather than clamped: an unbounded pack is a denial-of-service on a tile
    // server, and the count is the thing the module refuses on.
    const res = await run('/api/v1/tile-packs/plan', '?bbox=33,-5,42,6&min_zoom=10&max_zoom=14', { env: {} })
    assert.equal(res.status, 400)
    const body = res.json()
    assert.equal(body.success, false)
    assert.equal(body.reason, 'tile_budget')
    assert.equal(body.max_tiles, 20000)
    assert.ok(body.tile_count > 20000, `expected a count over the budget, got ${body.tile_count}`)
  })

  it('treats a blank zoom as an omitted one, not as zoom zero', async () => {
    // `?min_zoom=` gives `search.get` an empty string, and `Number('')` is 0 —
    // so a request that named no zoom was refused with "zoom range 0..14 is
    // outside 2..15", quoting a lower bound the caller never wrote. A blank
    // parameter is the same absence as an omitted one, which is the rule the
    // rest of this server follows.
    const omitted = await run('/api/v1/tile-packs/plan', `?bbox=${WARD}`, { env: {} })
    const blank = await run('/api/v1/tile-packs/plan', `?bbox=${WARD}&min_zoom=&max_zoom=`, { env: {} })
    // Both must *succeed* and carry the module's defaults. Asserting only that
    // the two agree was vacuous: a refusal quotes the same wrong bounds for both
    // and compares equal, which is how this test first passed against the bug.
    assert.equal(omitted.status, 200, omitted.json().error)
    assert.equal(blank.status, 200, blank.json().error)
    assert.equal(blank.json().data.min_zoom, omitted.json().data.min_zoom)
    assert.equal(blank.json().data.max_zoom, omitted.json().data.max_zoom)
    assert.equal(omitted.json().data.min_zoom, 2, 'the module default, not a zero the caller never wrote')
  })

  it('still refuses a zoom that is stated but unreadable', async () => {
    // The blank case above must not swallow this one: `?min_zoom=abc` names a
    // zoom, and the caller meant something by it. Refused, not defaulted.
    const res = await run('/api/v1/tile-packs/plan', `?bbox=${WARD}&min_zoom=abc&max_zoom=12`, { env: {} })
    assert.equal(res.status, 400)
    assert.equal(res.json().reason, 'invalid_zoom')
  })

  it('refuses an inverted bbox rather than answering an empty pack', async () => {
    const res = await run('/api/v1/tile-packs/plan', '?bbox=36,2.9,35.5,3.3', { env: {} })
    assert.equal(res.status, 400)
    assert.equal(res.json().reason, 'invalid_bbox')
  })
})

describe('ENH-42 — the pack route refuses by name when there is no tile server', () => {
  it('503s naming the variable, because the public servers prohibit this', async () => {
    // The load-bearing refusal. OSM's Tile Usage Policy §4 is headed
    // "Prohibited: bulk downloading and offline use"; CARTO's terms §9.c
    // prohibit bulk extraction. Both are archived under
    // `docs/research/tile-packs/sources/`. OSM names the remedy — "use
    // self-hosted tiles or a provider that explicitly allows
    // offline/prefetching" — so unset is the shipped default and the refusal
    // names the variable rather than falling back to an upstream whose terms
    // forbid the request.
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, { env: {} })
    assert.equal(res.status, 503)
    const body = res.json()
    assert.equal(body.reason, 'pack_source_not_configured')
    assert.equal(body.variable, 'LINDELA_LITE_PACK_TILE_URL')
    assert.match(body.error, /prohibit offline packs/)
  })

  it('refuses a template with no {z}/{x}/{y} rather than building a broken URL', async () => {
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: 'https://tiles.example.test/all.png' },
    })
    assert.equal(res.status, 500)
    assert.match(res.json().error, /must be a tile URL template containing \{z\}, \{x\} and \{y\}/)
  })

  it('refuses a metadata host, and permits an operator LAN address', async () => {
    // The SSRF jurisdiction is `assertConnectorUrl`, not the webhook guard: a
    // district office's tile server is on the district office's own network, so
    // RFC-1918 is the legitimate case and the instance-metadata range is not.
    const metadata = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: 'http://169.254.169.254/{z}/{x}/{y}.png' },
    })
    assert.equal(metadata.status, 500)
    assert.match(metadata.json().error, /not a usable tile server/)

    const lan = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: 'http://192.168.1.9:8080/tiles/{z}/{x}/{y}.png' },
      fetchTile: allTiles,
    })
    assert.equal(lan.status, 200, 'an operator LAN tile server is the documented remedy, not a refusal')
  })

  it('502s when the tile server answers none of the tiles, which is not an empty pack', async () => {
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: TEMPLATE },
      fetchTile: async () => null,
    })
    assert.equal(res.status, 502)
    const body = res.json()
    assert.equal(body.reason, 'no_tiles_fetched')
    assert.ok(body.tile_count > 0)
  })
})

describe('ENH-42 — a built pack round-trips, and its holes are named', () => {
  it('returns a PMTiles archive every planned tile is readable out of', async () => {
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: TEMPLATE },
      fetchTile: allTiles,
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/vnd.pmtiles')
    assert.equal(res.headers['x-lindela-missing-count'], '0')

    const bytes = res.body()
    const archive = readPmtilesArchive(new Uint8Array(bytes))
    assert.notEqual(archive, null, 'the response bytes are not a PMTiles v3 archive')
    assert.equal(archive.entries.length, Number(res.headers['x-lindela-tile-count']))
    assert.equal(archive.header.addressedTiles, 6)
    assert.equal(archive.header.minZoom, 10)
    assert.equal(archive.header.maxZoom, 10)
    // The header's bounds are the planned bbox, not the padded tile extent — a
    // client centres on what it asked for, not on the grid that covers it.
    assert.deepEqual(archive.header.bounds, { west: 35.5, south: 2.9, east: 36, north: 3.3 })

    // Provenance travels inside the archive, because a pack on a phone has no
    // server beside it to ask where it came from. The metadata block is JSON at
    // the offset the header names.
    const meta = JSON.parse(bytes.subarray(
      archive.header.metadataOffset,
      archive.header.metadataOffset + archive.header.metadataLength,
    ).toString('utf8'))
    // Redacted to the template's coordinates, and deliberately so: everything
    // after `{z}` is dropped, which is what keeps a `?key=…` credential from
    // travelling in a pack that gets copied onto phones and shared.
    assert.equal(meta.source, 'https://tiles.example.test/{z}/{x}/{y}')
    assert.match(meta.description, /Offline raster pack/)
  })

  it('does not carry a credential from the tile URL into the pack', async () => {
    // The redaction above, asserted as the property rather than the string: a
    // deployment that authenticates to its own tile server must not ship that
    // credential inside every archive it builds.
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      accept: 'application/json',
      env: { LINDELA_LITE_PACK_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png?key=s3cr3t' },
      fetchTile: allTiles,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.source, 'https://tiles.example.test/{z}/{x}/{y}')
    assert.doesNotMatch(JSON.stringify(res.json()), /s3cr3t/)
  })

  it('reports a tile the server does not have, in the manifest and in the header', async () => {
    // The defect this exists to prevent: a pack built with holes that ships as
    // complete renders a blank square in a ward and says nothing.
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      accept: 'application/json',
      env: { LINDELA_LITE_PACK_TILE_URL: TEMPLATE },
      fetchTile: missingOne({ z: 10, x: 612, y: 502 }),
    })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.success, true)
    // `buildPackManifest` spreads its `extra` at the top level, so the holes sit
    // beside `tile_ids` rather than under a key — the manifest is a flat record.
    assert.equal(body.data.missing_count, 1)
    assert.deepEqual(body.data.missing_tiles, [{ z: 10, x: 612, y: 502 }])
    // The manifest's own tile count is the tiles it actually holds; the extra
    // says how many were asked for, so a client can tell 5-of-6 from a bbox
    // that only ever had five.
    assert.equal(body.data.tile_count, 5)
    assert.equal(body.data.requested_tiles, 6)
    // And the manifest's promise is checkable: the tiles it names are the ones
    // the archive it accompanies actually addresses.
    assert.equal(body.data.tile_ids.length, 5)
  })

  it('serves the manifest instead of the bytes when the caller asks for JSON', async () => {
    // Two responses from one request by `Accept`. A manifest embedded in a
    // binary is a manifest nobody reads.
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      accept: 'application/json',
      env: { LINDELA_LITE_PACK_TILE_URL: TEMPLATE },
      fetchTile: allTiles,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    assert.equal(res.json().data.missing_count, 0)
  })

  it('builds the pack anyway when the tile server 404s a tile, recording the hole', async () => {
    // The end-to-end version of the basemap-tiles canary, through the route's
    // real fetch path rather than the injected seam. `fetchWithRetry` raises on
    // a non-2xx, so without the catch in `loadTileAt` this whole request 500s —
    // no pack at all, rather than a pack with one hole named. That is the
    // defect the feature exists to prevent, one step worse.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/10/612/502.png')) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(png)
    })
    const listener = server.listen(0)
    await new Promise((resolve) => listener.once('listening', resolve))
    try {
      clearRasterTileCache()
      const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
        accept: 'application/json',
        env: { LINDELA_LITE_PACK_TILE_URL: `http://127.0.0.1:${listener.address().port}/{z}/{x}/{y}.png` },
      })
      assert.equal(res.status, 200, 'a 404 on one tile aborted the whole pack')
      const body = res.json()
      assert.equal(body.data.missing_count, 1)
      assert.deepEqual(body.data.missing_tiles, [{ z: 10, x: 612, y: 502 }])
      assert.equal(body.data.tile_count, 5)
    } finally {
      clearRasterTileCache()
      listener.close()
    }
  })

  it('names the pack after the bbox and the zoom range it was built for', async () => {
    const res = await run('/api/v1/tile-packs', `?bbox=${WARD}&min_zoom=10&max_zoom=10`, {
      env: { LINDELA_LITE_PACK_TILE_URL: TEMPLATE },
      fetchTile: allTiles,
    })
    assert.match(res.headers['content-disposition'], /filename="[^"]*35\.5[^"]*\.pmtiles"/)
    // Not `immutable`: the holes are a property of this fetch, not of the bbox,
    // so a tile server that gains a tile changes the pack.
    assert.equal(res.headers['cache-control'], 'private, max-age=3600')
  })
})
