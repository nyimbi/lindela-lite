import { stableId } from '../utils.js'
import { normalizeSchoolAttendance } from '../field-signals.js'
import { defineConnector } from './spec.js'

/**
 * KoboToolbox submission pull.
 *
 * Kobo hosts the forms humanitarian partners actually run (XLSForm-based,
 * offline-capable, works from a feature phone network), so its submissions
 * are field truth arriving as JSON. This connector pulls one asset's
 * submissions and relays them in two shapes, both honest about what they are:
 *
 * 1. A field_report per submission. A Kobo form is not a RapidPro flow — the
 *    two report shapes deliberately differ — so the record keeps the raw
 *    submission as its body and names the provider in `source`. Kobo
 *    submissions carry no reporter URN this connector can hash (the
 *    `_submitted_by` field is an account name, and hashing a name is not the
 *    same discipline as hashing a URN), so `reporter_urn_hash` stays null
 *    rather than pretending.
 *
 *    Shape assumption, stated because this connector does not own the server
 *    wiring: field_reports has no normalizer on the ingest path this feeds —
 *    the store merges records as supplied (keyed by id) and readers use the
 *    fields loosely (reported_by/reporter_urn_hash/body/occurred_at). The
 *    fields below (external_id, form_id, submitted_at, district, body,
 *    source, reporter_urn_hash) are chosen to be self-describing and to match
 *    the names those readers already look for. If a later server-side
 *    normalizer tightens the contract, this shape is the first place to look.
 *
 * 2. Optionally, a normalized school_attendance_observation per submission
 *    when `field_mapping` carries a school_attendance entry naming the Kobo
 *    fields for school_id/date/enrolled/present. Submissions are daily
 *    registers, so unlike DHIS2 they can carry a real absent count; when the
 *    mapping names an `absent` field it is used as supplied, and only when it
 *    does not is absent derived as enrolled - present (the register
 *    arithmetic, stated out loud). A submission missing any required field is
 *    recorded as an error and skipped — the field_report for it is still
 *    returned, because the report and the attendance record are independent
 *    claims.
 *
 * The env gate plus base_url/asset_uid/api_token requirement mirrors every
 * other credential-bearing connector: gated off, it says so in errors and
 * returns nothing.
 */

const DEFAULT_TIMEOUT_MS = 20000

function koboDisabledReason(request) {
  if (process.env.LINDELA_LITE_KOBO_ENABLED !== 'on') {
    return 'KoboToolbox not enabled: set LINDELA_LITE_KOBO_ENABLED=on and provide request.base_url, request.asset_uid and request.api_token to pull submissions.'
  }
  const missing = []
  if (!request.base_url) missing.push('base_url')
  if (!request.asset_uid) missing.push('asset_uid')
  if (!request.api_token) missing.push('api_token')
  return missing.length
    ? `KoboToolbox not enabled: request.${missing.join(', request.')} must be set alongside LINDELA_LITE_KOBO_ENABLED=on.`
    : null
}

