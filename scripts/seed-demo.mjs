import { createStoreFromEnv } from '../src/storage.js'
import { runIngestion, defaultIngestionSchedules } from '../src/ingestion.js'
import { refreshAnalytics } from '../src/analytics.js'
import { createEquityAuditWorkflows } from '../src/equity.js'
import { normalizeAlertRule, normalizeTriggerProtocol } from '../src/alerts.js'
import { normalizeWorkflowInstance, transitionWorkflow } from '../src/workflows.js'
import { buildCreate } from '../src/operations.js'
import { normalizeServiceAsset } from '../src/connectors/uploads.js'
import {
  normalizeReportTemplate,
  normalizeReport,
  normalizeDistributionRun,
  normalizeReportSchedule,
  normalizeScheduleRun,
} from '../src/reports.js'
import { normalizeWebhookSubscription } from '../src/webhooks.js'
import { normalizeCommunityFeedback } from '../src/community.js'
import { normalizeParametricRule, simulateDisbursement } from '../src/parametric.js'
import { stableId, nowIso } from '../src/utils.js'

const REGIONS = [
  { name: 'Turkana', country: 'KE', lat: 3.1167, lon: 35.6, admin1: 'Turkana' },
  { name: 'Bor', country: 'SS', lat: 6.207, lon: 31.548, admin1: 'Jonglei' },
  { name: 'Aweil', country: 'SS', lat: 8.767, lon: 27.4, admin1: 'Northern Bahr el Ghazal' },
  { name: 'Moroto', country: 'UG', lat: 2.5333, lon: 34.6667, admin1: 'Moroto' },
  { name: 'Mandera', country: 'KE', lat: 3.9366, lon: 41.8569, admin1: 'Mandera' },
]

const FOCAL_POINTS = [
  { name: 'Achola Wanjiru', region: 'Turkana', org: 'MoH Kenya' },
  { name: 'Peter Deng', region: 'Bor', org: 'MoH South Sudan' },
  { name: 'Fatuma Hassan', region: 'Mandera', org: 'Dada Salama Network' },
  { name: 'Nyabuot Chan', region: 'Aweil', org: 'MoH South Sudan' },
  { name: 'Emmanuel Okello', region: 'Moroto', org: 'IGAD ICPAC' },
  { name: 'Amina Jillo', region: 'Mandera', org: 'MoH Kenya' },
]

const PARTNER_ORGS = ['MoH Kenya', 'MoH South Sudan', 'IGAD ICPAC', 'Dada Salama Network']

function daysAgo(n) {
  return new Date(Date.now() - n * 86400 * 1000).toISOString()
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600 * 1000).toISOString()
}

function coordNear(lat, lon, spread = 0.12) {
  const idx = Math.abs(Math.round(lat * 100 + lon * 100)) % 7
  const offsets = [0.04, -0.07, 0.11, -0.03, 0.09, -0.12, 0.06]
  return { lat: lat + offsets[idx % 7], lon: lon + offsets[(idx + 3) % 7] }
}

export async function ingestPublicSources(store) {
  const results = {}
  const sources = ['open_meteo', 'gdacs', 'glofas', 'chirps', 'nasa_firms']
  const regions = REGIONS.map(r => ({ name: r.name, country: r.country, lat: r.lat, lon: r.lon }))

  for (const source of sources) {
    try {
      const result = await runIngestion(store, { sources: [source], regions })
      results[source] = { status: 'ok', records: result.counts }
    } catch (e) {
      results[source] = { status: 'error', error: e.message }
      console.error(`[seed] ${source} ingestion failed:`, e.message)
    }
  }

  const data = await store.read()
  const schedules = defaultIngestionSchedules(data)
  await store.merge({ ingestion_schedules: schedules })

  return results
}

function buildServiceAssets() {
  const assets = []
  const assetDefs = [
    // Clinics
    { name: 'Kakuma Health Centre', type: 'health', region: REGIONS[0], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 1200, beds: 24 } },
    { name: 'Lodwar District Hospital Annex', type: 'health', region: REGIONS[0], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 3400, beds: 60 } },
    { name: 'Bor State Hospital Outpost', type: 'health', region: REGIONS[1], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 2100, beds: 30 } },
    { name: 'Tonj Road Clinic', type: 'health', region: REGIONS[1], meta: { cold_chain: false, unicef_supported: true, beneficiaries: 800, beds: 10 } },
    { name: 'Aweil Town Health Post', type: 'health', region: REGIONS[2], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 1500, beds: 20 } },
    { name: 'Wau Road Community Clinic', type: 'health', region: REGIONS[2], meta: { cold_chain: false, unicef_supported: false, beneficiaries: 620, beds: 8 } },
    { name: 'Moroto CHC', type: 'health', region: REGIONS[3], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 1800, beds: 35 } },
    { name: 'Mandera County Hospital Annex', type: 'health', region: REGIONS[4], meta: { cold_chain: true, unicef_supported: true, beneficiaries: 2600, beds: 45 } },
    // Water
    { name: 'Kakuma Borehole Station 1', type: 'water', region: REGIONS[0], meta: { beneficiaries: 3500, asset_subtype: 'borehole', operational: true } },
    { name: 'Lodwar Water Yard', type: 'water', region: REGIONS[0], meta: { beneficiaries: 2800, asset_subtype: 'water_yard', operational: true } },
    { name: 'Bor River Pump Station', type: 'water', region: REGIONS[1], meta: { beneficiaries: 4200, asset_subtype: 'pump_station', operational: true } },
    { name: 'Aweil Borehole B4', type: 'water', region: REGIONS[2], meta: { beneficiaries: 1900, asset_subtype: 'borehole', operational: true } },
    { name: 'Moroto Borehole East', type: 'water', region: REGIONS[3], meta: { beneficiaries: 2200, asset_subtype: 'borehole', operational: false } },
    { name: 'Mandera Water Kiosk Cluster', type: 'water', region: REGIONS[4], meta: { beneficiaries: 3100, asset_subtype: 'water_yard', operational: true } },
    // Schools
    { name: 'Kakuma Primary School', type: 'school', region: REGIONS[0], meta: { enrolment: 820, feeding_programme: true, unicef_supported: true } },
    { name: 'Lodwar Girls Primary', type: 'school', region: REGIONS[0], meta: { enrolment: 640, feeding_programme: true, unicef_supported: false } },
    { name: 'Bor Model Primary', type: 'school', region: REGIONS[1], meta: { enrolment: 910, feeding_programme: true, unicef_supported: true } },
    { name: 'Aweil East Primary', type: 'school', region: REGIONS[2], meta: { enrolment: 750, feeding_programme: false, unicef_supported: true } },
    { name: 'Moroto Township Primary', type: 'school', region: REGIONS[3], meta: { enrolment: 680, feeding_programme: true, unicef_supported: true } },
    { name: 'Mandera Boys Primary', type: 'school', region: REGIONS[4], meta: { enrolment: 800, feeding_programme: true, unicef_supported: true } },
    // Roads
    { name: 'Turkana B4 Supply Route', type: 'road', region: REGIONS[0], meta: { length_km: 82, condition: 'fair', flood_risk: 'high' } },
    { name: 'Bor-Malakal Highway Segment', type: 'road', region: REGIONS[1], meta: { length_km: 45, condition: 'poor', flood_risk: 'critical' } },
    { name: 'Aweil North Access Road', type: 'road', region: REGIONS[2], meta: { length_km: 30, condition: 'good', flood_risk: 'medium' } },
    { name: 'Mandera-Wajir Road', type: 'road', region: REGIONS[4], meta: { length_km: 115, condition: 'fair', flood_risk: 'medium' } },
    // CHW Posts
    { name: 'Kakuma CHW Outpost A', type: 'other', region: REGIONS[0], meta: { chw_count: 12, asset_subtype: 'chw_post', active: true } },
    { name: 'Bor South CHW Base', type: 'other', region: REGIONS[1], meta: { chw_count: 8, asset_subtype: 'chw_post', active: true } },
    { name: 'Aweil CHW Station', type: 'other', region: REGIONS[2], meta: { chw_count: 15, asset_subtype: 'chw_post', active: true } },
    { name: 'Moroto District CHW Hub', type: 'other', region: REGIONS[3], meta: { chw_count: 10, asset_subtype: 'chw_post', active: true } },
    { name: 'Mandera CHW Coordination Point', type: 'other', region: REGIONS[4], meta: { chw_count: 18, asset_subtype: 'chw_post', active: true } },
    { name: 'Turkana North CHW Relay', type: 'other', region: REGIONS[0], meta: { chw_count: 9, asset_subtype: 'chw_post', active: false } },
  ]

  for (const def of assetDefs) {
    const coords = coordNear(def.region.lat, def.region.lon)
    const result = normalizeServiceAsset({
      id: stableId('asset', [def.name, def.type, def.region.country]),
      name: def.name,
      service_type: def.type,
      country: def.region.country,
      admin1: def.region.admin1,
      latitude: coords.lat,
      longitude: coords.lon,
      status: def.meta.operational === false ? 'inactive' : 'operational',
      metadata: def.meta,
    })
    if (result.value) assets.push(result.value)
  }
  return assets
}

