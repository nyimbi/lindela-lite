const sourceGrid = document.querySelector('#sourceGrid')
const metrics = document.querySelector('#metrics')
const statusBox = document.querySelector('#status')
const floodRisk = document.querySelector('#floodRisk')
const conflictRisk = document.querySelector('#conflictRisk')
const eventsTable = document.querySelector('#eventsTable')
const map = document.querySelector('#map')
const storageMode = document.querySelector('#storageMode')
const sourceFreshness = document.querySelector('#sourceFreshness')
const serviceAssetInput = document.querySelector('#serviceAssetInput')
const dataQuality = document.querySelector('#dataQuality')
const operationsMetrics = document.querySelector('#operationsMetrics')
const incidentsTable = document.querySelector('#incidentsTable')
const interventionsTable = document.querySelector('#interventionsTable')
const tasksTable = document.querySelector('#tasksTable')
const alertsTable = document.querySelector('#alertsTable')
const rapidProStatus = document.querySelector('#rapidProStatus')
const rapidProDispatchesTable = document.querySelector('#rapidProDispatchesTable')
const rapidProInboundTable = document.querySelector('#rapidProInboundTable')
const reportsTable = document.querySelector('#reportsTable')
const reportPreview = document.querySelector('#reportPreview')
const reportTemplatesTable = document.querySelector('#reportTemplatesTable')
const reportSchedulesTable = document.querySelector('#reportSchedulesTable')
const reportDistributionsTable = document.querySelector('#reportDistributionsTable')
const apiKeyInput = document.querySelector('#apiKeyInput')

const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']
const state = { reports: [], templates: [], schedules: [] }
const savedApiKey = localStorage.getItem('lindela_lite_api_key') || ''
if (apiKeyInput) {
  apiKeyInput.value = savedApiKey
  apiKeyInput.addEventListener('input', () => {
    const value = apiKeyInput.value.trim()
    if (value) localStorage.setItem('lindela_lite_api_key', value)
    else localStorage.removeItem('lindela_lite_api_key')
  })
}

document.querySelector('#refreshButton').addEventListener('click', refresh)
document.querySelector('#runButton').addEventListener('click', runIngestion)
document.querySelector('#createIngestionSchedulesButton').addEventListener('click', createPublicIngestionSchedules)
document.querySelector('#runDueIngestionButton').addEventListener('click', runDueIngestion)
document.querySelector('#importCsvButton').addEventListener('click', () => importServiceAssets('csv'))
document.querySelector('#importGeoJsonButton').addEventListener('click', () => importServiceAssets('geojson'))
document.querySelector('#exportGeoJsonButton').addEventListener('click', () => open('/api/v1/export.geojson', '_blank'))
document.querySelector('#exportCsvButton').addEventListener('click', () => open('/api/v1/export.csv', '_blank'))
document.querySelector('#createIncidentButton').addEventListener('click', createIncident)
document.querySelector('#createInterventionButton').addEventListener('click', createIntervention)
document.querySelector('#createTaskButton').addEventListener('click', createTask)
document.querySelector('#createAlertRuleButton').addEventListener('click', createAlertRule)
document.querySelector('#evaluateAlertsButton').addEventListener('click', evaluateAlerts)
document.querySelector('#sendRapidProAlertButton').addEventListener('click', sendLatestRapidProAlert)
document.querySelector('#createReportTemplateButton').addEventListener('click', createReportTemplate)
document.querySelector('#generateReportButton').addEventListener('click', generateReport)
document.querySelector('#approveReportButton').addEventListener('click', approveLatestReport)
document.querySelector('#distributeReportButton').addEventListener('click', distributeLatestReport)
document.querySelector('#createReportScheduleButton').addEventListener('click', createReportSchedule)
document.querySelector('#runDueReportsButton').addEventListener('click', runDueReports)

await loadSources()
await refresh()

