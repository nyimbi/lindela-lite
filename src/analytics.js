import fs from 'node:fs/promises'
import path from 'node:path'
import { riskLevel, severityWeight } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'
import { computePopulationAtRisk, computeFacilitiesAtRisk } from './analytics/impact.js'
import { computeRoadAccess } from './road-access.js'
import { logger } from './observability.js'
import { calibrationByRegion } from './calibration.js'
import { driftReport } from './drift.js'

/**
 * Honesty envelopes (ENH-02).
 *
 * Every number this module returns used to travel with either nothing or one
 * prose `limits` string, and prose is the one form a machine cannot check: an
 * integrator reading the payload never sees the sentence, and a dashboard can
 * drop it silently. The envelope makes the caveat part of the value — what the
 * number is, what it is not, what it was computed from, and what it refuses to
 * say — so the caveat survives the trip through a consumer that knows nothing
 * about this repository.
 *
 * The prose `limits` strings stay. The envelope is structure, not a replacement
 * for the sentence, and each envelope restates the sentence's claim in a field
 * a test can assert on.
 */

/**
 * The kinds this module emits, with the claim each one is not entitled to make.
 *
 * A kind with no entry here is refused rather than described: an envelope whose
 * `not` is missing states what a number is without stating what it is not,
 * which is the failure the envelope exists to prevent.
 */
export const ENVELOPE_KINDS = Object.freeze({
  flood_risk_score: 'a weighted severity index over forecast rainfall, rain probability and nearby hazard reports — not a probability of flooding',
  climate_conflict_risk_score: 'a weighted sum of input counts and severities — not a probability of conflict or of any climate-driven outcome',
  service_impact_score: 'a blend of the two nearest region risk scores — not a forecast of service interruption and not an estimate of people affected',
  data_quality_confidence: 'a completeness heuristic over geocoding, record count, run status and record age — not an accuracy measurement of the underlying data',
  calibration_summary: 'an average over stored risk-score records — not a validation of the model behind them',
  trust_score: 'a weighted composite of measured alert outcome agreement, outcome sample size and outcome recording coverage — not a statement that alerts will be correct',
  drift_verdict: 'a comparison of two windows of the same series — not a diagnosis of the cause of a change',
})

const BASIS_DOC = 'docs/flood-probability-model-basis.md'
const ENVELOPE_RETRIEVED_AT = () => new Date().toISOString()

/**
 * Build the envelope for one number.
 *
 * `basis` is the evidence the number was computed from; `refused` is what this
 * call declined to say and why. Both are structural, never prose: a refusal
 * that cannot be asserted on is a comment.
 *
 * Refuses — returns `value: null` and a reason rather than a number — when the
 * kind is unknown or the value is not finite. A NaN in an envelope is the same
 * defect as a NaN in the score, and JSON turns it into `null` on the way out
 * with nothing to mark it as a refusal.
 */
export function honestyEnvelope(kind, { value, basis = {}, refused = [], notIncluded = [], evidence = {} } = {}) {
  const claim = ENVELOPE_KINDS[kind]
  const reasons = [...refused]
  if (!claim) reasons.push(`unknown envelope kind "${kind}"; the envelope cannot state what a number of this kind is not`)
  if (value !== null && value !== undefined && !Number.isFinite(value)) reasons.push('value is not finite, so it is withheld rather than published as null')

  // Withheld unless the envelope can say both what the number is and what it is
  // not. A value travelling without the second half is the bare number this
  // envelope was added to stop.
  const publishable = Number.isFinite(value) && Boolean(claim)
  return {
    value: publishable ? value : null,
    limits: {
      kind: kind ?? null,
      not: claim ?? null,
      // Uniform on every record, and false: nothing in this module is
      // calibrated against observed outcomes except through src/calibration.js,
      // which says so on its own records.
      calibrated_uncertainty: false,
      sample: basis.sample ?? null,
    },
    evidence: {
      basis_doc: BASIS_DOC,
      basis: basis.description ?? null,
      source_ids: basis.source_ids ?? [],
      retrieved_at: evidence.retrieved_at ?? ENVELOPE_RETRIEVED_AT(),
    },
    not_included: notIncluded,
    refused: reasons,
  }
}

/**
 * Three tiers of uncertainty on one number (ENH-04), each named by what it
 * measures.
 *
 * The names are load-bearing. `confidence interval` is forbidden here because
 * it means something specific — a range over the posterior of the outcome — and
 * none of these three is that. A tier is either a measured spread with its
 * sample attached, or a refusal stating which tier is absent and why.
 *
 * - `model_parameter`: spread of the fitted coefficients across refits. Absent
 *   for any score that was never fitted, which is most of them.
 * - `sampling`: a Wilson interval on the contingency counts, reported with an
 *   effective n. The months are not independent — the trailing 90-day windows
 *   overlap, so consecutive months share most of their rainfall — and a Wilson
 *   interval computed on the raw count is narrower than the evidence supports.
 * - `coverage`: what the number does not represent, which is always present and
 *   never empty.
 */
export function uncertaintyTiers({ modelParameter = null, sampling = null, coverage = [] } = {}) {
  const tier = (measures, value, refusal) => (refusal
    ? { measures, refused: refusal }
    : { measures, ...value })
  return {
    model_parameter: tier(
      'dispersion of the fitted coefficients across refits of this model; absent for a score that is not a fitted model',
      modelParameter,
      modelParameter ? null : 'no fit underlies this number, so there is no parameter to be uncertain about',
    ),
    sampling: tier(
      'spread of the observed rate around its point estimate on the contingency counts, with an effective n corrected for serial correlation between months',
      sampling,
      sampling ? null : 'no contingency counts underlie this number, so there is no sample to put an interval around',
    ),
    coverage: {
      measures: 'the populations and effects this number does not represent',
      not_represented: Array.isArray(coverage) ? [...coverage] : [],
    },
  }
}

