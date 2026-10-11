/**
 * ENH-56 — compound-hazard risk: flood and conflict, jointly.
 *
 * `computeFloodRisk` and `computeClimateConflictRisk` each score a region in
 * isolation. A planner who has both numbers still has to decide what to do with
 * them, and the natural move — add them, or take the worse — silently assumes
 * the two hazards are independent. They are not. A flood that cuts the B4 supply
 * route and a clash on the Mandera road are the same operational problem: a
 * convoy that cannot move. Treating them as independent understates the risk of
 * a district where both are high, and a planner who pre-positions against
 * whichever score is larger prepares for one of the two.
 *
 * **What this computes, and what it refuses to.** The dependence is *empirical*,
 * the same discipline as `flood-probability.js`: months are classified as
 * flood-months and conflict-months from the events actually recorded, and the
 * joint and marginal rates are counted. The statement of dependence is the lift
 * — the joint rate divided by the product of the marginals. Lift 1 is
 * independence, which the data can report; lift above 1 is co-occurrence beyond
 * chance. Nothing is fitted and nothing is extrapolated: a region with too few
 * months to count is **refused with a reason**, not given a modelled number,
 * because a copula fitted to eight months is a curve drawn through noise and it
 * would carry the authority of a probability.
 *
 * **Why months, and why the count is the honest denominator.** The hazards are
 * seasonal on the same calendar, so a joint rate over events would count a
 * single rainy season once per event in it. Months are the unit
 * `flood-probability.js` already uses, and for the same reason: consecutive
 * months are correlated through the season, which is a limitation this module
 * states rather than hides.
 */

/** A region needs this many months before a joint rate is reported at all. */
export const MIN_COMPOUND_MONTHS = 12

/**
 * The hazard family the flood marginal counts, named rather than left to a
 * regex in the middle of a function.
 *
 * GDACS classifies a pull into flood, storm, landslide, drought, earthquake,
 * fire and volcano, plus a `disaster` bucket for codes it cannot map. Only
 * flood and storm belong here: both are rainfall-driven, both put a road under
 * water, and a planner stages against them the same way. Landslide and drought
 * are climate hazards that are *not* flood-like — a drought-month is the
 * opposite of a flood-month — and fire, earthquake and volcano have no water in
 * them at all. Counting any of them as a flood-month would inflate the joint
 * rate with months that share nothing with a flood except a wet season.
 *
 * `disaster` is included because GDACS emits it precisely when it could not
 * classify, and the events it lands on are dominated by the weather codes it
 * failed to parse. It is a judgment, it is stated here, and it is one a reader
 * can reverse by editing this list.
 */
const FLOOD_FAMILY = Object.freeze(['flood', 'storm', 'disaster'])

/** `YYYY-MM` for an ISO timestamp, or null. */
function monthOf(value) {
  if (typeof value !== 'string') return null
  const key = value.slice(0, 7)
  return /^\d{4}-\d{2}$/.test(key) ? key : null
}

/**
 * The month keys a series of events touches, as a set.
 *
 * An event with no readable date contributes no month. It is not silently dated
 * to the epoch or to "now": either would put a phantom month in the denominator
 * and move every rate computed from it.
 */
function monthsTouched(events, isMember) {
  const months = new Set()
  for (const event of events || []) {
    if (!isMember(event)) continue
    // `occurred_at` is the hazard/conflict shape; disease records carry
    // `observed_at` (`reliefweb-epidemics.js`). Reading only the first would
    // count zero disease-months and report the third hazard as absent — a
    // refusal that looks like a finding about the data and is a bug in the
    // reader.
    const key = monthOf(event.occurred_at) || monthOf(event.observed_at)
    if (key) months.add(key)
  }
  return months
}

/**
 * The joint contingency over months: flood-months, conflict-months, both.
 *
 * Counts in, counts out — the shape `contingencyCount` established, for the same
 * reason. `lift` is the one derived number and it is named so a reader can
 * recompute it: `p(both) / (p(flood) * p(conflict))`, and it is null when either
 * marginal is zero, because a lift over a hazard that never occurred is a ratio
 * with no denominator, not a small number.
 */
