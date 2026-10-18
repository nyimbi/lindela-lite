/**
 * ENH-60 — the CSV upload family, out of the dispatcher.
 *
 * Two routes and one contract. `GET` serves the column list a client needs
 * before it sends anything; `POST` accepts a CSV through three doors — a browser
 * form posting multipart, `curl --data-binary @file.csv` sending `text/csv`, and
 * an integrator who already has the rows in memory sending JSON — and all three
 * end up in the same validator, so the report is identical whichever door the
 * data came through.
 *
 * ## The refusals that are answers
 *
 * An upload route is where a partial write is most tempting and most damaging,
 * so the family holds three rules in one place:
 *
 *   - **A batch that fails validation writes nothing.** `422` with the errors,
 *     not a partial import: the caller otherwise has to work out which half
 *     landed, and the half that landed is the half they did not look at.
 *   - **A dry run writes no rows but still logs what it would have done**, and
 *     says so in the response. The first twenty errors are enough to recognise a
 *     systematic problem — a wrong date format, a transposed latitude column —
 *     and a four-thousand-error body is a denial of service against the reader,
 *     so `errors_truncated` reports the cut.
 *   - **A malformed multipart body is a 400, not a 500.** `parseMultipart`
 *     raises with its own `statusCode`, and the route honours it rather than
 *     letting a client's bad framing read as a server fault.
 *
 * The batch id is a fingerprint of the bytes, so two posts of the same file
 * produce the same id — which makes the log readable and gives an operator
 * something to quote when asking why their import ran twice.
 */

import { createHash } from 'node:crypto'

import { actionLog } from '../operations.js'
import { parseMultipart, UPLOAD_COLLECTIONS, validateUpload } from '../upload.js'
import { readRawBody, readRequestJson } from '../utils.js'

/**
 * Which upload route a request is, or null.
 *
 * The listing is GET and the ingest is POST, so the matcher takes the method.
 * `check-openapi.mjs` reads this body, so the paths are discoverable without a
 * second list.
 *
 * The path is written as a positive `===` comparison, not as a guard that
 * returns null on everything else. The gate parses the positive form only, and a
 * matcher it cannot read is a family it reports as *no paths* — which passes the
 * comparison by contributing nothing, the quietest failure this check has. It
 * caught exactly that here.
 */
export function matchUploadRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/upload') {
    if (method === 'GET') return { kind: 'upload-contract' }
    if (method === 'POST') return { kind: 'upload-ingest' }
  }
  return null
}

/**
 * Read the CSV text out of a request, whichever of the three shapes it is.
 *
 * Returns `{ csvText, filename, body }`, or `{ error }` for a body the route
 * must refuse before it reaches the validator. Kept separate from the handler
 * because the three branches are a parse, not a decision: the decision — write
 * or refuse — happens once, below, for all three.
 */
async function readCsv(req, url) {
  const contentType = String(req.headers['content-type'] || '')

  if (contentType.startsWith('multipart/form-data')) {
    const raw = await readRawBody(req)
    let parsed
    try {
      parsed = parseMultipart(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)), contentType)
    } catch (error) {
      // The client's framing is wrong, so the fault is the client's. Without
      // this the throw reads as a server error on a body the server never
      // accepted.
      return { error: { statusCode: error.statusCode || 400, message: error.message } }
    }
    const file = parsed.files.find((f) => f.field === 'file') || parsed.files[0]
    if (!file) {
      return { error: { statusCode: 400, message: 'No file part found. Send the CSV as a part named "file".' } }
    }
    return {
      csvText: file.content.toString('utf8'),
      filename: file.filename,
      body: { collection: parsed.fields.collection, dry_run: parsed.fields.dry_run },
    }
  }

  if (contentType.startsWith('text/csv')) {
    const raw = await readRawBody(req)
    return {
      csvText: Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw),
      filename: null,
      body: { collection: url.searchParams.get('collection'), dry_run: url.searchParams.get('dry_run') },
    }
  }

  const body = await readRequestJson(req)
  return { csvText: body.csv ?? '', filename: body.filename ?? null, body }
}

/**
 * Handle one upload route. Returns true when it handled the request.
 */
