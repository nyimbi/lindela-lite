/**
 * ENH-74 — the annotation routes, and the collection the module asked for.
 *
 * `src/annotations.js` was complete, tested, and reached by nothing. It says why
 * in its own header: an annotation is a person's words attached to a record, and
 * a module that builds them is a library until a route stores them. This is that
 * route, and it is also the pair of declarations the module names as its
 * requirement — `annotations` in `COLLECTIONS` (`src/store.js`) and
 * `annotations: []` in `emptyStore()` (`src/schema.js`). Both, together, because
 * `JsonStore.merge` keys strictly off `COLLECTIONS` and drops an unlisted
 * collection silently while `read()` spreads `emptyStore()`'s default under a
 * parsed file: a name in one list and not the other is a defect in whichever
 * direction it appears.
 *
 * ## The identity is the token's, never the body's
 *
 * `buildAnnotation` takes an author and refuses without one. The author is
 * `actorFor(req)` — the token fingerprint `src/audit-chain.js` derives — and the
 * body's own `actor`/`author` is read only when no token subject exists. That
 * order is the whole of the module's provenance claim: `connector_id` names who
 * said it, and a client that could name itself could attribute its words to
 * somebody else. It is also why `actorFor` is called here rather than handed to
 * the module: a second implementation of identity beside the first is how two
 * answers to "who acted" appear.
 *
 * ## One merge per write, so the event cannot outlive the record
 *
 * Every write goes through `emit`, the R-22 rule the field-signal family states:
 * one merge carries the annotation and the action log beside it, so an outbox
 * event cannot announce a record that was never written. An edit is two records
 * — the closed version and the opened one — and both land in one merge for the
 * same reason.
 *
 * ## What the read returns
 *
 * `GET /api/v1/annotations` is paged on the collection and carries the thread
 * structure beside the page: `thread` is the depth-first walk with each
 * annotation's `depth`, and `summary` is `threadSummary`'s counts. Both are
 * computed over the *whole* matched set rather than the page — the property that
 * holds this family together, and the one `/disease-observations` had already
 * got wrong once by computing its series states over `filterRecords`' page.
 *
 * `?record_id=` scopes the read to one record's thread. It is the filter the
 * route exists for: an annotation without a record is a comment in a void, and
 * `buildAnnotation` refuses one.
 *
 * ## Refusals are the module's, and they arrive as statuses
 *
 * `buildAnnotation`, `editAnnotation` and `retractAnnotation` throw objects
 * carrying `statusCode` and `code` (a missing parent is a 404, an edit to a
 * retracted annotation a 409). The handler does not re-derive any of them — it
 * reads `err.statusCode` and lets the module decide, because a second copy of
 * the rule here would be a copy that drifts from the one the tests exercise.
 */

import { actorFor } from '../audit-chain.js'
import {
  ANNOTATION_RETRIEVAL_URL,
  buildAnnotation,
  buildThread,
  editAnnotation,
  flattenThread,
  liveAnnotations,
  retractAnnotation,
  threadSummary,
  versionsOf,
} from '../annotations.js'
import { actionLog } from '../operations.js'
import { emit } from '../outbox.js'
import { matchedAndPage, readRequestJson } from '../utils.js'

/** The route an annotation is recorded against when the request names none. */
export { ANNOTATION_RETRIEVAL_URL }

/**
 * Which annotation route a request is, or null.
 *
 * Method-aware: the collection path serves a GET and a POST with different
 * handlers, and the two by-id paths serve a PATCH and a DELETE. The paths are
 * spelled as `pathname === '…'` literals and regex literals in this function
 * because `scripts/route-surface.mjs` reads the served surface out of this
 * matcher's own body — an assembled path is a route no check can see.
 */
