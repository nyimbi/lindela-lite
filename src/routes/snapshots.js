/**
 * ENH-34 — the snapshot routes, as a family beside the export ones.
 *
 * Three routes over two paths, and they are the read half of the vintage
 * machinery: `src/vintage.js` identifies a dataset, this stores a copy of it
 * and mints a handle that resolves to the copy. The domain — what a snapshot
 * *is*, what a licence obliges, how a handle is minted — lives in
 * `src/snapshots.js`; this module decides which request is which and writes the
 * response.
 *
 * Split rather than kept in one file because `scripts/check-openapi.mjs` reads
 * the served surface out of `src/server.js` and every module under
 * `src/routes/`, by directory rather than by a list. A matcher in `src/` is
 * invisible to it, and it reports the documented paths as ghosts — which is
 * exactly what it did when this family first shipped as one file. The gate's
 * own comment names the failure: "a gate scoped to a file rather than to the
 * surface it audits goes blind the moment the surface moves".
 */

import { buildSnapshot, mintHandle, validateSnapshotRequest } from '../snapshots.js'
import { collectionPage, matchedAndPage, readRequestJson } from '../utils.js'
import { EXPORT_COLLECTIONS, vintageOf } from '../vintage.js'

/**
 * Which snapshot route a request is, or null.
 *
 * Method-aware per route: the collection is read with GET and written with POST,
 * and one handle is read with GET. `?vintage=` on an export stays refused — this
 * is a different surface, not a second door onto the same one.
 */
export function matchSnapshotRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/dataset-snapshots' && method === 'GET') return { kind: 'list' }
  if (pathname === '/api/v1/dataset-snapshots' && method === 'POST') return { kind: 'create' }
  const one = pathname.match(/^\/api\/v1\/dataset-snapshots\/([^/]+)$/)
  if (one && method === 'GET') return { kind: 'retrieve', handle: decodeURIComponent(one[1]) }
  return null
}

/**
 * Handle one snapshot route. Returns true when it handled the request.
 */
export async function handleSnapshotRoute(route, { data, req, res, url, jsonResponse, store }) {
  const { kind } = route
  const auth = req.__auth
  const snapshots = data.dataset_snapshots || []

  if (kind === 'list') {
    // The listing is the index: handles and their provenance, never the records.
    // A page of handles that each carried 50,000 rows would be the export route
    // under a second name.
    const index = snapshots.map(({ records, ...meta }) => ({ ...meta, records_withheld: Array.isArray(records) ? records.length : 0 }))
    jsonResponse(res, 200, { success: true, ...collectionPage(index, url.searchParams, { auth, data, collection: 'dataset_snapshots' }) })
    return true
  }

  if (kind === 'retrieve') {
    const { handle } = route
    const snapshot = snapshots.find((s) => s.handle === handle || s.id === handle)
    if (!snapshot) {
      jsonResponse(res, 404, { success: false, error: `No snapshot with handle ${handle}`, code: 'not_found' })
      return true
    }
    // `?records=false` returns the provenance alone, for a consumer checking a
    // citation without pulling the dataset. Absent the parameter the records
    // come with it, because a handle that resolves to metadata only is a
    // citation that still cannot be reproduced.
    if (url.searchParams.get('records') === 'false') {
      const { records, ...meta } = snapshot
      jsonResponse(res, 200, { success: true, data: { ...meta, records_withheld: Array.isArray(records) ? records.length : 0 } })
      return true
    }
    jsonResponse(res, 200, { success: true, data: snapshot })
    return true
  }

  if (kind === 'create') {
    // An empty body is a snapshot of everything under `internal-only` — the one
    // licence that cannot be wrong if the caller forgot to say, because it
    // forbids the redistribution a wrong permissive tag would allow.
    const body = await readRequestJson(req)
    const licence = body.licence || 'internal-only'
    // The set the snapshot covers. A caller may name collections; absent one,
    // the snapshot covers what a vintage is computed over, so a handle and the
    // `x-lindela-vintage` header on an export describe the same set.
    const named = Array.isArray(body.collections) && body.collections.length ? body.collections : null
    const unknown = named ? named.filter((name) => !(name in data)) : []
    if (unknown.length) {
      jsonResponse(res, 400, { success: false, error: `Unknown collection(s): ${unknown.join(', ')}`, code: 'bad_request' })
      return true
    }
    const source = named ? named.flatMap((name) => data[name] || []) : exportCollectionsOf(data)
    const records = filterSnapshotRecords(source, url.searchParams)
    const problem = validateSnapshotRequest({ licence, attribution: body.attribution, records })
    if (problem) {
      jsonResponse(res, 400, { success: false, error: problem, code: 'bad_request' })
      return true
    }
    const vintage = vintageOf(records, { store: data })
    const snapshot = buildSnapshot(records, {
      vintage: vintage.vintage,
      handle: mintHandle(vintage.vintage),
      label: body.label ?? null,
      licence,
      attribution: body.attribution ?? null,
      collections: named,
      query: url.search || null,
      createdBy: auth?.subject ?? null,
    })
    await store.merge({ dataset_snapshots: [snapshot] })
    // 201 with the handle, and the records withheld from the response: the
    // caller just sent the set, so echoing 50,000 rows back is a copy nobody
    // asked for. The handle is what they need.
    const { records: withheld, ...meta } = snapshot
    jsonResponse(res, 201, { success: true, data: { ...meta, records_withheld: withheld.length } })
    return true
  }

  return false
}

/**
 * The same collection list `src/vintage.js` computes a vintage over.
 *
 * Imported rather than duplicated: two lists that agree today are not one
 * source of truth, and a snapshot covering a different set from the vintage it
 * carries would make the handle and the `x-lindela-vintage` header disagree
 * about what they describe.
 */
function exportCollectionsOf(data) {
  return EXPORT_COLLECTIONS.flatMap((name) => data[name] || [])
}

/** `filterRecords` semantics over an already-selected set, with no paging cap. */
function filterSnapshotRecords(records, query) {
  const { matched } = matchedAndPage(records, query, {}, { unlimited: true })
  return matched
}
