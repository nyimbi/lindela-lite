// CO/Donor read-only dashboard
// Fetches: /api/v1/kpi/quarterly, /api/v1/equity/by-district,
//          /api/v1/rapidpro/dispatches, /api/v1/community-feedback/summary
//
// This file had no escape function of any kind, unlike the console's 55 uses of
// one. District names, alert event ids and quarter labels were interpolated
// into innerHTML raw. The helpers now come from the shared module.

import { esc, formatTimestamp, num, pct, truncate, applyLocaleToDocument } from '/shared/fmt.js'
import { metricLabel } from '/shared/labels.js'
import { barChart, sparkline } from '/shared/charts.js'
import { apiFetch, autoMarkScrollableRegions } from '/shared/runtime.js'
import { createLoadSequence } from '/shared/states.js'

/**
 * One load in flight at a time.
 *
 * Changing quarter twice quickly starts two loads, and without an ordering
 * check the *slower earlier* one renders last — a funner reading 2026 Q3 who
 * has already asked for Q4, shown Q3 under a Q4 heading. The same guard is what
 * stops the status line being stranded at the working state by a response that
 * lost.
 */
const loadSequence = createLoadSequence()

let currentLocale = 'en'
let i18n = {}

/**
 * Load a locale, always layering it over English.
 *
 * The single-locale load was R-62 on this surface: a Somali session got a
 * catalogue that is 23% covered, so every key the Somali file omits fell
 * through to `t(key, fallback)` and rendered either the key or nothing.
 * `set()` in `shared/runtime.js` re-reads English as the base for exactly this
 * reason; this private copy of the loader never did, which is what having a
 * private copy costs.
 */
async function loadLocale(locale) {
  const base = {}
  try {
    const res = await fetch('/i18n/en.json')
    if (res.ok) Object.assign(base, await res.json())
  } catch {
    // Keep whatever we have.
  }
  i18n = base
  if (locale !== 'en') {
    try {
      const res = await fetch(`/i18n/${locale}.json`)
      if (res.ok) Object.assign(i18n, await res.json())
    } catch {
      // Keep the English layer. A missing translation must fall back to
      // English, never to a raw key.
    }
  }
  currentLocale = locale
  applyLocaleToDocument(locale)
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
function announce(statusText, { errorText, state: stateName } = {}) {
  const status = document.getElementById('load-status')
  if (status) {
    status.textContent = statusText
    // `working` is not a result, and a live region that only ever carries
    // results cannot say "still working". The attribute is how a test — and
    // the next person after them — tells the three apart without having to
    // time a fetch.
    status.dataset.state = stateName || (errorText ? 'error' : 'done')
  }
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

/**
 * Every section, and the element that holds its rows.
 *
 * `load()` empties both before it fetches. `hidden` was doing two jobs at once —
 * "not shown" and "not loaded" — and doing neither: nothing hid anything at the
 * start of a load, so after a quarter change the previous quarter's table stayed
 * on screen under the new quarter's heading, and the announcement counted it as
 * loaded because it was not hidden. A reader comparing a KPI tile against the
 * equity table beneath it was reading two different quarters, and the status
 * line said everything had loaded.
 */
const SECTIONS = [
  { id: 'kpi-section', body: 'kpi-grid' },
  { id: 'trend-section', body: 'trend-grid' },
  { id: 'cohort-section', body: 'cohort-body' },
  { id: 'equity-section', body: 'equity-body' },
  { id: 'qoq-section', body: 'qoq-body' },
  { id: 'histogram-section', body: 'histogram' },
  { id: 'feedback-section', body: 'feedback-body' },
]

/** Section ids this load actually painted. */
let painted = new Set()

function beginLoad() {
  painted = new Set()
  for (const { id, body } of SECTIONS) {
    const el = document.getElementById(id)
    if (el) el.hidden = true
    const holder = document.getElementById(body)
    if (holder) holder.innerHTML = ''
  }
}

/** The only way a section becomes visible, so the count cannot drift from it. */
function show(id) {
  const el = document.getElementById(id)
  if (el) el.hidden = false
  painted.add(id)
}

/**
 * What to report, counted from what was painted rather than from what a fetch
 * returned. A 200 carrying an empty array paints nothing, and a section that
 * failed to repaint must not be counted against the period on screen.
 */
export function loadState(sectionIds, paintedIds) {
  const done = new Set(paintedIds)
  const loaded = sectionIds.filter((id) => done.has(id)).length
  return { loaded, total: sectionIds.length, unpainted: sectionIds.filter((id) => !done.has(id)) }
}

// ---------------------------------------------------------------
// The period the charts actually cover
// ---------------------------------------------------------------
//
// /api/v1/kpi/monthly-series has no period parameter: it computes the last N
// months ending *this month*, for any N. The KPI tiles beside it come from
// /api/v1/kpi/quarterly?quarter=Q&year=Y. So on any quarter but the current one
// the trend chart showed months after the quarter in its own heading — a chart
// of last quarter under this quarter's tiles, which is what the audit recorded.
// The window is selected here instead: ask the server for enough months to reach
// back past the selected quarter, then keep only the twelve that end in it.

const TREND_MONTHS = 12

/** Absolute month number for a 'YYYY-MM' string, or null if that is not one. */
function monthIndex(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''))
  if (!m) return null
  return Number(m[1]) * 12 + Number(m[2]) - 1
}

