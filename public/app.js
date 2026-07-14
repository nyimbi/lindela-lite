// =============================================================
// Lindela Lite — Operations Console
// =============================================================

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// =============================================================
// State
// =============================================================
const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  catalog: {},
  activeTab: 'alerts',
  alertFilter: 'all',
  mapTransform: { x: 0, y: 0, scale: 1 },
  mapDragging: false,
  mapDragStart: null,
  data: {},
  reports: [],
  templates: [],
  _paletteItems: [],
  _paletteIndex: 0,
}

// =============================================================
// DOM references
// =============================================================
const $ = (id) => document.getElementById(id)

const apiKeyInput       = $('apiKeyInput')
const storageMode       = $('storageMode')
const offlineBanner     = $('offlineBanner')
const queuedBadge       = $('queuedBadge')
const connectionStatus  = $('connectionStatus')
const statusText        = $('status')
const sourceDots        = $('sourceDots')
const queuedCount       = $('queuedCount')

// =============================================================
// API key
// =============================================================
const savedApiKey = localStorage.getItem('lindela_lite_api_key') || ''
if (apiKeyInput) {
  apiKeyInput.value = savedApiKey
  apiKeyInput.addEventListener('input', () => {
    const value = apiKeyInput.value.trim()
    if (value) localStorage.setItem('lindela_lite_api_key', value)
    else localStorage.removeItem('lindela_lite_api_key')
  })
}

function authHeaders(headers = {}) {
  const apiKey = apiKeyInput?.value.trim()
  return apiKey ? { ...headers, 'x-api-key': apiKey } : headers
}

// =============================================================
// Utilities
// =============================================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function safeClass(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown'
}

function displayDate(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : escapeHtml(d.toLocaleString())
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

// =============================================================
// i18n
// =============================================================
async function loadLocale(locale) {
  try {
    const res = await fetch(`/i18n/${locale}.json`)
    if (!res.ok) throw new Error('locale missing')
    state.catalog = await res.json()
  } catch {
    if (locale !== 'en') {
      const fallback = await fetch('/i18n/en.json')
      state.catalog = fallback.ok ? await fallback.json() : {}
    }
  }
  applyI18n()
}

function t(key, vars = {}) {
  let str = state.catalog[key] || key
  for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, String(v))
  return str
}

function applyI18n() {
  const isRtl = state.locale === 'ar'
  document.documentElement.lang = state.locale
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr'
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n
    el.textContent = t(key)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
}

// =============================================================
// Fetch helpers
// =============================================================
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

// =============================================================
// Status bar
// =============================================================
function setStatus(message) {
  statusText.textContent = message
}

// =============================================================
// Offline
// =============================================================
function updateConnectionStatus() {
  const online = navigator.onLine
  offlineBanner.hidden = online
  connectionStatus.textContent = online ? 'online' : 'offline'
  connectionStatus.className = `badge badge-connection${online ? '' : ' offline'}`
}

window.addEventListener('online', () => {
  updateConnectionStatus()
  navigator.serviceWorker?.controller?.postMessage({ type: 'sync' })
})
window.addEventListener('offline', updateConnectionStatus)
updateConnectionStatus()

window.lindelaQueue = {
  _pending: 0,
  async queueRequest(url, method, body) {
    if (navigator.onLine) return postJson(url, body)
    navigator.serviceWorker?.controller?.postMessage({
      type: 'queueRequest',
      request: { url, method, headers: authHeaders(), body: JSON.stringify(body) },
    })
    this._pending++
    const label = `${this._pending} queued`
    if (queuedCount) { queuedCount.textContent = label; queuedCount.hidden = false }
    if (queuedBadge) { queuedBadge.textContent = label; queuedBadge.hidden = false }
    return { success: true, queued: true }
  },
}

// =============================================================
// SVG Map
// =============================================================
const SVG_W = 800
const SVG_H = 500
const DEFAULT_BBOX = { minLat: -2, maxLat: 12, minLon: 29, maxLon: 46 }

const mapEl           = $('situationMap')
const mapTransformEl  = $('mapTransform')
const mapGraticuleEl  = $('mapGraticule')
const mapHazardsEl    = $('mapHazards')
const mapAssetsEl     = $('mapAssets')
const mapRiskEl       = $('mapRisk')
const mapLegendEl     = $('mapLegend')
const mapDefsEl       = $('mapDefs')

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function computeBbox(records) {
  const geo = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
  if (geo.length < 2) return DEFAULT_BBOX
  const lats = geo.map((r) => r.latitude)
  const lons = geo.map((r) => r.longitude)
  const pad = 1.5
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLon: Math.min(...lons) - pad,
    maxLon: Math.max(...lons) + pad,
  }
}

