/**
 * The metric registry. One declared denominator per named published metric.
 *
 * `false_alert_rate` shipped three definitions under one name on four surfaces,
 * and they disagreed *in direction* on the live store: on Mandera — the one
 * district with a confirmed false alert — `src/kpi.js` computed 50% while
 * `src/districts.js` and `src/equity.js` both computed 0%. The district page
 * therefore reported alerting clean for the only district where it was not.
 *
 * The cause is not that one of the three was wrong. It is that three were
 * *writable*. `src/districts.js:161` carried a long comment arguing that "the
 * denominator stays every alert the district raised … that is what a false-alert
 * *rate* means", while computing the numerator over a different population two
 * lines above, and `src/equity.js:100` carried a comment asserting it "is
 * defined exactly as `districtOverview` defines it" immediately before
 * computing something else. Both comments were locally reasonable. Both were
 * false. A metric a second module can redefine is a metric whose number depends
 * on which page you opened, which is the defect this file exists to close.
 *
 * So the rules here are about *writability*, not about style:
 *
 * - One definition per name, declared once, frozen. Nothing outside this file
 *   states what a registered metric's numerator or denominator is.
 * - Every definition carries its own refusal rule and sample floor, evaluated
 *   in `compute`. A surface cannot publish below the floor by forgetting to
 *   check, because the floor lives inside the only implementation.
 * - A surface that wants a different quantity must register a *different name*.
 *   "False alerts over every alert raised" and "false alerts over alerts whose
 *   outcome a person determined" are genuinely different quantities; conflating
 *   them under one name is the whole problem. The registry makes the honest
 *   route the cheap one.
 *
 * What this deliberately does not do is synthesise ground truth. The registry
 * decides *how a metric is counted*, not *what the truth is*. Where the store
 * carries no outcome for an alert, no amount of declaration makes one; the
 * refusal is the answer, and it is returned as a `reason` string rather than
 * thrown away.
 */

import { numericOrNull } from './numeric.js'

/** A rate whose sample cannot distinguish anything is not reported. */
export const MIN_DETERMINED_ALERTS = 30

/** Same argument, applied where the population is dispatch outcomes. */
export const MIN_PRECISION_DISPATCHES = 5

/** Operational rates: a 100% rate from one completed intervention is not a rate. */
export const MIN_OPERATIONAL_SAMPLES = 5

/**
 * Was this alert's outcome determined by a person?
 *
 * The whole disagreement in this file reduces to which alerts count. `true` and
 * `false` are determinations; `null`, absent, and anything else are the absence
 * of one. A keyword scan of `resolution_note` cannot tell them apart — the
 * confirmed false alert on Mandera reads "Reading traced to a faulty sensor",
 * which contains no `false`, no `invalid` and no `noop`, and was therefore
 * invisible to two of the three definitions while being perfectly visible to the
 * one that read the field an operator actually filled in.
 */
function determination(alert) {
  const v = alert?.false_alert
  return v === true || v === false ? v : null
}

/**
 * A rate as a numerator over a denominator, with the sample floor applied here
 * rather than at the call site.
 *
 * `value` is in percent (0–100) to match every published field of the same
 * name, and `null` when the floor is not met. `dp` rounds for display without
 * touching the underlying value.
 */
function rate({ numerator, denominator, floor, dp = 2, refusal }) {
  const sample = denominator
  if (sample < floor) {
    return {
      value: null,
      numerator,
      denominator,
      sample,
      floor,
      refusal: refusal(sample, floor),
    }
  }
  const value = Math.round((100 * numerator / sample) * 10 ** dp) / 10 ** dp
  return { value, numerator, denominator, sample, floor, refusal: null }
}

/**
 * The registry.
 *
 * `basis` is the sentence a reader would need in order to judge the number.
 * It travels with the value on every surface, so a rate can never be read
 * without the denominator that produced it — which is what makes a second
 * definition visible when one appears: the surface that disagrees also
 * disagrees about what it is measuring.
 */
