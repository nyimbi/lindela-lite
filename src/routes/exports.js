/**
 * ARC-01 — the export routes, out of the god function.
 *
 * `handleApiRequestInContext` held the whole `/api/v1` surface in one 2,132-line
 * function. This is one family of it, extracted the way the file's own sixteen
 * `match*Route`/`handle*Route` pairs already are: a matcher that reads only the
 * pathname, and a handler that receives what it needs.
 *
 * The export family is the one to start with because it is the most
 * self-contained and the most load-bearing. Four routes share one idea — a
 * partner is pulling a dataset to file as the record of truth — and each of them
 * has to answer the same three questions the same way:
 *
 *   - **Is this the whole set?** `export.csv` and `export.geojson` apply the
 *     default page limit unless told `unlimited`, and against a store of 12,929
 *     records they returned 500 with nothing in the body to say so. A silent
 *     truncation in the one format a partner cites is the worst failure this
 *     family has, so the two that materialise pass `unlimited` and the one that
 *     streams refuses `limit` and `cursor` outright.
 *   - **What vintage is it?** CAP-04. A hash over the records, so a citation
 *     names what was read. The streaming route cannot know its set before the
 *     headers go out, so it says `unavailable` rather than hashing a partial
 *     read — a vintage that names a dataset the caller does not hold is worse
 *     than no vintage.
 *   - **Which records?** One `filterRecords` call per route, so `?district=`,
 *     `?from=`/`?to=` and partner scoping narrow every export the same way.
 *     A filter that worked on one export and not another is the silent-ignore
 *     class this codebase refuses elsewhere.
 *
 * `matchExportRoute` reads the pathname only. Everything else — the store, the
 * loaded data, the auth context — arrives as an argument, which is what makes
 * the family testable without a request.
 */

import { once } from 'node:events'

import { COLLECTIONS } from '../store.js'
import { currentRequestAuth, districtRelationCollections, filterRecords, readRequestJson, toCsv, toGeoJson } from '../utils.js'
import { parseHxlFlag } from '../hxl.js'
import { vintageOf } from '../vintage.js'
import { pushDataValueSet } from '../connectors/dhis2-push.js'

/**
 * The collections an export spans.
 *
 * Named once. The three materialising routes used to repeat the spread inline,
 * which is how they drifted: `export.csv` carried fourteen collections and
 * `export.geojson` nine, so the same store produced two exports of different
 * sizes and neither said which one was the whole set.
 */
export const EXPORT_COLLECTIONS = Object.freeze([
  'hazard_events', 'conflict_events', 'service_assets', 'risk_scores',
  'impact_assessments', 'incidents', 'interventions', 'intervention_tasks',
  'field_reports', 'response_resources', 'alert_rules', 'alert_events',
  'rapidpro_dispatches', 'rapidpro_inbound_messages',
])

/** Every record the export spans, in one array, for the materialising routes. */
function exportRecords(data) {
  return EXPORT_COLLECTIONS.flatMap((name) => data[name] || [])
}

/**
 * Which export route a pathname is, or null.
 *
 * Pathname only, so this is a pure function of the URL — the property the
 * `check-openapi.mjs` gate reads to build its inventory of the served surface.
 */
/**
 * Which export route a request is, or null.
 *
 * VER-14, the class: the verb is checked per route rather than as a blanket
 * guard, because this family is not uniform. `docs/openapi.yaml` declares four
 * of these `get:` and `export/dhis2` **`post:`** — it pushes a dataValueSet
 * upstream and defaults to a dry run. A blanket `method !== 'GET'` here would
 * close the four and break the fifth; that is what the first attempt did, and
 * `test/dhis2-push.test.js:221` caught it. The methods below are read off the
 * spec, not assumed from the family's shape.
 */