function project(lat, lon, bbox) {
  const x = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * SVG_W
  const y = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * SVG_H
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

function renderGraticule(bbox) {
  mapGraticuleEl.innerHTML = ''
  const step = 5
  const latS = Math.ceil(bbox.minLat / step) * step
  const latE = Math.floor(bbox.maxLat / step) * step
  const lonS = Math.ceil(bbox.minLon / step) * step
  const lonE = Math.floor(bbox.maxLon / step) * step

  for (let lat = latS; lat <= latE; lat += step) {
    const a = project(lat, bbox.minLon, bbox)
    const b = project(lat, bbox.maxLon, bbox)
    mapGraticuleEl.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
    const lbl = svgEl('text', { x: a.x + 3, y: a.y - 3 })
    lbl.textContent = `${lat}°`
    mapGraticuleEl.append(lbl)
  }

  for (let lon = lonS; lon <= lonE; lon += step) {
    const a = project(bbox.maxLat, lon, bbox)
    const b = project(bbox.minLat, lon, bbox)
    mapGraticuleEl.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
    const lbl = svgEl('text', { x: a.x + 2, y: b.y - 3 })
    lbl.textContent = `${lon}°`
    mapGraticuleEl.append(lbl)
  }
}

function sevRadius(severity) {
  return { critical: 13, high: 10, medium: 7, low: 5 }[String(severity).toLowerCase()] ?? 5
}

function hazardClass(eventType) {
  const s = String(eventType || '').toLowerCase()
  if (s.includes('flood'))                       return 'hazard-flood'
  if (s.includes('storm') || s.includes('cycl')) return 'hazard-storm'
  if (s.includes('fire'))                        return 'hazard-fire'
  if (s.includes('disast') || s.includes('quake')) return 'hazard-disaster'
  if (s.includes('conflict') || s.includes('tension') || s.includes('communal')) return 'hazard-conflict'
  return 'hazard-default'
}

function assetClass(serviceType) {
  const s = String(serviceType || '').toLowerCase()
  if (s.includes('health') || s.includes('clinic') || s.includes('hospital')) return 'asset-health'
  if (s.includes('water'))  return 'asset-water'
  if (s.includes('edu') || s.includes('school')) return 'asset-education'
  return 'asset-default'
}

function renderMap(records) {
  const geo = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
  const bbox = computeBbox(geo)

  // Apply map severity filter
  const sevFilter = $('mapSeverity')?.value || ''
  const srcFilter = $('mapSource')?.value || ''

  const visible = geo.filter((r) => {
    if (sevFilter && r.severity && r.severity !== sevFilter) return false
    if (srcFilter && r.source && r.source !== srcFilter) return false
    return true
  })

  renderGraticule(bbox)
  mapHazardsEl.innerHTML = ''
  mapAssetsEl.innerHTML = ''
  mapRiskEl.innerHTML = ''
  if (mapDefsEl) mapDefsEl.innerHTML = ''

  const hazards = visible.filter((r) => r.event_type || r.source === 'gdacs' || r.source === 'glofas' || r.source === 'nasa_firms')
  const assets  = visible.filter((r) => r.service_type)
  const risks   = visible.filter((r) => Number.isFinite(r.score))

  // Risk blobs (radial gradient fills)
  risks.forEach((r, i) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const gradId = `rg${i}`
    const opacity = Math.min(0.45, (r.score ?? 0) * 0.45)
    const grad = svgEl('radialGradient', { id: gradId, cx: '50%', cy: '50%', r: '50%' })
    const s1 = svgEl('stop', { offset: '0%',   'stop-color': 'oklch(65% 0.22 25)', 'stop-opacity': String(opacity) })
    const s2 = svgEl('stop', { offset: '100%', 'stop-color': 'oklch(65% 0.22 25)', 'stop-opacity': '0' })
    grad.append(s1, s2)
    if (mapDefsEl) mapDefsEl.append(grad)
    const radius = Math.max(18, (r.score ?? 0.5) * 55)
    mapRiskEl.append(svgEl('ellipse', {
      cx: x, cy: y, rx: radius, ry: radius * 0.55,
      fill: `url(#${gradId})`,
      class: 'risk-blob',
    }))
  })

  // Hazard circles
  hazards.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const circle = svgEl('circle', {
      cx: x, cy: y,
      r: sevRadius(r.severity),
      class: `hazard-marker ${hazardClass(r.event_type)}`,
    })
    const titleEl = svgEl('title')
    titleEl.textContent = r.title || r.event_type || 'Hazard'
    circle.append(titleEl)
    circle.addEventListener('click', () => openDetailDialog(r))
    mapHazardsEl.append(circle)
  })

  // Asset squares
  assets.forEach((r) => {
    const { x, y } = project(r.latitude, r.longitude, bbox)
    const size = 9
    const rect = svgEl('rect', {
      x: x - size / 2, y: y - size / 2,
      width: size, height: size,
      class: `asset-marker ${assetClass(r.service_type)}`,
    })
    const titleEl = svgEl('title')
    titleEl.textContent = r.name || r.service_type || 'Asset'
    rect.append(titleEl)
    rect.addEventListener('click', () => openDetailDialog(r))
    mapAssetsEl.append(rect)
  })

  renderMapLegend()

  const countEl = $('mapRecordCount')
  if (countEl) countEl.textContent = `${visible.length} records`
}

function renderMapLegend() {
  mapLegendEl.innerHTML = ''
  const items = [
    { cls: 'hazard-flood',    label: 'Flood',   shape: 'circle' },
    { cls: 'hazard-fire',     label: 'Fire',    shape: 'circle' },
    { cls: 'hazard-conflict', label: 'Conflict',shape: 'circle' },
    { cls: 'asset-health',    label: 'Health',  shape: 'rect' },
    { cls: 'asset-water',     label: 'Water',   shape: 'rect' },
  ]
  const pad = 8
  const rowH = 17
  const bW = 92
  const bH = items.length * rowH + pad * 2
  const bY = SVG_H - bH - 6

  mapLegendEl.append(svgEl('rect', {
    x: 6, y: bY, width: bW, height: bH,
    class: 'legend-bg', rx: 5,
  }))

  items.forEach((item, i) => {
    const y = bY + pad + i * rowH + rowH / 2
    if (item.shape === 'circle') {
      mapLegendEl.append(svgEl('circle', { cx: 18, cy: y, r: 5, class: `hazard-marker ${item.cls}` }))
    } else {
      mapLegendEl.append(svgEl('rect', { x: 14, y: y - 4, width: 8, height: 8, class: `asset-marker ${item.cls}` }))
    }
    const lbl = svgEl('text', { x: 30, y: y, class: 'legend-label' })
    lbl.textContent = item.label
    mapLegendEl.append(lbl)
  })
}