function buildAlertRules() {
  return [
    normalizeAlertRule({ id: 'rule-flood-precip', name: 'Flood Watch: High Precipitation', metric: 'precipitation_mm', operator: '>=', threshold: 40, severity: 'high', status: 'active', suppression_minutes: 360, scope: { regions: ['Turkana', 'Bor', 'Aweil'] }, actions: ['notify_focal_point', 'trigger_workflow'] }),
    normalizeAlertRule({ id: 'rule-drought-precip', name: 'Drought Alert: Low Rainfall', metric: 'precipitation_mm', operator: '<=', threshold: 5, severity: 'high', status: 'active', suppression_minutes: 1440, scope: { regions: ['Mandera', 'Moroto'] }, actions: ['notify_focal_point'] }),
    normalizeAlertRule({ id: 'rule-heat-temp', name: 'Heat Stress: High Temperature', metric: 'temperature_max_c', operator: '>=', threshold: 38, severity: 'medium', status: 'active', suppression_minutes: 720, scope: { regions: ['Mandera', 'Moroto'] }, actions: ['notify_health_focal_point'] }),
    normalizeAlertRule({ id: 'rule-disease-fever', name: 'Disease Outbreak: Fever Case Rate', metric: 'fever_case_rate_per_1000', operator: '>=', threshold: 20, severity: 'critical', status: 'active', suppression_minutes: 480, scope: { regions: ['Bor', 'Aweil'] }, actions: ['notify_focal_point', 'trigger_chw_triage'] }),
    normalizeAlertRule({ id: 'rule-conflict-proximity', name: 'Conflict Proximity Alert', metric: 'conflict_events_count_7d', operator: '>=', threshold: 3, severity: 'high', status: 'active', suppression_minutes: 240, scope: { regions: ['Bor', 'Mandera'] }, actions: ['notify_focal_point', 'request_sitrep'] }),
  ]
}

function buildAlertEvents(rules) {
  const ruleMap = Object.fromEntries(rules.map(r => [r.id, r]))
  const now = Date.now()
  const events = [
    { ruleId: 'rule-flood-precip', status: 'open', severity: 'high', district: 'Turkana', value: 52, daysAgoN: 1, approval: { state: 'proposed' } },
    { ruleId: 'rule-flood-precip', status: 'acknowledged', severity: 'high', district: 'Bor', value: 48, daysAgoN: 4, approval: { state: 'approved', reviewer: 'Peter Deng', reviewed_at: daysAgo(3) } },
    { ruleId: 'rule-flood-precip', status: 'resolved', severity: 'high', district: 'Aweil', value: 61, daysAgoN: 12, approval: { state: 'approved', reviewer: 'Nyabuot Chan', reviewed_at: daysAgo(11) }, resolution_note: 'Flood subsided; road access restored.' },
    { ruleId: 'rule-drought-precip', status: 'open', severity: 'high', district: 'Mandera', value: 2.1, daysAgoN: 2, approval: { state: 'proposed' } },
    { ruleId: 'rule-drought-precip', status: 'acknowledged', severity: 'high', district: 'Moroto', value: 3.4, daysAgoN: 7, approval: { state: 'approved', reviewer: 'Emmanuel Okello', reviewed_at: daysAgo(6) } },
    { ruleId: 'rule-heat-temp', status: 'resolved', severity: 'medium', district: 'Mandera', value: 39.2, daysAgoN: 18, approval: { state: 'auto_approved' }, resolution_note: 'Temperature normalised after three days.' },
    { ruleId: 'rule-disease-fever', status: 'open', severity: 'critical', district: 'Bor', value: 27, daysAgoN: 3, approval: { state: 'proposed' } },
    { ruleId: 'rule-disease-fever', status: 'acknowledged', severity: 'critical', district: 'Aweil', value: 23, daysAgoN: 9, approval: { state: 'approved', reviewer: 'Nyabuot Chan', reviewed_at: daysAgo(8) } },
    { ruleId: 'rule-conflict-proximity', status: 'open', severity: 'high', district: 'Mandera', value: 5, daysAgoN: 2, approval: { state: 'proposed' } },
    { ruleId: 'rule-conflict-proximity', status: 'resolved', severity: 'high', district: 'Bor', value: 4, daysAgoN: 25, approval: { state: 'approved', reviewer: 'Peter Deng', reviewed_at: daysAgo(24) }, resolution_note: 'Situation stabilised; UNMISS engaged.' },
  ]

  return events.map((e, i) => {
    const rule = ruleMap[e.ruleId] || {}
    const createdAt = daysAgo(e.daysAgoN)
    return {
      id: stableId('alert_event', [e.ruleId, e.district, e.daysAgoN]),
      rule_id: e.ruleId,
      rule_name: rule.name || e.ruleId,
      status: e.status,
      severity: e.severity,
      metric: rule.metric || 'unknown',
      value: e.value,
      threshold: rule.threshold || 0,
      operator: rule.operator || '>=',
      message: `${rule.name || e.ruleId}: value ${e.value} in ${e.district}`,
      actions: rule.actions || [],
      scope: { district: e.district, regions: [e.district] },
      approval: e.approval,
      resolution_note: e.resolution_note || null,
      created_at: createdAt,
      updated_at: createdAt,
      suppression_bucket: Math.floor(Date.parse(createdAt) / (120 * 60000)),
      metadata: { district: e.district },
    }
  })
}

