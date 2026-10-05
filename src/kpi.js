import crypto from 'node:crypto'
import { computeShortTermSuccessRate } from './observability.js'
import { METRICS, computeMetric } from './analytics/metrics.js'
import { median } from './analytics/numeric.js'
// Neither of these imports back from kpi.js, so the quarterly export can compute the
// dashboard's equity and feedback sections from the same helpers the page uses —
// which is the point: a figure cannot be one thing on screen and another in the file.
import { equityByDistrict } from './equity.js'
import { feedbackSummaryByAlert } from './community.js'


// In-memory KPI cache: key -> {value, expires}
const _cache = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_SIZE = 32

function _cacheKey(quarter, year, data) {
  const counts = [
    data.rapidpro_dispatches?.length ?? 0,
    data.field_reports?.length ?? 0,
    data.alert_events?.length ?? 0,
    data.hazard_events?.length ?? 0,
    data.interventions?.length ?? 0,
    data.workflow_instances?.length ?? 0,
    data.report_templates?.length ?? 0,
  ].join(',')
  const hash = crypto.createHash('sha256').update(counts).digest('hex').slice(0, 8)
  return `${quarter}-${year}-${hash}`
}

function _currentQuarter() {
  const now = new Date()
  const month = now.getUTCMonth() + 1
  if (month <= 3) return 'Q1'
  if (month <= 6) return 'Q2'
  if (month <= 9) return 'Q3'
  return 'Q4'
}

function _currentYear() {
  return new Date().getUTCFullYear()
}

function _quarterDateRange(quarter, year) {
  const y = Number(year)
  const ranges = {
    Q1: [`${y}-01-01T00:00:00.000Z`, `${y}-03-31T23:59:59.999Z`],
    Q2: [`${y}-04-01T00:00:00.000Z`, `${y}-06-30T23:59:59.999Z`],
    Q3: [`${y}-07-01T00:00:00.000Z`, `${y}-09-30T23:59:59.999Z`],
    Q4: [`${y}-10-01T00:00:00.000Z`, `${y}-12-31T23:59:59.999Z`],
  }
  return ranges[quarter] || ranges['Q1']
}

// Helper: filter records by date range using field names in order of priority
/**
 * Hours from a dispatch matching a signal to that dispatch being sent.
 *
 * The system's own dispatch latency. Not warning-to-action in the field-response sense,
 * which runs from a warning reaching a household to a field action being
 * completed and reported.
 */
export function signalToDispatchHours(dispatches) {
  const lags = []
  for (const d of dispatches || []) {
    if (!d.matched_signal_at || !d.sent_at) continue
    const ms = new Date(d.sent_at).getTime() - new Date(d.matched_signal_at).getTime()
    if (ms >= 0) lags.push(ms / 3600000)
  }
  // `lags[Math.floor(n/2)]` returns the upper of the two middle values at even
  // n — 3 for [1,2,3,4] — so every even-length median published here was biased
  // high by up to half the central gap, and it was never visible because the
  // same expression appeared on the district page too.
  return median(lags)
}

export const WARNING_TO_ACTION_MEASURE =
  'median hours from a dispatch matching a signal (matched_signal_at) to that dispatch being sent (sent_at)'

export const WARNING_TO_ACTION_LIMIT =
  "System dispatch latency only: how long this platform took to send an SMS once a dispatch matched a signal. It is not warning-to-action in the field-response sense, which runs from a warning reaching a household to a field action being completed and reported. It is not comparable to any external response-time target, and a low value does not mean the response was fast."

export function kpiSnapshotForPeriod(records, from, to, dateField = null) {
  const fromTs = new Date(from).getTime()
  const toTs = new Date(to).getTime()
  return records.filter((r) => {
    const candidate = dateField
      ? r[dateField]
      : r.created_at || r.observed_at || r.sent_at
    if (!candidate) return false
    const ts = new Date(candidate).getTime()
    return ts >= fromTs && ts <= toTs
  })
}

