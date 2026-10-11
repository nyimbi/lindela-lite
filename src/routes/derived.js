/**
 * ARC-01 — the derived-collection reads, out of the god function.
 *
 * Five routes over the collections `refreshAnalytics` recomputes: source data
 * quality, the lineage rows, the operational roll-up, per-region calibration
 * trust and model drift. They are one family because they are all *derived* —
 * no caller writes them, an ingestion or refresh run does — and because three of
 * them carry a refusal that has to travel beside the figure rather than replace
 * it.
 *
 * That is the property the family exists to hold, and it is the same mistake
 * three times over:
 *
 *   - `data-quality` publishes a `ranking` whose confidence is a *completeness
 *     heuristic*, not an accuracy measurement, and says so in the payload so a
 *     reader is not left to infer the second from the field's name.
 *   - `calibration/by-region` reports `refused` beside the scores, because a
 *     region with too little evidence has `trust: null` and a reason, and the
 *     count of those is as much of the answer as the scores are.
 *   - `model-drift` reports `regions` and a `verdicts` tally, so a store whose
 *     features all came back `not_measurable` cannot read as a clean bill of
 *     health from a bare empty `data` array.
 *
 * All five are reads, so the matcher takes the method and refuses everything
 * but GET — the VER-14 class, applied at the point of extraction rather than
 * found by the next sweep.
 */

import { explainRanking } from '../../public/shared/rank-explain.js'
import { operationalSummary } from '../operations.js'
import { collectionPage } from '../utils.js'

/**
 * Which derived-collection route a request is, or null.
 *
 * Method-aware: these are all reads, and the whole family answered a `DELETE`
 * with a 200 before VER-14 was swept.
 */
export function matchDerivedRoute(pathname, method = 'GET') {
  if (method !== 'GET') return null
  if (pathname === '/api/v1/data-quality') return { kind: 'data-quality' }
  if (pathname === '/api/v1/data-lineage') return { kind: 'data-lineage' }
  if (pathname === '/api/v1/operations/summary') return { kind: 'operations-summary' }
  if (pathname === '/api/v1/calibration/by-region') return { kind: 'calibration-by-region' }
  if (pathname === '/api/v1/model-drift') return { kind: 'model-drift' }
  return null
}

/**
 * Handle one derived-collection route. Returns true when it handled the request.
 */
export async function handleDerivedRoute(route, { data, req, res, url, jsonResponse }) {
  const { kind } = route
  const auth = req.__auth

  if (kind === 'data-quality') {
    // ENH-72. The ordering is confidence descending, and the confidence is a
    // completeness heuristic rather than an accuracy measurement — both facts
    // travel with the payload so a reader is not left to infer the second from
    // the field's name.
    const ranking = explainRanking('data-quality', { entries: data.data_quality })
    jsonResponse(res, 200, { success: true, ranking, ...collectionPage(data.data_quality, url.searchParams, { auth, data, collection: 'data_quality' }) })
    return true
  }

  if (kind === 'data-lineage') {
    jsonResponse(res, 200, { success: true, ...collectionPage(data.data_lineage || [], url.searchParams, { auth, data, collection: 'data_lineage' }) })
    return true
  }

  if (kind === 'operations-summary') {
    jsonResponse(res, 200, { success: true, data: operationalSummary(data) })
    return true
  }

  if (kind === 'calibration-by-region') {
    // Calibration and drift are stored on every refresh, so they are read like
    // any other derived collection. Both refuse on thin evidence and say why;
    // the refusal travels with the row rather than becoming an empty list.
    const rows = data.region_trust || []
    const region = url.searchParams.get('region')
    const selected = region ? rows.filter((r) => r.region_name === region) : rows
    jsonResponse(res, 200, {
      success: true,
      regions: rows.length,
      returned: selected.length,
      // A region with too little evidence has `trust` null and a reason. The
      // count of refusals is as much of the answer as the scores.
      //
      // `regions` is the whole store and `returned` is what the filter kept, so
      // a `?region=` that matches nothing answers `returned: 0` beside
      // `regions: N` rather than an empty list that reads as "no regions".
      refused: selected.filter((r) => r.trust === null || r.trust === undefined).length,
      data: selected,
    })
    return true
  }

  if (kind === 'model-drift') {
    const rows = data.model_drift || []
    jsonResponse(res, 200, {
      success: true,
      regions: rows.length,
      verdicts: rows.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] || 0) + 1
        return acc
      }, {}),
      data: rows,
    })
    return true
  }

  return false
}
