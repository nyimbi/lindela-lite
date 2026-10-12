/**
 * ARC-01 — the workflow-instance routes, out of the god function.
 *
 * The workflow instances a protocol or a rule opens — one collection with a
 * list form, a by-id form, a metrics view and a transition action, across
 * GET/POST.
 *
 * Two properties make this one family, and both are the kind of thing a "tidy"
 * pass breaks:
 *
 *   - **a transition records where the actor came from.** The state machine
 *     (`transitionWorkflow`, `src/workflows.js`) moves an instance between the
 *     states its type declares, and this handler is the only caller that has to
 *     decide *who* moved it. It prefers the authenticated subject and keeps the
 *     caller's own `body.actor` as a separate `claimed_actor` rather than
 *     promoting it — a caller must not be able to claim an identity, but the
 *     claim is a fact worth recording. The old code read
 *     `req.__auth?.subject || 'anonymous'`, so on an unauthenticated deployment
 *     every transition — including who approved an anticipatory alert — was
 *     logged as "anonymous" and a supplied actor was thrown away.
 *   - **the metrics view is computed and has no `data[...]` key.** `metrics` is
 *     a roll-up over `workflow_instances`, so a generic collection branch
 *     reaching it would read `undefined` and 500. The `route.action` guard is
 *     what carries the branch.
 *
 * A create and a transition each emit exactly one outbox event, so the event
 * cannot outlive the instance it announces.
 */

import { metrics } from '../observability.js'
import { emit } from '../outbox.js'
import { collectionPage, readRequestJson } from '../utils.js'
import { normalizeWorkflowInstance, transitionWorkflow, workflowMetrics } from '../workflows.js'

/**
 * Which workflow route a request is, or null.
 *
 * Pathname only: the collection, its detail, the metrics view and the
 * transition action differ by path rather than by verb, and the handler tests
 * the method. `check-openapi.mjs` reads the literals and the optional tail, so
 * both `/api/v1/workflows` and `/api/v1/workflows/:id` are visible to it.
 */
export function matchWorkflowRoute(pathname) {
  const transition = pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/transition$/)
  if (transition) return { id: decodeURIComponent(transition[1]), action: 'transition' }
  if (pathname === '/api/v1/workflows/metrics') return { action: 'metrics' }
  const match = pathname.match(/^\/api\/v1\/workflows(?:\/([^/]+))?$/)
  if (!match) return null
  return { id: match[1] ? decodeURIComponent(match[1]) : null }
}

/**
 * Handle one workflow route. Returns true when it handled the request.
 */
export async function handleWorkflowRoute(route, { store, data, req, res, url, jsonResponse }) {
  if (req.method === 'GET' && !route.id && !route.action) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.workflow_instances, url.searchParams, { auth: req.__auth, data, collection: 'workflow_instances' }) })
    return true
  }

  if (req.method === 'GET' && route.id && !route.action) {
    const record = data.workflow_instances.find((w) => w.id === route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  if (req.method === 'GET' && route.action === 'metrics') {
    const metrics = workflowMetrics(data.workflow_instances)
    jsonResponse(res, 200, { success: true, data: metrics })
    return true
  }

  if (req.method === 'POST' && !route.id && !route.action) {
    const body = await readRequestJson(req)
    const record = normalizeWorkflowInstance(body)
    const outboxRecord = await emit(store, 'workflow.created', { workflow_id: record.id, type: record.type }, {
      workflow_instances: [record],
    })
    metrics.counter('workflow_created', { type: record.type })
    jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
    return true
  }

  if (req.method === 'POST' && route.id && route.action === 'transition') {
    const existing = data.workflow_instances.find((w) => w.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Workflow not found' })
      return true
    }
    const body = await readRequestJson(req)
    try {
      // Attribution follows the convention used by actionLog: the authenticated
      // subject is authoritative when there is one, and the caller's own stated
      // actor is kept separately rather than discarded. This previously read
      // `req.__auth?.subject || 'anonymous'`, so on an unauthenticated
      // deployment every transition — including who approved an anticipatory
      // alert — was recorded as "anonymous", and an actor the caller did supply
      // was thrown away. Preferring the verified subject is still correct: a
      // caller must not be able to claim an identity. The claim is recorded as a
      // claim, not promoted to authenticated.
      const claimedActor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : null
      const updated = transitionWorkflow(existing, {
        to: body.to,
        actor: req.__auth?.subject || claimedActor || 'anonymous',
        actor_source: req.__auth?.subject ? 'authenticated' : (claimedActor ? 'claimed' : 'unattributed'),
        claimed_actor: claimedActor,
        reason: body.reason || '',
        evidence: body.evidence || '',
      })
      const outboxRecord = await emit(store, 'workflow.transitioned', {
        workflow_id: updated.id,
        type: updated.type,
        from: existing.state,
        to: updated.state,
      }, { workflow_instances: [updated] })
      metrics.counter('workflow_transition_total', { type: updated.type, from: existing.state, to: updated.state })
      jsonResponse(res, 200, { success: true, data: updated, outbox_event: outboxRecord.id })
      return true
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
      return true
    }
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
