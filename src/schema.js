export const SOURCE_IDS = Object.freeze([
  'open_meteo',
  'gdacs',
  'glofas',
  'chirps',
  'nasa_firms',
  'service_assets',
  'acled_csv',
  'conflict_csv',
])

export const BLOCKED_SOURCE_IDS = Object.freeze(['gdelt'])

export const DEFAULT_REGIONS = Object.freeze([
  { name: 'Turkana', country: 'KE', lat: 3.1167, lon: 35.6 },
  { name: 'Mogadishu', country: 'SO', lat: 2.0469, lon: 45.3182 },
  { name: 'Juba', country: 'SS', lat: 4.8594, lon: 31.5713 },
])

export const SERVICE_TYPES = Object.freeze([
  'health',
  'water',
  'road',
  'school',
  'power',
  'telecom',
  'market',
  'other',
])

export const INCIDENT_STATUSES = Object.freeze([
  'open',
  'monitoring',
  'responding',
  'stabilized',
  'closed',
])

export const INTERVENTION_STATUSES = Object.freeze([
  'planned',
  'active',
  'paused',
  'completed',
  'cancelled',
])

export const TASK_STATUSES = Object.freeze([
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
])

export const RESOURCE_STATUSES = Object.freeze([
  'available',
  'reserved',
  'deployed',
  'depleted',
])

export const ALERT_RULE_STATUSES = Object.freeze([
  'active',
  'paused',
])

export const ALERT_EVENT_STATUSES = Object.freeze([
  'open',
  'acknowledged',
  'resolved',
])

export const PRIORITY_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'critical',
])

export const REPORT_TYPES = Object.freeze([
  'situation_report',
  'incident_brief',
  'intervention_update',
  'data_quality_report',
  'alert_digest',
])

export const REPORT_TEMPLATE_STATUSES = Object.freeze([
  'active',
  'paused',
  'archived',
])

export const REPORT_STATUSES = Object.freeze([
  'draft',
  'ready',
  'approved',
  'distributed',
  'archived',
])

export const REPORT_DISTRIBUTION_STATUSES = Object.freeze([
  'prepared',
  'sent',
  'failed',
])

export const REPORT_SCHEDULE_STATUSES = Object.freeze([
  'active',
  'paused',
  'archived',
])

export const REPORT_SCHEDULE_RUN_STATUSES = Object.freeze([
  'completed',
  'failed',
])

export const INGESTION_SCHEDULE_STATUSES = Object.freeze([
  'active',
  'paused',
  'archived',
])

export function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase()
  if (['critical', 'red', 'extreme'].includes(normalized)) return 'critical'
  if (['high', 'orange', 'severe'].includes(normalized)) return 'high'
  if (['medium', 'moderate', 'yellow'].includes(normalized)) return 'medium'
  if (['low', 'green', 'minor'].includes(normalized)) return 'low'
  return 'unknown'
}

export function severityWeight(value) {
  return {
    critical: 1,
    high: 0.78,
    medium: 0.52,
    low: 0.25,
    unknown: 0.18,
  }[normalizeSeverity(value)]
}

export function riskLevel(score) {
  if (score >= 80) return 'critical'
  if (score >= 60) return 'high'
  if (score >= 35) return 'medium'
  return 'low'
}

export function emptyStore() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source_runs: [],
    ingestion_schedules: [],
    climate_observations: [],
    hazard_events: [],
    conflict_events: [],
    service_assets: [],
    impact_assessments: [],
    risk_scores: [],
    data_quality: [],
    incidents: [],
    interventions: [],
    intervention_tasks: [],
    field_reports: [],
    response_resources: [],
    action_logs: [],
    alert_rules: [],
    alert_events: [],
    rapidpro_dispatches: [],
    rapidpro_inbound_messages: [],
    report_templates: [],
    reports: [],
    report_distribution_runs: [],
    report_schedules: [],
    report_schedule_runs: [],
  }
}

export function publicSourceCatalog() {
  return SOURCE_IDS.map((id) => {
    const common = { id, enabled: true }
    if (id === 'open_meteo') {
      return {
        ...common,
        name: 'Open-Meteo',
        type: 'weather_api',
        requires_credentials: false,
        outputs: ['climate_observations'],
      }
    }
    if (id === 'gdacs') {
      return {
        ...common,
        name: 'GDACS disaster alerts',
        type: 'rss_xml',
        requires_credentials: false,
        outputs: ['hazard_events'],
      }
    }
    if (id === 'glofas') {
      return {
        ...common,
        name: 'Copernicus GloFAS flood forecast',
        type: 'rss_html',
        requires_credentials: false,
        outputs: ['hazard_events'],
      }
    }
    if (id === 'chirps') {
      return {
        ...common,
        name: 'CHIRPS rainfall dataset index',
        type: 'dataset_index',
        requires_credentials: false,
        outputs: ['climate_observations'],
      }
    }
    if (id === 'nasa_firms') {
      return {
        ...common,
        name: 'NASA FIRMS fire detections',
        type: 'csv_api',
        requires_credentials: false,
        outputs: ['hazard_events'],
      }
    }
    if (id === 'service_assets') {
      return {
        ...common,
        name: 'User service assets',
        type: 'json_csv_upload',
        requires_credentials: false,
        outputs: ['service_assets'],
      }
    }
    if (id === 'acled_csv') {
      return {
        ...common,
        name: 'ACLED-compatible user CSV',
        type: 'licensed_csv_upload',
        requires_credentials: true,
        outputs: ['conflict_events'],
      }
    }
    return {
      ...common,
      name: 'Lite conflict event CSV',
      type: 'csv_upload',
      requires_credentials: false,
      outputs: ['conflict_events'],
    }
  })
}
