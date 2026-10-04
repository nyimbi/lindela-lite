import {
  REPORT_DISTRIBUTION_STATUSES,
  REPORT_SCHEDULE_RUN_STATUSES,
  REPORT_SCHEDULE_STATUSES,
  REPORT_STATUSES,
  REPORT_TEMPLATE_STATUSES,
  REPORT_TYPES,
} from './schema.js'
import { filterRecords, stableId, toNumber, haversineKm } from './utils.js'
import { resolveDistrict } from './districts.js'
import {
  MATCH_RADIUS_KM,
  MIN_EVENTS,
  MIN_MONTHS,
  MODEL_BASIS,
  MODEL_BASIS_DISCHARGE,
} from './flood-probability.js'

export const SECTION_LIBRARY = Object.freeze([
  'executive_summary',
  'risk_summary',
  'events_summary',
  'incident_summary',
  'intervention_summary',
  'service_impact_summary',
  'field_report_summary',
  'rapidpro_activity_summary',
  'alert_summary',
  'data_quality_summary',
  'recommended_actions',
  'appendix_sources',
])

export const DEFAULT_REPORT_SECTIONS = Object.freeze({
  situation_report: [
    'executive_summary',
    'risk_summary',
    'events_summary',
    'incident_summary',
    'intervention_summary',
    'service_impact_summary',
    'field_report_summary',
    'alert_summary',
    'recommended_actions',
    'data_quality_summary',
  ],
  incident_brief: [
    'executive_summary',
    'events_summary',
    'incident_summary',
    'field_report_summary',
    'intervention_summary',
    'rapidpro_activity_summary',
    'recommended_actions',
    'appendix_sources',
  ],
  intervention_update: [
    'executive_summary',
    'intervention_summary',
    'field_report_summary',
    'service_impact_summary',
    'recommended_actions',
    'appendix_sources',
  ],
  data_quality_report: [
    'executive_summary',
    'data_quality_summary',
    'appendix_sources',
  ],
  alert_digest: [
    'executive_summary',
    'alert_summary',
    'rapidpro_activity_summary',
    'recommended_actions',
    'appendix_sources',
  ],
})

export function normalizeReportTemplate(input = {}, existing = null) {
  const now = new Date().toISOString()
  const reportType = enumValue(input.report_type || existing?.report_type || 'situation_report', REPORT_TYPES, 'report_type')
  const name = input.name || required(existing?.name, 'name')
  const createdAt = existing?.created_at || input.created_at || now
  return stripUndefined({
    id: existing?.id || input.id || stableId('report_template', [name, reportType, createdAt]),
    name,
    report_type: reportType,
    status: enumValue(input.status || existing?.status || 'active', REPORT_TEMPLATE_STATUSES, 'status'),
    version: existing ? Number(existing.version || 1) + 1 : Number(input.version || 1),
    title_pattern: input.title_pattern || existing?.title_pattern || defaultTitlePattern(reportType),
    default_filters: objectValue(input.default_filters ?? existing?.default_filters),
    sections: sectionList(input.sections || existing?.sections || DEFAULT_REPORT_SECTIONS[reportType]),
    distribution_defaults: arrayValue(input.distribution_defaults ?? existing?.distribution_defaults),
    schedule_defaults: objectValue(input.schedule_defaults ?? existing?.schedule_defaults),
    owner: input.owner || existing?.owner || 'ops',
    created_at: createdAt,
    updated_at: now,
    metadata: objectValue(input.metadata ?? existing?.metadata),
  })
}

export function normalizeReport(input = {}, data, existing = null) {
  const now = new Date().toISOString()
  const template = findById(data.report_templates, input.template_id || existing?.template_id)
  const reportType = enumValue(input.report_type || existing?.report_type || template?.report_type || 'situation_report', REPORT_TYPES, 'report_type')
  const scope = objectValue({
    ...(template?.default_filters || {}),
    ...(existing?.scope || {}),
    ...(input.scope || scopeFromInput(input)),
  })
  const createdAt = existing?.created_at || input.created_at || now
  const title = input.title || existing?.title || renderTitle(template?.title_pattern || defaultTitlePattern(reportType), scope, now)
  const sectionIds = sectionList(input.section_ids || input.sections?.map?.((section) => section.id) || existing?.section_ids || template?.sections || DEFAULT_REPORT_SECTIONS[reportType])
  const sections = arrayValue(input.sections ?? existing?.sections)
  const status = enumValue(input.status || existing?.status || 'draft', REPORT_STATUSES, 'status')
  // A report with no sections renders as a title and four metadata lines, and its
  // SMS summary has no figures to draw. `approveReport` has always refused to
  // approve one, but POST and PATCH set `status` directly through this function,
  // so a client could declare a report `distributed` with no content and no
  // warnings — an empty SITREP that looked finished to every consumer.
  if (['approved', 'distributed'].includes(status) && !sections.length) {
    throw Object.assign(new Error('Report must be generated before approval or distribution'), { statusCode: 400 })
  }
  return stripUndefined({
    id: existing?.id || input.id || stableId('report', [template?.id, reportType, title, createdAt]),
    template_id: template?.id || input.template_id || existing?.template_id || null,
    report_type: reportType,
    status,
    title,
    scope,
    section_ids: sectionIds,
    sections,
    source_refs: arrayValue(input.source_refs ?? existing?.source_refs),
    warnings: arrayValue(input.warnings ?? existing?.warnings),
    narrative: objectValue(input.narrative ?? existing?.narrative),
    distribution_defaults: arrayValue(input.distribution_defaults ?? existing?.distribution_defaults ?? template?.distribution_defaults),
    generated_at: input.generated_at || existing?.generated_at || null,
    approved_at: input.approved_at || existing?.approved_at || null,
    distributed_at: input.distributed_at || existing?.distributed_at || null,
    owner: input.owner || existing?.owner || template?.owner || 'ops',
    created_at: createdAt,
    updated_at: now,
    metadata: objectValue(input.metadata ?? existing?.metadata),
  })
}

