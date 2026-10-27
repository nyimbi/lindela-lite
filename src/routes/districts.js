/**
 * ENH-60 — the district-and-equity family, out of the dispatcher.
 *
 * Five routes that answer the same question at three scales: what does the
 * platform know about a place, and does it treat places alike?
 *
 *   - `/districts` is the geography the platform publishes pages for,
 *     projected from the administrative registry rather than declared here.
 *   - `/districts/{id}` is that place's roll-up across eleven collections.
 *   - `/equity/*` is the comparison *between* places: dispatch quality by
 *     district, the districts that fall under a threshold, and the audit
 *     workflows raised for them.
 *
 * ## The refusals that are answers
 *
 * Three of the five publish a figure that looks more complete than it is, and
 * each carries the qualification beside the number:
 *
 *   - `equity/by-district` reports `dispatch_precision_pct` **and** the
 *     determined sample it was computed from. A district with 50 dispatches and
 *     one resolved record has a precision computed from a single case, so
 *     `determined_dispatched` is not decoration — it is the number that says
 *     whether the first one means anything. `data_gaps` names the four
 *     breakdowns the schema cannot produce at all.
 *   - `equity/breaches` applies `minSample` as the gate, so a district is not
 *     named a breach on a one-record sample. An absent `threshold` must stay
 *     absent rather than become `Number(null) = 0`, which would report every
 *     district with any determined dispatch as a breach.
 *   - `equity/scan` answers `created` beside `ids`: the workflow creation is
 *     idempotent against open audits, so a second scan over unchanged data
 *     creates nothing, and a caller reading only the array would read that as a
 *     failure.
 */

import { KNOWN_DISTRICTS, districtOverview, districtSummary } from '../districts.js'
import { createEquityAuditWorkflows, detectAccuracyBreaches, equityByDistrict } from '../equity.js'
import { parseBoundedNumber } from '../utils.js'

/**
 * Which district-or-equity route a request is, or null.
 *
 * Method-aware, because the family is not uniform: four routes are GET and the
 * audit scan is POST. A blanket guard would close one half or the other.
 * `check-openapi.mjs` reads this body, so the paths are discoverable without a
 * second list.
 *
 * `/districts/{id}` is matched rather than compared because the id is a path
 * segment. The pattern is anchored at both ends so `/districts/co/ke` — which is
 * not a route — does not resolve to the district `co`.
 */
export function matchDistrictRoute(pathname, method = 'GET') {
  if (method === 'GET') {
    if (pathname === '/api/v1/districts') return { kind: 'districts' }
    const detail = pathname.match(/^\/api\/v1\/districts\/([^/]+)$/)
    if (detail) return { kind: 'district', id: detail[1] }
    if (pathname === '/api/v1/equity/by-district') return { kind: 'equity-by-district' }
    if (pathname === '/api/v1/equity/breaches') return { kind: 'equity-breaches' }
    return null
  }
  if (method === 'POST') {
    if (pathname === '/api/v1/equity/scan') return { kind: 'equity-scan' }
    return null
  }
  return null
}

/**
 * Handle one district-or-equity route. Returns true when it handled the request.
 */
export async function handleDistrictRoute(route, { store, data, req, res, url, jsonResponse }) {
  const { kind } = route

  if (kind === 'districts') {
    // HX-06. The list page fetched this and then one overview per card to fill
    // four numbers and a hazard line — 2,652 KB measured through the live
    // ingress for five districts, of which ~2.3 MB was the 30-row
    // `alert_events` sample each overview embeds and the card discarded. The
    // summary is computed from the same arrays the overview reads, so the two
    // cannot disagree; `view=summary` is what asks for it.
    if (url.searchParams.get('view') === 'summary') {
      jsonResponse(res, 200, {
        success: true,
        data: KNOWN_DISTRICTS.map((d) => districtSummary(data, d.slug)),
      })
      return true
    }
    jsonResponse(res, 200, { success: true, data: KNOWN_DISTRICTS })
    return true
  }

  if (kind === 'district') {
    const overview = districtOverview(data, route.id)
    if (!overview) {
      jsonResponse(res, 404, { success: false, error: 'District not found' })
      return true
    }
    jsonResponse(res, 200, { success: true, data: overview })
    return true
  }

  if (kind === 'equity-by-district') {
    jsonResponse(res, 200, { success: true, data: equityByDistrict(data) })
    return true
  }

  if (kind === 'equity-breaches') {
    // `Number(null)` is 0, so an absent threshold would otherwise report every
    // district with any determined dispatch as a breach. Absent stays absent and
    // the module's own default applies.
    //
    // A present but unreadable one is the other half. `?threshold=abc` became
    // `NaN`, and `precision < NaN` is false for every district, so the scan
    // reported no breaches — the parameter an operator narrows to find more
    // problems widened the silence instead. The bounds are percentages: below 0
    // every district breaches, above 100 none can.
    const threshold = url.searchParams.has('threshold')
      ? parseBoundedNumber(url.searchParams.get('threshold'), { min: 0, max: 100, name: 'threshold' })
      : undefined
    jsonResponse(res, 200, {
      success: true,
      data: detectAccuracyBreaches(data, threshold !== undefined ? { threshold } : {}),
    })
    return true
  }

  if (kind === 'equity-scan') {
    const ids = await createEquityAuditWorkflows(store, data)
    // 201 with both the count and the ids: the creation is idempotent against
    // open audits, so a second scan over unchanged data creates nothing and
    // `created: 0` is the answer, not a failure.
    jsonResponse(res, 201, { success: true, created: ids.length, ids })
    return true
  }

  return false
}
