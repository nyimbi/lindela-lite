// =============================================================
// Lindela Lite — chart primitives
// =============================================================
// Every function here is **pure**: it takes a data array and an options object
// and returns strings. No DOM, no globals, no state. That is a deliberate
// constraint, not a limitation — it is what lets `test/charts.test.js` assert on
// what a chart actually drew without a browser, which is the same reason
// `public/shared/map-frame.js` and `evictionPlan` in `public/sw.js` are pure.
//
// The library exists because the product had no such thing. The complete set of
// graphics primitives in eight surfaces was 39 `svgEl()` calls in the situation
// map, one 30x40 inline `<polyline>` in `co/`, one CSS-`<div>` bar chart in
// `co/`, and a pair of pixel-height `<div>`s in `scenarios/`. Seven surfaces
// showed no chart of anything — a sentence in a `<span>`.
//
// Four properties every chart here holds to:
//
// 1. **An absent value is not a zero.** `null` breaks the line and is counted in
//    the table as "not recorded". A gap drawn as zero says a month had no rain,
//    which is a claim about the world and a false one.
// 2. **Every chart ships a table.** The SVG is `aria-hidden`; the accessible
//    name and the data table are siblings. A hue and a slope do not survive a
//    screen reader, and a chart a screen reader cannot read is a chart that does
//    not exist for the people most likely to be reading it.
// 3. **The extent is data-derived, shared, and printed.** Bars are comparable
//    only against one axis, and an axis nobody can read is a decoration.
// 4. **Colour comes from `tokens.css`, never from a literal.** The palette is
//    the thing that gets retuned for contrast; a hex inside an SVG would not
//    follow it.

import { esc } from './fmt.js'

/** Series/category palette, in order. Every entry is a CSS custom property. */
export const SERIES_COLORS = Object.freeze([
  'var(--brand)', 'var(--accent)', 'var(--sev-low)',
  'var(--ok)', 'var(--sev-medium)', 'var(--sev-high)',
])

/**
 * `Number(v)`, or `null` when there is no number there.
 *
 * `Number(null)` is `0`, `Number('')` is `0` and `Number(undefined)` is `NaN` —
 * three different kinds of nothing, two of which answer with a number. That is
 * how an absent month becomes the lowest value on a chart and a chart whose
 * every value is null renders a flat line at zero. Every numeric read in this
 * file goes through here so that the answer to "is there a number here" is one
 * question with one answer.
 */
const numeric = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const defaultFormat = (v) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return Math.abs(n) >= 1000 ? n.toLocaleString('en') : String(Math.round(n * 100) / 100)
}

const DEFAULT = Object.freeze({
  width: 480, height: 180, pad: { top: 12, right: 12, bottom: 26, left: 44 },
  colors: SERIES_COLORS, format: defaultFormat, empty: 'No data',
})

/**
 * The bounds a chart draws over.
 *
 * `zero` is on by default because a bar chart whose baseline is not zero lies:
 * a bar of 3 next to one of 6 looks like a halving that did not happen. A line
 * chart over a time series is the case where a non-zero baseline is legitimate
 * and usually better, so it can be turned off.
 *
 * Gaps are excluded from the extent. Letting a null become the minimum would
 * stretch the y-axis to an invented value and flatten every real one.
 */
export function extentOf(values, { zero = true } = {}) {
  const numbers = (Array.isArray(values) ? values : []).map(numeric).filter((n) => n !== null)
  if (!numbers.length) return { min: 0, max: 1, empty: true }
  let min = Math.min(...numbers)
  let max = Math.max(...numbers)
  if (zero) {
    min = Math.min(min, 0)
    max = Math.max(max, 0)
  }
  if (min === max) {
    // A flat series has no range. Symmetric padding around the value draws it as
    // a line in the middle, which is what a flat series looks like; padding to
    // [0, 1] would draw it on the floor.
    const pad = Math.abs(min) * 0.1 || 1
    min -= pad
    max += pad
  }
  return { min, max, empty: false }
}