export const METRICS = Object.freeze({
  /**
   * Share of *determined* alerts that were false.
   *
   * Numerator: alerts with `false_alert === true`.
   * Denominator: alerts with any determination (`true` or `false`).
   * Excluded: every alert nobody looked at. They are not sound alerts and not
   * false ones; they are unknowns, and folding them into the denominator is
   * what made the district page report 0% for a district with a confirmed miss.
   *
   * Sample floor 30, inherited from `src/calibration.js`: below it the Wilson
   * interval at a plausible rate spans the difference between "rarely wrong"
   * and "half the time". An honest useless interval presented as a rate is the
   * failure mode this metric has already produced twice.
   */
  false_alert_rate: Object.freeze({
    unit: 'percent',
    basis: 'alerts with false_alert === true, over alerts with a recorded determination (true or false); alerts nobody reviewed are excluded, not counted as sound',
    sample_floor: MIN_DETERMINED_ALERTS,
    compute(alerts = []) {
      let numerator = 0
      let denominator = 0
      for (const alert of alerts) {
        const d = determination(alert)
        if (d === null) continue
        denominator += 1
        if (d) numerator += 1
      }
      return rate({
        numerator,
        denominator,
        floor: MIN_DETERMINED_ALERTS,
        refusal: (n, floor) => `only ${n} determined alert(s) of the ${floor} required; an alert nobody reviewed cannot be counted as a sound one`,
      })
    },
  }),

  /**
   * Share of dispatched alerts that were not false.
   *
   * Numerator: determined, dispatched alerts with `false_alert === false`.
   * Denominator: determined, dispatched alerts.
   *
   * The "dispatched" qualifier is in the denominator on purpose. An alert that
   * was never sent is not evidence that the dispatch decision was right, and
   * subtracting false positives that were never dispatched — which the
   * original expression did — could produce a negative precision, which is not
   * a value of anything.
   *
   * This is a precision proxy derived from recorded outcomes, not a response
   * rate. Response rate lives in `rapidpro.responseMetrics` and counts inbound
   * messages per dispatch, not alerts that turned out to be warranted.
   */
  dispatch_precision_pct: Object.freeze({
    unit: 'percent',
    basis: 'dispatched alerts determined warranted, over dispatched alerts with a recorded determination',
    sample_floor: MIN_PRECISION_DISPATCHES,
    compute({ alerts = [], dispatchedAlertIds = null } = {}) {
      const dispatched = dispatchedAlertIds instanceof Set
        ? dispatchedAlertIds
        : new Set(dispatchedAlertIds || [])
      let numerator = 0
      let denominator = 0
      for (const alert of alerts) {
        if (alert?.id && !dispatched.has(alert.id)) continue
        const d = determination(alert)
        if (d === null) continue
        denominator += 1
        if (!d) numerator += 1
      }
      return rate({
        numerator,
        denominator,
        floor: MIN_PRECISION_DISPATCHES,
        refusal: (n, floor) => `only ${n} determined dispatch(es) of the ${floor} required; a percentage from one record is not a precision`,
      })
    },
  }),

  /**
   * People a dispatch actually reached.
   *
   * A count, not a rate, so it has no sample floor — but it has two exclusions
   * that matter more than a floor would:
   *
   * - A dispatch that failed never reached anybody. The original expression
   *   summed `recipients_count` over every dispatch, including
   *   `status: 'failed', sent_at: null, HTTP 503`, and published 1,399 people
   *   reached. Failed dispatches still counted; they counted at their intended
   *   size.
   * - Recipients are summed, not de-duplicated, because the payload carries no
   *   stable person identifier. 20 dispatches to 20 distinct numbers summed to
   *   22,130 recipients, and a union would be guesswork — a guess here inflates
   *   or deflates a funder's headline number. The count therefore reports what
   *   it is (`sends`, with `distinct_destinations` beside it) so the surface can
   *   say so rather than the payload implying a de-duplicated headcount.
   */
  people_reached: Object.freeze({
    unit: 'count',
    basis: 'sum of recipients_count over dispatches that were actually sent; recipients are not de-duplicated because the payload carries no stable person identifier',
    sample_floor: 0,
    compute(dispatches = []) {
      let recipients = 0
      let sends = 0
      let failed = 0
      let missingCount = 0
      const destinations = new Set()
      for (const d of dispatches) {
        const sent = d?.sent_at != null || (d?.status && !['failed', 'queued', 'pending'].includes(d.status))
        if (!sent) { failed += 1; continue }
        sends += 1
        const n = numericOrNull(d?.recipients_count) ?? numericOrNull(d?.metadata?.recipients_count)
        if (n === null) missingCount += 1
        else recipients += n
        const dest = d?.destination ?? d?.rapidpro_contact ?? d?.phone ?? d?.recipient_count
        if (dest != null) destinations.add(String(dest))
      }
      return {
        value: recipients,
        sends,
        failed_excluded: failed,
        without_recipient_count: missingCount,
        // 0 distinct destinations means "not carried in the payload", which is
        // different from "one number reached".
        distinct_destinations: destinations.size || null,
        de_duplicated: false,
        refusal: null,
      }
    },
  }),

  /**
   * Share of feeding interventions that reached a completed or verified state.
   */
  feeding_repositioning_rate: Object.freeze({
    unit: 'percent',
    basis: 'feeding interventions completed or verified, over feeding interventions raised',
    sample_floor: MIN_OPERATIONAL_SAMPLES,
    compute(interventions = []) {
      const feeding = interventions.filter((i) => i?.type === 'feeding')
      const done = feeding.filter((i) => ['completed', 'verified'].includes(i?.status))
      return rate({
        numerator: done.length,
        denominator: feeding.length,
        floor: MIN_OPERATIONAL_SAMPLES,
        refusal: (n, floor) => `only ${n} feeding intervention(s) of the ${floor} required; a rate from one record is not a rate`,
      })
    },
  }),

  /**
   * Share of cold-chain workflows that reached a terminal state.
   */
  cold_chain_protection_rate: Object.freeze({
    unit: 'percent',
    basis: 'cold-chain protection workflows closed or verified, over cold-chain protection workflows raised',
    sample_floor: MIN_OPERATIONAL_SAMPLES,
    compute(workflows = []) {
      const chain = workflows.filter((w) => w?.type === 'cold_chain_protection')
      const terminal = chain.filter((w) => ['closed', 'verified'].includes(w?.state))
      return rate({
        numerator: terminal.length,
        denominator: chain.length,
        floor: MIN_OPERATIONAL_SAMPLES,
        refusal: (n, floor) => `only ${n} cold-chain workflow(s) of the ${floor} required; a rate from one record is not a rate`,
      })
    },
  }),
})

