/**
 * ARC-01 — the webhook-subscription family, out of the god function.
 *
 * One collection with a list form and a by-id form, across GET/POST/PATCH — the
 * smallest family in the surface, and it is a family because it is the only
 * place a caller *registers a destination the platform will later fetch*.
 *
 * That is the property, and it is why the four branches belong in one module
 * rather than beside the outbox that delivers them:
 *
 *   - **the id resolves through `findVisible`.** VUL-03 lived in the by-id
 *     branches, and this collection's by-id read is the one that leaks a
 *     *subscription* — the URL and the secret an organisation delivers to. The
 *     list form was scoped and the by-id form was not; both now go through the
 *     one resolver, so a partner token cannot read another organisation's
 *     webhook by guessing an id it saw in a listing.
 *   - **the URL is checked at registration, not only at delivery.** The guard
 *     lives in `normalizeWebhookSubscription` (`src/webhooks.js`), which every
 *     write branch here calls, so a subscriber cannot register a target that
 *     reaches the platform's own network and have it stored. The delivery path
 *     re-checks because DNS can change between the two; this side is what stops
 *     the bad URL existing at all.
 *
 * `matchWebhookRoute` reads the pathname only, and matches the collection and
 * its detail segment with one optional tail so `/api/v1/webhooks` and
 * `/api/v1/webhooks/:id` are one matcher rather than two literals.
 */

import { actionLog } from '../operations.js'
import { collectionPage, readRequestJson } from '../utils.js'
import { findVisible } from '../visibility.js'
import { normalizeWebhookSubscription } from '../webhooks.js'

/**
 * Which webhook route a request is, or null.
 *
 * Pathname only: the collection serves a list on GET and a create on POST, and
 * the detail serves a read and a patch — one path, four verbs, and the handler
 * tests the verb. `check-openapi.mjs` reads the `.match(/…/)` below, and the
 * optional tail is what makes the detail path visible to it as well as the bare
 * collection.
 */
export function matchWebhookRoute(pathname) {
  const match = pathname.match(/^\/api\/v1\/webhooks(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

/**
 * Handle one webhook-subscription route. Returns true when it handled the
 * request.
 */
export async function handleWebhookRoute(route, { store, data, req, res, url, jsonResponse }) {
  if (req.method === 'GET' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.webhook_subscriptions || [], url.searchParams, { auth: req.__auth, data, collection: 'webhook_subscriptions' }) })
    return true
  }

  if (req.method === 'GET' && route.id) {
    // Through `findVisible`, so the by-id read carries the same
    // partner-organisation predicate as the listing beside it. A subscription
    // names a URL and a secret, so this is the branch where a missing predicate
    // is a disclosure rather than a scoping nicety.
    const record = findVisible(data.webhook_subscriptions, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  if (req.method === 'POST' && !route.id) {
    const body = await readRequestJson(req)
    try {
      const record = normalizeWebhookSubscription(body)
      const log = actionLog('webhook_subscriptions', 'created', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 201, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return true
  }

  if (req.method === 'PATCH' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.webhook_subscriptions, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Webhook subscription not found' })
      return true
    }
    try {
      const record = normalizeWebhookSubscription({ ...body, id: route.id }, existing)
      const log = actionLog('webhook_subscriptions', 'updated', record, body.actor, req.__auth?.subject)
      await store.merge({ webhook_subscriptions: [record], action_logs: [log] })
      jsonResponse(res, 200, { success: true, data: record, action_log: log })
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
    }
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
