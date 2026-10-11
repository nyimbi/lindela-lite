/**
 * ARC-01 — the alerting family, out of the god function.
 *
 * Everything that decides *what an operator is told, and what they decide back*:
 * the alert rules, the alert events they raise, the determinations filed against
 * them, the triage order they are read in, the CAP feed a partner's system
 * ingests, the trigger protocols that pre-authorise an action, and the
 * executions that record one firing.
 *
 * One family rather than three, because the three matchers are one lifecycle:
 * a rule raises an event, a protocol pre-authorises what happens to it, and an
 * execution is the record that it did. Splitting them would put the same
 * `findVisible` call, the same `action_logs` write and the same
 * `include_deleted` question in three modules and let them drift.
 *
 * The properties this family exists to hold, each of which was a bug once:
 *
 *   - **A view is not a collection.** `triage`, `outcome-reasons`,
 *     `outcome-tally`, `decision-latency` and `protocol-executions/summary` are
 *     computed, not stored, so they have no `data[...]` key. A generic
 *     collection branch reaching one would read `undefined` and 500.
 *
 *     Two things keep that from happening, and it is worth being honest that
 *     they are *both* there: every branch tests `route.kind` explicitly, and the
 *     views are answered before the collection branches. Removing either alone
 *     changes nothing — the first canary attempt proved it — and removing both
 *     fails `answers every view with a 200 on an empty store`. The kind guards
 *     are the load-bearing protection; the ordering is a second belt on the same
 *     trousers. A comment claiming the ordering alone holds this would be a claim
 *     the code does not make.
 *   - **A determination supersedes, it does not overwrite.** The alert carries
 *     the outcome as a *projection* so every existing consumer keeps reading one
 *     field, while `alert_outcomes` stays the record. Overwriting the alert
 *     would erase the sequence a false-alert rate is computed from.
 *   - **A refused verb is a 405, not a silent 200.** Every branch tests the
 *     method; the fallthrough answers 405. The alert cluster was already
 *     method-clean, and the extraction keeps it that way rather than relying on
 *     the handlers' own discipline.
 *   - **An unknown protocol id 404s rather than running nothing.** Scoping a run
 *     to a typo'd id would report success over an empty set.
 *
 * The `run` route reads the store a second time inside the handler
 * (`store.read()`), because executing protocols is a write path that must see
 * the store it is about to mutate rather than the snapshot the dispatcher read
 * on the way in.
 */

import {
  approveAlertEvent, backtestTriggerProtocol, evaluateInShadowMode, normalizeAlertRule,
  normalizeTriggerProtocol, updateAlertEvent,
} from '../alerts.js'
import { renderCapXml } from '../cap.js'
import { decisionLatency } from '../decision-latency.js'
import { logger, metrics } from '../observability.js'
import { actionLog, counts } from '../operations.js'
import { emit } from '../outbox.js'
import { determinationFor, normalizeAlertOutcome, outcomeReasons, outcomeTally, projectDetermination } from '../outcomes.js'
import { executeTriggerProtocols } from '../protocols.js'
import { rankAlerts } from '../triage.js'
import { collectionPage, readRequestJson } from '../utils.js'
import { findVisible } from '../visibility.js'

/**
 * Which alerting route a request is, or null.
 *
 * The alert cluster is matched without the method — the handler answers a 405
 * for a verb it does not serve, which is a better answer than a 404 for a route
 * that plainly exists. `protocol-executions` and `trigger-protocols/run` are
 * matched the same way.
 */
export function matchAlertingRoute(pathname) {
  const cap = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\.cap$/)
  if (cap) return { kind: 'cap', id: decodeURIComponent(cap[1]) }

  const action = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\/(approve|reject)$/)
  if (action) return { kind: 'alert-event-action', id: decodeURIComponent(action[1]), action: action[2] }

  // ENH-19. The outcome channel, addressed through the alert it is about: a
  // determination filed against an id is about that alert, and a body carrying a
  // different id is a mistake worth making impossible.
  const outcome = pathname.match(/^\/api\/v1\/alert-events\/([^/]+)\/outcome$/)
  if (outcome) return { kind: 'alert-outcome', id: decodeURIComponent(outcome[1]) }

  // ENH-69. The triage order, as a view rather than a collection: it is a
  // ranking over the open alerts, not a stored list, and serving it means the
  // console does not carry a second implementation of the arithmetic.
  if (pathname === '/api/v1/alert-events/triage') return { kind: 'triage' }
  if (pathname === '/api/v1/alert-outcomes/reasons') return { kind: 'outcome-reasons' }
  if (pathname === '/api/v1/alert-outcomes/tally') return { kind: 'outcome-tally' }
  // ENH-73. The redesign's premise is a cognitive-cost hypothesis that nothing
  // measured. This is the one decision the platform records with both of its
  // endpoints.
  if (pathname === '/api/v1/alert-outcomes/decision-latency') return { kind: 'decision-latency' }
  if (pathname === '/api/v1/alert-outcomes') return { kind: 'alert-outcomes' }

  const collection = pathname.match(/^\/api\/v1\/(alert-rules|alert-events)(?:\/([^/]+))?$/)
  if (collection) {
    return {
      kind: 'alert-collection',
      collection: collection[1] === 'alert-rules' ? 'alert_rules' : 'alert_events',
      id: collection[2] ? decodeURIComponent(collection[2]) : null,
    }
  }

  return matchTriggeringRoute(pathname)
}

