export const SOURCE_IDS = Object.freeze([
  'open_meteo',
  'gdacs',
  'glofas',
  'chirps',
  'nasa_firms',
  'usgs_earthquake',
  'noaa_enso',
  'ipc_hdx',
  'who_gho',
  'gdacs_archive',
  'open_meteo_archive',
  'open_meteo_flood',
  'service_assets',
  'acled_csv',
  'conflict_csv',
  'dhis2',
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

/**
 * How passable a road segment is to light vehicles. Non-road assets leave this
 * null; anything with a road classification is expected to carry one.
 */
export const ROAD_PASSABILITY = Object.freeze([
  'passable',
  'restricted',
  'impassable',
])

/**
 * Road classes, from all-weather trunk routes down to unpaved tracks. Used to
 * reason about which alternate routes exist when a segment is blocked.
 */
export const ROAD_CLASSES = Object.freeze([
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unpaved',
  'track',
])

/**
 * Hazard event types recognised by the platform. Connectors may emit any of
 * these; unknown types are preserved rather than rejected, so a new upstream
 * feed does not silently lose events.
 */
export const HAZARD_EVENT_TYPES = Object.freeze([
  'flood',
  'landslide',
  'storm',
  'earthquake',
  'drought',
  'fire',
  'volcano',
  'eruption',
  'flood_forecast',
  'disaster',
])

/**
 * Hazards that physically obstruct a road. A landslide covering a carriageway
 * and a flood over a bridge are both access-blocking; an earthquake is a
 * precursor, not an obstruction, unless it has produced one of the former.
 */
export const ACCESS_BLOCKING_HAZARDS = Object.freeze([
  'flood',
  'landslide',
  'eruption',
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
    population_at_risk: [],
    facilities_at_risk: [],
    incidents: [],
    interventions: [],
    intervention_tasks: [],
    field_reports: [],
    response_resources: [],
    action_logs: [],
    alert_rules: [],
    alert_events: [],
    trigger_protocols: [],
    rapidpro_dispatches: [],
    rapidpro_inbound_messages: [],
    report_templates: [],
    reports: [],
    report_distribution_runs: [],
    report_schedules: [],
    report_schedule_runs: [],
    data_lineage: [],
    events_outbox: [],
    webhook_subscriptions: [],
    workflow_instances: [],
    community_feedback: [],
    parametric_rules: [],
    parametric_disbursements: [],
    kpi_snapshots: [],
    road_access: [],
    food_security_records: [],
    disease_observations: [],
    flood_probability_models: [],
    watermark_state: [],
    region_trust: [],
    model_drift: [],
    // ENH-13. Must match COLLECTIONS in store.js: an emptyStore key that
    // JsonStore.merge never writes is harmless, but a COLLECTIONS entry with
    // no emptyStore key means read() spreads a missing key over the default
    // and the first `store.record_versions` access throws on a fresh file.
    record_versions: [],
    // ENH-07. Quarantine homes. These keys must match the store.js COLLECTIONS
    // entries of the same names: JsonStore.merge keys strictly off COLLECTIONS
    // and drops an unlisted collection silently, while read() spreads this
    // default under a parsed file — so a name in one list and not the other is
    // a defect in whichever direction it appears.
    quarantine_climate_observations: [],
    quarantine_hazard_events: [],
    quarantine_conflict_events: [],
    quarantine_service_assets: [],
    quarantine_food_security_records: [],
    quarantine_disease_observations: [],
    // Raw upstream response bodies, for replay and fixture seeding (ENH-12).
    //
    // Declared here because `store.js` SCHEMA now carries it: an `emptyStore`
    // key with no SCHEMA entry is harmless, but a SCHEMA entry with no
    // `emptyStore` key means `read()` spreads a missing key over the default and
    // the first `store.payload_captures` access throws on a fresh file.
    payload_captures: [],
    // One row: when the periodic driver last ran, what it attempted, what
    // succeeded, and what failed. The point is that it is readable — a process
    // that is up, serving 200s, and whose pipeline has been dead for a week is
    // currently indistinguishable from a healthy one.
    system_heartbeat: [],
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
        // Verified 2026-10-01: the published rss.xml path served the EFAS
        // single-page app rather than a feed, so this source currently reports
        // an error and zero records. Flagged rather than quietly empty.
        status_note: 'Feed endpoint unverified as of 2026-10-01; reports an error until a working feed URL is confirmed',
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
        // FIRMS requires a free MAP_KEY from an email signup; there is no
        // keyless access. Claiming otherwise let the source look healthy and
        // keyless while every request returned HTTP 400.
        requires_credentials: true,
        credential_hint: 'Set NASA_FIRMS_MAP_KEY (free, via firms.modaps.eosdis.nasa.gov/api/map_key)',
        outputs: ['hazard_events'],
      }
    }
    if (id === 'noaa_enso') {
      return {
        ...common,
        name: 'NOAA CPC Niño 3.4 index (ONI)',
        type: 'ascii_index',
        requires_credentials: false,
        outputs: ['climate_observations'],
      }
    }
    if (id === 'usgs_earthquake') {
      return {
        ...common,
        name: 'USGS earthquake feed',
        type: 'geojson_api',
        requires_credentials: false,
        outputs: ['hazard_events'],
      }
    }
    if (id === 'ipc_hdx') {
      return {
        ...common,
        name: 'IPC acute food insecurity classifications (via HDX)',
        type: 'dataset_api',
        requires_credentials: false,
        // ipcinfo.org 403s automated access, but the IPC organisation
        // publishes the same classifications on HDX, keyless and CC0. The
        // scoping document that concluded otherwise predates this check
        // (2026-10-01 vs 2026-10-02) and has been updated.
        status_note: 'IPC classifications relayed as published, subnational where available; not re-classified, not scored',
        outputs: ['food_security_records'],
      }
    }
    if (id === 'who_gho') {
      return {
        ...common,
        name: 'WHO Global Health Observatory outbreak indicators',
        type: 'odata_api',
        requires_credentials: false,
        status_note: 'National-annual aggregates only: context with attribution, not district surveillance',
        outputs: ['disease_observations'],
      }
    }
    if (id === 'gdacs_archive') {
      return {
        ...common,
        name: 'GDACS historical flood archive (1985 onward)',
        type: 'json_api',
        requires_credentials: false,
        status_note: 'Backfill source for flood-probability training; walk is paginated quarter-by-quarter and slow by design',
        outputs: ['hazard_events'],
      }
    }
    if (id === 'open_meteo_archive') {
      return {
        ...common,
        name: 'Open-Meteo ERA5 historical daily precipitation (1981 onward)',
        type: 'dataset_api',
        requires_credentials: false,
        status_note: 'Reanalysis, not gauge observations — stated on every record; backfill for flood-probability training',
        outputs: ['climate_observations'],
      }
    }
    if (id === 'open_meteo_flood') {
      return {
        ...common,
        name: 'Open-Meteo flood API — GloFAS v4 daily river discharge',
        type: 'dataset_api',
        requires_credentials: false,
        status_note: 'Modelled hydrology, not gauges; regions without a GloFAS river reach are refused as errors; backfill for discharge-labelled flood-probability training',
        outputs: ['climate_observations'],
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
        credential_hint: 'ACLED data is licensed; the operator uploads a file they are entitled to use. No account is bundled.',
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