/**
 * Effective sample size for a monthly binary series.
 *
 * `n_eff = n * (1 - r1) / (1 + r1)` for lag-1 autocorrelation `r1`, the
 * standard correction for an AR(1) sample. The trailing 90-day rainfall
 * window makes consecutive months strongly positively correlated, so the raw
 * count is an overcount of independent evidence and an uncorrected interval
 * reads as tighter than the record is.
 *
 * Clamped at 3: below that the correction produces an interval too wide to be
 * read, which is a refusal wearing a number. Returns `null` for a series too
 * short or too constant to estimate `r1` from — a constant series has zero
 * variance and an undefined correlation, not a correlation of zero.
 */
export function effectiveSampleSize(labels) {
  const values = (labels || []).filter((v) => v === 0 || v === 1)
  const n = values.length
  if (n < 4) return null
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  if (!(variance > 0)) return null
  let cov = 0
  for (let i = 1; i < n; i += 1) cov += (values[i] - mean) * (values[i - 1] - mean)
  const r1 = cov / ((n - 1) * variance)
  const corrected = n * (1 - r1) / (1 + r1)
  if (!Number.isFinite(corrected)) return null
  return Math.max(3, Math.min(n, Math.round(corrected * 100) / 100))
}

/**
 * Build the per-region drift inputs `driftReport` expects.
 *
 * It takes an explicit list of regions, each with a reference window and a
 * current window. The split is chronological — the earlier half against the
 * later — because comparing a source against itself calls every input stable,
 * and a monitor that can never fire is a monitor that looks like good news.
 *
 * A region with fewer than four samples produces no windows at all and is left
 * out rather than half-filled: half a window is not a window.
 */
function driftFromStore(data) {
  const MIN_SAMPLES = 4
  const byRegion = new Map()

  for (const row of data.climate_observations || []) {
    // `precipitation_mm`, not `value` — reading a field nothing writes filters
    // every record out and the monitor reports no regions, which reads as
    // "nothing is drifting" rather than "nothing was measured".
    //
    // `Number.isFinite` and not truthiness, because 0 mm is a real measurement
    // and `if (!row.precipitation_mm)` drops every dry month. CHIRPS stores null
    // explicitly when it does not decode a raster, so null and 0 are different
    // facts and only one of them is absent.
    const measured = Number.isFinite(row?.precipitation_mm)
      ? row.precipitation_mm
      : Number.isFinite(row?.temperature_max_c) ? row.temperature_max_c : NaN
    if (!Number.isFinite(measured)) continue
    const region = row.region_name || row.country
    if (!region) continue
    if (!byRegion.has(region)) byRegion.set(region, [])
    byRegion.get(region).push({
      value: measured,
      at: row.observed_at || row.created_at || null,
    })
  }

  const regions = []
  for (const [region, samples] of byRegion) {
    if (samples.length < MIN_SAMPLES) continue
    // Undated samples keep their arrival order; a sort on a null date would
    // scatter them rather than order them.
    const ordered = [...samples].sort((a, b) => {
      const ta = a.at ? Date.parse(a.at) : NaN
      const tb = b.at ? Date.parse(b.at) : NaN
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
      if (Number.isNaN(ta)) return -1
      if (Number.isNaN(tb)) return 1
      return ta - tb
    })
    const half = Math.floor(ordered.length / 2)
    regions.push({
      region,
      referenceSamples: ordered.slice(0, half),
      currentSamples: ordered.slice(ordered.length - half),
    })
  }

  const report = driftReport({ regions })
  // The summary counts belong beside the records, not instead of them: a
  // consumer asking "is Turkana drifting" needs the row, and one asking "is
  // anything drifting" needs the count.
  return report.records.map((record) => ({ ...record, id: `drift_${record.region_name}`, type: 'model_drift', generated_at: report.generated_at }))
}

export async function refreshAnalytics(store) {
  const data = await store.read()
  const risk_scores = [
    ...computeFloodRisk(data),
    ...computeClimateConflictRisk(data),
  ]
  const impact_assessments = computeServiceImpacts(data, risk_scores)
  const data_quality = computeDataQuality(data)
  const population_at_risk = computePopulationAtRisk(data)
  const facilities_at_risk = computeFacilitiesAtRisk(data)
  const road_access = computeRoadAccess(data)
  // Calibration and drift are computed on every refresh and stored like the rest
  // of the derived set, so a region's stale trust score is replaced rather than
  // accumulating under evidence that has since moved.
  const region_trust = calibrationByRegion({ ...data, risk_scores })
  const model_drift = driftFromStore(data)
  // ENH-23. The counts a value was computed from travel *with the value*, so
  // the next refresh has two real sides to compare: the number that was stored
  // and the counts it was stored from. Without them the only available
  // comparison is a number against itself, which is a check that cannot fail.
  //
  // Stamped before the swap, so what the store held is what the comparison reads.
  for (const record of risk_scores) record.input_counts = inputDigestFor(placeOf(record), data)
  for (const record of impact_assessments) record.input_counts = inputDigestFor(placeOf(record), data)

  const previous = await readDerived(store, ['risk_scores', 'impact_assessments'])
  await store.replaceAnalytics({
    risk_scores, impact_assessments, data_quality,
    population_at_risk, facilities_at_risk, road_access,
    region_trust, model_drift,
  })
  const reconciliation = await reconcileDerivedNumbers(store, data, { previous, now: new Date().toISOString() })

  // Persist calibration snapshot (best-effort, don't fail refresh)
  if (process.env.LINDELA_LITE_CALIBRATION_DIR !== 'off' && process.env.NODE_ENV !== 'test') {
    try {
      const calibDir = path.resolve(process.env.LINDELA_LITE_CALIBRATION_DIR || 'data/calibration')
      await fs.mkdir(calibDir, { recursive: true })
      await fs.writeFile(path.join(calibDir, 'latest.json'), JSON.stringify({ risk_scores, data_quality, generated_at: new Date().toISOString() }, null, 2))
    } catch {
      // swallow errors
    }
  }

  return {
    risk_scores, impact_assessments, data_quality, population_at_risk, facilities_at_risk,
    unexpected_changes: reconciliation.rows.length,
  }
}