/**
 * The trigger half: the protocols that pre-authorise an action, the executions
 * that record one firing, and the run that makes them fire.
 */
function matchTriggeringRoute(pathname) {
  const backtest = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/backtest$/)
  if (backtest) return { kind: 'trigger-action', id: decodeURIComponent(backtest[1]), action: 'backtest' }

  const shadowRun = pathname.match(/^\/api\/v1\/trigger-protocols\/([^/]+)\/shadow-run$/)
  if (shadowRun) return { kind: 'trigger-action', id: decodeURIComponent(shadowRun[1]), action: 'shadow-run' }

  // `/run` executes every protocol and belongs to the protocol-execution route,
  // not to a record id. The generic pattern would swallow it as id 'run', and
  // the record handler would then 405 a route that exists one matcher later.
  if (pathname === '/api/v1/trigger-protocols/run') return { kind: 'trigger-run' }

  const protocol = pathname.match(/^\/api\/v1\/trigger-protocols(?:\/([^/]+))?$/)
  if (protocol) return { kind: 'trigger-collection', id: protocol[1] ? decodeURIComponent(protocol[1]) : null }

  if (pathname === '/api/v1/protocol-executions') return { kind: 'protocol-executions' }
  if (pathname === '/api/v1/protocol-executions/summary') return { kind: 'protocol-executions-summary' }

  return null
}

/**
 * Handle one alerting route. Returns true when it handled the request.
 *
 * The split is by an explicit list rather than by elimination. A dispatcher that
 * sends everything it does not recognise to the second handler lets an unknown
 * kind fall through to that handler's 405 and answer `handled: true` — a route
 * that does not exist reporting itself as served, which is the opposite of what
 * the caller of this function needs to know.
 */
const ALERT_KINDS = new Set([
  'cap', 'alert-collection', 'alert-event-action', 'alert-outcome', 'alert-outcomes',
  'triage', 'outcome-reasons', 'outcome-tally', 'decision-latency',
])

const TRIGGER_KINDS = new Set([
  'trigger-collection', 'trigger-action', 'trigger-run',
  'protocol-executions', 'protocol-executions-summary',
])

export async function handleAlertingRoute(route, { data, req, res, url, jsonResponse, store }) {
  if (ALERT_KINDS.has(route.kind)) return handleAlertRoute(route, { data, req, res, url, jsonResponse, store })
  if (TRIGGER_KINDS.has(route.kind)) return handleTriggerRoute(route, { data, req, res, url, jsonResponse, store })
  return false
}

/**
 * The alert cluster.
 *
 * The `include_deleted` switch is read once here for the same reason the generic
 * collection route reads it: the by-id form has to answer with what the list
 * form answered with, and the list form honours this switch.
 */
