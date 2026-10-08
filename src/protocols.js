/**
 * Protocol execution engine — Phase D (vision gap-closure).
 *
 * THE POINT OF THE MODULE
 *
 * Alert *rules* (src/alerts.js) detect. They raise an alert and stop, and a
 * human decides what happens next. That decision latency — four to six days
 * between an early warning and an approved response in the settings this
 * platform is built for — is the failure the vision document names first:
 * "Early warning without coordination becomes delayed suffering."
 *
 * Protocols close that latency by moving the decision *before* the event. A
 * trigger protocol is a condition the district has already agreed to and
 * signed off (`agreed_at`, `approvers`) together with the actions that
 * agreement authorises (`action_playbook`). When the condition holds, the
 * alert is raised already approved (`approval.state = 'auto_approved'`,
 * `approval.pre_authorised = true`) and the playbook executes in the same
 * tick — no human gate, because the humans met when the protocol was signed.
 * The audit chain (`approvers`, `decided_at`,
 * `derivation.engine.rule_schema = 'protocol/1'`) is what makes "the district
 * agreed" a verifiable claim rather than a slogan.
 *
 * EXECUTION MODEL
 *
 * `executeTriggerProtocols(store, data, opts)` runs every protocol in the
 * store against a live context (`counts(data)` plus data quality — the same
 * metric vocabulary the backtester scores against, so a protocol fires on the
 * quantities it was evaluated on). Per protocol, exactly one of four things
 * happens:
 *
 *   - shadow mode writes one `protocol_executions` row recording what WOULD
 *     have fired. Shadow protocols are how a condition earns promotion to
 *     live: it runs silently, a backtest (backtestTriggerProtocol) measures
 *     its precision lift over the base rate, and only the evidence turns it
 *     on. A shadow row is the answer to "why did we start trusting this?"
 *   - live and not firing writes nothing at all. Silence means the condition
 *     does not hold; the feed shows actions, not heartbeats.
 *   - live, firing, with an open protocol alert already in the store records
 *     nothing new — one open action per protocol, ever. A persistent
 *     condition re-alerting every tick would multiply dispatches, tasks and
 *     equity-KPI noise without adding any information.
 *   - live, firing, none open builds the alert, executes the playbook, and
 *     commits EVERYTHING — alert, execution row, dispatches, incidents,
 *     interventions, tasks, logs — in ONE store.merge. A crash mid-run must
 *     not leave the playbook committed and the alert that justified it
 *     missing; the merge is the atomicity.
 *
 * COMPOSITION AND FAIL-CLOSED SEMANTICS
 *
 * Conditions compose as a flat set (`condition_set` in src/alerts.js): 1–5
 * terms combined by `and` / `or` / `xor`, with per-term negation and optional
 * group inversion — the whole practical space of district-phrased protocols
 * ("heat AND cold-chain breach", "flood OR landslide", "exactly one gauge
 * family reporting"), including NAND/NOR/XNOR via inversion. The one rule
 * that binds every combinator: if ANY term's metric cannot be resolved, the
 * set does not fire. An unresolvable term is a non-answer, and a non-answer
 * must never become a fire — group inversion of a missing reading would
 * otherwise turn silence into action, the one result guaranteed to be wrong.
 * Every evaluation (alert derivation, execution row, shadow row) snapshots
 * the per-term readings alongside the verdict, so "why did this fire?" has
 * the same answer for a compound protocol as for a single threshold.
 *
 * PLAYBOOK ACTIONS
 *
 * A closed set, executed in order:
 *
 *   - notify    — RapidPro dispatch to the protocol's recipients. Refused,
 *     not skipped, when RapidPro is unconfigured: the alert exists and is
 *     sendable by hand, so a missing gateway is a deferred delivery, not a
 *     failed step. The refusal says exactly that.
 *   - intervention — creates the incident first (an intervention is a
 *     response TO something; the chain incident → intervention → task must be
 *     real), then the intervention. Its optional `id` labels it for tasks.
 *   - task      — attaches to the intervention its `for` label names, or the
 *     most recent intervention this execution created. An unresolvable label
 *     is refused with the reason; a task is never filed against null or
 *     against last week's response.
 *
 * One refusal does not abort the playbook — the execution status (executed /
 * partial / refused) is computed from the RESULTS, never from the operator's
 * input JSON, which has no status fields to read.
 *
 * THE SHAPE OF AN HONEST LEDGER
 *
 * Everything lands in `protocol_executions`: what fired, the evaluated
 * condition set, which actions ran, which refused and why, the alert it
 * produced, and the actor (`protocol-engine`) — plus an action_log row and
 * a `protocol.executed` outbox event per execution so webhook subscribers
 * learn of pre-authorised actions in the same breath as the audit chain.
 * A pre-authorised action that nobody could observe would be indistinguishable
 * from nothing happening, and "nothing happened" is the one false claim this
 * system refuses to make.
 */