/**
 * The outgoing derived values, keyed for comparison.
 *
 * A store that has never computed them has no previous values, which is not a
 * change — it is a first run. Returning an empty map is what makes the
 * reconciliation say "nothing moved", rather than reporting every district as an
 * unexplained change on a fresh deployment.
 */
async function readDerived(store, collections) {
  if (typeof store.read !== 'function') return new Map()
  const snapshot = await store.read()
  const out = new Map()
  for (const collection of collections) {
    for (const record of snapshot[collection] || []) {
      // The whole outgoing record, not just its value: the input counts it was
      // computed from are on it, and they are the other side of the comparison.
      out.set(derivedKey(collection, record), { collection, record, value: comparableValue(record) })
    }
  }
  return out
}

/** The number a reconciliation compares: the score, or null when there is none. */
function comparableValue(record) {
  for (const field of ['score', 'risk_score', 'value', 'level', 'impact_level']) {
    if (record[field] !== undefined && record[field] !== null) return record[field]
  }
  return null
}

/**
 * ENH-23 — "this number changed and nobody knows why" has to be answerable.
 *
 * `replaceAnalytics` swaps eight collections wholesale, so a change in the
 * engine, or a source that quietly stops contributing, moves every district's
 * numbers at once and leaves no trace. The repository already has
 * `payload_hash`, `data_lineage` and per-record provenance — every primitive
 * except the cross-check, which is the one that would notice.
 *
 * So: for every district whose value moved while its *input counts* did not,
 * write a row naming the region, both values, and the inputs that did not
 * change. A moved value over moved inputs is ordinary; a moved value over
 * unmoved inputs is the engine, and this is the only place that says so.
 *
 * The band is deliberately wide. A reconciliation that fires on rounding
 * trains operators to ignore it, and an ignored signal is worse than none: a
 * narrow band here would produce a row on nearly every refresh and the row would
 * be read as noise by the third week.
 */
export const UNEXPECTED_CHANGE_BAND = 0.05

/** The input counts a district's derived value is a function of. */
const INPUT_COUNTS = [
  'hazard_events', 'conflict_events', 'climate_observations', 'field_reports',
  'service_assets', 'road_access', 'flood_probability_models', 'data_quality',
  'incident_records', 'food_security_records', 'disease_observations',
  'impact_assessments', 'response_resources',
]

/**
 * What a derived record is *about*.
 *
 * The derived rows are keyed on a grid cell (`region_name: "3,36"`) rather than
 * a district name, and the two risk families — flood and climate-conflict —
 * produce one row each for the same cell. So identity is the cell *and* the
 * kind: a flood score moving while a conflict score does not is one district's
 * number, and collapsing them into a single key would compare two different
 * quantities and call the difference an anomaly.
 */
function placeOf(record) {
  return record.region || record.district || record.region_name || record.id || null
}

export function derivedKey(collection, record) {
  return `${collection}:${record.type || 'score'}:${placeOf(record)}`
}

export function inputDigestFor(district, data) {
  const counts = {}
  for (const name of INPUT_COUNTS) {
    const records = data[name] || []
    counts[name] = Array.isArray(records)
      ? records.filter((record) => inDistrict(record, district)).length
      : 0
  }
  return counts
}

function inDistrict(record, district) {
  if (!district) return true
  if (record.district) return record.district === district
  if (record.country && district.includes(record.country)) return true
  return false
}

export async function reconcileDerivedNumbers(store, data, { previous, now = new Date().toISOString(), band = UNEXPECTED_CHANGE_BAND } = {}) {
  const before = previous || new Map()
  const rows = []
  for (const [collection, records] of Object.entries({
    risk_scores: data.risk_scores || [],
    impact_assessments: data.impact_assessments || [],
  })) {
    for (const record of records) {
      const key = derivedKey(collection, record)
      const was = before.get(key)
      if (!was) continue
      const nowValue = comparableValue(record)
      const wasValue = was.value
      if (nowValue === null || wasValue === null) continue
      const delta = typeof nowValue === 'number' && typeof wasValue === 'number'
        ? Math.abs(nowValue - wasValue)
        : (nowValue === wasValue ? 0 : Infinity)
      const relative = typeof nowValue === 'number' && nowValue !== 0
        ? delta / Math.abs(nowValue)
        : delta
      if (!(relative > band)) continue

      const district = placeOf(record)
      const after = record.input_counts || null
      const beforeCounts = was.record.input_counts || null
      if (after && beforeCounts && JSON.stringify(beforeCounts) === JSON.stringify(after)) {
        rows.push({
          id: `unexpected_${collection}_${String(district).replace(/[^a-z0-9]+/gi, '-')}`,
          type: 'unexpected_change',
          collection,
          district,
          value_before: wasValue,
          value_after: nowValue,
          relative_change: Number(relative.toFixed(6)),
          // The inputs, stated as counts, and the fact that they did not move.
          // "Inputs unchanged" is the whole claim; the reader's first question is
          // always "what changed then?", and this is the answer.
          input_counts: after,
          inputs_unchanged: true,
          observed_at: now,
        })
      }
    }
  }
  if (rows.length) {
    await store.merge({ unexpected_changes: rows })
    for (const row of rows) {
      logger.error('derived_value_moved_without_input_change', {
        collection: row.collection,
        district: row.district,
        before: row.value_before,
        after: row.value_after,
      })
    }
  }
  return { rows }
}