async function handleAlertRoute(route, { data, req, res, url, jsonResponse, store }) {
  const includeDeleted = url.searchParams.get('include_deleted') === 'true'

  if (req.method === 'GET' && route.kind === 'outcome-reasons') {
    // The closed set, served rather than duplicated in a client. A determination
    // UI with its own copy of these lists is a fourth definition of what a false
    // alert is, and the two would drift.
    jsonResponse(res, 200, { success: true, data: outcomeReasons() })
    return true
  }

  if (req.method === 'GET' && route.kind === 'triage') {
    // ENH-69. Ranked by expected-loss proxy, not by recency. The ordering is the
    // triage policy, and "newest first" was a policy nobody chose: it put a
    // low-severity alert raised a minute ago above a critical one over a district
    // with ten times the exposure. `src/triage.js` states what the quantity is and
    // what it is not.
    jsonResponse(res, 200, { success: true, data: rankAlerts(data) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'decision-latency') {
    jsonResponse(res, 200, { success: true, data: decisionLatency(data) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'outcome-tally') {
    // "How much do we actually know" is a number an operator needs before any
    // rate: 400 alerts with 12 determinations is unmeasured, and a false-alert
    // rate computed from those twelve describes a sample nobody chose.
    jsonResponse(res, 200, { success: true, data: outcomeTally(data.alert_events, data.alert_outcomes) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'cap') {
    const record = findVisible(data.alert_events, route.id, { includeDeleted })
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return true
    }
    const xml = renderCapXml(record)
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
    res.end(xml)
    return true
  }

  if (req.method === 'GET' && route.kind === 'alert-outcomes') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.alert_outcomes || [], url.searchParams, { auth: req.__auth, data, collection: 'alert_outcomes' }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'alert-collection' && !route.id) {
    // The collection and store are passed so a district filter can attribute
    // records that carry no location of their own — interventions through their
    // incident, tasks through the intervention, dispatches through the alert
    // event — the same way districtOverview does. Without it those collections
    // matched nothing and a district reported no activity it plainly had.
    jsonResponse(res, 200, { success: true, ...collectionPage(data[route.collection], url.searchParams, { data, collection: route.collection }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'alert-collection' && route.id) {
    const record = findVisible(data[route.collection], route.id, { includeDeleted })
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  if (req.method === 'POST' && route.kind === 'alert-collection' && !route.id && route.collection === 'alert_rules') {
    const body = await readRequestJson(req)
    const record = normalizeAlertRule(body)
    const log = actionLog(route.collection, 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ alert_rules: [record], action_logs: [log] })
    try {
      await emit(store, 'alert_rule.created', record)
    } catch (emitError) {
      // R-22. The record is already persisted above, so this gap runs the other
      // way from the one the atomic call sites closed: the state is true and the
      // notification is missing. That is the survivable direction — a subscriber
      // that never hears is a gap; a subscriber that hears about a transition
      // that did not happen is a false statement about the world — but a gap that
      // is swallowed is a gap nobody can count. So it is counted and logged, and
      // the request still succeeds: a failed notification is not a reason to
      // abandon a rule that was created.
      metrics.counter('outbox_emit_failed_total', { event: 'alert_rule.created' })
      logger.error('outbox_emit_failed', {
        outbox_event: 'alert_rule.created',
        message: 'outbox emit failed; the record is stored and no subscriber was told',
        err: { message: emitError.message, stack: emitError.stack },
      })
    }
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'PATCH' && route.kind === 'alert-collection' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data[route.collection], route.id, { includeDeleted })
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Record not found' })
      return true
    }
    const record = route.collection === 'alert_rules'
      ? normalizeAlertRule({ ...existing, ...body, id: route.id }, existing)
      : updateAlertEvent(existing, body)
    const log = actionLog(route.collection, 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ [route.collection]: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'alert-outcome') {
    const body = await readRequestJson(req)
    const alert = findVisible(data.alert_events, route.id)
    if (!alert) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return true
    }
    const prior = determinationFor(route.id, data.alert_outcomes)
    const outcome = normalizeAlertOutcome(
      { ...body, alert_event_id: route.id, supersedes: prior?.id ?? null },
      { existing: prior },
    )
    // The alert carries the determination as a projection, so every existing
    // consumer keeps reading one field while the outcome stays the record. A
    // later determination supersedes rather than overwrites, so the sequence is
    // still readable.
    const projected = projectDetermination(alert, outcome)
    const log = actionLog('alert_outcomes', 'created', outcome, body.actor, req.__auth?.subject)
    await store.merge({ alert_outcomes: [outcome], alert_events: [projected], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: outcome, alert: projected, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'alert-event-action') {
    const body = await readRequestJson(req)
    const existing = findVisible(data.alert_events, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Alert event not found' })
      return true
    }
    const actor = body.actor || (req.__auth?.subject)
    if (!actor) {
      jsonResponse(res, 400, { success: false, error: 'actor is required' })
      return true
    }
    const decision = route.action === 'approve' ? 'approved' : route.action === 'reject' ? 'rejected' : null
    if (!decision) {
      jsonResponse(res, 400, { success: false, error: 'Invalid approval action' })
      return true
    }
    const record = approveAlertEvent(existing, actor, decision, body.note || '')
    const log = actionLog('alert_events', route.action, record, body.actor, req.__auth?.subject)
    await store.merge({ alert_events: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}

/**
 * The trigger cluster: protocols, their executions, and the run that fires them.
 */
async function handleTriggerRoute(route, { data, req, res, url, jsonResponse, store }) {
  if (req.method === 'GET' && route.kind === 'trigger-collection' && !route.id) {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.trigger_protocols || [], url.searchParams, { auth: req.__auth, data, collection: 'trigger_protocols' }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'trigger-collection' && route.id) {
    const record = findVisible(data.trigger_protocols, route.id)
    if (!record) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: record })
    return true
  }

  if (req.method === 'POST' && route.kind === 'trigger-collection' && !route.id) {
    const body = await readRequestJson(req)
    const record = normalizeTriggerProtocol(body)
    const log = actionLog('trigger_protocols', 'created', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'PATCH' && route.kind === 'trigger-collection' && route.id) {
    const body = await readRequestJson(req)
    const existing = findVisible(data.trigger_protocols, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return true
    }
    const record = normalizeTriggerProtocol({ ...existing, ...body, id: route.id }, existing)
    const log = actionLog('trigger_protocols', 'updated', record, body.actor, req.__auth?.subject)
    await store.merge({ trigger_protocols: [record], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: record, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'trigger-action' && route.action === 'backtest') {
    const existing = findVisible(data.trigger_protocols, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return true
    }
    const result = backtestTriggerProtocol(existing, data)
    const updated = { ...existing, backtest: { ...result, last_run_at: new Date().toISOString() } }
    const log = actionLog('trigger_protocols', 'backtest_run', updated, null, req.__auth?.subject)
    await store.merge({ trigger_protocols: [updated], action_logs: [log] })
    jsonResponse(res, 200, { success: true, data: updated, backtest_result: result, action_log: log })
    return true
  }

  if (req.method === 'POST' && route.kind === 'trigger-action' && route.action === 'shadow-run') {
    const existing = findVisible(data.trigger_protocols, route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Trigger protocol not found' })
      return true
    }
    const context = {
      counts: counts(data),
      data_quality: data.data_quality,
    }
    const result = evaluateInShadowMode(existing, context)
    jsonResponse(res, 200, { success: true, data: result })
    return true
  }

  if (req.method === 'GET' && route.kind === 'protocol-executions') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.protocol_executions || [], url.searchParams, { auth: req.__auth, data, collection: 'protocol_executions' }) })
    return true
  }

  if (req.method === 'GET' && route.kind === 'protocol-executions-summary') {
    const rows = data.protocol_executions || []
    const last24hStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const recent = rows.filter((r) => r.fired_at > last24hStr)
    const byStatus = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})
    const latestPer = {}
    for (const r of [...rows].sort((a, b) => new Date(b.fired_at) - new Date(a.fired_at))) {
      if (!latestPer[r.protocol_id]) latestPer[r.protocol_id] = { execution_id: r.id, status: r.status, fired_at: r.fired_at, observed_value: r.observed_value, would_fire: r.would_fire }
    }
    jsonResponse(res, 200, { success: true, total: rows.length, by_status: byStatus, last_24h: recent.length, latest_per_protocol: latestPer })
    return true
  }

  if (req.method === 'POST' && route.kind === 'trigger-run') {
    const body = await readRequestJson(req)
    const dryRun = Boolean(body.dry_run)
    // Optional body.protocol_id scopes the run to a single protocol (the ops
    // action rail's per-row Run control). Unknown ids 404 rather than running
    // nothing: silently scoping to an empty set would report success and hide the
    // typo.
    //
    // Read again rather than reusing `data`: executing protocols is a write path
    // and it must see the store it is about to mutate, not the snapshot the
    // dispatcher read on the way in.
    const fresh = await store.read()
    let scoped = fresh
    if (body.protocol_id) {
      const target = fresh.trigger_protocols.find((p) => p.id === body.protocol_id)
      if (!target) {
        jsonResponse(res, 404, { success: false, error: `No trigger protocol with id ${body.protocol_id}` })
        return true
      }
      scoped = { ...fresh, trigger_protocols: [target] }
    }
    const result = await executeTriggerProtocols(store, scoped, { dryRun, actor: body.actor, subject: req.__auth?.subject })
    jsonResponse(res, dryRun ? 200 : 201, { success: true, dry_run: dryRun, data: result })
    return true
  }

  jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
  return true
}
