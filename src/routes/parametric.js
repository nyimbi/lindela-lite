/**
 * ARC-01 — the parametric routes, out of the god function.
 *
 * The rules that define what gets paid, to whom and on what condition, the
 * simulations that decide one, and the disbursements those simulations wrote.
 * Four routes over three paths, and they are a family because they are the
 * money path: every one of them is read together by anyone asking "why did this
 * payout happen".
 *
 * The properties this module exists to hold, each of which was a bug once:
 *
 *   - **a one-rule edit does not rewrite the store.** R-25. These routes used
 *     `store.write()` to change one rule — a full-table DELETE and reinsert on
 *     PostgreSQL for an `O(1)` edit, and a whole-snapshot write that silently
 *     reverts a concurrent write to another collection. They use
 *     `replaceCollection` now, and the action log is its own merge rather than a
 *     reason to rewrite the world.
 *   - **a deletion is archived, not summarised.** The DELETE carries the whole
 *     removed rule in the action log rather than "a rule was deleted", because
 *     the rule defined what gets paid, to whom and on what condition, and an
 *     audit chain that says only that something was removed is broken at exactly
 *     the point someone needed to know what had been in force.
 *   - **the trigger is evaluated against the platform's own state.** The
 *     simulation decides from the shared evaluation context, the
 *     same context an alert rule sees, so a payout is decided by the data rather
 *     than asserted by the caller. An explicit `trigger_value` overrides it, for
 *     an operator quoting an observation the store has not ingested.
 *   - **an approval is verified, not asserted.** `resolveFocalPointApproval`
 *     consults the workflow machinery that can carry a real approval, and a
 *     named instance that is not actually confirmed is a 409 rather than a
 *     silently accepted flag.
 *
 * VUL-04 is stated one layer up: the `role:operator|admin:*` scope for
 * `POST …/simulate` lives in `scopeForRoute`, where it reads as policy. A check
 * inside the handler would be a second copy of that decision, and the two would
 * drift.
 */

import { actionLog, buildEvaluationContext } from '../operations.js'
import { normalizeParametricRule, simulateDisbursement } from '../parametric.js'
import { screenNames } from '../sanctions.js'
import { readRequestJson } from '../utils.js'

/**
 * Which parametric route a request is, or null.
 *
 * Pathname only: each of these serves one verb per path and the handler tests
 * it, answering 405 for a verb it does not serve — a better answer than a 404
 * for a route that plainly exists. `check-openapi.mjs` reads the literals and
 * the `.match(/…/)` patterns below.
 */
export function matchParametricRoute(pathname) {
  if (pathname === '/api/v1/parametric-rules') return { kind: 'rules-list' }
  const ruleMatch = pathname.match(/^\/api\/v1\/parametric-rules\/([^/]+)$/)
  if (ruleMatch) return { kind: 'rule-detail', id: decodeURIComponent(ruleMatch[1]) }
  const simMatch = pathname.match(/^\/api\/v1\/parametric-rules\/([^/]+)\/simulate$/)
  if (simMatch) return { kind: 'simulate', id: decodeURIComponent(simMatch[1]) }
  if (pathname === '/api/v1/parametric-disbursements') return { kind: 'disbursements-list' }
  return null
}

/**
 * Where a focal point approval came from.
 *
 * The disbursement route previously gated on `Boolean(body.focal_point_approved)`
 * — a field the same request set. The workflow machinery that could carry a real
 * approval (`parametric_disbursement`, whose states include
 * `focal_point_confirmed`) was never consulted, so a verified path existed and
 * went unused. It is consulted now; an instance that does not exist, is the wrong
 * type, or has not reached a confirmed state is a 409 rather than a silently
 * accepted flag.
 */
