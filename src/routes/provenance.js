/**
 * ARC-01 — the provenance reads, out of the god function.
 *
 * Four routes that answer one question from four directions: *where did this
 * come from, and what does the platform still stand behind.*
 *
 *   - `explain/:id` resolves a record to its source run, its lineage rows and
 *     its declared limits — "where did this number come from" for one row.
 *   - `history/:collection` and `.../record` answer the same question over
 *     time, from the version history an ingestion run or a correction wrote.
 *   - `audit/verify` and `audit/head` answer it for the platform's own record
 *     of what it did, as a hash chain a reader can check.
 *   - `watermarks` reports how far each source has been read, which is the
 *     provenance of the *absence* — what the platform has not yet seen.
 *
 * The property that makes them a family, and the reason they are worth moving
 * together rather than one at a time: **none of them is a collection read, and
 * every one of them refuses a write.** Each answers a question about records
 * rather than serving records, so a client cannot tell from a 200 whether the
 * handler honoured the verb — which is exactly the VER-14 class. `history`
 * already refused every non-GET with a 405 and a code; `audit` and `explain`
 * carried `req.method === 'GET'` in the dispatch condition; `watermarks` was
 * fixed by the VER-14 sweep. Here the refusal is stated once, in the matcher,
 * for all four, so a new route in this family cannot arrive verb-agnostic.
 *
 * `history` is the one deliberate exception to the plain 404 for a wrong verb:
 * it answers **405 with `read_only`**, because a POST to a history route is not
 * a route that does not exist — it is a caller who believes they can write the
 * history, and that belief is worth correcting in words rather than with a 404
 * that reads as "wrong address".
 */

import { chainEntries, renderAuditProof, verifyChain } from '../audit-chain.js'
import { ERROR_CODES } from '../errors.js'
import { observationSeries, projectableCollections, recordHistory } from '../series.js'
import { describeWatermarkState } from '../watermarks.js'

/**
 * Which provenance route a request is, or null.
 *
 * Method-aware once for the whole family. `history` is matched even on a
 * non-GET so its handler can answer 405 rather than let the request fall
 * through to a 404; the rest decline the method here and never reach a handler.
 */
export function matchProvenanceRoute(pathname, method = 'GET') {
  const explain = pathname.match(/^\/api\/v1\/explain\/([^/]+)$/)
  if (explain && method === 'GET') return { kind: 'explain', id: decodeURIComponent(explain[1]) }

  if (method === 'GET' && (pathname === '/api/v1/audit/verify' || pathname === '/api/v1/audit/head')) {
    return { kind: 'audit', action: pathname.endsWith('/verify') ? 'verify' : 'head' }
  }

  // Two patterns rather than one with an optional tail. A capturing optional —
  // `([^/]+)(\/record)?` — is read by `scripts/check-openapi.mjs` as a required
  // segment, so the bare series path disappears from the gate's view of what is
  // served and the spec's `/api/v1/history/{id}` is reported as a ghost. The
  // gate is right to read it that way: it cannot tell an optional group from a
  // required one, and a matcher that only parses under a looser reader is a
  // matcher whose served surface is unknown.
  const record = pathname.match(/^\/api\/v1\/history\/([^/]+)\/record$/)
  if (record) return { kind: 'history', collection: decodeURIComponent(record[1]), record: true }
  const series = pathname.match(/^\/api\/v1\/history\/([^/]+)$/)
  if (series) return { kind: 'history', collection: decodeURIComponent(series[1]), record: false }

  if (pathname === '/api/v1/watermarks' && method === 'GET') return { kind: 'watermarks' }

  return null
}

/**
 * Handle one provenance route. Returns true when it handled the request.
 */
export async function handleProvenanceRoute(route, { data, req, res, url, jsonResponse }) {
  const { kind } = route

  if (kind === 'explain') return explainRecord(route, { data, res, url, jsonResponse })
  if (kind === 'audit') return auditProof(route, { data, res, url, jsonResponse })
  if (kind === 'history') return history(route, { data, req, res, url, jsonResponse })
  if (kind === 'watermarks') return watermarks({ data, res, jsonResponse })

  return false
}

/**
 * "Where did this number come from", for one record.
 *
 * The server's half only: it resolves the record and hands back everything the
 * store knows about how it arrived. The chain of reasoning is rendered by
 * `explainRecord` in the browser module, so there is one implementation of it
 * rather than a server copy that drifts.
 */
