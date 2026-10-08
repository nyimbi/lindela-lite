#!/usr/bin/env node
/**
 * Field signals: school attendance and IoT sensor readings.
 *
 * The two channels the correlation layer was missing, normalised with the
 * same discipline as every other collection: computed-not-supplied figures,
 * closed enums, ISO timestamps, and honest nulls where a summary has no data
 * to rest on. A rule or protocol thresholds on these through
 * operations.counts() and the district/latest helpers below.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  IOT_SENSOR_TYPES,
  normalizeSchoolAttendance,
  normalizeIotObservation,
  districtAttendanceRate,
  latestSensorReadings,
} from '../src/field-signals.js'

describe('normalizeSchoolAttendance', () => {
  it('computes the rate and keeps the fields it was given', () => {
    const record = normalizeSchoolAttendance({
      school_id: 'school_turkana_01',
      school_name: 'Lodwar Girls Primary',
      district: 'turkana',
      date: '2026-10-06',
      enrolled: 400,
      present: 300,
      absent: 80,
      source: 'dhis2',
    })
    assert.equal(record.attendance_rate, 75, 'present / enrolled, one decimal')
    assert.equal(record.district, 'turkana')
    assert.equal(record.source, 'dhis2')
    assert.ok(record.id.startsWith('school_attendance_'))
    assert.ok(record.first_seen_at)
  })

  it('rejects a malformed date and a non-positive enrolment', () => {
    assert.throws(() => normalizeSchoolAttendance({ date: '6 Oct 2026', enrolled: 10, present: 9 }), /YYYY-MM-DD/)
    assert.throws(() => normalizeSchoolAttendance({ date: '2026-10-06', enrolled: 0, present: 0 }), /positive/)
    assert.throws(() => normalizeSchoolAttendance({ date: '2026-10-06', enrolled: 10, present: -1 }), /non-negative/)
  })

  it('keeps present + absent not equalling enrolled: unaccounted children are a signal', () => {
    const record = normalizeSchoolAttendance({ date: '2026-10-06', enrolled: 100, present: 40, absent: 10 })
    assert.equal(record.attendance_rate, 40, 'the rate is present over enrolled, not over accounted')
  })
})

describe('normalizeIotObservation', () => {
  it('normalises a cold-chain reading with the default unit', () => {
    const record = normalizeIotObservation({
      sensor_id: 'fridge_kakuma_1',
      sensor_type: 'cold_chain',
      district: 'turkana',
      observed_at: '2026-10-08T06:00:00Z',
      value: 9.4,
    })
    assert.equal(record.unit, '°C')
    assert.equal(record.value, 9.4)
    assert.equal(record.sensor_type, 'cold_chain')
  })

  it('rejects an unknown sensor type and a missing value', () => {
    assert.throws(
      () => normalizeIotObservation({ sensor_id: 'x', sensor_type: 'smoke', observed_at: '2026-10-08T06:00:00Z', value: 1 }),
      new RegExp(`one of ${IOT_SENSOR_TYPES.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    assert.throws(
      () => normalizeIotObservation({ sensor_id: 'x', sensor_type: 'heat', observed_at: '2026-10-08T06:00:00Z' }),
      /numeric/,
    )
  })

  it('rejects a non-ISO observed_at rather than storing a NaN epoch', () => {
    assert.throws(
      () => normalizeIotObservation({ sensor_id: 'x', sensor_type: 'heat', observed_at: 'yesterday', value: 40 }),
      /ISO/,
    )
  })
})

describe('districtAttendanceRate', () => {
  const data = {
    school_attendance_observations: [
      { district: 'turkana', date: '2026-10-05', enrolled: 200, present: 150 },
      { district: 'turkana', date: '2026-10-06', enrolled: 100, present: 90 },
      { district: 'bor', date: '2026-10-06', enrolled: 50, present: 25 },
    ],
  }

  it('weights by enrolment and filters by district', () => {
    // (150 + 90 + 25) / (200 + 100 + 50) = 75.7 — not the unweighted
    // (80 + 50) / 2 = 65 a per-district average would give
    assert.equal(districtAttendanceRate(data), 75.7)
    assert.equal(districtAttendanceRate(data, { district: 'turkana' }), 80)
    assert.equal(districtAttendanceRate(data, { district: 'bor' }), 50)
  })

  it('returns null, not 0, when there is nothing to average', () => {
    assert.equal(districtAttendanceRate({}), null)
    assert.equal(districtAttendanceRate(data, { district: 'mandera' }), null)
  })
})

describe('latestSensorReadings', () => {
  const data = {
    iot_observations: [
      { sensor_id: 'f1', sensor_type: 'cold_chain', observed_at: '2026-10-08T05:00:00Z', value: 6 },
      { sensor_id: 'f1', sensor_type: 'cold_chain', observed_at: '2026-10-08T07:00:00Z', value: 9.4 },
      { sensor_id: 'f2', sensor_type: 'cold_chain', observed_at: '2026-10-08T06:00:00Z', value: 4 },
      { sensor_id: 'g1', sensor_type: 'flood_gauge', observed_at: '2026-10-08T07:00:00Z', value: 3.2 },
    ],
  }

  it('keeps only the latest reading per sensor of the requested type', () => {
    const result = latestSensorReadings(data, { sensorType: 'cold_chain' })
    assert.equal(result.latest.length, 2)
    const f1 = result.latest.find((row) => row.sensor_id === 'f1')
    assert.equal(f1.value, 9.4, 'the 07:00 reading supersedes the 05:00 one')
    assert.equal(result.readings, 3, 'the count is over all readings, latest or not')
  })

  it('counts breaches above a threshold across all readings', () => {
    const result = latestSensorReadings(data, { sensorType: 'cold_chain', above: 8 })
    assert.equal(result.breaches, 1, 'one reading of the three is above 8°C')
  })

  it('returns null when the type has no readings', () => {
    assert.equal(latestSensorReadings(data, { sensorType: 'heat' }), null)
    assert.equal(latestSensorReadings({}, { sensorType: 'cold_chain' }), null)
  })
})