export function updateReport(existing, patch = {}, data) {
  if (!existing) throw Object.assign(new Error('Report not found'), { statusCode: 404 })
  const nextStatus = patch.status || existing.status
  if (['approved', 'distributed'].includes(existing.status) && nextStatus !== 'archived') {
    throw Object.assign(new Error('Approved or distributed reports are immutable except archival'), { statusCode: 409 })
  }
  return normalizeReport({ ...existing, ...patch, id: existing.id }, data, existing)
}

export function generateReportSections(report, data, patch = {}) {
  const now = new Date().toISOString()
  const draft = normalizeReport({ ...report, ...patch, id: report.id, generated_at: now }, data, report)
  const context = resolveReportContext(data, draft.scope)
  const sections = draft.section_ids.map((sectionId) => buildSection(sectionId, context, draft, now))
  const sourceRefs = uniqueRefs(sections.flatMap((section) => section.source_refs || []))
  const warnings = buildReportWarnings(context, sourceRefs)
  return {
    ...draft,
    status: draft.status === 'draft' ? 'ready' : draft.status,
    sections,
    source_refs: sourceRefs,
    warnings,
    generated_at: now,
    updated_at: now,
  }
}

export function approveReport(report, actor = 'operator') {
  if (!report.sections?.length) {
    throw Object.assign(new Error('Report must be generated before approval'), { statusCode: 400 })
  }
  if (!['ready', 'approved'].includes(report.status)) {
    throw Object.assign(new Error('Only ready reports can be approved'), { statusCode: 400 })
  }
  const now = new Date().toISOString()
  return { ...report, status: 'approved', approved_at: report.approved_at || now, approved_by: actor, updated_at: now }
}

export function markReportDistributed(report) {
  const now = new Date().toISOString()
  return { ...report, status: 'distributed', distributed_at: report.distributed_at || now, updated_at: now }
}

export function normalizeDistributionRun(input = {}, report, existing = null) {
  const now = new Date().toISOString()
  const channel = input.channel || existing?.channel || required(null, 'channel')
  return stripUndefined({
    id: existing?.id || input.id || stableId('report_distribution', [report.id, channel, now]),
    report_id: report.id,
    template_id: report.template_id || null,
    channel,
    recipients: objectValue(input.recipients ?? existing?.recipients),
    status: enumValue(input.status || existing?.status || 'prepared', REPORT_DISTRIBUTION_STATUSES, 'status'),
    payload_summary: input.payload_summary || existing?.payload_summary || formatReportSmsSummary(report),
    response_status: input.response_status ?? existing?.response_status ?? null,
    response_body: input.response_body ?? existing?.response_body ?? null,
    error: input.error || existing?.error || null,
    retry_of: input.retry_of || existing?.retry_of || null,
    options: objectValue(input.options ?? existing?.options),
    created_at: existing?.created_at || input.created_at || now,
    updated_at: now,
  })
}

export function normalizeReportSchedule(input = {}, data, existing = null) {
  const now = new Date().toISOString()
  const template = findById(data.report_templates, input.template_id || existing?.template_id)
  if (!template) throw Object.assign(new Error('template_id is required'), { statusCode: 400 })
  const recurrence = objectValue(input.recurrence ?? existing?.recurrence ?? { type: 'daily', time: '07:00' })
  const schedule = stripUndefined({
    id: existing?.id || input.id || stableId('report_schedule', [template.id, recurrence, now]),
    template_id: template.id,
    status: enumValue(input.status || existing?.status || 'active', REPORT_SCHEDULE_STATUSES, 'status'),
    timezone: input.timezone || existing?.timezone || 'UTC',
    recurrence,
    auto_distribute: Boolean(input.auto_distribute ?? existing?.auto_distribute ?? false),
    distribution_defaults: arrayValue(input.distribution_defaults ?? existing?.distribution_defaults ?? template.distribution_defaults),
    next_run_at: input.next_run_at || existing?.next_run_at || null,
    last_run_at: input.last_run_at || existing?.last_run_at || null,
    owner: input.owner || existing?.owner || template.owner || 'ops',
    created_at: existing?.created_at || input.created_at || now,
    updated_at: now,
    metadata: objectValue(input.metadata ?? existing?.metadata),
  })
  return { ...schedule, next_run_at: schedule.next_run_at || computeNextRunAt(schedule, now) }
}

export function normalizeScheduleRun(input = {}, schedule, report = null) {
  const now = new Date().toISOString()
  return stripUndefined({
    id: input.id || stableId('report_schedule_run', [schedule.id, report?.id || input.error || now]),
    schedule_id: schedule.id,
    report_id: report?.id || input.report_id || null,
    status: enumValue(input.status || 'completed', REPORT_SCHEDULE_RUN_STATUSES, 'status'),
    started_at: input.started_at || now,
    completed_at: input.completed_at || now,
    error: input.error || null,
  })
}

