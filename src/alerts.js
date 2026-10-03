import { ALERT_EVENT_STATUSES, ALERT_RULE_STATUSES, PRIORITY_LEVELS } from './schema.js'
import { stableId, toNumber } from './utils.js'
import { counts } from './operations.js'

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
    // Whether this alert was a false alarm, recorded as data rather than
    // inferred from prose.
    //
    // The false-alert KPI used to scan resolution_note for /false|invalid|noop/i
    // and divide by the number of alerts. On the demo data that returned 0%,
    // which reads as "no false alerts occurred" when it means "nobody happened to
    // write the word false". None of the seeded resolutions — "situation
    // stabilised", "temperature normalised" — says whether the alert was
    // warranted at all.
    //
    // Null means not determined, which is the honest default and is what lets the
    // KPI report "not yet measurable" instead of a confident zero.
    false_alert: determination(patch.false_alert ?? existing.false_alert),
    updated_at: new Date().toISOString(),
  }
}

/**
 * Normalise a false-alert determination to true / false / null.
 *
 * Rejects anything else rather than coercing: a value like the string "maybe"
 * must not silently become `false`, which would understate the false-alert rate
 * and flatter the system.
 */
function determination(value) {
  if (value === null || value === undefined || value === '') return null
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw Object.assign(
    new Error('false_alert must be true, false, or null for "not determined"'),
    { statusCode: 400 },
  )
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

/**
 * Replays a trigger protocol over historical ingestion runs.
 *
 * This used to ignore `metric`, `operator` and `threshold` entirely and score
 * every run on "did any hazard event happen in the next lead-time window" —
 * so backtesting a protocol and backtesting a completely different one
 * produced identical numbers. It also classified every sample as either a true
 * or a false positive, which makes `misses` identically zero and `recall`
 * numerically equal to `precision` for any protocol, so the two figures could
 * never disagree and neither could mean anything.
 *
 * A backtest answers one question: does firing on this condition find events
 * that a person would want to know about? That needs the base rate. A protocol
 * with precision 0.60 when 60% of runs are followed by an event has learned
 * nothing, and a report that does not say so invites the reader to believe it
 * has.
 */
export function backtestTriggerProtocol(protocol, data, { buildContext = pointInTimeContext } = {}) {
  const hazardEvents = data.hazard_events || []
  const runs = (data.source_runs || [])
    .filter((run) => run.completed_at)
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at))

  const leadTimeMs = (protocol.lead_time_days || 3) * 24 * 60 * 60 * 1000

  let truePositives = 0
  let falsePositives = 0
  let misses = 0
  let trueNegatives = 0
  let unevaluable = 0
  const unevaluableMetrics = []

  for (const run of runs) {
    const runDate = Date.parse(run.completed_at)
    const context = buildContext(data, run)
    const value = resolveMetric(context, protocol.metric)
    if (!Number.isFinite(value)) {
      // Not a pass and not a fail: the condition could not be evaluated on
      // this run, usually because the metric did not exist yet that early.
      // Counting these as negatives would quietly punish the protocol for
      // data it could not have had.
      unevaluable += 1
      unevaluableMetrics.push(run.id)
      continue
    }

    const wouldFire = compare(value, protocol.operator, protocol.threshold)
    const eventFollowed = hazardEvents.some((event) => {
      if (!event.occurred_at) return false
      const occurred = Date.parse(event.occurred_at)
      return occurred > runDate && occurred <= runDate + leadTimeMs
    })

    if (wouldFire && eventFollowed) truePositives += 1
    else if (wouldFire) falsePositives += 1
    else if (eventFollowed) misses += 1
    else trueNegatives += 1
  }

  const evaluable = truePositives + falsePositives + misses + trueNegatives
  const positives = truePositives + misses
  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : null
  const recall = positives > 0 ? truePositives / positives : null
  // The share of runs that were followed by an event anyway. Firing on
  // everything would achieve exactly this precision.
  const baseRate = evaluable > 0 ? positives / evaluable : null

  return {
    metric: protocol.metric,
    operator: protocol.operator,
    threshold: protocol.threshold,
    lead_time_days: protocol.lead_time_days || 3,
    samples: runs.length,
    evaluable,
    unevaluable,
    unevaluable_run_ids: unevaluableMetrics,
    true_positives: truePositives,
    false_positives: falsePositives,
    misses,
    true_negatives: trueNegatives,
    // null, not 0, when the denominator is empty. A backtest with nothing to
    // evaluate has not found perfect precision.
    precision: round3(precision),
    recall: round3(recall),
    f1: precision !== null && recall !== null && precision + recall > 0
      ? round3((2 * precision * recall) / (precision + recall))
      : null,
    event_base_rate: round3(baseRate),
    // Precision above the base rate is the whole claim. 1.0 means the
    // protocol is exactly as good as firing on every run.
    precision_lift: precision !== null && baseRate > 0 ? round3(precision / baseRate) : null,
    verdict: backtestVerdict({ evaluable, unevaluable, precision, baseRate, wouldFireCount: truePositives + falsePositives }),
  }
}

function round3(value) {
  return value === null ? null : Math.round(value * 1000) / 1000
}

function backtestVerdict({ evaluable, unevaluable, precision, baseRate, wouldFireCount }) {
  if (!evaluable) {
    return 'not evaluable: no ingestion run in the store had the data this protocol measures'
  }
  if (unevaluable > evaluable) {
    return `weak evidence: only ${evaluable} of ${evaluable + unevaluable} runs could be evaluated; treat every figure below as provisional`
  }
  if (wouldFireCount === 0) {
    return 'never fired: the condition was not met on any evaluable run, so precision and recall are undefined'
  }
  if (precision !== null && baseRate !== null && precision <= baseRate * 1.05) {
    return `no better than firing always: precision ${round3(precision)} against an event base rate of ${round3(baseRate)}`
  }
  return 'outperformed firing on every run'
}

/**
 * The metric context as it stood at the end of a given run.
 *
 * Built from records whose ingest timestamp is at or before the run completed,
 * so a run is not scored against data it could not have seen. Without this the
 * backtest leaks the future into its own evaluation.
 */
function pointInTimeContext(data, run) {
  const cutoff = Date.parse(run.completed_at)
  const asOf = (record) => {
    const stamp = record.first_seen_at || record.created_at || record.observed_at || record.occurred_at
    const parsed = stamp ? Date.parse(stamp) : Number.NaN
    return !Number.isFinite(parsed) || parsed <= cutoff
  }
  const snapshot = { ...data }
  for (const [collection, records] of Object.entries(data)) {
    if (!Array.isArray(records)) continue
    snapshot[collection] = records.filter(asOf)
  }
  return { counts: counts(snapshot), data_quality: snapshot.data_quality }
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
