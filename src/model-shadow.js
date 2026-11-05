/**
 * Phase 1 of the decision-model roadmap: the shadow pass.
 *
 * A classifier that writes a `model_score` and a decision record but never
 * changes a dispatch decision. The runner accepts either a built-in scoring
 * function (today: a weighted average of the declared features) or a small
 * model object supplied by the caller (`{ id, version, hash, weights, bias }`).
 * Either way it computes the score, compares it to the policy threshold, and
 * emits a pair of results:
 *
 *   { record_id, model_id, model_version, algorithm_version, input, score, decision }
 *   { action: 'action_log', subject: 'model_decision', algorithm_id, ... }
 *
 * The two-oracle rule (anticipatory-action, impact-assessment) is preserved
 * because a model `decision === 'fire'` selecting a record never makes the
 * host process fire; it is information for shadow comparison only.
 *
 * Design notes:
 *   - Inputs come from validated records; this module performs no coercion.
 *     A caller that pushes an unvalidated record here is a bug one level up.
 *   - Null features propagate as `null` score (absence is absence, not zero).
 *     `numericOrNull` (src/analytics/numeric.js) is the sanctioned conversion.
 *   - All hashing/weights stay optional; built-in mode uses a default linear
 *   - Weighted linear baseline (weights sum to 1, optional bias), so a deployment
 *     can swap weights without code changes.
 */
export const SHADOW_DEFAULTS = Object.freeze({
  threshold: 0.5,
  model_id: 'shadow_probe',
  model_version: '0.1.0',
  algorithm_version: 'numeric-only-1',
  weights: null,
  bias: 0,
})

/**
 * Lightweight scalar coercion policy. Not `Number()` because `Number('  ')`,
 * `Number(false)` and `Number([])` collapse absence into a figure.
 */
function stated(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (Array.isArray(value)) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * A weighted sum of declared feature values. Feature values may be `null`, which
 * propagates as null per recorded feature list. If *all* features are null the
 * whole score is null; otherwise a null (missing) measurement does not vote
 * (its weight is removed rather than counted as zero).
 */
export function scoreLinear(features, weights, bias = 0) {
  let weighted = 0
  let totalWeight = 0
  for (let i = 0; i < features.length; i++) {
    const w = weights ? weights[i] : 1
    const v = stated(features[i])
    if (v === null) continue
    weighted += w * v
    totalWeight += w
  }
  if (totalWeight === 0) return null
  return weighted / totalWeight + bias
}

/**
 * Run the shadow pass over a list of records.
 *
 * Each record must carry stable `id`, the top-level `feature_values` array
 * whose elements line up with `features` (the feature name list), and
 * `validated: true`. Otherwise the runner throws before scoring.
 *
 * Returns:
 *   model_results : array of per-record { record_id, model_id, model_version,
 *                    algorithm_version, score, decision, reason }
 *   action_logs  : per-record `{ action: ... }` records (one line per decision)
 */
export function runShadow(records, options = {}) {
  const cfg = { ...SHADOW_DEFAULTS, ...options }
  const features = options.features || []
  const weights = Array.isArray(cfg.weights) ? cfg.weights : null
  const mode = options.mode || 'score-only'
  const modelId = cfg.model_id
  const modelVersion = cfg.model_version
  const algVersion = cfg.algorithm_version
  const threshold = typeof cfg.threshold === 'number' ? cfg.threshold : SHADOW_DEFAULTS.threshold

  if (!Array.isArray(records)) {
    throw new TypeError('runShadow: records must be an array')
  }

  const model_results = []
  const action_logs = []

  for (const rec of records) {
    if (!rec || rec.id === undefined || rec.id === null) {
      throw new Error('runShadow: every record needs a stable id')
    }
    if (rec.validated !== true) {
      throw new Error(`runShadow: record ${rec.id} was not validated before scoring`)
    }
    if (!Array.isArray(rec.feature_values)) {
      throw new Error(`runShadow: record ${rec.id} has no feature_values array`)
    }

    const inputs = features.length ? features : rec.feature_values.map((_, i) => `f${i}`)
    const fv = rec.feature_values
    const score = scoreLinear(fv, weights, cfg.bias)
    const decision =
      score === null
        ? 'undetermined'
        : score >= threshold ? 'alert' : 'monitor'
    const reason =
      score === null ? 'no measurable feature' : `${score.toFixed(4)} vs ${threshold}`

    model_results.push({
      record_id: rec.id,
      model_id: modelId,
      model_version: modelVersion,
      algorithm_version: algVersion,
      inputs: inputs.map((name, i) => ({ name, value: fv[i] })),
      score,
      decision,
      reason,
      mode,
    })

    action_logs.push({
      action: 'model_shadow',
      model_id: modelId,
      model_version: modelVersion,
      algorithm_version: algVersion,
      inputs_hash: stableInputsHash(rec.id, fv),
      result: decision,
      recorded_at: ISO(),
    })
  }

  return {
    results: model_results,
    action_logs,
    summary: {
      mode,
      model_id: modelId,
      model_version: modelVersion,
      threshold,
      count: records.length,
      alert: model_results.filter((r) => r.decision === 'alert').length,
      undetermined: model_results.filter((r) => r.decision === 'undetermined').length,
    },
  }
}

function ISO() {
  return new Date().toISOString()
}

function stableInputsHash(id, values) {
  // Deterministic, stateless stringification. No Math.random, no Date.
  return id + '|' + JSON.stringify(values)
}

/**
 * Default sleep guard used by the schedule hosts: we don't run this pass
 * more often than `minIntervalMs`.
 */
export function canRunInWindow(state, now = Date.now(), minIntervalMs = 15 * 60 * 1000) {
  if (!state || typeof state.lastRunMs !== 'number') return true
  return now - state.lastRunMs >= minIntervalMs
}
