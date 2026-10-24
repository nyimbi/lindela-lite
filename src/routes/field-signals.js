/**
 * ARC-01 — the field-signal routes, out of the god function.
 *
 * Four collections that arrive from outside the console, each with a list route
 * and a write route, and each with a summary that must be computed over the
 * *whole* set rather than over the page the list returned. That is the property
 * that holds the family together, and it is the one that had already gone wrong
 * once: `/disease-observations` computed its series states over the page
 * `filterRecords` handed back, so the dashboard strip's counts changed with the
 * page size. The summary route beside it had the comment explaining why that is
 * wrong while the list route did exactly that.
 *
 * Three of the four writes go through the outbox rather than writing the record
 * alone. The pattern is the same each time and the reason is R-22: one `emit`
 * carries the record and its action log, so the event cannot outlive the record
 * it announces or announce one that was never written.
 *
 * The fourth, school attendance, is the one that writes an action log beside the
 * record; `iot-observations` batches, and derives its outbox id from the record
 * ids rather than the count — a count-only payload made every same-size batch
 * collide on one id, so once a count-N event had been delivered every later
 * count-N batch was silently dropped while the API still answered 201.
 *
 * `matchFieldSignalRoute` takes the method, because three of these paths serve
 * both a GET and a POST and the handler for each is a different function.
 */

import { normalizeCommunityFeedback, feedbackSummaryByAlert } from '../community.js'
import { normalizeSchoolAttendance, normalizeIotObservation, districtAttendanceRate, latestSensorReadings } from '../field-signals.js'
import { fieldActionLatency, outcomeCounts } from '../field-outcomes.js'
import { summarizeDiseaseObservations } from '../connectors/who-gho.js'
import { actionLog } from '../operations.js'
import { emit } from '../outbox.js'
import { collectionPage, matchedAndPage, readCoordinate, readRequestJson, stableId } from '../utils.js'
import { numericOrNull } from '../analytics/numeric.js'

/**
 * Which field-signal route a request is, or null.
 *
 * Method-aware: `/community-feedback`, `/school-attendance` and
 * `/iot-observations` each serve a GET and a POST on one path, and the two are
 * different handlers. `check-openapi.mjs` reads the `pathname === '…'` literals
 * below, so the paths are spelled out rather than assembled.
 */
export function matchFieldSignalRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/disease-observations' && method === 'GET') return { kind: 'disease-observations' }
  if (pathname === '/api/v1/disease-observations/summary' && method === 'GET') return { kind: 'disease-summary' }
  if (pathname === '/api/v1/field-outcomes' && method === 'GET') return { kind: 'field-outcomes' }
  if (pathname === '/api/v1/field-outcomes/summary' && method === 'GET') return { kind: 'field-outcomes-summary' }
  if (pathname === '/api/v1/community-feedback/summary' && method === 'GET') return { kind: 'feedback-summary' }
  if (pathname === '/api/v1/community-feedback' && method === 'GET') return { kind: 'feedback-list' }
  if (pathname === '/api/v1/community-feedback' && method === 'POST') return { kind: 'feedback-create' }
  if (pathname === '/api/v1/school-attendance' && method === 'GET') return { kind: 'school-list' }
  if (pathname === '/api/v1/school-attendance' && method === 'POST') return { kind: 'school-create' }
  if (pathname === '/api/v1/iot-observations' && method === 'GET') return { kind: 'iot-list' }
  if (pathname === '/api/v1/iot-observations' && method === 'POST') return { kind: 'iot-create' }
  return null
}

/**
 * The narrow shape the map layer consumes: records with coordinates, and the
 * placement honesty carried alongside them.
 *
 * `readCoordinate` rather than `Number.isFinite(Number(record.latitude))`:
 * `Number(null)` and `Number('')` are both 0, so that expression makes a record
 * with no coordinates and a record on the equator the same point — the
 * coercion that once planted every alert of a CAP feed on Null Island. It is
 * also better than raw `Number.isFinite(record.latitude)`, which rejects the
 * numeric *string* `"3.12"` that half the store arrives carrying from
 * connectors. `readCoordinate` rules absence out first and then parses, which
 * is the only order that gets both cases right.
 */
