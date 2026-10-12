/**
 * ENH-60 — the outbox family: the queue's own listing, and the operator's
 * "deliver it now".
 *
 * Two routes over one collection, and the pair is a family because they are the
 * two halves of the same question. `GET /api/v1/outbox` is what is waiting;
 * `POST /api/v1/outbox/dispatch` is the instruction to stop waiting. A route
 * that listed the queue without a way to drain it, or drained it without a way
 * to see what was pending, would each be half a feature.
 *
 * ## Why the dispatch route is not the driver's item
 *
 * The scheduled tick runs `dispatchPending` from `DRIVER_ITEMS` with no
 * arguments — it reads the store and the registry itself. This route passes
 * `maxBatch` and `timeoutMs` because it is a *caller* waiting on the answer: an
 * operator who asked for a drain needs the request to finish, so the batch is
 * bounded by the request's own budget rather than by the tick's. The two call
 * sites are not duplication; they are the same function under two deadlines,
 * and the driver's unbounded run is the one that may take as long as it needs.
 *
 * ## The listing is not filtered, and that is deliberate
 *
 * Every other collection list in the surface drops soft-deleted rows. The
 * outbox is a queue, and its rows are never deleted: `outboxRollup` counts
 * `pending`, `sent` and `failed`, and `failed` is terminal — a permanently
 * failing integration stays in the list as the record of what stopped getting
 * through. Filtering here would take the one surface that shows a dead-letter
 * row and hide it, which is the gap R-47 was opened to close.
 */

import { dispatchPending } from '../outbox.js'
import { collectionPage, readRequestJson } from '../utils.js'

/**
 * Which outbox route a request is, or null.
 *
 * Pathname and method together, because the two paths are a collection and an
 * action rather than a collection and its detail: `/outbox/dispatch` is not
 * "the dispatch with id `dispatch`", it is the verb. Returning null for a
 * non-matching method is what lets an undeclared verb fall through to the
 * dispatcher's 404 instead of being served by a branch that ignored the method
 * — the class `scripts/check-route-methods.mjs` exists to catch.
 */
export function matchOutboxRoute(pathname, method) {
  const verb = String(method || 'GET').toUpperCase()
  if (pathname === '/api/v1/outbox' && verb === 'GET') return { kind: 'list' }
  if (pathname === '/api/v1/outbox/dispatch' && verb === 'POST') return { kind: 'dispatch' }
  return null
}

/**
 * Handle one outbox route. Returns true when it handled the request.
 */
export async function handleOutboxRoute(route, { store, data, req, res, url, jsonResponse }) {
  if (route.kind === 'list') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(data.events_outbox || [], url.searchParams, { auth: req.__auth, data, collection: 'events_outbox' }),
    })
    return true
  }

  if (route.kind === 'dispatch') {
    // The body is drained and discarded, as it was inline: a client may send
    // one, and a request whose body is never read holds its socket open.
    await readRequestJson(req)
    // The subscriptions to deliver to, read from the snapshot the request began
    // from rather than re-read here — the same reason every other handler in
    // this surface takes `data`: a second read inside a request is a second
    // view of the store, and the outbox's dedup discipline depends on the
    // pending set and the webhook set coming from one read.
    const webhooks = data.webhook_subscriptions || []
    // `maxBatch` and `timeoutMs` are fixed here rather than taken from the
    // body: the operator's drain is bounded so a queue of thousands is drained
    // across several calls rather than in one request that outlives its client.
    // The scheduled tick calls the same function with no arguments at all.
    const result = await dispatchPending(store, { webhooks, maxBatch: 50, timeoutMs: 5000 })
    jsonResponse(res, 201, { success: true, ...result })
    return true
  }

  return false
}
