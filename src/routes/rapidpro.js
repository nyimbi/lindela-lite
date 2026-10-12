/**
 * ARC-01 — the RapidPro routes, out of the god function.
 *
 * The two-way SMS surface: status and response metrics, the dispatch and inbound
 * logs, the alert-send action, and the two webhook doors a field device posts
 * through. They are a family because every one of them is a *view onto the SMS
 * channel* — the same dispatch/inbound pair read five ways and written two — and
 * because the two writes share a threat model the reads do not.
 *
 * The properties this module exists to hold, each of which was a bug once:
 *
 *   - **the signature is verified before the body is trusted.** Both POST doors
 *     call `verifyRapidProWebhook` first, and the field-report door reads the raw
 *     body so the signature is checked over the bytes that arrived rather than
 *     over a re-serialisation. A reply that can close an SLA is
 *     attacker-controlled input; the webhook secret is what makes it not.
 *   - **a reply is correlated by sender within a window, never by a payload
 *     field.** `parseRapidProReply` matches on the sender address and a bounded
 *     window; a payload-supplied `alert_event_id` is not trusted to name the
 *     alert it claims to answer.
 *   - **an uncorrelated reply is recorded, not dropped.** An unrecognised sender
 *     is what a wrong number looks like, and it is information — dropping it
 *     makes the gap invisible. It is redacted and stored as `reply_unmatched`.
 *   - **the PII policy is loaded where it is used.** The reply branch's
 *     `process.env.RAPIDPRO_REPLY_WINDOW_MINUTES` and its own `loadPolicy()`
 *     read are the fix for a route that threw `ReferenceError` on every request
 *     — a bare `env` that was never bound, and a `policy` borrowed from the
 *     field-report branch's block scope. Both are why this route answered 500
 *     before parsing anything, and why no test noticed: nothing posted to it.
 *   - **the reply's writes are built by hand, not passed through.** The
 *     correlation returns a *descriptor* (`{ inbound, duplicate, applied,
 *     reason? }`), not a collection map; handing it to `store.merge` threw
 *     "Undeclared collections: inbound, duplicate, applied" on every reply.
 *     The writes are assembled here and the descriptor decides only whether the
 *     reply is new.
 *   - **a correlated `DONE` writes the inbound and the outcome in one merge.**
 *     Two writes would let the confirmation be recorded without the outcome,
 *     leaving warning-to-action permanently short while the reply log claims the
 *     responder replied.
 *
 * `matchRapidProRoute` reads the pathname only, and names every path as a literal
 * so the spec gate sees the whole surface.
 */

import { ERROR_CODES } from '../errors.js'
import { logger } from '../observability.js'
import { actionLog, buildCreate } from '../operations.js'
import { loadPolicy, redactPii } from '../pii.js'
import { collectionPage, readRawBody, readRequestJson, stableId } from '../utils.js'
import { findVisible } from '../visibility.js'
import { DONE_OUTCOME_CODES, normalizeFieldOutcome } from '../field-outcomes.js'
import {
  deliveryReport,
  dueEscalations,
  formatDeliveryReport,
  parseRapidProFieldReport,
  parseRapidProReply,
  rapidProStatus,
  reconcileInbound,
  responseMetrics,
  sendRapidProAlert,
  verifyRapidProWebhook,
} from '../rapidpro.js'

/**
 * Which RapidPro route a request is, or null.
 *
 * Pathname only. `check-openapi.mjs` reads the literals and the one
 * `.match(/…/)` below.
 */
export function matchRapidProRoute(pathname) {
  if (pathname === '/api/v1/rapidpro/status') return { kind: 'status' }
  if (pathname === '/api/v1/rapidpro/response-metrics') return { kind: 'response-metrics' }
  if (pathname === '/api/v1/rapidpro/dispatches') return { kind: 'dispatches' }
  if (pathname === '/api/v1/rapidpro/inbound') return { kind: 'inbound' }
  if (pathname === '/api/v1/rapidpro/field-report') return { kind: 'field-report' }
  // A reply to an alert is the other half of two-way SMS: without it a
  // dispatch is fire-and-forget and nobody knows whether the message landed
  // or was acted on.
  if (pathname === '/api/v1/rapidpro/reply') return { kind: 'rapidpro-reply' }
  if (pathname === '/api/v1/rapidpro/delivery') return { kind: 'delivery' }
  if (pathname === '/api/v1/rapidpro/escalations') return { kind: 'escalations' }
  const sendAlert = pathname.match(/^\/api\/v1\/rapidpro\/alert-events\/([^/]+)\/send$/)
  if (sendAlert) return { kind: 'send-alert', id: decodeURIComponent(sendAlert[1]) }
  return null
}

/**
 * Handle one RapidPro route. Returns true when it handled the request.
 */
