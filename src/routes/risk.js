/**
 * ENH-60 — the hazard-risk family, out of the dispatcher.
 *
 * Nine routes over `risk_scores` and `flood_probability_models`. They are one
 * family because every one of them answers a question about a *hazard* the
 * platform has scored or fitted, and because they share a defect shape that is
 * worth holding in one place: each publishes a number that looks more
 * authoritative than it is, and each has to carry the qualification beside the
 * figure rather than in a footnote.
 *
 *   - `flood-risk` and `conflict-risk` are ordered by `score`, a weighted index
 *     and not a probability. A reader who assumes otherwise reads a ranking as a
 *     forecast, so `explainRanking` travels with the payload.
 *   - `compound-risk` is the joint score, served *beside* the two marginals
 *     rather than replacing them. A region whose record is too thin answers
 *     `score: null` with a refusal, not with a number.
 *   - `flood-probability/score` returns a point estimate from a fitted logistic
 *     model, and the contingency rows it was fit to — each with a Wilson
 *     interval and the month count it rests on — travel in `uncertainty`. A
 *     caller reading only `probability` sees an authoritative-looking figure
 *     with no idea it may rest on four events.
 *   - `flood-probability/train` never reaches the network. A district that
 *     cannot support a fit lands in `refusals` with the reason rather than as a
 *     model with no sample.
 *
 * ## The two refusals that are answers
 *
 * `flood-probability/score` with no region and more than one trained model is a
 * **400**, not a guess: the old behaviour took `models[0]`, whichever district
 * trained most recently, so a caller who omitted the parameter got an
 * authoritative-looking number about a district they never asked about. With no
 * model at all it is a **200** with `scored: false` and a refusal naming the
 * route to call first — an absent model is an answer, and a 500 would report a
 * missing fit as a server fault.
 */

import { explainRanking } from '../../public/shared/rank-explain.js'
import { predict, trainDistrictModels } from '../flood-probability.js'
import { collectionPage, readRequestJson } from '../utils.js'

/**
 * Which hazard-risk route a request is, or null.
 *
 * Method-aware: the reads are GET and the two that compute are POST, and a
 * blanket guard would close one half or the other. `check-openapi.mjs` reads
 * this body, so the paths are discoverable without a second list.
 */
export function matchRiskRoute(pathname, method = 'GET') {
  if (method === 'GET') {
    if (pathname === '/api/v1/flood-risk') return { kind: 'flood-risk' }
    if (pathname === '/api/v1/conflict-risk') return { kind: 'conflict-risk' }
    if (pathname === '/api/v1/compound-risk') return { kind: 'compound-risk' }
    if (pathname === '/api/v1/flood-probability/models') return { kind: 'probability-models' }
    if (pathname === '/api/v1/flood-probability/score') return { kind: 'probability-score' }
    return null
  }
  if (method === 'POST') {
    if (pathname === '/api/v1/flood-probability/train') return { kind: 'probability-train' }
    return null
  }
  return null
}

/**
 * The trained model's contingency rows, keyed by the feature they describe.
 *
 * `contingency()` returns a flat array; a caller asking about `max_7_day` has no
 * reason to know that, and picking the first row would hand them the interval
 * for a different statistic than the one they supplied.
 */
export function contingencyByFeature(rows) {
  if (!Array.isArray(rows)) return {}
  const byFeature = {}
  for (const row of rows) {
    if (!row || typeof row.feature !== 'string') continue
    byFeature[row.feature] = {
      threshold_mm: row.threshold_mm,
      months_above_threshold: row.months_above_threshold,
      flood_months_above_threshold: row.flood_months_above_threshold,
      conditional_probability: row.conditional_probability,
      conditional_probability_wilson: row.conditional_probability_wilson,
      // ENH-20. A wider interval with no stated reason is a number nobody trusts
      // twice, so the design effect that produced it travels with it. Projecting
      // the interval without this is how a corrected number would arrive looking
      // like the uncorrected one.
      clustering: row.clustering,
      lift_over_base_rate: row.lift_over_base_rate,
    }
  }
  return byFeature
}

/** The `risk_scores` rows of one type, paged, with the ordering explained. */
function riskRanking(data, url, auth, type) {
  return {
    success: true,
    ranking: explainRanking('risk-scores'),
    ...collectionPage((data.risk_scores || []).filter((risk) => risk.type === type), url.searchParams, {
      auth, data, collection: 'risk_scores',
    }),
  }
}

/**
 * Handle one hazard-risk route. Returns true when it handled the request.
 */
