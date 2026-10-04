// =============================================================
// Lindela Lite — ENH-20 wiring: floods and alerts over the calendar
// =============================================================
// The seasonal calendar answers one question — was the Pacific warm or cold that
// month — and the rest of the console answers another: what flooded, what was
// alerted. An operator looking at an ENSO grid has to hold the two apart in their
// head and notice the coincidence themselves, which is the one thing a grid laid
// out as years × months is for.
//
// This draws a marker row *directly beneath* the calendar, one cell per month,
// aligned to the calendar's own columns. Alignment is arithmetic, not layout:
// `heatmap` derives its left inset and cell width from the row labels and the
// width it was given, so passing the same width here reproduces the same geometry
// and the columns land on top of each other at every viewport width. That is why
// `renderSeasonalCalendar` passes one width to both rather than letting each
// default independently.
//
// A marker is a real record, never a derived intensity. Two months with one
// alert each are drawn identically whether the alert was an evacuation or a
// rainfall threshold, because the calendar has no way to weigh them and guessing
// a weight would draw a gradient this data cannot support.

const MONTH_KEY = (year, month) => `${year}-${String(month).padStart(2, '0')}`

/** `YYYY-MM` for a store timestamp, or null. */
function monthOf(value) {
  const ms = Date.parse(value ?? '')
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : null
}

/**
 * Count the records that land in each month of the calendar's own range.
 *
 * Both sources are normalised to `YYYY-MM` here because they spell their
 * timestamps differently (`occurred_at` on a hazard event, `created_at` on an
 * alert) and neither is in the calendar's vocabulary. Months outside the
 * calendar's years are dropped rather than quietly widening the grid: a marker
 * on a column the calendar does not draw has nowhere to be seen.
 */
export function monthlyCounts(calendar, { hazards = [], alerts = [] } = {}) {
  const years = new Set((calendar?.yearsShown || []).map(Number))
  const counts = new Map()
  const bump = (value) => {
    const key = monthOf(value)
    if (!key) return
    if (!years.has(Number(key.slice(0, 4)))) return
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  for (const h of hazards) bump(h?.occurred_at ?? h?.started_at ?? h?.event_time)
  for (const a of alerts) bump(a?.created_at ?? a?.updated_at)
  return counts
}

/**
 * The overlay strip: one row of months, aligned to the calendar above it.
 *
 * Marked months carry a filled square and the count in the cell; unmarked ones
 * are a hairline outline. The outline is deliberate — a reader comparing the two
 * rows must be able to see that "no record" is a different cell from "not
 * ingested", and a blank gap cannot tell those apart.
 */
export function seasonalOverlay(calendar, { width = 480, counts = new Map(), height = 46 } = {}) {
  const years = calendar?.yearsShown || []
  if (!calendar?.columns?.length || !years.length) return ''

  // Same derivation `heatmap` uses, on the same width: longest row label × 7 + 8
  // of left inset, then an equal cell across the remaining columns. Keep these
  // two in step or the overlay slides out from under the grid.
  const left = Math.max(...years.map((y) => String(y).length)) * 7 + 8
  const cell = Math.max(6, Math.floor((width - left - 4) / calendar.columns.length))
  const top = 4
  const box = Math.min(cell, 18)

  let inner = ''
  let marked = 0
  for (const [ri, year] of years.entries()) {
    const y = top + ri * (box + 3)
    inner += `<text x="${left - 6}" y="${(y + box / 2 + 4).toFixed(1)}" text-anchor="end" class="chart-tick" fill="var(--ink-muted)">${String(year)}</text>`
    for (const [ci] of calendar.columns.entries()) {
      const key = MONTH_KEY(year, ci + 1)
      const n = counts.get(key) || 0
      const x = left + ci * cell
      if (n > 0) marked += 1
      inner += `<rect class="chart-cell${n > 0 ? ' seasonal-overlay-mark' : ''}" x="${x}" y="${y}" width="${cell - 1}" height="${box}" rx="2" `
        + `fill="${n > 0 ? 'var(--brand)' : 'none'}" fill-opacity="${n > 0 ? 0.85 : 0}" stroke="${n > 0 ? 'var(--brand)' : 'var(--stroke)'}" `
        + `stroke-width="1" stroke-dasharray="${n > 0 ? 'none' : '2 2'}">`
        + `<title>${String(year)}-${String(ci + 1).padStart(2, '0')}: ${n} hazard or alert record${n === 1 ? '' : 's'}</title></rect>`
      if (n > 0 && cell >= 22) {
        inner += `<text x="${(x + cell / 2 - 0.5).toFixed(1)}" y="${(y + box / 2 + 4).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--on-brand)">${n}</text>`
      }
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const svg = `<svg class="chart seasonal-overlay" viewBox="0 0 ${width} ${height}" width="100%" role="img" `
    + `aria-labelledby="seasonal-overlay-t" aria-describedby="seasonal-overlay-d" preserveAspectRatio="xMidYMid meet">`
    + `<title id="seasonal-overlay-t">Hazard and alert records by month, aligned to the seasonal calendar above</title>`
    + `<desc id="seasonal-overlay-d">${marked} of ${years.length * calendar.columns.length} months carry at least one hazard or alert record, `
    + `${total} in total. A filled cell is a month with at least one record; an outlined cell is a month with none. `
    + 'These are reports of events, not measures of their severity, and they do not say the climate caused them.</desc>'
    + `${inner}</svg>`
  return svg
}

/**
 * The sentence under the overlay.
 *
 * Counts the records the overlay is standing on and says what they are: things
 * that were reported, from feeds that miss what is not. An operator reading an
 * ENSO row above a flood row below is looking for a causal claim, and the two
 * are a correlation drawn side by side — the only honest thing this panel can
 * offer is the correlation, labelled as one.
 */
export function seasonalOverlayNote(counts) {
  const entries = [...(counts || new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (!total) {
    return 'No hazard or alert record falls in the months this calendar covers, so the overlay is empty. '
      + 'That is what the store holds, not a statement about those months.'
  }
  const busiest = entries.reduce((a, b) => (b[1] > a[1] ? b : a))
  const months = entries.length
  return `${total} hazard or alert record${total === 1 ? '' : 's'} across ${months} month${months === 1 ? '' : 's'}, `
    + `busiest ${busiest[0]} with ${busiest[1]}. `
    + 'A record here means an event entered the archive from a feed, not that the month was severe and not that the sea surface caused it. '
    + 'Reporting is uneven across places and months, so an empty cell is mostly a statement about coverage.'
}