/** A linear map from a value domain onto a pixel range. */
export function scale(domain, from, to) {
  const span = domain[1] - domain[0]
  const ratio = span === 0 ? 0 : (to - from) / span
  return (value) => from + ((numeric(value) ?? 0) - domain[0]) * ratio
}

/** Round ticks across a domain, including both ends. */
export function ticks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min]
  const raw = (max - min) / Math.max(1, count)
  const decade = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1))
  const step = [1, 2, 5, 10].map((m) => m * decade).find((s) => s >= raw) || 10 * decade
  const out = []
  for (let v = Math.ceil(min / step) * step; v <= max + step / 2; v += step) {
    out.push(Math.round(v / step) * step)
  }
  return out.length > 1 ? out : [min, max]
}

/** SVG element as a string. Attribute names are passed through verbatim. */
export function svg(tag, attrs = {}, children = '') {
  const body = String(attrs).trim().length
    ? Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([k, v]) => `${k}="${esc(v)}"`)
      .join(' ')
    : ''
  const inner = String(children ?? '')
  return inner
    ? `<${tag}${body ? ` ${body}` : ''}>${inner}</${tag}>`
    : `<${tag}${body ? ` ${body}` : ''}/>`
}

const frame = (opts, inner) => svg('svg', {
  class: 'chart chart-line',
  viewBox: `0 0 ${opts.width} ${opts.height}`,
  width: '100%',
  preserveAspectRatio: 'xMidYMid meet',
  role: 'presentation',
  'aria-hidden': 'true',
  focusable: 'false',
}, inner)

const plotBox = (opts) => ({
  x0: opts.pad.left,
  x1: opts.width - opts.pad.right,
  y0: opts.pad.top,
  y1: opts.height - opts.pad.bottom,
})

/**
 * Grid lines and y-axis labels.
 *
 * Printed, not implied. An axis with ticks but no numbers asks the reader to
 * estimate from pixel positions, which is the one thing a chart is supposed to
 * save them from.
 */
function yAxis(opts, box, domain, format) {
  const y = scale(domain, box.y1, box.y0)
  return ticks(domain[0], domain[1]).map((value) => svg('g', { class: 'chart-grid' },
    svg('line', { x1: box.x0, x2: box.x1, y1: y(value).toFixed(1), y2: y(value).toFixed(1), stroke: 'var(--stroke)', 'stroke-width': 1 }) +
    svg('text', { x: box.x0 - 6, y: (y(value) + 4).toFixed(1), 'text-anchor': 'end', class: 'chart-tick', fill: 'var(--ink-muted)' }, esc(format(value)))
  )).join('')
}

function xLabels(opts, box, points, format) {
  return points.map((point, i) => {
    // Thin the labels rather than overlap them: eight unreadable ticks are worth
    // less than two readable ones, and the full set is always in the table.
    const stride = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor((box.x1 - box.x0) / 70))))
    if (i % stride !== 0 && i !== points.length - 1) return ''
    return svg('text', {
      x: point.x.toFixed(1), y: box.y1 + 16, 'text-anchor': 'middle',
      class: 'chart-tick', fill: 'var(--ink-muted)',
    }, esc(format(point.label, i, points.length)))
  }).join('')
}

const dataTable = (caption, headers, rows) => `<div class="chart-table"><table class="data-alt">
  <caption>${esc(caption)}</caption>
  <thead><tr>${headers.map((h, i) => `<th scope="col"${i === 0 ? '' : ' class="num"'}>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((row) => `<tr>${row.map((cell, i) => (i === 0
    ? `<th scope="row">${esc(cell)}</th>`
    : `<td class="num">${esc(cell)}</td>`)).join('')}</tr>`).join('')}</tbody>