export function computeFloodRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events.filter((event) => /flood|storm|disaster/i.test(event.event_type)), region, 250)

    // Bias-corrected value, else the deterministic point value.
    //
    // This used to prefer ensemble p90 over the point value. Those percentiles
    // were synthesized from the same point value by an invented spread, so
    // preferring them meant scoring against an inflated number — at a reported
    // probability of 10%, p90 was about 1.9x the observed precipitation. A
    // percentile is only preferred when a real probabilistic forecast supplied
    // it, which is now identified by `ensemble_source`.
    const precipValues = climate.map((item) => {
      if (Number.isFinite(item.bias_corrected_precipitation_mm)) return Number(item.bias_corrected_precipitation_mm)
      if (item.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(item.ensemble_p90)) {
        return Number(item.ensemble_p90)
      }
      // A missing reading is unknown, not zero. `|| 0` made an absent
      // precipitation record look like a measured dry spell, which lowers the
      // score — the worst direction for an absent input.
      return Number.isFinite(item.precipitation_mm) ? Number(item.precipitation_mm) : null
    })
    const usablePrecip = precipValues.filter((v) => v !== null)
    const missingPrecip = precipValues.length - usablePrecip.length
    const precipitation = usablePrecip.reduce((sum, v) => sum + v, 0)
    // Only a percentile from a genuine probabilistic forecast counts as ensemble
    // coverage. Percentiles previously synthesized from a point value would
    // otherwise always satisfy this and report uncertainty the data does not have.
    const hasEnsemble = climate.some((c) => c.ensemble_source === 'open_meteo_ensemble' && Number.isFinite(c.ensemble_p90))
    const hasBiasCorrection = climate.some((c) => Number.isFinite(c.bias_corrected_precipitation_mm))

    // Same rule for probability: an absent forecast is not a 0% chance of rain.
    const probabilities = climate
      .map((item) => (Number.isFinite(item.precipitation_probability_pct) ? Number(item.precipitation_probability_pct) : null))
      .filter((v) => v !== null)
    const missingProbability = climate.length - probabilities.length
    const maxProbability = probabilities.length ? Math.max(0, ...probabilities) : null
    const hazardPressure = hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)
    const score = clamp(Math.round(precipitation * 1.5 + (maxProbability ?? 0) * 0.35 + hazardPressure), 0, 100)
    // Confidence counts readings actually used, not records present. A region
    // whose observations arrived without precipitation gets a lower confidence,
    // so an absent input lowers how sure the score is rather than lowering the
    // score — which is the only safe direction for missing data.
    const confidence = confidenceScore([
      { count: usablePrecip.length, weight: 45 },
      { count: hazards.length, weight: 40 },
      { count: probabilities.length, weight: 15 },
    ])

    // Sensitivity band around the point score, NOT a probabilistic interval.
    //
    // These fields were originally named score_p10/p50/p90, which reads as
    // quantiles of a calibrated predictive distribution. They are not. The
    // width is a fixed function of the input-coverage confidence score, so a
    // well-populated region returns p10 == p50 == p90 with interval_width 0,
    // which presents as "no uncertainty" when it means "enough inputs to
    // compute a point score". Renamed to state what they are; the values and
    // the p10/p50/p90 aliases are unchanged so existing consumers and stored
    // records keep working.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10

    // One timestamp for the record and its envelope. Two `new Date()` calls a
    // microsecond apart would let a consumer diff the two and conclude the
    // evidence was gathered after the score it explains.
    const generated_at = new Date().toISOString()

    const drivers = {
      precipitation_mm: Math.round(precipitation * 10) / 10,
      precipitation_probability_pct: maxProbability,
      // Exposed so a caller can see how much of the input was missing rather than
      // inferring completeness from a plausible-looking total.
      climate_observations_in_scope: climate.length,
      missing_precipitation_records: missingPrecip,
      missing_probability_records: missingProbability,
      flood_hazard_events: hazards.length,
    }
    if (hasBiasCorrection) drivers.bias_corrected = true
    if (hasEnsemble) drivers.ensemble_used = true

    return {
      id: stableId('risk', ['flood', region.key]),
      type: 'flood_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      // Truthful names for what these are.
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      // Retained aliases for existing consumers and stored records.
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      risk_level: riskLevel(score),
      confidence,
      generated_at,
      drivers,
      methodology: 'Transparent baseline: precipitation forecast + flood/storm/disaster alerts near exposed locations.',
      // The band travels beside the tiers rather than inside them. It is a
      // function of input coverage (see ADR-004) and calling it a sampling tier
      // would say it measures the outcome rate when it measures neither.
      uncertainty: uncertaintyTiers({
        coverage: [
          'any hydrological transformation of rainfall to flood extent or depth — none is modelled here',
          'gauge observation error, and the ERA5 tail-dryness bias documented in the basis document',
          'reporting bias: a hazard that occurred and was never reported contributes nothing to the hazard pressure term',
          'the sensitivity band above, which is drawn from input coverage and is not a predictive interval',
        ],
      }),
      honesty: honestyEnvelope('flood_risk_score', {
        value: score,
        basis: {
          description: `precipitation total x 1.5 + max rain probability x 0.35 + sum of severity-weighted flood/storm/disaster alerts within 250 km, over ${climate.length} climate observation(s) and ${hazards.length} hazard event(s)`,
          sample: {
            climate_observations_in_scope: climate.length,
            missing_precipitation_records: missingPrecip,
            flood_hazard_events: hazards.length,
          },
        },
        notIncluded: [
          'any hydrological model: rainfall-to-flood extent, depth and duration are not modelled',
          'the sensitivity band, which reflects input coverage rather than a calibrated outcome distribution',
        ],
        evidence: { retrieved_at: generated_at },
        refused: missingPrecip || missingProbability
          ? [`${missingPrecip} of ${climate.length} in-scope climate observations and ${missingProbability} probability forecasts contributed nothing to this score, so a low score here may mean missing data rather than low risk`]
          : [],
      }),
      limits: [
        'Point score from input data, with a sensitivity band driven by input coverage, not a calibrated predictive distribution.',
        'A zero band means inputs were sufficient, not that the outcome is certain.',
        missingPrecip || missingProbability
          ? `Incomplete input: ${missingPrecip} of ${climate.length} in-scope climate observation(s) carry no precipitation reading and ${missingProbability} carry no probability forecast. Those contribute nothing to the score, so a low score here may reflect missing data rather than low risk.`
          : 'All in-scope climate observations carried a precipitation reading.',
        'Rainfall intensity/duration to flood probability is not modelled: that needs an agreed hydrological model basis and a validated record.',
      ].join(' '),
    }
  })
}

