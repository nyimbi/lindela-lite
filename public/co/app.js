// CO/Donor read-only dashboard
// Fetches: /api/v1/kpi/quarterly, /api/v1/equity/by-district,
//          /api/v1/rapidpro/dispatches, /api/v1/community-feedback/summary
//
// This file had no escape function of any kind, unlike the console's 55 uses of
// one. District names, alert event ids and quarter labels were interpolated
// into innerHTML raw. The helpers now come from the shared module.

import { esc, formatTimestamp, num, pct } from '/shared/fmt.js'

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

/**
 * How many alerts the false-alert rate rests on, and why it may be absent.
 *
 * The metric used to be a keyword scan of free-text resolution notes divided by
 * the alert count, which reported 0% on the demo data — read as "no false alerts"
 * when it meant "nobody wrote the word false". It is now measured only over alerts
 * with a recorded determination, so the denominator is small and must be visible.
 */
function falseAlertAnnotation(kpi) {
  const n = kpi.false_alert_determined
  if (!n) return 'no alert outcomes recorded yet'
  const of = kpi.false_alert_of_total ?? '?'
  return `${n} of ${of} alerts reviewed for outcome`
}

/**
 * Format a KPI value.
 *
 * This applied `toFixed(1)` to everything, so a count of people rendered as
 * "203.0 people" and a percentage as "100.0 %" — a spurious decimal place that
 * reads as false precision on the quarterly numbers a donor reads. Counts are
 * integers; percentages keep one place; a string is passed through.
 */
function fmtVal(v, unit = '') {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number') return `${v}${unit}`
  const isCount = unit === 'people' || unit === 'reporters' || unit === 'mappers' ||
                  unit === 'releases' || unit === 'deliveries' || unit === 'assets'
  if (isCount) return Math.round(v).toLocaleString()
  if (unit === '%') return v.toFixed(1)
  return v.toFixed(1)
}

function kpiTileHtml(label, value, unit, annotation, isDataGap) {
  const displayVal = value !== null && value !== undefined ? value : '—'
  const gapChip = isDataGap ? `<span class="chip-data-gap" data-i18n="co.data_gap">${esc(t('co.data_gap', 'data gap'))}</span>` : ''
  const ann = annotation ? `<span class="kpi-tile-annotation">${esc(annotation)}</span>` : ''
  return `
    <div class="kpi-tile">
      <span class="kpi-tile-label">${esc(label)}</span>
      <span class="kpi-tile-value">${esc(displayVal)}</span>
      <span class="kpi-tile-unit">${esc(unit)} ${gapChip}</span>
      ${ann}
    </div>
  `
}

function renderKpi(kpi) {
  const grid = document.getElementById('kpi-grid')
  if (!grid) return

  const tiles = [
    { key: 'co.kpi_people_reached', label: t('co.kpi_people_reached', 'People reached'), value: fmtVal(kpi.people_reached, 'people'), unit: 'people', annotation: '', gap: false },
    { key: 'co.kpi_percent_u18', label: t('co.kpi_percent_u18', '% Children U18'), value: fmtVal(kpi.percent_children_u18, '%'), unit: '%', annotation: '', gap: kpi.percent_children_u18 === null },
    { key: 'co.kpi_percent_women', label: t('co.kpi_percent_women', '% Women and girls'), value: fmtVal(kpi.percent_women_and_girls, '%'), unit: '%', annotation: '', gap: kpi.percent_women_and_girls === null },
    { key: 'co.kpi_percent_pwd', label: t('co.kpi_percent_pwd', '% PwD'), value: fmtVal(kpi.percent_pwd, '%'), unit: '%', annotation: '', gap: kpi.percent_pwd === null },
    { key: 'co.kpi_reporters', label: t('co.kpi_reporters', 'Community reporters'), value: fmtVal(kpi.community_reporters_count, 'reporters'), unit: 'reporters', annotation: '', gap: false },
    { key: 'co.kpi_mappers', label: t('co.kpi_mappers', 'Youth mappers'), value: fmtVal(kpi.youth_mappers_count, 'mappers'), unit: 'mappers', annotation: '', gap: kpi.youth_mappers_count === 0 },
    { key: 'co.kpi_oss_releases', label: t('co.kpi_oss_releases', 'OSS releases'), value: fmtVal(kpi.oss_releases_count, 'releases'), unit: 'releases', annotation: '', gap: false },
    // Labelled "Warning-to-action median" against a "<24h" UNICEF bid target, a
    // figure of 0.16 h sat right next to it. What it measures is how fast this
    // platform sent an SMS once a dispatch matched a signal — our own dispatch
    // latency. UNICEF's warning-to-action runs from a warning reaching a
    // household to a field action being completed and reported, which this does
    // not observe at all. Naming it accurately matters more than the comparison
    // looking good next to a bid target.
    { key: 'co.kpi_warning_to_action', label: t('co.kpi_warning_to_action', 'Signal-to-dispatch median'), value: fmtVal(kpi.warning_to_action_median_hours, 'hours'), unit: 'hours', annotation: 'signal matched → SMS sent; not a field action', gap: kpi.warning_to_action_median_hours === null },
    { key: 'co.kpi_feeding_repositioning', label: t('co.kpi_feeding_repositioning', 'Feeding repositioning rate'), value: fmtVal(kpi.feeding_supply_repositioning_rate, '%'), unit: '%', annotation: '', gap: kpi.feeding_supply_repositioning_rate === null },
    { key: 'co.kpi_cold_chain', label: t('co.kpi_cold_chain', 'Cold-chain protection rate'), value: fmtVal(kpi.cold_chain_protection_rate, '%'), unit: '%', annotation: '', gap: kpi.cold_chain_protection_rate === null },
    // The denominator travels with the number. A proportion computed from one
    // determined alert swings between 0% and 100% on a single record, so the
    // sample size is shown rather than a threshold being invented to suppress it.
    { key: 'co.kpi_false_alerts', label: t('co.kpi_false_alerts', 'False alert rate'), value: fmtVal(kpi.false_alert_rate, '%'), unit: '%', annotation: falseAlertAnnotation(kpi), gap: kpi.false_alert_rate === null },
    { key: 'co.kpi_api_uptime', label: t('co.kpi_api_uptime', 'API uptime'), value: fmtVal(kpi.api_uptime_pct, '%'), unit: '%', annotation: '', gap: false },
  ]

  grid.innerHTML = tiles.map((t) => kpiTileHtml(t.label, t.value, t.unit, t.annotation, t.gap)).join('')
  document.getElementById('kpi-section').hidden = false
}

