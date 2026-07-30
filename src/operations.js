import {
  INCIDENT_STATUSES,
  INTERVENTION_STATUSES,
  PRIORITY_LEVELS,
  RESOURCE_STATUSES,
  TASK_STATUSES,
  normalizeSeverity,
  riskLevel,
} from './schema.js'
import { stableId, toNumber } from './utils.js'

const OPERATIONAL_COLLECTIONS = Object.freeze({
  incidents: 'incident',
  interventions: 'intervention',
  intervention_tasks: 'task',
  field_reports: 'report',
  response_resources: 'resource',
})

export function operationalSummary(data) {
  const openIncidents = data.incidents.filter((item) => !['closed', 'stabilized'].includes(item.status))
  const activeInterventions = data.interventions.filter((item) => ['planned', 'active', 'paused'].includes(item.status))
  const overdueTasks = data.intervention_tasks.filter((item) => !['done', 'cancelled'].includes(item.status) && item.due_at && Date.parse(item.due_at) < Date.now())
  const deployedResources = data.response_resources.filter((item) => item.status === 'deployed')
  return {
    generated_at: new Date().toISOString(),
    counts: {
      open_incidents: openIncidents.length,
      active_interventions: activeInterventions.length,
      overdue_tasks: overdueTasks.length,
      deployed_resources: deployedResources.length,
      field_reports: data.field_reports.length,
    },
    critical_open_incidents: openIncidents.filter((item) => item.priority === 'critical').length,
    by_status: {
      incidents: countBy(data.incidents, 'status'),
      interventions: countBy(data.interventions, 'status'),
      tasks: countBy(data.intervention_tasks, 'status'),
      resources: countBy(data.response_resources, 'status'),
    },
  }
}

export function buildCreate(collection, input, data) {
  if (collection === 'incidents') return normalizeIncident(input, data)
  if (collection === 'interventions') return normalizeIntervention(input, data)
  if (collection === 'intervention_tasks') return normalizeTask(input, data)
  if (collection === 'field_reports') return normalizeFieldReport(input, data)
  if (collection === 'response_resources') return normalizeResource(input)
  throw new Error(`Unsupported operational collection: ${collection}`)
}

export function buildUpdate(collection, existing, patch, data) {
  if (!existing) throw Object.assign(new Error('Record not found'), { statusCode: 404 })
  const merged = { ...existing, ...patch, updated_at: new Date().toISOString() }
  if (collection === 'incidents') return normalizeIncident(merged, data, existing)
  if (collection === 'interventions') return normalizeIntervention(merged, data, existing)
  if (collection === 'intervention_tasks') return normalizeTask(merged, data, existing)
  if (collection === 'field_reports') return normalizeFieldReport(merged, data, existing)
  if (collection === 'response_resources') return normalizeResource(merged, existing)
  throw new Error(`Unsupported operational collection: ${collection}`)
}

export function actionLog(collection, action, record, actor = 'operator', subject = null) {
  const now = new Date().toISOString()
  return {
    id: stableId('log', [collection, action, record.id, now]),
    collection,
    record_id: record.id,
    action,
    actor,
    subject,
    created_at: now,
    summary: `${action} ${OPERATIONAL_COLLECTIONS[collection] || 'record'} ${record.id}`,
    metadata: {
      status: record.status || null,
      priority: record.priority || null,
    },
  }
}

function normalizeIncident(input, data, existing = null) {
  const linked = linkedContext(input, data)
  const now = new Date().toISOString()
  const severity = normalizeSeverity(input.severity || linked.severity || input.risk_level)
  const priority = normalizePriority(input.priority || severityToPriority(severity) || linked.priority)
  const latitude = toNumber(input.latitude ?? input.lat ?? linked.latitude)
  const longitude = toNumber(input.longitude ?? input.lon ?? input.lng ?? linked.longitude)
  const title = input.title || linked.title || required(input.incident_type, 'title or incident_type')
  const createdAt = existing?.created_at || input.created_at || now
  return stripUndefined({
    id: input.id || stableId('incident', [title, input.occurred_at || linked.occurred_at || createdAt, latitude, longitude]),
    source: input.source || linked.source || 'operator',
    incident_type: input.incident_type || linked.incident_type || 'operational_incident',
    title,
    description: input.description || linked.description || '',
    status: enumValue(input.status || existing?.status || 'open', INCIDENT_STATUSES, 'status'),
    severity,
    priority,
    country: input.country || linked.country || null,
    admin1: input.admin1 || linked.admin1 || null,
    latitude,
    longitude,
    occurred_at: isoDate(input.occurred_at || linked.occurred_at || createdAt, 'occurred_at'),
    owner: input.owner || existing?.owner || null,
    linked_event_id: input.linked_event_id || linked.linked_event_id || null,
    risk_score_id: input.risk_score_id || linked.risk_score_id || null,
    service_asset_ids: arrayValue(input.service_asset_ids || existing?.service_asset_ids),
    tags: arrayValue(input.tags || existing?.tags),
    created_at: createdAt,
    updated_at: input.updated_at || now,
    metadata: objectValue(input.metadata || existing?.metadata),
  })
}

