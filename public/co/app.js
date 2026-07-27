// CO/Donor read-only dashboard
// Fetches: /api/v1/kpi/quarterly, /api/v1/equity/by-district,
//          /api/v1/rapidpro/dispatches, /api/v1/community-feedback/summary

let currentLocale = 'en'
let i18n = {}

async function loadLocale(locale) {
  try {
    const res = await fetch(`/i18n/${locale}.json`)
    if (res.ok) i18n = await res.json()
  } catch {
    i18n = {}
  }
  currentLocale = locale
  applyI18n()
}

function t(key, fallback = key) {
  return i18n[key] || fallback
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n
    if (i18n[key]) el.textContent = i18n[key]
  })
}

function currentQuarter() {
  const m = new Date().getUTCMonth() + 1
  if (m <= 3) return 'Q1'
  if (m <= 6) return 'Q2'
  if (m <= 9) return 'Q3'
  return 'Q4'
}

function fmtVal(v, unit = '') {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return `${v.toFixed(1)}${unit}`
  return `${v}${unit}`
}

function kpiTileHtml(label, value, unit, annotation, isDataGap) {
  const displayVal = value !== null ? value : '—'
  const gapChip = isDataGap ? `<span class="chip-data-gap" data-i18n="co.data_gap">${t('co.data_gap', 'data gap')}</span>` : ''
  const ann = annotation ? `<span class="kpi-tile-annotation">${annotation}</span>` : ''
  return `
    <div class="kpi-tile">
      <span class="kpi-tile-label">${label}</span>
      <span class="kpi-tile-value">${displayVal}</span>
      <span class="kpi-tile-unit">${unit} ${gapChip}</span>
      ${ann}
    </div>
  `
}

function renderKpi(kpi) {
  const grid = document.getElementById('kpi-grid')
  if (!grid) return

  const tiles = [
    { key: 'co.kpi_people_reached', label: t('co.kpi_people_reached', 'People reached'), value: fmtVal(kpi.people_reached, ''), unit: 'people', annotation: '', gap: false },
    { key: 'co.kpi_percent_u18', label: t('co.kpi_percent_u18', '% Children U18'), value: fmtVal(kpi.percent_children_u18, ''), unit: '%', annotation: '', gap: kpi.percent_children_u18 === null },
    { key: 'co.kpi_percent_women', label: t('co.kpi_percent_women', '% Women and girls'), value: fmtVal(kpi.percent_women_and_girls, ''), unit: '%', annotation: '', gap: kpi.percent_women_and_girls === null },
    { key: 'co.kpi_percent_pwd', label: t('co.kpi_percent_pwd', '% PwD'), value: fmtVal(kpi.percent_pwd, ''), unit: '%', annotation: '', gap: kpi.percent_pwd === null },
    { key: 'co.kpi_reporters', label: t('co.kpi_reporters', 'Community reporters'), value: fmtVal(kpi.community_reporters_count, ''), unit: 'reporters', annotation: '', gap: false },
    { key: 'co.kpi_mappers', label: t('co.kpi_mappers', 'Youth mappers'), value: fmtVal(kpi.youth_mappers_count, ''), unit: 'mappers', annotation: '', gap: kpi.youth_mappers_count === 0 },
    { key: 'co.kpi_oss_releases', label: t('co.kpi_oss_releases', 'OSS releases'), value: fmtVal(kpi.oss_releases_count, ''), unit: 'releases', annotation: '', gap: false },
    { key: 'co.kpi_warning_to_action', label: t('co.kpi_warning_to_action', 'Warning-to-action median'), value: fmtVal(kpi.warning_to_action_median_hours, ''), unit: 'hours', annotation: t('co.kpi_warning_to_action_target', 'target: <24h'), gap: kpi.warning_to_action_median_hours === null },
    { key: 'co.kpi_feeding_repositioning', label: t('co.kpi_feeding_repositioning', 'Feeding repositioning rate'), value: fmtVal(kpi.feeding_supply_repositioning_rate, ''), unit: '%', annotation: '', gap: kpi.feeding_supply_repositioning_rate === null },
    { key: 'co.kpi_cold_chain', label: t('co.kpi_cold_chain', 'Cold-chain protection rate'), value: fmtVal(kpi.cold_chain_protection_rate, ''), unit: '%', annotation: '', gap: kpi.cold_chain_protection_rate === null },
    { key: 'co.kpi_false_alerts', label: t('co.kpi_false_alerts', 'False alert rate'), value: fmtVal(kpi.false_alert_rate, ''), unit: '%', annotation: '', gap: kpi.false_alert_rate === null },
    { key: 'co.kpi_api_uptime', label: t('co.kpi_api_uptime', 'API uptime'), value: fmtVal(kpi.api_uptime_pct, ''), unit: '%', annotation: '', gap: false },
  ]

  grid.innerHTML = tiles.map((t) => kpiTileHtml(t.label, t.value, t.unit, t.annotation, t.gap)).join('')
  document.getElementById('kpi-section').hidden = false
}

function renderCohort(cohort) {
  const body = document.getElementById('cohort-body')
  if (!body) return
  const dash = (v) => (v !== null && v !== undefined ? v : '—')
  body.innerHTML = `<tr>
    <td>${dash(cohort.total)}</td>
    <td>${dash(cohort.u18)}</td>
    <td>${dash(cohort.women_and_girls)}</td>
    <td>${dash(cohort.pwd)}</td>
    <td>${dash(cohort.refugees_idps)}</td>
  </tr>`
  document.getElementById('cohort-section').hidden = false
}

