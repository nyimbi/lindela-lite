import { haversineKm } from './utils.js'
import { stableId } from './utils.js'
import { DEFAULT_REGIONS } from './schema.js'

/**
 * Rainfall-to-flood probability, on an agreed empirical basis.
 *
 * The basis, agreed with the operator on 2026-10-02, replaces the MERIT-Hydro/
 * GEV scheme that was proposed and is not implementable here: MERIT Hydro is
 * unreachable and licence-gated, and the pilot basins have no 36-year
 * validated gauge-discharge record to fit annual maxima against. What *is*
 * available, verified keyless, is decades of both halves of the pairing:
 *
 * - rainfall: ERA5 reanalysis daily precipitation from the Open-Meteo archive
 *   (1981 onward) at each district's reference point;
 * - floods: GDACS historical flood events from the archive search API (1985
 *   onward), matched to a district by radius of the event's representative
 *   point.
 *
 * The model is therefore **empirical and local, not hydrological**:
 *
 *   P( a reported flood in the district within <label window> of month end
 *      | that month's rainfall intensity/duration statistics exceed
 *        training-set thresholds )
 *
 * reported two ways, both required:
 *
 * 1. **Contingency counts** — the primary, transparent form:
 *    P = flood months / all months above a threshold, with raw counts and a
 *    Wilson interval. No coefficient anywhere; a reader can check the
 *    arithmetic from the counts alone.
 * 2. **Fitted logistic regression** with L2 regularisation, coefficients and
 *    leave-one-year-out skill scores shown. Fitted coefficients are measured
 *    on the stated sample — that is the difference between invented numbers,
 *    which have no sample, and fitted ones, which have sample sizes, scores,
 *    and a defined failure mode (insufficient data → no model).
 *
 * Hard refusals are part of the model: fewer than MIN_MONTHS samples, fewer
 * than MIN_EVENTS events, or all-one-class data and the functions return no
 * probability at all rather than a number with no footing. Coefficients that
 * look authoritative without a sample are the specific failure this gate
 * exists to prevent.
 *
 * What the label honestly means: the events are *GDACS-reported* floods. The
 * probability is for a flood entering the archive, which tracks reporting
 * coverage, not the physical event rate. Every scored record carries that.
 */

export const MIN_MONTHS = 60
export const MIN_EVENTS = 5
export const MATCH_RADIUS_KM = 150
export const MIN_COVERAGE = 0.9

export const MODEL_BASIS = Object.freeze({
  basis: 'empirical rainfall-flood co-occurrence (contingency counts + regularised logistic fit)',
  rainfall_source: 'ERA5 reanalysis daily precipitation via Open-Meteo archive (1981 onwards), keyless',
  flood_source: 'GDACS historical flood events via the archive search API, keyless',
  label_definition: 'a GDACS-reported flood within MATCH_RADIUS_KM of the district point, starting within the same calendar month',
  features: {
    max_7_day: 'largest 7-day precipitation total inside the month (intensity x short duration)',
    sum_30_day: 'trailing 30-day total at month end (saturated-catchment proxy)',
    sum_90_day: 'trailing 90-day total at month end (antecedent wetness)',
  },
  rejection_reasons: 'MERIT Hydro (unreachable, EULA-gated) and gauge-based GEV annual maxima (no validated 36-year discharge record for the pilot basins) — see docs/flood-probability-model-basis.md',
  what_a_probability_is_not: 'reporting-conditioned: P(flood enters the GDACS archive), not P(water reaches a given ground elevation)',
})

/**
 * Rolling-window statistics for every month in the series, plus flood labels.
 * A month participates only if its 90-day trailing window is at least
 * 90% populated — a wet-season number computed on a third of its days is not
 * a statistic, it is noise wearing one.
 */