export function computeApiUptime() {
  const override = process.env.LINDELA_LITE_UPTIME_OVERRIDE
  if (override !== undefined) return parseFloat(override)
  const ringRate = computeShortTermSuccessRate()
  if (ringRate !== null) return Math.round(ringRate * 100) / 100
  return 100.0
}

export function computeQuarterlyKpi(data, { quarter, year } = {}) {
  const q = quarter || _currentQuarter()
  const y = year || _currentYear()

  // Validate quarter
  if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) {
    throw Object.assign(new Error(`quarter must be Q1|Q2|Q3|Q4`), { statusCode: 400 })
  }

  const cacheKey = _cacheKey(q, y, data)
  const cached = _cache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.value

  const [from, to] = _quarterDateRange(q, y)

  const dispatches = kpiSnapshotForPeriod(data.rapidpro_dispatches || [], from, to, 'sent_at')
  const fieldReports = kpiSnapshotForPeriod(data.field_reports || [], from, to, 'created_at')
  const alertEvents = kpiSnapshotForPeriod(data.alert_events || [], from, to, 'created_at')
  const hazardEvents = kpiSnapshotForPeriod(data.hazard_events || [], from, to, 'observed_at')
  const interventions = kpiSnapshotForPeriod(data.interventions || [], from, to, 'created_at')
  const workflowInstances = kpiSnapshotForPeriod(data.workflow_instances || [], from, to, 'created_at')
  const reportTemplates = data.report_templates || []

  // People reached, from the registry. The inline sum counted every dispatch,
  // including `status: 'failed', sent_at: null, HTTP 503` — 1,399 people, of
  // whom 503's reached nobody. Recipients are still not de-duplicated, because
  // the payload carries no stable person identifier, and the reason travels
  // with the number rather than being left for a reader to discover.
  const reached = computeMetric('people_reached', { dispatches })

  // Community reporters: distinct reporter identifiers in field_reports
  const reporterIds = new Set(
    fieldReports
      .map((r) => r.reported_by || r.reporter_urn_hash || r.reporter_id)
      .filter(Boolean)
  )
  const community_reporters_count = reporterIds.size

  // Youth mappers: distinct mappers with role=mapper or metadata.role=mapper
  const mapperIds = new Set(
    fieldReports
      .filter((r) => r.role === 'mapper' || r.metadata?.role === 'mapper')
      .map((r) => r.reported_by || r.reporter_id)
      .filter(Boolean)
  )
  const youth_mappers_count = mapperIds.size

  // OSS releases: count of report_templates (proxy heuristic per plan)
  const oss_releases_count = reportTemplates.length

  // Warning-to-action median hours.
  //
  // This measures how long the platform took to send an SMS once a dispatch
  // matched a signal. It is not warning-to-action in the field-response sense, and the
  // CO dashboard used to present it as such next to a "<24h" external target,
  // which invites the conclusion that a fast-looking figure means the response
  // was fast.
  //
  // There was also a silent fallback here that switched to a *different*
  // interval — hazard observed_at to sent_at — whenever no matched_signal_at
  // existed, so the same figure could quietly change meaning depending on the
  // data. The monthly series had no such fallback. Both now use one helper and
  // one interval; where the interval is unavailable the figure is null and says
  // so, rather than becoming a different measurement under the same name.
  const warning_to_action_median_hours = signalToDispatchHours(data.rapidpro_dispatches)

  // Feeding and cold-chain rates, from the registry. Both were `length ? 100 *
  // done / total : null`, which published a rate from a single intervention as
  // confidently as from forty. The floor is inside the computation now, so no
  // surface can publish below it by forgetting to check.
  const feeding = computeMetric('feeding_repositioning_rate', { interventions })
  const coldChain = computeMetric('cold_chain_protection_rate', { workflows: workflowInstances })

  // False alert rate, from the registry.
  //
  // This surface was the one that had it right — it read `alert_events.
  // false_alert` rather than scanning the resolution note, so it saw the
  // Mandera confirmation the other two missed — but it computed the metric
  // itself, which is what made its being right a matter of luck rather than of
  // design. Two sibling modules derived the same name from the same data and
  // got a different answer, and nothing in the codebase said which was
  // authoritative.
  //
  // `src/analytics/metrics.js` now says so once: numerator, denominator, floor
  // of 30 determined alerts, and the refusal when the floor is not met. All
  // four surfaces compute from it.
  const far = computeMetric('false_alert_rate', { alerts: alertEvents })

  // Demographic KPIs from field_reports.demographics
  const reportsWithDemo = fieldReports.filter((r) => r.demographics != null)
  const demoTotal = reportsWithDemo.length
  const demographics_coverage_pct = fieldReports.length
    ? Math.round((demoTotal / fieldReports.length) * 10000) / 100
    : null

  let percent_children_u18 = null
  let percent_women_and_girls = null
  let percent_pwd = null
  let cohort_u18 = null
  let cohort_women_and_girls = null
  let cohort_pwd = null
  let cohort_refugees_idps = null

  if (demoTotal > 0) {
    const u18Count = reportsWithDemo.filter((r) => ['u5', '5-17'].includes(r.demographics.age_band)).length
    const womenCount = reportsWithDemo.filter((r) => r.demographics.gender === 'female').length
    const pwdCount = reportsWithDemo.filter((r) => r.demographics.pwd === true).length
    const refugeeCount = reportsWithDemo.filter((r) => r.demographics.refugee_or_idp === true).length
    percent_children_u18 = Math.round((u18Count / demoTotal) * 10000) / 100
    percent_women_and_girls = Math.round((womenCount / demoTotal) * 10000) / 100
    percent_pwd = Math.round((pwdCount / demoTotal) * 10000) / 100
    cohort_u18 = u18Count
    cohort_women_and_girls = womenCount
    cohort_pwd = pwdCount
    cohort_refugees_idps = refugeeCount
  }

  const data_gaps = []
  if (percent_children_u18 === null) data_gaps.push({ field: 'percent_children_u18', reason: 'no demographics recorded yet' })
  if (percent_women_and_girls === null) data_gaps.push({ field: 'percent_women_and_girls', reason: 'no demographics recorded yet' })
  if (percent_pwd === null) data_gaps.push({ field: 'percent_pwd', reason: 'no demographics recorded yet' })
  if (cohort_u18 === null) data_gaps.push({ field: 'cohort.u18', reason: 'no demographics recorded yet' })
  if (cohort_women_and_girls === null) data_gaps.push({ field: 'cohort.women_and_girls', reason: 'no demographics recorded yet' })
  if (cohort_pwd === null) data_gaps.push({ field: 'cohort.pwd', reason: 'no demographics recorded yet' })
  if (cohort_refugees_idps === null) data_gaps.push({ field: 'cohort.refugees_idps', reason: 'no demographics recorded yet' })
  if (!youth_mappers_count) data_gaps.push({ field: 'youth_mappers_count', reason: 'role=mapper flag rarely set on field_reports' })
  if (warning_to_action_median_hours === null) data_gaps.push({ field: 'warning_to_action_median_hours', reason: 'no dispatch carries both matched_signal_at and sent_at, so the signal-to-dispatch interval cannot be measured; returns null rather than substituting a different interval' })
  if (far.value === null) data_gaps.push({ field: 'false_alert_rate', reason: far.refusal })

  const result = {
    people_reached: reached.value,
    // What "reached" counts, in words, on the payload. A funder's headline
    // number should not need a footnote to be interpreted.
    people_reached_basis: {
      sends: reached.sends,
      failed_dispatches_excluded: reached.failed_excluded,
      without_recipient_count: reached.without_recipient_count,
      de_duplicated: reached.de_duplicated,
      de_duplication_refusal: 'the dispatch payload carries no stable person identifier, so recipients are summed per send rather than de-duplicated; a union would be a guess, and a guess here inflates or deflates the headline number',
    },
    percent_children_u18,
    percent_women_and_girls,
    percent_pwd,
    community_reporters_count,
    youth_mappers_count,
    oss_releases_count,
    warning_to_action_median_hours,
    warning_to_action_measure: WARNING_TO_ACTION_MEASURE,
    warning_to_action_limit: WARNING_TO_ACTION_LIMIT,
    warning_to_action_is_field_outcome: false,
    feeding_supply_repositioning_rate: feeding.value,
    feeding_supply_repositioning_refusal: feeding.refusal,
    cold_chain_protection_rate: coldChain.value,
    cold_chain_protection_refusal: coldChain.refusal,
    false_alert_rate: far.value,
    // The denominator, the floor and the method travel with the number. A rate
    // with an unstated denominator cannot be judged, and the registry's basis
    // sentence is the same one `src/districts.js` and `src/equity.js` publish,
    // so an officer reading any of the three pages sees the same words.
    false_alert_determined: far.denominator,
    false_alert_of_total: alertEvents.length,
    false_alert_sample_floor: METRICS.false_alert_rate.sample_floor,
    false_alert_method: METRICS.false_alert_rate.basis,
    false_alert_refusal: far.refusal,
    api_uptime_pct: computeApiUptime(),
    cohort: {
      total: demoTotal,
      u18: cohort_u18,
      women_and_girls: cohort_women_and_girls,
      pwd: cohort_pwd,
      refugees_idps: cohort_refugees_idps,
    },
    demographics_coverage_pct,
    period: { quarter: q, year: Number(y), from, to },
    data_gaps,
    generated_at: new Date().toISOString(),
  }

  // Prune cache if at limit
  if (_cache.size >= CACHE_MAX_SIZE) {
    const firstKey = _cache.keys().next().value
    _cache.delete(firstKey)
  }
  _cache.set(cacheKey, { value: result, expires: Date.now() + CACHE_TTL_MS })

  return result
}

