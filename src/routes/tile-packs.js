/**
 * ENH-42 — offline map tile packs, as a route.
 *
 * The pack format shipped 2026-10-12 and was tested and called by nothing:
 * `public/shared/tile-pack.js` plans a bbox, writes and reads a PMTiles v3
 * archive and builds a manifest a client verifies offline. This is the HTTP
 * surface that materialises the tiles, and it is a route module rather than a
 * block in `handleApiRequestInContext` for the reason ARC-01 gives: the
 * dispatcher is already 1,372 lines and every family that moves out of it is a
 * family the next reader does not have to hold.
 *
 * ## The upstream is the operator's, and that is the whole design
 *
 * The obvious wiring — build the pack from `loadRasterTile('osm', …)`, the proxy
 * ADR-013 already ships — is prohibited by both of the upstreams that proxy
 * serves, by name:
 *
 *   - The OSM Tile Usage Policy §4 is headed *"Prohibited: bulk downloading
 *     ("scraping") and offline use"*, and lists *"Building tile archives (e.g.
 *     `.zip`, `.mbtiles`) for later distribution"* and *"Offline use is not
 *     permitted on tile.openstreetmap.org"*.
 *   - The CARTO Basemap Terms §9.c prohibit *"downloading or extracting map
 *     content in bulk"* and *"redistributing the map tiles or other map content
 *     as tiles or data"*.
 *
 * Both are archived verbatim with citations under
 * `docs/research/tile-packs/sources/`, and the finding is why this route reads
 * `LINDELA_LITE_PACK_TILE_URL` and refuses when it is unset. OSM names the
 * remedy in the same paragraph — *"use self-hosted tiles or a provider that
 * explicitly allows offline/prefetching"* — so the configuration is not a
 * workaround, it is the documented path, and the refusal names it.
 *
 * The template is **operator configuration, not caller input**. The caller
 * supplies a bbox and a zoom range; it never supplies a URL. That is the SSRF
 * jurisdiction for this route, and it is why there is no caller-supplied URL to
 * guard — `packTileUrl` substitutes `{z}`/`{x}`/`{y}` as text into an
 * operator-set prefix, range-checking each coordinate against `2^z` first.
 *
 * ## Two routes, because sizing and fetching are different questions
 *
 * `GET /api/v1/tile-packs/plan` answers "how big is this pack" as arithmetic:
 * no tiles are fetched, no upstream is touched, and it works with no
 * configuration at all. `GET /api/v1/tile-packs` materialises the archive. A
 * client that cannot size a pack before requesting one downloads until it fails,
 * and on a field connection that is the wrong order to find out.
 *
 * ## Three refusals, each by name
 *
 *   - **Over budget.** `planTilePack` refuses with `tile_budget`/`byte_budget`
 *     and the numbers. Passed through as a 400 rather than clamped, because an
 *     unbounded pack is a denial-of-service on a tile server and the module's
 *     own budget reasoning already treats the count as the thing to refuse.
 *   - **No tile server configured.** A 503 naming the variable, not a 500 and
 *     not an empty pack.
 *   - **A tile the server does not have.** Reported in the response's `missing`
 *     list and in the manifest, never silently skipped. A pack built with holes
 *     that ships as complete renders a blank square in a ward and says nothing.
 */

import { createHash } from 'node:crypto'

import {
  buildPackManifest,
  buildPmtilesArchive,
  packFilename,
  planTilePack,
} from '../../public/shared/tile-pack.js'
import { loadPackTile, packTileTemplate } from '../basemap-tiles.js'
import { assertConnectorUrl } from '../webhooks.js'

/** How many tiles are fetched at once. A field server is one small box. */
const PACK_FETCH_CONCURRENCY = 6

