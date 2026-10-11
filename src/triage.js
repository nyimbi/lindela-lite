import { severityWeight, normalizeSeverity } from './schema.js'
import { computePopulationAtRisk } from './analytics/impact.js'
import { haversineKm } from './utils.js'
import { explainRanking } from '../public/shared/rank-explain.js'

/**
 * ENH-69 — triage by expected loss, not by recency.
 *
 * The alert list is ordered by `created_at`, which is the one ordering that
 * carries no information about what acting is worth. A coordinator with forty
 * open alerts works down the list, so the list's order *is* the triage policy,
 * and "newest first" is a policy nobody chose: it puts a low-severity alert
 * raised a minute ago above a critical one raised an hour ago over a district
 * with ten times the exposure.
 *
 * This module makes the policy explicit and states it. The quantity is an
 * expected-loss proxy:
 *
 *     expected_loss = severity_weight × population_exposed
 *
 * **What that is not.** It is not an expected value in the decision-theoretic
 * sense — there is no probability of the hazard and no cost per person, and
 * both would be needed for one. It is a *proxy* that is monotone in the two
 * things the platform does know, and the payload says so in `method` rather
 * than leaving a reader to infer a rigour that is not there. Calling it an
 * expected value without that sentence is the kind of overclaim this repository
 * has spent an audit removing.
 *
 * **The gap is a first-class answer.** Exposure is often unknown: a CHIRPS
 * observation carries no population, and an alert whose inputs are a rainfall
 * reading has nothing to multiply. Those alerts are not dropped and not
 * silently scored zero — zero would rank an unmeasured alert *below* a measured
 * trivial one, which is the wrong direction for missing data. They are ranked
 * after the measured set, ordered by severity, and the response counts them.
 *
 * ARC-04's warning applies here: severity weights exist in three places. This
 * reads `src/schema.js`'s, which is the one the alert engine itself stamps onto
 * the event, so the ranking and the event cannot disagree about what "high"
 * means.
 */

/** The radius within which a hazard is treated as the one an alert is about. */
const ATTRIBUTION_RADIUS_KM = 250

/**
 * The population exposed to an alert, or `null` when nothing measurable is.
 *
 * Two ways to resolve it, in order of directness:
 *
 *   1. The alert's own derivation names the records its metric read. When one
 *      of them is a hazard the impact model scored, that hazard's population is
 *      the answer — the alert is about that hazard by the engine's own record.
 *   2. The alert names no such record. Then the nearest scored hazard within
 *      `ATTRIBUTION_RADIUS_KM` of the alert's location stands in, and `basis`
 *      says `nearest_hazard` so the reader knows it is an attribution rather
 *      than a fact. An alert with no location resolves to nothing at all.
 *
 * A hazard whose population is `null` — every facility near it declined to
 * record how many people it serves — is *not* a zero. `computePopulationAtRisk`
 * already distinguishes "no people" from "nobody said", and this preserves the
 * distinction rather than flattening it here.
 */
function exposureFor(alert, hazards, byHazardId) {
  const named = Array.isArray(alert?.derivation?.input_record_ids) ? alert.derivation.input_record_ids : []
  for (const id of named) {
    const row = byHazardId.get(id)
    if (row) return { population: row.population_at_risk, basis: 'named_input_hazard', hazard_event_id: row.hazard_event_id }
  }
  const location = alert?.location
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
    return { population: null, basis: 'no_location', hazard_event_id: null }
  }
  let nearest = null
  let nearestKm = Infinity
  for (const hazard of hazards) {
    if (!Number.isFinite(hazard.latitude) || !Number.isFinite(hazard.longitude)) continue
    const km = haversineKm(location, hazard)
    if (km <= ATTRIBUTION_RADIUS_KM && km < nearestKm) { nearest = hazard; nearestKm = km }
  }
  if (!nearest) return { population: null, basis: 'no_nearby_hazard', hazard_event_id: null }
  const row = byHazardId.get(nearest.id)
  return {
    population: row ? row.population_at_risk : null,
    basis: row && row.population_at_risk !== null ? 'nearest_hazard' : 'nearest_hazard_unmeasured',
    hazard_event_id: nearest.id,
  }
}

/**
 * Rank open alerts by expected-loss proxy, descending.
 *
 * `alerts` defaults to the store's open alert events. `now` is injectable so a
 * test can pin the age term rather than race the clock.
 */