export function scheduleIsDue(schedule, now = new Date()) {
  return schedule.status === 'active' && schedule.next_run_at && Date.parse(schedule.next_run_at) <= now.getTime()
}

export function computeNextRunAt(schedule, from = new Date().toISOString()) {
  const base = new Date(from)
  const recurrence = schedule.recurrence || {}
  const type = recurrence.type || 'daily'
  if (type === 'interval') {
    const minutes = Math.max(toNumber(recurrence.minutes ?? recurrence.interval_minutes, 60), 1)
    return new Date(base.getTime() + minutes * 60 * 1000).toISOString()
  }
  const next = new Date(base)
  if (type === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
  else if (type === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1)
  else next.setUTCDate(next.getUTCDate() + 1)
  const time = String(recurrence.time || '').match(/^(\d{1,2}):(\d{2})$/)
  if (time) next.setUTCHours(Number(time[1]), Number(time[2]), 0, 0)
  return next.toISOString()
}

export function renderReportMarkdown(report, { locale = 'en', plain = false } = {}) {
  let title = report.title
  const lines = [
    `# ${title}`,
    '',
    `- Type: ${report.report_type}`,
    `- Status: ${report.status}`,
    `- Generated: ${report.generated_at || 'not generated'}`,
    `- Scope: ${Object.entries(report.scope || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'all records'}`,
    '',
  ]
  if (!(report.sections || []).length) {
    // Otherwise this renders as a title and four metadata lines, which reads as
    // a complete but very short report rather than an ungenerated one.
    lines.push('## Warnings', '')
    lines.push('- This report has no generated sections. It contains no findings and must not be used as a situation picture.')
    lines.push('')
  }
  if (report.warnings?.length) {
    lines.push('## Warnings', '')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  for (const section of report.sections || []) {
    lines.push(`## ${section.title}`, '')
    let content = section.content?.markdown || section.content?.summary || ''
    if (plain) {
      const plainResult = plainLanguageText(content)
      content = plainResult.text
    }
    lines.push(content)
    lines.push('')
  }
  if (report.source_refs?.length) {
    lines.push('## Source Appendix', '')
    for (const ref of report.source_refs) lines.push(`- ${ref.collection}:${ref.id}`)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

function plainLanguageText(text) {
  const maxLength = 25
  const notes = []
  let result = text

  const sentences = text.split(/(?<=[.!?])\s+/)
  const simplified = []

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/)
    if (words.length > maxLength) {
      const chunks = []
      let chunk = []
      for (const word of words) {
        chunk.push(word)
        if (chunk.join(' ').split(/\s+/).length >= maxLength - 2) {
          chunks.push(chunk.join(' '))
          chunk = []
        }
      }
      if (chunk.length) chunks.push(chunk.join(' '))
      simplified.push(...chunks)
      notes.push(`Simplified long sentence into ${chunks.length} parts`)
    } else {
      simplified.push(sentence)
    }
  }

  result = simplified.join('. ')

  const abbreviations = {
    'SITREP': 'situation report',
    'IBF': 'impact-based forecasting',
    'GIS': 'geographic information system',
    'API': 'application programming interface',
    'SMS': 'text message',
    'URL': 'web address',
  }

  for (const [abbr, expanded] of Object.entries(abbreviations)) {
    const regex = new RegExp(`\\b${abbr}\\b`, 'g')
    if (regex.test(result)) {
      result = result.replace(regex, expanded)
      notes.push(`Expanded ${abbr} to ${expanded}`)
    }
  }

  return { text: result, notes }
}

export function recordsForReportSources(report, data) {
  const sources = {
    source_runs: data.source_runs,
    climate_observations: data.climate_observations,
    events: [...data.hazard_events, ...data.conflict_events],
    hazard_events: data.hazard_events,
    conflict_events: data.conflict_events,
    service_assets: data.service_assets,
    impact_assessments: data.impact_assessments,
    risk_scores: data.risk_scores,
    data_quality: data.data_quality,
    incidents: data.incidents,
    interventions: data.interventions,
    intervention_tasks: data.intervention_tasks,
    field_reports: data.field_reports,
    response_resources: data.response_resources,
    alert_events: data.alert_events,
    rapidpro_dispatches: data.rapidpro_dispatches,
    rapidpro_inbound_messages: data.rapidpro_inbound_messages,
  }
  const records = []
  for (const ref of report.source_refs || []) {
    const record = sources[ref.collection]?.find((item) => item.id === ref.id)
    if (record) records.push({ ...record, report_source_collection: ref.collection })
  }
  return records
}

export function formatReportSmsSummary(report) {
  const sections = report.sections || []
  // Without sections there are no metrics to read, so the counts below fall back
  // to 0. That made every ungenerated report announce "0 incidents, 0 open
  // alerts" over SMS — a positive claim that the district was quiet, sent to the
  // people meant to act on it. An absent figure is reported as absent.
  if (!sections.length) {
    const title = report.title || 'Lindela report'
    return `${title}: report not generated, no figures available. Report ${report.id}`.replace(/\s+/g, ' ').slice(0, 320)
  }
  const incidentSection = sections.find((section) => section.id === 'incident_summary')
  const alertSection = sections.find((section) => section.id === 'alert_summary')
  const incidents = incidentSection?.content?.metrics?.open_incidents ?? incidentSection?.content?.metrics?.total_incidents ?? 0
  const alerts = alertSection?.content?.metrics?.open_alerts ?? 0
  const title = report.title || 'Lindela report'
  return `${title}: ${incidents} incidents, ${alerts} open alerts. Report ${report.id}`.replace(/\s+/g, ' ').slice(0, 320)
}

/**
 * Filter keys `filterRecords` actually honours. Anything else in a report scope
 * is ignored by it — silently.
 */
const APPLIED_FILTER_KEYS = new Set([
  'bbox', 'country', 'source', 'event_type', 'report_type', 'type', 'severity',
  'status', 'priority', 'incident_id', 'intervention_id', 'service_type',
  'owner', 'template_id', 'schedule_id', 'from', 'to', 'limit',
])

export function resolveReportContext(data, scope = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(scope || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value)
  }

  // `district` is not a key filterRecords understands, so a district-scoped
  // report used to fall through to no filtering at all. The "Turkana Flood
  // SITREP" then reported all 280 hazard events in the store — Indonesia,
  // Brazil, Australia, Chad — as though they were Turkana's.
  //
  // Most collections carry no district label, so a district cannot be derived
  // from the record the way a country can. Where a record is geo-located it is
  // filtered against the district extent; where it is not, the count is
  // unscoped and the report says so rather than presenting it as a district
  // figure.
  const districtSlug = scope?.district || null
  const district = districtSlug ? resolveDistrict(districtSlug) : null
  const scoped = (records = []) => (district ? filterByDistrict(records, district) : records)
  const scopedLabels = (records = []) => (district ? filterByDistrict(records, district) : records)

  const raw = {
    source_runs: data.source_runs,
    climate_observations: data.climate_observations,
    events: [...data.hazard_events, ...data.conflict_events],
    service_assets: data.service_assets,
    impact_assessments: data.impact_assessments,
    risk_scores: data.risk_scores,
    data_quality: data.data_quality,
    incidents: data.incidents,
    interventions: data.interventions,
    intervention_tasks: data.intervention_tasks,
    field_reports: data.field_reports,
    response_resources: data.response_resources,
    alert_events: data.alert_events,
    rapidpro_dispatches: data.rapidpro_dispatches,
    rapidpro_inbound_messages: data.rapidpro_inbound_messages,
  }
  const sources = {
    source_runs: scoped(data.source_runs),
    climate_observations: scopedLabels(data.climate_observations),
    events: scopedLabels([...data.hazard_events, ...data.conflict_events]),
    service_assets: scopedLabels(data.service_assets),
    impact_assessments: scoped(data.impact_assessments),
    risk_scores: scoped(data.risk_scores),
    data_quality: scoped(data.data_quality),
    incidents: scoped(data.incidents),
    interventions: scoped(data.interventions),
    intervention_tasks: scoped(data.intervention_tasks),
    field_reports: scoped(data.field_reports),
    response_resources: scoped(data.response_resources),
    alert_events: scoped(data.alert_events),
    rapidpro_dispatches: scoped(data.rapidpro_dispatches),
    rapidpro_inbound_messages: scoped(data.rapidpro_inbound_messages),
  }
  const context = {}
  for (const [key, records] of Object.entries(sources)) {
    context[key] = key === 'events' ? records : filterRecords(records, query)
  }

  const ignored = Object.keys(scope || {}).filter(
    (key) => !APPLIED_FILTER_KEYS.has(key) && key !== 'district',
  )
  if (ignored.length) context.ignored_scope_keys = ignored
  if (districtSlug && !district) context.unresolved_district = String(districtSlug)
  // Summarised from the raw collections: the filtered ones contain only
  // attributable records, which would report nothing left unattributed.
  context.district_attribution = summariseAttribution(raw, district)
  if (district) context.raw_source_quality_count = (data.data_quality || []).length
  return context
}

/**
 * Keep a geo-located record only when it falls inside the district extent, and
 * mark the rest so callers can tell an unscoped count from a district one.
 *
 * A record with no location is kept but marked: dropping it would quietly
 * remove evidence, which is the opposite error. It is counted, and reported as
 * not attributable to the district.
 */
function filterByDistrict(records, district) {
  const names = districtLabels(district)
  const marked = markDistrictAttribution(records, district, names)
  // A district-scoped report counts only records attributable to that district.
  //
  // An unplaceable record is excluded from the district counts rather than kept:
  // keeping it produced "Turkana Flood SITREP: 280 events" for a store holding
  // 280 global hazard events from Indonesia, Brazil and Australia. A warning
  // alongside that number did not stop it being read as Turkana's. The excluded
  // records are still reported as a count, so nothing disappears silently.
  return marked.filter((item) => item._district_attributed === true)
}

function markDistrictAttribution(records, district, names) {
  return (records || []).map((item) => {
    if (Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
      const distance = haversineKm(
        { latitude: district.center.lat, longitude: district.center.lon },
        { latitude: item.latitude, longitude: item.longitude },
      )
      return { ...item, _district_attributed: distance <= district.radius_km }
    }
    const labelled = [item.district, item.region, item.region_name, item.admin1, item.scope?.district]
      .some((value) => typeof value === 'string' && names.includes(value.toLowerCase()))
    return { ...item, _district_attributed: labelled ? true : null }
  })
}

function districtLabels(district) {
  return [district.slug, district.name, district.name.toLowerCase()].map((value) => String(value).toLowerCase())
}

function summariseAttribution(sources, district) {
  if (!district) return null
  const names = districtLabels(district)
  let inDistrict = 0
  let unlocatable = 0
  let outside = 0
  for (const records of Object.values(sources)) {
    if (!Array.isArray(records)) continue
    // Raw records carry no attribution marker; it is applied here rather than
    // read off records that have already been through the filter.
    for (const { _district_attributed: state } of markDistrictAttribution(records, district, names)) {
      if (state === true) inDistrict += 1
      else if (state === null) unlocatable += 1
      else outside += 1
    }
  }
  return { in_district: inDistrict, unlocatable, outside, total: inDistrict + unlocatable + outside }
}


function buildSection(id, context, report, generatedAt) {
  const builders = {
    executive_summary: executiveSummary,
    risk_summary: riskSummary,
    events_summary: eventsSummary,
    incident_summary: incidentSummary,
    intervention_summary: interventionSummary,
    service_impact_summary: serviceImpactSummary,
    field_report_summary: fieldReportSummary,
    rapidpro_activity_summary: rapidProActivitySummary,
    alert_summary: alertSummary,
    data_quality_summary: dataQualitySummary,
    recommended_actions: recommendedActions,
    appendix_sources: appendixSources,
  }
  const content = builders[id](context, report)
  return {
    id,
    title: sectionTitle(id),
    type: 'deterministic_summary',
    content,
    source_refs: content.source_refs || [],
    generated_at: generatedAt,
    warnings: content.warnings || [],
  }
}

function executiveSummary(context, report) {
  const openIncidents = context.incidents.filter((item) => !['closed', 'stabilized'].includes(item.status))
  const activeInterventions = context.interventions.filter((item) => ['planned', 'active', 'paused'].includes(item.status))
  const highRisks = context.risk_scores.filter((item) => ['high', 'critical'].includes(item.risk_level))
  const summary = `${report.title} covers ${context.events.length} events, ${highRisks.length} high/critical risks, ${openIncidents.length} open incidents, ${activeInterventions.length} active interventions, and ${context.field_reports.length} field reports.`
  return content(summary, {
    events: context.events.length,
    high_or_critical_risks: highRisks.length,
    open_incidents: openIncidents.length,
    active_interventions: activeInterventions.length,
    field_reports: context.field_reports.length,
  }, [
    ...refs('risk_scores', highRisks),
    ...refs('incidents', openIncidents),
    ...refs('interventions', activeInterventions),
  ])
}

function riskSummary(context) {
  const byLevel = countBy(context.risk_scores, 'risk_level')
  const summary = `${context.risk_scores.length} risk scores are in scope. High/critical scores: ${(byLevel.high || 0) + (byLevel.critical || 0)}.`
  return content(summary, { total_risks: context.risk_scores.length, by_level: byLevel }, refs('risk_scores', context.risk_scores))
}

function eventsSummary(context) {
  const bySeverity = countBy(context.events, 'severity')
  const items = context.events.slice(0, 8).map((event) => ({
    id: event.id,
    title: event.title || event.event_type || event.type,
    severity: event.severity || 'unknown',
    occurred_at: event.occurred_at || event.event_date || event.observed_at || null,
  }))
  return content(`${context.events.length} hazard/conflict events are in scope.`, { total_events: context.events.length, by_severity: bySeverity }, refs('events', context.events), items)
}

function incidentSummary(context) {
  const open = context.incidents.filter((item) => !['closed', 'stabilized'].includes(item.status))
  return content(`${open.length} of ${context.incidents.length} incidents remain open or active.`, {
    total_incidents: context.incidents.length,
    open_incidents: open.length,
    by_status: countBy(context.incidents, 'status'),
    by_priority: countBy(context.incidents, 'priority'),
  }, refs('incidents', context.incidents), context.incidents.slice(0, 8).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
  })))
}

