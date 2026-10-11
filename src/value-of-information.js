import { clamp, toNumber } from './utils.js'
import { MIN_DRIFT_WINDOW_MONTHS, MIN_DRIFT_EVENTS } from './drift.js'
import { SOURCE_IDS } from './schema.js'

/**
 * ENH-54 — value of information: ranking the data gaps by what closing them buys.
 *
 * The platform is honest about what it cannot measure. `driftReport` returns
 * seven regions refused with a reason rather than a verdict, `freshnessReport`
 * returns `never_run` and `broken` for feeds that have not delivered, and every
 * one of those refusals is a *finding* — "we could not compute this" — carried
 * with the evidence that produced it. What no surface did was order them. A
 * procurement officer holding the refusal list has no way to tell a gap whose
 * closure changes a decision from one whose closure adds a number nobody acts
 * on, so the list reads as a catalogue rather than a priority. This module
 * supplies the ordering.
 *
 * ── The measure, and why this one ───────────────────────────────────────────
 *
 * Two measures were admissible. This module computes **EVPI** — the expected
 * value of perfect information — over the gap's own distribution of possible
 * true values, weighted by the loss the decision carries. It is the standard
 * VoI construct and it is the right one here for three reasons that the
 * alternative does not share.
 *
 * 1. **The refusals are uncertainty distributions, not entropy.** A refused
 *    drift verdict is not a random variable with a known spread; it is a region
 *    whose window is too short to say anything. What a buyer is choosing is
 *    whether to *buy the measurement*, and the question EVPI answers is
 *    precisely "what is the value of resolving this uncertainty". Shannon
 *    information gain would require a prior and a likelihood over a quantity
 *    nobody has observed — it would put a probability distribution on the
 *    absence of a distribution, which is the same defect as inventing a number
 *    for an absent value. EVPI needs only the *range* the decision cares about,
 *    which this repo can state (the PSI bands, the freshness deadlines) without
 *    asserting anything about a posterior.
 *
 * 2. **EVPI is commensurable across heterogeneous gaps.** The gaps here are of
 *    different kinds — a drift verdict, a stale feed, a divergence that needs a
 *    model. An entropy reduction is measured in bits and cannot be added to
 *    another entropy reduction measured over a different alphabet; an EVPI is
 *    measured in the decision's own loss units and a dollar of avoided loss
 *    from one gap is the same dollar as from another. Ranking requires one unit.
 *
 * 3. **The loss is where the decision lives.** The requirement is to rank by
 *    "how much closing each would reduce decision loss", and loss is the
 *    operand. An information-gain measure weights by sensitivity as an
 *    afterthought; EVPI *is* the loss reduction, so the ranking is the answer
 *    rather than a proxy for it.
 *
 * ── EVPI over a gap, stated ─────────────────────────────────────────────────
 *
 * Let the decision be a threshold on a quantity `q` — a drift PSI, a source's
 * silence — and let `L(q)` be the loss of acting wrongly. The decision-maker
 * who does not know `q` takes the action minimising the loss at their best
 * estimate, and the expected loss is `E[L]`. A perfect measurement of `q` lets
 * them take the action minimising the loss at the true `q`, at expected loss
 * `E[min_a L(a, q)]`. EVPI is the difference:
 *
 *     EVPI = E[L(chosen without information)] − E[min_a L(a, q)]
 *
 * This module computes exactly that, with a uniform prior over a candidate range
 * — a prior stated on the record rather than hidden, because with no observation
 * there is no basis for a non-uniform one and asserting one would be inventing a
 * number. Two decision actions (act, or wait) and a threshold give a one-sided
 * loss: the blind decision-maker takes the do-nothing default, so the loss is
 * nonzero only where the true value sat on the far side of the threshold and the
 * default was wrong. The expectation of that loss over the uniform range is a
 * closed form (see `expectedValueOfPerfectInformation`), and it is EVPI because
 * perfect information drives the loss to zero at every point.
 *
 * EVPI is bounded above by the expected loss of acting blind, which is why the
 * ranking is dominated by the *loss* a gap's closure could avert and only
 * secondarily by how far the gap sits from a decision boundary. A gap whose
 * quantity is far from every threshold has a low EVPI even if its uncertainty
 * is large — and that is the correct procurement signal, not a bug: measuring
 * something no decision turns on buys nothing.
 *
 * ── The house rule ──────────────────────────────────────────────────────────
 *
 * An absent value is not zero. Every gap this module ranks carries a decision
 * threshold and a loss weight, and a gap whose threshold cannot be grounded in
 * something the repository states is **refused with a reason** rather than
 * ranked on an invented number — the same discipline as
 * `analytics.js`'s "an absent forecast is not a 0% chance of rain". A refusal is
 * returned in `refused`, never folded into the ranking as a zero, because a zero
 * EVPI and an uncomputable EVPI are opposite claims about a gap and a list that
 * shows them as one number is the defect this module exists to avoid.
 */

