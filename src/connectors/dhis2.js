import { stableId } from '../utils.js'
import { normalizeSchoolAttendance } from '../field-signals.js'
import { defineConnector } from './spec.js'

/**
 * DHIS2 dataValueSets pull — the school-attendance and climate-data path.
 *
 * The env gate stays: a humanitarian DHIS2 instance is someone's production
 * HMIS, and this platform must not poke it until a human says so. The gate is
 * `LINDELA_LITE_DHIS2_ENABLED === 'on'` AND `request.base_url`; gated off, the
 * connector says why in `errors` and returns nothing, exactly like a
 * keyless-but-keyed source (nasa_firms) reports a missing MAP_KEY.
 *
 * Honesty constraints, stated up front because each one is a refusal this
 * connector makes on purpose:
 *
 * 1. School attendance needs TWO data elements, never one. A single aggregate
 *    headcount ("enrolled = 412") cannot produce a daily attendance rate, and
 *    normalizeSchoolAttendance rightfully refuses present:null. Padding the
 *    record with an invented present count would manufacture a child-welfare
 *    signal out of a census figure, so a mapping that names only one UID is
 *    recorded as an error and skipped. The pair is expressed in the mapping as
 *    `enrolled_from` + `present_from` — two data element UIDs.
 *
 * 2. `absent` is derived, and the derivation is named. DHIS2 daily attendance
 *    registers count present and enrolled; the register's own arithmetic makes
 *    absent = enrolled - present (a child is either in class or not that day).
 *    The platform's normalizer requires a non-negative absent and keeps
 *    "unaccounted" as a signal when a source genuinely reports all three, but
 *    DHIS2 pairs never carry that third number, so the register arithmetic is
 *    applied here, out loud. When present > enrolled the pair is contradictory
 *    and the whole record is refused rather than silently clamped.
 *
 * 3. Period granularity is a claim, not a detail. A yearly period cannot say
 *    anything about a day, so yearly attendance is refused with an explicit
 *    error instead of being stamped with a date it does not have. Quarterly
 *    periods are stamped with the quarter's last day and monthly periods with
 *    the month's first day — a convention, stated in periodToDate, so a reader
 *    knows the date is a derived anchor and not an observation time.
 *
 * Auth order: api_token (ApiToken scheme) beats username/password (Basic),
 * and no credentials at all means no header is sent — the server's 401 is the
 * honest answer and is recorded as an error, not hidden.
 */

const DEFAULT_TIMEOUT_MS = 20000

/** Calendar-quarter last days. Q1 ends 31 March, Q2 30 June, Q3 30 September, Q4 31 December. */
const QUARTER_LAST_DAY = Object.freeze({ Q1: '03-31', Q2: '06-30', Q3: '09-30', Q4: '12-31' })

/**
 * Derive a daily anchor date from a DHIS2 period string, or null when the
 * granularity cannot support one. Supported: YYYYMMDD (the day itself),
 * YYYYQn (the quarter's last day), YYYYMM (the month's first day). A bare
 * YYYY is a year — no day in it is more representative than any other, so the
 * caller records "period granularity too coarse for daily attendance" and
 * skips rather than inventing one.
 */
