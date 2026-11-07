/**
 * The falsy-zero gate, browser-side.
 *
 * Browser modules cannot reach `src/analytics/numeric.js` (src/ is not served),
 * which is why charts.js, wire-uncertainty.js and forms.js each carried a short
 * copy of the same rule. Keeping them separate meant the next copy could drift
 * (one of the copies does not reject arrays — see its test). One definition
 * here, imported by every browser surface. This module has no DOM and no peers
 * that it can induce, so it is safe to import from any surface.
 */
export function numericOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  if (Array.isArray(value)) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function numericOr(value, fallback = 0) {
  const n = numericOrNull(value)
  return n === null ? fallback : n
}