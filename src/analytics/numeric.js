/**
 * The falsy-zero rule, in one function.
 *
 * `Number(null) === 0`, `Number([]) === 0`, `'' == 0`, `x || 0` and `?? 0` on a
 * nullable all convert "not measured" into "measured, and the value is zero".
 * In a humanitarian dashboard the resulting figure is not merely wrong, it is
 * *optimistically* wrong: "13 facilities affected, 0 people at risk" reads as a
 * finding that nobody is exposed, when it means nobody recorded a population.
 *
 * This function is the only sanctioned conversion. It returns a number only
 * when the input is a real measurement, and `null` otherwise. Note what it
 * deliberately does *not* special-case: a genuine `0` is a real answer from a
 * facility that serves nobody, and it passes through untouched. That is why
 * this replaces `Number.isFinite(Number(x))` rather than living beside it —
 * the old expression returned `Number(null)`, which is finite, which is the bug.
 */

/**
 * A finite number, or null.
 *
 * Accepts a numeric string (`'42'`), because half the store arrives from
 * connectors as text. Rejects `null`, `undefined`, `''`, `[]`, `[5]` (one
 * element is not a scalar), booleans, `NaN`, `Infinity` and objects. Returns
 * null for anything it cannot vouch for rather than guessing.
 */
export function numericOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  // An array is not a scalar. `Number([])` is 0 and `Number([5])` is 5; both
  // would be a coincidence dressed as a measurement.
  if (Array.isArray(value)) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * A finite number, or `fallback`. For counters and internal accumulators where
 * the sum genuinely starts at zero and a missing term is worth zero — the
 * distinction only matters at the point a figure is *published*, and every
 * publication goes through `numericOrNull` first.
 */
export function numericOr(value, fallback = 0) {
  const n = numericOrNull(value)
  return n === null ? fallback : n
}

/**
 * Sum a field over records, skipping records whose value is absent.
 *
 * Skipping and adding zero are the same arithmetic here; the function exists so
 * that "absent" and "zero" are visibly different decisions at the call site,
 * and so the count of contributing records can be reported beside the sum.
 */
export function sumMeasured(records, field) {
  let total = 0
  let measured = 0
  for (const record of records || []) {
    const value = numericOrNull(record?.[field])
    if (value === null) continue
    total += value
    measured += 1
  }
  return { total, measured, of: (records || []).length }
}

/**
 * The median, by the definition a person means.
 *
 * `sorted[floor(n/2)]` — used in `src/kpi.js` and `src/districts.js` — returns
 * the upper of the two middle values for even n: `[1,2,3,4]` gives 3, not 2.5.
 * That is a systematically biased estimator, high by up to half the gap between
 * the middle pair, and it is the same expression on both surfaces so it never
 * looked like a bug. Null below one observation, which is the other half of
 * the rule: the median of nothing is not zero.
 */
export function median(values) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