function renderEquity(rows) {
  const body = document.getElementById('equity-body')
  if (!body) return
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--ink-muted)">No equity data yet.</td></tr>'
  } else {
    body.innerHTML = rows.map((r) => {
      const acc = r.accuracy_pct !== null ? `${r.accuracy_pct.toFixed(1)}%` : '—'
      const isBreach = r.accuracy_pct !== null && r.dispatched >= 5 && r.accuracy_pct < 80
      const breachChip = isBreach ? `<span class="chip-breach" data-i18n="co.equity_breach">${t('co.equity_breach', 'breach')}</span>` : ''
      const rowClass = isBreach ? 'breach-row' : ''
      return `<tr class="${rowClass}">
        <td>${r.district}</td>
        <td>${r.dispatched}</td>
        <td>${r.acknowledged}</td>
        <td>${acc}</td>
        <td>${breachChip}</td>
      </tr>`
    }).join('')
  }
  document.getElementById('equity-section').hidden = false
}

const LAG_BUCKETS = [
  { label: '0-6h', max: 6 },
  { label: '6-12h', max: 12 },
  { label: '12-24h', max: 24 },
  { label: '24-48h', max: 48 },
  { label: '48h+', max: Infinity },
]

function renderHistogram(dispatches) {
  const container = document.getElementById('histogram')
  if (!container) return

  const counts = LAG_BUCKETS.map(() => 0)

  for (const d of dispatches) {
    if (!d.sent_at || !d.queued_at) continue
    const lagH = (new Date(d.sent_at).getTime() - new Date(d.queued_at).getTime()) / 3600000
    if (lagH < 0) continue
    const bucketIdx = LAG_BUCKETS.findIndex((b) => lagH <= b.max)
    if (bucketIdx >= 0) counts[bucketIdx] += 1
  }

  const maxCount = Math.max(...counts, 1)
  const maxPx = 70

  container.innerHTML = LAG_BUCKETS.map((b, i) => {
    const h = Math.round((counts[i] / maxCount) * maxPx)
    return `<div class="hist-bar-wrap">
      <span class="hist-count">${counts[i]}</span>
      <div class="hist-bar" style="height:${h}px"></div>
      <span class="hist-label">${b.label}</span>
    </div>`
  }).join('')

  document.getElementById('histogram-section').hidden = false
}

function renderFeedback(summary) {
  const body = document.getElementById('feedback-body')
  if (!body) return
  if (!summary.length) {
    body.innerHTML = '<tr><td colspan="6" style="color:var(--ink-muted)">No feedback yet.</td></tr>'
  } else {
    body.innerHTML = summary.map((row) => `<tr>
      <td>${row.alert_event_id || '—'}</td>
      <td>${row.count}</td>
      <td>${row.sentiment.positive || 0}</td>
      <td>${row.sentiment.negative || 0}</td>
      <td>${row.sentiment.unclear || 0}</td>
      <td>${row.action_taken_count || 0}</td>
    </tr>`).join('')
  }
  document.getElementById('feedback-section').hidden = false
}

function updateExportBtn(quarter, year) {
  const btn = document.getElementById('export-btn')
  if (btn) btn.href = `/api/v1/kpi/quarterly.pdf?quarter=${quarter}&year=${year}`
}

async function load() {
  const quarterSel = document.getElementById('quarter-select')
  const yearSel = document.getElementById('year-select')

  const q = quarterSel?.value || currentQuarter()
  const y = yearSel?.value || new Date().getUTCFullYear()

  updateExportBtn(q, y)

  const loading = document.getElementById('loading-banner')
  if (loading) loading.hidden = false

  try {
    const [kpiRes, equityRes, dispatchRes, feedbackRes] = await Promise.all([
      fetch(`/api/v1/kpi/quarterly?quarter=${q}&year=${y}`),
      fetch('/api/v1/equity/by-district'),
      fetch('/api/v1/rapidpro/dispatches'),
      fetch('/api/v1/community-feedback/summary'),
    ])

    if (kpiRes.ok) {
      const { data: kpi } = await kpiRes.json()
      renderKpi(kpi)
      renderCohort(kpi.cohort || {})
      const sigEl = document.getElementById('sig-hash')
      if (sigEl) sigEl.textContent = `sig: ${kpi.generated_at?.slice(0, 16) || ''}`
      const genEl = document.getElementById('gen-time')
      if (genEl) genEl.textContent = kpi.generated_at || ''
    }

    if (equityRes.ok) {
      const { data: equity } = await equityRes.json()
      renderEquity(equity || [])
    }

    if (dispatchRes.ok) {
      const { data: dispatches } = await dispatchRes.json()
      renderHistogram(dispatches || [])
    }

    if (feedbackRes.ok) {
      const { data: summary } = await feedbackRes.json()
      renderFeedback(summary || [])
    }
  } catch (err) {
    console.error('CO dashboard load error:', err)
  } finally {
    if (loading) loading.hidden = true
  }
}

function init() {
  const localeSel = document.getElementById('locale-select')
  const quarterSel = document.getElementById('quarter-select')
  const yearSel = document.getElementById('year-select')

  // Set default quarter
  if (quarterSel) quarterSel.value = currentQuarter()

  localeSel?.addEventListener('change', (e) => {
    loadLocale(e.target.value).then(load)
  })

  quarterSel?.addEventListener('change', load)
  yearSel?.addEventListener('change', load)

  loadLocale('en').then(load)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