function interventionSummary(context) {
  const active = context.interventions.filter((item) => ['planned', 'active', 'paused'].includes(item.status))
  const openTasks = context.intervention_tasks.filter((item) => !['done', 'cancelled'].includes(item.status))
  return content(`${active.length} active interventions and ${openTasks.length} open tasks are in scope.`, {
    total_interventions: context.interventions.length,
    active_interventions: active.length,
    open_tasks: openTasks.length,
    by_intervention_status: countBy(context.interventions, 'status'),
    by_task_status: countBy(context.intervention_tasks, 'status'),
  }, [
    ...refs('interventions', context.interventions),
    ...refs('intervention_tasks', context.intervention_tasks),
  ])
}

function serviceImpactSummary(context) {
  return content(`${context.impact_assessments.length} service-impact assessments and ${context.service_assets.length} assets are in scope.`, {
    impacts: context.impact_assessments.length,
    assets: context.service_assets.length,
    by_service_type: countBy(context.service_assets, 'service_type'),
  }, [
    ...refs('impact_assessments', context.impact_assessments),
    ...refs('service_assets', context.service_assets),
  ])
}

function fieldReportSummary(context) {
  const items = context.field_reports.slice(0, 8).map((item) => ({
    id: item.id,
    incident_id: item.incident_id,
    intervention_id: item.intervention_id,
    summary: item.summary,
    reported_by: item.reported_by,
  }))
  return content(`${context.field_reports.length} field reports are in scope.`, {
    field_reports: context.field_reports.length,
    needs: [...new Set(context.field_reports.flatMap((item) => item.needs || []))],
  }, refs('field_reports', context.field_reports), items)
}

