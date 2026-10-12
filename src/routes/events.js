/**
 * ENH-60 — the events-and-assessments family, out of the dispatcher.
 *
 * Two reads over the same union: `/api/v1/events` *is* the merged hazard-and-
 * conflict event list, and `/api/v1/assessments` publishes that same list as
 * `recent_events` beside the risk roll-ups derived from it. They are one family
 * because they answer one question at two depths — "what happened" and "what
 * does it add up to" — and because the union expression
 * `[...data.hazard_events, ...data.conflict_events]` was written twice in the
 * dispatcher. Two copies of one expression is the shape VER-18 recorded, and
 * here they are one `recentEvents()` so a change to what counts as an event is a
 * change in one place.
 *
 * The assessments roll-up is the ARC-05 class in its densest form: it publishes
 * counts, five filtered record lists, an operational summary, a calibration
 * report and the recent-events list, and a caller that receives a bare number
 * from any of them cannot tell a measured zero from an absent measurement. Two
 * of its members carry a history worth naming:
 *
 *   - `recent_events` was the one list on the route that did not thread `auth`,
 *     so a partner token asking for `/api/v1/assessments` received every hazard
 *     and conflict event in the platform while the four lists beside it were
 *     filtered. It is scoped now, like its siblings.
 *   - `calibration` was exported, documented in the JTBD catalogue as evidence
 *     this route "includes calibration metadata", and called from nowhere. A
 *     claim in a catalogue is not a feature; it is here now, over the same
 *     scoped score list its siblings use, so a partner token learns mean
 *     confidence only over scores it can see.
 */

import { calibrationReport } from '../analytics.js'
import { counts, operationalSummary } from '../operations.js'
import { collectionPage, filterRecords } from '../utils.js'

/**
 * The merged event list. One expression, because the two routes that publish it
 * must agree on what an event is — `/api/v1/events` returns it directly and
 * `/api/v1/assessments` returns it as `recent_events`.
 */
export function recentEvents(data) {
  return [...data.hazard_events, ...data.conflict_events]
}

/**
 * Which events-family route a request is, or null.
 *
 * Both are reads, so the matcher refuses everything but GET — the VER-14 class,
 * applied at the point of extraction rather than found by the next sweep.
 * `check-openapi.mjs` reads this body, so the paths are discoverable without a
 * second list.
 */
export function matchEventsRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/events') return { kind: 'events' }
  if (pathname === '/api/v1/assessments') return { kind: 'assessments' }
  return null
}

/** Handle one events-family route. Returns true when it handled the request. */
export function handleEventsRoute(route, { data, req, res, url, jsonResponse }) {
  const scope = { auth: req.__auth, data }

  if (route.kind === 'events') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(recentEvents(data), url.searchParams, { ...scope, collection: 'incidents' }),
    })
    return true
  }

  if (route.kind === 'assessments') {
    const paged = (records, collection) => filterRecords(records, url.searchParams, { ...scope, collection })
    jsonResponse(res, 200, {
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        counts: counts(data),
        flood_risk: paged(data.risk_scores.filter((risk) => risk.type === 'flood_risk'), 'risk_scores'),
        climate_conflict_risk: paged(data.risk_scores.filter((risk) => risk.type === 'climate_conflict_risk'), 'risk_scores'),
        service_impacts: paged(data.impact_assessments, 'impact_assessments'),
        data_quality: paged(data.data_quality, 'data_quality'),
        operations: operationalSummary(data),
        alert_events: paged(data.alert_events, 'alert_events'),
        recent_events: paged(recentEvents(data), 'recent_events'),
        calibration: calibrationReport({ risk_scores: paged(data.risk_scores, 'risk_scores') }),
      },
    })
    return true
  }

  return false
}