</table></div>`

/** Count of real values against the length of the series. */
export function completeness(values) {
  const list = Array.isArray(values) ? values : []
  const determined = list.map(numeric).filter((n) => n !== null)
  return { total: list.length, present: determined.length, missing: list.length - determined.length }
}

/**
 * A line over time, with an optional uncertainty band.
 *
 * `series` is `[{ name, values, low, high }]`; `low`/`high` are the same length
 * as `values` and render as a filled band behind the line. This is ENH-17's
 * payload made visible — an interval in the JSON and a footnote in the docs is
 * not an uncertainty, it is a number with a caveat attached, and the caveat is
 * the part a user skips.
 *
 * Gaps break the line rather than being bridged. A run of nulls is missing
 * observations, and drawing a straight segment through them asserts the
 * intermediate months were measured.
 */
export function lineChart(data, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, ...(options.pad || {}) } }
  const series = (data?.series || []).map((s, i) => ({
    ...s,
    color: s.color || opts.colors[i % opts.colors.length],
    index: i,
  }))
  if (!series.length || !series[0].values?.length) {
    return emptyChart(opts, data?.empty || 'No data')
  }

  const n = series[0].values.length
  const labels = data.labels || []
  const all = series.flatMap((s) => [...(s.values || []), ...(s.low || []), ...(s.high || [])])
  const { min, max, empty } = extentOf(all, { zero: options.zero === true })
  if (empty) return emptyChart(opts, data?.empty || 'No data')

  const box = plotBox(opts)
  const domain = [min, max]
  const y = scale(domain, box.y1, box.y0)
  const xStep = n > 1 ? (box.x1 - box.x0) / (n - 1) : 0
  const xAt = (i) => box.x0 + (n > 1 ? i * xStep : (box.x1 - box.x0) / 2)

  const hasBand = series.some((s) => Array.isArray(s.low) && Array.isArray(s.high))
  const points = labels.length ? labels.map((label, i) => ({ label, x: xAt(i) })) : []

  let inner = ''
  if (hasBand) {
    inner += svg('defs', {}, series.map((s) => svg('linearGradient', { id: `chart-band-${s.index}`, x1: 0, y1: 0, x2: 0, y2: 1 },
      svg('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }) +
      svg('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.04 }))).join(''))
  }
  inner += yAxis(opts, box, domain, opts.format)
  if (labels.length) inner += xLabels(opts, box, points, (label) => label)

  for (const s of series) {
    const values = s.values || []
    if (hasBand && Array.isArray(s.low) && Array.isArray(s.high)) {
      const band = []
      for (let i = 0; i < n; i += 1) {
        const lo = numeric(s.low[i])
        if (lo !== null) band.push(`${xAt(i).toFixed(1)},${y(lo).toFixed(1)}`)
      }
      for (let i = n - 1; i >= 0; i -= 1) {
        const hi = numeric(s.high[i])
        if (hi !== null) band.push(`${xAt(i).toFixed(1)},${y(hi).toFixed(1)}`)
      }
      if (band.length >= 2) {
        inner += svg('polygon', {
          class: 'chart-band', points: band.join(' '),
          fill: `url(#chart-band-${s.index})`, stroke: 'none',
        })
      }
    }
    // Split into runs of consecutive present values; each run is its own
    // polyline, so a gap is a gap.
    let run = []
    const runs = []
    for (let i = 0; i <= n; i += 1) {
      const v = i < n ? numeric(values[i]) : null
      if (v !== null) {
        run.push(`${xAt(i).toFixed(1)},${y(v).toFixed(1)}`)
      } else {
        if (run.length) runs.push(run.join(' '))
        run = []
      }
    }
    for (const pts of runs) {
      inner += svg('polyline', {
        class: 'chart-line', points: pts, fill: 'none', stroke: s.color,
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      })
    }
    // The last present point gets a marker: where a line ends is a fact, and a
    // bare line end at the right margin is ambiguous with a value that simply
    // stopped being recorded.
    const lastIdx = presentIndex(values, -1)
    if (lastIdx >= 0) {
      inner += svg('circle', {
        class: 'chart-endpoint', cx: xAt(lastIdx).toFixed(1), cy: y(numeric(values[lastIdx])).toFixed(1),
        r: 3.5, fill: s.color,
      })
    }
  }

  const count = completeness(series[0].values)
  const headers = [data.xLabel || 'Period', ...series.map((s) => s.name || `Series ${s.index + 1}`)]
  const rows = labels.length
    ? labels.map((label, i) => [label || `#${i + 1}`,
      ...series.map((s) => describe(values(s.values, i), opts.format))])
    : Array.from({ length: n }, (_, i) => [`#${i + 1}`,
      ...series.map((s) => describe(values(s.values, i), opts.format))])

  return {
    svg: frame(opts, inner),
    table: dataTable(data.caption || data.title || 'Chart data', headers, rows),
    label: data.title || `${headers.slice(1).join(', ')} by ${headers[0].toLowerCase()}`,
    missing: count.missing,
    total: count.total,
  }
}