export function matchAnnotationRoute(pathname, method = 'GET') {
  const verb = String(method).toUpperCase()
  if (pathname === '/api/v1/annotations' && verb === 'GET') return { kind: 'list' }
  if (pathname === '/api/v1/annotations' && verb === 'POST') return { kind: 'create' }
  if (verb === 'GET') {
    const history = pathname.match(/^\/api\/v1\/annotations\/([^/]+)\/versions$/)
    if (history) return { kind: 'versions', id: decodeURIComponent(history[1]) }
    const thread = pathname.match(/^\/api\/v1\/annotations\/record\/([^/]+)$/)
    if (thread) return { kind: 'record-thread', record_id: decodeURIComponent(thread[1]) }
  }
  if (verb === 'PATCH') {
    const edit = pathname.match(/^\/api\/v1\/annotations\/([^/]+)$/)
    if (edit) return { kind: 'edit', id: decodeURIComponent(edit[1]) }
  }
  if (verb === 'DELETE') {
    const retract = pathname.match(/^\/api\/v1\/annotations\/([^/]+)$/)
    if (retract) return { kind: 'retract', id: decodeURIComponent(retract[1]) }
  }
  return null
}

/**
 * The author of a write: the token's subject, or the body's own actor.
 *
 * `actorFor` is the repo's one identity resolution and it is called on the
 * request, so `req.__auth.subject` wins over anything the body carries. The
 * `unattributed` flag is not reported here — it belongs to the audit chain's own
 * envelope — but the resolved string is what the annotation's `connector_id`
 * becomes, and that is the field the provenance claim rests on.
 *
 * `anonymous` is `actorFor`'s placeholder for "found nothing at all", and it is
 * the right answer for an audit row: an unattributed action is better than an
 * unactioned one. It is the wrong answer here, and returning it would be the
 * route laundering the one case the module refuses. `buildAnnotation` refuses an
 * annotation with no author because an unattributed claim is what provenance
 * exists to prevent, and handing it the string `anonymous` would store exactly
 * that claim under a name nobody signed. So the placeholder is turned back into
 * an absence and the module refuses — which is a 400 the caller can act on
 * rather than a row attributed to a person who does not exist.
 */
function authorFor(req, body) {
  const { actor, unattributed } = actorFor({ auth: req?.__auth, actor: body?.actor ?? body?.author ?? null })
  if (unattributed && actor === 'anonymous') return undefined
  return actor
}

/** The provenance `retrieval_url` for a request: its own path, not a constant. */
function retrievalUrlFor(url) {
  return url?.pathname || ANNOTATION_RETRIEVAL_URL
}

/** A refusal the module raised, sent with the status and code it named. */
function sendRefusal(res, jsonResponse, err) {
  jsonResponse(res, err.statusCode || 400, {
    success: false,
    error: err.message,
    code: err.code || undefined,
  })
}

/**
 * Handle one annotation route. Returns true when it handled the request.
 */