// Map zoom / pan
function applyMapTransform() {
  if (!mapTransformEl) return
  mapTransformEl.setAttribute('transform',
    `translate(${state.mapTransform.x},${state.mapTransform.y}) scale(${state.mapTransform.scale})`)
}

mapEl?.addEventListener('wheel', (e) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? 0.86 : 1.16
  state.mapTransform.scale = Math.max(0.3, Math.min(10, state.mapTransform.scale * delta))
  applyMapTransform()
}, { passive: false })

mapEl?.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.hazard-marker, .asset-marker')) return
  state.mapDragging = true
  state.mapDragStart = { x: e.clientX - state.mapTransform.x, y: e.clientY - state.mapTransform.y }
  mapEl.setPointerCapture(e.pointerId)
})

mapEl?.addEventListener('pointermove', (e) => {
  if (!state.mapDragging) return
  state.mapTransform.x = e.clientX - state.mapDragStart.x
  state.mapTransform.y = e.clientY - state.mapDragStart.y
  applyMapTransform()
})

mapEl?.addEventListener('pointerup', () => { state.mapDragging = false })
mapEl?.addEventListener('pointercancel', () => { state.mapDragging = false })

// Double-click resets zoom
mapEl?.addEventListener('dblclick', () => {
  state.mapTransform = { x: 0, y: 0, scale: 1 }
  applyMapTransform()
})

// Map filter triggers re-render
$('mapSeverity')?.addEventListener('change', reRenderMapFromState)
$('mapSource')?.addEventListener('change', reRenderMapFromState)

function reRenderMapFromState() {
  const d = state.data
  renderMap([
    ...(d.flood?.data || []),
    ...(d.conflict?.data || []),
    ...(d.events?.data || []),
    ...(d.assets?.data || []),
  ])
}

// =============================================================
// Data refresh
// =============================================================
async function refresh() {
  const [health, sources, ingestionHealth, flood, conflict, events, assets, alerts, reports, reportTemplates] =
    await Promise.all([
      fetchJson('/api/v1/health'),
      fetchJson('/api/v1/sources'),
      fetchJson('/api/v1/ingest/status'),
      fetchJson('/api/v1/flood-risk'),
      fetchJson('/api/v1/conflict-risk'),
      fetchJson('/api/v1/events?limit=50'),
      fetchJson('/api/v1/service-assets?limit=100'),
      fetchJson('/api/v1/alert-events?limit=30'),
      fetchJson('/api/v1/reports?limit=20'),
      fetchJson('/api/v1/report-templates?limit=20'),
    ])

  state.data = { health, sources, ingestionHealth, flood, conflict, events, assets, alerts, reports, reportTemplates }
  state.reports   = reports.data || []
  state.templates = reportTemplates.data || []

  if (storageMode) storageMode.textContent = health.storage?.mode || 'json'
  renderAlertsBadge(alerts.data || [])
  renderSourceDots(ingestionHealth.data || [])

  // Populate map source filter
  populateMapSourceFilter(sources.data || [])

  renderMap([
    ...(flood.data || []),
    ...(conflict.data || []),
    ...(events.data || []),
    ...(assets.data || []),
  ])

  if (state.activeTab === 'alerts')    renderAlertsPanel()
  else if (state.activeTab === 'reports')   renderReportsPanel()
  else if (state.activeTab === 'ingestion') renderIngestionPanel()

  setStatus(`Updated ${new Date().toLocaleString()}. GDELT excluded.`)
}

function populateMapSourceFilter(sources) {
  const sel = $('mapSource')
  if (!sel) return
  const current = sel.value
  sel.innerHTML = `<option value="">All</option>` +
    sources.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')
  if (current) sel.value = current
}

// =============================================================
// Source health dots (statusbar)
// =============================================================
function renderSourceDots(healthData) {
  if (!sourceDots) return
  sourceDots.innerHTML = healthData.slice(0, 8).map((h) => {
    const cls = h.status === 'fresh' ? 'health-dot-fresh'
      : h.status === 'failed' ? 'health-dot-failed'
      : h.status === 'stale'  ? 'health-dot-stale'
      : 'health-dot-never-run'
    return `<span class="source-dot ${cls}" title="${escapeHtml(h.source)}: ${escapeHtml(h.status)}"></span>`
  }).join('')
}

// =============================================================
// Tabs
// =============================================================
function switchTab(name) {
  state.activeTab = name
  document.querySelectorAll('.rail-tab').forEach((btn) => {
    const active = btn.dataset.tab === name
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', String(active))
  })
  document.querySelectorAll('.rail-panel').forEach((panel) => {
    const active = panel.id === `panel-${name}`
    panel.classList.toggle('active', active)
    panel.hidden = !active
  })
  if (name === 'alerts')    renderAlertsPanel()
  else if (name === 'reports')   renderReportsPanel()
  else if (name === 'ingestion') renderIngestionPanel()
  else if (name === 'settings')  renderSettingsPanel()
}

