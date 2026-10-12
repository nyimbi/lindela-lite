import { stacCatalog, stacCollection, stacItem, ogcFeatureCollection, resolveStacCollection, STAC_READ_COLLECTIONS } from '../stac.js'
import { currentRequestAuth } from '../utils.js'

/**
 * The STAC catalogue and its OGC twin (ARC-08, ENH-60).
 *
 * These two families are not `/api/v1/` routes and were never extracted, so
 * they kept every property the extraction exists to remove. Two of them were
 * live defects:
 *
 *   - **The whole-store read.** `handleStacRoute` called `store.read()` with no
 *     manifest, materialising all 63 collections to answer a request that
 *     touches four. ARC-08 fixed that in place, and this module is where the
 *     fix belongs — beside the route, not 800 lines above it.
 *
 *   - **The partner scope.** The same read ran outside the request context, so a
 *     token scoped to one organisation was served another's service assets. The
 *     auth gate answered 401 correctly and the isolation was still absent,
 *     because `authenticate` proves *a* caller and says nothing about *which*
 *     partner.
 *
 * The third defect was invisible until the other two were fixed, and it is the
 * reason this file exists rather than another in-place edit. `scripts/route-surface.mjs`
 * reads inline `.match()` literals only inside the dispatcher body and inside a
 * named `match*Route` function. `handleStacRoute` is neither, so three served
 * routes — `/stac/collections/{id}`, `/stac/collections/{id}/items`,
 * `/ogc/collections/{id}/items` — appeared in no manifest, no document entry,
 * and no check. `check-openapi` reported a clean *176 documented, 176 served*
 * straight over them: agreement by mutual blindness, which is exactly the shape
 * of the tile-proxy defect that closed ENH-59's parser gap in the first place.
 *
 * Writing the matcher here is what makes them visible. The literal stays in the
 * `match*Route` body rather than being hoisted to a constant, because the parser
 * reads it from there — a matcher whose paths it cannot see is a family reported
 * as *no paths*, which passes the document comparison by contributing nothing.
 */

/**
 * `GET /stac/catalog.json`, `/stac/collections/{id}`, `/stac/collections/{id}/items`,
 * `/stac/collections/{id}/items/{itemId}` → a descriptor, else `null`.
 *
 * A non-GET is `null` rather than a descriptor the handler refuses, so the
 * dispatcher's 405 table stays the one place that answers "wrong verb".
 */
export function matchStacRoute(pathname, method = 'GET') {
  if (String(method).toUpperCase() !== 'GET') return null

  if (pathname === '/stac/catalog.json') return { kind: 'catalog' }

  // Two regexes rather than one, and the spelling is the contract rather than a
  // style choice. `scripts/route-surface.mjs` reads a family's paths out of this
  // body, and it recognises two forms: a `pathname === '…'` literal and a
  // `<regex>.exec(<arg containing "pathname">)`. Two things it then does to what
  // it finds, both of which the single-regex draft got wrong:
  //
  //   - A local alias reads as nothing. `const path = String(pathname)` followed
  //     by `.exec(path)` yields *no path syntax recognised*, so the family
  //     contributes nothing to the document comparison while reporting success —
  //     the same blindness this extraction exists to close, one level down.
  //
  //   - A *nested* optional is flattened. `/collections/([^/]+)(?:\/items(?:\/([^/]+))?)?`
  //     is one route with two optional tails; the parser pulls optionals out one
  //     level and produced `/stac/collections/{id}/{id}` — a path that is neither
  //     the items route nor the collection route, and that a document written
  //     against the real surface could never match. Splitting it into a trailing
  //     optional per regex gives the four paths that actually exist.
  const items = /^\/stac\/collections\/([^/]+)\/items(?:\/([^/]+))?$/.exec(String(pathname || ''))
  if (items) {
    return { kind: 'collection', collectionId: items[1], itemId: items[2] || null, items: true }
  }

  const collection = /^\/stac\/collections\/([^/]+)$/.exec(String(pathname || ''))
  if (collection) {
    return { kind: 'collection', collectionId: collection[1], itemId: null, items: false }
  }

  return null
}

/**
 * `GET /ogc/collections/{id}/items` → a descriptor, else `null`.
 *
 * The OGC twin of the STAC items route. It shares `resolveStacCollection` with
 * the STAC family — four copies of a collection list is four chances to add a
 * collection to three of them — but the response shape differs, so the two
 * matchers stay separate and the dispatcher picks by path.
 */
export function matchOgcRoute(pathname, method = 'GET') {
  if (String(method).toUpperCase() !== 'GET') return null
  const match = /^\/ogc\/collections\/([^/]+)\/items$/.exec(String(pathname || ''))
  if (!match) return null
  return { kind: 'ogc-items', collectionId: match[1] }
}

/**
 * Answer a matched STAC or OGC route. Returns `true` when it wrote a response.
 *
 * `store` is passed rather than the already-read `data`, because these routes
 * are dispatched above the store read — the catalogue is not an `/api/v1/`
 * route and must not inherit that read. The manifest is `STAC_READ_COLLECTIONS`,
 * declared beside the collections it names in `src/stac.js`.
 */
/**
 * The OGC handler, paired to `matchOgcRoute` by the naming convention.
 *
 * `scripts/route-surface.mjs` derives a handler name from each matcher —
 * `handle${matcher.slice('match'.length)}` — and prints it as the coverage
 * line. The two families share one implementation because they share the
 * resolver and differ only in the response shape, which the descriptor already
 * carries; without this alias the coverage line would name `handleOgcRoute` and
 * no such function would exist, which is a small lie in a report whose whole
 * purpose is to be checkable.
 */
export const handleOgcRoute = handleStacRoute

export async function handleStacRoute(route, { store, req, res, jsonResponse }) {
  const data = await store.read({
    collections: STAC_READ_COLLECTIONS,
    partnerOrg: currentRequestAuth()?.partner_org || null,
  })
  const baseUrl = `http://${req.headers.host || 'localhost'}`

  if (route.kind === 'catalog') {
    jsonResponse(res, 200, stacCatalog(baseUrl))
    return true
  }

  const records = resolveStacCollection(data, route.collectionId)
  if (records === null) {
    jsonResponse(res, 404, { success: false, error: 'Collection not found' })
    return true
  }

  if (route.kind === 'ogc-items') {
    jsonResponse(res, 200, ogcFeatureCollection(records), { 'content-type': 'application/geo+json; charset=utf-8' })
    return true
  }

  if (!route.itemId) {
    if (route.items) {
      jsonResponse(res, 200, { type: 'FeatureCollection', features: records.map((r) => stacItem(r, route.collectionId, baseUrl)) })
      return true
    }
    jsonResponse(res, 200, stacCollection(route.collectionId, records, baseUrl))
    return true
  }

  const record = records.find((r) => r.id === route.itemId)
  if (!record) {
    jsonResponse(res, 404, { success: false, error: 'Item not found' })
    return true
  }

  jsonResponse(res, 200, stacItem(record, route.collectionId, baseUrl), { 'content-type': 'application/geo+json; charset=utf-8' })
  return true
}