/**
 * Which tile-pack route a request is, or null.
 *
 * Pathname and method only, so it stays a pure function of the URL — the
 * property `check-openapi.mjs` reads to build its inventory of the served
 * surface, and the reason the bbox is parsed in the handler rather than here.
 *
 * **Two literal paths, not a path with the bbox in it.** The obvious shape —
 * `/api/v1/tile-packs/{bbox}/{min}/{max}.pmtiles` — is the one to refuse, for a
 * reason that only shows up in the spec. That gate reads a family's served paths
 * out of its regex literals and turns every capture group into `{id}`, so the
 * route documents as `/api/v1/tile-packs/{id}/{id}/{id}.pmtiles`: a generated
 * client is handed three path parameters named `id` and nothing saying the first
 * is a bbox and the others are zooms. The path would be *served* and the meaning
 * lost, which is worse than a path a client cannot call, because it looks
 * callable.
 *
 * The query form reuses `components/parameters/Bbox`, which this API already
 * documents as `west,south,east,north` and which the OGC and STAC surfaces
 * already speak. One spelling of a bbox across the whole surface, and a spec
 * whose parameter names say what they are.
 */
export function matchTilePackRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/tile-packs/plan') return { kind: 'plan' }
  if (pathname === '/api/v1/tile-packs') return { kind: 'pack' }
  return null
}

/**
 * The bbox from `?bbox=`, or a refusal naming what was wrong.
 *
 * `west,south,east,north` — the order `components/parameters/Bbox` documents,
 * `demo-seed.js` writes and the spatial catalogues speak. A second order
 * accepted here would be two conventions for one shape that agree until someone
 * writes the other one, which is the class this repository keeps finding.
 */
export function parseBboxParam(raw) {
  const parts = String(raw ?? '').split(',')
  if (parts.length !== 4) {
    return { ok: false, detail: `bbox must be west,south,east,north — four numbers, got ${parts.length}` }
  }
  // A blank segment is refused rather than coerced. `Number('')` and
  // `Number(' ')` are both `0`, which is a *valid* coordinate — so `36,2.9,35.5,`
  // would silently become a bbox with its north edge on the equator and answer a
  // pack for the wrong place. `Number.isFinite` cannot see this: zero is finite.
  const [west, south, east, north] = parts.map((part) => (part.trim() === '' ? NaN : Number(part)))
  if (![west, south, east, north].every(Number.isFinite)) {
    return { ok: false, detail: `bbox ${raw} is not four finite numbers` }
  }
  return { ok: true, bbox: { west, south, east, north } }
}

/**
 * The zoom range from `?min_zoom=`/`?max_zoom=`, absent meaning the module's
 * default.
 *
 * A *blank* value is the same absence as an omitted one, which is the rule the
 * rest of this server follows. `search.get` returns `''` for `?min_zoom=`, and
 * `Number('')` is 0 — so a request that named no zoom was refused with "zoom
 * range 0..14 is outside 2..15", quoting a lower bound the caller never wrote.
 * A stated but unreadable value (`?min_zoom=abc`) stays NaN and is still
 * refused, by the same `Number.isInteger` check that catches a non-integer.
 */
function zoomRange(search) {
  const stated = (name) => {
    const raw = search.get(name)
    return raw === null || raw.trim() === '' ? null : Number(raw)
  }
  const minZoom = stated('min_zoom')
  const maxZoom = stated('max_zoom')
  return {
    ...(minZoom === null ? {} : { minZoom }),
    ...(maxZoom === null ? {} : { maxZoom }),
  }
}

/** The plan shape a refusal carries, with the numbers that decided it. */
function refusalBody(plan) {
  return {
    success: false,
    error: plan.detail || `the pack was refused: ${plan.reason}`,
    reason: plan.reason,
    ...(plan.tileCount === undefined ? {} : { tile_count: plan.tileCount }),
    ...(plan.maxTiles === undefined ? {} : { max_tiles: plan.maxTiles }),
    ...(plan.estimatedBytes === undefined ? {} : { estimated_bytes: plan.estimatedBytes }),
    ...(plan.maxBytes === undefined ? {} : { max_bytes: plan.maxBytes }),
  }
}

