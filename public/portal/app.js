import { initI18n, t, apiFetch, initOfflineBanner } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
import { esc as escapeHtml, formatTimestamp, num, pct, sevClass, truncate } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
mountNavbar({ activePath: '/portal' })

const state = {
  locale: localStorage.getItem('lindela_lite_locale') || 'en',
  partnerOrg: localStorage.getItem('lindela_lite_partner_org') || null,
  currentTab: 'risk',
  data: {
    risk: [],
    hazards: [],
    assets: [],
    alerts: [],
  },
}

const $ = (id) => document.getElementById(id)

const localeSelect = $('locale-select')
const signoutBtn = $('signoutBtn')
const authPanel = $('authPanel')
const contentArea = $('contentArea')
const partnerOrgDisplay = $('partnerOrg')

async function init() {
  await initI18n(state.locale)
  initOfflineBanner()

  localeSelect.value = state.locale
  localeSelect.addEventListener('change', async (e) => {
    state.locale = e.target.value
    localStorage.setItem('lindela_lite_locale', state.locale)
    await window.__i18n.set(state.locale)
    document.documentElement.lang = state.locale
    document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr'
  })

  signoutBtn.addEventListener('click', () => {
    localStorage.removeItem('lindela_lite_api_key')
    localStorage.removeItem('lindela_lite_partner_org')
    window.location.href = '/'
  })

  if (!state.partnerOrg) {
    authPanel.style.display = 'block'
    contentArea.style.display = 'none'
    return
  }

  partnerOrgDisplay.textContent = `Org: ${state.partnerOrg}`
  contentArea.style.display = 'block'
  authPanel.style.display = 'none'

  setupTabs()
  await loadData()
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'))
      e.target.classList.add('active')
      const tab = e.target.dataset.tab
      state.currentTab = tab
      $(`${tab}Tab`).classList.add('active')
    })
  })

  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tab = e.target.id.split('Export')[0]
      const format = e.target.id.split('Export')[1].toLowerCase()
      exportData(tab, format)
    })
  })
}

async function loadData() {
  const load = async (key, path) => {
    try {
      return { [key]: (await apiFetch(path)).data || [], failed: null }
    } catch (error) {
      // Settle rather than reject: this is a read-only partner view of four
      // independent collections, and one dead endpoint should not blank the
      // other three. Previously the first failure rejected the whole Promise.all
      // and the portal rendered an empty page with no explanation anywhere on
      // screen — `console.error` is not something a partner reads.
      return { [key]: [], failed: key }
    }
  }

  const results = await Promise.all([
    load('risk', `/api/v1/flood-risk?partner_org=${state.partnerOrg}`),
    load('hazards', `/api/v1/events?partner_org=${state.partnerOrg}`),
    load('assets', `/api/v1/service-assets?partner_org=${state.partnerOrg}`),
    load('alerts', `/api/v1/rapidpro/dispatches?partner_org=${state.partnerOrg}`),
  ])

  for (const result of results) {
    for (const key of ['risk', 'hazards', 'assets', 'alerts']) {
      if (result[key] !== undefined) state.data[key] = result[key]
    }
  }

  const failed = results.filter((r) => r.failed).map((r) => r.failed)

  renderRiskTable()
  renderHazardsTable()
  renderAssetsTable()
  renderAlertsTable()

  if (failed.length) showPortalError(
    failed.length === results.length
      ? 'Could not reach the server. Showing nothing rather than stale data.'
      : `Could not load: ${failed.join(', ')}.`
  )
}

function showPortalError(message) {
  let el = document.getElementById('portalError')
  if (!el) {
    el = document.createElement('div')
    el.id = 'portalError'
    el.setAttribute('role', 'alert')
    el.className = 'error-panel'
    el.style.margin = '1rem'
    document.getElementById('contentArea')?.prepend(el)
  }
  el.innerHTML = `<strong>Some data is unavailable</strong><p>${escapeHtml(message)}</p>`
}

