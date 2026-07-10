import {
  REPORT_DISTRIBUTION_STATUSES,
  REPORT_SCHEDULE_RUN_STATUSES,
  REPORT_SCHEDULE_STATUSES,
  REPORT_STATUSES,
  REPORT_TEMPLATE_STATUSES,
  REPORT_TYPES,
} from './schema.js'
import { filterRecords, stableId, toNumber } from './utils.js'

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
  return stripUndefined({
    id: existing?.id || input.id || stableId('report', [template?.id, reportType, title, createdAt]),
    template_id: template?.id || input.template_id || existing?.template_id || null,
    report_type: reportType,
    status: enumValue(input.status || existing?.status || 'draft', REPORT_STATUSES, 'status'),
    title,
    scope,
    section_ids: sectionIds,
    sections: arrayValue(input.sections ?? existing?.sections),
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
  const incidentSection = sections.find((section) => section.id === 'incident_summary')
  const alertSection = sections.find((section) => section.id === 'alert_summary')
  const incidents = incidentSection?.content?.metrics?.open_incidents ?? incidentSection?.content?.metrics?.total_incidents ?? 0
  const alerts = alertSection?.content?.metrics?.open_alerts ?? 0
  const title = report.title || 'Lindela report'
  return `${title}: ${incidents} incidents, ${alerts} open alerts. Report ${report.id}`.replace(/\s+/g, ' ').slice(0, 320)
}

function resolveReportContext(data, scope = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(scope || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value)
  }
  return {
    source_runs: filterRecords(data.source_runs, query),
    climate_observations: filterRecords(data.climate_observations, query),
    events: filterRecords([...data.hazard_events, ...data.conflict_events], query),
    service_assets: filterRecords(data.service_assets, query),
    impact_assessments: filterRecords(data.impact_assessments, query),
    risk_scores: filterRecords(data.risk_scores, query),
    data_quality: filterRecords(data.data_quality, query),
    incidents: filterRecords(data.incidents, query),
    interventions: filterRecords(data.interventions, query),
    intervention_tasks: filterRecords(data.intervention_tasks, query),
    field_reports: filterRecords(data.field_reports, query),
    response_resources: filterRecords(data.response_resources, query),
    alert_events: filterRecords(data.alert_events, query),
    rapidpro_dispatches: filterRecords(data.rapidpro_dispatches, query),
    rapidpro_inbound_messages: filterRecords(data.rapidpro_inbound_messages, query),
  }
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

function buildReportWarnings(context) {
  const warnings = []
  const stale = context.data_quality.filter((item) => item.freshness === 'stale')
  const lowConfidence = context.data_quality.filter((item) => toNumber(item.confidence, 1) < 0.5)
  if (stale.length) warnings.push(`${stale.length} source quality records are stale.`)
  if (lowConfidence.length) warnings.push(`${lowConfidence.length} source quality records are below 0.5 confidence.`)
  if (!context.source_runs.length && !context.events.length && !context.incidents.length) warnings.push('Report has limited source data in scope.')
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