/**
 * Fetch every tile of a plan, in bounded batches, recording the ones the tile
 * server did not have.
 *
 * Bounded rather than `Promise.all`: a 639-tile ward pack at full concurrency is
 * 639 simultaneous requests at one box, which is the load the budget exists to
 * keep off a tile server and would be equally rude to an operator's own. Six at
 * a time is roughly the width a field server serves without queueing.
 *
 * `fetchTile` is a seam, and the tests are why it exists: a suite that reached a
 * real tile server would be a flakiness generator pointed at somebody's
 * infrastructure, and the arithmetic this route is responsible for is the same
 * either way.
 */
async function materialiseTiles(plan, template, fetchTile = loadPackTile) {
  const tiles = []
  const missing = []
  for (let i = 0; i < plan.tiles.length; i += PACK_FETCH_CONCURRENCY) {
    const batch = plan.tiles.slice(i, i + PACK_FETCH_CONCURRENCY)
    const loaded = await Promise.all(batch.map(async (tile) => {
      const entry = await fetchTile(template, tile.z, tile.x, tile.y)
      return { tile, bytes: entry?.bytes || null }
    }))
    for (const { tile, bytes } of loaded) {
      // A tile the server answered without, or answered with something that is
      // not a PNG (the loader checks the signature). Named, not skipped.
      if (!bytes) missing.push({ z: tile.z, x: tile.x, y: tile.y })
      else tiles.push({ z: tile.z, x: tile.x, y: tile.y, bytes })
    }
  }
  return { tiles, missing }
}

/**
 * Handle one tile-pack route. Returns true when it handled the request.
 */
