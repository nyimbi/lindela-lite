import { numericOrNull } from './numeric.js'

export function computeEnsembleStats(values) {
  // Percentiles of nothing are not zero. This returned five confident zeros,
  // which is the same falsy-zero conflation the rest of the codebase exists to
  // avoid: an ensemble spread of 0 says every member agreed, and a mean of 0
  // says the members were all zero. Neither is knowable from an empty array.
  // `null` says the thing that is true — it was not computed — and a caller
  // that wants a number has to decide what to do about not having one.
  if (!Array.isArray(values) || values.length === 0) {
    return { p10: null, p50: null, p90: null, mean: null, stddev: null, count: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n
  const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)

  // Linear interpolation for percentiles
  const p10idx = 0.1 * (n - 1)
  const p50idx = 0.5 * (n - 1)
  const p90idx = 0.9 * (n - 1)

  const percentile = (idx) => {
    const lower = Math.floor(idx)
    const upper = Math.ceil(idx)
    if (lower === upper) return sorted[lower]
    const weight = idx - lower
    return sorted[lower] * (1 - weight) + sorted[upper] * weight
  }

  return {
    p10: percentile(p10idx),
    p50: percentile(p50idx),
    p90: percentile(p90idx),
    mean,
    stddev,
    count: n,
  }
}

export function spreadSkillIndex(records) {
  const validRecords = (records || []).filter((r) => Number.isFinite(r.ensemble_p90))
  if (validRecords.length === 0) return null

  const stddevs = validRecords
    .filter((r) => r.ensemble_members && r.ensemble_members.length > 0)
    .map((r) => {
      // `Number(m.value || 0)` turned a member with no value into a member
      // predicting exactly zero, which widens the spread of an ensemble that
      // was in fact unanimous and reports it as *uncertain*. A spread of 0 says
      // the members agreed; a spread inflated by two invented zeros says the
      // members disagreed, which is the opposite finding and the more alarming
      // one. Members with no value are skipped, and the skip is countable.
      const values = r.ensemble_members
        .map((m) => numericOrNull(m?.value))
        .filter((v) => v !== null)
      const stats = computeEnsembleStats(values)
      return stats.stddev
    })
    .filter((s) => s !== null)

  if (stddevs.length === 0) return null

  const meanStddev = stddevs.reduce((a, b) => a + b, 0) / stddevs.length
  // The same class, one level up: `Number(r.ensemble_p50 || 0)` folded a
  // missing median into the mean as a real zero, dragging the denominator down
  // and inflating the ratio — a spread index is relative to the value it is a
  // spread of, so biasing the reference point upward flatters the ensemble.
  const medians = validRecords
    .map((r) => numericOrNull(r.ensemble_p50))
    .filter((v) => v !== null)
  if (medians.length === 0) return null
  const meanValue = medians.reduce((a, b) => a + b, 0) / medians.length

  // A relative-spread index from a handful of ensembles cannot distinguish
  // "the members agreed" from "the members happened to agree this time". The
  // floor is inside the computation for the same reason it is in
  // `src/analytics/metrics.js`: a surface should not be able to publish
  // below it by forgetting to check.
  if (validRecords.length < MIN_ENSEMBLES_FOR_SPREAD_SKILL) return null

  return meanValue > 0 ? meanStddev / meanValue : null
}

/**
 * Ensembles needed before a spread-skill index is reportable.
 *
 * Three is the smallest count at which "how wide is this ensemble relative to
 * its value" is a comparison rather than an observation described in index
 * language. One record produces a ratio with no distribution behind it; two
 * produce a spread that is the gap between two numbers and nothing more. The
 * constant and this sentence said two and three respectively until the audit
 * read both.
 */
export const MIN_ENSEMBLES_FOR_SPREAD_SKILL = 3
