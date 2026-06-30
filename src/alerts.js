import { ALERT_EVENT_STATUSES, ALERT_RULE_STATUSES, PRIORITY_LEVELS } from './schema.js'
import { stableId, toNumber } from './utils.js'

const OPERATORS = Object.freeze(['>', '>=', '<', '<=', '==', '!='])
const TRIGGER_MODES = Object.freeze(['shadow', 'live'])

export function normalizeAlertRule(input, existing = null) {
  const now = new Date().toISOString()
  const metric = input.metric || input.metric_path || existing?.metric
  const operator = input.operator || existing?.operator || '>='
  if (!metric) throw Object.assign(new Error('metric is required'), { statusCode: 400 })
  if (!OPERATORS.includes(operator)) throw Object.assign(new Error(`operator must be one of ${OPERATORS.join(', ')}`), { statusCode: 400 })
  const threshold = toNumber(input.threshold ?? existing?.threshold)
  if (!Number.isFinite(threshold)) throw Object.assign(new Error('threshold is required and must be numeric'), { statusCode: 400 })
  const severity = normalizeSeverity(input.severity || existing?.severity || 'medium')
  return {
    id: input.id || stableId('alert_rule', [input.name, metric, operator, threshold]),
    name: input.name || existing?.name || metric,
    description: input.description || existing?.description || '',
    status: enumValue(input.status || existing?.status || 'active', ALERT_RULE_STATUSES, 'status'),
    metric,
    operator,
    threshold,
    severity,
    scope: objectValue(input.scope || existing?.scope),
    actions: arrayValue(input.actions || existing?.actions),
    suppression_minutes: toNumber(input.suppression_minutes ?? existing?.suppression_minutes, 120),
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    metadata: objectValue(input.metadata || existing?.metadata),
  }
}

export function updateAlertEvent(existing, patch) {
  if (!existing) throw Object.assign(new Error('Record not found'), { statusCode: 404 })
  return {
    ...existing,
    status: enumValue(patch.status || existing.status, ALERT_EVENT_STATUSES, 'status'),
    owner: patch.owner || existing.owner || null,
    resolution_note: patch.resolution_note || existing.resolution_note || null,
    updated_at: new Date().toISOString(),
  }
}

export function approveAlertEvent(existing, actor, decision, note = '') {
  if (!existing) throw Object.assign(new Error('Record not found'), { statusCode: 404 })
  const currentState = existing.approval?.state || 'proposed'
  const validDecisions = ['approved', 'rejected']
  if (!validDecisions.includes(decision)) {
    throw Object.assign(new Error(`decision must be one of ${validDecisions.join(', ')}`), { statusCode: 400 })
  }
  if (currentState === 'approved' || currentState === 'rejected') {
    throw Object.assign(new Error(`Cannot transition from ${currentState} state`), { statusCode: 409 })
  }
  return {
    ...existing,
    approval: {
      state: decision,
      reviewer: actor,
      reviewed_at: new Date().toISOString(),
      decision_note: note || '',
    },
    updated_at: new Date().toISOString(),
  }
}

export function evaluateAlertRules(data, context) {
  const now = new Date().toISOString()
  const active = data.alert_rules.filter((rule) => rule.status === 'active')
  const events = []
  for (const rule of active) {
    const value = resolveMetric(context, rule.metric)
    if (!Number.isFinite(value) || !compare(value, rule.operator, rule.threshold)) continue
    const bucket = suppressionBucket(now, rule.suppression_minutes)
    const existing = data.alert_events.find((event) => event.rule_id === rule.id && event.suppression_bucket === bucket)
    if (existing) continue
    const approvalState = rule.severity === 'low' ? 'auto_approved' : 'proposed'
    events.push({
      id: stableId('alert', [rule.id, bucket, value]),
      rule_id: rule.id,
      rule_name: rule.name,
      status: 'open',
      severity: rule.severity,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      operator: rule.operator,
      message: `${rule.name}: ${rule.metric} ${rule.operator} ${rule.threshold} (actual ${value})`,
      actions: rule.actions,
      scope: rule.scope,
      created_at: now,
      updated_at: now,
      suppression_bucket: bucket,
      approval: { state: approvalState },
      metadata: {},
    })
  }
  return events
}

