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

export const MONTH_LABELS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
])

/**
 * A month × year calendar of the Niño 3.4 anomaly.
 *
 * The point of a calendar rather than a line is that the interesting structure
 * is *seasonal*: an El Niño does not peak in December, it peaks around
 * November–December and decays through the following spring, and that shape is
 * invisible in a single anomaly number and hard to read in a monthly line.
 * Reading a year as a column of twelve cells makes the annual cycle legible at
 * a glance, and makes the months that are missing legible too.
 *
 * Two properties this deliberately does not have:
 *
 * It does not compute a departure from the median of the same calendar month
 * across years. The anomaly NOAA publishes is *already* a departure from a
 * 30-year climatological base, so subtracting an in-record median would
 * difference it twice and report the local spread of a series whose absolute
 * position is the thing under study.
 *
 * It does not fill a missing month. A cell that was never ingested is `null`,
 * which renders as a gap. Interpolating across it would produce a number that
 * no connector measured.
 *
 * Returns null when nothing has been ingested, so the caller renders "not
 * ingested" rather than an empty grid that reads as "nothing happened".
 */
export function seasonalCalendar(observations, { years = null } = {}) {
  const cells = new Map()
  for (const o of observations || []) {
    if (o?.source !== 'noaa_enso') continue
    const period = String(o.source_id || '')
    const match = /^(\d{4})-(\d{2})$/.exec(period)
    if (!match) continue
    // Number(null) and Number('') are both 0, which would render a confident
    // "0.00 °C neutral" from a value nobody measured.
    if (o.value === null || o.value === undefined || o.value === '') continue
    const value = Number(o.value)
    if (!Number.isFinite(value)) continue
    const year = Number(match[1])
    const month = Number(match[2])
    if (month < 1 || month > 12) continue
    cells.set(period, { year, month, value })
  }
  if (!cells.size) return null

  const allYears = [...new Set([...cells.values()].map((c) => c.year))].sort((a, b) => a - b)
  // Newest on the right, so time reads the way it is read everywhere else.
  const chosen = years ? [...years].sort((a, b) => a - b) : allYears
  if (!chosen.length) return null

  const rows = chosen.map((year) => ({
    label: String(year),
    values: MONTH_LABELS.map((_, i) => {
      const hit = cells.get(`${year}-${String(i + 1).padStart(2, '0')}`)
      return hit ? hit.value : null
    }),
  }))

  const values = rows.flatMap((r) => r.values).filter((v) => v !== null)
  const span = Math.max(...values.map((v) => Math.abs(v)), 0.1)

  return {
    columns: [...MONTH_LABELS],
    rows,
    rowLabel: 'Year',
    title: 'Niño 3.4 SST anomaly by month',
    caption: 'Niño 3.4 SST anomaly (°C) against the CPC climatological base. A gap is a month that has not been ingested, not a neutral one.',
    span,
    // Reported rather than assumed: a calendar that silently showed the last
    // twelve months as a complete history would misrepresent a series with one
    // observation in it.
    ingestedMonths: values.length,
    requestedMonths: chosen.length * 12,
    firstPeriod: cells.has(`${allYears[0]}-01`) ? `${allYears[0]}-01` : allYears[0],
    yearsAvailable: allYears,
    yearsShown: chosen,
    thresholdC: OCEANIC_NINO_THRESHOLD_C,
  }
}

/**
 * One line saying what the calendar is and is not.
 *
 * The months above and below ±0.5 °C are the ones CPC's advisory criterion
 * looks at, so the calendar is annotated against that threshold rather than
 * against its own extremes: a colour scale fitted to the data would make a
 * quiet year look dramatic.
 */
export function seasonalCalendarNote(calendar) {
  if (!calendar) return 'Niño 3.4 has not been ingested, so there is no calendar to draw.'
  const values = calendar.rows.flatMap((r) => r.values).filter((v) => v !== null)
  const warm = values.filter((v) => v >= OCEANIC_NINO_THRESHOLD_C).length
  const cold = values.filter((v) => v <= -OCEANIC_NINO_THRESHOLD_C).length
  const missing = calendar.requestedMonths - calendar.ingestedMonths
  const parts = [
    `${calendar.ingestedMonths} of ${calendar.requestedMonths} months shown`,
    `${warm} at or above the +${OCEANIC_NINO_THRESHOLD_C} °C advisory threshold`,
    `${cold} at or below −${OCEANIC_NINO_THRESHOLD_C} °C`,
  ]
  if (missing > 0) parts.push(`${missing} not ingested`)
  return parts.join(' · ') + '. Each cell is a departure from the CPC base, not from the median of this record.'
}

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