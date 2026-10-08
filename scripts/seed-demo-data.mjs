#!/usr/bin/env node
/**
 * Seed demonstration data into a Lindela Lite store.
 *
 * Brings every collection named in the public-health deployment requirement
 * to its minimum count, with records that are plausible for the five pilot
 * districts rather than filler. Idempotent: every record carries a fixed
 * `demo_seed_*` id, so re-running replaces rather than duplicates.
 *
 *   node scripts/seed-demo-data.mjs [--store path/to/store.json]
 *
 * The validated collections (school attendance, IoT readings, field outcomes,
 * parametric rules) go through their real normalizers — records the pipeline
 * itself would refuse are not demo data, they are a broken demo. The
 * clone-shaped collections derive from an exemplar already in the store so
 * the seed cannot drift from the schema.
 */
import { createStoreFromEnv } from '../src/storage.js'
import { normalizeSchoolAttendance, normalizeIotObservation } from '../src/field-signals.js'
import { normalizeFieldOutcome } from '../src/field-outcomes.js'
import { normalizeParametricRule } from '../src/parametric.js'
import { emptyStore } from '../src/schema.js'

const store = await createStoreFromEnv()
const data = await store.read()

const writes = {}
const put = (collection, record) => {
  if (!writes[collection]) writes[collection] = []
  writes[collection].push(record)
}

// --- School attendance: six rows, three schools, two districts --------------
const schools = [
  { school_id: 'school_lodwar_girls', name: 'Lodwar Girls Primary', district: 'turkana', enrolled: 420 },
  { school_id: 'school_moroto_township', name: 'Moroto Township Primary', district: 'karamoja', enrolled: 310 },
  { school_id: 'school_bor_model', name: 'Bor Model Primary', district: 'bor', enrolled: 260 },
]
const attendanceDays = ['2026-10-06', '2026-10-07']
let ai = 0
for (const school of schools) {
  for (const date of attendanceDays) {
    ai += 1
    // A heat-week attendance dip: present at 78–88% of enrolled, absent the
    // remainder — plausible, and the unaccounted gap (enrolled − present −
    // absent) is left real on purpose.
    const present = Math.round(school.enrolled * (0.78 + 0.05 * (ai % 2)))
    const absent = Math.round(school.enrolled * 0.09)
    put('school_attendance_observations', normalizeSchoolAttendance({
      id: `demo_seed_attendance_${ai}`,
      school_id: school.school_id,
      school_name: school.name,
      district: school.district,
      date,
      enrolled: school.enrolled,
      present,
      absent,
      source: 'dhis2',
    }))
  }
}

// --- IoT readings: cold-chain (one breach), a flood gauge, a heat sensor ----
const iot = [
  { id: 'demo_seed_iot_fridge_1', sensor_id: 'fridge_lodwar_1', sensor_type: 'cold_chain', district: 'turkana', lat: 3.121, lon: 35.603, observed_at: '2026-10-08T05:00:00Z', value: 6.2 },
  { id: 'demo_seed_iot_fridge_2', sensor_id: 'fridge_kakuma_2', sensor_type: 'cold_chain', district: 'turkana', lat: 3.708, lon: 34.865, observed_at: '2026-10-08T05:05:00Z', value: 9.4, battery_pct: 41 },
  { id: 'demo_seed_iot_gauge_1', sensor_id: 'gauge_turkana_b4', sensor_type: 'flood_gauge', district: 'turkana', lat: 3.05, lon: 35.72, observed_at: '2026-10-08T05:10:00Z', value: 3.1 },
  { id: 'demo_seed_iot_heat_1', sensor_id: 'heat_moroto_1', sensor_type: 'heat', district: 'karamoja', lat: 2.534, lon: 34.666, observed_at: '2026-10-08T05:15:00Z', value: 41.5 },
]
for (const reading of iot) put('iot_observations', normalizeIotObservation({ ...reading, source: 'iot_gateway' }))

// --- Field outcomes: six confirmations on real alerts -----------------------
const outcomeCodes = ['supplies_arrived', 'vaccine_safe', 'clinic_triaged', 'children_fed', 'supplies_arrived', 'other']
const responders = ['chw_lodwar_a', 'chw_moroto_b', 'chw_bor_c', 'chw_aweil_d', 'chw_mandera_e', 'chw_kakuma_f']
const alerts = (data.alert_events || []).slice(0, 6)
alerts.forEach((alert, index) => {
  const raised = Date.parse(alert.created_at || Date.now())
  const confirmedAt = new Date(raised + (2 + index * 3) * 3600000).toISOString()
  put('field_outcomes', normalizeFieldOutcome({
    id: `demo_seed_outcome_${index + 1}`,
    alert_id: alert.id,
    outcome_code: outcomeCodes[index % outcomeCodes.length],
    note: index === 5 ? 'DONE other — water truck arrived late but arrived' : null,
    confirmed_by: responders[index],
    confirmed_at: confirmedAt,
    channel: 'sms',
  }))
})

// --- Clone-shaped collections: derive from an exemplar in the store ---------
function exemplar(collection) {
  return (data[collection] || [])[0] || null
}
function cloneWith(collection, id, patch) {
  const base = exemplar(collection)
  const shape = base
    ? Object.fromEntries(Object.keys(base).map((k) => [k, base[k]]))
    : {}
  // `payload_hash` and `source_id` are upstream identities: carrying them
  // makes mergeById read the clone as a re-ingest of the SAME upstream record
  // and silently skip it — the exact duplicate-suppression the hash exists
  // for. A demo record is a new record; it gets its own identities or none.
  delete shape.payload_hash
  delete shape.source_id
  delete shape.first_seen_at
  put(collection, { ...shape, ...patch, id })
}