export async function handleRapidProRoute(route, { store, data, req, res, url, jsonResponse }) {
  if (req.method === 'GET' && route.kind === 'status') {
    jsonResponse(res, 200, { success: true, data: rapidProStatus() })
    return true
  }

  if (req.method === 'GET' && route.kind === 'response-metrics') {
    jsonResponse(res, 200, { success: true, data: responseMetrics(data) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'dispatches') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.rapidpro_dispatches, url.searchParams, { auth: req.__auth, data, collection: 'rapidpro_dispatches' }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'inbound') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.rapidpro_inbound_messages, url.searchParams, { auth: req.__auth, data, collection: 'rapidpro_inbound_messages' }) })
    return true
  }

  if (req.method === 'POST' && route.kind === 'send-alert') {
    const body = await readRequestJson(req)
    const alert = findVisible(data.alert_events, route.id)
    if (!alert) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return true
    }
    const approvalState = alert.approval?.state || 'proposed'
    if (approvalState !== 'approved' && approvalState !== 'auto_approved') {
      jsonResponse(res, 409, { success: false, error: 'Alert not approved', current_state: approvalState, code: ERROR_CODES.INVALID_STATE })
      return true
    }
    const dispatch = await sendRapidProAlert(alert, body)
    const log = actionLog('rapidpro_dispatches', dispatch.status === 'sent' ? 'sent' : 'failed', dispatch, body.actor, req.__auth?.subject)
    await store.merge({ rapidpro_dispatches: [dispatch], action_logs: [log] })
    jsonResponse(res, dispatch.status === 'sent' ? 201 : 502, { success: dispatch.status === 'sent', data: dispatch, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'field-report') {
    req.rawBody = await readRawBody(req)
    if (!verifyRapidProWebhook(req)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook secret', code: ERROR_CODES.INVALID_SIGNATURE })
      return true
    }
    const payload = await readRequestJson(req)
    const parsed = parseRapidProFieldReport(payload, data)
    const policy = await loadPolicy()
    let incident = parsed.report.incident_id ? data.incidents.find((item) => item.id === parsed.report.incident_id) : null
    const writes = { rapidpro_inbound_messages: [redactPii(parsed.inbound, policy)], action_logs: [] }
    if (!incident && !parsed.report.intervention_id) {
      incident = buildCreate('incidents', parsed.fallbackIncident, data)
      parsed.report.incident_id = incident.id
      writes.incidents = [incident]
      writes.action_logs.push(actionLog('incidents', 'created', incident, 'rapidpro'))
    }
    const report = buildCreate('field_reports', redactPii(parsed.report, policy), { ...data, incidents: incident ? [...data.incidents, incident] : data.incidents })
    parsed.inbound.field_report_id = report.id
    parsed.inbound.incident_id = report.incident_id
    parsed.inbound.intervention_id = report.intervention_id
    writes.field_reports = [report]
    writes.rapidpro_inbound_messages = [redactPii(parsed.inbound, policy)]
    writes.action_logs.push(actionLog('field_reports', 'created', report, 'rapidpro'))
    await store.merge(writes)
    jsonResponse(res, 201, { success: true, data: report, inbound: writes.rapidpro_inbound_messages[0], incident_created: Boolean(writes.incidents?.length) })
    return true
  }

  // A reply is the acknowledgement half of two-way SMS. It sits behind the same
  // webhook verification as a field report: a reply that can close an SLA is
  // attacker-controlled input, so correlation is by sender address within a
  // bounded window, never by a payload-supplied alert_event_id.
  if (req.method === 'POST' && route.kind === 'rapidpro-reply') {
    if (!verifyRapidProWebhook(req)) {
      jsonResponse(res, 401, { success: false, error: 'Invalid webhook signature', code: ERROR_CODES.INVALID_SIGNATURE })
      return true
    }
    const body = await readRequestJson(req)
    const parsed = parseRapidProReply(body, data, {
      // `process.env`, like every other configuration read in this file.
      // This said bare `env`, which is not bound in this scope — so the whole
      // `/api/v1/rapidpro/reply` route threw a ReferenceError and answered 500
      // before parsing anything. Nothing caught it because no test posted to
      // this route: the Phase E end-to-end cases are the first thing to reach
      // this line, which is how an unrunnable endpoint survived.
      correlationWindowMinutes: Number(process.env.RAPIDPRO_REPLY_WINDOW_MINUTES || 1440),
    })
    if (!parsed.correlated) {
      // Recorded anyway. An unrecognised sender is information — it is what a
      // wrong number looks like — and dropping it makes the gap invisible.
      //
      // `policy` is loaded here rather than reusing the `field-report` branch's
      // binding: that `const` is scoped to its own block, so the reference below
      // was a ReferenceError — the second half of why this route 500'd on every
      // request. A PII policy is also not a thing to share across two unrelated
      // branches by accident; loading it where it is used is both correct and
      // what makes the scope obvious.
      const policy = await loadPolicy()
      const orphan = redactPii({
        id: stableId('inbound', ['orphan', body.from, body.text, Date.now()]),
        text: body.text || '',
        contact_urn: body.from || '',
        event_type: 'reply_unmatched',
        created_at: new Date().toISOString(),
      }, policy)
      await store.merge({
        rapidpro_inbound_messages: [orphan],
        action_logs: [actionLog('rapidpro_inbound_messages', 'created', orphan, 'rapidpro', req.__auth?.subject)],
      })
      jsonResponse(res, 202, {
        success: true,
        correlated: false,
        recorded: orphan.id,
        reason: parsed.reason || 'no dispatch from this sender in the correlation window',
      })
      return true
    }
    // `reconcileInbound` returns a DESCRIPTOR, not a collection map —
    // `{ inbound, duplicate, applied, reason? }`. Passing that to `store.merge` as
    // if the keys were collection names is what the previous line did, and it threw
    // "Undeclared collections: inbound, duplicate, applied" on every reply. Records
    // for an undeclared collection are dropped silently by design, which is why this
    // surfaced as an error rather than as a missing write: the guard caught it.
    //
    // So the writes are built here, and the descriptor is used for what it is: the
    // decision about whether this reply is new.
    const reconciled = reconcileInbound(data, parsed)
    const writes = reconciled.applied
      ? {
          rapidpro_inbound_messages: [reconciled.inbound],
          action_logs: [actionLog('rapidpro_inbound_messages', 'created', reconciled.inbound, 'rapidpro', req.__auth?.subject)],
        }
      : {}

    // A correlated `DONE` is the only thing in this system that is evidence a
    // person acted on the ground, so it writes a `field_outcomes` row as well as
    // the inbound — and in the SAME merge, because two writes would let the
    // confirmation be recorded without the outcome, leaving warning-to-action
    // permanently short while the reply log claims the responder replied.
    //
    // An UNCORRELATED `DONE` is an orphan inbound only, exactly as every other
    // unrecognised reply is: it closes no SLA, confirms no outcome, and its
    // sender cannot be attributed to an alert, so there is nothing to time it
    // against. That is the case handled by the branch above.
    let fieldOutcome = null
    if (parsed.verb === 'DONE') {
      // Only a code the outcome set recognises becomes an outcome. A `DONE` with
      // no code, or with prose where a code was expected, is still a real
      // confirmation and still stays in the inbound — but recording it under an
      // invented `other` would manufacture the very aggregation the closed set
      // exists to keep honest. It is refused here and stays visible as a reply.
      if (!DONE_OUTCOME_CODES.has(parsed.reason_code)) {
        writes.field_outcomes = []
      } else {
        const now = new Date().toISOString()
        const linkedAlert = (data.alert_events || []).find((alert) => alert.id === parsed.alert_event_id) || null
        // The playbook-created intervention, where the alert has one: the
        // confirmation is about an intervention having been carried out, so the
        // link is the difference between "someone said done" and "the action we
        // opened a ticket for was done".
        const linkedIntervention = linkedAlert?.metadata?.protocol_id
          ? (data.interventions || []).find((i) => i.alert_id === linkedAlert.id || i.incident_id === linkedAlert.incident_id) || null
          : null
        try {
          fieldOutcome = normalizeFieldOutcome({
            alert_id: parsed.alert_event_id,
            dispatch_id: parsed.dispatch_id,
            intervention_id: linkedIntervention?.id ?? null,
            outcome_code: parsed.reason_code,
            note: parsed.note,
            confirmed_by: parsed.from,
            confirmed_at: now,
            channel: parsed.channel,
            source: 'rapidpro_reply',
          })
        } catch (outcomeError) {
          // The inbound is already built and valid; a confirmation we cannot
          // categorise must not cost us the reply itself. Refused rather than
          // thrown, and the reason travels in the response so it is not a
          // silent gap.
          fieldOutcome = null
          logger.error('field_outcome_write_failed', {
            alert_event_id: parsed.alert_event_id,
            message: 'DONE reply could not be recorded as a field outcome; the inbound is kept',
            err: { message: outcomeError.message, stack: outcomeError.stack },
          })
        }
        if (fieldOutcome) {
          writes.field_outcomes = [fieldOutcome]
          writes.action_logs = [
            ...(writes.action_logs || []),
            actionLog('field_outcomes', 'created', fieldOutcome, 'rapidpro', req.__auth?.subject),
          ]
        }
      }
    }

    await store.merge(writes)
    jsonResponse(res, 200, {
      success: true,
      correlated: true,
      ...parsed,
      // Named explicitly rather than buried in the spread: a caller confirming a
      // delivery needs to know whether it became a field outcome, and
      // "the reply was processed" is not the same answer.
      field_outcome_id: fieldOutcome?.id ?? null,
      field_outcome: fieldOutcome ? 'recorded' : (parsed.verb === 'DONE' ? 'refused: no recognised outcome code' : null),
    })
    return true
  }

  if (req.method === 'GET' && route.kind === 'delivery') {
    const report = deliveryReport(data, {
      alertEventId: url.searchParams.get('alert_event_id') || undefined,
    })
    jsonResponse(res, 200, { success: true, ...report, summary: formatDeliveryReport(report) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'escalations') {
    const due = dueEscalations(data, {
      now: Date.now(),
      minutes: url.searchParams.get('within_minutes') ? Number(url.searchParams.get('within_minutes')) : undefined,
    })
    jsonResponse(res, 200, {
      success: true,
      due: due.length,
      // What is not computed is as much of the answer as what is.
      escalatable: due.length ? 'escalations whose acknowledgement window has closed' : 'none due',
      data: due,
    })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