/**
 * Population within range of a set of hazards, counted once per person.
 *
 * This one is a count over a *set*, not a rate, and the hazard overlap is the
 * trap: an asset inside two hazards' radii appears in both per-hazard rows, and
 * a reader summing the rows — which is exactly what
 * `src/operations.js:425` does with `population_at_risk_total` — counts its
 * population twice. Clustered events are the normal regime for floods, not an
 * edge case, so this is not a rare over-count.
 *
 * The per-hazard rows stay per-hazard; each hazard has its own exposed
 * population and collapsing them would lose that. What this provides is the
 * figure that is safe to *sum to*: distinct assets, each contributing its
 * population once. Note the null, which is the point of R-87: an asset with no
 * recorded population contributes nothing to the total *and is counted*, so the
 * payload can report "34 facilities, none of which records a population" rather
 * than a confident zero.
 */
export const population_at_risk = Object.freeze({
  unit: 'count',
  basis: 'population served by distinct assets within range of at least one hazard, each asset counted once; per-hazard rows overlap and must not be summed',
  sample_floor: 0,
  compute({ assets = [], hazards = [], radiusKm = 25, haversineKm } = {}) {
    const byService = new Map()
    let exposedAssets = 0
    let assetsWithPopulation = 0
    let total = 0
    let nullPopulationAssets = 0
    for (const asset of assets) {
      const lat = numericOrNull(asset?.latitude)
      const lon = numericOrNull(asset?.longitude)
      if (lat === null || lon === null) continue
      let hits = 0
      for (const hazard of hazards) {
        const hlat = numericOrNull(hazard?.latitude)
        const hlon = numericOrNull(hazard?.longitude)
        if (hlat === null || hlon === null) continue
        if (haversineKm({ latitude: hlat, longitude: hlon }, { latitude: lat, longitude: lon }) <= radiusKm) {
          hits += 1
        }
      }
      if (!hits) continue
      exposedAssets += 1
      const population = numericOrNull(asset?.population_served) ?? numericOrNull(asset?.beneficiaries)
      if (population === null) nullPopulationAssets += 1
      else { total += population; assetsWithPopulation += 1 }
      const type = asset?.service_type || 'unknown'
      byService.set(type, (byService.get(type) || 0) + 1)
    }
    return {
      value: total,
      // The null travels with the number. `population_at_risk: 0` on a store
      // where no asset records a population is a claim that nobody is exposed;
      // this says "0 people, of 34 facilities, none of which records one".
      assets_at_risk: exposedAssets,
      assets_with_recorded_population: assetsWithPopulation,
      assets_without_recorded_population: nullPopulationAssets,
      // True whenever any asset sits in more than one hazard's range — which is
      // the clustered-events regime, and the reason the per-hazard rows must
      // not be summed.
      hazards_overlap: exposedAssets > 0 && hazardsOverlap(assets, hazards, radiusKm, haversineKm),
      assets_by_service_type: Object.fromEntries(byService),
      refusal: null,
    }
  },
})

function hazardsOverlap(assets, hazards, radiusKm, haversineKm) {
  if (typeof haversineKm !== 'function') return null
  for (const asset of assets) {
    const lat = numericOrNull(asset?.latitude)
    const lon = numericOrNull(asset?.longitude)
    if (lat === null || lon === null) continue
    let hits = 0
    for (const hazard of hazards) {
      const hlat = numericOrNull(hazard?.latitude)
      const hlon = numericOrNull(hazard?.longitude)
      if (hlat === null || hlon === null) continue
      if (haversineKm({ latitude: hlat, longitude: hlon }, { latitude: lat, longitude: lon }) <= radiusKm) hits += 1
      if (hits > 1) return true
    }
  }
  return false
}

/**
 * Look up a declared metric.
 *
 * Throws on an unknown name rather than returning undefined: a surface that
 * spells a metric wrong should fail at the call, not publish `undefined` into
 * a payload that renders as a dash and looks like a data gap.
 */
export function metric(name) {
  const found = METRICS[name]
  if (!found) {
    throw new Error(`no declared metric "${name}"; register it in src/analytics/metrics.js with its numerator, denominator, sample floor and refusal rule`)
  }
  return found
}

/**
 * Compute a declared metric by name.
 *
 * The only supported route. `computeMetric('false_alert_rate', { alerts })` is
 * greppable; a rate computed inline in a district page is not, which is the
 * entire difference between a registry that constrains behaviour and a document
 * that describes it.
 */
export function computeMetric(name, input) {
  return metric(name).compute(input)
}

/**
 * Every declared metric, for a route or a test that wants to assert the set is
 * closed. Adding a metric is adding a name here; there is no other place.
 */
export function declaredMetrics() {
  return Object.keys(METRICS).sort()
}