export function computeClimateConflictRisk(data, options = {}) {
  const regions = collectRegions(data, options)
  return regions.map((region) => {
    const climate = nearby(data.climate_observations, region, 125)
    const hazards = nearby(data.hazard_events, region, 250)
    const conflicts = nearby(data.conflict_events, region, 125)
    const serviceAssets = nearby(data.service_assets, region, 75)
    const climatePressure = Math.min(35, climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0))
    // How many climate observations actually carried a rainfall number. Every
    // CHIRPS record has `precipitation_mm: null` by construction — the connector
    // reports which rasters exist, not what fell — and open-meteo-flood does the
    // same. Counting them in the confidence vector gave a region full climate
    // coverage credit for observations that contributed nothing to the score
    // above, and `confidence` is what the p10/p90 band is drawn from. The
    // pressure sum itself is unaffected: a null adds nothing either way.
    const climateWithRainfall = climate.filter((item) => item.precipitation_mm !== null
      && item.precipitation_mm !== undefined
      && item.precipitation_mm !== ''
      && Number.isFinite(Number(item.precipitation_mm))).length
    const hazardPressure = Math.min(25, hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 12, 0))
    const conflictPressure = Math.min(30, conflicts.reduce((sum, event) => sum + 4 + Number(event.fatalities || 0) * 0.8, 0))
    const servicePressure = Math.min(10, serviceAssets.length * 1.5)
    const score = clamp(Math.round(climatePressure + hazardPressure + conflictPressure + servicePressure), 0, 100)
    const confidence = confidenceScore([
      { count: climateWithRainfall, weight: 30 },
      { count: hazards.length, weight: 25 },
      { count: conflicts.length, weight: 30 },
      { count: serviceAssets.length, weight: 15 },
    ])

    // Sensitivity band, not a probabilistic interval. See the note in
    // computeFloodRisk: the width reflects input coverage, not uncertainty.
    const halfWidth = Math.round((100 - confidence) * 0.4)
    const score_p50 = score
    const score_p10 = clamp(score - halfWidth, 0, 100)
    const score_p90 = clamp(score + halfWidth, 0, 100)
    const interval_width = score_p90 - score_p10
    const generated_at = new Date().toISOString()

    return {
      id: stableId('risk', ['climate_conflict', region.key]),
      type: 'climate_conflict_risk',
      region_name: region.name,
      country: region.country,
      latitude: region.latitude,
      longitude: region.longitude,
      score,
      sensitivity_low: score_p10,
      sensitivity_mid: score_p50,
      sensitivity_high: score_p90,
      sensitivity_width: interval_width,
      score_p10,
      score_p50,
      score_p90,
      interval_width,
      calibrated_uncertainty: false,
      risk_level: riskLevel(score),
      confidence,
      generated_at,
      drivers: {
        climate_observations: climate.length,
        hazard_events: hazards.length,
        conflict_events: conflicts.length,
        nearby_service_assets: serviceAssets.length,
      },
      methodology: 'Transparent baseline: climate stress + hazard pressure + user-supplied or licensed conflict events + exposed service assets.',
      limits: 'Weighted sum of input counts and severities, with a sensitivity band driven by input coverage rather than a calibrated predictive distribution. A zero band means inputs were sufficient, not that the outcome is certain.',
      uncertainty: uncertaintyTiers({
        coverage: [
          'the causal direction between climate stress and conflict: both are counted, neither is claimed to cause the other',
          'conflict-event coverage, which follows reporting access and is not uniform across the region set',
          'the sensitivity band above, which is drawn from input coverage and is not a predictive interval',
        ],
      }),
      honesty: honestyEnvelope('climate_conflict_risk_score', {
        value: score,
        basis: {
          description: `climate stress (max 35) + hazard pressure (max 25) + conflict pressure (max 30) + exposed service assets (max 10), from ${climateWithRainfall} of ${climate.length} climate observation(s) carrying rainfall, ${hazards.length} hazard event(s), ${conflicts.length} conflict event(s), ${serviceAssets.length} nearby asset(s)`,
          sample: {
            climate_observations_with_rainfall: climateWithRainfall,
            climate_observations_in_scope: climate.length,
            hazard_events: hazards.length,
            conflict_events: conflicts.length,
            nearby_service_assets: serviceAssets.length,
          },
        },
        notIncluded: [
          'a causal claim linking climate stress to conflict; both terms are counted side by side and no mechanism is modelled',
          'demographic attribution: the score says nothing about which population is exposed',
          'the sensitivity band, which reflects input coverage rather than a calibrated outcome distribution',
        ],
        evidence: { retrieved_at: generated_at },
        refused: climate.length > climateWithRainfall
          ? [`${climate.length - climateWithRainfall} of ${climate.length} in-scope climate observations carry no rainfall figure and contributed nothing to the climate term`]
          : [],
      }),
    }
  })
}