function _monthDateRange(year, month) {
  const y = String(year).padStart(4, '0')
  const m = String(month).padStart(2, '0')
  const from = `${y}-${m}-01T00:00:00.000Z`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const to = `${y}-${m}-${String(lastDay).padStart(2, '0')}T23:59:59.999Z`
  return { from, to }
}

export function computeMonthlyKpiSeries(data, { monthsBack = 12 } = {}) {
  const now = new Date()
  const series = []

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth() + 1
    const monthStr = `${year}-${String(month).padStart(2, '0')}`
    const { from, to } = _monthDateRange(year, month)

    const dispatches = kpiSnapshotForPeriod(data.rapidpro_dispatches || [], from, to, 'sent_at')
    const fieldReports = kpiSnapshotForPeriod(data.field_reports || [], from, to, 'created_at')
    const alertEvents = kpiSnapshotForPeriod(data.alert_events || [], from, to, 'created_at')
    const interventions = kpiSnapshotForPeriod(data.interventions || [], from, to, 'created_at')
    const workflowInstances = kpiSnapshotForPeriod(data.workflow_instances || [], from, to, 'created_at')

    // Same registry route as the quarterly figure. It used to be a third
    // inline copy of the same sum.
    const people_reached = computeMetric('people_reached', { dispatches }).value

    const reporterIds = new Set(
      fieldReports.map(r => r.reported_by || r.reporter_urn_hash || r.reporter_id).filter(Boolean)
    )
    const community_reporters_count = reporterIds.size

    const warning_to_action_median_hours = signalToDispatchHours(dispatches)

    // The monthly series was a *fifth* inline copy of each rate, and the
    // comment above it claimed it was "the same rule as the quarterly figure"
    // while computing the same three numbers a different way. A trend card that
    // reads differently from the tile above it is the same defect wearing a
    // time axis.
    const feeding = computeMetric('feeding_repositioning_rate', { interventions })
    const coldChain = computeMetric('cold_chain_protection_rate', { workflows: workflowInstances })
    const far = computeMetric('false_alert_rate', { alerts: alertEvents })
    const feeding_repositioning_rate = feeding.value
    const cold_chain_protection_rate = coldChain.value
    const false_alert_rate = far.value
    const false_alert_determined = far.denominator

    series.push({
      month: monthStr,
      false_alert_determined,

      from,
      to,
      people_reached,
      warning_to_action_median_hours,
      false_alert_rate,
      feeding_repositioning_rate,
      cold_chain_protection_rate,
      community_reporters_count,
    })
  }

  return series
}