import { evaluateConditionSet } from './alerts.js'
import { counts, buildCreate, actionLog } from './operations.js'
import { sendRapidProAlert, rapidProStatus } from './rapidpro.js'
import { stableId } from './utils.js'
import { emit } from './outbox.js'
import { logger, metrics } from './observability.js'

// `buildAlert` is deliberately NOT imported. The plan calls for the protocol
// alert to be built to field parity with `buildAlert` in src/alerts.js:225, but
// copying that function here would be a second implementation of the same
// derivation, and the two would drift the moment a field was added to one. The
// alert shape is constructed explicitly below instead, so a divergence between
// the two is visible in this file rather than hidden by a shared import whose
// signature does not cover what a protocol needs (`rule_id: null`,
// `pre_authorised: true`, `protocol/1` in the engine).

export function liveContext(data) {
  return { counts: counts(data), data_quality: data.data_quality || null }
}

/** Pure evaluation: returns per-protocol firing against the full logic. */
export function evaluateTriggerProtocols(data, { now = new Date().toISOString() } = {}) {
  const protocols = data.trigger_protocols || []
  const context = liveContext(data)
  const out = []
  for (const p of protocols) {
    const evaluation = evaluateConditionSet(conditionSetFor(p), context)
    out.push({ protocol: p, value: evaluation.primary?.observed_value ?? null, firing: evaluation.firing, evaluation })
  }
  return out
}

/** Records normalised before condition sets existed — and hand-built fixtures —
 * carry only the flat fields; they always meant a one-term AND set. */