document.querySelectorAll('.rail-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

// =============================================================
// Alerts panel
// =============================================================
function renderAlertsBadge(alerts) {
  const badge = $('alertsBadge')
  if (!badge) return
  const open = alerts.filter((a) => a.status === 'open').length
  if (open > 0) { badge.textContent = open; badge.hidden = false }
  else { badge.hidden = true }
}

function renderAlertsPanel() {
  const alerts = state.data.alerts?.data || []
  const filter = state.alertFilter
  const filtered = filter === 'all' ? alerts
    : filter === 'auto_approved' ? alerts.filter((a) => a.status === 'auto_approved' || a.status === 'auto-approved')
    : alerts.filter((a) => a.status === filter)

  const container = $('alertsList')
  if (!container) return

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_alerts'))}</p></div>`
    return
  }

  container.innerHTML = filtered.map((alert, i) => {
    const delay = Math.min(i * 40, 320)
    const canSend = alert.status === 'approved' || alert.status === 'auto_approved' || alert.status === 'auto-approved'
    return `<div class="alert-item" style="animation-delay:${delay}ms" role="listitem">
      <div class="alert-item-row">
        <span class="sev-chip sev-${safeClass(alert.severity || 'unknown')}">${escapeHtml(alert.severity || 'unknown')}</span>
        <span class="alert-rule-name">${escapeHtml(alert.rule_name || alert.metric || alert.id || '')}</span>
        <span class="alert-timestamp">${displayDate(alert.created_at)}</span>
      </div>
      <div class="alert-item-meta">
        <span class="alert-metric">${escapeHtml(alert.metric_expression || alert.metric || '')}</span>
        <span class="status-pill status-${safeClass(alert.status || 'unknown')}">${escapeHtml(alert.status || '')}</span>
      </div>
      <div class="item-actions">
        <button class="btn btn-xs btn-approve" data-id="${escapeHtml(alert.id)}" data-action="approve"
                data-i18n="action.approve">Approve</button>
        <button class="btn btn-xs btn-reject" data-id="${escapeHtml(alert.id)}" data-action="reject"
                data-i18n="action.reject">Reject</button>
        <button class="btn btn-xs btn-send" data-id="${escapeHtml(alert.id)}" data-action="send"
                ${canSend ? '' : 'disabled'} data-i18n="action.send">Send</button>
      </div>
    </div>`
  }).join('')

  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const { id, action } = e.currentTarget.dataset
      handleAlertAction(id, action)
    })
  })
}

$('alertFilterChips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip')
  if (!chip) return
  state.alertFilter = chip.dataset.filter
  document.querySelectorAll('#alertFilterChips .chip').forEach((c) => c.classList.toggle('active', c === chip))
  renderAlertsPanel()
})

async function handleAlertAction(id, action) {
  const safeId = encodeURIComponent(id)
  if (action === 'approve') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}/approve`, { actor: 'dashboard' })
    setStatus(payload.success ? `Alert approved.` : (payload.error || 'Approve failed'))
  } else if (action === 'reject') {
    const payload = await postJson(`/api/v1/alert-events/${safeId}`, { status: 'rejected' })
    setStatus(payload.success ? `Alert rejected.` : (payload.error || 'Reject failed'))
  } else if (action === 'send') {
    const urns = prompt('URNs (comma-separated, e.g. +254700000000):')
    if (!urns) return
    const payload = await postJson(`/api/v1/rapidpro/alert-events/${safeId}/send`, {
      urns: urns.split(',').map((u) => u.trim()).filter(Boolean),
    })
    setStatus(payload.success ? 'Alert sent via RapidPro.' : (payload.error || 'Send failed'))
  }
  await refresh()
}

// =============================================================
// Reports panel
// =============================================================
function renderReportsPanel() {
  const container = $('reportsList')
  if (!container) return
  const reports = state.reports

  if (!reports.length) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(t('state.empty_reports'))}</p></div>`
  } else {
    container.innerHTML = reports.map((r) => {
      const canApprove = r.status === 'ready' || r.status === 'draft'
      const canDist    = r.status === 'approved' || r.status === 'ready'
      return `<div class="report-item" role="listitem">
        <div class="report-item-title">${escapeHtml(r.title || r.template_name || 'Untitled report')}</div>
        <div class="report-item-meta">
          <span class="status-pill status-${safeClass(r.status || 'draft')}">${escapeHtml(r.status || '')}</span>
          <span>${displayDate(r.generated_at)}</span>
        </div>
        <div class="item-actions">
          ${canApprove ? `<button class="btn btn-xs btn-approve" data-id="${escapeHtml(r.id)}" data-action="approve">Approve</button>` : ''}
          ${canDist    ? `<button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="distribute">Distribute</button>` : ''}
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-md">MD</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-csv">CSV</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-json">JSON</button>
          <button class="btn btn-xs" data-id="${escapeHtml(r.id)}" data-action="export-geojson">GeoJSON</button>
        </div>
      </div>`
    }).join('')

    container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const { id, action } = e.currentTarget.dataset
        handleReportAction(id, action)
      })
    })
  }

  // Populate template select
  const sel = $('reportTemplateIdInput')
  if (sel) {
    const cur = sel.value
    sel.innerHTML = `<option value="">None (create new)</option>` +
      state.templates.map((tmpl) => `<option value="${escapeHtml(tmpl.id)}">${escapeHtml(tmpl.name)}</option>`).join('')
    if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur
    else if (state.templates[0] && !sel.value) sel.value = state.templates[0].id
  }
}