function rapidProActivitySummary(context) {
  return content(`${context.rapidpro_dispatches.length} RapidPro dispatches and ${context.rapidpro_inbound_messages.length} inbound messages are in scope.`, {
    dispatches: context.rapidpro_dispatches.length,
    inbound_messages: context.rapidpro_inbound_messages.length,
    dispatch_status: countBy(context.rapidpro_dispatches, 'status'),
  }, [
    ...refs('rapidpro_dispatches', context.rapidpro_dispatches),
    ...refs('rapidpro_inbound_messages', context.rapidpro_inbound_messages),
  ])
}

function alertSummary(context) {
  const open = context.alert_events.filter((item) => item.status === 'open')
  return content(`${open.length} of ${context.alert_events.length} alert events remain open.`, {
    total_alerts: context.alert_events.length,
    open_alerts: open.length,
    by_severity: countBy(context.alert_events, 'severity'),
    by_status: countBy(context.alert_events, 'status'),
  }, refs('alert_events', context.alert_events))
}

function dataQualitySummary(context) {
  const stale = context.data_quality.filter((item) => item.freshness === 'stale')
  const lowConfidence = context.data_quality.filter((item) => toNumber(item.confidence, 1) < 0.5)
  return content(`${context.data_quality.length} source-quality summaries are in scope; ${stale.length} are stale and ${lowConfidence.length} are low confidence.`, {
    sources: context.data_quality.length,
    stale_sources: stale.length,
    low_confidence_sources: lowConfidence.length,
  }, refs('data_quality', context.data_quality))
}