/**
 * One table renderer for all four portal tables.
 *
 * These were four near-identical 24-line blocks differing only in body id,
 * columns and button ids. Each applied `toFixed(2)` to a value that could be
 * absent, so a missing risk score rendered "0.00" — a number where the honest
 * answer is that nothing was measured. Severity was bare text rather than the
 * same chip every other surface uses.
 */
function renderTable(bodyId, { rows, columns, sortKey, limit = 100 }) {
  const tbody = $(bodyId)
  if (!tbody) return

  const body = sortKey
    ? [...rows].sort((a, b) => new Date(b[sortKey] || 0) - new Date(a[sortKey] || 0)).slice(0, limit)
    : rows.slice(0, limit)

  if (!body.length) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-cell" data-i18n="portal.no_data">No data available</td></tr>`
    return
  }

  tbody.innerHTML = body.map((row) => `<tr>${
    columns.map((col) => `<td${col.numeric ? ' class="num-cell"' : ''}>${col.render(row)}</td>`).join('')
  }</tr>`).join('')

  if (body.length < rows.length) {
    // The limit is a deliberate cap on a partner-facing export; say so rather
    // than letting a reader assume the table is complete.
    const note = document.createElement('tr')
    note.innerHTML = `<td colspan="${columns.length}" class="empty-cell">Showing the ${body.length} most recent of ${rows.length}.</td>`
    tbody.appendChild(note)
  }
}

const severityCell = (value) =>
  `<span class="sev-chip sev-${sevClass(value)}">${escapeHtml(value || 'unknown')}</span>`

function renderRiskTable() {
  renderTable('riskTableBody', {
    rows: state.data.risk || [],
    columns: [
      { render: (r) => escapeHtml(r.district || '—') },
      // A score with no value is not zero. `|| 0` then toFixed made it so.
      { render: (r) => escapeHtml(num(r.risk_score, { dp: 2, dash: '—' })), numeric: true },
      { render: (r) => escapeHtml(pct(r.confidence, { dp: 0 })), numeric: true },
    ],
  })
}

function renderHazardsTable() {
  renderTable('hazardsTableBody', {
    rows: state.data.hazards || [],
    sortKey: 'created_at',
    columns: [
      { render: (e) => escapeHtml(truncate(e.headline || e.event_type || '—', { max: 80 })) },
      { render: (e) => escapeHtml(metricLabel(e.event_type)) },
      { render: (e) => escapeHtml(formatDate(e.created_at)) },
      { render: (e) => severityCell(e.severity) },
    ],
  })
}

function renderAssetsTable() {
  renderTable('assetsTableBody', {
    rows: state.data.assets || [],
    columns: [
      { render: (a) => escapeHtml(a.name || '—') },
      { render: (a) => escapeHtml(metricLabel(a.asset_type)) },
      { render: (a) => escapeHtml(a.district || '—') },
    ],
  })
}

function renderAlertsTable() {
  renderTable('alertsTableBody', {
    rows: state.data.alerts || [],
    sortKey: 'created_at',
    columns: [
      { render: (a) => escapeHtml(truncate(a.headline || a.event_type || '—', { max: 80 })) },
      { render: (a) => severityCell(a.severity) },
      { render: (a) => escapeHtml(formatDate(a.created_at)) },
    ],
  })
}

async function exportData(tab, format) {
  const tabMap = { risk: 'flood-risk', hazards: 'events', assets: 'service-assets', alerts: 'rapidpro/dispatches' }
  const endpoint = `/api/v1/${tabMap[tab] || tab}`
  const query = `?partner_org=${state.partnerOrg}`

  try {
    const url = format === 'csv' ? `${endpoint}/export.csv${query}` : `${endpoint}/export.geojson${query}`
    window.open(url, '_blank')
  } catch (error) {
    console.error('Export failed:', error)
  }
}

function formatDate(iso) {
  // Ambiguous and locale-dependent: "9/28/2026" reads as 28 September in
  // Nairobi and 9 February to a reader elsewhere in the same deployment.
  return formatTimestamp(iso, { style: 'date', dash: '—' })
}

// escapeHtml, num, pct, truncate and sevClass come from /shared/fmt.js. This
// file carried its own copies; the escape helper used `||`, which dropped a
// legitimate 0 or false and rendered it blank.

await init()