/** The last month of Q1..Q4, as a 1-12 month number. Null for anything else. */
export function quarterEndMonth(quarter) {
  const m = /^Q([1-4])$/.exec(String(quarter ?? ''))
  return m ? Number(m[1]) * 3 : null
}

/**
 * How many trailing months to ask for so the window that *ends* at the selected
 * quarter is inside the range the server returns. A future quarter needs no
 * extra; the filter then returns everything the server has.
 */
export function monthsBackFor(quarter, year, months = TREND_MONTHS, now = new Date()) {
  const end = quarterEndMonth(quarter)
  if (end === null || !Number.isFinite(Number(year))) return months
  const target = Number(year) * 12 + end - 1
  const today = now.getUTCFullYear() * 12 + now.getUTCMonth()
  return months + Math.max(0, today - target)
}

/** The `months` months ending in the selected quarter, oldest first. */
export function selectTrendWindow(series, quarter, year, months = TREND_MONTHS) {
  const end = quarterEndMonth(quarter)
  if (!Array.isArray(series) || end === null) return []
  const last = Number(year) * 12 + end - 1
  const first = last - months + 1
  return series
    .filter((s) => s && typeof s.month === 'string')
    .filter((s) => {
      const i = monthIndex(s.month)
      return i !== null && i >= first && i <= last
    })
    .sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * The range the chart covers, written as it is: two ISO months, no prose, no
 * language. The heading said "last 12 months" whatever the quarter, which is
 * the claim the data cannot support once the reader picks a past one.
 */
export function windowLabel(series) {
  if (!series?.length) return ''
  return `${series[0].month} → ${series[series.length - 1].month}`
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
  show('kpi-section')
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
  show('cohort-section')
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
  show('equity-section')
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
 * This was a labelled empty div: aria-label on a div with no role announces the
 * label and nothing else, so the chart was five coloured rectangles with no
 * values. The bars are now the shared `barChart`, and the table it ships beside
 * the SVG carries the full distribution — a donor asking "how many went past 24
 * hours" is asking for one bucket, not for the shape.
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

  const total = counts.reduce((a, b) => a + b, 0)
  const chart = barChart({
    labels: LAG_BUCKETS.map((b) => b.label),
    series: [{ name: t('co.dispatches', 'Dispatches'), values: counts }],
    xLabel: t('co.lag_bucket', 'Lag'),
    caption: t('co.histogram_table_caption', 'Dispatches by signal-to-dispatch lag'),
    title: t('co.histogram_table_caption', 'Dispatches by signal-to-dispatch lag'),
  }, { height: 190, pad: { left: 40, bottom: 30 } })

  container.innerHTML = chart.svg + chart.table
  container.setAttribute('aria-label', histogramSummary(counts, total))
  show('histogram-section')
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
  show('feedback-section')
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
/**
 * The sparkline, from the shared library.
 *
 * The logic here was already right about the thing it is easy to get wrong — a
 * lone plotted value is a dot, not a trend — so it moved rather than being
 * rewritten. What it gained is being reachable from every surface.
 */
function buildSparkline(values, label, w = 200, h = 40, pad = 4) {
  return sparkline(values, { label, width: w, height: h, pad }).svg
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
  const caption = document.getElementById('trend-window')
  if (caption) caption.textContent = windowLabel(series)
  if (!grid || !series || !series.length) return
  grid.innerHTML = [
    sparkCard(t('co.trend_people_reached', 'People reached'), series, 'people_reached', 'people'),
    sparkCard(t('co.trend_warning_to_action', 'Signal-to-dispatch'), series, 'warning_to_action_median_hours', 'h'),
    sparkCard(t('co.trend_false_alert', 'False alert rate'), series, 'false_alert_rate', '%'),
    sparkCard(t('co.trend_cold_chain', 'Cold-chain rate'), series, 'cold_chain_protection_rate', '%'),
  ].join('')
  show('trend-section')
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
  show('qoq-section')
}

function updateExportBtn(quarter, year) {
  const pdf = document.getElementById('export-btn')
  if (pdf) {
    pdf.href = `/api/v1/kpi/quarterly.pdf?quarter=${quarter}&year=${year}`
    pdf.setAttribute('download', `lindela-kpi-${year}-${quarter}.pdf`)
  }
  // Markdown as well as PDF. The PDF is typeset for a reader; the Markdown is
  // for someone who wants the numbers in a spreadsheet, a wiki or a diff, and
  // the server already builds one from the same report and the same narrative.
  // Same filename convention, same period, same link.
  const md = document.getElementById('export-md-btn')
  if (md) {
    md.href = `/api/v1/kpi/quarterly.md?quarter=${quarter}&year=${year}`
    md.setAttribute('download', `lindela-kpi-${year}-${quarter}.md`)
  }
}

/**
 * What the download contains, stated before it is downloaded.
 *
 * The dashboard rendered seven sections and the export carried two, with nothing
 * on either side saying so. The button said "Download quarterly PDF" and a
 * funder receiving the file had no way to know that Equity by District — the
 * section they most often ask for by name — was not in it. The list comes from
 * the same declaration the renderer reads, so the preview cannot drift from the
 * file, and it names what is missing rather than rounding up to "the dashboard".
 */
export async function renderExportPreview() {
  const el = document.getElementById('export-preview')
  if (!el) return
  el.textContent = t('co.export_preview_loading', 'Checking what the export contains...')
  try {
    const { data } = await apiFetch('/api/v1/kpi/quarterly/coverage')
    el.innerHTML = `<span class="export-preview-summary">${esc(data.summary)}</span>`
    el.appendChild(barList(data.titles, 'co.export_carries', 'In the file'))
    if (data.missing.length) el.appendChild(barList(data.missing, 'co.export_omits', 'Not in the file'))
  } catch {
    // A preview that cannot load must not stand between the user and the
    // download. Say so and leave the link live.
    el.textContent = t('co.export_preview_failed',
      'Could not confirm what the export contains. The download will still work; the list below is what this page renders.')
  }
}

/** A labelled list, so the two halves of the preview cannot be confused. */
function barList(titles, key, fallback) {
  const wrap = document.createElement('span')
  wrap.className = 'export-preview-list'
  wrap.innerHTML = `<span class="export-preview-label">${esc(t(key, fallback))}:</span> `
    + titles.map((t2) => `<span class="export-preview-item">${esc(t2)}</span>`).join('')
  return wrap
}

export async function load() {
  const quarterSel = document.getElementById('quarter-select')
  const yearSel = document.getElementById('year-select')

  const q = quarterSel?.value || currentQuarter()
  const y = yearSel?.value || new Date().getUTCFullYear()

  updateExportBtn(q, y)

  const period = `${y} ${q}`
  const loading = document.getElementById('loading-banner')
  if (loading) loading.hidden = false

  // Everything on screen belongs to the period being left, not the one being
  // loaded, so it goes before the first fetch rather than after the first paint.
  beginLoad()

  // Counted from what the renderers painted, not from what the requests
  // returned and not from what happens to be visible: a 200 carrying an empty
  // array paints nothing, an error paints nothing, and a section still showing
  // the previous quarter is exactly the case that must not be counted.
  const sections = SECTIONS.map((s) => s.id)
  let failed = 0

  // The working state, said out loud rather than implied by a banner. The
  // banner has been here since the first version; what it could not do is reach
  // a screen reader, and the status line could not describe work in progress
  // because it only ever held the terminal sentence.
  //
  // `announce` is called again at the end on both the success and the failure
  // path, so the working state cannot outlive its request.
  const token = loadSequence.start()
  announce(fill(t('co.status_loading', 'Checking the figures for {period}.'), { period }), { state: 'working' })

  try {
    const [kpiRes, equityRes, dispatchRes, feedbackRes, trendRes] = await Promise.all([
      fetch(`/api/v1/kpi/quarterly?quarter=${q}&year=${y}`),
      fetch('/api/v1/equity/by-district'),
      fetch('/api/v1/rapidpro/dispatches'),
      fetch('/api/v1/community-feedback/summary'),
      fetch(`/api/v1/kpi/monthly-series?monthsBack=${monthsBackFor(q, y)}`),
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
      // The series is trailing-to-now whatever quarter is selected; the charts
      // belong to the selected quarter, so the window is cut here.
      const win = selectTrendWindow(series, q, y)
      if (win.length) {
        renderTrend(win)
        renderQoQ(win)
      } else {
        renderTrend([])
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

  // A load that a newer one superseded has already painted nothing; announcing
  // its outcome would put a terminal sentence next to a dashboard that has
  // already moved on to another period.
  if (!loadSequence.isCurrent(token)) return
  loadSequence.settle(token)

  const { loaded, unpainted } = loadState(sections, [...painted])
  if (loaded === 0) {
    announce(
      fill(t('co.status_failed', 'Could not load the dashboard for {period}.'), { period }),
      { errorText: fill(t('co.error_body', 'None of the quarterly figures could be loaded. Reload the page to try again.'), { period }) },
    )
  } else if (failed > 0 || unpainted.length) {
    // {failed} counts sections, not requests: the kpi response paints two of
    // them, and a request that failed but painted anyway has nothing missing.
    announce(
      fill(t('co.status_partial', 'Loaded {loaded} of {total} sections for {period}; {failed} could not be loaded.'),
        { loaded: String(loaded), total: String(sections.length), period, failed: String(unpainted.length) }),
      { errorText: fill(t('co.error_partial', '{failed} of {total} sections could not be loaded. The figures shown are the ones that did load.'),
        { failed: String(unpainted.length), total: String(sections.length) }) },
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

  // The dashboard swaps four tables per quarter change; a fixed sweep at boot
  // would miss every one of them. Observed instead — see `autoMarkScrollableRegions`.
  autoMarkScrollableRegions()
  loadLocale('en').then(() => { load(); renderExportPreview() })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
