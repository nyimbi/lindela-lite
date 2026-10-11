import { haversineKm } from './utils.js'
import { numericOrNull } from './analytics/numeric.js'
import { computeRoadAccess } from './road-access.js'
import { DEFAULT_SEED, seededRng } from './counterfactual.js'

// The default seed is part of this module's contract — a stored plan is
// re-derivable only if a caller can name the seed the default draws used — so it
// is re-exported rather than left to be imported from the module that happens to
// own the generator.
export { DEFAULT_SEED }

/**
 * ENH-53 — resource pre-positioning optimiser.
 *
 * The question a relief coordinator asks before a flood season is not "how risky
 * is this district" but "where do I put the stock". Those are different
 * questions and the second has an answer the first cannot give: a district can
 * be the riskiest on the board and still be the wrong place to stage from,
 * because the road that would carry the stock is the same one the flood closes.
 *
 * **The failure this module is built to avoid is the point estimate.** The
 * platform carries a *distribution* over the future — `flood-probability.js`
 * publishes a probability with a Wilson interval, `compound-hazard.js` a joint
 * rate over counted months — and most surfaces downstream collapse it to a mean
 * before acting on it. An allocation sized to the mean demand is correct only
 * when demand is certain. When it is not, the mean is the one number that throws
 * away the information the shortfall depends on: `E[max(0, D − a)]` is convex in
 * `D`, so two districts with the same mean demand but different spread have
 * different expected unmet demand at the same stock level, and a planner who
 * stages to the mean under-prepares exactly where the tail is fattest.
 *
 * **What is computed, and what is refused.** Demand is carried as an explicit
 * scenario set — a probability and a demand vector per scenario — because that
 * is the only representation of "a distribution over demand" the platform can
 * honestly hold: the *magnitude* of need when a hazard lands is not measured
 * anywhere (0 of the 34 service assets in the live store carry a served
 * population), so this module will not invent one. It composes the distribution
 * from what it is given — a per-site demand distribution and, optionally, the
 * forecast's hazard probability — and it **refuses** a site with no distribution
 * rather than reading the absence as zero demand. An absent value is not zero.
 *
 * **Transport comes from the road network, not a great-circle line.**
 * `computeRoadAccess` scores every road against the hazards on it and classifies
 * it `open` / `constrained` / `severely_constrained` / `cut_off`. A demand
 * site's route reliability is the *level* of the nearest road that serves it,
 * inside `ROAD_LINK_RADIUS_KM` — the level rather than the raw score, because
 * the decision "can a convoy move on this" is the level and the score's fine
 * gradations are not calibrated to delivery. A site with no road within that
 * radius is refused: "no road recorded" is not "reachable by road", and a
 * stockpile that cannot be moved is not pre-positioning.
 *
 * **The allocation is a greedy marginal allocation on a separable convex
 * objective**, which is optimal for it. With `A_k` the stock delivered to group
 * `k`, `E[unmet] = Σ_k E[max(0, G_k − A_k)]` is convex and decreasing in each
 * `A_k`, so at every step the next budget chunk goes to the group where it buys
 * the largest reduction — `r_k · P(G_k > A_k)` per unit staged. The result is
 * reported beside the **proportional-to-mean** allocation, the naive plan that
 * sizes each staging site to its share of mean demand, so the improvement is a
 * measured number rather than a claim.
 */

/**
 * How near a demand site must be to a scored road for a route to exist.
 *
 * Beyond it the site is refused rather than assumed reachable. The registry's
 * own boundaries are centre-and-radius at 150–200 km, so a district whose only
 * road is 50 km away is a district whose road we cannot see, not one without
 * roads.
 */
export const ROAD_LINK_RADIUS_KM = 50

/** Scenario draws when the caller supplies a per-site distribution rather than a scenario set. */
export const DEFAULT_DRAWS = 2000

/** Budget discretisation for the greedy allocator. Finer is slower and closer to the continuous optimum. */
export const DEFAULT_STEPS = 400

/** Probabilities must sum to one; this is the tolerance a float sum is allowed. */
const PROBABILITY_TOLERANCE = 1e-6