function buildTriggerProtocols() {
  return [
    normalizeTriggerProtocol({ id: 'tp-turkana-flood', name: 'Turkana Flood Anticipatory Trigger', metric: 'precipitation_mm', operator: '>=', threshold: 40, severity: 'high', mode: 'live', lead_time_days: 3, description: 'Activate when 72-hour cumulative precipitation exceeds 40 mm in Turkana basin.', approvers: ['Achola Wanjiru'], action_playbook: ['notify_focal_point', 'pre-position_supplies', 'open_anticipatory_workflow'], backtest: { precision: 0.72, recall: 0.68, samples: 18 }, metadata: { district: 'Turkana', focal_point: 'Achola Wanjiru' } }),
    normalizeTriggerProtocol({ id: 'tp-bor-flood', name: 'Bor Flood Anticipatory Trigger', metric: 'precipitation_mm', operator: '>=', threshold: 45, severity: 'high', mode: 'live', lead_time_days: 4, description: 'Nile White flooding precursor: daily precipitation threshold for Bor.', approvers: ['Peter Deng'], action_playbook: ['notify_focal_point', 'evacuate_health_stocks'], backtest: { precision: 0.68, recall: 0.71, samples: 14 }, metadata: { district: 'Bor', focal_point: 'Peter Deng' } }),
    normalizeTriggerProtocol({ id: 'tp-aweil-drought', name: 'Aweil Drought Early-Warning Trigger', metric: 'precipitation_mm', operator: '<=', threshold: 5, severity: 'high', mode: 'live', lead_time_days: 7, description: 'Sub-threshold CHIRPS rainfall index triggers livelihood-support protocols.', approvers: ['Nyabuot Chan'], action_playbook: ['notify_focal_point', 'assess_food_pipeline'], backtest: { precision: 0.64, recall: 0.59, samples: 11 }, metadata: { district: 'Aweil', focal_point: 'Nyabuot Chan' } }),
    normalizeTriggerProtocol({ id: 'tp-moroto-heat', name: 'Moroto Heat-Health Trigger', metric: 'temperature_max_c', operator: '>=', threshold: 38, severity: 'medium', mode: 'live', lead_time_days: 2, description: 'High temperature alert for Moroto pastoral corridor; activate health outreach.', approvers: ['Emmanuel Okello'], action_playbook: ['notify_health_focal_point', 'distribute_oral_rehydration'], backtest: { precision: 0.81, recall: 0.55, samples: 22 }, metadata: { district: 'Moroto', focal_point: 'Emmanuel Okello' } }),
    normalizeTriggerProtocol({ id: 'tp-mandera-conflict', name: 'Mandera Conflict-Displacement Trigger', metric: 'conflict_events_count_7d', operator: '>=', threshold: 3, severity: 'high', mode: 'live', lead_time_days: 1, description: 'Conflict event cluster triggers displacement-response and supply reroute.', approvers: ['Fatuma Hassan', 'Amina Jillo'], action_playbook: ['reroute_supplies', 'notify_displacement_focal_point'], backtest: { precision: 0.76, recall: 0.62, samples: 13 }, metadata: { district: 'Mandera', focal_point: 'Fatuma Hassan' } }),
    normalizeTriggerProtocol({ id: 'tp-cold-chain', name: 'Cold Chain Protection: Temperature Breach', metric: 'temperature_max_c', operator: '>=', threshold: 34, severity: 'high', mode: 'live', lead_time_days: 1, description: 'Forecast heat triggers cold-chain repositioning for vaccines in transit.', approvers: ['Achola Wanjiru', 'Amina Jillo'], action_playbook: ['check_cold_chain_status', 'notify_moh_logistics'], backtest: { precision: 0.88, recall: 0.74, samples: 9 }, metadata: { workflow_type: 'cold_chain_protection' } }),
    normalizeTriggerProtocol({ id: 'tp-school-feeding', name: 'School Feeding Continuity Trigger', metric: 'precipitation_mm', operator: '>=', threshold: 35, severity: 'medium', mode: 'shadow', lead_time_days: 2, description: 'Road flood risk trigger to pre-position school feeding supplies upstream.', approvers: ['Emmanuel Okello'], action_playbook: ['notify_district_education', 'reposition_feeding_stocks'], backtest: { precision: 0.61, recall: 0.70, samples: 10 }, metadata: { workflow_type: 'school_feeding_continuity' } }),
    normalizeTriggerProtocol({ id: 'tp-chw-triage', name: 'CHW Outbreak Triage Trigger', metric: 'fever_case_rate_per_1000', operator: '>=', threshold: 20, severity: 'critical', mode: 'live', lead_time_days: 1, description: 'High fever case rate in CHW catchment triggers supervised clinical triage.', approvers: ['Peter Deng'], action_playbook: ['activate_chw_triage', 'send_rapidpro_alert'], backtest: { precision: 0.79, recall: 0.83, samples: 12 }, metadata: { workflow_type: 'chw_outbreak_triage' } }),
    normalizeTriggerProtocol({ id: 'tp-parametric', name: 'Parametric Rainfall Disbursement Trigger', metric: 'precipitation_mm', operator: '<=', threshold: 8, severity: 'high', mode: 'live', lead_time_days: 5, description: 'Parametric index trigger for testnet disbursement to registered recipients.', approvers: ['Nyabuot Chan', 'Achola Wanjiru'], action_playbook: ['confirm_focal_point', 'dispatch_parametric_tx'], backtest: { precision: 0.73, recall: 0.67, samples: 15 }, metadata: { workflow_type: 'parametric_disbursement' } }),
    normalizeTriggerProtocol({ id: 'tp-equity-audit', name: 'Equity Audit Action Trigger', metric: 'dispatch_accuracy_pct', operator: '<=', threshold: 80, severity: 'medium', mode: 'live', lead_time_days: 0, description: 'Persistent accuracy shortfall below 80% triggers scheduled equity audit.', approvers: ['Achola Wanjiru'], action_playbook: ['schedule_equity_audit', 'notify_programme_officer'], backtest: { precision: 0.55, recall: 0.90, samples: 6 }, metadata: { workflow_type: 'equity_audit_action' } }),
  ]
}

function buildIncidents() {
  const emptyData = { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }
  return [
    buildCreate('incidents', { id: 'inc-turkana-flood-1', title: 'Flash floods cut B4 supply route', description: 'Overnight precipitation 68 mm blocked B4. Supplies for three health posts affected.', status: 'responding', severity: 'high', priority: 'high', country: 'KE', admin1: 'Turkana', latitude: 3.09, longitude: 35.58, occurred_at: daysAgo(3), tags: ['flood', 'supply_chain'], metadata: { protocol_id: 'tp-turkana-flood' } }, emptyData),
    buildCreate('incidents', { id: 'inc-bor-flood-2', title: 'White Nile flooding: Bor riverine displacement', description: 'River level exceeded 8.4 m. Estimated 3,200 displaced. Six villages inundated.', status: 'open', severity: 'critical', priority: 'critical', country: 'SS', admin1: 'Jonglei', latitude: 6.19, longitude: 31.53, occurred_at: daysAgo(5), tags: ['flood', 'displacement'], metadata: { protocol_id: 'tp-bor-flood' } }, emptyData),
    buildCreate('incidents', { id: 'inc-aweil-drought-3', title: 'Prolonged dry spell: livestock losses in Aweil North', description: 'Twenty-eight consecutive dry days. Borehole output down 40%. Livestock mortality reported.', status: 'monitoring', severity: 'high', priority: 'high', country: 'SS', admin1: 'Northern Bahr el Ghazal', latitude: 8.80, longitude: 27.39, occurred_at: daysAgo(14), tags: ['drought', 'livelihood'], metadata: { protocol_id: 'tp-aweil-drought' } }, emptyData),
    buildCreate('incidents', { id: 'inc-bor-disease-4', title: 'Acute watery diarrhoea outbreak: Bor IDP camp', description: 'Fourteen AWD cases reported in 48 hours at Bor transit site. Lab confirmation pending.', status: 'open', severity: 'critical', priority: 'critical', country: 'SS', admin1: 'Jonglei', latitude: 6.22, longitude: 31.56, occurred_at: daysAgo(3), tags: ['disease', 'outbreak'], metadata: { protocol_id: 'tp-chw-triage' } }, emptyData),
    buildCreate('incidents', { id: 'inc-mandera-conflict-5', title: 'Inter-clan clashes disrupt Mandera access road', description: 'Armed clashes on Mandera-Wajir road. Convoy diverted. ETA for supplies extended by 18 hours.', status: 'responding', severity: 'high', priority: 'high', country: 'KE', admin1: 'Mandera', latitude: 3.93, longitude: 41.85, occurred_at: daysAgo(2), tags: ['conflict', 'access'], metadata: { protocol_id: 'tp-mandera-conflict' } }, emptyData),
    buildCreate('incidents', { id: 'inc-moroto-heat-6', title: 'Extreme heat: Moroto district health alert', description: 'Five consecutive days above 39C. Three heat-related cases at Moroto CHC.', status: 'monitoring', severity: 'medium', priority: 'medium', country: 'UG', admin1: 'Moroto', latitude: 2.54, longitude: 34.67, occurred_at: daysAgo(8), tags: ['heat', 'health'], metadata: { protocol_id: 'tp-moroto-heat' } }, emptyData),
    buildCreate('incidents', { id: 'inc-turkana-coldchain-7', title: 'Cold chain breach risk: Kakuma stock', description: 'Forecast max 36C over next 48 h. Refrigeration at Kakuma HC operating near capacity.', status: 'open', severity: 'high', priority: 'high', country: 'KE', admin1: 'Turkana', latitude: 3.12, longitude: 35.62, occurred_at: daysAgo(1), tags: ['cold_chain', 'health'], metadata: { protocol_id: 'tp-cold-chain' } }, emptyData),
    buildCreate('incidents', { id: 'inc-aweil-school-8', title: 'School feeding disruption: Aweil East flooding', description: 'Access road to Aweil East Primary flooded. Feeding supplies unable to reach school for three days.', status: 'stabilized', severity: 'medium', priority: 'medium', country: 'SS', admin1: 'Northern Bahr el Ghazal', latitude: 8.75, longitude: 27.43, occurred_at: daysAgo(18), tags: ['school_feeding', 'flood'], metadata: { protocol_id: 'tp-school-feeding' } }, emptyData),
  ]
}