export async function handleRiskRoute(route, { store, data, req, res, url, jsonResponse }) {
  const { kind } = route
  const auth = req.__auth

  if (kind === 'flood-risk' || kind === 'conflict-risk' || kind === 'compound-risk') {
    // ENH-56 for the third: the joint score is served beside the two marginals
    // rather than replacing them, so a caller can see which marginal drove it.
    const type = {
      'flood-risk': 'flood_risk',
      'conflict-risk': 'climate_conflict_risk',
      'compound-risk': 'compound_hazard_risk',
    }[kind]
    jsonResponse(res, 200, riskRanking(data, url, auth, type))
    return true
  }

  if (kind === 'probability-models') {
    jsonResponse(res, 200, {
      success: true,
      ...collectionPage(data.flood_probability_models || [], url.searchParams, {
        auth, data, collection: 'flood_probability_models',
      }),
    })
    return true
  }

  if (kind === 'probability-train') {
    // Training is pure compute over the store: open_meteo_archive rainfall
    // series, plus either GDACS flood events (default label) or an
    // open_meteo_flood discharge series (`label_source: 'glofas_discharge'`)
    // already held. It writes trained models into flood_probability_models and
    // never reaches the network. A district that cannot support a fit lands in
    // `refusals` with the reason, not as a model with no sample.
    const body = await readRequestJson(req)
    const { trained, refusals } = trainDistrictModels(data, body || {})
    if (trained.length) await store.merge({ flood_probability_models: trained })
    jsonResponse(res, 200, { success: true, data: trained, refusals })
    return true
  }

  if (kind === 'probability-score') {
    // A query param that is absent must not become `Number(null) = 0` mm — one
    // missing statistic would otherwise score against feature zeros that were
    // never given. Absent or empty is unreadable and refused.
    const featureValue = (name) => {
      const raw = url.searchParams.get(name)
      return raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
    }
    const features = {
      max_7_day: featureValue('max_7_day'),
      sum_30_day: featureValue('sum_30_day'),
      sum_90_day: featureValue('sum_90_day'),
    }
    const missing = Object.entries(features).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)
    if (missing.length) {
      jsonResponse(res, 400, { success: false, error: `missing or non-numeric rainfall features: ${missing.join(', ')}` })
      return true
    }
    const region = url.searchParams.get('region')
    const models = (data.flood_probability_models || [])
      .filter((m) => m.model)
      .sort((a, b) => Date.parse(b.trained_at) - Date.parse(a.trained_at))

    // With no region named, a single trained model is unambiguous and safe to
    // use. More than one is not: the old behaviour took `models[0]`, which is
    // whichever district happened to train most recently, so a caller who
    // omitted the parameter got an authoritative-looking number about a
    // district they never asked about. Ask which one instead.
    if (!region && models.length > 1) {
      jsonResponse(res, 400, {
        success: false,
        error: 'region is required: more than one flood-probability model is trained, and scoring against whichever trained most recently would answer a question nobody asked',
        available_regions: models.map((m) => m.region_name),
      })
      return true
    }

    const latest = region
      ? models.find((m) => String(m.region_name).toUpperCase() === region.toUpperCase())
      : models[0]
    if (!latest || !latest.model) {
      // An absent model is an answer, not a 500: the refusal says what is
      // missing, exactly as the training endpoint would have reported it.
      jsonResponse(res, 200, {
        success: true,
        scored: false,
        refusal: region
          ? `no trained flood-probability model for ${region}; POST /api/v1/flood-probability/train first`
          : 'no trained flood-probability model in the store; POST /api/v1/flood-probability/train first',
        basis: latest?.basis || null,
      })
      return true
    }
    const probability = predict(latest.model, features)
    if (probability === null) {
      jsonResponse(res, 200, { success: true, scored: false, refusal: 'cannot score: non-finite feature after standardization' })
      return true
    }
    jsonResponse(res, 200, {
      success: true,
      scored: true,
      data: {
        region_name: latest.region_name,
        probability,
        features,
        trained_at: latest.trained_at,
        model: latest.model,
        folds: latest.folds,
        // The uncertainty behind this number, which used to stay on the server.
        // `probability` is a point estimate from the fitted logistic model; the
        // contingency rows are the empirical rainfall-flood co-occurrence
        // counts it was fit to, each with a Wilson interval and the number of
        // months the count rests on. A caller reading only `probability` sees
        // an authoritative-looking figure with no idea that it may rest on four
        // events.
        uncertainty: {
          note: 'conditional_probability and its Wilson interval are the empirical co-occurrence count at each feature threshold, not a confidence interval on the fitted point estimate. Read months_above_threshold before quoting the probability.',
          by_feature: contingencyByFeature(latest.contingency),
        },
        basis: latest.basis,
        label_source: latest.label_source,
        months_kept: latest.months_kept,
        events_matched: latest.events_matched,
        // ENH-49. `events_matched` reads as "this many events informed the fit"
        // and only some of them did: an admitted event whose month the rainfall
        // series could not sample is counted here and contributes nothing to
        // the contingency table. The pair below is the monitor — a client that
        // quotes the probability reads `label_coverage` beside it, and a
        // coverage that falls is the VER-03 class failing visibly rather than
        // an audit finding six months later.
        events_unlabelled: latest.events_unlabelled ?? null,
        label_coverage: latest.label_coverage ?? null,
        metadata: latest.metadata,
      },
    })
    return true
  }

  return false
}
