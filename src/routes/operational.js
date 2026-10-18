/**
 * ARC-01 — the operational CRUD family, out of the god function.
 *
 * The seven collection routes the field app lives on: incidents, interventions,
 * tasks, field reports, response resources, action logs and service assets,
 * each in list form and by-id, across GET/POST/PATCH/DELETE. One family because
 * they share one matcher, one set of builders and one soft-delete discipline.
 *
 * The thing that had to survive the move is the pair of asymmetries, because
 * each one is a decision someone made on purpose and each is easy to "tidy"
 * into a bug:
 *
 *   - `include_deleted` is honoured on the read branches and *ignored* on the
 *     writes. A PATCH has to see the soft-deleted record to answer 409 rather
 *     than 404 — the record exists, the caller may not change it, and those are
 *     different answers. A write that cannot see the deleted row reports "not
 *     found" for something that is plainly there.
 *   - `action_logs` is read-only. It is served like a collection, so a POST or
 *     a PATCH reaches the same branch as any other and is refused with 405 and
 *     `READ_ONLY`, rather than being quietly accepted into an audit trail the
 *     system writes itself.
 *   - `service_assets` is readable by id but *not* writable here. It is in the
 *     matcher because a caller holding an asset id — the subject panel, the
 *     routing endpoint's own error text — had no way to resolve one record. But
 *     the collection is written by the ingestion path (`POST
 *     /api/v1/service-assets`), and the builders that back this family's three
 *     write verbs know nothing about it. Without the guard below, a by-id PATCH
 *     or DELETE fell through to `buildUpdate` and died on a bare `Error`, so a
 *     documented GET-only path answered 500 to a verb it never claimed.
 *
 * VUL-03 lives here too: every by-id read goes through `findVisible`, which
 * carries the partner-organisation predicate. The list form and the by-id form
 * must agree, and the earlier fix reached only one branch of the two.
 */

import { refreshAnalytics } from '../analytics.js'
import { runIngestion } from '../ingestion.js'
import { WRITABLE_COLLECTIONS, actionLog, buildCreate, buildSoftDelete, buildUpdate, isDeleted } from '../operations.js'
import { loadPolicy, redactPii } from '../pii.js'
import { ERROR_CODES } from '../errors.js'
import { logger, metrics } from '../observability.js'
import { emit } from '../outbox.js'
import { collectionPage, readRequestJson } from '../utils.js'
import { findVisible } from '../visibility.js'

/**
 * Which operational collection a request is, or null.
 *
 * The path segment names the *URL*, the value names the *store collection*, and
 * they differ for four of the seven — `tasks` is stored as `intervention_tasks`,
 * `field-reports` as `field_reports`. The map is the only place that translation
 * is stated.
 */
export function matchOperationalRoute(pathname) {
  const routes = {
    incidents: 'incidents',
    interventions: 'interventions',
    tasks: 'intervention_tasks',
    'field-reports': 'field_reports',
    'response-resources': 'response_resources',
    'action-logs': 'action_logs',
    // Absent here, so `GET /api/v1/service-assets/<id>` matched nothing and
    // 404'd while the collection itself served fine. A caller holding an asset
    // id — the subject panel, the routing endpoint's own error message — had no
    // way to resolve one record.
    'service-assets': 'service_assets',
  }
  const match = pathname.match(/^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/)
  if (!match || !routes[match[1]]) return null
  return { collection: routes[match[1]], id: match[2] ? decodeURIComponent(match[2]) : null }
}

/**
 * Handle one operational route. Returns true when it handled the request.
 */
