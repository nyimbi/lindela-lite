// CO/Donor read-only dashboard
// Fetches: /api/v1/kpi/quarterly, /api/v1/equity/by-district,
//          /api/v1/rapidpro/dispatches, /api/v1/community-feedback/summary
//
// This file had no escape function of any kind, unlike the console's 55 uses of
// one. District names, alert event ids and quarter labels were interpolated
// into innerHTML raw. The helpers now come from the shared module.

import { esc, formatTimestamp, num, pct, truncate } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'

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

/**
 * What to say, and how loudly, about the last load.
 *
 * A quarter change swaps four tables, a KPI grid and five charts without moving
 * the reading position, so the only evidence a screen reader has that anything
 * happened is if we say so. Failures went to console.error and left the
 * previous quarter's figures standing with nothing marking them as stale —
 * which is the failure mode this codebase is most careful about elsewhere, so
 * it should not be the one place a stale number is shown silently.
 *
 * One polite region, and a visible panel that is an alert rather than a status,
 * because a missing table is not something to wait for.
 */
function announce(statusText, { errorText } = {}) {
  const status = document.getElementById('load-status')
  if (status) status.textContent = statusText
  const panel = document.getElementById('load-error')
  if (!panel) return
  panel.hidden = !errorText
  if (errorText) {
    panel.innerHTML = `<strong>${esc(t('co.error_heading', 'This dashboard did not load'))}</strong>` +
      `<p>${esc(errorText)}</p>`
  }
}

/**
 * `{name}` interpolation for the status sentences.
 *
 * An unknown placeholder is left as written rather than blanked: a translator
 * who mistypes a key should see `{perod}` in the running interface, not a
 * sentence with a hole in it.
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`))
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
    // Labelled "Warning-to-action median" against a "<24h" external target, a
    // figure of 0.16 h sat right next to it. What it measures is how fast this
    // platform sent an SMS once a dispatch matched a signal — our own dispatch
    // latency. Warning-to-action in the field-response sense runs from a warning reaching a
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
      // The named field, and the sample it was computed over. `dispatched`
      // counts every alert sent, including the ones still open and therefore
      // not yet capable of being right or wrong -- gating a breach on that
      // would flag a district for being slow to resolve.
      const precision = r.dispatch_precision_pct ?? null
      const acc = pct(precision)
      const isBreach = precision !== null && (r.determined_dispatched ?? 0) >= 5 && precision < 80
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

/**
 * The histogram as a sentence, and as the numbers behind it.
 *
 * The bars were a labelled empty div: aria-label on a div with no role
 * announces the label and nothing else, so the chart was five coloured
 * rectangles with no values. role="img" makes the summary the alternative and
 * the bars presentational; the table carries the full distribution, because a
 * donor asking "how many went past 24 hours" is asking for one bucket, not for
 * the shape.
 */
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

  const total = counts.reduce((a, b) => a + b, 0)
  container.setAttribute('aria-label', histogramSummary(counts, total))

  const data = document.getElementById('histogram-data')
  if (data) {
    data.innerHTML = `<table class="data-alt">
      <caption>${esc(t('co.histogram_table_caption', 'Dispatches by signal-to-dispatch lag'))}</caption>
      <thead>
        <tr>
          <th scope="col">${esc(t('co.lag_bucket', 'Lag'))}</th>
          <th scope="col">${esc(t('co.dispatches', 'Dispatches'))}</th>
        </tr>
      </thead>
      <tbody>
        ${LAG_BUCKETS.map((b, i) => `<tr><th scope="row">${esc(b.label)}</th><td>${counts[i]}</td></tr>`).join('')}
        <tr><th scope="row">${esc(t('co.total', 'Total'))}</th><td>${total}</td></tr>
      </tbody>
    </table>`
  }

  document.getElementById('histogram-section').hidden = false
}

/** One sentence naming where most dispatches landed and how many there were. */
function histogramSummary(counts, total) {
  if (!total) return t('co.histogram_empty', 'No dispatches recorded for this period')
  const peak = counts.indexOf(Math.max(...counts))
  const sentence = fill(t('co.histogram_summary', 'Most dispatches were sent within {bucket}; {total} dispatches in total.'), {
    bucket: LAG_BUCKETS[peak].label,
    total: String(total),
  })
  return truncate(sentence, { max: 200 })
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
function buildSparkline(values, label, w = 200, h = 40, pad = 4) {
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
  return `<svg class="spark-svg" role="img" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="${esc(label)}">` +
    line +
    `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--accent,#4a9eff)"/>` +
    `</svg>`
}

/**
 * A value the way the tile prints it.
 *
 * The sentence, the table and the tile have to agree: if the table rounds where
 * the tile does not, a reader comparing them concludes one of them is lying.
 */
function fmtPoint(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v !== 'number') return String(v)
  return v.toFixed(v % 1 === 0 ? 0 : 1)
}