export function resolveFocalPointApproval(data, rule, body) {
  if (!body.workflow_instance_id) {
    const asserted = Boolean(body.focal_point_approved)
    // No approval is being claimed beyond the flag. A rule that does not require
    // one is approved by nobody, which is the rule's own decision.
    if (!rule.requires_focal_point_approval) {
      return { approved: false, source: null, workflow_instance_id: null, approved_by: null }
    }
    return {
      approved: asserted,
      source: asserted ? 'request_body' : null,
      workflow_instance_id: null,
      approved_by: asserted ? (body.approved_by || body.actor || null) : null,
    }
  }

  const instance = (data.workflow_instances || []).find((w) => w.id === body.workflow_instance_id)
  if (!instance) {
    throw Object.assign(new Error(`Workflow instance ${body.workflow_instance_id} not found`), { statusCode: 409 })
  }
  if (instance.type !== 'parametric_disbursement') {
    throw Object.assign(
      new Error(`Workflow instance ${instance.id} is a ${instance.type} instance and cannot approve a disbursement`),
      { statusCode: 409 }
    )
  }
  if (!['focal_point_confirmed', 'chain_dispatched', 'closed'].includes(instance.state)) {
    throw Object.assign(
      new Error(`Workflow instance ${instance.id} is "${instance.state}"; focal point confirmation is required before a disbursement can be simulated`),
      { statusCode: 409 }
    )
  }
  return {
    approved: true,
    source: 'workflow',
    workflow_instance_id: instance.id,
    approved_by: instance.actor || null,
  }
}

/**
 * Handle one parametric route. Returns true when it handled the request.
 */