function conditionSetFor(p) {
  return p.condition_set?.terms?.length
    ? p.condition_set
    : { combinator: 'and', negate: false, terms: [{ metric: p.metric, operator: p.operator, threshold: p.threshold }] }
}

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
    const conditionSet = conditionSetFor(p)
    const evaluation = evaluateConditionSet(conditionSet, context)
    const primary = evaluation.primary || { observed_value: null }
    const value = primary.observed_value
    const wouldFire = evaluation.firing

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
        // The full evaluated logic travels with the row: the feed shows the
        // readings per term, not just the verdict.
        condition_set: {
          combinator: conditionSet.combinator,
          negate: Boolean(conditionSet.negate),
          evaluable: evaluation.evaluable,
          terms: evaluation.results,
        },
        // Explicitly null rather than absent. `alert_id` is part of the declared
        // execution shape, and a reader that has to tell "no alert was created"
        // from "this field does not exist" gets the wrong answer for a missing
        // key — the same present-versus-absent distinction the repo keeps having
        // to re-learn elsewhere.
        alert_id: null,
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

    // The alert is built to field parity with `buildAlert` in src/alerts.js:225
    // rather than through it. `rule_id: null` and `engine.rule_schema:
    // 'protocol/1'` are not things that function can express — it always writes
    // a rule id and schema '1' — so calling it and then overwriting the fields
    // would leave a derivation claiming a rule fired when no rule was involved.
    //
    // `execution_id` is computed before the alert because the alert's metadata
    // names it and `alert_id` is written into the execution row. One direction
    // of that pair has to be filled in after the fact; doing it this way means
    // both are real rather than one being null.
    const executionId = stableId('protocol_execution', [p.id, now])
    // Protocol metrics are aggregate counts over the whole store — counts.* —
    // so the alert has no per-record identity to inherit a place from. The
    // playbook is where a district lives: the first action that names one is
    // the alert's where. Null when the playbook names none; the console words
    // that ("not recorded for this alert") rather than guessing.
    const playbookDistrict = (p.action_playbook || [])
      .find((a) => a && typeof a === 'object' && a.district)?.district || null
    const alert = {
      id: stableId('alert', [p.id, 'protocol', now]),
      rule_id: null,
      rule_name: p.name,
      status: 'open',
      severity: p.severity,
      metric: p.metric,
      operator: p.operator,
      threshold: p.threshold,
      value,
      location: playbookDistrict
        ? { name: playbookDistrict, admin1: null, country: null, latitude: null, longitude: null }
        : null,
      message: `${p.name} (pre-authorised protocol): ${p.metric} ${p.operator} ${p.threshold} (actual ${value})`,
      actions: p.action_playbook,
      scope: { protocol_id: p.id, ...(playbookDistrict ? { district: playbookDistrict } : {}) },
      created_at: now,
      updated_at: now,
      // The pre-authorisation IS the protocol record. That is the entire point:
      // no human gate on the alert itself. `p.approvers` is carried so a reader
      // can see who signed the protocol off, not so anyone is asked again.
      approval: {
        state: 'auto_approved',
        pre_authorised: true,
        protocol_id: p.id,
        protocol_version: p.version || 1,
        approvers: p.approvers || [],
        // The date the district signed the protocol off, carried with the
        // approvers and decided_at it belongs beside: "pre-authorised" is a
        // claim about a decision made ON a date. Null when the protocol has
        // none, which is itself the honest answer.
        agreed_at: p.agreed_at || null,
        decided_at: now,
      },
      metadata: {
        protocol_id: p.id,
        protocol_version: p.version || 1,
        execution_id: executionId,
        pre_authorised: true,
      },
      derivation: {
        rule_id: null,
        rule_version: p.version || 1,
        rule_name_at_fire: p.name,
        metric: p.metric,
        operator: p.operator,
        threshold: p.threshold,
        observed_value: value,
        observed_at: now,
        context_snapshot: context,
        // The full evaluated logic, so "why did this fire?" has the same
        // answer for a compound protocol as for a single threshold: every
        // term's reading and satisfaction at the moment of the decision.
        condition_set: {
          combinator: conditionSet.combinator,
          negate: Boolean(conditionSet.negate),
          evaluable: evaluation.evaluable,
          terms: evaluation.results,
        },
        // Null, not an empty array: a count over an aggregate has no per-record
        // identity to name, and `[]` would read as "no records were involved".
        input_record_ids: null,
        engine: { module: 'src/protocols.js', rule_schema: 'protocol/1' },
      },
    }
    alerts.push(alert)

    const playbookActions = p.action_playbook || []
    const actionsResults = []
    // The label registry is what lets a `task` name the intervention it belongs
    // to. Without it a task attaches to "the most recent intervention anywhere
    // in the store", which is how a task ends up filed against last week's
    // response. Labels are scoped to THIS execution and discarded after it.
    const interventionLabels = new Map()
    let anyRefused = false

    for (const action of playbookActions) {
      if (action.type === 'notify') {
        // Refused, not skipped, when RapidPro is not configured. The alert still
        // exists and is sendable by hand from the UI, so an unconfigured gateway
        // is a deferred delivery, not a failed playbook step.
        if (rapidProStatus(env)?.enabled) {
          const recipients = action.recipients || []
          const dispatch = await sendRapidProAlert(alert, { recipients })
          rapidproDispatchesArr.push(dispatch)
          actionsResults.push({ type: 'notify', status: 'executed', record_id: dispatch?.id, detail: `dispatched to ${recipients.length ? recipients.join(', ') : 'the configured default recipients'}` })
        } else {
          actionsResults.push({ type: 'notify', status: 'refused', detail: 'rapidpro not configured; alert raised, dispatch awaits manual send' })
          anyRefused = true
        }
      } else if (action.type === 'intervention') {
        if (!action.title) {
          // `title` is required by the plan. An intervention with no title is a
          // row an operator cannot act on, so the step refuses rather than
          // writing one named after the protocol.
          actionsResults.push({ type: 'intervention', status: 'refused', detail: 'intervention action requires a title' })
          anyRefused = true
          continue
        }
        // The incident first: an intervention is a response TO something, and
        // the incident is that something. Created as the source of the
        // intervention so the chain incident → intervention → task is real
        // rather than an intervention referencing an id nothing points at.
        const incidentRecord = buildCreate('incidents', {
          title: action.title,
          description: action.objective || p.description || '',
          source: 'protocol_engine',
          severity: p.severity,
          occurred_at: now,
        }, data)
        const interventionRecord = buildCreate('interventions', {
          incident_id: incidentRecord.id,
          title: action.title,
          objective: action.objective || p.description || '',
          priority: action.priority || p.severity,
          lead_org: action.lead_org || null,
          district: action.district || null,
        }, data)
        incidentsArr.push(incidentRecord)
        interventionsArr.push(interventionRecord)
        // `a.id` is the label the playbook uses to refer to this intervention.
        // Also registered under the most-recent slot so a task with no `for`
        // attaches to the last one created here, which is the plan's default.
        if (action.id) interventionLabels.set(action.id, interventionRecord)
        interventionLabels.set('__latest__', interventionRecord)
        actionsResults.push({ type: 'intervention', status: 'executed', record_id: interventionRecord.id, detail: `incident ${incidentRecord.id} and intervention created` })
      } else if (action.type === 'task') {
        if (!action.title) {
          actionsResults.push({ type: 'task', status: 'refused', detail: 'task action requires a title' })
          anyRefused = true
          continue
        }
        // `for` names a label; without it, the most recent intervention this
        // execution created. Unresolvable is refused with the reason, never
        // attached to a null.
        const target = action.for ? interventionLabels.get(action.for) : interventionLabels.get('__latest__')
        if (!target) {
          actionsResults.push({ type: 'task', status: 'refused', detail: action.for ? `no intervention labelled "${action.for}" in this playbook` : 'no intervention in this execution to attach the task to' })
          anyRefused = true
          continue
        }
        const taskRecord = buildCreate('intervention_tasks', {
          intervention_id: target.id,
          title: action.title,
          description: action.description || '',
          due_at: action.due_at || null,
          owner: action.owner || null,
        }, data)
        tasksArr.push(taskRecord)
        actionsResults.push({ type: 'task', status: 'executed', record_id: taskRecord.id, detail: `attached to intervention ${target.id}` })
      } else {
        // One refusal does not abort the playbook. A protocol that opens an
        // incident and then hits an unknown action type has still done the
        // important part, and the execution row's status is what records which
        // part that was.
        actionsResults.push({ type: action.type || 'unknown', status: 'refused', detail: 'unknown action type' })
        anyRefused = true
      }
    }

    // What authorisation DID, on the alert itself. `actionsResults` is the same
    // array the execution row records below, and the alert was already pushed
    // into `alerts`, so the single merge at the end of the run covers it — no
    // second write exists or is needed. The alert card and the explain view
    // read this first and the execution row only as a fallback.
    alert.metadata.playbook_results = actionsResults

    // The execution status is computed from the RESULTS, not from the playbook
    // input. The first version of this checked `playbookActions.some(a =>
    // a.status === 'executed')`, and playbook entries are the operator's own
    // JSON — they have no `status` field at all, so the expression was always
    // false and a playbook that ran two steps and refused one reported
    // `refused` rather than `partial`. The distinction matters to the UI: the
    // execution feed colours them differently, and `refused` reads as "nothing
    // happened".
    //
    // A playbook with no actions at all is `executed`: the alert was raised and
    // pre-authorised, which is the whole of the claim.
    const executedCount = actionsResults.filter((r) => r.status === 'executed').length
    const executionStatus = !anyRefused ? 'executed' : (executedCount > 0 ? 'partial' : 'refused')

    logsArr.push(actionLog('protocol_executions', 'created', {
      id: executionId,
      protocol_id: p.id,
      protocol_name: p.name,
      status: executionStatus,
      alert_id: alert.id,
      observed_value: value,
      actions: actionsResults,
    }, 'protocol-engine', subject))

    const executionRow = {
      id: executionId,
      protocol_id: p.id,
      protocol_name: p.name,
      protocol_version: p.version || 1,
      mode: 'live', fired_at: now,
      status: executionStatus,
      metric: p.metric, operator: p.operator, threshold: p.threshold,
      observed_value: value,
      condition_set: {
        combinator: conditionSet.combinator,
        negate: Boolean(conditionSet.negate),
        evaluable: evaluation.evaluable,
        terms: evaluation.results,
      },
      alert_id: alert.id,
      dry_run: Boolean(dryRun),
      actions: actionsResults,
      actor: 'protocol-engine',
      created_at: now,
    }
    executionsRows.push(executionRow)
    results.push({ protocol_id: p.id, mode: 'live', status: executionStatus, alert_id: alert.id, actions: actionsResults })
  }

  // ONE merge for the whole run, not one per protocol. The vision document is
  // explicit: "then one `store.merge` of everything". Per-protocol merging
  // would make a three-protocol run three separate commits, so a crash between
  // them leaves half the playbooks committed and the alert that justified them
  // missing — the exact partial state a single merge exists to make impossible.
  // Nothing to merge means nothing is written. `store.merge` with seven empty
  // arrays still rewrites the file and bumps `updated_at`, so a run in which no
  // protocol fired would leave a store that *looks* modified — and a
  // not-firing protocol is meant to write nothing at all. The guard is on the
  // rows, not on the collections: a shadow-mode run always has an execution row,
  // so shadow mode still records what would have fired.
  const hasRows = executionsRows.length > 0 || alerts.length > 0

  if (!dryRun && hasRows) {
    await store.merge({
      alert_events: alerts,
      protocol_executions: executionsRows,
      rapidpro_dispatches: rapidproDispatchesArr,
      incidents: incidentsArr,
      interventions: interventionsArr,
      intervention_tasks: tasksArr,
      action_logs: logsArr,
    })
    // One row per protocol execution, so the audit chain records which
    // pre-authorisation produced which records. Emitted in a try/catch with a
    // counted failure, exactly like `evaluateAndPersistAlerts` does for
    // `alert_event.created`: the state is already true, so a missing
    // notification is a gap to count, not a reason to abandon the merge.
    for (const execution of executionsRows) {
      try {
        await emit(store, 'protocol.executed', { execution_id: execution.id, protocol_id: execution.protocol_id })
      } catch (emitError) {
        metrics.counter('outbox_emit_failed_total', { event: 'protocol.executed' })
        logger.error({ err: emitError, event: 'protocol.executed' }, 'outbox emit failed; the execution is stored and no subscriber was told')
      }
    }
  }

  return { executions: executionsRows, dry_run: Boolean(dryRun) }
}