async function loadSources() {
  const response = await fetch('/api/v1/sources')
  const payload = await response.json()
  sourceGrid.innerHTML = payload.data.map((source) => `
    <label title="${escapeHtml(source.name)}">
      <input type="checkbox" value="${escapeHtml(source.id)}" ${defaultSources.includes(source.id) ? 'checked' : ''}>
      <span>${escapeHtml(source.id)}</span>
    </label>
  `).join('')
  renderFreshness(payload.data)
}

async function runIngestion() {
  setStatus('Running ingestion...')
  const selectedSources = [...sourceGrid.querySelectorAll('input:checked')].map((input) => input.value)
  const body = {
    sources: selectedSources,
    regions: [{
      name: document.querySelector('#regionInput').value,
      country: document.querySelector('#countryInput').value,
      lat: Number(document.querySelector('#latInput').value),
      lon: Number(document.querySelector('#lonInput').value),
    }],
  }
  const response = await fetch('/api/v1/ingest/run', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!payload.success) {
    setStatus(payload.error || 'Ingestion failed')
    return
  }
  setStatus(`Ingestion complete. ${payload.source_runs.length} source runs recorded.`)
  await refresh()
}

async function createPublicIngestionSchedules() {
  setStatus('Creating default public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/schedules/defaults', {})
  if (!payload.success) {
    setStatus(payload.error || 'Ingestion schedule creation failed')
    return
  }
  setStatus(`Created ${payload.created} ingestion schedules.`)
  await refresh()
}

async function runDueIngestion() {
  setStatus('Running due public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/run-due', {})
  if (!payload.success) {
    setStatus(payload.error || 'Due ingestion failed')
    return
  }
  setStatus(`Completed ${payload.data.length} due source runs.`)
  await refresh()
}

async function importServiceAssets(kind) {
  setStatus(`Importing service assets as ${kind.toUpperCase()}...`)
  const key = kind === 'geojson' ? 'service_assets_geojson' : 'service_assets_csv'
  const response = await fetch('/api/v1/service-assets', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ [key]: serviceAssetInput.value }),
  })
  const payload = await response.json()
  if (!payload.success) {
    setStatus((payload.errors || [payload.error]).join(' | '))
    return
  }
  setStatus(`Imported ${payload.imported} service assets.`)
  await refresh()
}

async function createIncident() {
  setStatus('Creating incident...')
  const body = {
    title: document.querySelector('#incidentTitleInput').value,
    incident_type: document.querySelector('#incidentTypeInput').value,
    priority: document.querySelector('#incidentPriorityInput').value,
    country: document.querySelector('#countryInput').value,
    latitude: Number(document.querySelector('#latInput').value),
    longitude: Number(document.querySelector('#lonInput').value),
  }
  const payload = await postJson('/api/v1/incidents', body)
  if (!payload.success) {
    setStatus(payload.error || 'Incident creation failed')
    return
  }
  document.querySelector('#interventionIncidentInput').value = payload.data.id
  setStatus(`Created incident ${payload.data.id}.`)
  await refresh()
}

async function createIntervention() {
  setStatus('Creating intervention...')
  const body = {
    incident_id: document.querySelector('#interventionIncidentInput').value,
    title: document.querySelector('#interventionTitleInput').value,
    lead_org: document.querySelector('#interventionLeadInput').value,
    status: 'active',
  }
  const payload = await postJson('/api/v1/interventions', body)
  if (!payload.success) {
    setStatus(payload.error || 'Intervention creation failed')
    return
  }
  document.querySelector('#taskInterventionInput').value = payload.data.id
  setStatus(`Created intervention ${payload.data.id}.`)
  await refresh()
}

async function createTask() {
  setStatus('Creating task...')
  const body = {
    intervention_id: document.querySelector('#taskInterventionInput').value,
    title: document.querySelector('#taskTitleInput').value,
    owner: document.querySelector('#taskOwnerInput').value,
    status: 'todo',
  }
  const payload = await postJson('/api/v1/tasks', body)
  if (!payload.success) {
    setStatus(payload.error || 'Task creation failed')
    return
  }
  setStatus(`Created task ${payload.data.id}.`)
  await refresh()
}

