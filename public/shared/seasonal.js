/**
 * Seasonal context rendering: the Niño 3.4 advisory state.
 *
 * Pure functions, no DOM, so the honest part is testable. The presentation
 * rule that matters: this is an *advisory*, not a declared ENSO event. CPC
 * declares an episode only after ±0.5 °C holds for five consecutive
 * overlapping three-month seasons, so the strip shows how many of the five
 * currently qualify instead of asserting "El Niño".
 */

export const OCEANIC_NINO_THRESHOLD_C = 0.5
export const EPISODE_MIN_SEASONS = 5

/**
 * Reads the advisory state out of stored climate observations.
 *
 * Returns null when the connector has not run, which the UI renders as
 * "not ingested" rather than as neutral conditions. Those are different claims
 * and only one of them is evidenced.
 */
export function readSeasonalState(observations) {
  const rows = (observations || [])
    .filter((o) => o.source === 'noaa_enso' && typeof o.source_id === 'string')
    // Number(null) and Number('') are both 0, which would render a confident
    // "0.00 °C neutral" from a missing value. A null anomaly is not a
    // measurement of zero, so reject the falsy-and-non-numeric shapes first.
    .filter((o) => o.value !== null && o.value !== undefined && o.value !== '')
    .filter((o) => Number.isFinite(Number(o.value)))
    // source_id is YYYY-MM, so a descending sort by period puts newest first.
    .sort((a, b) => (a.source_id < b.source_id ? 1 : -1))

  if (!rows.length) return null

  const latest = rows[0]
  const meta = latest.metadata || {}
  const value = Number(latest.value)

  let phase = 'neutral'
  if (value >= OCEANIC_NINO_THRESHOLD_C) phase = 'el_nino_advisory'
  else if (value <= -OCEANIC_NINO_THRESHOLD_C) phase = 'la_nina_advisory'

  const seasons = Number.isFinite(meta.overlapping_seasons) ? meta.overlapping_seasons : 0

  return {
    period: latest.source_id,
    anomalyC: Math.round(value * 100) / 100,
    phase,
    thresholdC: Number.isFinite(meta.threshold_c) ? meta.threshold_c : OCEANIC_NINO_THRESHOLD_C,
    overlappingSeasons: seasons,
    seasonsRequired: EPISODE_MIN_SEASONS,
    // Computed from the seasons, not read blindly from the record, so a
    // mis-stored flag cannot turn five qualifying seasons into an event.
    episodeDeclared: seasons >= EPISODE_MIN_SEASONS,
    advisoryRunMonths: Number.isFinite(meta.advisory_run_months) ? meta.advisory_run_months : null,
    indexUsed: meta.index_used || null,
    indexNote: meta.index_note || null,
    modelLimit: meta.model_limit || null,
  }
}

/** Short human label. Never says "El Niño" without "advisory". */
export function seasonalPhaseLabel(state) {
  if (!state) return 'not ingested'
  if (state.phase === 'el_nino_advisory') return 'El Niño advisory'
  if (state.phase === 'la_nina_advisory') return 'La Niña advisory'
  return 'Neutral'
}

/**
 * The sentence under the strip.
 *
 * Says what the number is, how close it is to an episode, and what it is not.
 * A panel asking "is this an El Niño?" should get the qualification, not a
 * bare phase name.
 */
export function seasonalNarrative(state) {
  if (!state) {
    return 'Niño 3.4 has not been ingested. Run POST /api/v1/ingest/run with {"sources":["noaa_enso"]}.'
  }
  const seasons = state.overlappingSeasons
  const needed = state.seasonsRequired
  const parts = [
    `${state.period}: ${state.anomalyC > 0 ? '+' : ''}${state.anomalyC.toFixed(2)} °C `
      + `against a ±${state.thresholdC} °C advisory threshold.`,
    seasons >= needed
      ? `CPC's episode criterion is met: ${seasons} consecutive overlapping seasons.`
      : `${seasons} of ${needed} consecutive overlapping seasons qualify; CPC declares an episode only at ${needed}. This is an advisory, not a declared event.`,
    state.modelLimit || 'Monthly SST anomaly index.',
  ]
  if (state.indexNote) parts.push(state.indexNote)
  return parts.join(' ')
}