const values = (list, i) => (Array.isArray(list) ? list[i] : null)

/** Index of the last present value at or before `from`, or -1. */
export function presentIndex(list, from) {
  if (!Array.isArray(list)) return -1
  for (let i = from < 0 ? list.length - 1 : from; i >= 0; i -= 1) {
    if (numeric(list[i]) !== null) return i
  }
  return -1
}

const describe = (v, format) => (v === null || v === undefined ? 'not recorded' : format(v))

function emptyChart(opts, message) {
  return {
    svg: frame(opts, svg('text', {
      x: opts.width / 2, y: opts.height / 2, 'text-anchor': 'middle',
      class: 'chart-empty', fill: 'var(--ink-faint)',
    }, esc(message))),
    table: dataTable(message, ['Chart'], [['No data']]),
    label: message,
    missing: 0,
    total: 0,
    empty: true,
  }
}

/**
 * Vertical bars over a shared baseline at zero.
 *
 * `data` is `{ labels, series: [{name, values}], format }`. One extent covers
 * every series — three cards showing the same quantity in the same units have
 * to be comparable, and per-series extents would render three equal bars for
 * three unrelated magnitudes.
 */
export function barChart(data, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, left: 44, ...(options.pad || {}) } }
  const series = (data?.series || [])
  const n = (data?.labels || []).length
  if (!series.length || !n) return emptyChart(opts, data?.empty || 'No data')

  const all = series.flatMap((s) => s.values || [])
  const { min, max, empty } = extentOf(all, { zero: true })
  if (empty) return emptyChart(opts, data?.empty || 'No data')

  const box = plotBox(opts)
  const domain = [min, max]
  const y = scale(domain, box.y1, box.y0)
  const slot = (box.x1 - box.x0) / n
  const barWidth = Math.max(2, Math.min(28, (slot * 0.72) / series.length))
  const zeroY = y(0)

  let inner = yAxis(opts, box, domain, opts.format)
  inner += svg('line', {
    x1: box.x0, x2: box.x1, y1: zeroY.toFixed(1), y2: zeroY.toFixed(1),
    stroke: 'var(--stroke-strong)', 'stroke-width': 1,
  })

  for (let i = 0; i < n; i += 1) {
    const centre = box.x0 + slot * i + slot / 2
    for (const [si, s] of series.entries()) {
      const raw = (s.values || [])[i]
      // A missing value draws nothing and is reported in the table. A zero draws
      // a zero-height bar, which is visible as a gap — the two are different
      // claims and the chart has to keep them apart.
      const v = numeric(raw)
      if (v === null) continue
      const top = y(v)
      const x = centre - (barWidth * series.length) / 2 + si * barWidth
      inner += svg('rect', {
        class: 'chart-bar', x: x.toFixed(1), y: Math.min(top, zeroY).toFixed(1),
        width: Math.max(1, barWidth - 1).toFixed(1), height: Math.max(1, Math.abs(zeroY - top)).toFixed(1),
        fill: s.color || opts.colors[si % opts.colors.length], rx: 2,
      })
    }
    inner += svg('text', {
      x: centre.toFixed(1), y: box.y1 + 16, 'text-anchor': 'middle',
      class: 'chart-tick', fill: 'var(--ink-muted)',
    }, esc(String(data.labels[i] ?? '')))
  }

  const headers = [data.xLabel || 'Category', ...series.map((s, i) => s.name || `Series ${i + 1}`)]
  const rows = data.labels.map((label, i) => [label ?? `#${i + 1}`,
    ...series.map((s) => describe((s.values || [])[i], opts.format))])
  const count = completeness(series[0].values)
  return {
    svg: frame(opts, inner),
    table: dataTable(data.caption || data.title || 'Chart data', headers, rows),
    label: data.title || `${headers.slice(1).join(', ')} by ${headers[0].toLowerCase()}`,
    missing: count.missing,
    total: count.total,
  }
}