export function buildDistrictSamples(daily, floodEvents, district, options = {}) {
  const radiusKm = options.matchRadiusKm || MATCH_RADIUS_KM
  const minCoverage = options.minCoverage || MIN_COVERAGE
  const series = normalizeDaily(daily)
  if (series.length < 120) return { samples: [], months_skipped: series.length, skipped_reason: 'series shorter than ~4 months of daily data' }

  // Pre-filter events once: in radius and before series end.
  const events = (floodEvents || []).filter((event) => {
    const t = Date.parse(event.occurred_at || event.from || '')
    if (!Number.isFinite(t)) return false
    if (district.latitude != null && district.longitude != null &&
        Number.isFinite(event.latitude) && Number.isFinite(event.longitude)) {
      return haversineKm({ latitude: district.latitude, longitude: district.longitude },
        event) <= radiusKm
    }
    return String(event.country).toUpperCase() === String(district.country).toUpperCase()
  })

  const byMonth = groupByMonth(series)
  const indexByDate = new Map(series.map((d, i) => [d.date, i]))
  const samples = []
  for (const month of byMonth) {
    const stats = monthStats(month, series, minCoverage, indexByDate)
    if (!stats) continue
    const label = monthHasFlood(month, events)
    samples.push({ ...stats, label })
  }
  return { samples, events_matched: events.length, months_kept: samples.length }
}