export async function handleOperationalRoute(route, { data, req, res, url, jsonResponse, store }) {
  const includeDeleted = url.searchParams.get('include_deleted') === 'true'

  if (req.method === 'GET' && !route.id) {
    const records = includeDeleted ? data[route.collection] : data[route.collection].filter((item) => !isDeleted(item))
    jsonResponse(res, 200, { success: true, ...collectionPage(records, url.searchParams, { data, collection: route.collection }) })
    return true
  }

  if (req.method === 'GET' && route.id) {
    // Through `findVisible`, so a by-id read carries the same
    // partner-organisation predicate as the list form. This branch was the one
    // the earlier fix reached; VUL-03 is the other thirty.
    const record = findVisible(data[route.collection], route.id, { includeDeleted })
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  // The one write this family serves that its builders cannot perform, and it is
  // here rather than in the dispatcher because the dispatcher was the second
  // place the path was written down. `GET /api/v1/service-assets` was served by
  // an inline block *above* this family's dispatch, so the family's list branch
  // was dead code for the life of the extraction — and the inline copy had
  // dropped `?include_deleted=true`, which every sibling list honours. The
  // import verb was the other half of the same duplication.
  //
  // So both halves are one route in one place now. The refusal below still names
  // `POST /api/v1/service-assets` as where the collection is written; that
  // sentence is now this branch rather than a route somewhere else.
  if (req.method === 'POST' && route.collection === 'service_assets' && !route.id) {
    // `sources: ['service_assets']` is forced rather than taken from the body:
    // this route imports assets and nothing else, so a caller cannot use it to
    // trigger the nine public connectors.
    const body = await readRequestJson(req)
    const ingestion = await runIngestion(store, { ...body, sources: ['service_assets'] })
    const run = ingestion.source_runs[0]
    if (run.errors.length) {
      jsonResponse(res, 400, { success: false, error: 'Invalid service asset input', errors: run.errors, accepted: ingestion.counts.service_assets })
      return true
    }
    const analytics = await refreshAnalytics(store)
    jsonResponse(res, 201, {
      success: true,
      imported: ingestion.counts.service_assets,
      source_run: run,
      analytics: {
        risk_scores: analytics.risk_scores.length,
        impact_assessments: analytics.impact_assessments.length,
        data_quality: analytics.data_quality.length,
      },
    })
    return true
  }

  // The two refusals this family owes a write verb, in one place and in this
  // order. Both are checked before any body is read, because a refusal must not
  // depend on the request being well-formed.
  //
  // `action_logs` first: it is served like a collection and is the system's own
  // audit trail, so it answers `READ_ONLY` rather than `METHOD_NOT_ALLOWED` —
  // the collection is readable, the verb is what the system reserves for itself.
  // It is not in `WRITABLE_COLLECTIONS` either, so the order is load-bearing.
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only', code: ERROR_CODES.READ_ONLY })
      return true
    }
    // A collection the matcher serves but the builders cannot write.
    // `service_assets` is readable by id — the subject panel and the routing
    // endpoint's own error text both hold an id — but it is written by the
    // ingestion path (`POST /api/v1/service-assets`), not one record at a time.
    // Without this, a by-id PATCH or DELETE fell through to a normaliser that
    // knows five collections and died on a bare `Error`, so a path OpenAPI
    // documents as GET-only answered 500 to a verb it never claimed.
    //
    // The path in the message is derived rather than written out, so the refusal
    // stays true for the next collection that is readable before it is writable
    // — the same reason `WRITABLE_COLLECTIONS` is derived from the builders'
    // table rather than listed here.
    if (!WRITABLE_COLLECTIONS.has(route.collection)) {
      jsonResponse(res, 405, {
        success: false,
        error: `${route.collection} is written by its import route (POST /api/v1/${route.collection.replace(/_/g, '-')}), not one record at a time`,
        code: ERROR_CODES.METHOD_NOT_ALLOWED,
      })
      return true
    }
  }

  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    // The third door into `field_reports`, and until now the only one with no
    // redactor behind it. `src/routes/rapidpro.js` and `src/routes/chw.js` both
    // call `redactPii` on the record they are about to store; this path built
    // one with `buildCreate` and stored it, so `POST /api/v1/field-reports` with
    // `reported_by: "Amina Nakuru"` wrote that name in cleartext where
    // `redactPii` hashes exactly that field. Tested through the live ingress.
    //
    // Redacted *after* the build, not before, so the field is the one the
    // builder produces: `normalizeFieldReport` defaults `reported_by` to the
    // literal `'operator'` when the caller sends none, and redacting the input
    // would leave that system label in cleartext while a caller-supplied name
    // was hashed — two shapes in one column, decided by whether the field was
    // sent. Hashing the constant costs nothing; a distinct-reporter count over
    // the column is unchanged, because a constant hashed is still one value.
    //
    // This is `src/operations.js:323`'s own argument — "a gate at one of two
    // doors is not a gate" — applied to PII rather than to the quality verdict.
    const record = redactPii(buildCreate(route.collection, body, data), await loadPolicy())
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    if (route.collection === 'incidents') {
      try {
        await emit(store, 'incident.created', record)
      } catch (emitError) {
        // Counted and logged, not swallowed — see the alert_rule path above for
        // why this direction of the gap is the survivable one.
        metrics.counter('outbox_emit_failed_total', { event: 'incident.created' })
        logger.error('outbox_emit_failed', {
          outbox_event: 'incident.created',
          message: 'outbox emit failed; the incident is stored and no subscriber was told',
          err: { message: emitError.message, stack: emitError.stack },
        })
      }
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    // `includeDeleted` unconditionally here, unlike the read branch. A write
    // has to see the soft-deleted record to answer 409 rather than 404: the
    // record exists, the caller may not change it, and those are different
    // answers. Whether a caller may mutate a record is a separate question from
    // whether it may read one, and the partner predicate still applies either
    // way — `findVisible` is what carries it.
    const existing = findVisible(data[route.collection], route.id, { includeDeleted: true })
    if (isDeleted(existing)) {
      jsonResponse(res, 409, { success: false, error: 'Record is deleted', code: ERROR_CODES.RECORD_DELETED })
      return true
    }
    // PRIV-03. The POST branch above redacts and this one did not, so the same
    // path held a gate at one of two doors: `POST /api/v1/field-reports` hashed
    // a caller-supplied `reported_by`, and `PATCH /api/v1/field-reports/:id`
    // with the same field wrote the name in cleartext. Both branches reach the
    // same builders over the same collection, so the choice was never about the
    // verb — it was about which branch someone remembered.
    //
    // Redacting the built record rather than the patch is what keeps the two
    // doors agreeing: `buildUpdate` merges the patch over the existing row, and
    // redacting only the patch would leave an untouched `reported_by` from a
    // previous unredacted write in place. `redactPii` is idempotent on its own
    // output (`src/pii.js`'s `PSEUDONYM_RE`), so a record that already carries a
    // pseudonym keeps it instead of acquiring a second one for the same person.
    const record = redactPii(buildUpdate(route.collection, existing, { ...body, id: route.id }, data), await loadPolicy())
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'DELETE' && route.id) {
    const body = await readRequestJson(req)
    // Same reason as PATCH above: a second DELETE answers 409, which needs the
    // already-deleted record in hand.
    const existing = findVisible(data[route.collection], route.id, { includeDeleted: true })
    const record = buildSoftDelete(route.collection, existing, body.actor || req.__auth?.subject, data)
    const log = actionLog(route.collection, 'deleted', record, body.actor || req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