function recommendedActions(context) {
  const actions = []
  const criticalIncidents = context.incidents.filter((item) => item.priority === 'critical' && !['closed', 'stabilized'].includes(item.status))
  if (criticalIncidents.length) actions.push(`Review ${criticalIncidents.length} critical open incidents.`)
  const openAlerts = context.alert_events.filter((item) => item.status === 'open')
  if (openAlerts.length) actions.push(`Acknowledge or resolve ${openAlerts.length} open alert events.`)
  const blockedTasks = context.intervention_tasks.filter((item) => item.status === 'blocked')
  if (blockedTasks.length) actions.push(`Unblock ${blockedTasks.length} intervention tasks.`)
  if (!actions.length) actions.push('Continue monitoring and refresh source data before the next operational decision.')
  return content(actions.join(' '), { actions: actions.length }, [
    ...refs('incidents', criticalIncidents),
    ...refs('alert_events', openAlerts),
    ...refs('intervention_tasks', blockedTasks),
  ], actions.map((action) => ({ action })))
}

function appendixSources(context) {
  const sourceRefs = [
    ...refs('source_runs', context.source_runs),
    ...refs('events', context.events),
    ...refs('risk_scores', context.risk_scores),
    ...refs('incidents', context.incidents),
    ...refs('interventions', context.interventions),
    ...refs('field_reports', context.field_reports),
    ...refs('alert_events', context.alert_events),
  ]
  return content(`${sourceRefs.length} source references support this report.`, { source_references: sourceRefs.length }, sourceRefs)
}

function content(summary, metrics = {}, sourceRefs = [], items = []) {
  const lines = [summary]
  if (Object.keys(metrics).length) {
    lines.push('', ...Object.entries(metrics).map(([key, value]) => `- ${key.replaceAll('_', ' ')}: ${formatMetricValue(value)}`))
  }
  if (items.length) {
    lines.push('', ...items.map((item) => `- ${Object.entries(item).map(([key, value]) => `${key}: ${value}`).join(' | ')}`))
  }
  return { summary, metrics, items, source_refs: uniqueRefs(sourceRefs), markdown: lines.join('\n') }
}

export function buildReportWarnings(context) {
  const warnings = []
  const stale = context.data_quality.filter((item) => item.freshness === 'stale')
  const lowConfidence = context.data_quality.filter((item) => toNumber(item.confidence, 1) < 0.5)
  if (stale.length) warnings.push(`${stale.length} source quality records are stale.`)
  if (lowConfidence.length) warnings.push(`${lowConfidence.length} source quality records are below 0.5 confidence.`)
  if (!context.source_runs.length && !context.events.length && !context.incidents.length) warnings.push('Report has limited source data in scope.')
  if (context.raw_source_quality_count && !context.data_quality.length) {
    warnings.push(
      `No source quality record could be attributed to this district, so source freshness and confidence could not be assessed for it. ` +
      `${context.raw_source_quality_count} exist without district attribution.`,
    )
  }
  if (context.unresolved_district) {
    warnings.push(`Scope names district "${context.unresolved_district}", which is not a district this system knows. Scope was not applied.`)
  }
  if (context.ignored_scope_keys?.length) {
    warnings.push(`Scope key(s) ${context.ignored_scope_keys.join(', ')} are not supported filters and were not applied.`)
  }
  const attribution = context.district_attribution
  if (attribution && attribution.unlocatable) {
    warnings.push(
      `${attribution.unlocatable} record(s) carry no location or district label and could not be attributed to this district; ` +
      `they are excluded from the figures below. ${attribution.in_district} record(s) were attributed.`,
    )
  }
  return warnings
}

function refs(collection, records = []) {
  return records.map((record) => ({ collection, id: record.id })).filter((ref) => ref.id)
}

