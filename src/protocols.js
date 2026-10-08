/**
 * Protocol execution engine — Phase D (vision gap-closure).
 *
 * Protocols are pre-authorised conditions. When their metric crosses the
 * threshold, the alert is auto-approved (`approval.state = 'auto_approved'`)
 * and the playbook executes without a human gate — the protocol IS the
 * authorisation. The audit chain (`approval.approvers`, `approval.decided_at`,
 * `derivation.engine.rule_schema = 'protocol/1'`) makes that claim verifiable.
 */

import { resolveMetric, compare, buildAlert, normalizeTriggerProtocol, backtestTriggerProtocol, pointInTimeContext } from './alerts.js'
import { counts, buildCreate } from './operations.js'
import { sendRapidProAlert, rapidProStatus } from './rapidpro.js'
import { stableId } from './utils.js'

export function liveContext(data) {
  return { counts: counts(data), data_quality: data.data_quality || null }
}

/** Pure evaluation: returns per-protocol `{ protocol, value, firing }`. */
export function evaluateTriggerProtocols(data, { now = new Date().toISOString() } = {}) {
  const protocols = data.trigger_protocols || []
  const context = liveContext(data)
  const out = []
  for (const p of protocols) {
    const value = resolveMetric(context, p.metric)
    out.push({ protocol: p, value, firing: Number.isFinite(value) && compare(value, p.operator, p.threshold) })
  }
  return out
}

/** Effectful execution: shadow writes execution row only; live creates
 * auto-approved alert + executes playbook + writes executions row. */