export function periodToDate(period) {
  const value = String(period || '')
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  const quarter = value.match(/^(\d{4})Q([1-4])$/)
  if (quarter) return `${quarter[1]}-${QUARTER_LAST_DAY[`Q${quarter[2]}`]}`
  if (/^\d{6}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-01`
  return null
}

/** The current calendar quarter in DHIS2 form, e.g. 2026Q4. */
function currentQuarter() {
  const now = new Date()
  return `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`
}

function authHeader(request) {
  if (request.api_token) return { authorization: `ApiToken ${request.api_token}` }
  if (request.username && request.password) {
    return { authorization: `Basic ${Buffer.from(`${request.username}:${request.password}`).toString('base64')}` }
  }
  return {}
}

/**
 * One GET with a hard timeout. Plain fetch + AbortController rather than
 * fetchWithRetry: a 401 from a wrong token is not transient, and retrying it
 * just burns time against an HMIS that has already answered. Transient
 * handling lives in the ingestion retry policy.
 */
async function fetchDataValueSet(url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw Object.assign(new Error(`DHIS2 HTTP ${response.status}`), { status: response.status })
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('DHIS2 response was not valid JSON')
    }
  } finally {
    clearTimeout(timer)
  }
}

async function dhis2Ingest(request = {}) {
  const climate_observations = []
  const school_attendance_observations = []
  const errors = []

  // Default off: only runs when LINDELA_LITE_DHIS2_ENABLED is explicitly 'on'
  // and a base_url has been supplied for this request.
  const enabled = process.env.LINDELA_LITE_DHIS2_ENABLED === 'on'
  if (!enabled || !request.base_url) {
    errors.push(
      'DHIS2 not enabled: set LINDELA_LITE_DHIS2_ENABLED=on and provide request.base_url '
      + '(the DHIS2 instance root URL) to pull dataValueSets. No records are returned while gated off.',
    )
    return { climate_observations, school_attendance_observations, errors }
  }

  const base = String(request.base_url).replace(/\/+$/, '')
  const url = new URL(`${base}/api/dataValueSets`)
  const orgUnits = Array.isArray(request.org_units) ? request.org_units : []
  for (const orgUnit of orgUnits) url.searchParams.append('orgUnit', orgUnit)
  for (const dataElement of request.data_elements || []) url.searchParams.append('dataElement', dataElement)
  url.searchParams.set('period', request.period || currentQuarter())
  url.searchParams.set('children', 'true')

  let payload
  try {
    payload = await fetchDataValueSet(url, { accept: 'application/json', ...authHeader(request) }, request.timeout_ms || DEFAULT_TIMEOUT_MS)
  } catch (error) {
    errors.push(`dhis2: ${request.period || currentQuarter()}: ${error.message}`)
    return { climate_observations, school_attendance_observations, errors }
  }

  if (!payload || !Array.isArray(payload.dataValues)) {
    errors.push('dhis2: response carried no dataValues array; the instance answered but not with a dataValueSet')
    return { climate_observations, school_attendance_observations, errors }
  }

  const mappings = request.mappings && typeof request.mappings === 'object' ? request.mappings : {}
  const dataValues = payload.dataValues
  const byTriple = new Map()
  for (const row of dataValues) {
    byTriple.set(`${row.dataElement}|${row.orgUnit}|${row.period}`, row.value)
  }

  const attendanceMappings = Object.entries(mappings).filter(([, mapping]) => mapping?.kind === 'school_attendance')
  const attendanceElements = new Set()
  // Two mapping keys commonly name the same pair (one per UID of the pair);
  // the pair is the unit of work, so it is processed once. The first mapping
  // key seen is the label errors are attributed to.
  const attendancePairs = new Map()
  for (const [key, mapping] of attendanceMappings) {
    if (!mapping.enrolled_from || !mapping.present_from) {
      errors.push(
        `dhis2: school attendance mapping '${key}' names only one of enrolled_from/present_from `
        + `(got enrolled_from=${mapping.enrolled_from || 'none'}, present_from=${mapping.present_from || 'none'}). `
        + 'A single aggregate headcount cannot yield a daily attendance rate and this connector refuses to '
        + 'invent a present count; configure both data element UIDs to ingest attendance.',
      )
      continue
    }
    attendanceElements.add(mapping.enrolled_from)
    attendanceElements.add(mapping.present_from)
    const pairKey = `${mapping.enrolled_from}|${mapping.present_from}`
    if (!attendancePairs.has(pairKey)) attendancePairs.set(pairKey, { key, mapping })
  }

  // Climate and unmapped elements, row by row. A data element with no mapping
  // is noted once (deduped) rather than silently dropped or aborting the batch.
  const unmappedNoted = new Set()
  for (const row of dataValues) {
    if (attendanceElements.has(row.dataElement)) continue
    const mapping = mappings[row.dataElement]
    if (!mapping || mapping.kind !== 'climate') {
      if (!unmappedNoted.has(row.dataElement)) {
        unmappedNoted.add(row.dataElement)
        errors.push(
          `dhis2: data element ${row.dataElement} arrived with no mapping; the value is skipped rather than guessed at. `
          + 'Add a climate mapping (indicator/unit/district) or an attendance pair to ingest it.',
        )
      }
      continue
    }
    const observedAt = periodToDate(row.period)
    const value = Number(row.value)
    climate_observations.push({
      id: stableId('climate', ['dhis2', row.dataElement, row.orgUnit, row.period]),
      source: 'dhis2',
      type: 'dhis2_data_element',
      indicator: mapping.indicator || 'dhis2_data_element',
      value: Number.isFinite(value) ? value : null,
      unit: mapping.unit || '',
      observed_at: observedAt || String(row.period),
      period: row.period,
      district: mapping.district || null,
      latitude: null,
      longitude: null,
      org_unit: row.orgUnit || null,
      metadata: { provider: 'DHIS2', data_element: row.dataElement },
    })
  }

  // Attendance pairs: for every org unit + period the pair reported at, join
  // enrolled and present into one normalized record. A half-pair (one element
  // missing for that org unit/period) is recorded and skipped, not padded.
  for (const { key, mapping } of attendancePairs.values()) {
    const triples = new Set()
    for (const row of dataValues) {
      if (row.dataElement === mapping.enrolled_from || row.dataElement === mapping.present_from) {
        triples.add(`${row.orgUnit}|${row.period}`)
      }
    }
    for (const triple of triples) {
      const enrolledRaw = byTriple.get(`${mapping.enrolled_from}|${triple}`)
      const presentRaw = byTriple.get(`${mapping.present_from}|${triple}`)
      const label = mapping.school_id || triple
      if (enrolledRaw === undefined || presentRaw === undefined) {
        errors.push(
          `dhis2: attendance pair '${key}' for ${triple} is incomplete `
          + `(enrolled=${enrolledRaw === undefined ? 'missing' : enrolledRaw}, present=${presentRaw === undefined ? 'missing' : presentRaw}); skipped.`,
        )
        continue
      }
      const enrolled = Number(enrolledRaw)
      const present = Number(presentRaw)
      if (!Number.isFinite(enrolled) || !Number.isFinite(present)) {
        errors.push(`dhis2: attendance pair '${key}' for ${triple} carried a non-numeric value; skipped.`)
        continue
      }
      if (!(enrolled > 0)) {
        errors.push(`dhis2: attendance pair '${key}' for ${triple} reported enrolled=${enrolled}; a non-positive enrolment is refused.`)
        continue
      }
      if (present < 0 || present > enrolled) {
        errors.push(
          `dhis2: attendance pair '${key}' for ${triple} reported present=${present} against enrolled=${enrolled}; `
          + 'a negative or over-enrolment present count is contradictory and is refused, not clamped.',
        )
        continue
      }
      const date = periodToDate(String(triple).split('|')[1])
      if (!date) {
        errors.push(`dhis2: period granularity too coarse for daily attendance (period ${String(triple).split('|')[1]}); skipped.`)
        continue
      }
      try {
        school_attendance_observations.push(normalizeSchoolAttendance({
          school_id: mapping.school_id || null,
          school_name: mapping.school_name || null,
          district: mapping.district || null,
          date,
          enrolled,
          present,
          // See the module note: the register's own arithmetic, stated out loud.
          absent: enrolled - present,
          source: 'dhis2',
        }))
      } catch (error) {
        errors.push(`dhis2: attendance record for ${label} ${triple} failed validation: ${error.message}`)
      }
    }
  }

  return { climate_observations, school_attendance_observations, errors }
}

export const dhis2Connector = defineConnector({
  id: 'dhis2',
  description: 'DHIS2 dataValueSets pull. Maps configured data elements to climate observations and, when a mapping names BOTH enrolled_from and present_from data element UIDs, to normalized daily school attendance records (absent derived as enrolled minus present, the register arithmetic, stated per record). A single aggregate headcount is refused with an error — no invented present counts. Runs only when LINDELA_LITE_DHIS2_ENABLED=on and request.base_url is set.',
  schema: {
    requestSchema: {
      base_url: 'string — DHIS2 instance root URL',
      api_token: 'string — personal access token (ApiToken auth)',
      username: 'string — basic auth user (used when api_token absent)',
      password: 'string — basic auth password',
      org_units: 'array of string — org unit UIDs (default [])',
      data_elements: 'array of string — data element UIDs to pull',
      period: 'string — DHIS2 period e.g. 2026Q3 (default current quarter)',
      mappings: 'object keyed by data element UID: { kind: climate|school_attendance, indicator?, unit?, district?, school_id?, school_name?, enrolled_from?, present_from? }',
      timeout_ms: 'number (default 20000)',
    },
    outputSchema: {
      climate_observations: 'array of climate observations from mapped data elements',
      school_attendance_observations: 'array of normalized daily school attendance records from enrolled/present pairs',
    },
  },
  // No rateLimit declaration here, on purpose. The R-11 ratchet in
  // test/rate-limit.test.js requires every declared rateLimit to resolve to a
  // live RATE_LIMIT_POLICIES entry, and dhis2 is pinned exempt there: one
  // request per run to a configured instance is not a crawl. This connector
  // also uses plain fetch rather than fetchWithRetry, so a declared number
  // would be a limit nothing reads — the exact defect the ratchet exists for.
  defaults: {
    retry: { max: 1, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: dhis2Ingest,
})

export const spec = dhis2Connector
