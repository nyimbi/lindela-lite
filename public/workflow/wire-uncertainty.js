// =============================================================
// Lindela Lite — ENH-17 wiring: a risk series drawn with its band
// =============================================================
// The console drew a score per district as a polygon and a number. It never drew
// the band the score sits inside, which is the one piece of that score that says
// something about our own coverage rather than about the district. ADR-004
// (`docs/architecture/decisions/ADR-004-sensitivity-is-not-a-probability.md`)
// exists because a band once shipped under percentile names it had not earned;
// `public/shared/viz-uncertainty.js` enforces the naming and the hatching. This
// module is only the wiring: it turns the risk records `refresh()` already
// fetched into the chart call, and renders the caption the call returns rather
// than writing its own summary of what a band means.
//
// Statically imported by `app.js` through `lazy()`, so an operator who never
// scrolls to this panel never downloads it. The first-load budget measures the
// module graph from `index.html`, and a dynamic import is not an edge in it.

import { sensitivityBandChart } from '/shared/viz-uncertainty.js'
import { caption } from '/shared/charts.js'

/** A number, or null. `0` and absent are different answers and stay different. */
function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** The band's three numbers, or null when the record carries none. */
function boundsOf(record) {
  const low = num(record?.sensitivity_low ?? record?.score_p10)
  const high = num(record?.sensitivity_high ?? record?.score_p90)
  const mid = num(record?.sensitivity_mid ?? record?.score_p50 ?? record?.score)
  if (low === null && high === null && mid === null) return null
  return { low: low === null ? mid : low, high: high === null ? mid : high, mid }
}

/**
 * Split the records this chart may draw from the ones it must not.
 *
 * `viz-uncertainty` throws on a record claiming `calibrated_uncertainty: true`:
 * a real predictive interval under a coverage caption is the failure ADR-004
 * describes. Throwing here would take the whole console panel down for one
 * record, so the record is dropped instead — and named in the note, because a
 * quietly shorter chart is how a reader ends up comparing four districts while
 * the screen shows six.
 */
function refuse(records) {
  const drawable = []
  const refused = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.calibrated_uncertainty === true) { refused.push(record); continue }
    drawable.push(record)
  }
  return { drawable, refused }
}

/**
 * Both risk types over one shared axis of districts.
 *
 * The two scores are different quantities — one is rainfall and hazard pressure,
 * the other adds conflict and service exposure — on the same bounded 0..100
 * scale, and `sensitivityBandChart` pins that axis rather than fitting it to the
 * data. That is what makes the bands comparable across districts: the drawn
 * height is the score, not a share of the largest score on screen.
 *
 * Districts are ordered by their highest score so the reader's eye lands on the
 * worst one first; the chart's own caption names which line is which.
 */
export function bandChartData(records) {
  const byDistrict = new Map()
  for (const record of records) {
    const name = record?.region_name || record?.id
    if (!name) continue
    const bounds = boundsOf(record)
    if (!bounds) continue
    if (!byDistrict.has(name)) byDistrict.set(name, new Map())
    byDistrict.get(name).set(record.type, bounds)
  }

  const order = [...byDistrict.entries()]
    .map(([name, types]) => ({ name, top: Math.max(...[...types.values()].map((b) => b.mid ?? 0)) }))
    .sort((a, b) => b.top - a.top || a.name.localeCompare(b.name))

  const series = [
    { name: 'Flood risk', type: 'flood_risk', color: 'var(--brand)' },
    { name: 'Climate and conflict risk', type: 'climate_conflict_risk', color: 'var(--accent)' },
  ].map((spec) => {
    const rows = order.map((entry) => byDistrict.get(entry.name).get(spec.type))
    return {
      name: spec.name,
      color: spec.color,
      values: rows.map((b) => (b ? b.mid : null)),
      low: rows.map((b) => (b ? b.low : null)),
      high: rows.map((b) => (b ? b.high : null)),
    }
  })

  return {
    labels: order.map((e) => e.name),
    series,
    title: 'Risk score by district, with its sensitivity band',
    xLabel: 'District',
    empty: 'No risk scores have been computed',
  }
}

/**
 * Draw the band chart into `host` and say what it is into `note`.
 *
 * Returns the chart object so a caller that wants the underlying table — the
 * `table` field is the same numbers, reachable without seeing the picture — can
 * reach it. The console does not render it by default: the SVG carries the same
 * values in its `desc`, and the accessible table is one more thing to keep
 * correct at every refresh.
 */
export function renderUncertainty({ host, note }, records) {
  if (!host) return null
  const { drawable, refused } = refuse(records || [])
  const chart = sensitivityBandChart(bandChartData(drawable))

  host.innerHTML = chart.svg
  if (!note) return chart

  // The caption is the module's own words, not a paraphrase. It is the mechanism
  // that stops a hatched region being read as a confidence interval, and a
  // paraphrase is exactly what would let that reading back in.
  const widest = (drawable || [])
    .map((r) => num(r.sensitivity_width ?? r.interval_width) ?? 0)
    .reduce((a, b) => Math.max(a, b), 0)
  const sentences = [
    `${drawable.length} risk record${drawable.length === 1 ? '' : 's'} across `
    + `${new Set(drawable.map((r) => r.region_name).filter(Boolean)).size} districts. `
    + `Widest band here: ${Math.round(widest)} points.`,
  ]
  if (refused.length) {
    sentences.push(`${refused.length} record(s) claim a calibrated interval and were left out rather than drawn with a coverage caption.`)
  }
  note.innerHTML = caption(chart.caption, { class: 'chart-panel-note' })
    + `<p class="chart-panel-note">${sentences.join(' ')}</p>`
  return chart
}