function uniqueRefs(refsList) {
  const seen = new Set()
  const unique = []
  for (const ref of refsList) {
    const key = `${ref.collection}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(ref)
  }
  return unique
}

function countBy(records = [], field) {
  const counts = {}
  for (const record of records) {
    const value = record[field] || 'unknown'
    counts[value] = (counts[value] || 0) + 1
  }
  return counts
}

function sectionList(value) {
  const sections = arrayValue(value).length ? arrayValue(value) : ['executive_summary']
  for (const section of sections) enumValue(section, SECTION_LIBRARY, 'section')
  return [...new Set(sections)]
}

function scopeFromInput(input) {
  const allowed = ['country', 'bbox', 'from', 'to', 'source', 'severity', 'status', 'priority', 'incident_id', 'intervention_id', 'service_type']
  return Object.fromEntries(allowed.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
}

function defaultTitlePattern(reportType) {
  return `${sectionTitle(reportType)} - {{country}} - {{date}}`
}

function renderTitle(pattern, scope, now) {
  const date = now.slice(0, 10)
  return String(pattern || 'Lindela Report - {{date}}')
    .replaceAll('{{date}}', date)
    .replaceAll('{{country}}', scope.country || 'All')
    .replaceAll('{{incident_id}}', scope.incident_id || 'All')
    .replaceAll('{{intervention_id}}', scope.intervention_id || 'All')
}

function sectionTitle(id) {
  return String(id)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
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

function arrayValue(value) {
  if (!value) return []
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== '') : [value]
}

function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function formatMetricValue(value) {
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ---------------------------------------------------------------------------
// ENH-27: an export that carries the narrative
// ---------------------------------------------------------------------------
//
// `/export.csv` and `/export.geojson` return the source-record appendix and
// nothing else. The caveats, the refusals and the reasoning live in
// `export.md`, so a spreadsheet handed to a country office says nothing about
// which rows are uncertain — and a CSV *cannot*, because a CSV has nowhere to
// put a caveat that a reader will not delete along with the column.
//
// The narrative therefore travels with the numbers, in the same artefact, in
// the order a reader meets it: what was measured, what was refused, and what
// this export does not license them to conclude. The three blocks are
// separated because a reader who skims reads the first and skips the rest, and
// the first block is the one that can be mistaken for a finding.
//
// The rule this is built against: an export must not state a capability the
// system does not have. `calibrationReport` returns `brier_score: null`
// unconditionally — not zero, not a poor score, an absent measurement — and
// `trainDistrictModels` refuses every pilot district at the `MIN_EVENTS` floor.
// Both are stated here as refusals with their reasons. A number printed where
// the module returns null is the exact defect this repository has shipped and
// fixed twice, and the export is where it would be hardest to notice.

/**
 * Refusal vocabulary, taken from the module that refuses.
 *
 * Imported rather than retyped so the export cannot drift from the code. If
 * `MODEL_BASIS` changes what the model is, this text changes with it in the
 * same commit, which is the only way a quoted refusal stays true.
 */
export const EXPORT_BASIS_LIMITS = Object.freeze({
  rainfall_conditioned: MODEL_BASIS.what_a_probability_is_not,
  discharge_conditioned: MODEL_BASIS_DISCHARGE.what_a_probability_is_not,
  discharge_label_caveat: MODEL_BASIS_DISCHARGE.label_caveat,
  routes_rejected: MODEL_BASIS.rejection_reasons,
  floors: Object.freeze({
    min_months: MIN_MONTHS,
    min_events: MIN_EVENTS,
    match_radius_km: MATCH_RADIUS_KM,
  }),
  calibration_refusal:
    'brier_score is null on every calibration summary because nothing joins those stored '
    + 'records to observed outcomes. A null is an absent measurement, not a poor one, and '
    + 'rendering it as 0 or as a dash beside other figures would assert a result nobody computed.',
})

/**
 * What a refused export says instead of a number.
 *
 * One function, used everywhere, so there is exactly one spelling of "the
 * system declined to answer" in the codebase. The alternative — each call site
 * picking its own dash — is how `null` becomes `0` by accumulation.
 */
export function refused(reason, detail = null) {
  return `refused — ${reason}${detail ? ` (${detail})` : ''}`
}

/**
 * Build the three narrative blocks for an export.
 *
 * Composes with what exists rather than replacing it: `report.warnings` is
 * whatever `buildReportWarnings` already computed for this report, the flood
 * refusals come from whatever `trainDistrictModels` returned, and the
 * calibration refusals from the calibration rows themselves. Nothing here
 * recomputes a figure; the export's job is to say which figures exist and which
 * do not, not to produce more.
 */
export function buildExportNarrative({ report = null, data = {}, flood = null, calibration = [] } = {}) {
  const measured = []
  const refusedItems = []
  const limits = []

  // --- what was measured -------------------------------------------------
  const sections = report?.sections || []
  if (sections.length) {
    for (const section of sections) {
      measured.push({
        claim: section.content?.summary || section.title,
        source_refs: (section.source_refs || []).length,
        collections: [...new Set((section.source_refs || []).map((ref) => ref.collection))],
      })
    }
  } else {
    measured.push({
      claim: 'Nothing. This export carries no generated findings.',
      source_refs: 0,
      collections: [],
    })
  }
  measured.push({
    claim: `${(report?.source_refs || []).length} source record(s) are reproduced in the appendix below.`,
    source_refs: (report?.source_refs || []).length,
    collections: [...new Set((report?.source_refs || []).map((ref) => ref.collection))],
  })

  // --- what was refused --------------------------------------------------
  for (const warning of report?.warnings || []) refusedItems.push({ subject: 'report scope', reason: warning })

  const models = data.flood_probability_models || []
  const regions = models.length ? new Set(models.map((model) => model.region_name)) : new Set()
  for (const refusal of flood?.refusals || []) {
    refusedItems.push({ subject: `flood probability, ${refusal.region}`, reason: refusal.refusal })
    regions.add(refusal.region)
  }
  for (const model of models) {
    if (!model.model) {
      refusedItems.push({ subject: `flood probability, ${model.region_name}`, reason: model.refusal || 'no model produced' })
    }
  }
  if (!models.length && !(flood?.refusals || []).length) {
    refusedItems.push({
      subject: 'flood probability',
      reason:
        `no district has a trained model and no district was refused on this run. The model needs `
        + `${MIN_MONTHS} months and ${MIN_EVENTS} flood-label events within ${MATCH_RADIUS_KM} km; `
        + 'no figure is available for any district from this export.',
    })
  }
  for (const row of calibration || []) {
    if (row.brier_score === null || row.brier_score === undefined) {
      refusedItems.push({ subject: `calibration, ${row.type}`, reason: EXPORT_BASIS_LIMITS.calibration_refusal })
    }
  }
  if (!(calibration || []).length) {
    refusedItems.push({
      subject: 'calibration',
      reason: 'no risk scores are in scope, so no calibration summary — and therefore no skill figure — exists for this export.',
    })
  }

  // --- what a reader must not conclude -----------------------------------
  limits.push(EXPORT_BASIS_LIMITS.routes_rejected)
  limits.push(EXPORT_BASIS_LIMITS.rainfall_conditioned)
  if (models.some((model) => model.label_source === 'glofas_discharge')) {
    limits.push(EXPORT_BASIS_LIMITS.discharge_conditioned)
    limits.push(EXPORT_BASIS_LIMITS.discharge_label_caveat)
  }
  limits.push(
    'Counts of events are counts of what reached this platform. A source that is silent, late or '
    + 'unattributed is absent from the total, so a low count is not evidence that little happened.',
  )
  limits.push(
    'This export is a snapshot of the store at generation time and carries no validation against '
    + 'observed outcomes. Nothing in it is calibrated.',
  )

  return {
    generated_at: new Date().toISOString(),
    measured,
    refused: refusedItems,
    limits,
    provenance: data.__provenance ?? null,
  }
}

/**
 * One line of provenance per exported row: `source_id`, `observed_at`,
 * `payload_hash`.
 *
 * ENH-27 asks for it on every exported row, which is the right place — a
 * caveat above a table is a caveat about the table, and a caveat beside a row is
 * about that row. The three fields are the ones that answer "where did this
 * come from and is this the same thing I saw last quarter": which source, when
 * it was observed rather than when it was ingested, and whether the bytes
 * behind it are the same bytes.
 */
export function rowProvenanceLine(record = {}) {
  const parts = [
    `source_id=${record.source_id || record.source || 'unattributed'}`,
    `observed_at=${record.observed_at || record.event_date || record.occurred_at || 'unstated'}`,
    `payload_hash=${record.payload_hash || record.content_hash || 'none recorded'}`,
  ]
  if (record.provenance?.origin) {
    parts.push(`origin=${record.provenance.origin}`)
    parts.push('is_live_observation=false')
  }
  return parts.join(' ')
}

/** The exported rows, each with its provenance line attached. */
export function provenanceAnnotatedRows(records = []) {
  return records.map((record) => ({
    ...record,
    provenance_line: rowProvenanceLine(record),
  }))
}

/**
 * Render the export: the existing Markdown report, plus the narrative, plus a
 * provenance-stamped appendix.
 *
 * `renderReportMarkdown` is called, not reimplemented, so the export and the
 * `export.md` endpoint cannot disagree about what the report says. The
 * narrative goes above the body — a reader who stops after the first screen
 * should have met the refusals — and the stamped appendix goes below it.
 */
export function renderExportMarkdown(report, data = {}, options = {}) {
  const narrative = options.narrative || buildExportNarrative({ report, data, ...options })
  const body = renderReportMarkdown(report, options)
  const rows = provenanceAnnotatedRows(recordsForReportSources(report, data))
  const lines = [body.trimEnd(), '', '---', '', '## What was measured', '']

  for (const item of narrative.measured) {
    lines.push(`- ${item.claim}${item.source_refs ? ` (${item.source_refs} source reference(s): ${item.collections.join(', ') || 'none'})` : ' (no source references)'}`)
  }

  lines.push('', '## What was refused', '')
  if (narrative.refused.length) {
    for (const item of narrative.refused) lines.push(`- ${item.subject}: ${refused(item.reason)}`)
  } else {
    lines.push('- Nothing in scope was refused, which is itself a statement about sample size, not a clean bill of health.')
  }

  lines.push('', '## What this export does not support', '')
  for (const limit of narrative.limits) lines.push(`- ${limit}`)

  if (narrative.provenance) {
    lines.push('', '## Provenance of this export', '')
    lines.push(`- ${narrative.provenance.note || 'stamped as non-live'}`)
    if (narrative.provenance.urls?.length) lines.push(`- replayed from ${narrative.provenance.urls.length} captured URL(s)`)
  }

  if (rows.length) {
    // Not "Source Appendix": `renderReportMarkdown` already emitted that
    // heading for the report's own ref list, and two sections with one name in
    // one document is a heading a reader cannot navigate by.
    lines.push('', '## Row Provenance', '', 'Every row below carries its own provenance line.', '')
    for (const row of rows) {
      lines.push(`- ${row.report_source_collection}:${row.id} — ${row.provenance_line}`)
    }
  }

  lines.push('')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
