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

  // Warning-to-action median hours: prefer matched_signal_at -> sent_at on dispatches
  const lags = []
  for (const d of (data.rapidpro_dispatches || [])) {
    const signalAt = d.matched_signal_at
    const sentAt = d.sent_at
    if (signalAt && sentAt) {
      const lagMs = new Date(sentAt).getTime() - new Date(signalAt).getTime()
      if (lagMs >= 0) lags.push(lagMs / 3600000)
    }
  }
  // Fallback: hazard_event.observed_at -> first matching dispatch.sent_at
  if (!lags.length) {
    for (const haz of hazardEvents) {
      const matchingDispatch = (data.rapidpro_dispatches || []).find(
        (d) => d.hazard_event_id === haz.id || d.trigger_id === haz.id || d.matched_signal_id === haz.id
      )
      if (matchingDispatch && matchingDispatch.sent_at && haz.observed_at) {
        const lagMs = new Date(matchingDispatch.sent_at).getTime() - new Date(haz.observed_at).getTime()
        if (lagMs >= 0) lags.push(lagMs / 3600000)
      }
    }
  }
  lags.sort((a, b) => a - b)
  const warning_to_action_median_hours = lags.length
    ? lags[Math.floor(lags.length / 2)]
    : null

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
  const resolved = alertEvents.filter((a) => a.status === 'resolved')
  const falseAlerts = resolved.filter((a) =>
    a.resolution_note && /false|invalid|noop/i.test(a.resolution_note)
  )
  const false_alert_rate = alertEvents.length
    ? (100 * falseAlerts.length) / alertEvents.length
    : null

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
  if (warning_to_action_median_hours === null) data_gaps.push({ field: 'warning_to_action_median_hours', reason: 'dispatches rarely linked to matched_signal_at; returns null when no matches' })

  const result = {
    people_reached,
    percent_children_u18,
    percent_women_and_girls,
    percent_pwd,
    community_reporters_count,
    youth_mappers_count,
    oss_releases_count,
    warning_to_action_median_hours,
    feeding_supply_repositioning_rate,
    cold_chain_protection_rate,
    false_alert_rate,
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