function normalizeDaily(daily) {
  return (daily || [])
    .map((d) => ({ date: String(d.date).slice(0, 10), mm: d.precipitation_mm === null || d.precipitation_mm === undefined ? null : Number(d.precipitation_mm) }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

function groupByMonth(series) {
  const months = new Map()
  for (const d of series) {
    const key = d.date.slice(0, 7)
    if (!months.has(key)) months.set(key, [])
    months.get(key).push(d)
  }
  return [...months.keys()].sort().map((key) => ({ key, days: months.get(key) }))
}

/**
 * Trailing-window features at month end, computed over the whole series so
 * sums crossing month boundaries stay correct. max_7_day is the largest
 * rolling 7-day total *within* this month. Returns null when the trailing
 * 90-day window is too sparsely reported or reaches past the series start.
 */
function monthStats(month, series, minCoverage, indexByDate) {
  const monthEnd = month.days[month.days.length - 1]
  const endIndex = indexByDate.get(monthEnd.date)
  if (endIndex < 89) return null
  const trail = series.slice(endIndex - 89, endIndex + 1)
  const present = trail.filter((d) => d.mm !== null)
  if (present.length < 90 * minCoverage) return null
  // Gaps are skipped, not zero-filled: a sum over present days underestimates
  // slightly, and a flagged low coverage beats an invented interpolation.
  const sum = (days) => days.reduce((acc, d) => acc + (d.mm || 0), 0)
  const sum30 = sum(series.slice(endIndex - 29, endIndex + 1))
  const sum90 = sum(trail)
  let max7 = 0
  for (const d of month.days) {
    const idx = indexByDate.get(d.date)
    if (idx < 6) continue
    // max_7_day should reflect this month's own wettest 7 days, computed on
    // the full series around it so boundary overlaps count once.
    const week = series.slice(idx - 6, idx + 1)
    if (week.some((x) => x.mm === null)) continue
    const total = sum(week)
    if (total > max7) max7 = total
  }
  return {
    month: month.key,
    max_7_day: Math.round(max7 * 10) / 10,
    sum_30_day: Math.round(sum30 * 10) / 10,
    sum_90_day: Math.round(sum90 * 10) / 10,
  }
}

/**
 * A flood starting within the same calendar month credits that month. The
 * month is the grain, and features (trailing sums, in-month max 7-day) are
 * computed at month end — so a mid-month flood's own rains are inside its
 * features, which is the point of the design. Two documented residuals:
 * an event's reported start may postdate the rains that caused it (GDACS
 * reporting delay) or land within days of a boundary; both are attribution
 * noise at month grain, not something a lag window fixes without
 * double-counting neighbouring months.
 */
function monthHasFlood(month, events) {
  const monthStart = Date.parse(`${month.key}-01T00:00:00.000Z`)
  const monthEnd = month.days[month.days.length - 1]
  const last = Date.parse(`${monthEnd.date}T23:59:59.999Z`)
  return events.some((event) => {
    const t = Date.parse(event.occurred_at)
    return t >= monthStart && t <= last
  })
}

/**
 * Empirical contingency at a percentile threshold of the training
 * distribution. Nothing is smoothed or fitted: counts in, counts out.
 */
export function contingencyCount(samples, feature, percentile) {
  const values = samples.map((s) => s[feature]).filter(Number.isFinite).sort((a, b) => a - b)
  if (values.length < 10) {
    return { counts: null, reason: `fewer than 10 months with a finite ${feature}` }
  }
  const threshold = quantile(values, percentile)
  const above = samples.filter((s) => s[feature] > threshold)
  const positives = above.filter((s) => s.label).length
  const wilson = wilsonInterval(positives, above.length)
  return {
    counts: {
      feature,
      percentile,
      threshold_mm: round1(threshold),
      months_above_threshold: above.length,
      flood_months_above_threshold: positives,
      flood_months_below_threshold: samples.filter((s) => s[feature] <= threshold && s.label).length,
      conditional_probability: round4(positives / Math.max(1, above.length)),
      conditional_probability_wilson: wilson,
      lift_over_base_rate: baseRate(samples) > 0 ? round4(positives / above.length / baseRate(samples)) : null,
    },
  }
}

export function contingency(samples, thresholds) {
  const perFeature = []
  for (const [feature, percentile] of Object.entries(thresholds || { max_7_day: 0.9, sum_30_day: 0.9, sum_90_day: 0.9 })) {
    const result = contingencyCount(samples, feature, percentile)
    if (result.counts) perFeature.push(result.counts)
  }
  return perFeature
}

function round1(x) { return Math.round(x * 10) / 10 }
function round4(x) { return Math.round(x * 10000) / 10000 }

function baseRate(samples) {
  const events = samples.filter((s) => s.label).length
  return samples.length ? events / samples.length : 0
}

/** Wilson score interval at 95%: a count-based probability must carry its uncertainty. */
export function wilsonInterval(hits, total) {
  if (!total) return null
  const z = 1.96
  const p = hits / total
  const denom = 1 + z * z / total
  const centre = (p + z * z / (2 * total)) / denom
  const spread = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
  return { low: round4(Math.max(0, centre - spread)), high: round4(Math.min(1, centre + spread)) }
}

/**
 * Logistic regression, L2-regularised, Newton iterations on standardized
 * features. Plain JS on purpose: a two-parameter-per-feature model does not
 * need a tensor library, and every operation here is inspectable in review.
 * Returns null instead of a fit when the data cannot support one — that null
 * is the refusal the basis document promises.
 * Coefficients are per standardized feature unit; scaling is stored so
 * scoring applies the same transform.
 */
export function fitLogisticRegression(samples, options = {}) {
  const lambda = options.lambda ?? 1.0
  const iterations = options.iterations ?? 40
  if (samples.length < MIN_MONTHS) {
    return { model: null, refusal: `only ${samples.length} of the required ${MIN_MONTHS} months available` }
  }
  const positives = samples.filter((s) => s.label).length
  if (positives < MIN_EVENTS) {
    return { model: null, refusal: `only ${positives} flood-label months of the required ${MIN_EVENTS}` }
  }
  if (positives === samples.length) {
    return { model: null, refusal: 'every month in the sample is labelled a flood; no contrast to fit' }
  }
  const FEATURES = ['max_7_day', 'sum_30_day', 'sum_90_day']
  const standardization = FEATURES.map((f) => {
    const vals = samples.map((s) => s[f]).filter(Number.isFinite)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1)) || 1
    return { feature: f, mean, sd }
  })
  const xs = samples.map((s) => standardization.map((st) => (s[st.feature] - st.mean) / st.sd))
  const ys = samples.map((s) => (s.label ? 1 : 0))

  // Full-matrix Newton (4x4 including the intercept) — a diagonal Hessian
  // approximation diverges on collinear standardized features, and rainfall
  // features are exactly that: a wet month is simultaneously high on every
  // accumulation statistic. Safeguarded by step-halving on penalized
  // log-likelihood, so a bad step cannot destroy the fit.
  const D = xs[0].length + 1
  let theta = new Array(D).fill(0)
  // Parameter layout: [beta1..betak, intercept], x rows extended with 1.
  const X = xs.map((row) => [...row, 1])
  const penLogLik = (t) => {
    let ll = 0
    for (let i = 0; i < X.length; i += 1) {
      const p = 1 / (1 + Math.exp(-(t.reduce((a, v, j) => a + v * X[i][j], 0))))
      ll += ys[i] * Math.log(Math.max(p, 1e-12)) + (1 - ys[i]) * Math.log(Math.max(1 - p, 1e-12))
    }
    for (let j = 0; j < t.length; j += 1) ll -= lambda / 2 * t[j] * t[j]
    return ll
  }
  let current = penLogLik(theta)
  for (let it = 0; it < iterations; it += 1) {
    const grad = new Array(D).fill(0)
    const H = Array.from({ length: D }, () => new Array(D).fill(0))
    for (let i = 0; i < X.length; i += 1) {
      let z = 0
      for (let j = 0; j < D; j += 1) z += theta[j] * X[i][j]
      const p = 1 / (1 + Math.exp(-z))
      const w = p * (1 - p)
      for (let j = 0; j < D; j += 1) {
        grad[j] += (ys[i] - p) * X[i][j]
        for (let k = 0; k <= j; k += 1) H[j][k] += w * X[i][j] * X[i][k]
      }
    }
    for (let j = 0; j < D; j += 1) {
      for (let k = 0; k < j; k += 1) H[k][j] = H[j][k]
      grad[j] -= lambda * theta[j]
      H[j][j] += lambda
    }
    const step = solveSymmetric(H, grad)
    if (!step) return { model: null, refusal: 'Hessian not solvable during fitting' }
    // Backtracking: take the full step only if the objective rises.
    let scale = 1
    let next = penLogLik(stepAdd(theta, step, scale))
    let tries = 0
    while (!Number.isFinite(next) || next < current - 1e-9) {
      scale /= 2
      tries += 1
      if (tries > 30) break
      next = penLogLik(stepAdd(theta, step, scale))
    }
    const nextTheta = stepAdd(theta, step, scale)
    const move = nextTheta.reduce((a, v, j) => Math.max(a, Math.abs(v - theta[j])), 0)
    if (Number.isFinite(next) && next >= current - 1e-9) {
      theta = nextTheta
      current = Math.max(current, next)
    }
    if (move < 1e-8 && it > 1) break
  }
  const betaVals = theta.slice(0, D - 1)
  const intercept = theta[D - 1]

  return {
    model: {
      type: 'logistic_l2_empirical',
      features: FEATURES,
      coefficients: betaVals.map((b, i) => ({ feature: FEATURES[i], value: round4(b) })),
      intercept: round4(intercept),
      standardization,
      lambda,
      training: trainingFacts(samples),
    },
  }
}

function stepAdd(theta, step, scale) {
  return theta.map((v, j) => v + scale * step[j])
}

/**
 * Solves Hx = g for symmetric positive-definite H by Gaussian elimination
 * with partial pivoting — the Hessian of a convex penalized log-likelihood
 * is at least positive semi-definite, and the L2 term makes it strictly
 * positive definite, but exact solves still need the elimination to be real.
 */
function solveSymmetric(H, g) {
  const n = g.length
  const a = H.map((row) => [...row, 0])
  for (let i = 0; i < n; i += 1) a[i][n] = g[i]
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]]
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const f = a[r][col] / a[col][col]
      if (!f) continue
      for (let c = col; c <= n; c += 1) a[r][c] -= f * a[col][c]
    }
  }
  return a.map((row, i) => row[n] / row[i])
}