/**
 * The sparkline said in words, and the twelve months behind it.
 *
 * The delta on the card is a glyph and a hue — neither of which survives a
 * screen reader — and neither says what it rose from. The sentence names the
 * direction and the two endpoints; the table carries every month, so "the
 * twelve months behind the arrow" are actually available rather than inferred.
 *
 * Months with no value are counted, not drawn and not quietly dropped: a rise
 * measured over four months and the same rise over twelve are different claims.
 */
function sparkA11y(label, values) {
  const determined = values.filter((v) => v !== null && v !== undefined)
  const first = determined[0]
  const last = determined[determined.length - 1]
  const months = t('co.months', '{n} months').replace('{n}', String(values.length))

  if (determined.length < 2) {
    return fill(t('co.spark_single', '{label}, {months}: {value} recorded in {n} month(s); not enough data for a trend'), {
      label, months, value: fmtPoint(first), n: String(determined.length),
    })
  }
  const dir = last > first ? t('co.spark_rising', 'rising') : last < first ? t('co.spark_falling', 'falling') : t('co.spark_flat', 'unchanged')
  return fill(t('co.spark_summary', '{label}, {months}: {dir} from {first} to {last}, {n} months with a value'), {
    label, months, dir, first: fmtPoint(first), last: fmtPoint(last), n: String(determined.length),
  })
}

/** The series behind one sparkline, as a table a screen reader can walk. */
function sparkSeriesTable(label, series, field) {
  const head = `<thead><tr><th scope="col">${esc(t('co.month', 'Month'))}</th>` +
    `<th scope="col">${esc(metricLabel(field))}</th></tr></thead>`
  const rows = [...series].reverse().map((s) => {
    const v = s[field]
    const cell = v === null || v === undefined ? t('co.no_value', 'not recorded') : fmtPoint(v)
    return `<tr><th scope="row">${esc(s.month || '—')}</th><td>${esc(cell)}</td></tr>`
  }).join('')
  return `<div class="visually-hidden"><table class="data-alt">
    <caption>${esc(fill(t('co.spark_caption', '{label} by month'), { label }))}</caption>
    ${head}
    <tbody>${rows}</tbody>
  </table></div>`
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
  const displayVal = fmtPoint(latest)
  return `<div class="spark-tile">
    <span class="spark-label">${label}</span>
    <span class="spark-value">${displayVal}<span style="font-size:0.8rem;font-weight:400;color:var(--ink-muted)">${unit ? ' ' + unit : ''}</span></span>
    ${deltaHtml}
    ${buildSparkline(values, truncate(sparkA11y(label, values), { max: 300 }))}
    ${sparkSeriesTable(label, series, field)}
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

  const period = `${y} ${q}`
  const loading = document.getElementById('loading-banner')
  if (loading) loading.hidden = false

  // Counted from the sections, not from the requests: a 200 carrying an empty
  // array loads a table and an error response does not, and the announcement
  // is about what a reader can now see.
  const sections = ['kpi-section', 'cohort-section', 'trend-section', 'qoq-section',
                    'equity-section', 'histogram-section', 'feedback-section']
  let failed = 0

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
    } else {
      failed += 2
    }

    if (equityRes.ok) {
      const { data: equity } = await equityRes.json()
      renderEquity(equity || [])
    } else {
      failed += 1
    }

    if (dispatchRes.ok) {
      const { data: dispatches } = await dispatchRes.json()
      renderHistogram(dispatches || [])
    } else {
      failed += 1
    }

    if (feedbackRes.ok) {
      const { data: summary } = await feedbackRes.json()
      renderFeedback(summary || [])
    } else {
      failed += 1
    }

    if (trendRes.ok) {
      const { data: series } = await trendRes.json()
      if (series && series.length) {
        renderTrend(series)
        renderQoQ(series)
      }
    } else {
      failed += 2
    }
  } catch (err) {
    // One rejected fetch rejects the whole Promise.all, so nothing rendered.
    console.error('CO dashboard load error:', err)
    failed = sections.length
  } finally {
    if (loading) loading.hidden = true
  }

  const loaded = sections.filter((id) => !document.getElementById(id)?.hidden).length
  if (loaded === 0) {
    announce(
      fill(t('co.status_failed', 'Could not load the dashboard for {period}.'), { period }),
      { errorText: fill(t('co.error_body', 'None of the quarterly figures could be loaded. Reload the page to try again.'), { period }) },
    )
  } else if (failed > 0) {
    announce(
      fill(t('co.status_partial', 'Loaded {loaded} of {total} sections for {period}; {failed} could not be loaded.'),
        { loaded: String(loaded), total: String(sections.length), period, failed: String(failed) }),
      { errorText: fill(t('co.error_partial', '{failed} of {total} sections could not be loaded. The figures shown are the ones that did load.'),
        { failed: String(failed), total: String(sections.length) }) },
    )
  } else {
    announce(fill(t('co.status_loaded', 'Loaded {loaded} sections for {period}.'),
      { loaded: String(loaded), period }))
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