async function handleReportAction(id, action) {
  const safeId = encodeURIComponent(id)
  if (action === 'approve') {
    const payload = await postJson(`/api/v1/reports/${safeId}/approve`, { actor: 'dashboard' })
    setStatus(payload.success ? `Report approved.` : (payload.error || 'Approve failed'))
    await refresh()
  } else if (action === 'distribute') {
    const payload = await postJson(`/api/v1/reports/${safeId}/distribute`, { channels: [{ channel: 'markdown_download' }] })
    if (payload.success || payload.report) {
      window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
      setStatus('Report distributed.')
    } else {
      setStatus(payload.error || 'Distribute failed')
    }
    await refresh()
  } else if (action === 'export-md') {
    window.open(`/api/v1/reports/${safeId}/export.md`, '_blank')
  } else if (action === 'export-csv') {
    window.open(`/api/v1/reports/${safeId}/export.csv`, '_blank')
  } else if (action === 'export-json') {
    window.open(`/api/v1/reports/${safeId}/export.json`, '_blank')
  } else if (action === 'export-geojson') {
    window.open(`/api/v1/reports/${safeId}/export.geojson`, '_blank')
  }
}

$('newReportButton')?.addEventListener('click', () => {
  const form = $('newReportForm')
  if (form) form.hidden = !form.hidden
})

$('generateReportButton')?.addEventListener('click', generateReport)
$('createReportTemplateButton')?.addEventListener('click', createReportTemplate)

function reportScope() {
  return Object.fromEntries(Object.entries({
    country:         $('reportCountryInput')?.value?.trim(),
    incident_id:     $('reportIncidentInput')?.value?.trim(),
    intervention_id: $('reportInterventionInput')?.value?.trim(),
  }).filter(([, v]) => v))
}

function reportSections() {
  return ($('reportSectionsInput')?.value || 'executive_summary,incident_summary,appendix_sources')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

async function createReportTemplate() {
  setStatus('Creating report template...')
  const body = {
    name: 'SITREP',
    report_type: 'situation_report',
    title_pattern: 'SITREP - {{country}} - {{date}}',
    default_filters: reportScope(),
    sections: reportSections(),
  }
  const payload = await postJson('/api/v1/report-templates', body)
  if (!payload.success) { setStatus(payload.error || 'Template creation failed'); return }
  const sel = $('reportTemplateIdInput')
  if (sel) sel.value = payload.data.id
  setStatus(`Created template ${payload.data.id}.`)
  await refresh()
}

async function generateReport() {
  setStatus('Generating report...')
  let templateId = $('reportTemplateIdInput')?.value?.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = $('reportTemplateIdInput')?.value?.trim()
  }
  const payload = await postJson('/api/v1/reports', { template_id: templateId, scope: reportScope(), generate: true })
  if (!payload.success) { setStatus(payload.error || 'Report generation failed'); return }
  setStatus(`Generated report ${payload.data.id}.`)
  await refresh()
}

async function approveLatestReport() {
  const report = state.reports.find((r) => r.status === 'ready') || state.reports[0]
  if (!report) { setStatus('No report to approve.'); return }
  const payload = await postJson(`/api/v1/reports/${report.id}/approve`, {})
  setStatus(payload.success ? `Approved report ${payload.data.id}.` : (payload.error || 'Approval failed'))
  await refresh()
}

async function distributeLatestReport() {
  const report = state.reports.find((r) => ['ready', 'approved'].includes(r.status)) || state.reports[0]
  if (!report) { setStatus('No report to distribute.'); return }
  const payload = await postJson(`/api/v1/reports/${report.id}/distribute`, { channels: [{ channel: 'markdown_download' }] })
  if (!payload.success) { setStatus(payload.error || payload.data?.[0]?.error || 'Distribution failed'); return }
  window.open(`/api/v1/reports/${report.id}/export.md`, '_blank')
  setStatus(`Prepared Markdown export for report ${report.id}.`)
  await refresh()
}

// =============================================================
// Ingestion panel
// =============================================================
async function loadSources() {
  const response = await fetch('/api/v1/sources')
  const payload = await response.json()
  const grid = $('sourceGrid')
  if (!grid) return
  const defaultSources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']
  grid.innerHTML = payload.data.map((source) => `
    <label title="${escapeHtml(source.name)}">
      <input type="checkbox" value="${escapeHtml(source.id)}" ${defaultSources.includes(source.id) ? 'checked' : ''}>
      <span>${escapeHtml(source.id)}</span>
    </label>
  `).join('')
}

function renderIngestionPanel() {
  const healthData = state.data.ingestionHealth?.data || []
  const sources    = state.data.sources?.data || []
  const container  = $('sourceStatusList')
  if (!container) return

  container.innerHTML = sources.map((source) => {
    const health  = healthData.find((h) => h.source === source.id) || {}
    const run     = source.last_run
    const status  = health.status || (run ? run.status : 'never_run')
    const dotCls  = status === 'fresh' ? 'health-dot-fresh'
      : status === 'failed' ? 'health-dot-failed'
      : status === 'stale'  ? 'health-dot-stale'
      : 'health-dot-never-run'
    const nextRun = health.schedule?.next_run_at ? `next ${displayDate(health.schedule.next_run_at)}` : ''
    const records = run ? `${escapeHtml(String(run.records_processed))} records` : ''
    const meta = [displayDate(run?.completed_at), records, nextRun].filter(Boolean).join(' · ')
    return `<div class="source-card">
      <div class="source-card-header">
        <span class="health-dot ${dotCls}"></span>
        <span class="source-name">${escapeHtml(source.name)}</span>
        <span class="status-pill status-${safeClass(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="source-meta">${meta}</div>
      <div class="item-actions">
        <button class="btn btn-xs" data-source="${escapeHtml(source.id)}" data-action="run-source"
                data-i18n="action.run_now">Run now</button>
        <button class="btn btn-xs" data-source="${escapeHtml(source.id)}" data-action="view-lineage"
                data-i18n="action.view_lineage">Lineage</button>
      </div>
    </div>`
  }).join('')

  container.querySelectorAll('[data-action="run-source"]').forEach((btn) => {
    btn.addEventListener('click', (e) => runSingleSource(e.currentTarget.dataset.source))
  })
}