/**
 * Bars stacked by category.
 *
 * A stack total is a sum of parts, so the running total must be explicit rather
 * than accumulated in a hidden loop — which is how a `total` variable declared
 * outside the loop and read after it comes to mean the last row's sum.
 */
export function stackedBar(data, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, left: 44, ...(options.pad || {}) } }
  const series = (data?.series || [])
  const n = (data?.labels || []).length
  if (!series.length || !n) return emptyChart(opts, data?.empty || 'No data')

  const totals = []
  for (let i = 0; i < n; i += 1) {
    totals[i] = series.reduce((sum, s) => sum + (numeric((s.values || [])[i]) ?? 0), 0)
  }
  const { min, max, empty } = extentOf(totals, { zero: true })
  if (empty) return emptyChart(opts, data?.empty || 'No data')

  const box = plotBox(opts)
  const domain = [min, max]
  const y = scale(domain, box.y1, box.y0)
  const slot = (box.x1 - box.x0) / n
  const barWidth = Math.max(2, Math.min(40, slot * 0.7))
  const zeroY = y(0)

  let inner = yAxis(opts, box, domain, opts.format)
  for (let i = 0; i < n; i += 1) {
    const centre = box.x0 + slot * i + slot / 2
    let cursor = 0
    for (const [si, s] of series.entries()) {
      const raw = (s.values || [])[i]
      const v = numeric(raw)
      if (v === null) continue
      const from = y(cursor)
      cursor += v
      const to = y(cursor)
      inner += svg('rect', {
        class: 'chart-bar chart-stack-seg', x: (centre - barWidth / 2).toFixed(1),
        y: Math.min(from, to).toFixed(1), width: barWidth.toFixed(1),
        height: Math.max(1, Math.abs(from - to)).toFixed(1),
        fill: s.color || opts.colors[si % opts.colors.length],
      })
    }
    inner += svg('text', {
      x: centre.toFixed(1), y: box.y1 + 16, 'text-anchor': 'middle',
      class: 'chart-tick', fill: 'var(--ink-muted)',
    }, esc(String(data.labels[i] ?? '')))
  }
  inner += svg('line', {
    x1: box.x0, x2: box.x1, y1: zeroY.toFixed(1), y2: zeroY.toFixed(1),
    stroke: 'var(--stroke-strong)', 'stroke-width': 1,
  })

  const headers = [data.xLabel || 'Category', ...series.map((s, i) => s.name || `Series ${i + 1}`), 'Total']
  const rows = data.labels.map((label, i) => [label ?? `#${i + 1}`,
    ...series.map((s) => describe((s.values || [])[i], opts.format)),
    opts.format(totals[i])])
  const count = completeness(totals)
  return {
    svg: frame(opts, inner),
    table: dataTable(data.caption || data.title || 'Chart data', headers, rows),
    label: data.title || `${headers.slice(1, -1).join(' + ')} by ${headers[0].toLowerCase()}`,
    missing: count.missing,
    total: count.total,
  }
}

/**
 * A month-by-month grid, one cell per period.
 *
 * The cell colour is a step function of a shared domain, and the domain is
 * computed over **every** cell, not per row. A per-row domain would make a dry
 * district and a wet one look equally wet, which is the single most misleading
 * thing a heatmap can do.
 */