export async function executeTriggerProtocols(store, data, {
  now = new Date().toISOString(), dryRun = false, actor = null, subject = null, env = process.env,
} = {}) {
  const protocols = data.trigger_protocols || []
  const results = []
  const executionsRows = []
  const rapidproDispatchesArr = []
  const incidentsArr = []
  const interventionsArr = []
  const tasksArr = []
  const alerts = []
  const logsArr = []

  for (const p of protocols) {
    const context = liveContext(data)
    const value = resolveMetric(context, p.metric)
    const wouldFire = Number.isFinite(value) && compare(value, p.operator, p.threshold)

    if (p.mode === 'shadow') {
      executionsRows.push({
        id: stableId('protocol_execution', [p.id, now]),
        protocol_id: p.id,
        protocol_name: p.name,
        protocol_version: p.version || 1,
        mode: 'shadow', fired_at: now,
        status: 'shadow',
        metric: p.metric, operator: p.operator, threshold: p.threshold,
        observed_value: value,
        would_fire: wouldFire,
        dry_run: Boolean(dryRun),
        actions: [],
        actor: 'protocol-engine', created_at: now,
      })
      results.push({ protocol_id: p.id, mode: 'shadow', status: 'shadow', would_fire: wouldFire })
      continue
    }

    if (!wouldFire) {
      results.push({ protocol_id: p.id, mode: 'live', status: 'not_firing', value })
      continue
    }

    const currentAlertEvent = (data.alert_events || []).find((a) => a.metadata?.protocol_id === p.id && a.status === 'open')
    if (currentAlertEvent) {
      results.push({ protocol_id: p.id, mode: 'live', status: 'persisted', value })
      continue
    }

    const alert = buildAlert(p, value, {
      bucket: 'protocol', now, supersedes: null, prior_value: null,
      context, inputs: null,
    })
    alert.approval = { state: 'auto_approved', pre_authorised: true, protocol_id: p.id, protocol_version: p.version || 1, approvers: p.approvers || ['system:protocol_engine'], decided_at: now }
    alert.metadata = { ...(alert.metadata || {}), protocol_id: p.id, protocol_version: p.version || 1, pre_authorised: true }
    alert.derivation = {
      ...(alert.derivation || {}),
      rule_id: null,
      rule_version: p.version || 1,
      rule_name_at_fire: p.name,
      metric: p.metric,
      operator: p.operator,
      threshold: p.threshold,
      observed_value: value,
      observed_at: now,
      context_snapshot: context,
      input_record_ids: null,
      engine: { module: 'src/protocols.js', rule_schema: 'protocol/1' },
    }
    alerts.push(alert)

    const playbookActions = p.action_playbook || []
    const actionsResults = []
    let anyFailed = false

    for (const action of playbookActions) {
      if (action.type === 'notify') {
        if (rapidProStatus(env)?.enabled) {
          const recipients = action.recipients || []
          try {
            const dispatch = await sendRapidProAlert(alert, { recipients })
            rapidproDispatchesArr.push(dispatch)
            actionsResults.push({ type: 'notify', status: 'executed', detail: `dispatched to ${recipients.length ? recipients.join(', ') : 'default'}` })
          } catch (e) {
            actionsResults.push({ type: 'notify', status: 'refused', detail: `rapidpro not configured; alert raised but dispatch awaits manual send: ${e.message || String(e)}` })
            anyFailed = true
          }
        } else {
          actionsResults.push({ type: 'notify', status: 'refused', detail: 'rapidpro not configured; alert raised, dispatch awaits manual send' })
          anyFailed = true
        }
      } else if (action.type === 'intervention') {
        const interventionRecord = buildCreate('interventions', {
          title: action.title || p.name,
          objective: action.objective || p.description,
          priority: action.priority || p.severity,
          lead_org: action.lead_org || null,
          district: action.district || null,
        }, data)
        interventionsArr.push(interventionRecord)
        actionsResults.push({ type: 'intervention', status: 'executed', record_id: interventionRecord.id, detail: 'intervention created with linked alert' })
      } else if (action.type === 'task') {
        const interventionRecord = interventionsArr[interventionsArr.length - 1]
        if (!interventionRecord && !action.for) {
          actionsResults.push({ type: 'task', status: 'refused', detail: 'no intervention in this execution to attach the task to' })
          anyFailed = true
        } else {
          const taskRecord = buildCreate('intervention_tasks', {
            intervention_id: action.for ? null : (interventionRecord?.id || null),
            title: action.title,
            description: action.description || '',
            due_at: action.due_at || null,
            owner: action.owner || null,
          }, data)
          tasksArr.push(taskRecord)
          actionsResults.push({ type: 'task', status: 'executed', record_id: taskRecord.id, detail: `attached to ${interventionRecord ? 'intervention ' + interventionRecord.id : 'no intervention'}` })
        }
      } else {
        actionsResults.push({ type: action.type || 'unknown', status: 'refused', detail: 'unknown action type' })
        anyFailed = true
      }
    }

    const executionRow = {
      id: stableId('protocol_execution', [p.id, now]),
      protocol_id: p.id,
      protocol_name: p.name,
      protocol_version: p.version || 1,
      mode: 'live', fired_at: now,
      status: anyFailed ? (playbookActions.some((a) => a.status === 'executed') ? 'partial' : 'refused') : 'executed',
      metric: p.metric, operator: p.operator, threshold: p.threshold,
      observed_value: value,
      alert_id: alert.id,
      dry_run: Boolean(dryRun),
      actions: actionsResults,
      actor: 'protocol-engine',
      created_at: now,
    }
    executionsRows.push(executionRow)
    results.push({ protocol_id: p.id, mode: 'live', status: anyFailed ? (playbookActions.some((a) => a.status === 'executed') ? 'partial' : 'refused') : 'executed', alert_id: alert.id })

  if (!dryRun) {
    const allRecords = [
      ...alerts.map((a) => ({ collection: 'alert_events', record: a })),
      ...executionsRows.map((e) => ({ collection: 'protocol_executions', record: e })),
      ...rapidproDispatchesArr.map((d) => ({ collection: 'rapidpro_dispatches', record: d })),
      ...incidentsArr.map((i) => ({ collection: 'incidents', record: i })),
      ...interventionsArr.map((i) => ({ collection: 'interventions', record: i })),
      ...tasksArr.map((t) => ({ collection: 'intervention_tasks', record: t })),
      ...logsArr.map((l) => ({ collection: 'action_logs', record: l })),
    ]
    await store.merge({
      alert_events: alerts,
      protocol_executions: executionsRows,
      rapidpro_dispatches: rapidproDispatchesArr,
      incidents: incidentsArr,
      interventions: interventionsArr,
      intervention_tasks: tasksArr,
      action_logs: logsArr,
    })
  }

  return { executions: executionsRows, dry_run: Boolean(dryRun) }
}
