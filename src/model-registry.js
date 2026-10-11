/**
 * ENH-50 — one place where every model declares its basis, its floors and its
 * refusal vocabulary.
 *
 * The problem this solves is not documentation. It is that a surface rendering
 * "not measured" has to know *which* sentence to render and *which* floor was
 * missed, and until now it had to import that knowledge from the model module
 * itself — so a dashboard that shows a refusal, an export that withholds a
 * number, and the model that refuses all three carried their own copy of the
 * same fact. `check-no-flood-probability.mjs` reads `MODEL_BASIS` today; nothing
 * else could, because there was no list of models to iterate.
 *
 * **The floors are imported bindings, not restated numbers.** `MIN_MONTHS` in
 * this file IS `flood-probability.js`'s `MIN_MONTHS` — the same binding, not a
 * copy that agrees today. That distinction is the whole design, and this repo
 * has paid for getting it wrong: `gate.py` existed twice in `infra`, prod ran
 * the second, and a checker read the first and reported four correct slugs as
 * phantoms. A registry that retyped `60` would be the same bug with a new
 * spelling — it would pass a test asserting `floors.min_months === 60` while the
 * model moved to 72. So the test asserts *identity* (`===` against the model's
 * own export), and `assertFloorsAreLive` re-checks it at read time.
 *
 * **What a model card is.** `basis` is the sentence a surface renders where the
 * number would be — the thing that makes "we did not measure this" an answer
 * rather than a blank. `refusals` is the vocabulary the model actually returns,
 * so a caller can match on a code instead of parsing prose. `entry` is the
 * function a caller invokes to get either a number or a refusal.
 *
 * The `refusals` lists are declarative claims about the model's behaviour, and
 * the test file cross-checks each one against the model's source — a registry
 * listing a refusal the model cannot produce is a surface that renders a
 * sentence for a state that never occurs, and a model producing one the registry
 * omits is a state no surface can explain.
 */

import {
  MIN_COVERAGE,
  MIN_EVENTS,
  MIN_MONTHS,
  MODEL_BASIS,
  MODEL_BASIS_DISCHARGE,
} from './flood-probability.js'
import {
  DRIFT_BASIS,
  MIN_DRIFT_EVENTS,
  MIN_DRIFT_WINDOW_MONTHS,
  PSI_DRIFT,
  PSI_WATCH,
} from './drift.js'
import { CALIBRATION_BASIS, MIN_DETERMINED_ALERTS } from './calibration.js'
import { MIN_COMPOUND_MONTHS } from './compound-hazard.js'
import {
  BASELINE_TOLERANCE,
  COUNTERFACTUAL_REFUSALS,
  MIN_ARM_UNITS,
  RADIUS_RATIO_MAX,
} from './counterfactual.js'
import { MIN_TERRAIN_COMPARABLES } from './flood-depth.js'

/**
 * A floor is `{ value, unit, because }`.
 *
 * `because` is not decoration: a floor without a reason is a number an operator
 * cannot argue with, and the whole point of publishing floors is that they are
 * arguable. "60 months" is arbitrary; "60 months, because a seasonal model needs
 * five full cycles before a fit is a fit" is a claim someone can contest, which
 * is what a floor is for.
 */
const floor = (value, unit, because) => Object.freeze({ value, unit, because })

/**
 * Every model the platform publishes a number from, with the sentence that
 * accompanies a refusal and the floors that produce one.
 *
 * Order is by subject, not by module, because a reader arrives with a question
 * ("what does the flood model need?") rather than a filename.
 */