function buildInterventions(incidents) {
  const incidentData = { incidents, interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }
  return [
    buildCreate('interventions', { id: 'int-supply-reroute-1', incident_id: 'inc-turkana-flood-1', title: 'Reroute B4 supplies via Lokichar bypass', objective: 'Deliver essential health supplies to Kakuma HC and Lodwar Annex using alternate road.', status: 'active', priority: 'high', lead_org: 'MoH Kenya', partners: ['Dada Salama Network'], start_at: daysAgo(2), target_end_at: daysAgo(-2), budget_usd: 4200 }, incidentData),
    buildCreate('interventions', { id: 'int-bor-evac-2', incident_id: 'inc-bor-flood-2', title: 'Bor flood response: health stock evacuation', objective: 'Move vaccines and medical supplies from Bor State Hospital to elevated storage.', status: 'active', priority: 'critical', lead_org: 'MoH South Sudan', partners: ['IGAD ICPAC'], start_at: daysAgo(4), target_end_at: daysAgo(-1), budget_usd: 8700 }, incidentData),
    buildCreate('interventions', { id: 'int-aweil-water-3', incident_id: 'inc-aweil-drought-3', title: 'Aweil emergency water trucking', objective: 'Deliver 50,000 litres daily to communities around Aweil Borehole B4 catchment.', status: 'active', priority: 'high', lead_org: 'MoH South Sudan', partners: ['IGAD ICPAC'], start_at: daysAgo(10), target_end_at: daysAgo(-5), budget_usd: 12400 }, incidentData),
    buildCreate('interventions', { id: 'int-bor-disease-4', incident_id: 'inc-bor-disease-4', title: 'Bor AWD outbreak response', objective: 'Deploy ORS and IV fluids; establish isolation area at Bor transit site.', status: 'active', priority: 'critical', lead_org: 'MoH South Sudan', partners: ['Dada Salama Network'], start_at: daysAgo(2), target_end_at: daysAgo(-4), budget_usd: 6300 }, incidentData),
    buildCreate('interventions', { id: 'int-mandera-access-5', incident_id: 'inc-mandera-conflict-5', title: 'Mandera convoy reroute and escort coordination', objective: 'Negotiate escort with county administration; reroute via B3 to reduce delay.', status: 'planned', priority: 'high', lead_org: 'Dada Salama Network', partners: ['MoH Kenya'], start_at: daysAgo(1), target_end_at: daysAgo(-3), budget_usd: 2100 }, incidentData),
    buildCreate('interventions', { id: 'int-moroto-heat-6', incident_id: 'inc-moroto-heat-6', title: 'Moroto heat response: ORS distribution', objective: 'Distribute oral rehydration salts to health centres and CHW posts across Moroto district.', status: 'completed', priority: 'medium', lead_org: 'IGAD ICPAC', partners: ['MoH Kenya'], start_at: daysAgo(7), completed_at: daysAgo(2), budget_usd: 1800 }, incidentData),
    buildCreate('interventions', { id: 'int-coldchain-7', incident_id: 'inc-turkana-coldchain-7', title: 'Kakuma cold chain emergency repositioning', objective: 'Transfer EPI vaccines to Lodwar backup refrigeration before temperature peaks.', status: 'active', priority: 'high', lead_org: 'MoH Kenya', partners: [], start_at: daysAgo(0), target_end_at: daysAgo(-2), budget_usd: 900 }, incidentData),
    buildCreate('interventions', { id: 'int-school-feeding-8', incident_id: 'inc-aweil-school-8', title: 'Aweil East school feeding continuity', objective: 'Deliver two weeks of feeding stocks pre-positioned at Wau warehouse.', status: 'completed', priority: 'medium', lead_org: 'MoH South Sudan', partners: ['IGAD ICPAC'], start_at: daysAgo(16), completed_at: daysAgo(11), budget_usd: 3400 }, incidentData),
    buildCreate('interventions', { id: 'int-bor-chw-9', incident_id: 'inc-bor-disease-4', title: 'CHW-led case finding: Bor camp clusters', objective: 'Activate 8 CHW teams to identify AWD cases and refer to Bor State Hospital Outpost.', status: 'active', priority: 'critical', lead_org: 'MoH South Sudan', partners: [], start_at: daysAgo(2), target_end_at: daysAgo(-5), budget_usd: 1500 }, incidentData),
    buildCreate('interventions', { id: 'int-aweil-school-alt-10', incident_id: 'inc-aweil-drought-3', title: 'Aweil drought nutrition screening', objective: 'MUAC screening for children U5 across five villages; refer SAM cases to Aweil Town Health Post.', status: 'active', priority: 'high', lead_org: 'MoH South Sudan', partners: ['IGAD ICPAC', 'Dada Salama Network'], start_at: daysAgo(8), target_end_at: daysAgo(-7), budget_usd: 5200 }, incidentData),
  ]
}