export function computeSparklineData(series, field) {
  return [...series].reverse().map(s => s[field] ?? 0)
}

export async function refreshKpiSnapshots(store) {
  const data = await store.read()
  const { stableId } = await import('./utils.js')
  const series = computeMonthlyKpiSeries(data, { monthsBack: 12 })
  const snapshots = series.map(s => ({
    id: stableId('kpi', [s.month]),
    month: s.month,
    from: s.from,
    to: s.to,
    indicators: {
      people_reached: s.people_reached,
      warning_to_action_median_hours: s.warning_to_action_median_hours,
      warning_to_action_is_field_outcome: s.warning_to_action_is_field_outcome,
      false_alert_rate: s.false_alert_rate,
      false_alert_determined: s.false_alert_determined,
      false_alert_of_total: s.false_alert_of_total,
      feeding_repositioning_rate: s.feeding_repositioning_rate,
      cold_chain_protection_rate: s.cold_chain_protection_rate,
      community_reporters_count: s.community_reporters_count,
    },
    generated_at: new Date().toISOString(),
  }))
  await store.merge({ kpi_snapshots: snapshots })
  return snapshots
}

/** The last day-of-quarter month index, 1-12. `Q3` -> 9. */
function _quarterEndMonth(quarter) {
  const m = /^Q([1-4])$/.exec(String(quarter ?? ''))
  return m ? Number(m[1]) * 3 : null
}

