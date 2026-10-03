import crypto from 'node:crypto'
import { computeShortTermSuccessRate } from './observability.js'

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
  lags.sort((a, b) => a - b)
  return lags.length ? lags[Math.floor(lags.length / 2)] : null
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

  // People reached: sum of recipients_count across dispatches (may live on d.metadata in some providers)
  const people_reached = dispatches.reduce((sum, d) => sum + (d.recipients_count || d.metadata?.recipients_count || 0), 0)

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

  // Feeding supply repositioning rate
  const feedingInterventions = interventions.filter((i) => i.type === 'feeding')
  const feedingCompleted = feedingInterventions.filter((i) =>
    ['completed', 'verified'].includes(i.status)
  )
  const feeding_supply_repositioning_rate = feedingInterventions.length
    ? (100 * feedingCompleted.length) / feedingInterventions.length
    : null

  // Cold chain protection rate
  const coldChainWorkflows = workflowInstances.filter((w) => w.type === 'cold_chain_protection')
  const coldChainTerminal = coldChainWorkflows.filter((w) => ['closed', 'verified'].includes(w.state))
  const cold_chain_protection_rate = coldChainWorkflows.length
    ? (100 * coldChainTerminal.length) / coldChainWorkflows.length
    : null

  // False alert rate
  //
  // Measured only over alerts whose outcome was actually determined. It used to
  // scan resolution_note for /false|invalid|noop/i and divide by the alert count,
  // which on the demo data reported 0% — read as "no false alerts occurred" when
  // it means "nobody wrote the word false". A resolution note like "situation
  // stabilised" says nothing about whether the alert was warranted.
  //
  // With no determinations recorded the rate is null, not zero, and the reason is
  // reported as a data gap. A number that looks authoritative without being sound
  // is worse than no number.
  const determinedAlerts = alertEvents.filter((a) => a.false_alert !== null && a.false_alert !== undefined)
  const falseAlerts = determinedAlerts.filter((a) => a.false_alert === true)
  const false_alert_rate = determinedAlerts.length
    ? (100 * falseAlerts.length) / determinedAlerts.length
    : null
  const false_alert_determined = determinedAlerts.length
  const false_alert_sample = determinedAlerts.length

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
  if (false_alert_rate === null) data_gaps.push({ field: 'false_alert_rate', reason: 'no alert event carries a false_alert determination; the rate is measured over determined alerts only and is null rather than 0 until an outcome is recorded' })

  const result = {
    people_reached,
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
    feeding_supply_repositioning_rate,
    cold_chain_protection_rate,
    false_alert_rate,
    // The denominator and the method travel with the number. A rate with an
    // unstated denominator cannot be judged, and a rate whose denominator is
    // "every alert ever raised" is not a false-alert rate at all.
    false_alert_determined,
    false_alert_of_total: alertEvents.length,
    false_alert_method: 'share of alert events with a recorded false_alert determination (true) among alert events with any determination; null when none are determined',
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

    const people_reached = dispatches.reduce(
      (s, d) => s + (d.recipients_count || d.metadata?.recipients_count || 0), 0
    )

    const reporterIds = new Set(
      fieldReports.map(r => r.reported_by || r.reporter_urn_hash || r.reporter_id).filter(Boolean)
    )
    const community_reporters_count = reporterIds.size

    const warning_to_action_median_hours = signalToDispatchHours(dispatches)

    const feedingInterventions = interventions.filter(iv => iv.type === 'feeding')
    const feedingCompleted = feedingInterventions.filter(iv => ['completed', 'verified'].includes(iv.status))
    const feeding_repositioning_rate = feedingInterventions.length
      ? (100 * feedingCompleted.length) / feedingInterventions.length : null

    const coldChainWorkflows = workflowInstances.filter(w => w.type === 'cold_chain_protection')
    const coldChainTerminal = coldChainWorkflows.filter(w => ['closed', 'verified'].includes(w.state))
    const cold_chain_protection_rate = coldChainWorkflows.length
      ? (100 * coldChainTerminal.length) / coldChainWorkflows.length : null

    // Same rule as the quarterly figure: measured only over alerts whose outcome
    // was determined, and null rather than 0 when none were. This path had kept
    // the old keyword scan, so the trend card showed a flat 0% while the KPI tile
    // correctly showed a gap — the same metric contradicting itself on one screen.
    const determined = alertEvents.filter(a => a.false_alert !== null && a.false_alert !== undefined)
    const false_alert_rate = determined.length
      ? (100 * determined.filter(a => a.false_alert === true).length) / determined.length : null
    const false_alert_determined = determined.length

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
