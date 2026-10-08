import { stableId, toNumber } from './utils.js'

/**
 * Field signals: school attendance and IoT sensor readings.
 *
 * The vision names two signal families the correlation layer did not have:
 * school attendance (the leading indicator for child-welfare shocks — feeding
 * interruptions show up as absences before they show up anywhere else) and
 * direct IoT sensor readings (cold-chain temperature, flood gauges, heat).
 *
 * Both collections are first-class and ingestable (each has a quarantine home
 * via QUARANTINE_SOURCES in store.js), so they pass through the same validation
 * and refusal path as climate_observations, and both are counted in
 * operations.counts(), which makes them thresholdable by alert rules and
 * trigger protocols the moment the first record lands.
 */

export const IOT_SENSOR_TYPES = Object.freeze([
  'cold_chain',
  'flood_gauge',
  'heat',
  'humidity',
  'water_point',
  'other',
])

const IOT_UNITS = Object.freeze({
  cold_chain: '°C',
  flood_gauge: 'm',
  heat: '°C',
  humidity: '%',
  water_point: 'm',
  other: '',
})

function isoDate(value, field) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error(`${field} must be an ISO date-time`), { statusCode: 400 })
  }
  return new Date(parsed).toISOString()
}

function enumOrThrow(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw Object.assign(
      new Error(`${field} must be one of ${allowed.join(', ')}`),
      { statusCode: 400 },
    )
  }
  return value
}

/**
 * One school's attendance on one day.
 *
 * `attendance_rate` is computed, never supplied: a rate a school reports about
 * itself disagrees with enrolled/present often enough that the disagreement is
 * the finding, and storing both lets them drift. present + absent may also not
 * equal enrolled (children unaccounted for is itself a signal), so the sum is
 * not forced.
 */
export function normalizeSchoolAttendance(input, existing = null) {
  const now = new Date().toISOString()
  const date = input.date || existing?.date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw Object.assign(new Error('date is required as YYYY-MM-DD'), { statusCode: 400 })
  }
  const enrolled = toNumber(input.enrolled ?? existing?.enrolled)
  const present = toNumber(input.present ?? existing?.present)
  const absent = toNumber(input.absent ?? existing?.absent)
  if (!(enrolled > 0)) {
    throw Object.assign(new Error('enrolled must be a positive number'), { statusCode: 400 })
  }
  for (const [field, value] of [['present', present], ['absent', absent]]) {
    if (!Number.isFinite(value) || value < 0) {
      throw Object.assign(new Error(`${field} must be a non-negative number`), { statusCode: 400 })
    }
  }
  const rate = Math.round((present / enrolled) * 1000) / 10
  return {
    id: existing?.id || input.id || stableId('school_attendance', [input.school_id, date, enrolled, present]),
    school_id: input.school_id || existing?.school_id || null,
    school_name: input.school_name || existing?.school_name || null,
    district: input.district || existing?.district || null,
    date,
    enrolled,
    present,
    absent,
    attendance_rate: rate,
    source: input.source || existing?.source || 'dhis2',
    source_run_id: input.source_run_id || existing?.source_run_id || null,
    first_seen_at: existing?.first_seen_at || now,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
}

/**
 * One sensor reading. `unit` defaults per sensor type but may be overridden
 * (a flood gauge reporting centimetres is a gauge, not a schema change).
 */
export function normalizeIotObservation(input, existing = null) {
  const now = new Date().toISOString()
  const sensorType = enumOrThrow(
    input.sensor_type || existing?.sensor_type,
    IOT_SENSOR_TYPES,
    'sensor_type',
  )
  const value = toNumber(input.value ?? existing?.value)
  if (!Number.isFinite(value)) {
    throw Object.assign(new Error('value is required and must be numeric'), { statusCode: 400 })
  }
  return {
    id: existing?.id || input.id || stableId('iot', [input.sensor_id, input.observed_at, value]),
    sensor_id: input.sensor_id || existing?.sensor_id || null,
    sensor_type: sensorType,
    district: input.district || existing?.district || null,
    lat: input.lat ?? existing?.lat ?? null,
    lon: input.lon ?? existing?.lon ?? null,
    observed_at: isoDate(input.observed_at || existing?.observed_at, 'observed_at'),
    value,
    unit: input.unit || existing?.unit || IOT_UNITS[sensorType] || '',
    battery_pct: input.battery_pct ?? existing?.battery_pct ?? null,
    source: input.source || existing?.source || 'iot_gateway',
    source_run_id: input.source_run_id || existing?.source_run_id || null,
    first_seen_at: existing?.first_seen_at || now,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
}

/**
 * District attendance summary for one window — the figure a rule or protocol
 * thresholds on. Rates are enrolled-weighted: a 200-pupil school counts twice
 * as much as a 100-pupil school, because that is what "attendance in the
 * district" means.
 *
 * Returns null (not 0) when there is no data, so a rule sees "no signal" rather
 * than "perfect attendance".
 */
export function districtAttendanceRate(data, { district, since = null, until = null } = {}) {
  const rows = (data.school_attendance_observations || []).filter((row) => {
    if (district && row.district !== district) return false
    if (since && String(row.date) < String(since)) return false
    if (until && String(row.date) > String(until)) return false
    return true
  })
  if (!rows.length) return null
  const enrolled = rows.reduce((total, row) => total + (Number(row.enrolled) || 0), 0)
  const present = rows.reduce((total, row) => total + (Number(row.present) || 0), 0)
  if (!(enrolled > 0)) return null
  return Math.round((present / enrolled) * 1000) / 10
}

/**
 * The latest reading per sensor of a given type in a district, plus how many
 * readings breached `above`. A cold-chain rule is "latest temperature above
 * 8°C", not "any reading ever", so the latest wins and the breach count is
 * reported alongside it as the trend.
 */
export function latestSensorReadings(data, { district = null, sensorType, above = null } = {}) {
  const rows = (data.iot_observations || []).filter((row) => {
    if (row.sensor_type !== sensorType) return false
    if (district && row.district !== district) return false
    return true
  })
  if (!rows.length) return null
  const bySensor = new Map()
  for (const row of rows) {
    const current = bySensor.get(row.sensor_id)
    if (!current || String(row.observed_at) > String(current.observed_at)) {
      bySensor.set(row.sensor_id, row)
    }
  }
  const latest = [...bySensor.values()]
  const breaches = above === null ? null : rows.filter((row) => Number(row.value) > above).length
  return { latest, breaches, readings: rows.length }
}