export function computeServiceImpacts(data, riskScores) {
  const floodRisks = riskScores.filter((risk) => risk.type === 'flood_risk')
  const conflictRisks = riskScores.filter((risk) => risk.type === 'climate_conflict_risk')
  const assessments = []
  for (const asset of data.service_assets) {
    const assetPoint = { latitude: asset.latitude, longitude: asset.longitude }
    const nearestFlood = nearest(floodRisks, assetPoint)
    const nearestConflict = nearest(conflictRisks, assetPoint)
    const floodScore = nearestFlood && nearestFlood.distance_km <= 150 ? nearestFlood.item.score : 0
    const conflictScore = nearestConflict && nearestConflict.distance_km <= 150 ? nearestConflict.item.score : 0
    const score = clamp(Math.round(floodScore * 0.55 + conflictScore * 0.45), 0, 100)
    const confidence = Math.round(((nearestFlood?.item?.confidence || 0) * 0.55) + ((nearestConflict?.item?.confidence || 0) * 0.45))
    const generated_at = new Date().toISOString()
    assessments.push({
      id: stableId('impact', [asset.id, score]),
      asset_id: asset.id,
      asset_name: asset.name,
      service_type: asset.service_type,
      country: asset.country,
      latitude: asset.latitude,
      longitude: asset.longitude,
      impact_score: score,
      impact_level: riskLevel(score),
      confidence,
      generated_at,
      drivers: {
        nearest_flood_risk: nearestFlood?.item?.region_name || null,
        nearest_climate_conflict_risk: nearestConflict?.item?.region_name || null,
        // Distance to the region the score was borrowed from, and whether that
        // region was inside the 150 km borrowing radius. A zero contribution
        // from a hazard score is either "no nearby risk" or "the nearest region
        // is too far to borrow from", and those read identically above.
        nearest_flood_risk_km: nearestFlood ? Math.round(nearestFlood.distance_km * 10) / 10 : null,
        nearest_conflict_risk_km: nearestConflict ? Math.round(nearestConflict.distance_km * 10) / 10 : null,
        flood_risk_in_radius: Boolean(nearestFlood && nearestFlood.distance_km <= 150),
        conflict_risk_in_radius: Boolean(nearestConflict && nearestConflict.distance_km <= 150),
      },
      recommended_actions: recommendedActions(asset.service_type, score),
      uncertainty: uncertaintyTiers({
        coverage: [
          'service continuity itself: nothing here observes roads, staffing, stock or whether a service is actually running',
          'the number of people affected — the asset carries no served population on this record',
          'timing: a score is a snapshot, and the hazard it points at has no duration attached',
        ],
      }),
      honesty: honestyEnvelope('service_impact_score', {
        value: score,
        basis: {
          description: `nearest flood_risk score x 0.55 + nearest climate_conflict_risk score x 0.45, each borrowed only from a region within 150 km of the asset`,
          sample: {
            flood_risk_region: nearestFlood?.item?.region_name || null,
            flood_risk_km: nearestFlood ? Math.round(nearestFlood.distance_km * 10) / 10 : null,
            conflict_risk_region: nearestConflict?.item?.region_name || null,
            conflict_risk_km: nearestConflict ? Math.round(nearestConflict.distance_km * 10) / 10 : null,
          },
        },
        notIncluded: [
          'any observation of the service: no asset condition, no road passability, no stock level',
          'population served, which lives on the asset record and is not folded into this score',
          'the sensitivity bands of the borrowed region scores, which are not propagated here',
        ],
        evidence: { retrieved_at: generated_at },
        refused: [
          ...(nearestFlood && nearestFlood.distance_km > 150
            ? [`the nearest flood risk region is ${Math.round(nearestFlood.distance_km)} km away, beyond the 150 km borrowing radius, so its score contributed 0 rather than a small amount`]
            : []),
          ...(nearestConflict && nearestConflict.distance_km > 150
            ? [`the nearest climate-conflict region is ${Math.round(nearestConflict.distance_km)} km away, beyond the 150 km borrowing radius, so its score contributed 0 rather than a small amount`]
            : []),
          ...(nearestFlood || nearestConflict ? [] : ['no scored region lies within 150 km of this asset, so the score is 0 for lack of nearby evidence rather than for lack of risk']),
        ],
      }),
    })
  }
  return assessments
}