export function heatmap(data, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, top: 4, bottom: 4, left: 4, ...(options.pad || {}) } }
  const columns = data?.columns || []
  const rows = data?.rows || []
  if (!columns.length || !rows.length) return emptyChart(opts, data?.empty || 'No data')

  const cells = rows.flatMap((row) => (row.values || []).map(numeric)).filter((n) => n !== null)
  if (!cells.length) return emptyChart(opts, data?.empty || 'No values recorded')
  const { min, max } = extentOf(cells, { zero: false })

  const left = Math.max(...rows.map((r) => String(r.label ?? '').length)) * 7 + 8
  const cell = Math.max(6, Math.floor((opts.width - left - opts.pad.right) / columns.length))
  const cellH = Math.max(10, Math.min(cell, Math.floor((opts.height - 30) / rows.length)))
  const box = { x0: left, x1: left + cell * columns.length, y0: opts.pad.top, y1: opts.pad.top + cellH * rows.length }
  const ratio = (v) => (max === min ? 0.5 : (v - min) / (max - min))

  let inner = ''
  for (const [ri, row] of rows.entries()) {
    inner += svg('text', {
      x: left - 6, y: (box.y0 + ri * cellH + cellH / 2 + 4).toFixed(1), 'text-anchor': 'end',
      class: 'chart-tick', fill: 'var(--ink-muted)',
    }, esc(String(row.label ?? '')))
    for (const [ci, value] of (row.values || []).entries()) {
      const n = numeric(value)
      const x = box.x0 + ci * cell
      const yPos = box.y0 + ri * cellH
      if (n === null) {
        // A gap is a gap. It gets an empty cell with a hairline, never the
        // lowest colour in the ramp — which would say "the driest thing here".
        inner += svg('rect', {
          class: 'chart-cell chart-cell-missing', x, y: yPos, width: cell - 1, height: cellH - 1,
          fill: 'none', stroke: 'var(--stroke)', 'stroke-dasharray': '2 2', rx: 2,
        })
        continue
      }
      inner += svg('rect', {
        class: 'chart-cell', x, y: yPos, width: cell - 1, height: cellH - 1,
        fill: heatColor(ratio(n)), rx: 2,
      })
    }
  }
  inner += svg('text', {
    x: (box.x0 + box.x1) / 2, y: opts.height - 4, 'text-anchor': 'middle',
    class: 'chart-tick', fill: 'var(--ink-faint)',
  }, esc(`${opts.format(min)} – ${opts.format(max)}`))

  const headers = [data.rowLabel || 'Row', ...columns]
  const tableRows = rows.map((row) => [row.label ?? '',
    ...(row.values || []).map((v) => describe(v, opts.format))])
  const count = completeness(rows.flatMap((row) => row.values || []))
  return {
    svg: frame(opts, inner),
    table: dataTable(data.caption || data.title || 'Heatmap data', headers, tableRows),
    label: data.title || `${data.rowLabel || 'Row'} by ${columns.join(', ')}`,
    missing: count.missing,
    total: count.total,
  }
}

/**
 * Cell colour on a two-stop ramp between the surface and the brand hue.
 *
 * Interpolated in sRGB rather than OKLCH on purpose: an OKLCH interpolation
 * through the gamut boundary produces hues that are not in the palette, and the
 * whole point of the ramp is that its ends are tokens. This is a *sequential*
 * ramp — light means low, dark means high — so colourblind readers keep the
 * ordering, and every cell's number is in the table regardless.
 */
export function heatColor(t) {
  const n = numeric(t)
  const clamped = Math.max(0, Math.min(1, n === null ? 0 : n))
  return `color-mix(in oklab, var(--brand) ${Math.round(clamped * 100)}%, var(--surface))`
}

/**
 * A grid of small charts, one per facet.
 *
 * `panels` is `[{ title, note, chart }]` where `chart` is what `lineChart` or
 * `barChart` returned. The note is not decoration: `loadFloodProbabilityModels`
 * in `public/app.js` deliberately keeps districts that *refused* a model
 * rather than hiding them, because "this district has 40 months, not the 60
 * required" is actionable and a blank strip is not. This generalises that — a
 * panel that is refused, thin, or short says so underneath its own title rather
 * than being left out of the grid, so eight districts side by side each carry
 * their own sample size instead of one headline district being chosen for them.
 */