async function createAlertRule() {
  setStatus('Creating alert rule...')
  const payload = await postJson('/api/v1/alert-rules', {
    name: document.querySelector('#alertNameInput').value,
    metric: document.querySelector('#alertMetricInput').value,
    operator: '>=',
    threshold: Number(document.querySelector('#alertThresholdInput').value),
    severity: 'high',
    actions: [{ type: 'notify', target: 'response-lead' }],
  })
  if (!payload.success) {
    setStatus(payload.error || 'Alert rule creation failed')
    return
  }
  setStatus(`Created alert rule ${payload.data.id}.`)
  await refresh()
}

async function evaluateAlerts() {
  setStatus('Evaluating alert rules...')
  const payload = await postJson('/api/v1/alerts/evaluate', {})
  if (!payload.success) {
    setStatus(payload.error || 'Alert evaluation failed')
    return
  }
  setStatus(`Evaluated ${payload.evaluated} rules; created ${payload.created} alert events.`)
  await refresh()
}

async function sendLatestRapidProAlert() {
  setStatus('Sending latest alert through RapidPro...')
  const alerts = await fetchJson('/api/v1/alert-events?status=open&limit=1')
  const alert = alerts.data?.[0]
  if (!alert) {
    setStatus('No open alert event to send.')
    return
  }
  const urns = document.querySelector('#rapidProUrnsInput').value.split(',').map((item) => item.trim()).filter(Boolean)
  const payload = await postJson(`/api/v1/rapidpro/alert-events/${alert.id}/send`, { urns })
  if (!payload.success) {
    setStatus(payload.data?.error || payload.error || 'RapidPro dispatch failed')
    return
  }
  setStatus(`RapidPro dispatch ${payload.data.id} recorded.`)
  await refresh()
}

async function createReportTemplate() {
  setStatus('Creating report template...')
  const body = {
    name: document.querySelector('#reportTemplateNameInput').value,
    report_type: document.querySelector('#reportTypeInput').value,
    title_pattern: `${document.querySelector('#reportTemplateNameInput').value} - {{country}} - {{date}}`,
    default_filters: reportScope(),
    sections: reportSections(),
  }
  const payload = await postJson('/api/v1/report-templates', body)
  if (!payload.success) {
    setStatus(payload.error || 'Report template creation failed')
    return
  }
  document.querySelector('#reportTemplateIdInput').value = payload.data.id
  setStatus(`Created report template ${payload.data.id}.`)
  await refresh()
}

async function generateReport() {
  setStatus('Generating report...')
  let templateId = document.querySelector('#reportTemplateIdInput').value.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = document.querySelector('#reportTemplateIdInput').value.trim()
  }
  const payload = await postJson('/api/v1/reports', {
    template_id: templateId,
    scope: reportScope(),
    generate: true,
  })
  if (!payload.success) {
    setStatus(payload.error || 'Report generation failed')
    return
  }
  setStatus(`Generated report ${payload.data.id}.`)
  await refresh()
}

async function approveLatestReport() {
  const report = state.reports.find((item) => item.status === 'ready') || state.reports[0]
  if (!report) {
    setStatus('No report to approve.')
    return
  }
  const payload = await postJson(`/api/v1/reports/${report.id}/approve`, {})
  if (!payload.success) {
    setStatus(payload.error || 'Report approval failed')
    return
  }
  setStatus(`Approved report ${payload.data.id}.`)
  await refresh()
}

async function distributeLatestReport() {
  const report = state.reports.find((item) => ['ready', 'approved'].includes(item.status)) || state.reports[0]
  if (!report) {
    setStatus('No report to distribute.')
    return
  }
  const payload = await postJson(`/api/v1/reports/${report.id}/distribute`, {
    channels: [{ channel: 'markdown_download' }],
  })
  if (!payload.success) {
    setStatus(payload.error || payload.data?.[0]?.error || 'Report distribution failed')
    return
  }
  open(`/api/v1/reports/${report.id}/export.md`, '_blank')
  setStatus(`Prepared Markdown export for report ${report.id}.`)
  await refresh()
}