export function rankAlerts(data, alerts = null, { now = new Date().toISOString() } = {}) {
  const pool = Array.isArray(alerts)
    ? alerts
    : (data?.alert_events || []).filter((event) => event.status === 'open')
  const hazards = (data?.hazard_events || []).filter(
    (h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude),
  )
  const byHazardId = new Map(computePopulationAtRisk(data || {}).map((row) => [row.hazard_event_id, row]))

  const scored = pool.map((alert) => {
    const severity = normalizeSeverity(alert?.severity)
    const weight = severityWeight(severity)
    const exposure = exposureFor(alert, hazards, byHazardId)
    // The proxy is computed only when both terms are measured. A null exposure
    // makes the product null rather than zero — see the module note.
    const expectedLoss = exposure.population === null ? null : Math.round(weight * exposure.population * 100) / 100
    return {
      id: alert?.id ?? null,
      rule_id: alert?.rule_id ?? null,
      rule_name: alert?.rule_name ?? null,
      severity,
      severity_weight: weight,
      status: alert?.status ?? null,
      metric: alert?.metric ?? null,
      observed_value: Number.isFinite(alert?.value) ? alert.value : null,
      threshold: Number.isFinite(alert?.threshold) ? alert.threshold : null,
      location: alert?.location ?? null,
      created_at: alert?.created_at ?? null,
      age_hours: ageHours(alert?.created_at, now),
      population_exposed: exposure.population,
      exposure_basis: exposure.basis,
      hazard_event_id: exposure.hazard_event_id,
      expected_loss: expectedLoss,
    }
  })

  // Measured first, by loss; unmeasured after, by severity then age. The second
  // ordering is not a fallback for the first — it is the honest statement that
  // these alerts cannot be placed on the same scale, and a rank that mixed them
  // would be an ordering the data does not support.
  const measured = scored.filter((entry) => entry.expected_loss !== null)
  const unmeasured = scored.filter((entry) => entry.expected_loss === null)
  measured.sort((a, b) => b.expected_loss - a.expected_loss || compareRecency(a, b))
  unmeasured.sort((a, b) => b.severity_weight - a.severity_weight || compareRecency(a, b))

  const ranked = [...measured, ...unmeasured].map((entry, index) => ({
    rank: index + 1,
    ...entry,
    // ENH-72. The arithmetic, on the entry, in the order it was applied.
    rationale: rationaleFor(entry),
  }))

  return {
    ranked,
    total: ranked.length,
    measured_exposure: measured.length,
    unmeasured_exposure: unmeasured.length,
    // ENH-72. The ordering declared rather than implied: a list sorted by
    // `created_at` looks exactly like one sorted by severity, and an operator
    // who assumes the wrong one makes a different decision than the product
    // intended.
    ranking: explainRanking('alert-events/triage', { entries: ranked }),
    method: 'expected_loss = severity_weight × population_exposed. A proxy for what acting now is worth: it is monotone in severity and exposure, and it is NOT an expected value — no hazard probability and no cost per person enters it, so it ranks alerts against each other and does not price them.',
    exposure_attribution: `population is taken from the hazard the alert's derivation names, or failing that from the nearest scored hazard within ${ATTRIBUTION_RADIUS_KM} km of the alert's location; \`exposure_basis\` on each entry says which`,
    // Not a caveat about this module — a property of the impact model beneath
    // it, stated here because this is the surface where it can mislead. Two
    // alerts about two hazards 2 km apart both report the same facilities, and
    // a reader who adds the column gets a population counted twice. The ranks
    // are unaffected (each is computed from its own hazard); the total is not
    // a number this payload offers.
    exposure_overlap: 'populations are per hazard and are not disjoint: a facility within the radius of two hazards is counted in both, so these figures must not be summed across alerts. No total population is reported here for that reason.',
    limits: unmeasured.length
      ? `${unmeasured.length} of ${ranked.length} open alert(s) have no measured exposure and are ranked after the rest by severity. Their expected loss is null, not zero: a zero would place an unmeasured alert below a measured trivial one, which is the wrong direction for missing data.`
      : 'Every open alert resolved to a measured population.',
    generated_at: now,
  }
}

/** The entry's arithmetic in words, including the part that is missing. */
function rationaleFor(entry) {
  if (entry.expected_loss === null) {
    return `${entry.severity} (weight ${entry.severity_weight}) with no measured exposure (${entry.exposure_basis}), so no loss is computed and the rank comes from severity alone`
  }
  return `${entry.severity} (weight ${entry.severity_weight}) × ${entry.population_exposed} people exposed (${entry.exposure_basis}) = ${entry.expected_loss}`
}

function ageHours(createdAt, now) {
  if (!createdAt) return null
  const ms = Date.parse(now) - Date.parse(createdAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.round((ms / 3600000) * 100) / 100
}

function compareRecency(a, b) {
  const at = a.created_at ? Date.parse(a.created_at) : 0
  const bt = b.created_at ? Date.parse(b.created_at) : 0
  return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
}