function buildTasks(incidents, interventions) {
  const taskData = { incidents, interventions, hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }
  return [
    buildCreate('intervention_tasks', { id: 'task-1', intervention_id: 'int-supply-reroute-1', incident_id: 'inc-turkana-flood-1', title: 'Confirm Lokichar bypass road passability', status: 'done', priority: 'high', owner: 'Achola Wanjiru', due_at: daysAgo(1), completed_at: daysAgo(1), action_type: 'assessment' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-2', intervention_id: 'int-supply-reroute-1', incident_id: 'inc-turkana-flood-1', title: 'Dispatch convoy with escort to Kakuma HC', status: 'in_progress', priority: 'high', owner: 'Achola Wanjiru', due_at: daysAgo(-1), action_type: 'logistics' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-3', intervention_id: 'int-bor-evac-2', incident_id: 'inc-bor-flood-2', title: 'Inventory EPI vaccines at Bor State Hospital', status: 'done', priority: 'critical', owner: 'Peter Deng', due_at: daysAgo(3), completed_at: daysAgo(3), action_type: 'assessment' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-4', intervention_id: 'int-bor-evac-2', incident_id: 'inc-bor-flood-2', title: 'Move cold-chain cargo to elevated storage', status: 'in_progress', priority: 'critical', owner: 'Peter Deng', due_at: daysAgo(-0), action_type: 'logistics' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-5', intervention_id: 'int-aweil-water-3', incident_id: 'inc-aweil-drought-3', title: 'Contract water trucking vendor', status: 'done', priority: 'high', owner: 'Nyabuot Chan', due_at: daysAgo(9), completed_at: daysAgo(9), action_type: 'procurement' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-6', intervention_id: 'int-aweil-water-3', incident_id: 'inc-aweil-drought-3', title: 'Monitor daily delivery volumes at distribution points', status: 'in_progress', priority: 'medium', owner: 'Nyabuot Chan', due_at: daysAgo(-5), action_type: 'monitoring' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-7', intervention_id: 'int-bor-disease-4', incident_id: 'inc-bor-disease-4', title: 'Set up isolation area at transit site', status: 'done', priority: 'critical', owner: 'Peter Deng', due_at: daysAgo(1), completed_at: daysAgo(1), action_type: 'response_action' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-8', intervention_id: 'int-bor-disease-4', incident_id: 'inc-bor-disease-4', title: 'Submit lab samples to Juba reference lab', status: 'in_progress', priority: 'critical', owner: 'Peter Deng', due_at: daysAgo(-1), action_type: 'response_action' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-9', intervention_id: 'int-mandera-access-5', incident_id: 'inc-mandera-conflict-5', title: 'Coordinate with county administration for escort', status: 'todo', priority: 'high', owner: 'Fatuma Hassan', due_at: daysAgo(-1), action_type: 'coordination' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-10', intervention_id: 'int-moroto-heat-6', incident_id: 'inc-moroto-heat-6', title: 'Distribute ORS kits to Moroto CHC and CHW hub', status: 'done', priority: 'medium', owner: 'Emmanuel Okello', due_at: daysAgo(5), completed_at: daysAgo(4), action_type: 'logistics' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-11', intervention_id: 'int-coldchain-7', incident_id: 'inc-turkana-coldchain-7', title: 'Transfer EPI vaccines to Lodwar backup fridge', status: 'in_progress', priority: 'high', owner: 'Achola Wanjiru', due_at: hoursAgo(-6), action_type: 'logistics' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-12', intervention_id: 'int-coldchain-7', incident_id: 'inc-turkana-coldchain-7', title: 'Verify cold chain integrity post-transfer', status: 'todo', priority: 'high', owner: 'Achola Wanjiru', due_at: daysAgo(-1), action_type: 'assessment' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-13', intervention_id: 'int-school-feeding-8', incident_id: 'inc-aweil-school-8', title: 'Confirm Wau warehouse stock levels', status: 'done', priority: 'medium', owner: 'Nyabuot Chan', due_at: daysAgo(15), completed_at: daysAgo(15), action_type: 'assessment' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-14', intervention_id: 'int-bor-chw-9', incident_id: 'inc-bor-disease-4', title: 'Brief CHW teams on AWD case definitions', status: 'done', priority: 'critical', owner: 'Peter Deng', due_at: daysAgo(1), completed_at: daysAgo(1), action_type: 'coordination' }, taskData),
    buildCreate('intervention_tasks', { id: 'task-15', intervention_id: 'int-aweil-school-alt-10', incident_id: 'inc-aweil-drought-3', title: 'Compile MUAC screening results for W32', status: 'blocked', priority: 'high', owner: 'Nyabuot Chan', due_at: daysAgo(-2), action_type: 'monitoring', metadata: { block_reason: 'Awaiting CHW data submission from two villages.' } }, taskData),
  ]
}

function buildFieldReports(incidents, interventions) {
  const frData = { incidents, interventions, hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }
  const reports = []
  const categories = ['fever', 'cough', 'diarrhea', 'flood', 'drought', 'conflict']
  const reporters = ['Achola Wanjiru', 'Peter Deng', 'Fatuma Hassan', 'Nyabuot Chan', 'Emmanuel Okello', 'Amina Jillo', null, null, null]
  const incInt = [
    { incident_id: 'inc-turkana-flood-1', intervention_id: 'int-supply-reroute-1', region: REGIONS[0] },
    { incident_id: 'inc-bor-flood-2', intervention_id: 'int-bor-evac-2', region: REGIONS[1] },
    { incident_id: 'inc-aweil-drought-3', intervention_id: 'int-aweil-water-3', region: REGIONS[2] },
    { incident_id: 'inc-bor-disease-4', intervention_id: 'int-bor-disease-4', region: REGIONS[1] },
    { incident_id: 'inc-mandera-conflict-5', intervention_id: 'int-mandera-access-5', region: REGIONS[4] },
    { incident_id: 'inc-moroto-heat-6', intervention_id: 'int-moroto-heat-6', region: REGIONS[3] },
    { incident_id: 'inc-turkana-coldchain-7', intervention_id: 'int-coldchain-7', region: REGIONS[0] },
    { incident_id: 'inc-aweil-school-8', intervention_id: 'int-school-feeding-8', region: REGIONS[2] },
  ]
  const summaries = [
    'Access route flooded; rerouting supplies via B4 bypass. Stock at destination for 4 days.',
    'Three AWD cases isolated. ORS and IV fluids administered. Lab samples dispatched.',
    'Borehole output reduced to 60% capacity. Trucking vendor confirmed for next 7 days.',
    'Fourteen households displaced to school compound. Shelter assessment complete.',
    'Cold chain reading stable at 4C. Transfer completed without temperature excursion.',
    'Convoy delayed 18 hours by road closure. Community liaison negotiating passage.',
    'MUAC screening: 12% SAM prevalence in U5 cohort. Referrals made to Aweil Town HP.',
    'Vaccine transfer to Lodwar complete. Generator fuel sufficient for 72 hours.',
    'CHW team B visited 34 households; 6 fever cases registered and referred.',
    'River level at 8.1 m, receding. Monitoring point operational.',
    'ORS distribution at four sites complete. Community uptake reported as high.',
    'School feeding resumed after 3-day disruption. Stock levels adequate for 2 weeks.',
    'Conflict flashpoint de-escalating. Road passable with escort from 0800 onwards.',
    'Nutrition screening in village cluster complete. 3 SAM, 9 MAM cases identified.',
    'Water quality test results: E. coli detected in borehole B4. Trucking extended.',
    'Cold chain unit at Bor outpost requires maintenance. Backup unit deployed.',
    'Heat-related illness: 2 cases at Moroto CHC, both discharged after rehydration.',
    'Field team unable to reach Aweil North village due to road condition.',
    'Community leaders engaged on drought messaging. IEC materials distributed.',
    'Disease surveillance form completed for Bor camp: 14 AWD, 2 suspected cholera.',
    'Supply convoy reached Kakuma HC at 1430. Delivery receipt signed.',
    'Nutritional assessment forms collected from 5 villages. Data entry pending.',
    'Fire in Moroto market affected 12 stalls. No health facility damage.',
    'School attendance down 30% due to flooding. Head teacher engaged.',
    'Rapid assessment of Bor displacement site complete. 3,200 displaced confirmed.',
    'Parametric disbursement request filed for Aweil drought cluster.',
    'Feedback received from 40 households on alert SMS quality.',
    'Road condition report: B4 passable for light vehicles only.',
    'Equity audit data collected from Mandera dispatches W30-W34.',
    'Community meeting: 62 attendees discussed flood preparedness protocol.',
    'CHW refresh training completed: 15 CHWs certified on AWD case definitions.',
    'Morning temperature reading: 39.1C at Moroto weather station.',
    'Aweil North nutrition surveillance: week 2 data submitted.',
    'Cold chain maintenance completed; all units certified serviceable.',
    'School feeding monitoring visit: records complete, stock tracked.',
    'Rapid market price assessment: maize up 18% in Mandera vs last quarter.',
    'Field coordination meeting minutes submitted. 8 partners in attendance.',
    'Displacement tracking: 412 new arrivals at Bor transit site since yesterday.',
    'Community feedback forms collected: 28 positive, 9 negative on alert messaging.',
    'End-of-week operational summary submitted to district coordinator.',
  ]
  const ageBands = ['u5', '5-17', '18-59', '60+']
  const genders = ['female', 'female', 'female', 'male', 'male', 'other']
  for (let i = 0; i < 40; i++) {
    const ctx = incInt[i % incInt.length]
    const coords = coordNear(ctx.region.lat, ctx.region.lon)
    const reporter = reporters[i % reporters.length]
    const daysN = Math.max(0, 30 - Math.floor(i * 0.7))
    const isRefugee = i % 7 === 0
    const isPwd = i % 13 === 0
    reports.push(buildCreate('field_reports', {
      id: stableId('fr', [ctx.incident_id, i]),
      incident_id: ctx.incident_id,
      intervention_id: ctx.intervention_id,
      summary: summaries[i % summaries.length],
      reported_by: reporter || 'operator',
      observed_at: daysAgo(daysN),
      latitude: coords.lat,
      longitude: coords.lon,
      demographics: {
        age_band: ageBands[i % ageBands.length],
        gender: genders[i % genders.length],
        pwd: isPwd,
        refugee_or_idp: isRefugee,
      },
      metadata: {
        category: categories[i % categories.length],
        refugee_idp: isRefugee,
        verified: i % 3 !== 0,
      },
    }, frData))
  }
  return reports
}

function buildResponseResources() {
  return [
    buildCreate('response_resources', { id: 'res-1', name: 'EPI Vaccine Cold Box A', resource_type: 'medical_supply', status: 'deployed', quantity: 12, unit: 'box', country: 'KE', location_name: 'Lodwar backup refrigeration', assigned_intervention_id: 'int-coldchain-7', latitude: 3.12, longitude: 35.61 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-2', name: 'ORS Kit Pallet', resource_type: 'medical_supply', status: 'deployed', quantity: 800, unit: 'sachet', country: 'UG', location_name: 'Moroto CHC', assigned_intervention_id: 'int-moroto-heat-6', latitude: 2.53, longitude: 34.67 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-3', name: 'Water Trucking Fleet (3 vehicles)', resource_type: 'logistics', status: 'deployed', quantity: 3, unit: 'vehicle', country: 'SS', location_name: 'Aweil water distribution point', assigned_intervention_id: 'int-aweil-water-3', latitude: 8.77, longitude: 27.41 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-4', name: 'AWD Rapid Response Kit', resource_type: 'medical_supply', status: 'deployed', quantity: 5, unit: 'kit', country: 'SS', location_name: 'Bor transit site isolation area', assigned_intervention_id: 'int-bor-disease-4', latitude: 6.21, longitude: 31.55 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-5', name: 'School Feeding Stock (2-week supply)', resource_type: 'food', status: 'available', quantity: 2800, unit: 'kg', country: 'SS', location_name: 'Wau warehouse', assigned_intervention_id: 'int-school-feeding-8', latitude: 8.77, longitude: 27.39 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-6', name: 'Generator + Fuel (200 L)', resource_type: 'power', status: 'deployed', quantity: 200, unit: 'litre', country: 'KE', location_name: 'Kakuma HC backup power', latitude: 3.11, longitude: 35.59 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-7', name: 'CHW Triage Kits', resource_type: 'medical_supply', status: 'deployed', quantity: 8, unit: 'kit', country: 'SS', location_name: 'Bor CHW base', assigned_intervention_id: 'int-bor-chw-9', latitude: 6.20, longitude: 31.55 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-8', name: 'IEC Materials (flood messaging)', resource_type: 'communications', status: 'available', quantity: 500, unit: 'leaflet', country: 'KE', location_name: 'Turkana county store', latitude: 3.10, longitude: 35.60 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-9', name: 'MUAC Bands', resource_type: 'medical_supply', status: 'depleted', quantity: 0, unit: 'band', country: 'SS', location_name: 'Aweil screening site', assigned_intervention_id: 'int-aweil-school-alt-10', latitude: 8.76, longitude: 27.40 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
    buildCreate('response_resources', { id: 'res-10', name: 'Satellite Phone Set', resource_type: 'communications', status: 'reserved', quantity: 2, unit: 'device', country: 'KE', location_name: 'Mandera field office', latitude: 3.94, longitude: 41.86 }, { incidents: [], interventions: [], hazard_events: [], conflict_events: [], risk_scores: [], service_assets: [], intervention_tasks: [], field_reports: [], response_resources: [] }),
  ]
}

function buildRapidProDispatches(alertEvents) {
  const alertIds = alertEvents.map(e => e.id)
  const dispatches = []
  const msgTemplates = [
    'ALERT: Flood risk high in {region}. Avoid low-lying areas. Follow instructions from local health officer.',
    'DROUGHT WARNING: Low rainfall in {region}. Water rationing in effect. Report to nearest distribution point.',
    'HEAT ADVISORY: Extreme temperatures in {region}. Stay hydrated. Seek shade. Report illness to CHW.',
    'DISEASE ALERT: AWD cases detected near {region}. Boil water before use. Seek care if symptomatic.',
    'CONFLICT ALERT: Access road disrupted in {region}. Supplies rerouted. Expect delay.',
  ]
  const regNames = ['Turkana', 'Bor', 'Aweil', 'Moroto', 'Mandera']
  for (let i = 0; i < 20; i++) {
    const alertEventId = alertIds[i % alertIds.length]
    const region = regNames[i % regNames.length]
    const queuedAt = daysAgo(Math.max(0, 28 - i))
    const sentAt = new Date(Date.parse(queuedAt) + 120000 + i * 15000).toISOString()
    const matchedAt = new Date(Date.parse(queuedAt) - 300000).toISOString()
    dispatches.push({
      id: stableId('rapidpro_dispatch', ['demo', region, i]),
      provider: 'rapidpro',
      alert_event_id: alertEventId,
      status: i % 9 === 0 ? 'failed' : 'sent',
      mode: i % 3 === 0 ? 'broadcast' : 'flow_start',
      message: msgTemplates[i % msgTemplates.length].replace('{region}', region),
      recipients: [`tel:+2547${String(i).padStart(8, '0')}`],
      endpoint: 'https://rapidpro.io/api/v2/broadcasts.json',
      request_body: null,
      response_status: i % 9 === 0 ? 503 : 201,
      response_body: null,
      error: i % 9 === 0 ? 'RapidPro HTTP 503' : null,
      queued_at: queuedAt,
      sent_at: i % 9 === 0 ? null : sentAt,
      matched_signal_id: stableId('alert_event', [alertEventId.replace('alert_event_', ''), region, i % 5]),
      matched_signal_at: matchedAt,
      created_at: queuedAt,
      updated_at: sentAt,
      metadata: {
        partner_org: PARTNER_ORGS[i % PARTNER_ORGS.length],
        recipients_count: 50 + (i * 137 % 2450),
        region,
      },
    })
  }
  return dispatches
}

function buildWorkflowInstances(alertEvents) {
  const alertIds = alertEvents.map(e => e.id)
  const now = nowIso()
  const instances = []

  // 3 anticipatory_alert
  let w1 = normalizeWorkflowInstance({ id: 'wf-aa-1', type: 'anticipatory_alert', state: 'focal_point_review', subject_kind: 'alert_event', subject_id: alertIds[0], district: 'Turkana', owner: 'Achola Wanjiru', created_at: daysAgo(2) })
  w1 = { ...w1, transitions: [{ from: 'signal_detected', to: 'focal_point_review', actor: 'system', reason: 'Precipitation threshold exceeded', timestamp: daysAgo(2) }] }
  instances.push(w1)

  let w2 = normalizeWorkflowInstance({ id: 'wf-aa-2', type: 'anticipatory_alert', state: 'signal_detected', subject_kind: 'alert_event', subject_id: alertIds[1], district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(4) })
  w2 = transitionWorkflow(w2, { to: 'focal_point_review', actor: 'system', reason: 'Auto-escalated per protocol', evidence: 'rule-flood-precip' })
  w2 = transitionWorkflow(w2, { to: 'approved', actor: 'Peter Deng', reason: 'Flood confirmed by river gauge', evidence: 'gauge reading 8.4m' })
  w2 = transitionWorkflow(w2, { to: 'dispatched', actor: 'system', reason: 'RapidPro dispatch sent', evidence: 'dispatch batch 002' })
  instances.push(w2)

  let w3 = normalizeWorkflowInstance({ id: 'wf-aa-3', type: 'anticipatory_alert', state: 'signal_detected', subject_kind: 'alert_event', subject_id: alertIds[2], district: 'Aweil', owner: 'Nyabuot Chan', created_at: daysAgo(12) })
  w3 = transitionWorkflow(w3, { to: 'focal_point_review', actor: 'system', reason: 'Threshold breach auto-escalated' })
  w3 = transitionWorkflow(w3, { to: 'approved', actor: 'Nyabuot Chan', reason: 'Confirmed drought onset' })
  w3 = transitionWorkflow(w3, { to: 'dispatched', actor: 'system', reason: 'SMS batch dispatched' })
  w3 = transitionWorkflow(w3, { to: 'closed', actor: 'Nyabuot Chan', reason: 'Situation stabilised; monitoring continues' })
  instances.push(w3)

  // 2 cold_chain_protection
  let w4 = normalizeWorkflowInstance({ id: 'wf-cc-1', type: 'cold_chain_protection', state: 'temperature_breach_forecast', subject_kind: 'incident', subject_id: 'inc-turkana-coldchain-7', district: 'Turkana', owner: 'Achola Wanjiru', created_at: daysAgo(1) })
  w4 = transitionWorkflow(w4, { to: 'moh_notified', actor: 'system', reason: 'MoH logistics notified via SMS' })
  instances.push(w4)

  let w5 = normalizeWorkflowInstance({ id: 'wf-cc-2', type: 'cold_chain_protection', state: 'temperature_breach_forecast', subject_kind: 'service_asset', subject_id: 'asset-bor-coldchain', district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(6) })
  w5 = transitionWorkflow(w5, { to: 'moh_notified', actor: 'Peter Deng', reason: 'MoH South Sudan logistics team alerted' })
  w5 = transitionWorkflow(w5, { to: 'action_taken', actor: 'Peter Deng', reason: 'Backup unit deployed; chain secured' })
  w5 = transitionWorkflow(w5, { to: 'closed', actor: 'system', reason: 'Temperature readings stable for 24 h' })
  instances.push(w5)

  // 2 school_feeding_continuity
  let w6 = normalizeWorkflowInstance({ id: 'wf-sf-1', type: 'school_feeding_continuity', state: 'disruption_forecast', subject_kind: 'incident', subject_id: 'inc-aweil-school-8', district: 'Aweil', owner: 'Nyabuot Chan', created_at: daysAgo(17) })
  w6 = transitionWorkflow(w6, { to: 'district_notified', actor: 'system', reason: 'District education officer notified' })
  w6 = transitionWorkflow(w6, { to: 'supplies_repositioned', actor: 'Nyabuot Chan', reason: 'Stocks pre-positioned at Wau warehouse' })
  w6 = transitionWorkflow(w6, { to: 'verified', actor: 'Nyabuot Chan', reason: 'School confirmed receipt; feeding resumed' })
  w6 = transitionWorkflow(w6, { to: 'closed', actor: 'system', reason: 'Workflow complete' })
  instances.push(w6)

  let w7 = normalizeWorkflowInstance({ id: 'wf-sf-2', type: 'school_feeding_continuity', state: 'disruption_forecast', subject_kind: 'alert_event', subject_id: alertIds[0], district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(5) })
  w7 = transitionWorkflow(w7, { to: 'district_notified', actor: 'Peter Deng', reason: 'Bor county education office alerted' })
  instances.push(w7)

  // 1 school_health_decision
  let w8 = normalizeWorkflowInstance({ id: 'wf-shd-1', type: 'school_health_decision', state: 'flood_signal_detected', subject_kind: 'alert_event', subject_id: alertIds[1], district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(5) })
  w8 = transitionWorkflow(w8, { to: 'head_teacher_notified', actor: 'Peter Deng', reason: 'Head teacher Bor Model Primary contacted' })
  w8 = transitionWorkflow(w8, { to: 'schedule_shifted', actor: 'system', reason: 'Calendar shifted 3 days per protocol' })
  instances.push(w8)

  // 1 chw_outbreak_triage
  let w9 = normalizeWorkflowInstance({ id: 'wf-chw-1', type: 'chw_outbreak_triage', state: 'symptom_reported', subject_kind: 'incident', subject_id: 'inc-bor-disease-4', district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(3) })
  w9 = transitionWorkflow(w9, { to: 'climate_correlated', actor: 'system', reason: 'AWD cases correlated with flood event' })
  w9 = transitionWorkflow(w9, { to: 'district_reviewed', actor: 'Peter Deng', reason: 'District health officer briefed' })
  instances.push(w9)

  // 1 equity_audit_action
  let w10 = normalizeWorkflowInstance({ id: 'wf-eq-1', type: 'equity_audit_action', state: 'threshold_breached', subject_kind: 'district', subject_id: 'Mandera', district: 'Mandera', owner: 'Amina Jillo', created_at: daysAgo(10), metadata: { accuracy_pct: 72, dispatched: 8 } })
  w10 = transitionWorkflow(w10, { to: 'audit_scheduled', actor: 'Amina Jillo', reason: 'Audit scheduled for W34' })
  instances.push(w10)

  // 1 parametric_disbursement
  let w11 = normalizeWorkflowInstance({ id: 'wf-pd-1', type: 'parametric_disbursement', state: 'threshold_breached', subject_kind: 'alert_event', subject_id: alertIds[3], district: 'Aweil', owner: 'Nyabuot Chan', created_at: daysAgo(7) })
  w11 = transitionWorkflow(w11, { to: 'focal_point_confirmed', actor: 'Nyabuot Chan', reason: 'Drought index confirmed below threshold' })
  instances.push(w11)

  // 2 community_feedback_loop
  let w12 = normalizeWorkflowInstance({ id: 'wf-cf-1', type: 'community_feedback_loop', state: 'alert_dispatched', subject_kind: 'alert_event', subject_id: alertIds[0], district: 'Turkana', owner: 'Achola Wanjiru', created_at: daysAgo(2) })
  w12 = transitionWorkflow(w12, { to: 'feedback_received', actor: 'system', reason: 'Inbound feedback via SMS: 28 responses' })
  instances.push(w12)

  let w13 = normalizeWorkflowInstance({ id: 'wf-cf-2', type: 'community_feedback_loop', state: 'alert_dispatched', subject_kind: 'alert_event', subject_id: alertIds[6], district: 'Bor', owner: 'Peter Deng', created_at: daysAgo(3) })
  w13 = transitionWorkflow(w13, { to: 'feedback_received', actor: 'system', reason: 'Feedback loop activated' })
  w13 = transitionWorkflow(w13, { to: 'reviewed', actor: 'Peter Deng', reason: 'Feedback reviewed; action noted' })
  w13 = transitionWorkflow(w13, { to: 'closed', actor: 'system', reason: 'Loop closed' })
  instances.push(w13)

  return instances
}

function buildCommunityFeedback(alertEvents) {
  const alertIds = alertEvents.map(e => e.id)
  const messages = [
    'Alert received in time. We moved to higher ground before flooding.',
    'Message came too late. Water was already in the compound.',
    'We received the warning but could not read the Swahili text clearly.',
    'CHW confirmed alert and helped us relocate. Helpful.',
    'Alert SMS did not mention which roads are closed.',
    'Temperature warning useful. We distributed ORS before cases rose.',
    'No action possible; no transport available to reach clinic.',
    'We shared the alert with neighbours. Good reach.',
    'Alert about drought did not explain what to do with livestock.',
    'Received three identical messages. One is enough.',
    'Message was clear and actionable. Community leader read it aloud.',
    'We did not receive alert until the morning after the event.',
    'The CHW visit following the SMS was very helpful.',
    'Alert message text too long for basic phones.',
    'Positive experience. Will trust future alerts.',
  ]
  const sentiments = ['positive', 'negative', 'unclear', 'positive', 'negative', 'positive', 'unclear', 'positive', 'negative', 'unclear', 'positive', 'negative', 'positive', 'negative', 'positive']
  return messages.map((msg, i) => normalizeCommunityFeedback({
    id: stableId('feedback', ['demo', i]),
    alert_event_id: alertIds[i % alertIds.length],
    source: ['sms', 'web', 'chw'][i % 3],
    sentiment: sentiments[i],
    message: msg,
    reporter_urn: i % 3 === 0 ? null : `tel:+25473${String(i).padStart(7, '0')}`,
    was_action_taken: i % 4 === 0 ? null : (i % 2 === 0),
    metadata: { district: REGIONS[i % REGIONS.length].name },
  }))
}

function buildReportTemplates() {
  return [
    normalizeReportTemplate({ id: 'tmpl-sitrep', name: 'Situation Report (SITREP)', report_type: 'situation_report', status: 'active', owner: 'ops', distribution_defaults: ['markdown_download', 'webhook'] }),
    normalizeReportTemplate({ id: 'tmpl-incident', name: 'Incident Brief', report_type: 'incident_brief', status: 'active', owner: 'ops', distribution_defaults: ['markdown_download'] }),
    normalizeReportTemplate({ id: 'tmpl-intervention', name: 'Intervention Update', report_type: 'intervention_update', status: 'active', owner: 'ops', distribution_defaults: ['rapidpro_sms', 'webhook'] }),
    normalizeReportTemplate({ id: 'tmpl-alert-digest', name: 'Alert Digest', report_type: 'alert_digest', status: 'active', owner: 'ops', distribution_defaults: ['rapidpro_sms'] }),
  ]
}

function buildReports(templates) {
  const data = { report_templates: templates }
  const titledReports = [
    { template_id: 'tmpl-sitrep', title: 'Turkana Flood SITREP W37', status: 'distributed', scope: { district: 'Turkana' }, generated_at: daysAgo(3), approved_at: daysAgo(2), distributed_at: daysAgo(2) },
    { template_id: 'tmpl-sitrep', title: 'Bor Flood SITREP W37', status: 'approved', scope: { district: 'Bor' }, generated_at: daysAgo(2), approved_at: daysAgo(1) },
    { template_id: 'tmpl-incident', title: 'AWD Outbreak Incident Brief: Bor W37', status: 'ready', scope: { district: 'Bor' }, generated_at: daysAgo(1) },
    { template_id: 'tmpl-intervention', title: 'Aweil Water Trucking Update W36', status: 'distributed', scope: { district: 'Aweil' }, generated_at: daysAgo(8), distributed_at: daysAgo(7) },
    { template_id: 'tmpl-alert-digest', title: 'Weekly Alert Digest W37', status: 'ready', scope: {}, generated_at: daysAgo(1) },
    { template_id: 'tmpl-sitrep', title: 'Mandera Conflict SITREP W37', status: 'draft', scope: { district: 'Mandera' } },
  ]
  return titledReports.map((r, i) => normalizeReport({ id: stableId('report', ['demo', r.title]), ...r, owner: FOCAL_POINTS[i % FOCAL_POINTS.length].name }, data))
}

function buildDistributionRuns(reports) {
  const channels = ['markdown_download', 'webhook', 'rapidpro_sms']
  const runs = []
  for (let i = 0; i < 10; i++) {
    const report = reports[i % reports.length]
    const channel = channels[i % channels.length]
    runs.push(normalizeDistributionRun({
      id: stableId('dist_run', ['demo', report.id, channel, i]),
      channel,
      status: i % 5 === 0 ? 'failed' : 'sent',
      recipients: { emails: [], groups: [PARTNER_ORGS[i % PARTNER_ORGS.length]] },
      payload_summary: report.title,
      response_status: i % 5 === 0 ? 503 : 200,
      error: i % 5 === 0 ? 'Webhook timeout' : null,
      created_at: daysAgo(Math.max(0, 10 - i)),
    }, report))
  }
  return runs
}

function buildReportSchedules(templates) {
  const data = { report_templates: templates }
  return [
    normalizeReportSchedule({ id: 'rsched-1', template_id: 'tmpl-sitrep', status: 'active', timezone: 'Africa/Nairobi', recurrence: { type: 'weekly', day: 'monday', time: '06:00' }, auto_distribute: true, owner: 'Achola Wanjiru' }, data),
    normalizeReportSchedule({ id: 'rsched-2', template_id: 'tmpl-alert-digest', status: 'active', timezone: 'Africa/Juba', recurrence: { type: 'weekly', day: 'friday', time: '15:00' }, auto_distribute: false, owner: 'Peter Deng' }, data),
    normalizeReportSchedule({ id: 'rsched-3', template_id: 'tmpl-intervention', status: 'active', timezone: 'UTC', recurrence: { type: 'monthly', day: 1, time: '07:00' }, auto_distribute: true, owner: 'ops' }, data),
  ]
}

function buildParametricRules() {
  return [
    normalizeParametricRule({ id: 'pr-1', name: 'Aweil Drought Rainfall Index', chain: 'celo-alfajores', contract_address: '0xSIM_celo_aweil', trigger_metric: 'precipitation_mm', trigger_threshold: 8, disbursement_amount_local_currency: 5000, currency: 'USD', recipient_group_id: 'group-aweil-farmers', requires_focal_point_approval: true, status: 'active', metadata: { district: 'Aweil' } }),
    normalizeParametricRule({ id: 'pr-2', name: 'Turkana Flood Pre-financing', chain: 'ethereum-sepolia', contract_address: '0xSIM_eth_turkana', trigger_metric: 'precipitation_mm', trigger_threshold: 40, disbursement_amount_local_currency: 8000, currency: 'USD', recipient_group_id: 'group-turkana-response', requires_focal_point_approval: true, status: 'active', metadata: { district: 'Turkana' } }),
    normalizeParametricRule({ id: 'pr-3', name: 'Mandera Conflict Displacement Support', chain: 'polygon-mumbai', contract_address: '0xSIM_polygon_mandera', trigger_metric: 'conflict_events_count_7d', trigger_threshold: 3, disbursement_amount_local_currency: 3000, currency: 'USD', recipient_group_id: 'group-mandera-displaced', requires_focal_point_approval: false, status: 'draft', metadata: { district: 'Mandera' } }),
  ]
}

function buildDisbursements(rules) {
  const ruleIds = rules.map(r => r.id)
  return [
    { ...simulateDisbursement(rules[0], { actor: 'Nyabuot Chan', focal_point_approved: true }), id: 'disb-1', created_at: daysAgo(7), updated_at: daysAgo(7) },
    { ...simulateDisbursement(rules[1], { actor: 'Achola Wanjiru', focal_point_approved: true }), id: 'disb-2', created_at: daysAgo(5), updated_at: daysAgo(5) },
    { ...simulateDisbursement(rules[0], { actor: 'Nyabuot Chan', focal_point_approved: true }), id: 'disb-3', created_at: daysAgo(14), updated_at: daysAgo(14) },
    { ...simulateDisbursement(rules[1], { actor: 'Achola Wanjiru', focal_point_approved: true }), id: 'disb-4', created_at: daysAgo(21), updated_at: daysAgo(21) },
    { ...simulateDisbursement(rules[2], { actor: 'Amina Jillo', focal_point_approved: true }), id: 'disb-5', created_at: daysAgo(3), updated_at: daysAgo(3) },
  ]
}

function buildWebhookSubscriptions() {
  return [
    normalizeWebhookSubscription({ id: 'wh-1', url: 'https://hooks.example.org/lindela/alerts', events: ['alert.created', 'alert.*'], status: 'active', headers: { 'x-source': 'lindela-lite' } }),
    normalizeWebhookSubscription({ id: 'wh-2', url: 'https://reporting.example.org/lindela/reports', events: ['report.distributed'], status: 'active', headers: { 'x-source': 'lindela-lite' } }),
  ]
}

function buildOutboxEvents(alertEvents, reports) {
  const now = nowIso()
  return [
    { id: stableId('outbox', ['alert.created', alertEvents[0].id]), event: 'alert.created', payload: { alert_event_id: alertEvents[0].id, severity: alertEvents[0].severity }, created_at: daysAgo(1), attempts: 1, status: 'sent', last_attempt_at: daysAgo(1), last_error: null },
    { id: stableId('outbox', ['alert.created', alertEvents[6].id]), event: 'alert.created', payload: { alert_event_id: alertEvents[6].id, severity: alertEvents[6].severity }, created_at: daysAgo(3), attempts: 1, status: 'sent', last_attempt_at: daysAgo(3), last_error: null },
    { id: stableId('outbox', ['report.distributed', reports[0].id]), event: 'report.distributed', payload: { report_id: reports[0].id, title: reports[0].title }, created_at: daysAgo(2), attempts: 1, status: 'sent', last_attempt_at: daysAgo(2), last_error: null },
    { id: stableId('outbox', ['report.distributed', reports[3].id]), event: 'report.distributed', payload: { report_id: reports[3].id, title: reports[3].title }, created_at: daysAgo(7), attempts: 2, status: 'sent', last_attempt_at: daysAgo(7), last_error: null },
    { id: stableId('outbox', ['alert.created', alertEvents[3].id + '-pending']), event: 'alert.created', payload: { alert_event_id: alertEvents[3].id, severity: alertEvents[3].severity }, created_at: hoursAgo(2), attempts: 0, status: 'pending', last_attempt_at: null, last_error: null },
  ]
}

export async function seedAll(store) {
  const serviceAssets = buildServiceAssets()
  await store.merge({ service_assets: serviceAssets })

  const alertRules = buildAlertRules()
  await store.merge({ alert_rules: alertRules })

  const alertEvents = buildAlertEvents(alertRules)
  await store.merge({ alert_events: alertEvents })

  const triggerProtocols = buildTriggerProtocols()
  await store.merge({ trigger_protocols: triggerProtocols })

  const incidents = buildIncidents()
  await store.merge({ incidents })

  const interventions = buildInterventions(incidents)
  await store.merge({ interventions })

  const tasks = buildTasks(incidents, interventions)
  await store.merge({ intervention_tasks: tasks })

  const fieldReports = buildFieldReports(incidents, interventions)
  await store.merge({ field_reports: fieldReports })

  const resources = buildResponseResources()
  await store.merge({ response_resources: resources })

  const dispatches = buildRapidProDispatches(alertEvents)
  await store.merge({ rapidpro_dispatches: dispatches })

  const workflowInstances = buildWorkflowInstances(alertEvents)
  await store.merge({ workflow_instances: workflowInstances })

  const feedback = buildCommunityFeedback(alertEvents)
  await store.merge({ community_feedback: feedback })

  const templates = buildReportTemplates()
  await store.merge({ report_templates: templates })

  const reports = buildReports(templates)
  await store.merge({ reports })

  const scheduleRuns = [
    normalizeScheduleRun({ id: 'sr-1', started_at: daysAgo(7), completed_at: daysAgo(7), status: 'completed' }, { id: 'rsched-1' }, reports[0]),
    normalizeScheduleRun({ id: 'sr-2', started_at: daysAgo(14), completed_at: daysAgo(14), status: 'completed' }, { id: 'rsched-2' }, reports[4]),
  ]
  await store.merge({ report_schedule_runs: scheduleRuns })

  const distributionRuns = buildDistributionRuns(reports)
  await store.merge({ report_distribution_runs: distributionRuns })

  const reportSchedules = buildReportSchedules(templates)
  await store.merge({ report_schedules: reportSchedules })

  const parametricRules = buildParametricRules()
  await store.merge({ parametric_rules: parametricRules })

  const disbursements = buildDisbursements(parametricRules)
  await store.merge({ parametric_disbursements: disbursements })

  const webhooks = buildWebhookSubscriptions()
  await store.merge({ webhook_subscriptions: webhooks })

  const outbox = buildOutboxEvents(alertEvents, reports)
  await store.merge({ events_outbox: outbox })

  const data = await store.read()
  await createEquityAuditWorkflows(store, data, 'seed-demo')
}

export async function summary(store) {
  const data = await store.read()
  const cols = [
    'source_runs', 'ingestion_schedules', 'climate_observations', 'hazard_events',
    'service_assets', 'alert_rules', 'alert_events', 'trigger_protocols', 'incidents',
    'interventions', 'intervention_tasks', 'field_reports', 'response_resources',
    'rapidpro_dispatches', 'workflow_instances', 'community_feedback', 'report_templates',
    'reports', 'report_distribution_runs', 'report_schedules', 'report_schedule_runs',
    'parametric_rules', 'parametric_disbursements', 'webhook_subscriptions', 'events_outbox',
    'risk_scores', 'impact_assessments', 'data_quality',
  ]
  return Object.fromEntries(cols.map(c => [c, (data[c] || []).length]))
}

async function main() {
  const store = await createStoreFromEnv()
  console.error('[seed] ingesting public sources...')
  const ingestionResults = await ingestPublicSources(store)
  console.error('[seed] ingestion results:', JSON.stringify(ingestionResults))
  console.error('[seed] seeding operational data...')
  await seedAll(store)
  console.error('[seed] refreshing analytics...')
  await refreshAnalytics(store)
  const counts = await summary(store)
  console.log(JSON.stringify(counts, null, 2))
  console.error('[seed] done.')
}

if (process.argv[1] && process.argv[1].endsWith('seed-demo.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