async function createReportSchedule() {
  setStatus('Creating report schedule...')
  let templateId = document.querySelector('#reportTemplateIdInput').value.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = document.querySelector('#reportTemplateIdInput').value.trim()
  }
  const localValue = document.querySelector('#reportScheduleNextRunInput').value
  const payload = await postJson('/api/v1/report-schedules', {
    template_id: templateId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    recurrence: { type: 'daily', time: '07:00' },
    next_run_at: localValue ? new Date(localValue).toISOString() : undefined,
    auto_distribute: false,
  })
  if (!payload.success) {
    setStatus(payload.error || 'Report schedule creation failed')
    return
  }
  setStatus(`Created report schedule ${payload.data.id}.`)
  await refresh()
}

async function runDueReports() {
  setStatus('Running due report schedules...')
  const payload = await postJson('/api/v1/report-schedules/run-due', {})
  if (!payload.success) {
    setStatus(payload.error || 'Due report run failed')
    return
  }
  setStatus(`Completed ${payload.data.length} due report schedule runs.`)
  await refresh()
}

async function refresh() {
  const [health, sources, ingestionHealth, flood, conflict, events, assets, quality, operations, incidents, interventions, tasks, fieldReports, resources, alerts, rapidPro, dispatches, inbound, reportTemplates, reports, reportSchedules, reportDistributions] = await Promise.all([
    fetchJson('/api/v1/health'),
    fetchJson('/api/v1/sources'),
    fetchJson('/api/v1/ingest/status'),
    fetchJson('/api/v1/flood-risk'),
    fetchJson('/api/v1/conflict-risk'),
    fetchJson('/api/v1/events?limit=20'),
    fetchJson('/api/v1/service-assets?limit=100'),
    fetchJson('/api/v1/data-quality'),
    fetchJson('/api/v1/operations/summary'),
    fetchJson('/api/v1/incidents?limit=20'),
    fetchJson('/api/v1/interventions?limit=20'),
    fetchJson('/api/v1/tasks?limit=30'),
    fetchJson('/api/v1/field-reports?limit=50'),
    fetchJson('/api/v1/response-resources?limit=50'),
    fetchJson('/api/v1/alert-events?limit=20'),
    fetchJson('/api/v1/rapidpro/status'),
    fetchJson('/api/v1/rapidpro/dispatches?limit=20'),
    fetchJson('/api/v1/rapidpro/inbound?limit=20'),
    fetchJson('/api/v1/report-templates?limit=20'),
    fetchJson('/api/v1/reports?limit=20'),
    fetchJson('/api/v1/report-schedules?limit=20'),
    fetchJson('/api/v1/report-distributions?limit=20'),
  ])

  state.templates = reportTemplates.data || []
  state.reports = reports.data || []
  state.schedules = reportSchedules.data || []
  const latestTemplate = state.templates[0]
  if (latestTemplate && !document.querySelector('#reportTemplateIdInput').value) {
    document.querySelector('#reportTemplateIdInput').value = latestTemplate.id
  }
  storageMode.textContent = `storage: ${health.storage?.mode || 'unknown'}`
  renderMetrics(health.counts || {})
  renderFreshness(sources.data || [], ingestionHealth.data || [])
  renderDataQuality(quality.data || [])
  renderOperations(operations.data || {})
  renderCards(floodRisk, flood.data || [])
  renderCards(conflictRisk, conflict.data || [])
  renderEvents(events.data || [])
  renderIncidents(incidents.data || [])
  renderInterventions(interventions.data || [])
  renderTasks(tasks.data || [])
  renderAlerts(alerts.data || [])
  renderRapidProStatus(rapidPro.data || {})
  renderRapidProDispatches(dispatches.data || [])
  renderRapidProInbound(inbound.data || [])
  renderReportTemplates(state.templates)
  renderReports(state.reports)
  renderReportSchedules(state.schedules)
  renderReportDistributions(reportDistributions.data || [])
  renderMap([
    ...(flood.data || []),
    ...(conflict.data || []),
    ...(events.data || []),
    ...(assets.data || []),
    ...(incidents.data || []),
    ...(fieldReports.data || []),
    ...(resources.data || []),
  ])
  setStatus(`Updated ${new Date().toLocaleString()}. GDELT excluded.`)
}

