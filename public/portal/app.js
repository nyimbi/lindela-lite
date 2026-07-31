import { initI18n, t, apiFetch, initOfflineBanner } from '/shared/runtime.js'
import { mountNavbar } from '/shared/navbar.js'
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
  try {
    const [risk, hazards, assets, alerts] = await Promise.all([
      apiFetch(`/api/v1/flood-risk?partner_org=${state.partnerOrg}`),
      apiFetch(`/api/v1/events?partner_org=${state.partnerOrg}`),
      apiFetch(`/api/v1/service-assets?partner_org=${state.partnerOrg}`),
      apiFetch(`/api/v1/rapidpro/dispatches?partner_org=${state.partnerOrg}`),
    ])

    state.data.risk = risk.data || []
    state.data.hazards = hazards.data || []
    state.data.assets = assets.data || []
    state.data.alerts = alerts.data || []

    renderRiskTable()
    renderHazardsTable()
    renderAssetsTable()
    renderAlertsTable()
  } catch (error) {
    console.error('Failed to load data:', error)
  }
}

function renderRiskTable() {
  const tbody = $('riskTableBody')
  if (state.data.risk.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state" data-i18n="portal.no_data">No data available</td></tr>'
    return
  }

  tbody.innerHTML = state.data.risk.map((r) => `
    <tr>
      <td>${escapeHtml(r.district || '')}</td>
      <td>${(r.risk_score || 0).toFixed(2)}</td>
      <td>${(r.confidence || 0).toFixed(2)}</td>
    </tr>
  `).join('')
}

function renderHazardsTable() {
  const tbody = $('hazardsTableBody')
  const events = [...(state.data.hazards || [])].sort((a, b) => {
    return new Date(b.created_at || 0) - new Date(a.created_at || 0)
  }).slice(0, 100)

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state" data-i18n="portal.no_data">No data available</td></tr>'
    return
  }

  tbody.innerHTML = events.map((e) => `
    <tr>
      <td>${escapeHtml(e.headline || e.event_type || '')}</td>
      <td>${escapeHtml(e.event_type || '')}</td>
      <td>${formatDate(e.created_at)}</td>
      <td>${escapeHtml(e.severity || '')}</td>
    </tr>
  `).join('')
}

function renderAssetsTable() {
  const tbody = $('assetsTableBody')
  if (state.data.assets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state" data-i18n="portal.no_data">No data available</td></tr>'
    return
  }

  tbody.innerHTML = state.data.assets.map((a) => `
    <tr>
      <td>${escapeHtml(a.name || '')}</td>
      <td>${escapeHtml(a.asset_type || '')}</td>
      <td>${escapeHtml(a.district || '')}</td>
    </tr>
  `).join('')
}

function renderAlertsTable() {
  const tbody = $('alertsTableBody')
  const alerts = [...(state.data.alerts || [])].sort((a, b) => {
    return new Date(b.created_at || 0) - new Date(a.created_at || 0)
  }).slice(0, 100)

  if (alerts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state" data-i18n="portal.no_data">No data available</td></tr>'
    return
  }

  tbody.innerHTML = alerts.map((a) => `
    <tr>
      <td>${escapeHtml(a.headline || a.event_type || '')}</td>
      <td>${escapeHtml(a.severity || '')}</td>
      <td>${formatDate(a.created_at)}</td>
    </tr>
  `).join('')
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
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]))
}

await init()