/**
 * The decision thresholds this module will rank against, each grounded in a
 * constant the repository already states.
 *
 * A threshold is the point at which the unmeasured action becomes wrong: below
 * the drift band, waiting on a monitor is free; above it, a region whose model
 * has moved is being scored by coefficients that no longer describe it and every
 * score issued from it is mispriced. The two drift thresholds are `drift.js`'s
 * own PSI bands; the freshness threshold is the deadline `freshness.js` already
 * measures an age against. Nothing here is a new convention — a threshold
 * invented for this module would be a decision boundary the platform does not
 * actually hold, and a ranking against a boundary nobody acts on is a ranking of
 * nothing.
 */
export const DECISION_THRESHOLDS = Object.freeze({
  // A PSI at or above the drift band means the model's coefficients no longer
  // describe the population, and the action "retrain or stop trusting the
  // score" is the one a blind decision-maker forgoes.
  input_shift: Object.freeze({ quantity: 'psi', threshold: 0.25, units: 'population stability index', source: 'drift.js PSI_DRIFT' }),
  // Divergence is the same decision at the same band, but over the observed
  // rate rather than the input distribution: the observed rate crossing the
  // predicted mean is where a blind operator keeps trusting a broken model.
  divergence: Object.freeze({ quantity: 'rate_gap', threshold: 0, units: 'absolute difference between observed and predicted rate', source: 'drift.js detectOutcomeDivergence' }),
  // A source older than its cadence is late, and the action "treat the feed as
  // current" is wrong from that day. The threshold is expressed in cadence
  // multiples so a source with a 730-day cadence is not ranked against a
  // daily one's deadline.
  freshness: Object.freeze({ quantity: 'cadence_multiple', threshold: 1, units: 'age as a multiple of the source cadence', source: 'freshness.js explainVerdict' }),
})

/**
 * A gap's loss weight, in the decision's own units, when the caller supplies
 * none. Deliberately uniform and stated: with no external weighting every gap
 * is worth the same per unit of decision error, so the ranking is driven by the
 * geometry of the gap against its threshold alone. A caller with a real cost
 * (a district's population, a funding envelope) passes `lossPerUnit` and the
 * ranking follows it — the default is the honest statement that this module has
 * no basis to weight one district's error above another's.
 */
export const DEFAULT_LOSS_PER_UNIT = 1

/**
 * Expected value of perfect information for one decision threshold.
 *
 * `range` is `{ low, high }`, the span of candidate true values the decision
 * would have to distinguish between — not a confidence interval, which would be
 * a claim about a posterior this module does not have. `threshold` is where the
 * action flips. `lossPerUnit` converts a decision error into the decision's own
 * units.
 *
 * The prior is uniform over `[low, high]`: with no observation there is no
 * basis for anything else, and stating the prior is what separates a modelled
 * number from an invented one. The blind action is the do-nothing default, so
 * the loss is `lossPerUnit * (q − threshold)` for `q` above the threshold and
 * zero below it — the default is only wrong on the far side. Over the uniform
 * prior the expectation of that one-sided loss is `lossPerUnit * (high −
 * threshold)² / (2 * (high − low))` when the threshold cuts the range, and
 * zero when the range sits wholly on the near side.
 *
 * A decision the blind action always gets right therefore has no value of
 * information, whatever the uncertainty — the range is pinned to the near side
 * and the default was never wrong. That is a real answer, not a refusal: the
 * uncertainty exists and its procurement value is nil.
 */
export function expectedValueOfPerfectInformation({ range, threshold, lossPerUnit = DEFAULT_LOSS_PER_UNIT } = {}) {
  const low = toNumber(range?.low, null)
  const high = toNumber(range?.high, null)
  const at = toNumber(threshold, null)
  const loss = toNumber(lossPerUnit, null)
  if (low === null || high === null || !(high > low)) {
    return { evpi: null, reason: 'no finite range to integrate over, so there is no uncertainty to price' }
  }
  if (at === null) {
    return { evpi: null, reason: 'no decision threshold, so no action flips and no loss can be averted' }
  }
  if (loss === null || loss <= 0) {
    return { evpi: null, reason: 'no positive loss per unit of decision error, so closing the gap averts nothing' }
  }
  const overshoot = Math.max(0, high - at)
  const evpi = loss * (overshoot ** 2) / (2 * (high - low))
  return {
    evpi: round4(evpi),
    range: { low: round4(low), high: round4(high) },
    threshold: round4(at),
    loss_per_unit: loss,
    // Named on the record so a reader can recompute it, and so a consumer knows
    // the ranking rests on a uniform prior rather than an estimate.
    prior: 'uniform over the candidate range, stated rather than estimated',
    reason: null,
  }
}