async function fetchJson(path) {
  const response = await fetch(path)
  return response.json()
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return response.json()
}

function authHeaders(headers = {}) {
  const apiKey = apiKeyInput?.value.trim()
  return apiKey ? { ...headers, 'x-api-key': apiKey } : headers
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

function safeClass(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}

function displayDate(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : escapeHtml(date.toLocaleString())
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

function renderMetrics(counts) {
  renderMetricsInto(metrics, counts)
}

function renderMetricsInto(container, counts) {
  container.innerHTML = Object.entries(counts).map(([key, value]) => `
    <div class="metric">
      <span>${escapeHtml(key.replaceAll('_', ' '))}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join('')
}

function renderFreshness(sources, healthRecords = []) {
  sourceFreshness.innerHTML = sources.map((source) => {
    const health = healthRecords.find((item) => item.source === source.id)
    const run = source.last_run
    const nextRun = health?.schedule?.next_run_at ? ` | next ${displayDate(health.schedule.next_run_at)}` : ''
    const label = run ? `${escapeHtml(health?.status || run.status)} at ${displayDate(run.completed_at)} (${escapeHtml(run.records_processed)} records)${nextRun}` : `${escapeHtml(health?.status || 'not run')}${nextRun}`
    return `<div class="freshness-row"><strong>${escapeHtml(source.id)}</strong><span>${label}</span></div>`
  }).join('')
}

function renderDataQuality(records) {
  dataQuality.innerHTML = records.length ? records.map((record) => `
    <article class="card">
      <h3>${escapeHtml(record.source)}</h3>
      <p><strong>${escapeHtml(record.confidence)}</strong> confidence | ${escapeHtml(record.freshness)}</p>
      <p>records: ${escapeHtml(record.total_records)} | geocoded: ${escapeHtml(record.geocode_coverage_pct)}% | errors: ${escapeHtml(record.error_count || 0)}</p>
    </article>
  `).join('') : '<p class="note">No data quality records yet. Run ingestion first.</p>'
}

function renderOperations(summary) {
  renderMetricsInto(operationsMetrics, summary.counts || {})
}

function renderRapidProStatus(status) {
  rapidProStatus.innerHTML = `
    <article class="card">
      <h3>${status.enabled ? 'Configured' : 'Not configured'}</h3>
      <p>${escapeHtml(status.base_url || '')}</p>
      <p>mode: ${escapeHtml(status.alert_mode || 'unknown')} | flow: ${status.has_alert_flow ? 'yes' : 'no'} | webhook secret: ${status.inbound_webhook_protected ? 'yes' : 'no'}</p>
    </article>
  `
}

function renderCards(container, records) {
  container.innerHTML = records.length ? records.map((record) => `
    <article class="card">
      <h3>${escapeHtml(record.region_name || record.type)}</h3>
      <p><strong>${escapeHtml(record.score)}</strong> ${escapeHtml(record.risk_level)}${Number.isFinite(record.confidence) ? ` | confidence ${escapeHtml(record.confidence)}` : ''}</p>
      <p>${Object.entries(record.drivers || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(' | ')}</p>
    </article>
  `).join('') : '<p class="note">No scores yet. Run ingestion first.</p>'
}

function renderIncidents(records) {
  incidentsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.title || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.priority || '')}</td>
      <td>${escapeHtml(record.id || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No incidents created.</td></tr>'
}

function renderInterventions(records) {
  interventionsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.title || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.id || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No interventions created.</td></tr>'
}

function renderTasks(records) {
  tasksTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.title || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.owner || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No tasks created.</td></tr>'
}

function renderAlerts(records) {
  alertsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.rule_name || '')}</td>
      <td>${escapeHtml(record.severity || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.message || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No alert events created.</td></tr>'
}

function renderRapidProDispatches(records) {
  rapidProDispatchesTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.alert_event_id || record.id || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.mode || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No dispatches recorded.</td></tr>'
}

function renderRapidProInbound(records) {
  rapidProInboundTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.from || '')}</td>
      <td>${escapeHtml(record.field_report_id || '')}</td>
      <td>${escapeHtml(record.text || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No inbound reports recorded.</td></tr>'
}

function renderReportTemplates(records) {
  reportTemplatesTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.name || '')}</td>
      <td>${escapeHtml(record.report_type || '')}</td>
      <td>${escapeHtml(record.id || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No report templates created.</td></tr>'
}

function renderReports(records) {
  reportsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.title || '')}</td>
      <td>${escapeHtml(record.report_type || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${displayDate(record.generated_at)}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No reports generated.</td></tr>'
  const latest = records[0]
  reportPreview.textContent = latest ? renderReportText(latest) : 'No generated report yet.'
}

function renderReportSchedules(records) {
  reportSchedulesTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.template_id || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${displayDate(record.next_run_at)}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No report schedules created.</td></tr>'
}

function renderReportDistributions(records) {
  reportDistributionsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.channel || '')}</td>
      <td>${escapeHtml(record.status || '')}</td>
      <td>${escapeHtml(record.report_id || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="3">No report distributions recorded.</td></tr>'
}

function renderReportText(report) {
  const sections = (report.sections || []).map((section) => `## ${section.title}\n${section.content?.markdown || section.content?.summary || ''}`).join('\n\n')
  const warnings = (report.warnings || []).map((warning) => `- ${warning}`).join('\n')
  return [`# ${report.title}`, `status: ${report.status}`, warnings ? `\nWarnings\n${warnings}` : '', sections].filter(Boolean).join('\n\n')
}

function reportScope() {
  return Object.fromEntries(Object.entries({
    country: document.querySelector('#reportCountryInput').value.trim(),
    incident_id: document.querySelector('#reportIncidentInput').value.trim(),
    intervention_id: document.querySelector('#reportInterventionInput').value.trim(),
  }).filter(([, value]) => value))
}

function reportSections() {
  return document.querySelector('#reportSectionsInput').value.split(',').map((item) => item.trim()).filter(Boolean)
}

function renderEvents(records) {
  eventsTable.innerHTML = records.length ? records.map((record) => `
    <tr>
      <td>${escapeHtml(record.event_type || record.type || '')}</td>
      <td>${escapeHtml(record.severity || '')}</td>
      <td>${escapeHtml(record.title || '')}</td>
      <td>${escapeHtml(record.source || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No events loaded.</td></tr>'
}

function renderMap(records) {
  const plotted = records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude))
  const labels = plotted.map((record) => {
    const x = clampPercent(((record.longitude + 180) / 360) * 100)
    const y = clampPercent((1 - ((record.latitude + 90) / 180)) * 100)
    const level = record.risk_level || record.impact_level || record.severity || record.priority || 'unknown'
    const label = record.title || record.region_name || record.asset_name || record.name || level
    return `<span class="pin ${safeClass(level)}" style="left:${x}%;top:${y}%" title="${escapeHtml(label)}"></span>`
  }).join('')
  map.innerHTML = `<div class="graticule-label">${escapeHtml(plotted.length || 'No')} geocoded records</div>${labels}`
}

function setStatus(message) {
  statusBox.textContent = message
}