export async function handleTilePackRoute(route, { req, res, url, jsonResponse, env = process.env, fetchTile } = {}) {
  const search = url.searchParams
  const parsed = parseBboxParam(search.get('bbox'))
  const plan = parsed.ok
    ? planTilePack({ bbox: parsed.bbox, ...zoomRange(search) })
    : { ok: false, reason: 'invalid_bbox', detail: parsed.detail }
  if (!plan.ok) {
    jsonResponse(res, 400, refusalBody(plan))
    return true
  }

  if (route.kind === 'plan') {
    // Sizing is arithmetic and touches no upstream, so it is answered whatever
    // the configuration is. A client sizes a pack before requesting it.
    jsonResponse(res, 200, {
      success: true,
      data: {
        bbox: plan.bbox,
        min_zoom: plan.minZoom,
        max_zoom: plan.maxZoom,
        tile_count: plan.tileCount,
        estimated_bytes: plan.estimatedBytes,
        // The exact count and the estimate, both. The count is the pack; the
        // estimate is `tileBytes` per tile and is the number a client shows
        // before it has fetched anything, so the two travel together rather than
        // one standing in for the other.
        estimated_note: `at ${plan.tileCount} tiles; the byte figure assumes a typical tile size, the count is exact`,
        // The path to ask for it, spelled the way this route spells it — the
        // same bbox in the same order, so a client pastes this and gets the pack
        // it just sized rather than a 400 from a transposed pair.
        download_path: `/api/v1/tile-packs?bbox=${[plan.bbox.west, plan.bbox.south, plan.bbox.east, plan.bbox.north].join(',')}&min_zoom=${plan.minZoom}&max_zoom=${plan.maxZoom}`,
        filename: packFilename(plan.bbox, plan.minZoom, plan.maxZoom),
      },
    })
    return true
  }

  // kind === 'pack'. The plan above already refused an unusable bbox and an
  // over-budget pack by name; what remains is fetching it.

  // The upstream, refused by name when unset. Not a 500: nothing failed, the
  // deployment is simply not configured to build packs, and the message says
  // which variable to set and why the public servers are not an option.
  let template
  try {
    template = packTileTemplate(env)
  } catch (thrown) {
    jsonResponse(res, 500, { success: false, error: thrown.message })
    return true
  }
  if (!template) {
    jsonResponse(res, 503, {
      success: false,
      error: 'no offline tile server is configured, so this deployment cannot build a tile pack. Set LINDELA_LITE_PACK_TILE_URL to a tile URL template containing {z}, {x} and {y}. The public OSM and CARTO tile servers prohibit offline packs by their usage policies and are not usable here.',
      variable: 'LINDELA_LITE_PACK_TILE_URL',
      reason: 'pack_source_not_configured',
    })
    return true
  }
  // The template is operator configuration, and it is validated as such: an
  // instance-metadata host is refused, an operator's own LAN address is not.
  // That is the connector jurisdiction (`assertConnectorUrl`), not the webhook
  // one — a district office's tile server is on the district office's network.
  try {
    assertConnectorUrl(template)
  } catch (thrown) {
    jsonResponse(res, 500, { success: false, error: `LINDELA_LITE_PACK_TILE_URL is not a usable tile server: ${thrown.message}` })
    return true
  }

  const { tiles, missing } = await materialiseTiles(plan, template, fetchTile)
  if (!tiles.length) {
    // Nothing fetched is not an empty pack. A 502 says the tile server answered
    // nothing, which is a different fact from "this bbox has no tiles".
    jsonResponse(res, 502, {
      success: false,
      error: `the tile server answered none of the ${plan.tileCount} tiles this bbox needs`,
      reason: 'no_tiles_fetched',
      tile_count: plan.tileCount,
      missing_count: missing.length,
    })
    return true
  }

  const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const provenance = template.replace(/\{z\}.*$/, '{z}/{x}/{y}')
  const archive = buildPmtilesArchive({
    tiles,
    bbox: plan.bbox,
    minZoom: plan.minZoom,
    maxZoom: plan.maxZoom,
    digest: sha256Hex,
    metadata: {
      name: packFilename(plan.bbox, plan.minZoom, plan.maxZoom),
      description: `Offline raster pack for ${plan.bbox.west},${plan.bbox.south},${plan.bbox.east},${plan.bbox.north} at z${plan.minZoom}..z${plan.maxZoom}`,
      type: 'baselayer',
      // The provenance travels in the archive's own metadata, because a pack on
      // a phone has no server beside it to ask where it came from.
      source: provenance,
      attribution: 'Tile imagery from the deployment\'s configured tile server',
    },
  })
  if (!archive.ok) {
    jsonResponse(res, 400, {
      success: false,
      error: archive.detail || `the archive was refused: ${archive.reason}`,
      reason: archive.reason,
      ...(archive.rootLength === undefined ? {} : { root_length: archive.rootLength, limit: archive.limit }),
    })
    return true
  }

  const manifest = buildPackManifest({
    bbox: plan.bbox,
    minZoom: plan.minZoom,
    maxZoom: plan.maxZoom,
    tiles,
    bytes: archive.bytes.length,
    digest: archive.digest,
    source: provenance,
    createdAt: new Date().toISOString(),
    // The holes, in the manifest rather than in a log. `verifyPackManifest`
    // names them on the client too; carrying them here is what lets a client
    // know *before* it downloads that the pack is short, and decide.
    extra: {
      missing_tiles: missing,
      missing_count: missing.length,
      requested_tiles: plan.tileCount,
    },
  })

  // Two responses from one request, by `Accept`: a client that wants the pack
  // gets the bytes, and one that wants to inspect it first gets the manifest and
  // a URL. A manifest embedded in a binary is a manifest nobody reads.
  if (String(req?.headers?.accept || '').includes('application/json')) {
    jsonResponse(res, 200, { success: true, data: manifest })
    return true
  }

  const bytes = Buffer.from(archive.bytes)
  res.writeHead(200, {
    'content-type': 'application/vnd.pmtiles',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${packFilename(plan.bbox, plan.minZoom, plan.maxZoom)}"`,
    // The pack is a derived artefact of immutable imagery, so it is cacheable —
    // but the holes are a property of this fetch, not of the bbox, so it is not
    // `immutable`. A tile server that gains a tile changes the pack, and a
    // client holding the old one has no way to know.
    'cache-control': 'private, max-age=3600',
    'x-lindela-tile-count': String(tiles.length),
    'x-lindela-missing-count': String(missing.length),
    'x-lindela-pack-digest': archive.digest || '',
  })
  res.end(bytes)
  return true
}