/**
 * The seven regions `driftReport` refuses, derived from a drift report.
 *
 * A region whose verdict is `not_measurable` is one the platform cannot say
 * anything about, and the refusal names the signal and the counts behind it. The
 * gap's quantity for ranking is how far the region's *evidence* sits from the
 * floor that would let it be measured — a region with 3 of 24 months is further
 * from measurement than one with 20, and its closure is worth more. The loss
 * weight is the region's exposure, passed by the caller, so a gap in a populous
 * district outranks the same gap in a sparsely populated one.
 *
 * `report` is a `driftReport(...)` result, or an object with the same `records`.
 */
export function driftGaps(report, { lossByRegion = {} } = {}) {
  const records = Array.isArray(report) ? report : (report?.records || [])
  const gaps = []
  for (const record of records) {
    if (record?.verdict !== 'not_measurable') continue
    const region = record.region_name ?? null
    const refusal = (record.honesty?.refused || [])[0] || 'no drift verdict is issued'
    // Which signal refused, and how short its evidence fell. Read off the
    // structured verdict objects, never parsed from the refusal prose — the
    // prose is for a reader, and a ranking that scraped numbers out of a
    // sentence would break the first time the sentence was edited.
    const input = record.input_shift || {}
    const divergence = record.outcome_divergence || {}
    let signal = null
    let shortfall = null
    let thresholdKey = null
    if (input.verdict === 'not_measurable') {
      signal = 'input_shift'
      thresholdKey = 'input_shift'
      const have = Math.min(toNumber(input.reference_months, 0), toNumber(input.current_months, 0))
      shortfall = clamp((MIN_DRIFT_WINDOW_MONTHS - have) / MIN_DRIFT_WINDOW_MONTHS, 0, 1)
    } else if (divergence.verdict === 'not_measurable') {
      signal = 'divergence'
      thresholdKey = 'divergence'
      const haveMonths = toNumber(divergence.months, 0)
      const haveEvents = toNumber(divergence.events, 0)
      const monthShort = clamp((MIN_DRIFT_WINDOW_MONTHS - haveMonths) / MIN_DRIFT_WINDOW_MONTHS, 0, 1)
      const eventShort = clamp((MIN_DRIFT_EVENTS - haveEvents) / MIN_DRIFT_EVENTS, 0, 1)
      shortfall = Math.max(monthShort, eventShort)
    } else {
      // A region can be `not_measurable` overall with neither signal refused —
      // not reachable through `detectDrift`, but the shape is returned rather
      // than assumed, and a gap with no named signal is refused below.
      signal = null
      shortfall = null
      thresholdKey = null
    }
    gaps.push({
      id: `drift:${region ?? 'unknown'}`,
      kind: 'drift',
      region,
      signal,
      thresholdKey,
      // How far the evidence sits from the floor, 0 (at the floor) to 1 (no
      // evidence at all). The candidate range for the quantity is the span the
      // decision cares about scaled by this, so a region with no evidence at
      // all is priced over the whole range and one at the floor over none.
      evidence_shortfall: shortfall === null ? null : round4(shortfall),
      loss_per_unit: toNumber(lossByRegion[region], DEFAULT_LOSS_PER_UNIT),
      reason: refusal,
    })
  }
  return gaps
}

/**
 * Freshness gaps: every source whose verdict is a failure to deliver.
 *
 * A source that has never run, or whose last run failed, or that has returned
 * empty twice running, is a gap in the record — the platform is scoring districts
 * from a feed that is not arriving. `verdict` and `reason` travel as
 * `freshnessReport` returned them; the loss weight is the source's declared
 * contribution to the decision, passed by the caller.
 */
export function freshnessGaps(report, { lossBySource = {} } = {}) {
  const rows = Array.isArray(report) ? report : []
  const gaps = []
  for (const row of rows) {
    if (!row || !['never_run', 'broken', 'empty_response'].includes(row.verdict)) continue
    const cadence = toNumber(row.cadence_days, null)
    gaps.push({
      id: `freshness:${row.source}`,
      kind: 'freshness',
      source: row.source,
      verdict: row.verdict,
      thresholdKey: 'freshness',
      // A source with no cadence deadline can be broken but cannot be late, so
      // it has no multiple-of-cadence quantity and is ranked on its delivery
      // failure alone rather than against a deadline it does not have.
      cadence_days: cadence,
      // `never_run` is a total absence — the whole range is unknown — and
      // `empty_response` a partial one, so the two are priced differently and
      // the difference is stated rather than folded into one number.
      evidence_shortfall: row.verdict === 'never_run' ? 1
        : row.verdict === 'broken' ? 0.75
          : 0.5,
      loss_per_unit: toNumber(lossBySource[row.source], DEFAULT_LOSS_PER_UNIT),
      reason: row.reason || null,
    })
  }
  return gaps
}