/**
 * A mean that survives the units it is given.
 *
 * `Math.round(sum / n)` over a 0-1 quantity returns 0 or 1 and nothing else, so
 * a source whose model reports 0.82 confidence reported a mean of 1, and one
 * reporting 0.4 reported 0 — the number was not imprecise, it was meaningless.
 * Rounded to two decimals it is readable; `null` when there was nothing to
 * average, because no mean is not a mean of zero.
 */
const mean2dp = (sum, count) => (count > 0 ? Math.round((sum / count) * 100) / 100 : null)

/** The same mean as a 0-100 percentage, for display beside other percentages. */
const asPct = (value) => (value === null ? null : Math.round(value * 100))

export function calibrationReport(data) {
  const byType = new Map()
  for (const score of data.risk_scores || []) {
    const type = score.type
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        count: 0,
        total_score: 0,
        total_confidence: 0,
        total_interval_width: 0,
      })
    }
    const item = byType.get(type)
    item.count += 1
    item.total_score += score.score || 0
    item.total_confidence += score.confidence || 0
    item.total_interval_width += score.interval_width || 0
  }

  return [...byType.values()].map((item) => ({
    type: item.type,
    count: item.count,
    mean_score: item.count > 0 ? Math.round(item.total_score / item.count) : 0,
    // Record confidence and interval width are 0-1 and 0-100 respectively;
    // rounding a 0-1 mean to an integer left it able to hold only 0 or 1.
    mean_confidence: mean2dp(item.total_confidence, item.count),
    mean_confidence_pct: asPct(mean2dp(item.total_confidence, item.count)),
    mean_interval_width: mean2dp(item.total_interval_width, item.count),
    brier_score: null,
    uncertainty: uncertaintyTiers({
      coverage: [
        'skill of the underlying model: these are averages of stored records, not a validation',
        'the variance between regions — two regions with the same mean can differ entirely',
        'the districts that were not scored at all, because the risk surface is bounded to the operational area',
      ],
    }),
    honesty: honestyEnvelope('calibration_summary', {
      value: item.count > 0 ? Math.round(item.total_score / item.count) : 0,
      basis: {
        description: `arithmetic mean over ${item.count} stored ${item.type} record(s)`,
        sample: { records_averaged: item.count, record_type: item.type },
      },
      notIncluded: [
        'any comparison against observed outcomes; brier_score stays null because nothing joins these records to what happened',
        'the spread across regions behind the mean',
      ],
      refused: [
        'brier_score is withheld: this summary reads stored scores and has no outcome labels to score them against, and a null is not a poor score, it is an absent measurement',
      ],
    }),
  }))
}

export function computeDataQuality(data) {
  const collections = {
    climate_observations: data.climate_observations,
    hazard_events: data.hazard_events,
    conflict_events: data.conflict_events,
    service_assets: data.service_assets,
    food_security_records: data.food_security_records,
    disease_observations: data.disease_observations,
  }
  const bySource = new Map()
  for (const [collection, records] of Object.entries(collections)) {
    for (const record of records || []) {
      const source = record.source || 'operator'
      if (!bySource.has(source)) {
        bySource.set(source, {
          id: `quality_${source}`,
          source,
          records_by_collection: {},
          total_records: 0,
          geocoded_records: 0,
          latest_record_at: null,
          confidence_sum: 0,
          confidence_count: 0,
        })
      }
      const quality = bySource.get(source)
      quality.records_by_collection[collection] = (quality.records_by_collection[collection] || 0) + 1
      quality.total_records += 1
      // Only computed records carry a model confidence. Raw source rows do not,
      // and counting their absence as zero would drag the mean down for a source
      // whose model has not run.
      if (Number.isFinite(record.confidence)) {
        quality.confidence_sum += record.confidence
        quality.confidence_count += 1
      }
      if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) quality.geocoded_records += 1
      quality.latest_record_at = latestDate(quality.latest_record_at, record.observed_at || record.occurred_at || record.updated_at || record.generated_at)
    }
  }

  for (const run of data.source_runs || []) {
    const source = run.source || 'unknown'
    if (!bySource.has(source)) {
      bySource.set(source, {
        id: `quality_${source}`,
        source,
        records_by_collection: {},
        total_records: 0,
        geocoded_records: 0,
        latest_record_at: null,
        confidence_sum: 0,
        confidence_count: 0,
      })
    }
    const quality = bySource.get(source)
    quality.last_run_status = run.status
    quality.last_run_at = latestDate(quality.last_run_at, run.completed_at)
    quality.error_count = (quality.error_count || 0) + (run.errors?.length || 0)
  }

  return [...bySource.values()].map((quality) => {
    const geocodeCoverage = quality.total_records ? quality.geocoded_records / quality.total_records : 0
    const runPenalty = quality.last_run_status === 'failed' ? 35 : quality.last_run_status === 'degraded' ? 15 : 0
    const freshnessPenalty = freshnessPenaltyFor(quality.latest_record_at || quality.last_run_at)
    const confidence = clamp(Math.round(geocodeCoverage * 55 + Math.min(quality.total_records, 25) * 1.8 - runPenalty - freshnessPenalty), 0, 100)
    const updated_at = new Date().toISOString()
    // Null, not zero, when no record carried a confidence. `confidence_sum` was
    // initialised and read here but never incremented anywhere, so this divided
    // zero by the record count and reported 0 for every source — a confident
    // "we have no confidence in any of this" for sources whose models were
    // simply not part of this pass.
    const mean_confidence = mean2dp(quality.confidence_sum, quality.confidence_count)
    return {
      ...quality,
      geocode_coverage_pct: Math.round(geocodeCoverage * 100),
      // Beside `confidence` and `geocode_coverage_pct`, both 0-100, a bare
      // 0-1 fraction invites the reader to compare it with the wrong scale.
      mean_confidence_pct: asPct(mean_confidence),
      freshness: freshnessLabel(quality.latest_record_at || quality.last_run_at),
      confidence,
      mean_confidence,
      updated_at,
      uncertainty: uncertaintyTiers({
        coverage: [
          'accuracy: nothing here compares a source against ground truth, only against itself',
          'correctness of the values: a source can be perfectly geocoded, fresh and wrong',
          'representativeness: a source that reports only severe events scores as complete',
          'cross-source agreement, which is measured elsewhere rather than here',
        ],
      }),
      honesty: honestyEnvelope('data_quality_confidence', {
        value: confidence,
        basis: {
          description: `geocode coverage x 55 + min(records, 25) x 1.8 - run penalty (${runPenalty}) - freshness penalty (${freshnessPenalty}), clamped 0-100`,
          sample: {
            total_records: quality.total_records,
            geocoded_records: quality.geocoded_records,
            records_with_a_model_confidence: quality.confidence_count,
          },
        },
        notIncluded: [
          'any check of whether the reported values are correct — this is a completeness and hygiene score',
          'agreement with other sources covering the same period',
          'whether the source\'s own upstream pipeline failed silently and reported no rows at all',
        ],
        evidence: { retrieved_at: updated_at },
        refused: quality.confidence_count === 0
          ? ['no record from this source carried a model confidence, so mean_confidence is null rather than 0']
          : [],
      }),
    }
  }).sort((a, b) => b.confidence - a.confidence)
}