export const MODEL_REGISTRY = Object.freeze({
  flood_probability: Object.freeze({
    title: 'Rainfall-conditioned flood probability',
    module: './flood-probability.js',
    entry: 'trainDistrictModels',
    basis: MODEL_BASIS.what_a_probability_is_not,
    basis_record: MODEL_BASIS,
    basis_document: 'docs/flood-probability-model-basis.md',
    floors: Object.freeze({
      months: floor(MIN_MONTHS, 'months of record', 'a seasonal model needs five full cycles before a fit is a fit, and fewer than 60 months cannot carry a leave-one-year-out score'),
      events: floor(MIN_EVENTS, 'flood-label months', 'below five positive months a contingency table has no cell that is not one event wearing a rate'),
      coverage: floor(MIN_COVERAGE, 'fraction of the trailing 90-day window populated', 'a wet-season statistic computed on a third of its days is not a statistic'),
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'refuses in prose from `trainDistrictModels` — `only N of the required M months available`, `only N flood-label months of the required M` — and carries no code vocabulary. A caller distinguishes the cases by which floor it missed, which `floorsMissed` answers from the counts rather than by parsing the sentence.',
    }),
  }),

  flood_probability_discharge: Object.freeze({
    title: 'Discharge-conditioned flood probability',
    module: './flood-probability.js',
    entry: 'buildDistrictSamplesFromDischarge',
    basis: MODEL_BASIS_DISCHARGE.what_a_probability_is_not,
    basis_record: MODEL_BASIS_DISCHARGE,
    basis_document: 'docs/flood-probability-model-basis.md',
    floors: Object.freeze({
      months: floor(MIN_MONTHS, 'months of discharge coverage', 'the label is a percentile of monthly maxima, so it needs the same record length the rainfall label does'),
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'returns `{ samples: [], months_kept: 0, skipped_reason }` — a skipped reason rather than a refusal code, and the caller reads `months_kept` for the count.',
    }),
  }),

  drift: Object.freeze({
    title: 'Input shift and outcome divergence',
    module: './drift.js',
    entry: 'driftReport',
    basis: DRIFT_BASIS.what_a_drift_verdict_is_not,
    basis_record: DRIFT_BASIS,
    floors: Object.freeze({
      window_months: floor(MIN_DRIFT_WINDOW_MONTHS, 'months in each window', 'a window-over-window comparison needs enough months on both sides that the comparison is between windows and not between two months'),
      events: floor(MIN_DRIFT_EVENTS, 'observed events in the current window', 'a divergence computed against one observed event is that event'),
    }),
    thresholds: Object.freeze({
      psi_watch: PSI_WATCH,
      psi_drift: PSI_DRIFT,
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'returns `{ psi: null, reason }` / `{ verdict, reason }` — a reason string per check, with `reason: null` on a verdict that was issued. Four distinct causes (too few months in a window, too few events, no feature measurable in both windows, non-finite features, no model supplied), none coded.',
    }),
  }),

  compound_hazard: Object.freeze({
    title: 'Compound flood-conflict hazard',
    module: './compound-hazard.js',
    entry: 'compoundHazardScore',
    basis: 'the joint rate over the product of the marginals — a lift — not three independent scores combined by hand',
    floors: Object.freeze({
      months: floor(MIN_COMPOUND_MONTHS, 'months of record', 'a joint rate over fewer than twelve months is a curve through noise, and the lift it reports is the noise'),
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'returns `{ score: null, reason }` — a sentence naming the count and the floor it missed, e.g. "N month(s) of record; 12 are needed before a joint rate is reported rather than a curve through noise".',
    }),
  }),

  counterfactual: Object.freeze({
    title: 'Counterfactual impact of a dispatch',
    module: './counterfactual.js',
    entry: 'counterfactualImpact',
    basis: 'pooled difference-in-differences against a matched comparison set, with a unit bootstrap interval',
    floors: Object.freeze({
      arm_units: floor(MIN_ARM_UNITS, 'units per arm', 'a difference of means over two units is noise with a sign, and a counterfactual from fewer is worse than none'),
      baseline_imbalance: floor(BASELINE_TOLERANCE, 'x the pooled pre-period spread', 'arms that were not comparable at the start cannot be assumed to move in parallel afterwards'),
      radius_ratio: floor(RADIUS_RATIO_MAX, 'x the treated catchment radius', 'a comparison set drawn from a materially different catchment is a different population, not a control'),
    }),
    // The only model here with a code vocabulary, and it is imported rather
    // than restated: a copied list agrees today and drifts tomorrow.
    refusals: Object.freeze({ codes: COUNTERFACTUAL_REFUSALS, note: 'every refusal prefixes its sentence with one of these codes' }),
  }),

  calibration: Object.freeze({
    title: 'Alert-outcome calibration',
    module: './calibration.js',
    entry: 'calibrationByRegion',
    basis: CALIBRATION_BASIS.what_a_trust_score_is_not,
    basis_record: CALIBRATION_BASIS,
    floors: Object.freeze({
      determined_alerts: floor(MIN_DETERMINED_ALERTS, 'determined alerts', 'a false-alarm rate over fewer than thirty determinations has a Wilson interval wide enough to contain both a good and a bad system'),
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'returns `{ regions, refusals }`, where each entry carries the `reason` sentence — the determined-alert floor, or the all-one-determination case where there is no contrast to measure a rate against.',
    }),
  }),

  flood_depth: Object.freeze({
    title: 'Flood depth from terrain',
    module: './flood-depth.js',
    entry: 'depthAtPoint',
    basis: 'terrarium tiles against mean sea level, with a caller-supplied datum offset where the datum is not the source datum',
    floors: Object.freeze({
      terrain_comparables: floor(MIN_TERRAIN_COMPARABLES, 'terrain cells', 'a depth interpolated from fewer than three cells is one cell with a decimal point'),
    }),
    refusals: Object.freeze({
      codes: null,
      note: 'returns `{ ok: false, reason }` / null-valued fields with a reason — a level below the terrain floor, a level above the maximum plausible water surface, a non-finite level, or a datum that is neither the source datum nor accompanied by an offset.',
    }),
  }),
})