export function compoundContingency({ hazardEvents = [], conflictEvents = [], from = null, to = null } = {}) {
  const floods = monthsTouched(hazardEvents, (e) => FLOOD_FAMILY.includes(String(e.event_type || '').toLowerCase()))
  const conflicts = monthsTouched(conflictEvents, () => true)

  // The denominator is every month in the window, including the quiet ones. A
  // rate over only the months that had *something* would be a rate over a set
  // selected by the outcome, which is the base-rate error this module exists to
  // avoid.
  const months = new Set([...floods, ...conflicts])
  // The denominator is every month in the window, including the quiet ones. A
  // rate over only the months that had *something* would be a rate over a set
  // selected by the outcome, which is the base-rate error this module exists to
  // avoid. With no declared window the span is therefore drawn from the first
  // touched month to the last, quiet months in between included — the first
  // version used the touched months themselves as the denominator and reported
  // every region as more compound-risky than its own calendar supports.
  const touched = [...months].sort()
  const declared = monthsInWindow(from, to)
  const denominator = declared.length ? declared : monthsInWindow(touched[0], touched[touched.length - 1])
  const n = denominator.length

  const floodMonths = denominator.filter((m) => floods.has(m)).length
  const conflictMonths = denominator.filter((m) => conflicts.has(m)).length
  const bothMonths = denominator.filter((m) => floods.has(m) && conflicts.has(m)).length

  const pFlood = n ? floodMonths / n : null
  const pConflict = n ? conflictMonths / n : null
  const pBoth = n ? bothMonths / n : null
  // The product of the marginals is what independence predicts. Guarded against
  // a zero marginal rather than allowed to divide: `0/0` is NaN and would render
  // as "no dependence" if anything coerced it.
  const independent = pFlood !== null && pConflict !== null && pFlood > 0 && pConflict > 0 ? pFlood * pConflict : null

  return {
    months: n,
    flood_months: floodMonths,
    conflict_months: conflictMonths,
    both_months: bothMonths,
    p_flood: pFlood === null ? null : round4(pFlood),
    p_conflict: pConflict === null ? null : round4(pConflict),
    p_both: pBoth === null ? null : round4(pBoth),
    p_both_if_independent: independent === null ? null : round4(independent),
    lift: independent ? round4(pBoth / independent) : null,
    window: { from: denominator[0] || null, to: denominator[n - 1] || null },
  }
}

/**
 * The compound score for one region, or a refusal.
 *
 * Returns `{score, level, basis, reason}`. When the window holds fewer than
 * `MIN_COMPOUND_MONTHS` months the score is `null` and `reason` says so — the
 * same shape the platform uses everywhere an input is too thin to answer from.
 *
 * The score is the **joint** probability of a flood-month and a conflict-month
 * meeting, expressed as a 0–100 index, and it is deliberately *not* the sum of
 * the two independent scorers. Two regions with identical marginals but
 * different lift get different compound scores, which is the whole point: the
 * dependence is the information the independent scores discard.
 */
export function compoundHazardScore({ hazardEvents = [], conflictEvents = [], from = null, to = null, region = null } = {}) {
  const contingency = compoundContingency({ hazardEvents, conflictEvents, from, to })
  if (contingency.months < MIN_COMPOUND_MONTHS) {
    return {
      region,
      score: null,
      level: 'unknown',
      contingency,
      reason: `${contingency.months} month(s) of record; ${MIN_COMPOUND_MONTHS} are needed before a joint rate is reported rather than a curve through noise`,
    }
  }
  if (contingency.p_flood === 0 || contingency.p_conflict === 0) {
    // One hazard never occurred in the window. The joint rate is then zero by
    // construction and reporting a "compound risk" of zero would read as "safe"
    // when it means "this window contains no instance of one of the two".
    const absent = contingency.p_flood === 0 ? 'flood' : 'conflict'
    return {
      region,
      score: null,
      level: 'unknown',
      contingency,
      reason: `no ${absent}-month in this window, so the joint rate is undefined rather than zero`,
    }
  }

  // The compound index is the joint rate scaled to 0-100, with the *excess* over
  // independence carried explicitly in the basis. `p_both` is what a planner
  // stages against; the lift is why it is larger than the marginals suggest.
  const score = clamp(Math.round(contingency.p_both * 100), 0, 100)
  return {
    region,
    score,
    level: levelFor(score),
    contingency,
    basis: {
      description: 'joint rate of a flood-month and a conflict-month meeting, counted over calendar months — not the sum of the two independent scorers',
      joint_months: contingency.both_months,
      of_months: contingency.months,
      lift_over_independence: contingency.lift,
      // Stated so a reader cannot mistake the number for a probabilistic
      // interval. It is a rate over a counted window, and the window is named.
      window: contingency.window,
    },
    reason: null,
  }
}