/**
 * Regions to score.
 *
 * Every record with coordinates used to become a region, so a global alert feed
 * defined the analytical surface: after a live GDACS pull the console computed
 * risk for 87 regions across 25 countries, 82 of them outside the area the
 * platform operates in. The risk surface then said nothing about the five
 * pilot districts, because it was 94% other places.
 *
 * Regions are now bounded to the operational area, using the same anchor the
 * map framing uses. Records outside it are still ingested, still stored, and
 * still drawn on the map — they simply do not generate risk scores for an
 * operator who is not working there.
 *
 * `options.scope` can widen or narrow this. With no scope, the Horn of Africa
 * pilot area is used.
 */
const RISK_SCOPE = Object.freeze({
  minLat: -6,
  maxLat: 15,
  minLon: 27,
  maxLon: 52,
  marginDeg: 6,
})

function inRiskScope(point, scope) {
  return point.latitude >= scope.minLat - scope.marginDeg
    && point.latitude <= scope.maxLat + scope.marginDeg
    && point.longitude >= scope.minLon - scope.marginDeg
    && point.longitude <= scope.maxLon + scope.marginDeg
}

function collectRegions(data, options = {}) {
  const scope = options.scope || RISK_SCOPE
  const points = [
    ...data.climate_observations,
    ...data.hazard_events,
    ...data.conflict_events,
    ...data.service_assets,
  ].filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .filter((item) => inRiskScope(item, scope))

  const byKey = new Map()
  for (const point of points) {
    const roundedLat = Math.round(point.latitude)
    const roundedLon = Math.round(point.longitude)
    const key = `${point.country || 'unknown'}:${roundedLat}:${roundedLon}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: point.region_name || point.admin1 || point.country || `${roundedLat},${roundedLon}`,
        country: point.country || null,
        latitude: point.latitude,
        longitude: point.longitude,
      })
    }
  }
  return [...byKey.values()]
}

function nearby(records, point, radiusKm) {
  return records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude) && haversineKm(point, record) <= radiusKm)
}

function nearest(records, point) {
  let best = null
  for (const item of records) {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue
    const distance_km = haversineKm(point, item)
    if (!best || distance_km < best.distance_km) best = { item, distance_km }
  }
  return best
}

function recommendedActions(serviceType, score) {
  if (score >= 80) return [`Activate continuity plan for ${serviceType}`, 'Validate access routes', 'Pre-position contingency supplies']
  if (score >= 60) return [`Monitor ${serviceType} service continuity`, 'Confirm backup providers', 'Review flood and security access constraints']
  if (score >= 35) return ['Maintain routine monitoring', 'Check source freshness before operational decisions']
  return ['No immediate action beyond periodic monitoring']
}

function confidenceScore(parts) {
  return clamp(Math.round(parts.reduce((sum, part) => sum + (part.count > 0 ? part.weight : 0), 0)), 0, 100)
}

function latestDate(current, candidate) {
  if (!candidate) return current || null
  if (!current) return new Date(candidate).toISOString()
  const currentMs = Date.parse(current)
  const candidateMs = Date.parse(candidate)
  if (!Number.isFinite(candidateMs)) return current
  return candidateMs > currentMs ? new Date(candidateMs).toISOString() : current
}

function freshnessPenaltyFor(value) {
  if (!value) return 30
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0
  if (ageDays <= 2) return 0
  if (ageDays <= 14) return 10
  if (ageDays <= 45) return 20
  return 30
}

function freshnessLabel(value) {
  if (!value) return 'unknown'
  const ageDays = (Date.now() - Date.parse(value)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 'current'
  if (ageDays <= 2) return 'current'
  if (ageDays <= 14) return 'recent'
  if (ageDays <= 45) return 'stale'
  return 'expired'
}