export async function handleUploadRoute(route, { store, data, req, res, url, jsonResponse }) {
  if (route.kind === 'upload-contract') {
    // A client that has to guess which columns a collection wants will guess
    // wrong, and a wrong guess is a validation report the operator has to read
    // instead of a column list they could have had up front.
    jsonResponse(res, 200, {
      success: true,
      collections: UPLOAD_COLLECTIONS.map(({ id, label, required, optional }) => ({
        id, label, required_columns: required, optional_columns: optional,
      })),
      accepts: ['multipart/form-data (part named "file")', 'text/csv?collection=…', 'application/json { csv, collection }'],
      dry_run: 'Send dry_run=true to validate and write nothing.',
    })
    return true
  }

  if (route.kind !== 'upload-ingest') return false

  const parsed = await readCsv(req, url)
  if (parsed.error) {
    jsonResponse(res, parsed.error.statusCode, { success: false, error: parsed.error.message })
    return true
  }
  const { csvText, filename, body } = parsed

  const dryRun = body.dry_run === true || body.dry_run === 'true' || body.dry_run === '1'
  const collection = body.collection || url.searchParams.get('collection') || 'service_assets'
  const existingIds = new Set((data[collection] || []).map((record) => record.id).filter(Boolean))
  const report = validateUpload(csvText, { collection, existingIds })

  // A batch is one thing that happened, so it gets one id — a fingerprint of the
  // bytes. Two posts of the same file produce the same id, which makes the log
  // readable and gives an operator something to quote when asking why their
  // import ran twice.
  const batchId = `upload_${createHash('sha256').update(csvText).digest('hex').slice(0, 12)}`

  if (dryRun) {
    await store.merge({
      action_logs: [actionLog(collection, 'upload_validated',
        { id: batchId }, body.actor || req.__auth?.subject, req.__auth?.subject, {
          batch_id: batchId,
          collection,
          filename,
          dry_run: true,
          ...report.summary,
          errors: report.errors.slice(0, 25),
          error_count_total: report.errors.length,
        })],
    })
    jsonResponse(res, 200, {
      success: true,
      dry_run: true,
      collection: report.collection,
      filename,
      ...report.summary,
      headers: report.headers,
      errors: report.errors.slice(0, 20),
      errors_truncated: report.errors.length > 20,
    })
    return true
  }

  if (!report.ok) {
    // The refusal is still an event. `uploaded` is the action name the audit
    // has always used for a POST that reached the store path, and the metadata
    // carries `invalid_rows` — so a refused batch is distinguishable from one
    // that never arrived without reading the message text.
    await store.merge({
      action_logs: [actionLog(collection, 'uploaded',
        { id: batchId }, body.actor || req.__auth?.subject, req.__auth?.subject, {
          batch_id: batchId,
          collection,
          filename,
          dry_run: false,
          ...report.summary,
          errors: report.errors.slice(0, 25),
          error_count_total: report.errors.length,
        })],
    })
    // Nothing is written. A partial import is the outcome nobody wants: the
    // caller has to work out which half landed, and the half that landed is the
    // half they did not look at.
    jsonResponse(res, 422, {
      success: false,
      error: report.summary.valid_rows === 0
        ? 'No rows could be imported. Nothing was written; the errors below say why.'
        : `Nothing was written. ${report.summary.invalid_rows} of ${report.summary.total_rows} rows failed validation, and a partial import is refused.`,
      collection: report.collection,
      filename,
      ...report.summary,
      headers: report.headers,
      errors: report.errors.slice(0, 20),
      errors_truncated: report.errors.length > 20,
    })
    return true
  }

  // DATA-13. `imported` is what the store kept, not what the file offered.
  //
  // `merge` skips an incoming record whose `payload_hash` the collection
  // already holds, and `canonicalHash` ignores `id` — so a re-export of the
  // same rows under fresh ids imports none of them. The route used to answer
  // `201 {imported: rows.length}`, which is a count of the input wearing the
  // output's name: an operator re-importing a GeoJSON they had just fixed was
  // told every row landed while the store declined all of them.
  //
  // A discard is not an error. The row is genuinely already stored; what was
  // wrong was the silence, so the response names the count and the ids (capped,
  // like the error list) and the batch id — which is a fingerprint of the
  // bytes — so the operator can point at the import that did it.
  const { discarded = [] } = (await store.merge({ [collection]: report.rows })) || {}
  const imported = report.rows.length - discarded.length
  // Logged after the merge, so the audit row carries what landed rather than
  // what was offered — the same distinction the response now makes. One merge
  // for the rows and one for the log, in that order: a log written first would
  // be the pre-merge claim this fix exists to remove.
  await store.merge({
    action_logs: [actionLog(collection, 'uploaded',
      { id: batchId }, body.actor || req.__auth?.subject, req.__auth?.subject, {
        batch_id: batchId,
        collection,
        filename,
        dry_run: false,
        imported,
        duplicates_skipped: discarded.length,
        duplicate_ids: discarded.slice(0, 25).map((item) => item.id),
        ...report.summary,
        errors: report.errors.slice(0, 25),
        error_count_total: report.errors.length,
      })],
  })
  jsonResponse(res, 201, {
    success: true,
    collection: report.collection,
    filename,
    imported,
    ...report.summary,
    // `imported + discarded === report.rows.length` by construction, and
    // `duplicates_skipped` is the same number as `discarded` under the name a
    // client reads. Stated on the response so the arithmetic is checkable
    // without knowing how the store dedups.
    duplicates_skipped: discarded.length,
    duplicate_ids: discarded.slice(0, 20).map((item) => item.id),
    duplicates_truncated: discarded.length > 20,
  })
  return true
}
