export function computeEnsembleStats(values) {
  if (!values || values.length === 0) {
    return { p10: 0, p50: 0, p90: 0, mean: 0, stddev: 0, count: 0 }
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
      const values = r.ensemble_members.map((m) => Number(m.value || 0))
      const stats = computeEnsembleStats(values)
      return stats.stddev
    })

  if (stddevs.length === 0) return null

  const meanStddev = stddevs.reduce((a, b) => a + b, 0) / stddevs.length
  const meanValue = validRecords.reduce((sum, r) => sum + Number(r.ensemble_p50 || 0), 0) / validRecords.length

  return meanValue > 0 ? meanStddev / meanValue : null
}