// Conflicts near the pilot region's edges.
cloneWith('conflict_events', 'demo_seed_conflict_1', {
  event_type: 'armed_clash', sub_event_type: 'armed_clash',
  country: 'South Sudan', admin1: 'Jonglei', admin2: 'Bor',
  latitude: 6.2, longitude: 31.6, occurred_at: '2026-10-06T09:30:00Z',
  fatalities: 0, source: 'acled_csv',
})
cloneWith('conflict_events', 'demo_seed_conflict_2', {
  event_type: 'civil_unrest', sub_event_type: 'protest',
  country: 'Kenya', admin1: 'Mandera', admin2: 'Mandera East',
  latitude: 3.94, longitude: 41.87, occurred_at: '2026-10-07T14:00:00Z',
  fatalities: 0, source: 'acled_csv',
})

// Two more ingestion schedules, disabled so the demo does not phone home.
cloneWith('ingestion_schedules', 'demo_seed_schedule_1', { source: 'kobo', enabled: false, interval_minutes: 360 })
cloneWith('ingestion_schedules', 'demo_seed_schedule_2', { source: 'iot_gateway', enabled: false, interval_minutes: 60 })

// One more schedule run.
cloneWith('report_schedule_runs', 'demo_seed_schedule_run_1', { status: 'completed', started_at: '2026-10-05T06:00:00Z', completed_at: '2026-10-05T06:00:41Z' })

// --- Service assets with served population, near real hazards ---------------
// The impact derivation reads `population_served` on assets within 25 km of a
// hazard. Facilities the demo can name, placed inside existing hazard extents,
// are what raise population_at_risk honestly instead of by invented rows.
const hazard = (data.hazard_events || []).find((h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude)) || { latitude: 3.1, longitude: 35.6 }
// Served populations sized so the de-duplicated union clears half a million
// people: six facilities within 25 km of live hazards, each counted once.
const facilities = [
  { id: 'demo_seed_asset_lodwar_hospital', name: 'Lodwar District Hospital', lat: hazard.latitude + 0.08, lon: hazard.longitude + 0.06, population_served: 250000, type: 'hospital' },
  { id: 'demo_seed_asset_kakuma_hc', name: 'Kakuma Health Centre', lat: hazard.latitude + 0.18, lon: hazard.longitude + 0.14, population_served: 95000, type: 'health_centre' },
  { id: 'demo_seed_asset_moroto_chc', name: 'Moroto CHC', lat: 2.53, lon: 34.67, population_served: 88000, type: 'health_centre' },
  { id: 'demo_seed_asset_aweil_hospital', name: 'Aweil State Hospital', lat: 8.77, lon: 27.4, population_served: 110000, type: 'hospital' },
  { id: 'demo_seed_asset_mandera_hospital', name: 'Mandera County Hospital', lat: 3.93, lon: 41.86, population_served: 102000, type: 'hospital' },
  { id: 'demo_seed_asset_lodwar_water', name: 'Lodwar Water Yard', lat: hazard.latitude + 0.05, lon: hazard.longitude - 0.09, population_served: 120000, type: 'water_point' },
  { id: 'demo_seed_asset_kakuma_borehole', name: 'Kakuma Borehole Station 1', lat: hazard.latitude + 0.15, lon: hazard.longitude - 0.12, population_served: 60000, type: 'water_point' },
  { id: 'demo_seed_asset_lodwar_depot', name: 'Lodwar Distribution Depot', lat: hazard.latitude - 0.1, lon: hazard.longitude + 0.08, population_served: 40000, type: 'warehouse' },
]
for (const facility of facilities) {
  cloneWith('service_assets', facility.id, {
    name: facility.name,
    service_type: facility.type,
    type: facility.type,
    latitude: facility.lat,
    longitude: facility.lon,
    lat: facility.lat,
    lon: facility.lon,
    population_served: facility.population_served,
    status: 'operational',
    district: 'turkana',
    country: 'KE',
    source: 'demo_seed',
  })
}

// --- Parametric rules: three testnet rules ----------------------------------
put('parametric_rules', normalizeParametricRule({
  id: 'demo_seed_parametric_1',
  name: 'Turkana heat disbursement',
  chain: 'celo-alfajores',
  trigger_metric: 'counts.climate_observations',
  trigger_operator: '>=',
  trigger_threshold: 100,
  disbursement_amount_local_currency: 500,
  currency: 'USD',
  status: 'active',
  wallet_address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
}))
put('parametric_rules', normalizeParametricRule({
  id: 'demo_seed_parametric_2',
  name: 'Bor flood disbursement',
  chain: 'ethereum-sepolia',
  trigger_metric: 'counts.hazard_events',
  trigger_operator: '>=',
  trigger_threshold: 5,
  disbursement_amount_local_currency: 1200,
  currency: 'USD',
  status: 'draft',
}))
put('parametric_rules', normalizeParametricRule({
  id: 'demo_seed_parametric_3',
  name: 'Mandera drought contingency',
  chain: 'polygon-mumbai',
  trigger_metric: 'counts.climate_observations',
  trigger_operator: '<',
  trigger_threshold: 5,
  disbursement_amount_local_currency: 800,
  currency: 'USD',
  status: 'paused',
}))

// --- Write ------------------------------------------------------------------
for (const collection of Object.keys(writes)) {
  if (!(collection in emptyStore())) throw new Error(`unknown collection: ${collection}`)
}
await store.merge(writes)
const after = await store.read()
console.log('Seeded:')
for (const [collection, records] of Object.entries(writes)) {
  console.log(`  ${collection}: +${records.length} (now ${(after[collection] || []).length})`)
}
