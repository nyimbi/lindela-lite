/**
 * CAP-02 — DHIS2 `dataValueSet` push. The other half of the connector.
 *
 * `src/connectors/dhis2.js` pulls. Until this module the link was one-way: the
 * platform could read a district's HMIS and could not write back to it, which
 * for a national system of record is the half that matters. A ministry that
 * ingests from DHIS2 and reports nowhere else ends up re-keying this platform's
 * numbers by hand.
 *
 * **What a push must refuse.** The pull's honesty rules are about not inventing
 * readings on the way in; the push's are the mirror, and the failure mode is
 * worse because the number leaves the building and lands in a national
 * database. Three refusals, each of which would otherwise be a silent write:
 *
 *   1. A record with no `orgUnit` mapping is not sent with a blank org unit.
 *      DHIS2 would reject it, or worse, accept it against a default.
 *   2. A record with no `dataElement` mapping is not sent under a guessed UID.
 *      A wrong data element is a correct number filed under the wrong question,
 *      which is indistinguishable from a wrong number downstream.
 *   3. A record whose value is absent is **not** sent as 0. This is VER-02's
 *      class exactly: "nobody reported" and "the answer is zero" are different
 *      facts, and a dataValueSet cannot express the first one — so the record
 *      is refused and counted rather than flattened.
 *
 * A refused record is reported in `refused` with its reason, and `pushed`
 * counts only what was actually sent. A push that refuses everything is a
 * failure, not a success with a zero.
 */

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The DHIS2 period for an observation date, monthly.
 *
 * Monthly is the granularity a `dataValueSet` carries for an aggregate element
 * and the one the pull reads back, so a push and a pull of the same value agree
 * on which period it belongs to. Daily periods exist (`YYYYMMDD`) but only for
 * event data, which this is not.
 */
export function periodForDate(value) {
  const ms = Date.parse(value ?? '')
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}${month}`
}

/**
 * The `dataValueSet` body for a set of records, plus what was refused.
 *
 * Pure, so the shape that reaches an HMIS is testable without a network. The
 * caller supplies `orgUnits` and `dataElements` as lookups from the record's
 * own vocabulary to DHIS2 UIDs — the deployment's mapping, not this module's
 * guess.
 */
export function dataValueSetFrom(records, { orgUnits = {}, dataElements = {}, period = null } = {}) {
  const dataValues = []
  const refused = []
  for (const record of Array.isArray(records) ? records : []) {
    const indicator = record?.indicator ?? record?.metric ?? null
    const dataElement = indicator === null ? null : dataElements[indicator] ?? null
    if (!dataElement) {
      refused.push({ id: record?.id ?? null, reason: 'no dataElement mapping', indicator })
      continue
    }
    const district = record?.district ?? null
    const orgUnit = district === null ? null : orgUnits[district] ?? null
    if (!orgUnit) {
      refused.push({ id: record?.id ?? null, reason: 'no orgUnit mapping', district })
      continue
    }
    const value = record?.value
    // Present-and-finite, not merely coercible. `Number(null)` is 0 and
    // `Number('')` is 0, so a truthiness or `Number()` check would file every
    // absent reading as a measured zero in a national database.
    const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
    if (!Number.isFinite(numeric)) {
      refused.push({ id: record?.id ?? null, reason: 'value is absent, and an absent reading is not a zero', indicator, district })
      continue
    }
    const recordPeriod = period || periodForDate(record?.observed_at ?? record?.created_at)
    if (!recordPeriod) {
      refused.push({ id: record?.id ?? null, reason: 'no parseable observation date, so no period to file it under', indicator, district })
      continue
    }
    dataValues.push({
      dataElement,
      period: recordPeriod,
      orgUnit,
      value: String(numeric),
      ...(record?.comment ? { comment: String(record.comment) } : {}),
    })
  }
  return { dataValues, refused }
}

function authHeader(request) {
  if (request.api_token) return { authorization: `ApiToken ${request.api_token}` }
  if (request.username && request.password) {
    return { authorization: `Basic ${Buffer.from(`${request.username}:${request.password}`).toString('base64')}` }
  }
  return {}
}

/**
 * POST a `dataValueSet` to a DHIS2 instance.
 *
 * Gated off by default, like the pull, and for a stronger reason: a pull that
 * runs when it should not costs a request, and a push that runs when it should
 * not writes into someone else's system of record. `dry_run` defaults to
 * **true** — the caller must ask for the write explicitly, and the default
 * answer to "should this leave the building" is no.
 *
 * The response is read for DHIS2's own import summary, because a 200 from
 * `dataValueSets` does not mean the values were accepted: the endpoint answers
 * 200 with `status: 'ERROR'` and a per-value conflict list. Reporting the HTTP
 * status as the outcome is the defect this avoids.
 */
export async function pushDataValueSet(request = {}) {
  const orgUnits = request.org_units && typeof request.org_units === 'object' ? request.org_units : {}
  const dataElements = request.data_elements && typeof request.data_elements === 'object' ? request.data_elements : {}
  const { dataValues, refused } = dataValueSetFrom(request.records, {
    orgUnits,
    dataElements,
    period: request.period || null,
  })

  const base = { dataValues: dataValues.length, refused: refused.length, refused_records: refused, dry_run: request.dry_run !== false }

  if (request.dry_run !== false) {
    // The default path: the body is built and returned so an operator can see
    // exactly what would be sent, and nothing is sent.
    return { ...base, outcome: 'dry_run', data_value_set: { dataValues } }
  }

  if (process.env.LINDELA_LITE_DHIS2_ENABLED !== 'on') {
    return { ...base, outcome: 'refused', error: 'DHIS2 not enabled: set LINDELA_LITE_DHIS2_ENABLED=on to push. Nothing was sent.' }
  }
  if (!request.base_url) {
    return { ...base, outcome: 'refused', error: 'no base_url supplied, so there is no instance to push to. Nothing was sent.' }
  }
  if (!dataValues.length) {
    return { ...base, outcome: 'refused', error: 'every record was refused, so the push would write nothing. A push that sends zero values is a failure, not a success.' }
  }

  const url = `${String(request.base_url).replace(/\/+$/, '')}/api/dataValueSets`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeout_ms || DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeader(request) },
      body: JSON.stringify({ dataValues }),
      signal: controller.signal,
    })
    const text = await response.text()
    let summary = null
    try {
      summary = JSON.parse(text)
    } catch {
      // A non-JSON body is the instance answering with an error page. The
      // status is still the outcome; the body is not a summary.
      return { ...base, outcome: 'error', status: response.status, error: `DHIS2 answered HTTP ${response.status} with a body that was not JSON` }
    }
    // DHIS2 reports the real result in `status`, not in the HTTP code: a 200
    // with `status: 'ERROR'` is a rejected import.
    const importStatus = summary?.status ?? null
    const imported = summary?.importCount?.imported ?? null
    const updated = summary?.importCount?.updated ?? null
    const ignored = summary?.importCount?.ignored ?? null
    const rejected = (summary?.conflicts || []).map((c) => c?.value ?? c?.object ?? c?.error ?? String(c))
    const accepted = importStatus === 'OK' || importStatus === 'SUCCESS'
    return {
      ...base,
      outcome: accepted ? 'pushed' : 'rejected',
      status: response.status,
      import_status: importStatus,
      imported,
      updated,
      ignored,
      conflicts: rejected,
      ...(accepted ? {} : { error: `DHIS2 rejected the import (status ${importStatus ?? 'absent'}), so the values were not written despite HTTP ${response.status}` }),
    }
  } catch (error) {
    return { ...base, outcome: 'error', error: `dhis2 push: ${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}