export async function handleAnnotationRoute(route, { store, data, req, res, url, jsonResponse }) {
  const { kind } = route
  const all = data.annotations || []

  if (kind === 'list') {
    // The thread is computed over the matched set, not the page. `matchedAndPage`
    // returns both halves from one scan; calling `filterRecords` twice would be a
    // second scan that could disagree with the first.
    const scoped = url.searchParams.get('record_id')
    const records = scoped === null ? all : all.filter((a) => a.record_id === scoped)
    const { matched, ...page } = matchedAndPage(records, url.searchParams, { auth: req.__auth, data, collection: 'annotations' })
    const thread = flattenThread(matched)
    jsonResponse(res, 200, {
      success: true,
      ...page,
      record_id: scoped,
      thread,
      summary: threadSummary(matched, { recordId: scoped ?? undefined }),
    })
    return true
  }

  if (kind === 'record-thread') {
    // A record's whole conversation in one read, which is what a record panel
    // asks for. `buildThread` nests the replies; `summary` counts them.
    //
    // No page, and no limit applied — `check-route-envelopes` carries the reason
    // for this route in `ARRAY_IS_COMPLETE`: a paged thread is not a thread. The
    // read is bounded by the record rather than by a page size, and a panel that
    // showed the first 500 replies and said nothing about the rest would be the
    // roll-up-over-the-page failure one layer out. `summary.live` is the count,
    // so a caller can still see how much it is holding.
    const recordId = route.record_id
    const scoped = all.filter((a) => a.record_id === recordId)
    jsonResponse(res, 200, {
      success: true,
      record_id: recordId,
      data: liveAnnotations(scoped),
      thread: buildThread(scoped),
      summary: threadSummary(scoped, { recordId }),
      note: 'Live versions only: an edited annotation is one row per version, and the superseded text is readable at /api/v1/annotations/{id}/versions.',
    })
    return true
  }

  if (kind === 'versions') {
    // The whole chain, oldest first, also unpaged for the reason above: a
    // version chain read in pages cannot be read as a correction history.
    const chain = versionsOf(all, route.id)
    if (!chain.length) {
      jsonResponse(res, 404, { success: false, error: `annotation ${route.id} does not exist`, code: 'not_found' })
      return true
    }
    jsonResponse(res, 200, { success: true, annotation_id: route.id, data: chain, count: chain.length })
    return true
  }

  if (kind === 'create') {
    const body = await readRequestJson(req)
    let annotation
    try {
      annotation = buildAnnotation(
        { ...body, actor: authorFor(req, body) },
        { annotations: all, retrievalUrl: retrievalUrlFor(url) },
      )
    } catch (err) {
      sendRefusal(res, jsonResponse, err)
      return true
    }
    const log = actionLog('annotations', 'created', annotation, annotation.author, req.__auth?.subject)
    const outboxRecord = await emit(store, 'annotation.created', { annotation_id: annotation.id, record_id: annotation.record_id }, {
      annotations: [annotation],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: annotation, outbox_event: outboxRecord.id })
    return true
  }

  if (kind === 'edit') {
    const body = await readRequestJson(req)
    const previous = all.find((a) => a.id === route.id)
    if (!previous) {
      jsonResponse(res, 404, { success: false, error: `annotation ${route.id} does not exist`, code: 'not_found' })
      return true
    }
    let closed
    let current
    try {
      ({ previous: closed, current } = editAnnotation(previous, body, { annotations: all }))
    } catch (err) {
      sendRefusal(res, jsonResponse, err)
      return true
    }
    // Two records, one merge: the closed version and the opened one land
    // together, so a reader can never see the chain with a hole in it.
    const log = actionLog('annotations', 'edited', current, authorFor(req, body), req.__auth?.subject)
    const outboxRecord = await emit(store, 'annotation.edited', { annotation_id: current.id, supersedes: closed.id }, {
      annotations: [closed, current],
      action_logs: [log],
    })
    jsonResponse(res, 200, { success: true, data: current, superseded: closed, outbox_event: outboxRecord.id })
    return true
  }

  if (kind === 'retract') {
    const body = await readRequestJson(req)
    const target = all.find((a) => a.id === route.id)
    if (!target) {
      jsonResponse(res, 404, { success: false, error: `annotation ${route.id} does not exist`, code: 'not_found' })
      return true
    }
    let retracted
    try {
      retracted = retractAnnotation(target, { by: authorFor(req, body) })
    } catch (err) {
      sendRefusal(res, jsonResponse, err)
      return true
    }
    // The body stays. ADR-007's soft delete: the row is stamped so a read
    // presents it as withdrawn, and the replies pointing at it stay resolvable.
    const log = actionLog('annotations', 'retracted', retracted, retracted.retracted_by, req.__auth?.subject)
    const outboxRecord = await emit(store, 'annotation.retracted', { annotation_id: retracted.id, record_id: retracted.record_id }, {
      annotations: [retracted],
      action_logs: [log],
    })
    jsonResponse(res, 200, { success: true, data: retracted, outbox_event: outboxRecord.id })
    return true
  }

  return false
}
