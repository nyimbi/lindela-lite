/**
 * ARC-01 — the exposure reads, out of the god function.
 *
 * What a hazard does to the things people depend on: which roads are cut, which
 * food-security records are flagged, which facilities and populations sit in a
 * risk radius. Nine routes over seven paths, and they are one family because
 * they share a single property that is easy to get wrong in the same way every
 * time:
 *
 * **the roll-up describes the matched set, not the page.**
 *
 * `road-access` and `food-security` each return a listing with a summary beside
 * it, and each summary must be computed over every record that matched the
 * query — not over the twenty-five the page happened to carry. `summarizeRoadAccess(matched)`
 * beside a page of 25 roads is the map's "N of M roads impassable" reporting N
 * out of the window instead of out of the network, and it undercounts the
 * moment the set outgrows the limit. The summary-only routes beside them read
 * the whole collection for the same reason.
 *
 * This family had already been fixed once for exactly that (R-27, and the
 * food-security note that cites it), which is why the property is asserted in
 * `test/exposure-route-module.test.js` rather than left to the next reader.
 *
 * **The method is in the matcher.** `road-access`, `road-access/summary`,
 * `food-security` and `food-security/summary` were written as
 * `if (url.pathname === …)` with no verb test, so `DELETE /api/v1/road-access`
 * answered 200 with the full listing — a destructive method returning a body
 * that says nothing about destruction, on a path `docs/openapi.yaml` documents
 * as `get:` only. A caller cannot tell that from a server that ignored the
 * method, and a scanner cannot tell it from a server that honoured it. The
 * matcher takes the method so the wrong verb is a 404 rather than a 200.
 */

import { isDeleted } from '../operations.js'
import { summarizeRoadAccess } from '../road-access.js'
import { summarizeFoodSecurity } from '../connectors/ipc-hdx.js'
import { collectionPage, matchedAndPage } from '../utils.js'

/**
 * Which exposure route a request is, or null.
 *
 * Method-aware, and the verb is load-bearing on the four paths that had no
 * guard: they answer a GET and nothing else.
 */
export function matchExposureRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/service-impacts') return { kind: 'service-impacts' }
  if (pathname === '/api/v1/impact/population-at-risk') return { kind: 'population-at-risk' }
  if (pathname === '/api/v1/impact/facilities-at-risk') return { kind: 'facilities-at-risk' }
  if (pathname === '/api/v1/road-access') return { kind: 'road-access' }
  if (pathname === '/api/v1/road-access/summary') return { kind: 'road-access-summary' }
  if (pathname === '/api/v1/food-security') return { kind: 'food-security' }
  if (pathname === '/api/v1/food-security/summary') return { kind: 'food-security-summary' }
  return null
}

/**
 * Handle one exposure route. Returns true when it handled the request.
 *
 * The paged reads go through `collectionPage`, the summarised ones through
 * `matchedAndPage`, and the difference between them is the point: only a route
 * that publishes a roll-up needs the whole matched set in hand, and
 * `collectionPage` is what keeps a listing from being a second full scan.
 */
export async function handleExposureRoute(route, { data, req, res, url, jsonResponse }) {
  const { kind } = route
  const auth = req.__auth
  const page = (records, collection) => collectionPage(records, url.searchParams, { auth, data, collection })

  if (kind === 'service-impacts') {
    jsonResponse(res, 200, { success: true, ...page(data.impact_assessments, 'impact_assessments') })
    return true
  }

  if (kind === 'population-at-risk') {
    jsonResponse(res, 200, { success: true, ...page(data.population_at_risk || [], 'population_at_risk') })
    return true
  }

  if (kind === 'facilities-at-risk') {
    jsonResponse(res, 200, { success: true, ...page(data.facilities_at_risk || [], 'facilities_at_risk') })
    return true
  }

  if (kind === 'road-access') {
    // One record per road asset, so the set grows with the road network. The
    // roll-up is computed from `matched`, not from the page: `impassable`
    // beside a page of 25 roads must describe the network, not the window.
    //
    // `include_deleted` is honoured for the caller that asks, and the deleted
    // filter runs *before* the match so a soft-deleted road is not counted in
    // the summary either.
    const includeDeleted = url.searchParams.get('include_deleted') === 'true'
    const all = includeDeleted
      ? (data.road_access || [])
      : (data.road_access || []).filter((item) => !isDeleted(item))
    const { matched, ...rest } = matchedAndPage(all, url.searchParams, { auth, data, collection: 'road_access' })
    jsonResponse(res, 200, { success: true, ...rest, summary: summarizeRoadAccess(matched) })
    return true
  }

  if (kind === 'road-access-summary') {
    jsonResponse(res, 200, { success: true, data: summarizeRoadAccess(data.road_access || []) })
    return true
  }

  if (kind === 'food-security') {
    // Summary rides along with the list, like road-access: a caller paging the
    // records gets the roll-up for nothing instead of a second request.
    //
    // R-27. This once called `filterRecords` and returned its capped page
    // directly — no `total`, no `has_more`, no cursor — so against the demo
    // store 4,017 of 4,517 records were unreachable and nothing said so.
    const { matched, ...rest } = matchedAndPage(data.food_security_records || [], url.searchParams, { auth, data, collection: 'food_security_records' })
    jsonResponse(res, 200, { success: true, ...rest, summary: summarizeFoodSecurity(matched) })
    return true
  }

  if (kind === 'food-security-summary') {
    jsonResponse(res, 200, { success: true, data: summarizeFoodSecurity(data.food_security_records || []) })
    return true
  }

  return false
}
