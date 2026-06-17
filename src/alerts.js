import { ALERT_EVENT_STATUSES, ALERT_RULE_STATUSES, PRIORITY_LEVELS } from './schema.js'
import { stableId, toNumber } from './utils.js'

const OPERATORS = Object.freeze(['>', '>=', '<', '<=', '==', '!='])

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
      metadata: {},
    })
  }
  return events
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