/**
 * Rank gaps by the expected reduction in decision loss closing each would buy.
 *
 * `gaps` is the list from `driftGaps` and `freshnessGaps` (or a caller's own,
 * carrying the same fields). For each gap with a decision threshold this module
 * can ground, it computes the EVPI of resolving the gap and returns the list
 * sorted by it, descending. A gap whose threshold cannot be grounded — an
 * unknown `thresholdKey`, a missing evidence shortfall, a region or source the
 * thresholds do not cover — is **refused with a reason** and placed in
 * `refused`, never ranked as a zero.
 *
 * `totalEvpi` is the sum over the ranked gaps: the value of closing *every*
 * gap at once, which is an upper bound on any subset and is reported so a
 * reader can see the whole prize rather than one row at a time.
 */
export function rankDataGaps(gaps = []) {
  const ranked = []
  const refused = []
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    const threshold = DECISION_THRESHOLDS[gap?.thresholdKey]
    if (!threshold) {
      refused.push({ id: gap?.id ?? null, reason: `no decision threshold is grounded for "${gap?.thresholdKey ?? 'unknown'}", so the gap cannot be priced against an action` })
      continue
    }
    const shortfall = toNumber(gap?.evidence_shortfall, null)
    if (shortfall === null) {
      refused.push({ id: gap?.id ?? null, reason: 'no evidence shortfall recorded, so there is nothing to say about how far the gap sits from measurement' })
      continue
    }
    // The candidate range is the threshold's own scale: a PSI spans 0 to the
    // drift band and beyond, a cadence multiple spans 0 to 2 deadlines. A gap
    // with no evidence covers the whole range; one at the floor covers none,
    // because closing a gap already measured averts nothing.
    const span = spanFor(threshold)
    const range = { low: threshold.threshold - span, high: threshold.threshold + span }
    const priced = expectedValueOfPerfectInformation({
      range,
      threshold: threshold.threshold,
      lossPerUnit: gap.loss_per_unit,
    })
    if (priced.evpi === null) {
      refused.push({ id: gap?.id ?? null, reason: priced.reason })
      continue
    }
    ranked.push({
      id: gap.id,
      kind: gap.kind,
      region: gap.region ?? null,
      source: gap.source ?? null,
      signal: gap.signal ?? null,
      decision: threshold.quantity,
      threshold: threshold.threshold,
      threshold_source: threshold.source,
      evidence_shortfall: round4(shortfall),
      // Weighted by the shortfall: a gap whose evidence nearly reaches the
      // floor has most of its uncertainty already resolved, so the perfect
      // information still on the table is the fraction that remains.
      evpi: round4(priced.evpi * shortfall),
      loss_per_unit: gap.loss_per_unit,
      reason: gap.reason ?? null,
    })
  }
  ranked.sort((a, b) => (b.evpi - a.evpi) || String(a.id).localeCompare(String(b.id)))
  return {
    gaps: ranked,
    refused,
    ranked: ranked.length,
    refused_count: refused.length,
    total_evpi: round4(ranked.reduce((sum, row) => sum + row.evpi, 0)),
    measure: 'expected value of perfect information over a uniform prior on the gap\'s candidate range, weighted by the decision loss per unit and the fraction of the range still unmeasured',
    limit: 'The ranking is a procurement order, not a forecast: it says which measurement is worth buying first, and it rests on a uniform prior over each gap\'s candidate range because no observation supports another. The loss per unit is the caller\'s, and a gap with no grounded threshold is refused rather than ranked at zero.',
    basis: {
      thresholds: Object.fromEntries(Object.entries(DECISION_THRESHOLDS).map(([k, v]) => [k, v.source])),
      sources_considered: SOURCE_IDS.length,
      prior: 'uniform over each gap\'s candidate range, stated rather than estimated',
    },
  }
}

/**
 * How far a threshold's quantity is worth ranging, per threshold.
 *
 * A PSI is read against its own drift band, so the range is 0 to twice the band
 * — the far side being "materially drifted". A rate gap spans one predicted
 * mean either way. A cadence multiple spans 0 to two deadlines. Each is a
 * judgment, stated here rather than buried, and each is reversible by editing
 * this table.
 */
function spanFor(threshold) {
  if (threshold.quantity === 'psi') return threshold.threshold
  if (threshold.quantity === 'rate_gap') return 0.5
  if (threshold.quantity === 'cadence_multiple') return 1
  return threshold.threshold
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}