function diseaseMapLayer(rows) {
  const mapped = rows
    .filter((record) => readCoordinate(record.latitude) !== null && readCoordinate(record.longitude) !== null)
    .map((record) => ({
      id: record.id,
      source: record.source,
      disease: record.disease || null,
      country: record.country || null,
      latitude: readCoordinate(record.latitude),
      longitude: readCoordinate(record.longitude),
      location_name: record.location_name || null,
      granularity: record.granularity || 'unknown',
      // `numericOrNull`, not `Number.isFinite(Number(x))`. The coercion turns a
      // record with no case count into a record with **0** cases: `Number(null)`
      // and `Number('')` are 0, `Number(false)` is 0, `Number([])` is 0. On a
      // disease map that reads as a district that reported zero cases, which is
      // a finding, where the truth is that nobody reported. `null` is rendered
      // as "not stated" by the layer; zero is drawn.
      cases: numericOrNull(record.cases),
      deaths: numericOrNull(record.deaths),
      observed_at: record.observed_at || null,
      source_url: record.source_url || null,
    }))
  // String-folded latest timestamp, seeded from `undefined`. Folding against a
  // null seed silently loses everything: `'2026…' > 'null'` is alphabetically
  // false, so every record loses to a null.
  const times = rows.map((r) => r.observed_at).filter(Boolean)
  return { data: mapped, as_of: times.length ? times.sort().at(-1) : null }
}

/**
 * The latest reading per sensor, with coordinates — what the map draws.
 *
 * Same coordinate rule as `diseaseMapLayer`, and this one had the coercion:
 * `Number.isFinite(Number(row.lat))` accepts `null` as 0, so a sensor that
 * reported no position was drawn at 0/0 in the Gulf of Guinea rather than left
 * off the map. A gateway that omits `lat` is saying it does not know where the
 * sensor is, and a pin at Null Island is a claim that it does. Nothing caught
 * it because every fixture omitted `lat` entirely and so never reached the
 * filter with a null to mis-handle.
 */
function iotMapLayer(rows) {
  const bySensor = new Map()
  for (const row of rows) {
    const lat = readCoordinate(row.lat)
    const lon = readCoordinate(row.lon)
    if (lat === null || lon === null) continue
    const current = bySensor.get(row.sensor_id)
    if (!current || String(row.observed_at) > String(current.observed_at)) bySensor.set(row.sensor_id, { ...row, lat, lon })
  }
  const latest = [...bySensor.values()].map((row) => ({
    id: row.id,
    sensor_id: row.sensor_id,
    sensor_type: row.sensor_type,
    district: row.district || null,
    lat: row.lat,
    lon: row.lon,
    value: row.value,
    unit: row.unit || '',
    observed_at: row.observed_at,
    battery_pct: row.battery_pct ?? null,
  }))
  const times = rows.map((row) => row.observed_at).filter(Boolean)
  return { data: latest, as_of: times.length ? times.sort().at(-1) : null }
}

/**
 * Handle one field-signal route. Returns true when it handled the request.
 *
 * `emit` is imported rather than injected: unlike the vintage index or the
 * request ring it is a pure function of the store, and the store is an argument.
 */
