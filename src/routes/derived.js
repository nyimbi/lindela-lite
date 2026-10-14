/**
 * ARC-01 — the derived-collection reads, out of the god function.
 *
 * Six routes over the collections `refreshAnalytics` recomputes: source data
 * quality, the lineage rows, the operational roll-up, per-region calibration
 * trust, model drift, and — ENH-09 — whether two rainfall products tell the same
 * story. They are one family because they are all *derived* — no caller writes
 * them, an ingestion or refresh run does — and because three of them carry a
 * refusal that has to travel beside the figure rather than replace
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
 * All six are reads, so the matcher takes the method and refuses everything
 * but GET — the VER-14 class, applied at the point of extraction rather than
 * found by the next sweep.
 */

import { explainRanking } from '../../public/shared/rank-explain.js'
import { dataGaps } from '../data-gaps.js'
import { operationalSummary } from '../operations.js'
import { qualityTally } from '../quality.js'
import { sourceAgreement } from '../source-agreement.js'
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
  // ENH-44. The submission-quality roll-up. A derived read like the rest: the
  // verdict is stamped on each field report at write time and this only counts
  // what is there.
  if (pathname === '/api/v1/field-reports/quality') return { kind: 'field-report-quality' }
  // ENH-09. Do two independent rainfall products tell the same story? A derived
  // read like the rest: nothing writes it, and the verdict is computed from the
  // observations an ingestion run already stored.
  if (pathname === '/api/v1/source-agreement') return { kind: 'source-agreement' }
  // ENH-54. Every gap the platform is honest about, ordered by what closing it
  // would buy. Derived over two other derived reads — the refused drift
  // verdicts and the freshness verdicts — so it reads `model_drift` and
  // `source_runs` rather than any ingested collection.
  if (pathname === '/api/v1/data-gaps') return { kind: 'data-gaps' }
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

  if (kind === 'field-report-quality') {
    // ENH-44. The roll-up a coordinator weights a queue by. Every field report
    // carries a `quality` verdict stamped at write time; this counts them. A
    // record written before the gate existed has no verdict, and it is counted
    // as `unassessable` rather than dropped — a store whose older half is
    // silently excluded from the tally would read as a healthier queue than it
    // is, which is the opposite of what this endpoint is for.
    const reports = (data.field_reports || []).filter((r) => !r.deleted_at)
    // A record with no verdict is folded in as `unassessable` rather than
    // dropped. Dropping it makes `total` disagree with `reports` — two numbers
    // in one payload counting different sets — and makes a store whose older
    // half predates the gate read as a healthier queue than it is.
    const tally = qualityTally(reports.map((r) => r.quality ?? {
      grade: 'unassessable',
      duplicates: [],
      reasons: ['this record was written before the quality gate existed, so nothing about it was measured'],
    }))
    jsonResponse(res, 200, {
      success: true,
      ...tally,
      // Named explicitly, because `unassessable` covers two different facts: a
      // verdict that measured nothing, and a record written before verdicts
      // existed. Only the first is a report about the field.
      pre_gate_records: reports.filter((r) => !r.quality).length,
      reports: reports.length,
    })
    return true
  }

  if (kind === 'source-agreement') {
    // ENH-09. Where two independent products disagree, the disagreement *is*
    // the finding — it is evidence about how much to trust the number that
    // feeds a score, and it is honest in a way that raising confidence is not.
    //
    // What this route does not do is pick a winner. Between a satellite blend
    // and a reanalysis that is a separate judgement with its own error modes,
    // and the spec declines it in as many words: "Disagreement is the finding;
    // picking a winner is a separate judgement." `disputed` is therefore a
    // state a year carries and a consumer passes through, never an average.
    //
    // `refused` travels beside the report for the reason `calibration/by-region`
    // counts its refusals: a region with one product present has an empty
    // comparison list, and an empty list with no count reads as "these products
    // agree" when it means "there was nothing to compare".
    jsonResponse(res, 200, { success: true, ...sourceAgreement(data) })
    return true
  }

  if (kind === 'data-gaps') {
    // ENH-54. The refusals this platform already publishes, ordered by what
    // closing each would buy. `model-drift` reports seven regions refused with
    // a reason and `ingest/status` reports feeds that are not arriving; both
    // are honest and neither is a priority. This is the ordering.
    //
    // `refused` travels beside the ranking for the same reason it does on the
    // three routes above: a gap whose threshold cannot be grounded is refused
    // rather than ranked at zero, and a payload showing only the ranked rows
    // would render "we could not price this" as "this is worth nothing".
    //
    // The loss weights are not supplied, and that is deliberate rather than an
    // omission: this route is a GET with no body, and it holds no population or
    // funding envelope to weight by. So every gap is worth the same per unit of
    // decision error and the ranking follows the gap's geometry against its
    // threshold alone. A caller with a real cost calls `dataGaps(data, {
    // lossByRegion, lossBySource })` directly rather than through this route.
    jsonResponse(res, 200, { success: true, ...dataGaps(data) })
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