export function smallMultiples(panels, options = {}) {
  const list = (panels || []).filter(Boolean)
  if (!list.length) {
    const opts = { ...DEFAULT, ...options }
    return { ...emptyChart(opts, options.empty || 'Nothing to plot'), panels: [], html: '' }
  }
  const columns = Math.max(1, options.columns || Math.min(4, Math.ceil(Math.sqrt(list.length))))
  const html = list.map((panel, i) => {
    const chart = panel.chart || {}
    return `<figure class="chart-panel" style="--panel-col:${(i % columns) + 1}">
      <figcaption class="chart-panel-title">${esc(panel.title ?? '')}</figcaption>
      ${chart.svg || ''}
      ${panel.note ? `<p class="chart-panel-note">${esc(panel.note)}</p>` : ''}
      ${chart.table || ''}
      ${panel.refused ? `<p class="chart-panel-refused">${esc(panel.refused)}</p>` : ''}
    </figure>`
  }).join('')
  return {
    html: `<div class="chart-grid" style="--chart-cols:${columns}">${html}</div>`,
    label: options.title || `${list.length} panels`,
    panels: list,
    missing: list.reduce((sum, p) => sum + (p.chart?.missing || 0), 0),
    total: list.reduce((sum, p) => sum + (p.chart?.total || 0), 0),
  }
}

/**
 * The sparkline: a line, a last-value dot, and no axes.
 *
 * Moved here from `public/co/app.js:430`. Two behaviours changed rather than
 * being carried across verbatim, and both are about a gap: a single plotted
 * point stays a dot rather than becoming a degenerate trend, and a missing month
 * now breaks the line instead of being bridged — the original filtered the nulls
 * out and connected what remained, which asserts the missing month between two
 * observed ones was measured.
 */
export function sparkline(values, { label = '', width = 200, height = 40, pad = 4, color = 'var(--brand)', endpoint = 'var(--accent)' } = {}) {
  const list = Array.isArray(values) ? values : []
  const points = list.map((v, i) => ({ v: numeric(v), i })).filter((p) => p.v !== null)
  if (points.length < 1) return { svg: '', label, missing: list.length, total: list.length }
  const xs = list.length - 1
  const min = Math.min(...points.map((p) => p.v))
  const max = Math.max(...points.map((p) => p.v))
  const range = max - min || 1
  const xStep = xs > 0 ? (width - pad * 2) / xs : 0
  const at = (p) => [pad + p.i * xStep, height - pad - ((p.v - min) / range) * (height - pad * 2)]
  // Split into runs of consecutive present values, exactly as `lineChart` does.
  // Drawing one polyline through every present point bridges a gap, which
  // asserts the missing month between them was measured. Two runs of one point
  // each is two dots and no line — which is what a series with holes looks like.
  const runs = []
  let run = []
  for (let i = 0; i <= list.length; i += 1) {
    const v = i < list.length ? numeric(list[i]) : null
    if (v !== null) {
      run.push(`${at({ v, i })[0].toFixed(1)},${at({ v, i })[1].toFixed(1)}`)
    } else {
      if (run.length) runs.push(run.join(' '))
      run = []
    }
  }
  // A run of one is a dot, not a trend: drawing a polyline with a single pair of
  // coordinates draws nothing, so only runs of two or more become a line.
  const line = runs.filter((r) => r.split(' ').length > 1).map((coords) => svg('polyline', {
    points: coords, fill: 'none', stroke: color, 'stroke-width': 1.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  })).join('')
  const last = at(points[points.length - 1])
  const svgMarkup = `<svg class="spark-svg chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">` +
    line +
    svg('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 3, fill: endpoint }) +
    '</svg>'
  return {
    svg: svgMarkup,
    label,
    missing: list.length - points.length,
    total: list.length,
  }
}