/**
 * What fraction of the stock aimed at a site actually arrives, by the road's
 * own classification.
 *
 * A `cut_off` road carries nothing — not "a little" — because the level is
 * `computeRoadAccess`'s judgement that the segment is impassable, and a
 * pre-positioning plan that ships to an impassable road is a plan that loses the
 * stock. The intermediate levels are the fraction of a convoy a constrained
 * route is expected to pass, stated as a call a reader can challenge.
 */
export const ROUTE_RELIABILITY_BY_LEVEL = Object.freeze({
  open: 1,
  constrained: 0.6,
  severely_constrained: 0.3,
  cut_off: 0,
})

/** A site's code, from the field names the registry and the records actually use. */
function siteCode(site) {
  const code = site?.code ?? site?.unit_code ?? site?.id ?? null
  return code === null || code === undefined ? null : String(code)
}

/** A point a distance can be measured from, or null. */
function pointOf(site) {
  const latitude = numericOrNull(site?.latitude ?? site?.center?.lat)
  const longitude = numericOrNull(site?.longitude ?? site?.center?.lon)
  if (latitude === null || longitude === null) return null
  return { latitude, longitude }
}

/** The route reliability of a road-access record: its level, mapped. Null when the level is unknown. */
export function routeReliability(record) {
  if (!record) return null
  const level = record.access_level
  return level in ROUTE_RELIABILITY_BY_LEVEL ? ROUTE_RELIABILITY_BY_LEVEL[level] : null
}

/** The nearest scored road to a point inside `radiusKm`, with its distance, or null. */
function nearestRoad(point, roads, radiusKm) {
  let best = null
  for (const road of roads) {
    const roadPoint = pointOf(road)
    if (!roadPoint) continue
    const distanceKm = haversineKm(point, roadPoint)
    if (distanceKm <= radiusKm && (best === null || distanceKm < best.distance_km)) {
      best = { road, distance_km: distanceKm }
    }
  }
  return best
}

/**
 * Validate a per-site demand distribution: a list of `{probability, units}` that
 * sums to one. Returns the normalised points, or null for anything it cannot
 * vouch for — including an absent distribution, which is a refusal rather than a
 * demand of zero.
 */
function normaliseDistribution(distribution) {
  if (!Array.isArray(distribution) || distribution.length === 0) return null
  const points = []
  let total = 0
  for (const point of distribution) {
    const probability = numericOrNull(point?.probability)
    const units = numericOrNull(point?.units)
    if (probability === null || units === null || probability < 0 || units < 0) return null
    total += probability
    points.push({ probability, units })
  }
  return Math.abs(total - 1) <= PROBABILITY_TOLERANCE ? points : null
}

/** Draw a value from a normalised distribution. */
function sampleUnits(points, rng) {
  let draw = rng()
  for (const point of points) {
    draw -= point.probability
    if (draw <= 0) return point.units
  }
  return points[points.length - 1].units
}

/**
 * Build a joint scenario set from per-site distributions, by independent
 * sampling with a seeded RNG.
 *
 * This is where the forecast distribution enters. A site may carry a
 * `hazardProbability` — the point probability `flood-probability.js` or
 * `compound-hazard.js` publishes — in which case the site is dry with
 * probability `1 − p` and its demand distribution is the conditional one. The
 * seed makes the draw reproducible run to run; without it the allocation would
 * differ between two runs over identical data and a stored plan could not be
 * re-derived. Returns `{scenarios, refusal, reason}` so the caller can tell a
 * sampled set from a refused one.
 */