function normalizeIntervention(input, data, existing = null) {
  const incident = findById(data.incidents, input.incident_id)
  if (!input.incident_id) required(input.incident_id, 'incident_id')
  const now = new Date().toISOString()
  const title = input.title || required(incident?.title, 'title')
  return stripUndefined({
    id: input.id || stableId('intervention', [input.incident_id, title, input.start_at || now]),
    incident_id: input.incident_id,
    title,
    objective: input.objective || input.description || '',
    status: enumValue(input.status || existing?.status || 'planned', INTERVENTION_STATUSES, 'status'),
    priority: normalizePriority(input.priority || incident?.priority || existing?.priority),
    lead_org: input.lead_org || existing?.lead_org || null,
    partners: arrayValue(input.partners || existing?.partners),
    service_asset_ids: arrayValue(input.service_asset_ids || incident?.service_asset_ids || existing?.service_asset_ids),
    start_at: optionalIsoDate(input.start_at || existing?.start_at),
    target_end_at: optionalIsoDate(input.target_end_at || existing?.target_end_at),
    completed_at: optionalIsoDate(input.completed_at || existing?.completed_at),
    budget_usd: toNumber(input.budget_usd ?? existing?.budget_usd),
    success_metrics: objectValue(input.success_metrics || existing?.success_metrics),
    outcome_summary: input.outcome_summary || existing?.outcome_summary || null,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    metadata: objectValue(input.metadata || existing?.metadata),
  })
}

function normalizeTask(input, data, existing = null) {
  if (!input.intervention_id) required(input.intervention_id, 'intervention_id')
  const intervention = findById(data.interventions, input.intervention_id)
  const now = new Date().toISOString()
  return stripUndefined({
    id: input.id || stableId('task', [input.intervention_id, input.title, input.due_at || now]),
    intervention_id: input.intervention_id,
    incident_id: input.incident_id || intervention?.incident_id || existing?.incident_id || null,
    title: input.title || required(existing?.title, 'title'),
    description: input.description || existing?.description || '',
    status: enumValue(input.status || existing?.status || 'todo', TASK_STATUSES, 'status'),
    priority: normalizePriority(input.priority || intervention?.priority || existing?.priority),
    owner: input.owner || existing?.owner || null,
    due_at: optionalIsoDate(input.due_at || existing?.due_at),
    completed_at: optionalIsoDate(input.completed_at || existing?.completed_at),
    action_type: input.action_type || existing?.action_type || 'response_action',
    linked_asset_id: input.linked_asset_id || existing?.linked_asset_id || null,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    metadata: objectValue(input.metadata || existing?.metadata),
  })
}

const DEMOGRAPHIC_AGE_BANDS = ['u5', '5-17', '18-59', '60+', 'unknown']
const DEMOGRAPHIC_GENDERS = ['female', 'male', 'other', 'unknown']

function normalizeDemographics(input) {
  if (!input) return undefined
  const age_band = DEMOGRAPHIC_AGE_BANDS.includes(input.age_band) ? input.age_band : 'unknown'
  const gender = DEMOGRAPHIC_GENDERS.includes(input.gender) ? input.gender : 'unknown'
  const pwd = input.pwd == null ? null : Boolean(input.pwd)
  const refugee_or_idp = input.refugee_or_idp == null ? null : Boolean(input.refugee_or_idp)
  return { age_band, gender, pwd, refugee_or_idp }
}