async function fetchSubmissions(url, apiToken, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { authorization: `Token ${apiToken}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw Object.assign(new Error(`KoboToolbox HTTP ${response.status}`), { status: response.status })
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('KoboToolbox response was not valid JSON')
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Kobo dates arrive as ISO strings; the normalizer wants YYYY-MM-DD. */
function toDailyDate(value) {
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text
}

async function koboIngest(request = {}) {
  const field_reports = []
  const school_attendance_observations = []
  const errors = []

  const disabled = koboDisabledReason(request)
  if (disabled) {
    errors.push(disabled)
    return { field_reports, school_attendance_observations, errors }
  }

  const base = String(request.base_url).replace(/\/+$/, '')
  const assetUid = String(request.asset_uid)
  const url = new URL(`${base}/api/v2/assets/${encodeURIComponent(assetUid)}/data.json`)

  let payload
  try {
    payload = await fetchSubmissions(url, request.api_token, request.timeout_ms || DEFAULT_TIMEOUT_MS)
  } catch (error) {
    errors.push(`kobotoolbox: ${error.message}`)
    return { field_reports, school_attendance_observations, errors }
  }

  const results = Array.isArray(payload?.results) ? payload.results : []
  if (!Array.isArray(payload?.results)) {
    errors.push('kobotoolbox: response carried no results array; the asset answered but not with a submission list')
    return { field_reports, school_attendance_observations, errors }
  }

  const mappings = request.field_mapping && typeof request.field_mapping === 'object' ? request.field_mapping : {}
  const attendanceMappings = Object.values(mappings).filter((entry) => entry?.kind === 'school_attendance')

  for (const submission of results) {
    const externalId = submission?._id === undefined || submission?._id === null ? null : String(submission._id)
    field_reports.push({
      id: stableId('field_report', ['kobotoolbox', assetUid, externalId ?? results.indexOf(submission)]),
      external_id: externalId,
      form_id: assetUid,
      submitted_at: submission?._submission_time || null,
      district: submission?.district || null,
      // The raw submission is the report. Stringifying an object body keeps
      // every form field the form author chose, unanswered ones included.
      body: typeof submission?.body === 'string' ? submission.body : JSON.stringify(submission ?? {}),
      source: 'kobotoolbox',
      reporter_urn_hash: null,
    })

    for (const mapping of attendanceMappings) {
      const fields = { school_id: mapping.school_id, date: mapping.date, enrolled: mapping.enrolled, present: mapping.present }
      const missing = Object.entries(fields).filter(([name, koboField]) => !koboField || submission?.[koboField] === undefined || submission?.[koboField] === null)
      if (missing.length) {
        errors.push(
          `kobotoolbox: submission ${externalId ?? 'unknown'} is missing required attendance fields `
          + `(${missing.map(([name, koboField]) => `${name}${koboField ? ` (Kobo field '${koboField}')` : ' (no field configured)'}`).join(', ')}); `
          + 'the attendance record is skipped. The field_report is still returned.',
        )
        continue
      }
      const enrolled = Number(submission[mapping.enrolled])
      const present = Number(submission[mapping.present])
      // Prefer the absent field the mapping names when this submission
      // actually carries it; otherwise fall back to the register arithmetic
      // (enrolled - present), stated in the module note.
      const suppliedAbsent = mapping.absent ? Number(submission[mapping.absent]) : NaN
      const absent = Number.isFinite(suppliedAbsent) ? suppliedAbsent : enrolled - present
      try {
        school_attendance_observations.push(normalizeSchoolAttendance({
          school_id: String(submission[mapping.school_id]),
          school_name: mapping.school_name ? String(submission[mapping.school_name] ?? '') || null : null,
          district: mapping.district ? String(submission[mapping.district] ?? '') || (submission.district || null) : (submission.district || null),
          date: toDailyDate(submission[mapping.date]),
          enrolled,
          present,
          absent,
          source: 'kobotoolbox',
        }))
      } catch (error) {
        errors.push(`kobotoolbox: submission ${externalId ?? 'unknown'} failed attendance validation: ${error.message}`)
      }
    }
  }

  return { field_reports, school_attendance_observations, errors }
}

export const koboConnector = defineConnector({
  id: 'kobo',
  description: 'KoboToolbox submission pull. Every submission becomes a field_report carrying the raw form answers (source kobotoolbox, reporter_urn_hash null — no hashable URN arrives). A field_mapping school_attendance entry additionally yields normalized daily school attendance when the form carries school_id/date/enrolled/present fields; missing fields are recorded as errors and skipped. Runs only when LINDELA_LITE_KOBO_ENABLED=on with base_url, asset_uid and api_token.',
  schema: {
    requestSchema: {
      base_url: 'string — KoboToolbox server root URL',
      asset_uid: 'string — the form asset UID',
      api_token: 'string — API token (Token auth)',
      field_mapping: 'object; a school_attendance entry maps canonical names to Kobo field names: { kind, school_id, date, enrolled, present, absent?, school_name?, district? }',
      timeout_ms: 'number (default 20000)',
    },
    outputSchema: {
      field_reports: 'array of field reports, one per submission',
      school_attendance_observations: 'array of normalized daily school attendance records when an attendance mapping is configured',
    },
  },
  // No rateLimit declaration: one request per run, and this connector uses
  // plain fetch rather than fetchWithRetry — a declared number would be a
  // limit nothing reads (the R-11 defect class test/rate-limit.test.js pins).
  defaults: {
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: koboIngest,
})

export const spec = koboConnector
