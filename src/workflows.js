import { stableId, toNumber } from './utils.js'

export const WORKFLOW_TYPES = Object.freeze([
  'anticipatory_alert',
  'cold_chain_protection',
  'school_feeding_continuity',
  'school_health_decision',
  'chw_outbreak_triage',
  'community_feedback_loop',
  'equity_audit_action',
  'parametric_disbursement',
])

export const WORKFLOW_STATES = Object.freeze({
  anticipatory_alert: ['signal_detected', 'focal_point_review', 'approved', 'rejected', 'dispatched', 'closed'],
  cold_chain_protection: ['temperature_breach_forecast', 'moh_notified', 'action_taken', 'closed'],
  school_feeding_continuity: ['disruption_forecast', 'district_notified', 'supplies_repositioned', 'verified', 'closed'],
  school_health_decision: ['flood_signal_detected', 'head_teacher_notified', 'schedule_shifted', 'closed'],
  chw_outbreak_triage: ['symptom_reported', 'climate_correlated', 'district_reviewed', 'triaged', 'closed'],
  community_feedback_loop: ['alert_dispatched', 'feedback_received', 'reviewed', 'closed'],
  equity_audit_action: ['threshold_breached', 'audit_scheduled', 'audit_completed', 'retrained', 'closed'],
  parametric_disbursement: ['threshold_breached', 'focal_point_confirmed', 'chain_dispatched', 'closed'],
})

export const WORKFLOW_TRANSITIONS = Object.freeze({
  anticipatory_alert: {
    signal_detected: ['focal_point_review'],
    focal_point_review: ['approved', 'rejected'],
    approved: ['dispatched'],
    rejected: ['closed'],
    dispatched: ['closed'],
    closed: [],
  },
  cold_chain_protection: {
    temperature_breach_forecast: ['moh_notified'],
    moh_notified: ['action_taken'],
    action_taken: ['closed'],
    closed: [],
  },
  school_feeding_continuity: {
    disruption_forecast: ['district_notified'],
    district_notified: ['supplies_repositioned'],
    supplies_repositioned: ['verified'],
    verified: ['closed'],
    closed: [],
  },
  school_health_decision: {
    flood_signal_detected: ['head_teacher_notified'],
    head_teacher_notified: ['schedule_shifted'],
    schedule_shifted: ['closed'],
    closed: [],
  },
  chw_outbreak_triage: {
    symptom_reported: ['climate_correlated'],
    climate_correlated: ['district_reviewed'],
    district_reviewed: ['triaged'],
    triaged: ['closed'],
    closed: [],
  },
  community_feedback_loop: {
    alert_dispatched: ['feedback_received'],
    feedback_received: ['reviewed'],
    reviewed: ['closed'],
    closed: [],
  },
  equity_audit_action: {
    threshold_breached: ['audit_scheduled'],
    audit_scheduled: ['audit_completed'],
    audit_completed: ['retrained'],
    retrained: ['closed'],
    closed: [],
  },
  parametric_disbursement: {
    threshold_breached: ['focal_point_confirmed'],
    focal_point_confirmed: ['chain_dispatched'],
    chain_dispatched: ['closed'],
    closed: [],
  },
})

export function normalizeWorkflowInstance(input, existing = null) {
  const now = new Date().toISOString()
  const type = input.type || existing?.type
  const state = input.state || existing?.state

  if (!type) throw Object.assign(new Error('type is required'), { statusCode: 400 })
  if (!WORKFLOW_TYPES.includes(type)) throw Object.assign(new Error(`type must be one of ${WORKFLOW_TYPES.join(', ')}`), { statusCode: 400 })

  const validStates = WORKFLOW_STATES[type] || []
  const initialState = validStates[0] || 'pending'
  const resolvedState = state || initialState

  if (!validStates.includes(resolvedState)) {
    throw Object.assign(new Error(`state must be one of ${validStates.join(', ')} for type ${type}`), { statusCode: 400 })
  }

  return {
    id: input.id || stableId('workflow', [type, input.subject_kind, input.subject_id, now]),
    type,
    subject_kind: input.subject_kind || existing?.subject_kind || 'alert_event',
    subject_id: input.subject_id || existing?.subject_id || '',
    state: resolvedState,
    district: input.district || existing?.district || '',
    owner: input.owner || existing?.owner || '',
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    closed_at: existing?.closed_at || null,
    transitions: input.transitions || existing?.transitions || [],
    metadata: input.metadata || existing?.metadata || {},
  }
}

export function transitionWorkflow(instance, { to, actor, reason, evidence }) {
  if (!instance) throw Object.assign(new Error('Workflow not found'), { statusCode: 404 })

  const type = instance.type
  const fromState = instance.state
  const stateTransitions = WORKFLOW_TRANSITIONS[type]

  if (!stateTransitions || !stateTransitions[fromState]) {
    throw Object.assign(new Error(`No transitions defined for state ${fromState}`), { statusCode: 409 })
  }

  const allowedNextStates = stateTransitions[fromState] || []
  if (!allowedNextStates.includes(to)) {
    throw Object.assign(new Error(`Cannot transition from ${fromState} to ${to}`), { statusCode: 409 })
  }

  const now = new Date().toISOString()
  const terminalStates = ['closed', 'rejected']
  const isTerminal = terminalStates.includes(to)

  return {
    ...instance,
    state: to,
    updated_at: now,
    closed_at: isTerminal ? now : instance.closed_at,
    transitions: [
      ...instance.transitions,
      {
        from: fromState,
        to,
        actor: actor || '',
        reason: reason || '',
        evidence: evidence || '',
        timestamp: now,
      },
    ],
  }
}

export function pendingForFocalPoint(instances, district) {
  return instances.filter((w) =>
    w.type === 'anticipatory_alert' &&
    w.state === 'focal_point_review' &&
    w.district === district
  )
}

export function workflowMetrics(instances) {
  const counts = {
    open: 0,
    closed: 0,
    rejected: 0,
    by_type: {},
  }

  for (const instance of instances) {
    const type = instance.type
    if (!counts.by_type[type]) {
      counts.by_type[type] = { open: 0, closed: 0, rejected: 0 }
    }

    if (instance.state === 'closed') {
      counts.closed += 1
      counts.by_type[type].closed += 1
    } else if (instance.state === 'rejected') {
      counts.rejected += 1
      counts.by_type[type].rejected += 1
    } else {
      counts.open += 1
      counts.by_type[type].open += 1
    }
  }

  return counts
}