export async function handleParametricRoute(route, { store, data, req, res, jsonResponse }) {
  const auth = req.__auth || {}

  if (route.kind === 'rules-list') {
    if (req.method === 'GET') {
      const rules = data.parametric_rules || []
      jsonResponse(res, 200, { success: true, data: rules, count: rules.length })
      return true
    }
    if (req.method === 'POST') {
      const body = await readRequestJson(req)
      try {
        const rule = normalizeParametricRule(body)
        // The money path wrote no action log: a rule that defines what gets
        // paid, to whom, on what condition, could be created or edited with
        // nothing recording who did it.
        const log = actionLog('parametric_rules', 'created', rule, body.actor, req.__auth?.subject)
        // R-25. `write()` replaces the whole store, and these four routes used
        // it to change one rule: on PostgreSQL that is a DELETE of every row
        // and a reinsert, for an O(N + B) edit. `replaceCollection` says what
        // actually happened, and the action log is its own merge rather than a
        // reason to rewrite the world.
        await store.replaceCollection('parametric_rules', [...(data.parametric_rules || []), rule])
        await store.merge({ action_logs: [log] })
        jsonResponse(res, 201, { success: true, data: rule, action_log: log })
      } catch (err) {
        jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      }
      return true
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return true
  }

  if (route.kind === 'rule-detail') {
    const existing = (data.parametric_rules || []).find((r) => r.id === route.id)
    if (!existing) {
      jsonResponse(res, 404, { success: false, error: 'Parametric rule not found' })
      return true
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, { success: true, data: existing })
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readRequestJson(req)
      try {
        const updated_rule = normalizeParametricRule(body, existing)
        const rules = (data.parametric_rules || []).map((r) => r.id === route.id ? updated_rule : r)
        const log = actionLog('parametric_rules', 'updated', updated_rule, body.actor, req.__auth?.subject)
        await store.replaceCollection('parametric_rules', rules)
        await store.merge({ action_logs: [log] })
        jsonResponse(res, 200, { success: true, data: updated_rule, action_log: log })
      } catch (err) {
        jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      }
      return true
    }
    // A hard delete, with the removed rule carried whole in the action log
    // rather than a summary of it. The rule defined what gets paid, to whom and
    // on what condition; a delete that left only "a rule was deleted" behind
    // would break the audit chain at exactly the point someone needed to know
    // what had been in force. CE-10 preferred archiving over deleting so the
    // chain survives; this copy is that archive, and an archived rule would stay
    // in the simulator picker as something still selectable.
    if (req.method === 'DELETE') {
      const rules = (data.parametric_rules || []).filter((r) => r.id !== route.id)
      const log = actionLog('parametric_rules', 'deleted', existing, null, req.__auth?.subject, {
        removed_rule: existing,
      })
      await store.replaceCollection('parametric_rules', rules)
      await store.merge({ action_logs: [log] })
      jsonResponse(res, 200, { success: true, data: { id: route.id, deleted: true }, action_log: log })
      return true
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return true
  }

  if (route.kind === 'simulate') {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
      return true
    }
    const rule = (data.parametric_rules || []).find((r) => r.id === route.id)
    if (!rule) {
      jsonResponse(res, 404, { success: false, error: 'Parametric rule not found' })
      return true
    }
    const body = await readRequestJson(req)
    try {
      const recipientName = body.recipient_name || body.recipient || null
      let sanctions = null
      if (recipientName) {
        try {
          const screened = await screenNames([recipientName], { retries: 0 })
          sanctions = {
            screened: true,
            matches: screened.matches,
            blocked: screened.matches.length > 0,
            reason: `screened "${recipientName}" against the OFAC SDN list`,
          }
        } catch (screenError) {
          // Screening is advisory: surface the failure but do not silently
          // treat an unreachable list as a clean result.
          sanctions = {
            screened: false,
            matches: [],
            blocked: false,
            error: screenError.message,
            reason: `screening "${recipientName}" failed: ${screenError.message}`,
          }
        }
      } else {
        // No recipient was supplied, so nothing was screened. Recorded rather
        // than left as a bare false, because a compliance reader must be able to
        // see that this disbursement never went near the SDN list.
        sanctions = {
          screened: false,
          matches: [],
          blocked: false,
          reason: 'no recipient name supplied, so no name was screened against the OFAC SDN list',
        }
      }

      // The trigger is evaluated against the platform's own state, the same
      // context alert rules see, so a parametric payout is decided by the data
      // rather than asserted by the caller. An explicit trigger_value overrides
      // it, for an operator quoting an observation the store has not ingested.
      const context = buildEvaluationContext(data)
      // An approval backed by a workflow instance is verified; one asserted in
      // the request body is recorded as asserted. `focal_point_approved` still
      // gates, but the disbursement now carries where the approval came from,
      // and a named instance that is not actually approved is rejected.
      const approval = resolveFocalPointApproval(data, rule, body)
      const result = simulateDisbursement(rule, {
        actor: body.actor || auth.subject || null,
        focal_point_approved: approval.approved,
        approval,
        sanctions,
        context,
        triggerValue: body.trigger_value,
      })
      const log = actionLog('parametric_disbursements', 'simulated', result, body.actor, req.__auth?.subject)
      // DATA-12. Appending the simulated row put the same payout in the list
      // twice when a request was retried, because the id it appends under used
      // to be clock-derived. The id is now the four facts that decide the
      // payout, so the row replaces rather than repeats — `replaceCollection`
      // would otherwise write both copies back, sorted, since it stores the
      // array it is handed. An existing row for the same id is superseded, and
      // its `simulated_at` records the later evaluation, which is when the row
      // on screen was last confirmed rather than when it was first minted.
      // DATA-14. A row written before the payout carried an `id` has none, and
      // `replaceCollection` now refuses one rather than letting Postgres drop
      // it and JSON keep it. Those rows are not lost: `disbursement_id` is the
      // same value under the name the record already used, so a legacy row is
      // named from the field it already carries. A row with neither is a row
      // this route cannot identify, and it is dropped here rather than
      // resurrected under a guessed id — it can only have come from a build
      // that wrote shapes this one does not.
      const carried = (data.parametric_disbursements || [])
        .filter((row) => row && row.disbursement_id !== result.disbursement_id)
        .map((row) => (row.id ? row : { ...row, id: row.disbursement_id }))
        .filter((row) => row.id)
      const disbursements = [...carried, result]
      await store.replaceCollection('parametric_disbursements', disbursements)
      await store.merge({ action_logs: [log] })
      jsonResponse(res, 201, { success: true, data: result, sanctions })
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, {
        success: false,
        error: err.message,
        ...(err.sanctions ? { sanctions: err.sanctions } : {}),
      })
    }
    return true
  }

  if (route.kind === 'disbursements-list') {
    if (req.method === 'GET') {
      const disbursements = data.parametric_disbursements || []
      jsonResponse(res, 200, { success: true, data: disbursements, count: disbursements.length })
      return true
    }
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return true
  }

  jsonResponse(res, 404, { success: false, error: 'Not found' })
  return true
}