export function demandScenarios({ demandSites = [], seed = DEFAULT_SEED, draws = DEFAULT_DRAWS } = {}) {
  const rng = seededRng(seed)
  const prepared = []
  for (const site of demandSites) {
    const code = siteCode(site)
    const points = normaliseDistribution(site?.demandDistribution)
    if (!points) {
      return {
        scenarios: null,
        refusal: 'unmodelled_demand',
        reason: `demand site ${code ?? '(unidentified)'} carries no demand distribution, so its need is unmodelled rather than zero`,
      }
    }
    prepared.push({ code, points, hazardProbability: numericOrNull(site?.hazardProbability) })
  }

  const count = Math.max(1, Math.floor(draws))
  const scenarios = []
  for (let i = 0; i < count; i += 1) {
    const demand = {}
    for (const site of prepared) {
      if (site.hazardProbability !== null && rng() >= site.hazardProbability) {
        demand[site.code] = 0
        continue
      }
      demand[site.code] = sampleUnits(site.points, rng)
    }
    scenarios.push({ probability: 1 / count, demand })
  }
  return { scenarios, refusal: null, reason: null }
}

/**
 * Validate an explicit scenario set against the demand-site codes.
 *
 * A scenario enumerates the demand it carries; a code it does not name has no
 * demand in that scenario. Probabilities must sum to one — an unweighted set is
 * a set with no distribution in it, and reading it as uniform would be inventing
 * the weights.
 */
function normaliseScenarios(scenarios, codes) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return null
  const normalised = []
  let total = 0
  for (const scenario of scenarios) {
    const probability = numericOrNull(scenario?.probability)
    if (probability === null || probability < 0 || typeof scenario?.demand !== 'object' || scenario.demand === null) return null
    const demand = {}
    for (const code of codes) {
      const units = numericOrNull(scenario.demand[code])
      demand[code] = units === null ? 0 : units
    }
    total += probability
    normalised.push({ probability, demand })
  }
  return Math.abs(total - 1) <= PROBABILITY_TOLERANCE ? normalised : null
}

/** Expected unmet demand for one group's demand series at a delivered stock level. */
export function expectedShortfall(series, delivered) {
  let total = 0
  for (const point of series) {
    const shortfall = point.demand - delivered
    if (shortfall > 0) total += point.probability * shortfall
  }
  return total
}

/** A group's demand per scenario, as a series of `{probability, demand}`, from its member codes. */
function groupSeries(scenarios, codes) {
  return scenarios.map((scenario) => {
    let demand = 0
    for (const code of codes) demand += scenario.demand[code] || 0
    return { probability: scenario.probability, demand }
  })
}

/** The mean demand of a series. */
function seriesMean(series) {
  let total = 0
  for (const point of series) total += point.probability * point.demand
  return total
}

/**
 * Greedy marginal allocation of `budget` across groups, minimising
 * `Σ_k E[max(0, G_k − r_k·s_k)]`.
 *
 * Each step spends one `budget/steps` chunk at the staging site where it buys
 * the largest reduction in that group's expected shortfall. The objective is
 * separable and convex, so the greedy is optimal for it: a chunk's marginal
 * value at a site falls as the site fills, which is what drives the budget to
 * spread rather than pile up. Ties break to the lowest group index, so the
 * result is deterministic.
 */
export function optimiseAllocation({ groupSeries: series, reliability, budget, steps = DEFAULT_STEPS } = {}) {
  const count = series.length
  const stock = new Array(count).fill(0)
  const delivered = new Array(count).fill(0)
  const chunk = budget / Math.max(1, Math.floor(steps))

  for (let step = 0; step < steps; step += 1) {
    let bestIndex = -1
    let bestGain = 0
    for (let k = 0; k < count; k += 1) {
      const rate = reliability[k]
      if (!(rate > 0)) continue
      const gain = expectedShortfall(series[k], delivered[k])
        - expectedShortfall(series[k], delivered[k] + rate * chunk)
      if (gain > bestGain + 1e-12) {
        bestGain = gain
        bestIndex = k
      }
    }
    // No remaining chunk buys any reduction — every group is covered or cut off.
    // Stopping leaves the remainder unallocated, which the ≤ budget constraint
    // permits and which is the honest answer rather than staging stock nowhere.
    if (bestIndex === -1) break
    stock[bestIndex] += chunk
    delivered[bestIndex] += reliability[bestIndex] * chunk
  }

  return { stock, delivered }
}