async function runSingleSource(sourceId) {
  setStatus(`Running ${sourceId}...`)
  const payload = await postJson('/api/v1/ingest/run', { sources: [sourceId] })
  setStatus(payload.success ? `Ran ${sourceId}.` : (payload.error || 'Ingestion failed'))
  await refresh()
}

async function runIngestion() {
  setStatus('Running ingestion...')
  const grid = $('sourceGrid')
  const selectedSources = [...(grid?.querySelectorAll('input:checked') || [])].map((inp) => inp.value)
  const payload = await postJson('/api/v1/ingest/run', {
    sources: selectedSources,
    regions: [{
      name:    $('regionInput')?.value,
      country: $('countryInput')?.value,
      lat:     Number($('latInput')?.value),
      lon:     Number($('lonInput')?.value),
    }],
  })
  if (!payload.success) { setStatus(payload.error || 'Ingestion failed'); return }
  setStatus(`Ingestion complete. ${payload.source_runs.length} source runs recorded.`)
  await refresh()
}

async function createPublicIngestionSchedules() {
  setStatus('Creating default public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/schedules/defaults', {})
  setStatus(payload.success ? `Created ${payload.created} ingestion schedules.` : (payload.error || 'Ingestion schedule creation failed'))
  await refresh()
}

async function runDueIngestion() {
  setStatus('Running due public ingestion schedules...')
  const payload = await postJson('/api/v1/ingest/run-due', {})
  setStatus(payload.success ? `Completed ${payload.data.length} due source runs.` : (payload.error || 'Due ingestion failed'))
  await refresh()
}

async function importServiceAssets(kind) {
  setStatus(`Importing service assets as ${kind.toUpperCase()}...`)
  const key = kind === 'geojson' ? 'service_assets_geojson' : 'service_assets_csv'
  const response = await fetch('/api/v1/service-assets', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ [key]: $('serviceAssetInput')?.value }),
  })
  const payload = await response.json()
  setStatus(payload.success ? `Imported ${payload.imported} service assets.` : ((payload.errors || [payload.error]).join(' | ')))
  await refresh()
}

// =============================================================
// Settings panel
// =============================================================
function renderSettingsPanel() {
  fetchJson('/api/v1/trigger-protocols').then((payload) => {
    const list = $('triggerProtocolsList')
    if (!list) return
    const protos = payload.data || []
    list.innerHTML = protos.length
      ? protos.map((p) => `<div class="source-card"><div class="source-card-header">
          <span class="source-name">${escapeHtml(p.name || p.id)}</span>
        </div></div>`).join('')
      : `<p class="settings-note">No trigger protocols configured.</p>`
  }).catch(() => {
    const list = $('triggerProtocolsList')
    if (list) list.innerHTML = `<p class="settings-note">Trigger protocols unavailable.</p>`
  })

  fetchJson('/api/v1/webhooks').then((payload) => {
    const list = $('webhooksList')
    if (!list) return
    const webhooks = payload.data || []
    list.innerHTML = webhooks.length
      ? webhooks.map((w) => `<div class="source-card"><div class="source-card-header">
          <span class="source-name">${escapeHtml(w.url || w.id)}</span>
          <span class="status-pill status-${safeClass(w.status || 'unknown')}">${escapeHtml(w.status || 'unknown')}</span>
        </div></div>`).join('')
      : `<p class="settings-note">No webhooks configured.</p>`
  }).catch(() => {})
}

$('addWebhookForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const url    = $('webhookUrlInput')?.value?.trim()
  const events = ($('webhookEventsInput')?.value || 'alert.*').split(',').map((s) => s.trim()).filter(Boolean)
  if (!url) return
  const payload = await postJson('/api/v1/webhooks', { url, events })
  setStatus(payload.success ? `Webhook added.` : (payload.error || 'Webhook failed'))
  renderSettingsPanel()
})

// Operations forms
$('createIncidentButton')?.addEventListener('click', createIncident)
$('createInterventionButton')?.addEventListener('click', createIntervention)
$('createTaskButton')?.addEventListener('click', createTask)
$('createAlertRuleButton')?.addEventListener('click', createAlertRule)
$('evaluateAlertsButton')?.addEventListener('click', evaluateAlerts)
$('sendRapidProAlertButton')?.addEventListener('click', sendLatestRapidProAlert)
$('createReportScheduleButton')?.addEventListener('click', createReportSchedule)
$('runDueReportsButton')?.addEventListener('click', runDueReports)

async function createIncident() {
  setStatus('Creating incident...')
  const body = {
    title:         $('incidentTitleInput')?.value,
    incident_type: $('incidentTypeInput')?.value,
    priority:      $('incidentPriorityInput')?.value,
    country:       $('countryInput')?.value,
    latitude:      Number($('latInput')?.value),
    longitude:     Number($('lonInput')?.value),
  }
  const payload = await postJson('/api/v1/incidents', body)
  if (!payload.success) { setStatus(payload.error || 'Incident creation failed'); return }
  const intInput = $('interventionIncidentInput')
  if (intInput) intInput.value = payload.data.id
  setStatus(`Created incident ${payload.data.id}.`)
  await refresh()
}