function trainingFacts(samples) {
  return {
    months: samples.length,
    flood_months: samples.filter((s) => s.label).length,
    base_rate: round4(baseRate(samples)),
  }
}

/**
 * Leave-one-year-out validation: fit on all years except one, score that one.
 * Brier + how much better than always predicting the training base rate.
 * Refuses (null scores) when a fold would be empty — skill numbers computed
 * on a fold of three months say nothing.
 */
export function leaveOneYearOut(samples, options = {}) {
  const years = [...new Set(samples.map((s) => s.month.slice(0, 4)))].sort()
  if (years.length < 3) {
    return { folds: null, refusal: `need at least 3 calendar years to validate, have ${years.length}` }
  }
  const scores = []
  for (const year of years) {
    const train = samples.filter((s) => s.month.slice(0, 4) !== year)
    const test = samples.filter((s) => s.month.slice(0, 4) === year)
    const { model } = fitLogisticRegression(train, options)
    if (!model) continue
    for (const s of test) {
      const p = predict(model, s)
      scores.push({ year, p, y: s.label ? 1 : 0 })
    }
  }
  if (scores.length < MIN_MONTHS) {
    return { folds: null, refusal: `only ${scores.length} validated months; no skill number is reportable` }
  }
  const brier = scores.reduce((a, s) => a + (s.p - s.y) ** 2, 0) / scores.length
  const base = scores.reduce((a, s) => a + s.y, 0) / scores.length
  return {
    folds: {
      brier_score: round4(brier),
      brier_of_base_rate: round4(base * (1 - base)),
      skill_over_base_rate: round4(1 - brier / (base * (1 - base))),
      validated_months: scores.length,
      n_folds: new Set(scores.map((s) => s.year)).size,
    },
  }
}

