// =============================================================
// Lindela Lite — domain labels
// =============================================================
//
// The API speaks in field names and the interface used to speak the same way.
// A focal point approving a trigger that releases money was shown
//
//     Metric        precipitation_mm
//     Threshold     40 (value: 48)
//
// and an alert list carried `conflict_events_count_7d` and
// `fever_case_rate_per_1000` as visible labels. The number was right; the
// meaning was withheld from the person who had to act on it.
//
// Everything here is presentational only. An unmapped key falls through to a
// humanised form of itself rather than disappearing, so a new backend field is
// legible on arrival instead of looking like a bug.

const METRIC_LABELS = {
  // Hydrology and climate
  precipitation_mm: 'Rainfall (mm)',
  precipitation_anomaly_mm: 'Rainfall anomaly (mm)',
  temperature_max_c: 'Peak temperature (°C)',
  temperature_min_c: 'Lowest temperature (°C)',
  river_level_m: 'River level (m)',
  water_level_m: 'Water level (m)',
  flood_depth_m: 'Flood depth (m)',
  discharge_m3s: 'River discharge (m³/s)',
  vertical_resolution_m: 'Vertical resolution (m)',

  // Food security (IPC)
  phase3plus_number: 'People in IPC phase 3+',
  phase3plus_fraction: 'Share of population in IPC phase 3+',
  ipc_phase: 'IPC phase',
  food_consumption_score: 'Food consumption score',

  // Conflict
  conflict_events_count_7d: 'Conflict events (7 days)',
  conflict_events_count_30d: 'Conflict events (30 days)',
  fatality_count: 'Fatalities',
  displacement_estimate: 'People displaced',
  conflict_displacement_events_7d: 'Displacement events (7 days)',

  // Health
  fever_case_rate_per_1000: 'Fever cases per 1,000',
  cholera_case_rate_per_1000: 'Cholera cases per 1,000',
  malnutrition_prevalence_pct: 'Malnutrition prevalence',
  vaccination_coverage_pct: 'Vaccination coverage',
  mortality_rate: 'Mortality rate',

  // Access and roads
  access_status: 'Road access',
  access_reason: 'Access reason',
  road_class: 'Road class',
  impassable_segments: 'Impassable segments',

  // Delivery and response
  people_reached: 'People reached',
  warning_to_action_median_hours: 'Warning to action',
  false_alert_rate: 'False alert rate',
  cold_chain_protection_rate: 'Cold-chain protection rate',
  delivery_rate: 'Delivery rate',
  acknowledgement_rate: 'Acknowledgement rate',
}

/**
 * Humanise a key we have no explicit label for: `phase3plus_number` becomes
 * "Phase3plus number". Better than the raw key, and honest about the fact that
 * nobody has named this field yet.
 */
function humanise(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

/** The label for a metric or field name. Never returns an empty string. */
export function metricLabel(key) {
  if (!key) return '—'
  const k = String(key)
  return METRIC_LABELS[k] || humanise(k)
}

/*
 * `KNOWN_METRICS`, `ruleLabel` and `describeRecord` were exported from here
 * with no consumer on any surface. `describeRecord` in particular is ~25 lines
 * of formatter logic shipped to every console load to render a detail view that
 * does not exist. Removed to pay for the locked-out-console banner rather than
 * to raise the first-load budget a third time.
 */