/** The ids, in declaration order — what a surface iterates. */
export const MODEL_IDS = Object.freeze(Object.keys(MODEL_REGISTRY))

/**
 * The model card, or a refusal.
 *
 * An unknown id refuses rather than returning `undefined`: a surface that asks
 * for a model the registry does not carry has a bug, and `undefined` would
 * render as a blank card that looks like a model with nothing to say.
 */
export function modelCard(id) {
  const card = MODEL_REGISTRY[id]
  if (!card) {
    return {
      card: null,
      refusal: 'unknown_model',
      reason: `'${id}' is not a registered model; the registry carries ${MODEL_IDS.length}: ${MODEL_IDS.join(', ')}`,
    }
  }
  return { card, refusal: null, reason: null }
}

/**
 * Every floor that would refuse a given observation, in the order they appear.
 *
 * Returns an empty array when nothing refuses — and an empty array is a real
 * answer here, unlike the house rule's usual warning, because the caller is
 * asking "what is missing?" and "nothing" is the answer they want. The warning
 * applies to a *measurement* that reports success having measured nothing; this
 * measures the floors and reports none.
 */
export function floorsMissed(id, observed = {}) {
  const { card } = modelCard(id)
  if (!card) return []
  const missed = []
  for (const [key, spec] of Object.entries(card.floors)) {
    const value = observed[key]
    // An absent observation is not a passing one. A caller that omits the
    // count has not shown the floor is met, and reporting no refusal would
    // turn a missing input into a clean bill of health.
    if (value == null) {
      missed.push({ floor: key, observed: null, required: spec.value, reason: 'not supplied, so the floor is unverified rather than met' })
      continue
    }
    const failing = key === 'baseline_imbalance' || key === 'radius_ratio'
      ? value > spec.value
      : value < spec.value
    if (failing) missed.push({ floor: key, observed: value, required: spec.value, reason: spec.because })
  }
  return missed
}

/**
 * The one sentence a surface renders where a number would be.
 *
 * This is the function the entry exists for: every surface that shows a model's
 * output calls it, so "not measured" reads the same in the console, the PDF, the
 * export and the API — and it reads the model's own words rather than a
 * paraphrase written at the surface.
 *
 * `code` is optional and only meaningful for the models that have a vocabulary
 * (`refusalCodes`). Passing one to a model that refuses in prose is a caller
 * mistake worth reporting rather than ignoring: it means the caller expected a
 * code that does not exist, and silently returning the basis sentence would hide
 * that.
 */
export function refusalSentence(id, code = null) {
  const { card } = modelCard(id)
  if (!card) return null
  const codes = refusalCodes(id)
  if (code && codes === null) {
    return `unregistered refusal '${code}' from ${card.title}; this model refuses in prose and declares no codes`
  }
  if (code && !codes.includes(code)) {
    // A code the registry does not carry means the model grew a refusal and
    // the card did not, which is the drift the registry exists to catch.
    return `unregistered refusal '${code}' from ${card.title}; the card declares ${codes.join(', ')}`
  }
  return card.basis
}

/**
 * The coded refusals a model can return, or `null` when it has none.
 *
 * `null` rather than `[]` on purpose. An empty array would say "this model has a
 * vocabulary and it is empty", which is a different and false claim; five of the
 * six models here refuse in prose, and a caller that cannot tell the two apart
 * will treat "no codes" as "no refusals".
 */
export function refusalCodes(id) {
  const { card } = modelCard(id)
  if (!card) return null
  return card.refusals.codes ?? null
}

/**
 * Assert every floor is the model's own binding, not a copy.
 *
 * Called by the test rather than at import, because a registry that throws on
 * load takes the whole server down for a documentation defect. The comparison is
 * by value *and* the test additionally asserts identity where the model exports
 * the binding directly — a number that agrees today is not one source of truth,
 * and the only durable check is that there is one.
 */
export function assertFloorsAreLive(models = {}) {
  const problems = []
  for (const [id, card] of Object.entries(MODEL_REGISTRY)) {
    const module = models[id]
    if (!module) continue
    for (const [key, spec] of Object.entries(card.floors)) {
      const live = module[key]
      if (live !== undefined && live !== spec.value) {
        problems.push(`${id}.${key}: registry says ${spec.value}, module says ${live}`)
      }
    }
  }
  return problems
}