async function createIntervention() {
  setStatus('Creating intervention...')
  const body = {
    incident_id: $('interventionIncidentInput')?.value,
    title:       $('interventionTitleInput')?.value,
    lead_org:    $('interventionLeadInput')?.value,
    status:      'active',
  }
  const payload = await postJson('/api/v1/interventions', body)
  if (!payload.success) { setStatus(payload.error || 'Intervention creation failed'); return }
  const taskInput = $('taskInterventionInput')
  if (taskInput) taskInput.value = payload.data.id
  setStatus(`Created intervention ${payload.data.id}.`)
  await refresh()
}

async function createTask() {
  setStatus('Creating task...')
  const body = {
    intervention_id: $('taskInterventionInput')?.value,
    title:           $('taskTitleInput')?.value,
    owner:           $('taskOwnerInput')?.value,
    status:          'todo',
  }
  const payload = await postJson('/api/v1/tasks', body)
  if (!payload.success) { setStatus(payload.error || 'Task creation failed'); return }
  setStatus(`Created task ${payload.data.id}.`)
  await refresh()
}

async function createAlertRule() {
  setStatus('Creating alert rule...')
  const payload = await postJson('/api/v1/alert-rules', {
    name:      $('alertNameInput')?.value,
    metric:    $('alertMetricInput')?.value,
    operator:  '>=',
    threshold: Number($('alertThresholdInput')?.value),
    severity:  'high',
    actions:   [{ type: 'notify', target: 'response-lead' }],
  })
  if (!payload.success) { setStatus(payload.error || 'Alert rule creation failed'); return }
  setStatus(`Created alert rule ${payload.data.id}.`)
  await refresh()
}

async function evaluateAlerts() {
  setStatus('Evaluating alert rules...')
  const payload = await postJson('/api/v1/alerts/evaluate', {})
  if (!payload.success) { setStatus(payload.error || 'Alert evaluation failed'); return }
  setStatus(`Evaluated ${payload.evaluated} rules; created ${payload.created} alert events.`)
  await refresh()
}

async function sendLatestRapidProAlert() {
  setStatus('Sending latest alert through RapidPro...')
  const alerts = await fetchJson('/api/v1/alert-events?status=open&limit=1')
  const alert = alerts.data?.[0]
  if (!alert) { setStatus('No open alert event to send.'); return }
  const urns = $('rapidProUrnsInput')?.value?.split(',').map((u) => u.trim()).filter(Boolean)
  const payload = await postJson(`/api/v1/rapidpro/alert-events/${alert.id}/send`, { urns })
  if (!payload.success) { setStatus(payload.data?.error || payload.error || 'RapidPro dispatch failed'); return }
  setStatus(`RapidPro dispatch ${payload.data.id} recorded.`)
  await refresh()
}

async function createReportSchedule() {
  setStatus('Creating report schedule...')
  let templateId = $('reportTemplateIdInput')?.value?.trim()
  if (!templateId) {
    await createReportTemplate()
    templateId = $('reportTemplateIdInput')?.value?.trim()
  }
  const localValue = $('reportScheduleNextRunInput')?.value
  const payload = await postJson('/api/v1/report-schedules', {
    template_id:  templateId,
    timezone:     Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    recurrence:   { type: 'daily', time: '07:00' },
    next_run_at:  localValue ? new Date(localValue).toISOString() : undefined,
    auto_distribute: false,
  })
  if (!payload.success) { setStatus(payload.error || 'Report schedule creation failed'); return }
  setStatus(`Created report schedule ${payload.data.id}.`)
  await refresh()
}

async function runDueReports() {
  setStatus('Running due report schedules...')
  const payload = await postJson('/api/v1/report-schedules/run-due', {})
  if (!payload.success) { setStatus(payload.error || 'Due report run failed'); return }
  setStatus(`Completed ${payload.data.length} due report schedule runs.`)
  await refresh()
}

// =============================================================
// Detail dialog
// =============================================================
const detailDialog  = $('detailDialog')
const detailTitleEl = $('detailTitle')
const detailBodyEl  = $('detailBody')

function openDetailDialog(record) {
  if (!detailDialog) return
  const label = record.title || record.name || record.event_type || record.id || 'Detail'
  detailTitleEl.textContent = label
  const entries = Object.entries(record).filter(([k]) => k !== 'metadata')
  detailBodyEl.innerHTML = `<dl>${entries.map(([k, v]) =>
    `<dt>${escapeHtml(k.replaceAll('_', ' '))}</dt><dd>${escapeHtml(String(v ?? ''))}</dd>`
  ).join('')}</dl>`
  detailDialog.showModal()
}

detailDialog?.addEventListener('click', (e) => {
  if (e.target === detailDialog) detailDialog.close()
})

document.querySelectorAll('.dialog-close').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog')?.close())
})

// =============================================================
// Command palette
// =============================================================
const cmdPalette   = $('commandPalette')
const paletteInput = $('paletteInput')
const paletteResults = $('paletteResults')