export function predict(model, features) {
  let z = model.intercept
  for (const st of model.standardization) {
    const value = features[st.feature]
    if (!Number.isFinite(value)) return null
    z += model.coefficients.find((c) => c.feature === st.feature)?.value * ((value - st.mean) / st.sd)
  }
  return round4(1 / (1 + Math.exp(-z)))
}

function quantile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[i]
}

/**
 * Train one model per pilot district from whatever the store currently holds.
 * The store is the evidence: climate_observations carrying an
 * open_meteo_archive daily series (the rainfall record) and hazard_events
 * from gdacs / gdacs_archive (the labels). Nothing here reaches the network.
 *
 * A district with no archive series is a refusal, not a model from the live
 * forecast — a 7-day forecast series cannot produce 60 months of statistics,
 * and pretending otherwise would be exactly the invented-footing failure this
 * module refuses.
 */
export function trainDistrictModels(data, options = {}) {
  const regions = options.regions?.length ? options.regions : DEFAULT_REGIONS
  const trained = []
  const refusals = []
  const floodEvents = (data.hazard_events || []).filter((e) => e.event_type === 'flood' || !e.event_type)

  for (const region of regions) {
    const wanted = String(region.name).toUpperCase()
    const seriesRecord = (data.climate_observations || [])
      .filter((r) => r.source === 'open_meteo_archive' && String(r.region_name).toUpperCase() === wanted)
      .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0]

    if (!seriesRecord || !Array.isArray(seriesRecord.daily)) {
      refusals.push({
        region: region.name,
        refusal: 'no open_meteo_archive daily series in the store; run the open_meteo_archive backfill ingestion first',
      })
      continue
    }

    const district = { latitude: seriesRecord.latitude ?? region.lat, longitude: seriesRecord.longitude ?? region.lon, country: countryFor(seriesRecord, region) }
    const { samples, events_matched, months_kept } = buildDistrictSamples(seriesRecord.daily, floodEvents, district)

    const fit = fitLogisticRegression(samples)
    const folds = leaveOneYearOut(samples)
    const counts = contingency(samples)

    if (!fit.model) {
      refusals.push({ region: region.name, refusal: fit.refusal, months_kept, events_matched })
      continue
    }

    trained.push({
      id: stableId('floodmodel', [region.name, seriesRecord.id]),
      region_name: region.name,
      country: district.country,
      latitude: district.latitude,
      longitude: district.longitude,
      source: 'flood_probability_train',
      trained_at: new Date().toISOString(),
      model: fit.model,
      folds,
      contingency: counts,
      basis: MODEL_BASIS,
      months_kept,
      events_matched,
      rainfall: {
        record_id: seriesRecord.id,
        series_start: seriesRecord.series_start,
        series_end: seriesRecord.series_end,
        series_days: seriesRecord.series_days,
        days_missing_precipitation: seriesRecord.days_missing_precipitation,
        provider: seriesRecord.metadata?.provider || 'Open-Meteo archive (ERA5 reanalysis)',
      },
      metadata: {
        model_limit: MODEL_BASIS.what_a_probability_is_not,
        attribution: `${MODEL_BASIS.rainfall_source}; ${MODEL_BASIS.flood_source}`,
      },
    })
  }
  return { trained, refusals }
}

function countryFor(seriesRecord, region) {
  return seriesRecord.country || region.country
}