export function matchExportRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/exports' && method === 'GET') return { kind: 'manifest' }
  if (pathname === '/api/v1/export.ndjson' && method === 'GET') return { kind: 'ndjson' }
  if (pathname === '/api/v1/export.geojson' && method === 'GET') return { kind: 'geojson' }
  if (pathname === '/api/v1/export.csv' && method === 'GET') return { kind: 'csv' }
  if (pathname === '/api/v1/export/dhis2' && method === 'POST') return { kind: 'dhis2' }
  return null
}

/**
 * Handle one export route.
 *
 * Returns true when it handled the request. `jsonResponse` and the vintage index
 * are injected rather than imported, because the response writer is the
 * dispatcher's (it carries the CSP headers and the envelope) and the index is
 * per-process state the server owns.
 */
export async function handleExportRoute(route, { store, req, res, url, jsonResponse, vintageIndex, loadData }) {
  const { kind } = route

  // ARC-01. The whole-store read, deferred to the routes that need it.
  //
  // This family is dispatched above the dispatcher's own read, because
  // `export.ndjson` exists to avoid that read and would 503 on a store past the
  // read-row budget if it ran after it. Everything else here is cheap: the
  // manifest is process state and the NDJSON stream walks the store itself.
  // Only three routes want the materialised set, so it is a thunk they call
  // rather than an argument everyone is handed.
  let data = null
  const materialise = async () => (data ??= await loadData())

  if (kind === 'manifest') {
    // CAP-04. What partners hold. Each entry is a vintage this process has
    // served, with the hash a consumer can compare against. It is an index of
    // responses, not a store of datasets: nothing here can be fetched again,
    // and `?vintage=` on an export is refused for that reason.
    jsonResponse(res, 200, { success: true, ...vintageIndex.list() })
    return true
  }

  if (kind === 'dhis2') {
    if (req.method !== 'POST') return false
    // CAP-02. The push half of the DHIS2 link. `dry_run` defaults to true in
    // `pushDataValueSet`, so an operator can see the exact body without a
    // write; sending requires `dry_run: false` in the body, which is the point.
    const body = await readRequestJson(req)
    const records = Array.isArray(body.records) ? body.records : ((await materialise()).climate_observations || [])
    const result = await pushDataValueSet({
      ...body,
      records,
      // The request's own mapping wins; absent one, the deployment's connector
      // config is the mapping the pull already reads.
      org_units: body.org_units || body.orgUnits || {},
      data_elements: body.data_elements || body.dataElements || {},
    })
    // A push whose outcome is not `pushed` or `dry_run` did not do what the
    // caller asked, so it is not a 200 with a flag — the status says so.
    const ok = result.outcome === 'pushed' || result.outcome === 'dry_run'
    jsonResponse(res, ok ? 200 : 502, { success: ok, ...result })
    return true
  }

  if (req.method !== 'GET') return false

  if (kind === 'ndjson') {
    // Not `materialise()`: the stream reads the store itself, one batch at a
    // time, and calling the whole-store read here is the defect this route was
    // built to remove.
    await streamNdjson({ store, req, res, url, jsonResponse })
    return true
  }

  if (kind === 'geojson') {
    // A FeatureCollection that silently stops at 500 puts the map's features and
    // the map's count in disagreement with no marker, and a GIS client cannot
    // tell a truncated collection from a small one.
    const loaded = await materialise()
    const records = filterRecords(exportRecords(loaded), url.searchParams, {}, { unlimited: true })
    const vintage = vintageOf(records, { store: loaded })
    vintageIndex.record(vintage)
    jsonResponse(res, 200, toGeoJson(records), {
      'content-type': 'application/geo+json; charset=utf-8',
      'x-lindela-vintage': vintage.vintage,
      'x-lindela-record-count': String(vintage.record_count),
    })
    return true
  }

  if (kind === 'csv') {
    const loaded = await materialise()
    const records = filterRecords(
      exportRecords(loaded),
      url.searchParams,
      { auth: req.__auth, data: loaded, collection: 'export' },
      { unlimited: true },
    )
    // ENH-31. `?hxl=1` adds the HXL hashtag row above the header. A value that
    // is not a switch is refused rather than read as truthy — `Boolean('maybe')`
    // is true, so a truthiness test would tag the export for a caller who did
    // not ask, and ignoring it instead tells a caller a parameter was honoured
    // when it was not. Same rule as `?limit=abc`.
    const hxl = parseHxlFlag(url.searchParams.get('hxl'))
    if (hxl === undefined) {
      jsonResponse(res, 400, {
        success: false,
        error: 'hxl must be one of 1, 0, true, false, yes or no',
      })
      return true
    }
    // CAP-04. `?vintage=` is refused rather than ignored. The store keeps no
    // snapshots, so a vintage can be *reported* but not *requested* — and a
    // report that names a vintage it did not actually read is a citation that
    // lies. Refusing says so; ignoring the parameter would let a caller believe
    // they had pinned a vintage they had not.
    if (url.searchParams.get('vintage') !== null) {
      jsonResponse(res, 400, {
        success: false,
        error: 'vintage is not a requestable parameter: this deployment stores no snapshots, so an export cannot be pinned to an earlier vintage. Read `vintage` from the response header and cite it; the manifest at /api/v1/exports lists what has been served.',
      })
      return true
    }
    const vintage = vintageOf(records, { store: loaded })
    vintageIndex.record(vintage)
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="lindela-lite-export-${vintage.vintage.slice(0, 12)}${hxl ? '-hxl' : ''}.csv"`,
      // The vintage, on the response, so a report can name what it read without
      // a second request. The filename carries the short form too, so a file
      // saved from a browser is self-identifying on a disk where the header is
      // long gone.
      'x-lindela-vintage': vintage.vintage,
      'x-lindela-record-count': String(vintage.record_count),
    })
    res.end(toCsv(records, { hxl: Boolean(hxl) }))
    return true
  }

  return false
}

/**
 * ENH-37. The same records as `export.csv` and `export.geojson`, streamed.
 *
 * Those two call `filterRecords` over a spread of collections, which materialises
 * the whole matched set and then serialises it into one string held in memory
 * before `res.end()` writes a byte. Measured on the demo store, `export.csv` at
 * the default limit returned 500 of 12,929 records and said nothing about the
 * other 12,429 — a silent truncation in a `text/csv` body. A partner pulling a
 * flood season's field reports cannot do it at all.
 *
 * This walks the store with `iterateRecords` and writes each record as it
 * arrives, so the peak heap is one batch regardless of table size, and the
 * backpressure is real: `write()` returning false pauses the generator until the
 * socket drains.
 *
 * NDJSON, not CSV. A streamed CSV needs its header row complete before the first
 * record, and a flat header cannot be known until every record has been
 * flattened — the union of keys is only visible after the last row. NDJSON has no
 * header: each line is a self-describing JSON object, which is what a stream can
 * honestly produce. HXL (ENH-31) is a CSV convention and stays on the CSV route.
 */
async function streamNdjson({ store, req, res, url, jsonResponse }) {
  // `?collection=` narrows the stream to one collection, which is how a partner
  // pulls field reports without the rest of the store. It is validated against
  // the declared list, so a typo is a 400 rather than an empty file that reads as
  // "no records".
  const requested = url.searchParams.get('collection')
  if (requested !== null && !COLLECTIONS.includes(requested)) {
    jsonResponse(res, 400, {
      success: false,
      error: `collection must be one of the ${COLLECTIONS.length} declared collections; received ${JSON.stringify(requested)}`,
    })
    return
  }
  // `?limit=` and `?cursor=` are paging parameters, and this route does not page.
  // `filterRecords` reads both, so honouring them is the easy path and the wrong
  // one: a stream that stops at 500 for a caller who never asked for 500 is the
  // truncation this route was built to remove, arriving by a different door. A
  // caller who wants a page has the list routes; a caller who wants to stop early
  // closes the connection, which the cursor handles. Refused rather than ignored,
  // because an ignored parameter is indistinguishable from an honoured one.
  for (const paged of ['limit', 'cursor']) {
    if (url.searchParams.has(paged)) {
      jsonResponse(res, 400, {
        success: false,
        error: `${paged} is not a parameter of this route: the export is not paged, and a stream that stopped early would be indistinguishable from a complete one`,
      })
      return
    }
  }

  const collections = requested === null ? null : [requested]
  // The caller on the request context, not `req.__auth`: this family is
  // dispatched above the line that stamps `req.__auth`, because `export.ndjson`
  // must not run behind the dispatcher's whole-store read. `filterRecords`
  // defaults to the same caller, resolved one frame up — but "the same caller"
  // is a claim, and a stream of another organisation's field reports is a
  // disclosure. `test/streaming-export.test.js` asserts it rather than assuming.
  const partnerOrg = currentRequestAuth()?.partner_org || null

  // A record that names a district needs the collections the district relation
  // is built from, and a streaming route cannot ask `filterRecords` to go and
  // find them: it sees one record at a time and has no store to read. So the
  // parents are resolved once, up front, and only when the stream is narrowed —
  // never the whole store, which is the read this route exists to avoid.
  let relations = null
  if (url.searchParams.has('district') || url.searchParams.has('region')) {
    const needed = new Set()
    for (const name of (collections === null ? COLLECTIONS : collections)) {
      for (const parent of districtRelationCollections(name)) needed.add(parent)
    }
    if (needed.size) {
      relations = await store.read({ collections: [...needed], partnerOrg })
    }
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="lindela-lite-export${requested ? `-${requested}` : ''}.ndjson"`,
    // No `content-length`: the size is not known before the stream ends, and a
    // guessed one is worse than none. Chunked transfer is the honest encoding for
    // a body the server cannot measure.
    'cache-control': 'no-store',
    // CAP-04. The vintage is a hash over the whole set, and this route's set is
    // not known until the last record arrives — after the headers are on the
    // wire. So the header says so rather than carrying a value computed from a
    // partial read, which would be a vintage that names a dataset the caller does
    // not hold. A caller who needs a citable vintage uses `export.csv` or
    // `export.geojson`, which materialise the set and can hash it before
    // responding.
    'x-lindela-vintage': 'unavailable: this route streams, so the set is not known before the headers are sent; use export.csv or export.geojson for a citable vintage',
  })

  let sent = 0
  try {
    for await (const { collection, body } of store.iterateRecords({ collections, partnerOrg })) {
      // The caller's filters, applied per record rather than to a materialised
      // array. `filterRecords` takes one record at a time here, so `?district=`
      // and `?from=`/`?to=` narrow the stream the same way they narrow
      // `export.csv` — a filter that worked on one export and not the other is
      // the same silent-ignore class this codebase refuses elsewhere.
      //
      // No `unlimited` flag, and that is deliberate rather than an oversight:
      // `filterRecords` caps by slicing the array it is handed, and this array is
      // always one record long, so the cap cannot bite. The parameters that
      // *would* make it bite — `limit` and `cursor` — are refused above rather
      // than silently neutralised here.
      const [kept] = filterRecords([body], url.searchParams, { data: relations, collection })
      if (!kept) continue
      if (!res.write(`${JSON.stringify({ collection, ...kept })}\n`)) {
        await once(res, 'drain')
      }
      sent += 1
    }
    res.end()
  } catch (error) {
    // Mid-stream there is no status code left to send — the 200 and the body are
    // already on the wire. The only honest ending is a final line naming the
    // failure, so a consumer reading NDJSON sees an incomplete stream rather than
    // a clean EOF that reads as a complete export.
    res.write(`${JSON.stringify({ error: 'export_failed', message: error.expose ? error.message : 'the export could not be completed', sent })}\n`)
    res.end()
  }
}