const PALETTE_BASE = [
  { icon: '1', label: 'Alerts tab',              category: 'Navigation', action: () => switchTab('alerts') },
  { icon: '2', label: 'Reports tab',             category: 'Navigation', action: () => switchTab('reports') },
  { icon: '3', label: 'Ingestion tab',           category: 'Navigation', action: () => switchTab('ingestion') },
  { icon: '4', label: 'Settings tab',            category: 'Navigation', action: () => switchTab('settings') },
  { icon: '>', label: 'Run all due sources',     category: 'Ingestion',  action: runDueIngestion },
  { icon: '>', label: 'Create default schedules',category: 'Ingestion',  action: createPublicIngestionSchedules },
  { icon: '+', label: 'Generate report',         category: 'Reports',   action: generateReport },
  { icon: '+', label: 'Approve latest report',   category: 'Reports',   action: approveLatestReport },
  { icon: '+', label: 'Distribute latest report',category: 'Reports',   action: distributeLatestReport },
  { icon: '!', label: 'Evaluate alert rules',    category: 'Alerts',    action: evaluateAlerts },
  { icon: '?', label: 'Keyboard shortcuts',      category: 'Help',      action: () => $('shortcutDialog')?.showModal() },
  { icon: '~', label: 'Export GeoJSON',          category: 'Export',    action: () => window.open('/api/v1/export.geojson', '_blank') },
  { icon: '~', label: 'Export CSV',              category: 'Export',    action: () => window.open('/api/v1/export.csv', '_blank') },
  { icon: 'r', label: 'Refresh data',            category: 'System',    action: refresh },
]

function openPalette() {
  if (!cmdPalette) return
  if (paletteInput) paletteInput.value = ''
  state._paletteIndex = 0
  renderPaletteResults('')
  cmdPalette.showModal()
  paletteInput?.focus()
}

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase()
  const recentAlerts = (state.data.alerts?.data || []).slice(0, 3).map((a) => ({
    icon: '!',
    label: `Alert: ${a.rule_name || a.id || ''}`,
    category: 'Recent alerts',
    action: () => { switchTab('alerts'); openDetailDialog(a) },
  }))

  const all = [...recentAlerts, ...PALETTE_BASE]
  const items = q
    ? all.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
    : all

  state._paletteItems = items
  state._paletteIndex = 0

  paletteResults.innerHTML = items.map((item, i) => `
    <li class="palette-result${i === 0 ? ' selected' : ''}"
        data-index="${i}" role="option" aria-selected="${i === 0}">
      <span class="palette-result-icon">${escapeHtml(item.icon)}</span>
      <span class="palette-result-label">${escapeHtml(item.label)}</span>
      <span class="palette-result-category">${escapeHtml(item.category)}</span>
    </li>
  `).join('')

  paletteResults.querySelectorAll('.palette-result').forEach((li, i) => {
    li.addEventListener('click', () => {
      cmdPalette.close()
      items[i]?.action?.()
    })
  })
}

paletteInput?.addEventListener('input', debounce((e) => renderPaletteResults(e.target.value), 100))

paletteInput?.addEventListener('keydown', (e) => {
  const items = paletteResults.querySelectorAll('.palette-result')
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    state._paletteIndex = Math.min(state._paletteIndex + 1, items.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    state._paletteIndex = Math.max(state._paletteIndex - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    cmdPalette.close()
    state._paletteItems[state._paletteIndex]?.action?.()
    return
  } else {
    return
  }
  items.forEach((li, i) => {
    const selected = i === state._paletteIndex
    li.classList.toggle('selected', selected)
    li.setAttribute('aria-selected', String(selected))
  })
})

cmdPalette?.addEventListener('click', (e) => {
  if (e.target === cmdPalette) cmdPalette.close()
})

$('cmdPaletteButton')?.addEventListener('click', openPalette)

// =============================================================
// Keyboard shortcuts
// =============================================================
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase()
  const inInput = ['input', 'textarea', 'select'].includes(tag)

  // Cmd/Ctrl+K from anywhere
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openPalette()
    return
  }

  if (e.key === 'Escape') {
    document.querySelectorAll('dialog[open]').forEach((dlg) => dlg.close())
    return
  }

  if (inInput) return

  if (e.key === '/') { e.preventDefault(); $('mapSeverity')?.focus(); return }
  if (e.key === '?') { $('shortcutDialog')?.showModal(); return }
  if (e.key === 'r' || e.key === 'R') { refresh(); return }
  if (e.key === '1') { switchTab('alerts'); return }
  if (e.key === '2') { switchTab('reports'); return }
  if (e.key === '3') { switchTab('ingestion'); return }
  if (e.key === '4') { switchTab('settings'); return }
})

// =============================================================
// Locale select
// =============================================================
const locSel = $('locale-select')
if (locSel) {
  locSel.value = state.locale
  locSel.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await loadLocale(state.locale)
  })
}

// =============================================================
// Button wiring
// =============================================================
$('refreshButton')?.addEventListener('click', refresh)
$('runButton')?.addEventListener('click', runIngestion)
$('createIngestionSchedulesButton')?.addEventListener('click', createPublicIngestionSchedules)
$('runDueIngestionButton')?.addEventListener('click', runDueIngestion)
$('importCsvButton')?.addEventListener('click', () => importServiceAssets('csv'))
$('importGeoJsonButton')?.addEventListener('click', () => importServiceAssets('geojson'))
$('exportGeoJsonButton')?.addEventListener('click', () => window.open('/api/v1/export.geojson', '_blank'))
$('exportCsvButton')?.addEventListener('click', () => window.open('/api/v1/export.csv', '_blank'))

// =============================================================
// Auto-refresh (30s)
// =============================================================
setInterval(refresh, 30_000)

// =============================================================
// Boot
// =============================================================
await loadLocale(state.locale)
await loadSources()
await refresh()