function renderCohort(cohort) {
  const body = document.getElementById('cohort-body')
  if (!body) return
  const dash = (v) => (v !== null && v !== undefined ? v : '—')
  body.innerHTML = `<tr>
    <td class="num-cell">${dash(cohort.total)}</td>
    <td class="num-cell">${dash(cohort.u18)}</td>
    <td class="num-cell">${dash(cohort.women_and_girls)}</td>
    <td class="num-cell">${dash(cohort.pwd)}</td>
    <td class="num-cell">${dash(cohort.refugees_idps)}</td>
  </tr>`
  document.getElementById('cohort-section').hidden = false
}

function renderEquity(rows) {
  const body = document.getElementById('equity-body')
  if (!body) return
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">No equity data yet.</td></tr>'
  } else {
    body.innerHTML = rows.map((r) => {
      const acc = pct(r.accuracy_pct)
      const isBreach = r.accuracy_pct !== null && r.dispatched >= 5 && r.accuracy_pct < 80
      const breachChip = isBreach ? `<span class="chip-breach" data-i18n="co.equity_breach">${t('co.equity_breach', 'breach')}</span>` : ''
      const rowClass = isBreach ? 'breach-row' : ''
      const slug = (r.district || '').toLowerCase().replace(/\s+/g, '-')
      return `<tr class="${rowClass}">
        <td><a class="district-link" href="/districts#/${encodeURIComponent(slug)}">${esc(r.district)}</a></td>
        <td class="num-cell">${num(r.dispatched, { int: true })}</td>
        <td class="num-cell">${num(r.acknowledged, { int: true })}</td>
        <td class="num-cell">${acc}</td>
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
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">No feedback yet.</td></tr>'
  } else {
    body.innerHTML = summary.map((row) => `<tr>
      <td>${esc(row.alert_event_id || '—')}</td>
      <td class="num-cell">${num(row.count, { int: true })}</td>
      <td class="num-cell">${num(row.sentiment?.positive, { int: true })}</td>
      <td class="num-cell">${num(row.sentiment?.negative, { int: true })}</td>
      <td class="num-cell">${num(row.sentiment?.unclear, { int: true })}</td>
      <td class="num-cell">${num(row.action_taken_count, { int: true })}</td>
    </tr>`).join('')
  }
  document.getElementById('feedback-section').hidden = false
}

/**
 * A sparkline that distinguishes "no value" from "zero".
 *
 * Gaps used to be filled with 0 before plotting, so a month with no recorded
 * outcome drew as a flat line sitting on the axis — visually identical to a
 * month in which nothing happened. That is the same absence-as-zero mistake the
 * KPI itself was making, one layer down: the tile correctly showed a gap while
 * the chart under it drew a confident flat zero.
 *
 * Months with a value are connected in their own right, so a single determined
 * month shows as a single dot rather than being stretched into a trend line it
 * does not support.
 */
function buildSparkline(values, w = 200, h = 40, pad = 4) {
  if (!values || values.length < 2) return ''
  const indexed = values
    .map((v, i) => ({ v, i }))
    .filter((p) => p.v !== null && p.v !== undefined)
  if (!indexed.length) return ''
  const xs = values.length - 1
  const min = Math.min(...indexed.map((p) => p.v))
  const max = Math.max(...indexed.map((p) => p.v))
  const range = max - min || 1
  const xStep = xs > 0 ? (w - pad * 2) / xs : 0
  const at = (p) => [
    pad + p.i * xStep,
    h - pad - ((p.v - min) / range) * (h - pad * 2),
  ]
  const pts = indexed.map((p) => at(p).map((n) => n.toFixed(1)).join(',')).join(' ')
  const last = at(indexed[indexed.length - 1])
  // Only draw a connecting line when there is more than one plotted point;
  // a lone value is a dot, not a trend.
  const line = indexed.length > 1
    ? `<polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
    : ''
  return `<svg class="spark-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    line +
    `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--accent,#4a9eff)"/>` +
    `</svg>`
}

function sparkCard(label, series, field, unit = '') {
  const values = [...series].reverse().map(s => s[field] ?? null)
  const latest = values[values.length - 1]
  const prev = values[values.length - 2]
  let deltaHtml = ''
  if (latest !== null && prev !== null && prev !== undefined) {
    const pct = prev === 0 ? null : ((latest - prev) / Math.abs(prev)) * 100
    if (pct !== null) {
      const sign = pct >= 0 ? '+' : ''
      const cls = pct >= 0 ? 'up' : 'down'
      const arrow = pct >= 0 ? '&#8593;' : '&#8595;'
      deltaHtml = `<span class="spark-delta ${cls}">${arrow} ${sign}${pct.toFixed(1)}% vs prev month</span>`
    }
  }
  const displayVal = latest !== null && latest !== undefined
    ? (typeof latest === 'number' ? latest.toFixed(latest % 1 === 0 ? 0 : 1) : latest)
    : '—'
  return `<div class="spark-tile">
    <span class="spark-label">${label}</span>
    <span class="spark-value">${displayVal}<span style="font-size:0.8rem;font-weight:400;color:var(--ink-muted)">${unit ? ' ' + unit : ''}</span></span>
    ${deltaHtml}
    ${buildSparkline(values)}
  </div>`
}

function renderTrend(series) {
  const grid = document.getElementById('trend-grid')
  if (!grid || !series || !series.length) return
  grid.innerHTML = [
    sparkCard(t('co.trend_people_reached', 'People reached'), series, 'people_reached', 'people'),
    sparkCard(t('co.trend_warning_to_action', 'Signal-to-dispatch'), series, 'warning_to_action_median_hours', 'h'),
    sparkCard(t('co.trend_false_alert', 'False alert rate'), series, 'false_alert_rate', '%'),
    sparkCard(t('co.trend_cold_chain', 'Cold-chain rate'), series, 'cold_chain_protection_rate', '%'),
  ].join('')
  document.getElementById('trend-section').hidden = false
}

function renderQoQ(series) {
  const body = document.getElementById('qoq-body')
  if (!body || !series || series.length < 3) return
  // Group by quarter: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  const quarterMap = {}
  for (const s of series) {
    const [y, m] = s.month.split('-').map(Number)
    const q = Math.ceil(m / 3)
    const key = `${y}-Q${q}`
    if (!quarterMap[key]) quarterMap[key] = { label: key, months: [] }
    quarterMap[key].months.push(s)
  }
  const quarters = Object.values(quarterMap)
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-4)

  function avg(months, field) {
    const vals = months.map(m => m[field]).filter(v => v !== null && v !== undefined)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  function sum(months, field) {
    return months.reduce((s, m) => s + (m[field] ?? 0), 0)
  }
  function fmtCell(v) {
    if (v === null || v === undefined) return '<td class="num-cell">—</td>'
    return `<td class="num-cell">${esc(num(v))}</td>`
  }

  body.innerHTML = quarters.map(q => `<tr>
    <td><strong>${esc(q.label)}</strong></td>
    ${fmtCell(sum(q.months, 'people_reached'))}
    ${fmtCell(avg(q.months, 'warning_to_action_median_hours'))}
    ${fmtCell(avg(q.months, 'false_alert_rate'))}
    ${fmtCell(avg(q.months, 'cold_chain_protection_rate'))}
  </tr>`).join('')
  document.getElementById('qoq-section').hidden = false
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
    const [kpiRes, equityRes, dispatchRes, feedbackRes, trendRes] = await Promise.all([
      fetch(`/api/v1/kpi/quarterly?quarter=${q}&year=${y}`),
      fetch('/api/v1/equity/by-district'),
      fetch('/api/v1/rapidpro/dispatches'),
      fetch('/api/v1/community-feedback/summary'),
      fetch('/api/v1/kpi/monthly-series'),
    ])

    if (kpiRes.ok) {
      const { data: kpi } = await kpiRes.json()
      renderKpi(kpi)
      renderCohort(kpi.cohort || {})
      const sigEl = document.getElementById('sig-hash')
      if (sigEl) sigEl.textContent = `signed ${formatTimestamp(kpi.generated_at)}`
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

    if (trendRes.ok) {
      const { data: series } = await trendRes.json()
      if (series && series.length) {
        renderTrend(series)
        renderQoQ(series)
      }
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