function normalizeFieldReport(input, data, existing = null) {
  if (!input.incident_id && !input.intervention_id) {
    throw Object.assign(new Error('incident_id or intervention_id is required'), { statusCode: 400 })
  }
  const intervention = findById(data.interventions, input.intervention_id)
  const now = new Date().toISOString()

  // Demographics: accept from input or preserve existing; aggregate-safe categoricals, not PII
  const demographics = input.demographics != null
    ? normalizeDemographics(input.demographics)
    : existing?.demographics

  return stripUndefined({
    id: input.id || stableId('report', [input.incident_id, input.intervention_id, input.summary, input.observed_at || now]),
    incident_id: input.incident_id || intervention?.incident_id || null,
    intervention_id: input.intervention_id || null,
    summary: input.summary || required(input.description, 'summary'),
    reported_by: input.reported_by || 'operator',
    observed_at: isoDate(input.observed_at || now, 'observed_at'),
    needs: arrayValue(input.needs || existing?.needs),
    impact: objectValue(input.impact || existing?.impact),
    latitude: toNumber(input.latitude ?? input.lat ?? existing?.latitude),
    longitude: toNumber(input.longitude ?? input.lon ?? input.lng ?? existing?.longitude),
    demographics,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: now,
    metadata: objectValue(input.metadata),
  })
}

function normalizeResource(input, existing = null) {
  const now = new Date().toISOString()
  return stripUndefined({
    id: input.id || stableId('resource', [input.name, input.resource_type || input.type, input.location_name || input.country]),
    name: input.name || required(existing?.name, 'name'),
    resource_type: input.resource_type || input.type || existing?.resource_type || 'supply',
    status: enumValue(input.status || existing?.status || 'available', RESOURCE_STATUSES, 'status'),
    quantity: toNumber(input.quantity ?? existing?.quantity, 0),
    unit: input.unit || existing?.unit || 'unit',
    country: input.country || existing?.country || null,
    location_name: input.location_name || existing?.location_name || null,
    latitude: toNumber(input.latitude ?? input.lat ?? existing?.latitude),
    longitude: toNumber(input.longitude ?? input.lon ?? input.lng ?? existing?.longitude),
    assigned_intervention_id: input.assigned_intervention_id || existing?.assigned_intervention_id || null,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: input.updated_at || now,
    metadata: objectValue(input.metadata || existing?.metadata),
  })
}

function linkedContext(input, data) {
  const event = findById([...data.hazard_events, ...data.conflict_events], input.linked_event_id || input.source_event_id)
  const risk = findById(data.risk_scores, input.risk_score_id)
  return {
    source: event?.source || risk?.type,
    incident_type: event?.event_type || risk?.type,
    title: event?.title || risk?.region_name,
    description: event?.description || risk?.methodology,
    severity: event?.severity || risk?.risk_level,
    priority: risk?.risk_level,
    country: event?.country || risk?.country,
    admin1: event?.admin1,
    latitude: event?.latitude ?? risk?.latitude,
    longitude: event?.longitude ?? risk?.longitude,
    occurred_at: event?.occurred_at || risk?.generated_at,
    linked_event_id: event?.id || null,
    risk_score_id: risk?.id || null,
  }
}

function findById(records = [], id) {
  if (!id) return null
  return records.find((record) => record.id === id) || null
}

function required(value, field) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 })
  }
  return value
}

function enumValue(value, allowed, field) {
  const normalized = String(value || '').toLowerCase()
  if (!allowed.includes(normalized)) {
    throw Object.assign(new Error(`${field} must be one of ${allowed.join(', ')}`), { statusCode: 400 })
  }
  return normalized
}

function normalizePriority(value = 'medium') {
  const normalized = String(value || 'medium').toLowerCase()
  if (PRIORITY_LEVELS.includes(normalized)) return normalized
  return riskLevel(toNumber(value, 35))
}

function severityToPriority(severity) {
  if (severity === 'critical') return 'critical'
  if (severity === 'high') return 'high'
  if (severity === 'medium') return 'medium'
  return 'low'
}

function isoDate(value, field) {
  const parsed = new Date(required(value, field))
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${field} must be a valid date`), { statusCode: 400 })
  return parsed.toISOString()
}

function optionalIsoDate(value) {
  if (!value) return null
  return isoDate(value, 'date')
}

function arrayValue(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function stripUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function countBy(records, key) {
  return records.reduce((counts, record) => {
    const value = record[key] || 'unknown'
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
}