/** The months between two `YYYY-MM` bounds, inclusive, or [] if either is unreadable. */
function monthsInWindow(from, to) {
  const start = monthOf(from)
  const end = monthOf(to)
  if (!start || !end || start > end) return []
  const months = []
  let [y, m] = start.split('-').map(Number)
  const [endY, endM] = end.split('-').map(Number)
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

function levelFor(score) {
  if (score >= 60) return 'critical'
  if (score >= 35) return 'high'
  if (score >= 15) return 'medium'
  return 'low'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * ENH-56, third hazard — the joint rate of all three, not a pairwise score.
 *
 * The entry names three hazards and the module above counts two. This adds
 * disease, and it is a **separate function** rather than a third optional
 * argument to `compoundHazardScore`, for a reason that is not stylistic: making
 * disease optional would leave the existing two-hazard callers returning
 * `p_disease === 0`, which is exactly the condition that already refuses with
 * "no disease-month in this window". Every caller would have gone from a score
 * to a refusal. A second entry point keeps the two-hazard contract intact and
 * states the three-hazard one on its own terms.
 *
 * **What the joint means here.** With three hazards the lift is no longer a
 * single ratio a reader can check by eye, so the module reports the whole
 * contingency — all seven month-classes (each hazard alone, each pair, all
 * three, none) — and computes the lift of the triple against the product of the
 * three marginals. The pairwise lifts are carried too, because a planner acting
 * on this needs to know *which* pair is driving the excess.
 *
 * **The disease input is shaped differently and that is the whole difficulty.**
 * `reliefweb_epidemics` records carry `observed_at` and a real event date;
 * `who_gho` records carry `observed_at` stamped `YYYY-01-01` for a *national
 * annual aggregate*, with `first_seen_source_type: 'national_annual_aggregate'`.
 * Feeding the second kind through a month counter would manufacture a January
 * disease-month every year of the series and inflate the joint rate with months
 * that share nothing but a calendar. So an annual aggregate is excluded, and it
 * is excluded **visibly**: `excluded_annual_aggregates` is returned, because a
 * silently dropped input is a denominator nobody can check.
 *
 * The same rule as the flood family applies and is stated rather than implied:
 * disease records with no readable date contribute no month, rather than being
 * dated to the epoch or to now.
 */
export function compoundHazardScoreThree({ hazardEvents = [], conflictEvents = [], diseaseEvents = [], from = null, to = null, region = null } = {}) {
  const floods = monthsTouched(hazardEvents, (e) => FLOOD_FAMILY.includes(String(e.event_type || '').toLowerCase()))
  const conflicts = monthsTouched(conflictEvents, () => true)

  // The annual-aggregate exclusion, counted so it can be reported.
  let annualAggregates = 0
  const diseases = monthsTouched(diseaseEvents, (e) => {
    if (isAnnualAggregate(e)) { annualAggregates += 1; return false }
    return true
  })

  const touched = [...new Set([...floods, ...conflicts, ...diseases])].sort()
  const declared = monthsInWindow(from, to)
  const denominator = declared.length ? declared : monthsInWindow(touched[0], touched[touched.length - 1])
  const n = denominator.length

  const count = (set) => denominator.filter((m) => set.has(m)).length
  const floodMonths = count(floods)
  const conflictMonths = count(conflicts)
  const diseaseMonths = count(diseases)
  const bothFC = denominator.filter((m) => floods.has(m) && conflicts.has(m)).length
  const bothFD = denominator.filter((m) => floods.has(m) && diseases.has(m)).length
  const bothCD = denominator.filter((m) => conflicts.has(m) && diseases.has(m)).length
  const allThree = denominator.filter((m) => floods.has(m) && conflicts.has(m) && diseases.has(m)).length

  const rate = (c) => (n ? round4(c / n) : null)
  const pFlood = n ? floodMonths / n : null
  const pConflict = n ? conflictMonths / n : null
  const pDisease = n ? diseaseMonths / n : null
  const pAll = n ? allThree / n : null

  // The product of three marginals is what independence predicts for the
  // triple. Guarded the same way the pair is: a zero marginal makes the lift a
  // ratio with no denominator, not a large number.
  const independentAll = [pFlood, pConflict, pDisease].every((p) => p !== null && p > 0)
    ? pFlood * pConflict * pDisease
    : null
  // Pairwise, so a reader can see which pair drives the excess. Each is guarded
  // on its own two marginals rather than on all three.
  const pairLift = (a, b, pab) => (a > 0 && b > 0 && pab !== null ? round4(pab / (a * b)) : null)

  const contingency = {
    months: n,
    flood_months: floodMonths,
    conflict_months: conflictMonths,
    disease_months: diseaseMonths,
    all_three_months: allThree,
    both_flood_conflict_months: bothFC,
    both_flood_disease_months: bothFD,
    both_conflict_disease_months: bothCD,
    p_flood: rate(floodMonths),
    p_conflict: rate(conflictMonths),
    p_disease: rate(diseaseMonths),
    p_all_three: rate(allThree),
    p_all_three_if_independent: independentAll === null ? null : round4(independentAll),
    lift_all_three: independentAll ? round4(pAll / independentAll) : null,
    pair_lifts: {
      flood_conflict: pairLift(pFlood, pConflict, n ? bothFC / n : null),
      flood_disease: pairLift(pFlood, pDisease, n ? bothFD / n : null),
      conflict_disease: pairLift(pConflict, pDisease, n ? bothCD / n : null),
    },
    window: { from: denominator[0] || null, to: denominator[n - 1] || null },
    excluded_annual_aggregates: annualAggregates,
  }

  if (n < MIN_COMPOUND_MONTHS) {
    return {
      region, score: null, level: 'unknown', contingency,
      reason: `${n} month(s) of record; ${MIN_COMPOUND_MONTHS} are needed before a joint rate is reported rather than a curve through noise`,
    }
  }
  // Each hazard is checked separately and named. With three, "no hazard-month"
  // would not say which one is absent, and the three have different remedies —
  // a window with no disease is a surveillance gap, one with no flood is a dry
  // record, and a planner acts differently on each.
  const absent = [['flood', floodMonths], ['conflict', conflictMonths], ['disease', diseaseMonths]]
    .filter(([, c]) => c === 0)
    .map(([name]) => name)
  if (absent.length) {
    return {
      region, score: null, level: 'unknown', contingency,
      reason: `no ${absent.join(' or ')}-month in this window, so the joint rate is undefined rather than zero`,
    }
  }

  const score = clamp(Math.round((allThree / n) * 100), 0, 100)
  return {
    region,
    score,
    level: levelFor(score),
    contingency,
    basis: {
      description: 'joint rate of a flood-month, a conflict-month and a disease-month meeting in the same calendar month — not the sum of three independent scorers, and not a pairwise score',
      joint_months: allThree,
      of_months: n,
      lift_over_independence: contingency.lift_all_three,
      pair_lifts: contingency.pair_lifts,
      window: contingency.window,
    },
    reason: null,
  }
}

/**
 * A national annual aggregate, which has a year and no month.
 *
 * The WHO Global Health Observatory emits one row per country per year and
 * stamps it `YYYY-01-01`. That is not a January observation; it is an annual
 * total wearing a date, and a month counter that accepts it puts a disease-month
 * in every January of the series. `who-gho.js` marks these with
 * `first_seen_source_type`, and the marker is what this reads.
 */
function isAnnualAggregate(event) {
  return String(event?.first_seen_source_type || '') === 'national_annual_aggregate'
}

function round4(x) {
  return Math.round(x * 10000) / 10000
}