export function normalizeTriggerProtocol(input, existing = null) {
  const now = new Date().toISOString()
  const metric = input.metric || existing?.metric
  const operator = input.operator || existing?.operator || '>='
  if (!metric) throw Object.assign(new Error('metric is required'), { statusCode: 400 })
  if (!OPERATORS.includes(operator)) throw Object.assign(new Error(`operator must be one of ${OPERATORS.join(', ')}`), { statusCode: 400 })
  const threshold = toNumber(input.threshold ?? existing?.threshold)
  if (!Number.isFinite(threshold)) throw Object.assign(new Error('threshold is required and must be numeric'), { statusCode: 400 })
  const severity = normalizeSeverity(input.severity || existing?.severity || 'medium')
  const mode = enumValue(input.mode || existing?.mode || 'live', TRIGGER_MODES, 'mode')
  const leadTimeDays = toNumber(input.lead_time_days ?? existing?.lead_time_days, 3)
  return {
    id: input.id || stableId('trigger_protocol', [input.name, metric, operator, threshold]),
    name: input.name || existing?.name || metric,
    version: input.version || existing?.version || 1,
    description: input.description || existing?.description || '',
    metric,
    operator,
    threshold,
    severity,
    lead_time_days: leadTimeDays,
    mode,
    rule_ids: arrayValue(input.rule_ids || existing?.rule_ids),
    action_playbook: arrayValue(input.action_playbook || existing?.action_playbook),
    approvers: arrayValue(input.approvers || existing?.approvers),
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    backtest: objectValue(input.backtest || existing?.backtest),
  }
}

export function backtestTriggerProtocol(protocol, data) {
  const sourceRuns = data.source_runs || []
  const hazardEvents = data.hazard_events || []
  if (!sourceRuns.length || !hazardEvents.length) {
    return { samples: 0, true_positives: 0, false_positives: 0, misses: 0, precision: 0, recall: 0 }
  }
  const leadTimeMs = (protocol.lead_time_days || 3) * 24 * 60 * 60 * 1000
  let truePositives = 0
  let falsePositives = 0
  let misses = 0
  let samples = 0
  for (const run of sourceRuns) {
    if (!run.completed_at) continue
    const runDate = new Date(run.completed_at).getTime()
    samples++
    const matchedEvents = hazardEvents.filter((event) => {
      if (!event.occurred_at) return false
      const eventDate = new Date(event.occurred_at).getTime()
      return eventDate > runDate && eventDate <= runDate + leadTimeMs
    })
    if (matchedEvents.length > 0) {
      truePositives++
    } else {
      falsePositives++
    }
  }
  misses = samples - truePositives - falsePositives
  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0
  const recall = truePositives + misses > 0 ? truePositives / (truePositives + misses) : 0
  return {
    samples,
    true_positives: truePositives,
    false_positives: falsePositives,
    misses,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
  }
}

export function evaluateInShadowMode(protocol, context) {
  const value = resolveMetric(context, protocol.metric)
  const wouldFire = Number.isFinite(value) && compare(value, protocol.operator, protocol.threshold)
  return {
    would_fire: wouldFire,
    message: wouldFire ? `${protocol.name}: ${protocol.metric} ${protocol.operator} ${protocol.threshold} (actual ${value})` : 'No trigger condition met',
    computed_value: value,
    shadow: true,
  }
}

function resolveMetric(context, path) {
  return String(path).split('.').reduce((value, part) => value?.[part], context)
}

function compare(value, operator, threshold) {
  if (operator === '>') return value > threshold
  if (operator === '>=') return value >= threshold
  if (operator === '<') return value < threshold
  if (operator === '<=') return value <= threshold
  if (operator === '==') return value === threshold
  if (operator === '!=') return value !== threshold
  return false
}

function suppressionBucket(now, minutes) {
  const windowMs = Math.max(1, minutes) * 60000
  return Math.floor(Date.parse(now) / windowMs)
}

function enumValue(value, allowed, field) {
  const normalized = String(value || '').toLowerCase()
  if (!allowed.includes(normalized)) {
    throw Object.assign(new Error(`${field} must be one of ${allowed.join(', ')}`), { statusCode: 400 })
  }
  return normalized
}

function normalizeSeverity(value) {
  const normalized = String(value || 'medium').toLowerCase()
  return PRIORITY_LEVELS.includes(normalized) ? normalized : 'medium'
}

function arrayValue(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