export async function handleFieldSignalRoute(route, { store, data, req, res, url, jsonResponse }) {
  const { kind } = route
  const auth = req.__auth

  if (kind === 'disease-observations') {
    if (url.searchParams.get('map') === '1') {
      // Unplacable records (granularity 'unknown') are deliberately NOT here —
      // the map draws nothing for them — while the paged default below still
      // lists them, so nothing an operator could read in the detail dialog is
      // hidden by the geometry filter.
      jsonResponse(res, 200, {
        success: true,
        ...diseaseMapLayer(data.disease_observations || []),
        note: 'Subnational coordinates where available; national centroid otherwise.',
      })
      return true
    }
    // R-27: paged and self-describing rather than a silent cap, and the series
    // states come from the whole matched set. This route used to compute them
    // over the page, which is what the summary route's own comment warns
    // against.
    const { matched, ...page } = matchedAndPage(data.disease_observations || [], url.searchParams, { auth, data, collection: 'disease_observations' })
    jsonResponse(res, 200, { success: true, ...page, summary: summarizeDiseaseObservations(matched) })
    return true
  }

  if (kind === 'disease-summary') {
    // The list endpoint caps at `filterRecords`' page limit, and the series
    // states must not be computed over an arbitrary page of the collection — the
    // dashboard strip therefore reads the whole store here.
    jsonResponse(res, 200, { success: true, data: summarizeDiseaseObservations(data.disease_observations || []) })
    return true
  }

  if (kind === 'field-outcomes') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(data.field_outcomes || [], url.searchParams, { auth, data, collection: 'field_outcomes' }),
    })
    return true
  }

  if (kind === 'field-outcomes-summary') {
    // The refusal is returned as a 200 alongside the counts, never as a bare
    // null. A dashboard that receives `null` renders a dash, and a dash reads as
    // "the response time is zero" or "we have no data" — the sentence
    // `fieldActionLatency` returns is what distinguishes them.
    jsonResponse(res, 200, {
      success: true,
      total: (data.field_outcomes || []).length,
      by_outcome_code: outcomeCounts(data),
      ...fieldActionLatency(data),
    })
    return true
  }

  if (kind === 'feedback-summary') {
    jsonResponse(res, 200, { success: true, data: feedbackSummaryByAlert(data) })
    return true
  }

  if (kind === 'feedback-list') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.community_feedback || [], url.searchParams, { auth, data, collection: 'community_feedback' }) })
    return true
  }

  if (kind === 'feedback-create') {
    const body = await readRequestJson(req)
    let record
    try {
      record = normalizeCommunityFeedback(body)
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return true
    }
    // R-22: one merge, so the event cannot outlive the record it announces.
    const outboxRecord = await emit(store, 'community_feedback.created', { feedback_id: record.id }, {
      community_feedback: [record],
    })
    jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
    return true
  }

  if (kind === 'school-list') {
    const rows = data.school_attendance_observations || []
    const districts = [...new Set(rows.map((row) => row.district).filter(Boolean))].sort()
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(rows, url.searchParams, { auth, data, collection: 'school_attendance_observations' }),
      summary: {
        overall_rate: districtAttendanceRate(data),
        districts: Object.fromEntries(districts.map((district) => [district, districtAttendanceRate(data, { district })])),
        schools: new Set(rows.map((row) => row.school_id || row.school_name).filter(Boolean)).size,
      },
    })
    return true
  }

  if (kind === 'school-create') {
    const body = await readRequestJson(req)
    let record
    try {
      record = normalizeSchoolAttendance(body)
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return true
    }
    const log = actionLog('school_attendance_observations', 'created', record, body.actor, auth?.subject)
    const outboxRecord = await emit(store, 'school_attendance.created', { record_id: record.id }, {
      school_attendance_observations: [record],
      action_logs: [log],
    })
    jsonResponse(res, 201, { success: true, data: record, outbox_event: outboxRecord.id })
    return true
  }

  if (kind === 'iot-list') {
    const rows = data.iot_observations || []
    if (url.searchParams.get('map') === '1') {
      // `?map=1` returns the latest reading per sensor with coordinates — the
      // shape the map layer draws. `?sensor_type=X&above=N` scopes the summary;
      // a cold-chain rule asks "latest reading per fridge, and how many readings
      // breached 8°C", which is what `latestSensorReadings` answers.
      jsonResponse(res, 200, { success: true, ...iotMapLayer(rows) })
      return true
    }
    const sensorType = url.searchParams.get('sensor_type')
    const above = url.searchParams.get('above')
    const summary = sensorType
      ? latestSensorReadings(data, { sensorType, above: above === null ? null : Number(above) })
      : null
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(rows, url.searchParams, { auth, data, collection: 'iot_observations' }),
      summary,
    })
    return true
  }

  if (kind === 'iot-create') {
    // Sensor gateways push either one reading or `{ readings: [...] }`. A
    // partial batch rejects as a unit: half-written batches are how a gateway
    // and the store disagree about what was recorded.
    const body = await readRequestJson(req)
    const inputs = Array.isArray(body?.readings) ? body.readings : [body]
    if (!inputs.length) {
      jsonResponse(res, 400, { success: false, error: 'a reading or a non-empty readings array is required' })
      return true
    }
    let records
    try {
      records = inputs.map((input) => normalizeIotObservation(input))
    } catch (err) {
      jsonResponse(res, err.statusCode || 400, { success: false, error: err.message })
      return true
    }
    const logs = records.map((record) => actionLog('iot_observations', 'created', record, body.actor || 'iot_gateway', auth?.subject))
    // The outbox event id is derived from this payload (`outbox.js`
    // `outboundEventId`). A count-only payload made every same-size batch collide
    // on one id, so once a count-N event was delivered, every later count-N batch
    // was silently dropped — records and action logs lost, the API still
    // answering 201. A stable batch id derived from the record ids keeps true
    // retries of the same batch deduplicated while making distinct batches
    // distinct.
    const batchId = stableId('iot_batch', records.map((record) => record.id).sort())
    const outboxRecord = await emit(store, 'iot.observations_recorded', { count: records.length, batch_id: batchId }, {
      iot_observations: records,
      action_logs: logs,
    })
    jsonResponse(res, 201, { success: true, data: records.length === 1 ? records[0] : records, count: records.length, outbox_event: outboxRecord.id })
    return true
  }

  return false
}