/**
 * The four dashboard sections the quarterly PDF used to omit, computed from the
 * same collections and the same helpers the page renders from.
 *
 * The export carried two of seven sections and said nothing about the other
 * five. `Equity by District` is the one a funder asks for by name, so its
 * absence was not a formatting detail — it was a claim, delivered by omission,
 * that the file was the dashboard.
 *
 * Every figure here is `null` where it could not be measured, and the page
 * prints the reason. Nothing is defaulted to zero to make a table look
 * complete.
 */
export function quarterlyPdfSections(data, { quarter, year } = {}) {
  const q = quarter || _currentQuarter()
  const y = Number(year || _currentYear())
  const endMonth = _quarterEndMonth(q)
  const { from, to } = _quarterDateRange(q, y)

  // --- Trend: the twelve months ending in the reported quarter ------------
  //
  // `computeMonthlyKpiSeries` ends at the current month, so on any past quarter
  // the export would carry a trend that runs past its own period — the exact
  // defect the dashboard's trend window already fixed. Re-derived here from the
  // monthly helper's own interval so the window ends where the report does.
  //
  // `computeMonthlyKpiSeries` always ends at the current month, so calling it
  // would carry a trend that runs past the period this file is about — the same
  // defect the dashboard's trend window fixes client-side. The window is
  // therefore computed here, ending on the report's own quarter.
  const monthsForQuarter = []
  for (let back = 11; back >= 0; back -= 1) {
    const idx = (y * 12 + (endMonth || 12)) - back
    monthsForQuarter.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 })
  }
  const trend = monthsForQuarter
    .map(({ year: my, month }) => {
      const r = _monthDateRange(my, month)
      const disp = kpiSnapshotForPeriod(data.rapidpro_dispatches || [], r.from, r.to, 'sent_at')
      const reps = kpiSnapshotForPeriod(data.field_reports || [], r.from, r.to, 'created_at')
      const ivs = kpiSnapshotForPeriod(data.interventions || [], r.from, r.to, 'created_at')
      return {
        month: `${my}-${String(month).padStart(2, '0')}`,
        people_reached: computeMetric('people_reached', { dispatches: disp }).value,
        community_reporters_count: new Set(
          reps.map((x) => x.reported_by || x.reporter_urn_hash || x.reporter_id).filter(Boolean),
        ).size,
        warning_to_action_median_hours: signalToDispatchHours(disp),
        feeding_repositioning_rate: computeMetric('feeding_repositioning_rate', { interventions: ivs }).value,
      }
    })
    .map((m) => ({
      ...m,
    }))

  // --- Quarter-over-quarter: this quarter and the two before it -----------
  const qoq = []
  for (let back = 2; back >= 0; back -= 1) {
    let qq = endMonth - back * 3
    let qy = y
    while (qq < 1) { qq += 12; qy -= 1 }
    if (endMonth === null) break
    qoq.push({ quarter: `Q${Math.ceil(qq / 3)} ${qy}`, ...computeQuarterlyKpi(data, { quarter: `Q${Math.ceil(qq / 3)}`, year: qy }) })
  }

  // --- Equity by district -------------------------------------------------
  // Imported lazily to keep this module free of a cycle through equity.js,
  // which imports the KPI helpers back.
  const equity = equityByDistrict(data).filter((d) => d.alerts > 0)

  // --- Signal-to-dispatch lag --------------------------------------------
  //
  // The dashboard's histogram measures `queued_at -> sent_at` and the KPI tile
  // measures `matched_signal_at -> sent_at`. Two intervals, one label. The
  // dashboard heading says "Signal-to-Action Lag" and the export is what a donor
  // keeps, so the interval travels with the numbers on both sides rather than
  // being reconciled here — the disagreement is the finding, and papering over
  // it in one artefact would leave the other lying.
  const dispatches = kpiSnapshotForPeriod(data.rapidpro_dispatches || [], from, to, 'sent_at')
  const LAG_BUCKETS = [
    { label: '0-6h', max: 6 }, { label: '6-12h', max: 12 }, { label: '12-24h', max: 24 },
    { label: '24-48h', max: 48 }, { label: '48h+', max: Infinity },
  ]
  const counts = LAG_BUCKETS.map(() => 0)
  for (const d of dispatches) {
    if (!d.sent_at || !d.queued_at) continue
    const lagH = (new Date(d.sent_at).getTime() - new Date(d.queued_at).getTime()) / 3600000
    if (lagH < 0) continue
    const idx = LAG_BUCKETS.findIndex((b) => lagH <= b.max)
    if (idx >= 0) counts[idx] += 1
  }

  // --- Community feedback -------------------------------------------------
  const feedback = feedbackSummaryByAlert(data)

  return {
    period: { quarter: q, year: y },
    trend,
    qoq: qoq.map(({ quarter: label, people_reached, community_reporters_count, warning_to_action_median_hours }) => ({
      quarter: label,
      people_reached,
      community_reporters_count,
      warning_to_action_median_hours,
    })),
    equity,
    lag: LAG_BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] })),
    lag_measure: 'Dispatches sent in this period, bucketed by hours from queued_at to sent_at.',
    lag_note: 'This is platform send latency from the moment a message entered the queue. It is NOT the same interval as the '
      + '"Signal-to-dispatch median" on the KPI page, which runs from matched_signal_at to sent_at. The dashboard heading '
      + 'calls this section "Signal-to-Action Lag", which is a third thing again: no field action is measured anywhere in '
      + 'this report. See the narrative page.',
    feedback,
  }
}