/**
 * The naive alternative: stock sized to each group's share of mean demand.
 *
 * This is the plan a mean-only planner produces. It reads one number per group
 * and never looks at the spread behind it or at whether the road can carry what
 * it stages. Evaluated with the same physical delivery, so the comparison is
 * between two allocations and not two models.
 */
export function naiveAllocation({ groupSeries: series, reliability, budget } = {}) {
  const means = series.map(seriesMean)
  const total = means.reduce((sum, value) => sum + value, 0)
  const stock = means.map((mean) => (total > 0 ? (budget * mean) / total : 0))
  const delivered = stock.map((value, k) => value * reliability[k])
  return { stock, delivered, means }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** The refusal shape. Null-valued fields, so a caller cannot read a missing plan as a zero-cost one. */
function refuse(reason, message, extra = {}) {
  return {
    allocation: null,
    expected_unmet: null,
    naive_expected_unmet: null,
    improvement: null,
    transport: [],
    groups: [],
    scenarios: null,
    refusal: reason,
    reason: message,
    ...extra,
  }
}

/**
 * Plan where to stage stock, minimising expected unmet demand.
 *
 * See the module header for the model. Returns the allocation, the expected
 * unmet demand it achieves, the expected unmet demand of the proportional-to-mean
 * allocation, and the improvement between them — or a refusal with a reason where
 * an input the answer depends on is absent.
 */
export function planPrepositioning({
  demandSites = [],
  stagingSites = [],
  budget = null,
  data = {},
  now = undefined,
  scenarios = null,
  seed = DEFAULT_SEED,
  draws = DEFAULT_DRAWS,
  steps = DEFAULT_STEPS,
} = {}) {
  const budgetValue = numericOrNull(budget)
  if (budgetValue === null || budgetValue <= 0) {
    return refuse('unusable_budget', 'a stock budget is required to allocate; the plan has nothing to place without one')
  }
  if (!Array.isArray(demandSites) || demandSites.length === 0) {
    return refuse('no_demand_sites', 'no demand sites were supplied, so there is no demand to minimise unmet against')
  }
  const staging = (stagingSites || []).map((site) => ({ code: siteCode(site), point: pointOf(site), raw: site }))
    .filter((site) => site.code !== null && site.point !== null)
  if (staging.length === 0) {
    return refuse('no_staging_sites', 'no candidate staging site carries both a code and a coordinate')
  }

  // The road network: every road scored against the hazards on it. This is the
  // transport substrate — without a road near a demand site there is no route to
  // compute a cost from.
  const roads = computeRoadAccess(data, now === undefined ? {} : { now })
  const codes = []
  const demandMeta = []
  for (const site of demandSites) {
    const code = siteCode(site)
    if (code === null) return refuse('unidentified_demand_site', 'a demand site carries no code, so its allocation could not be reported')
    const point = pointOf(site)
    if (!point) return refuse('unlocated_demand_site', `demand site ${code} carries no coordinate, so no route can be measured to it`)
    const link = nearestRoad(point, roads, ROAD_LINK_RADIUS_KM)
    if (!link) {
      return refuse(
        'unroutable_demand',
        `no scored road lies within ${ROAD_LINK_RADIUS_KM} km of demand site ${code}; an unrecorded road is not a clear one, so its transport cost is unknown rather than zero`,
      )
    }
    const reliability = routeReliability(link.road)
    if (reliability === null) {
      return refuse('unscored_road', `the road serving demand site ${code} carries no access level, so its reliability is unknown`)
    }
    codes.push(code)
    demandMeta.push({
      code,
      point,
      reliability,
      access_level: link.road.access_level,
      road_id: link.road.road_id,
      road_name: link.road.road_name,
      road_distance_km: round2(link.distance_km),
    })
  }

  // The distribution over demand: an explicit set, or one sampled from the
  // per-site distributions the caller supplied. A site with neither is refused.
  let scenarioSet = null
  let scenarioSource = 'given'
  if (scenarios) {
    scenarioSet = normaliseScenarios(scenarios, codes)
    if (!scenarioSet) {
      return refuse('unweighted_scenarios', 'the scenario set is empty or its probabilities do not sum to one, so it carries no distribution')
    }
  } else {
    const sampled = demandScenarios({ demandSites, seed, draws })
    if (sampled.refusal) return refuse(sampled.refusal, sampled.reason)
    scenarioSet = sampled.scenarios
    scenarioSource = 'sampled'
  }

  // Assign each demand site to the nearest staging site, then group.
  const groupsByStaging = new Map()
  const transport = []
  for (const meta of demandMeta) {
    let chosen = null
    for (const site of staging) {
      const distanceKm = haversineKm(meta.point, site.point)
      if (chosen === null || distanceKm < chosen.distance_km) chosen = { site, distance_km: distanceKm }
    }
    if (!groupsByStaging.has(chosen.site.code)) {
      groupsByStaging.set(chosen.site.code, { staging_code: chosen.site.code, members: [] })
    }
    groupsByStaging.get(chosen.site.code).members.push(meta)
    transport.push({
      demand_code: meta.code,
      staging_code: chosen.site.code,
      distance_km: round2(chosen.distance_km),
      route_reliability: meta.reliability,
      access_level: meta.access_level,
      road_id: meta.road_id,
      road_name: meta.road_name,
      road_distance_km: meta.road_distance_km,
    })
  }

  const groups = []
  for (const group of groupsByStaging.values()) {
    const series = groupSeries(scenarioSet, group.members.map((member) => member.code))
    const means = group.members.map((member) => {
      const memberSeries = groupSeries(scenarioSet, [member.code])
      return seriesMean(memberSeries)
    })
    const totalMean = means.reduce((sum, value) => sum + value, 0)
    // The group's route reliability is the volume-weighted mean of its members'
    // last-mile reliabilities: the fraction of shipped stock that arrives,
    // weighted by how much each site is expected to need. A single cut-off
    // member does not zero the group, but a group that is entirely cut off does.
    const reliability = totalMean > 0
      ? group.members.reduce((sum, member, i) => sum + member.reliability * means[i], 0) / totalMean
      : group.members.reduce((sum, member) => sum + member.reliability, 0) / group.members.length
    groups.push({
      staging_code: group.staging_code,
      reliability: round2(reliability),
      mean_demand: round2(totalMean),
      demand_sites: group.members.map((member) => member.code),
      series,
    })
  }

  const series = groups.map((group) => group.series)
  const reliability = groups.map((group) => group.reliability)

  const optimised = optimiseAllocation({ groupSeries: series, reliability, budget: budgetValue, steps })
  // Round the stock to a reportable precision and recompute delivery and unmet
  // from the rounded plan, so the allocation and the figure beside it describe
  // the same plan rather than two.
  const stock = optimised.stock.map(round2)
  const delivered = stock.map((value, k) => value * reliability[k])
  const expectedUnmet = series.reduce((sum, group, k) => sum + expectedShortfall(group, delivered[k]), 0)

  const naive = naiveAllocation({ groupSeries: series, reliability, budget: budgetValue })
  const naiveUnmet = series.reduce((sum, group, k) => sum + expectedShortfall(group, naive.delivered[k]), 0)

  const allocation = {}
  groups.forEach((group, k) => { allocation[group.staging_code] = stock[k] })

  const meanDemand = series.reduce((sum, group) => sum + seriesMean(group), 0)
  return {
    allocation,
    expected_unmet: round2(expectedUnmet),
    naive_expected_unmet: round2(naiveUnmet),
    improvement: {
      absolute: round2(naiveUnmet - expectedUnmet),
      relative_pct: naiveUnmet > 0 ? round2(((naiveUnmet - expectedUnmet) / naiveUnmet) * 100) : null,
    },
    total_mean_demand: round2(meanDemand),
    budget: budgetValue,
    scenarios: { source: scenarioSource, count: scenarioSet.length, seed: scenarioSource === 'sampled' ? seed : null },
    transport,
    groups: groups.map((group) => ({
      staging_code: group.staging_code,
      reliability: group.reliability,
      mean_demand: group.mean_demand,
      demand_sites: group.demand_sites,
    })),
    refusal: null,
    reason: null,
  }
}