function explainRecord(route, { data, res, url, jsonResponse }) {
  const kind = url.searchParams.get('kind') || 'risk_scores'
  const id = route.id
  const rows = data[kind] || []
  const record = rows.find((r) => String(r.id) === id)
  if (!record) {
    jsonResponse(res, 404, { success: false, error: `No ${kind} record with id ${id}` })
    return true
  }
  const run = record._source_run_id
    ? (data.source_runs || []).find((r) => r.id === record._source_run_id) || null
    : null
  const lineage = (data.data_lineage || []).filter((l) => l.source_run_id === record._source_run_id)
  jsonResponse(res, 200, {
    success: true,
    kind,
    record,
    // A record with no source run still gets a 200: it exists, and saying so is
    // the answer. Absence of provenance is a fact about the record, not a reason
    // to withhold it.
    provenance: {
      source_run: run,
      lineage,
      // Stated rather than left as null, because null here reads as "we did not
      // look" rather than "there was nothing to find".
      known: Boolean(run || lineage.length),
      note: run || lineage.length
        ? null
        : 'This record names no source run, so its origin cannot be traced from the store.',
    },
    limits: record.limits || null,
    calibrated_uncertainty: record.calibrated_uncertainty ?? null,
  })
  return true
}

/**
 * The platform's own record of what it did, as a chain a reader can check.
 *
 * The published head travels OUT OF BAND. Verifying a chain against a head
 * stored inside the chain it protects proves nothing: a file re-chained end to
 * end is internally consistent and completely rewritten.
 */
function auditProof(route, { data, res, url, jsonResponse }) {
  // chainEntries returns the entries AND the head it computed; it is not itself
  // the list, and passing the object where an array was wanted is what made this
  // route 500 on its first call.
  const { entries } = chainEntries(data.action_logs || [])
  const publishedHead = url.searchParams.get('head') || null
  const proof = verifyChain(entries, { expectedHead: publishedHead })
  jsonResponse(res, 200, {
    success: true,
    entries: entries.length,
    head: entries.length ? entries[entries.length - 1].entry_hash : null,
    verified: proof.ok,
    // Present so a reader is not left to infer it from a missing field: a chain
    // nobody anchored is internally consistent and still not proof.
    unanchored: !publishedHead,
    defects: proof.defects || [],
    advisories: proof.advisories || [],
    // renderAuditProof re-verifies from the entries itself and renders the
    // human-readable document a non-engineer reads. Passing it the proof object
    // instead is what made this route 500 on its third attempt.
    proof: renderAuditProof(entries, { expectedHead: publishedHead }),
  })
  return true
}

/**
 * A value the platform believed, over time, or one record's own history.
 *
 * ENH-49. `valueAsOf` and `versionsFor` had zero production callers, so "why
 * does this district's count disagree with the report" was a question the
 * repository held the answer to and had no way to ask. This is that question as
 * a query.
 */
function history(route, { data, req, res, url, jsonResponse }) {
  if (req.method !== 'GET') {
    jsonResponse(res, 405, { success: false, error: 'History is read-only: a value the platform believed is written by an ingestion run or a correction, not by an API caller', code: ERROR_CODES.READ_ONLY })
    return true
  }
  if (route.record) {
    const recordId = url.searchParams.get('id')
    if (!recordId) {
      jsonResponse(res, 400, { success: false, error: 'id is required: /history/:collection/record asks about one record' })
      return true
    }
    jsonResponse(res, 200, {
      success: true,
      data: recordHistory(data, { collection: route.collection, recordId, at: url.searchParams.get('at') }),
    })
    return true
  }
  jsonResponse(res, 200, {
    success: true,
    data: observationSeries(data, {
      collection: route.collection,
      district: url.searchParams.get('district'),
      at: url.searchParams.get('at'),
    }),
    // Repeated at the top level so a client that guessed a collection name sees
    // the right ones without reaching into the data object.
    projectable_collections: projectableCollections(),
  })
  return true
}

/**
 * How far each source has been read — the provenance of what is absent.
 *
 * A store with no watermark row for a source is not a store where the source is
 * up to date; it is one where the platform has no idea. `describeWatermarkState`
 * is what tells those two apart, and it is why this answers a described state
 * rather than the raw rows.
 */
function watermarks({ data, res, jsonResponse }) {
  jsonResponse(res, 200, {
    success: true,
    data: describeWatermarkState(
      Object.fromEntries((data.watermark_state || []).map((row) => [row.source, row.state || {}])),
    ),
  })
  return true
}
