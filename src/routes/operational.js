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
 *
 * VUL-03 lives here too: every by-id read goes through `findVisible`, which
 * carries the partner-organisation predicate. The list form and the by-id form
 * must agree, and the earlier fix reached only one branch of the two.
 */

import { actionLog, buildCreate, buildSoftDelete, buildUpdate, isDeleted } from '../operations.js'
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

  if (req.method === 'POST' && !route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only', code: ERROR_CODES.READ_ONLY })
      return true
    }
    const body = await readRequestJson(req)
    const record = buildCreate(route.collection, body, data)
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
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only', code: ERROR_CODES.READ_ONLY })
      return true
    }
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
    const record = buildUpdate(route.collection, existing, { ...body, id: route.id }, data)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'DELETE' && route.id) {
    if (route.collection === 'action_logs') {
      jsonResponse(res, 405, { success: false, error: 'Action logs are read-only', code: ERROR_CODES.READ_ONLY })
      return true
    }
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
