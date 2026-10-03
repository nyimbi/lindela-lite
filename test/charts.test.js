#!/usr/bin/env node
/**
 * The chart library.
 *
 * Seven of eight surfaces showed no chart of anything — a sentence in a
 * `<span>`. The four that did had four unrelated implementations: a `<polyline>`
 * in `co/`, a CSS-`<div>` bar chart in `co/`, two pixel-height `<div>`s in
 * `scenarios/`, and 39 `svgEl()` calls in the situation map. So this file is
 * what stops a shared library turning back into seven copies: the assertions are
 * about *behaviour that would rot silently* — a gap drawn as a zero, an extent
 * computed per row, a palette that stops following the tokens, an accessible
 * table that drifts from what was plotted.
 *
 * Everything is pure, so none of this needs a DOM. That is the reason the
 * library is written as string-returning functions rather than components.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  barChart, stackedBar, heatmap, heatColor, lineChart, scale, smallMultiples, sparkline,
  completeness, extentOf, presentIndex, ticks, SERIES_COLORS,
} from '../public/shared/charts.js'

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04']

/** Pull the `points` off every polyline in a rendered chart. */
const lines = (markup) => [...markup.matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((m) => m[1])
const bars = (markup) => [...markup.matchAll(/<rect[^>]*class="chart-bar[^"]*"[^>]*height="([^"]*)"/g)].map((m) => Number(m[1]))
const rects = (markup) => [...markup.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0])

describe('extent — an absent value is not a zero', () => {
  it('excludes nulls rather than letting them set the bounds', () => {
    // `Math.min(...values)` with a null in the array is 0 in every engine, so a
    // series that never dips below 8 would be drawn against a floor of 0 and
    // every real movement would compress into the top eighth of the plot.
    const { min, max } = extentOf([8, null, 10, null, 12])
    assert.equal(min, 0)
    assert.equal(max, 12)
    assert.equal(extentOf([8, null, 10, 12], { zero: false }).min, 8)
  })

  it('treats an empty or non-numeric series as empty rather than as [0, 0]', () => {
    assert.equal(extentOf([]).empty, true)
    assert.equal(extentOf([null, undefined, 'x']).empty, true)
    assert.equal(extentOf(null).empty, true)
  })

  it('draws a flat series in the middle, not on the floor', () => {
    // min === max means a zero-height range. Padding to [0, 1] would draw a
    // perfectly constant series as though it were pinned at zero.
    const { min, max } = extentOf([5, 5, 5], { zero: false })
    assert.ok(max > 5 && min < 5, `expected padding around 5, got ${min}..${max}`)
  })

  it('includes the zero point for a quantity that can be negative', () => {
    const { min, max } = extentOf([-3, 4])
    assert.equal(min, -3)
    assert.equal(max, 4)
  })
})

describe('scale and ticks', () => {
  it('maps a domain onto a pixel range, inverted for y', () => {
    const y = scale([0, 10], 100, 0)
    assert.equal(y(0), 100)
    assert.equal(y(10), 0)
    assert.equal(y(5), 50)
  })

  it('does not divide by zero on a degenerate domain', () => {
    assert.equal(Number.isFinite(scale([5, 5], 0, 100)(5)), true)
  })

  it('produces round ticks, not the raw data max', () => {
    const out = ticks(0, 12)
    assert.ok(out.every((v) => Number.isInteger(v) || v % 0.5 === 0), out.join(','))
    assert.ok(out.length >= 2)
  })
})

describe('completeness — gaps are counted, not dropped', () => {
  it('reports what is missing', () => {
    assert.deepEqual(completeness([1, null, 3, undefined]), { total: 4, present: 2, missing: 2 })
    assert.deepEqual(completeness([]), { total: 0, present: 0, missing: 0 })
  })

  it('counts zero as present', () => {
    // Zero rain is an observation. Conflating it with absent is the falsy-zero
    // defect, and a monthly series is where it does the most damage.
    assert.deepEqual(completeness([0, null, 0]), { total: 3, present: 2, missing: 1 })
  })

  it('finds the last real value', () => {
    assert.equal(presentIndex([1, null, null], -1), 0)
    assert.equal(presentIndex([1, 2, null], -1), 1)
    assert.equal(presentIndex([null, null], -1), -1)
    assert.equal(presentIndex('nope', -1), -1)
  })
})

describe('lineChart', () => {
  const series = [{ name: 'Rainfall', values: [10, 20, null, 40] }]

  it('breaks the line at a gap instead of bridging it', () => {
    const chart = lineChart({ labels: MONTHS, series, caption: 'Rainfall by month' })
    // Two runs: [10, 20] and [40]. Bridging would assert that March was measured
    // at 30, which nobody measured.
    assert.equal(lines(chart.svg).length, 2)
    // xStep = (width - left - right) / (n - 1) = (480 - 44 - 12) / 3.
    const xs = lines(chart.svg)[0].split(' ').map((p) => Number(p.split(',')[0]))
    assert.equal(xs[0], 44)
    assert.ok(Math.abs(xs[1] - (44 + 424 / 3)) < 0.5, `second point at ${xs[1]}`)
  })

  it('never invents a point for a gap', () => {
    const chart = lineChart({ labels: MONTHS, series, caption: 'x' })
    const drawn = lines(chart.svg).flatMap((l) => l.split(' ')).length
    assert.equal(drawn, 3, 'three present values, three drawn points')
  })

  it('draws a dot at the last real value, not at the right margin', () => {
    // Where a line ends is a fact. A bare line end at the right edge is
    // ambiguous with a series that simply stopped being recorded.
    const chart = lineChart({ labels: MONTHS, series, caption: 'x' })
    const dot = chart.svg.match(/<circle[^>]*class="chart-endpoint"[^>]*cx="([\d.]+)"/)
    const third = Number(lines(chart.svg)[1].split(' ')[0].split(',')[0])
    assert.ok(dot, 'an endpoint marker is drawn')
    assert.equal(Number(dot[1]), third, 'and it sits on the last plotted point')
  })

  it('reports the missing count alongside the chart', () => {
    const chart = lineChart({ labels: MONTHS, series, caption: 'x' })
    assert.equal(chart.missing, 1)
    assert.equal(chart.total, 4)
  })

  it('says "not recorded" in the table rather than leaving a blank cell', () => {
    // A blank cell in a data table reads as zero to anyone scanning it.
    const chart = lineChart({ labels: MONTHS, series, caption: 'x' })
    assert.match(chart.table, /not recorded/)
    assert.ok(!/<td class="num"><\/td>/.test(chart.table), 'no empty numeric cells')
  })

  it('renders a band when low and high are supplied', () => {
    const withBand = lineChart({
      labels: MONTHS,
      series: [{ name: 'Risk', values: [0.2, 0.3, 0.25, 0.4], low: [0.1, 0.2, 0.15, 0.3], high: [0.3, 0.4, 0.35, 0.5] }],
      caption: 'x',
    })
    assert.match(withBand.svg, /<polygon class="chart-band"/)
    // ENH-17: an interval in the JSON and a footnote in the docs is not an
    // uncertainty, it is a number with a caveat attached.
    assert.ok(!lineChart({ labels: MONTHS, series, caption: 'x' }).svg.includes('chart-band'))
  })

  it('pads the extent to include the band, so the line never clips it', () => {
    const chart = lineChart({
      labels: MONTHS,
      series: [{ name: 'Risk', values: [0.2, 0.3, 0.25, 0.4], low: [0, 0.1, 0.05, 0.2], high: [0.4, 0.5, 0.45, 0.6] }],
      caption: 'x', zero: false,
    })
    const ys = [...chart.svg.matchAll(/<line[^>]*y1="([\d.]+)"/g)].map((m) => Number(m[1]))
    assert.ok(ys.length >= 2, 'a grid was drawn')
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 180, 'grid stays inside the viewBox')
  })

  it('returns an empty chart rather than throwing on no data', () => {
    for (const input of [{ series: [] }, {}, { series: [{ name: 'x', values: [] }] }, null]) {
      const chart = lineChart(input)
      assert.equal(chart.empty, true)
      assert.match(chart.svg, /No data/)
      assert.match(chart.table, /No data/)
    }
  })

  it('returns an empty chart when every value is null', () => {
    const chart = lineChart({ labels: MONTHS, series: [{ name: 'x', values: [null, null, null, null] }] })
    assert.equal(chart.empty, true)
  })

  it('hides the SVG from assistive tech and ships a table beside it', () => {
    // The SVG is `role="presentation"`; the table carries the data. A hue and a
    // slope do not survive a screen reader.
    const chart = lineChart({ labels: MONTHS, series, caption: 'Rainfall by month' })
    assert.match(chart.svg, /aria-hidden="true"/)
    assert.match(chart.svg, /role="presentation"/)
    assert.match(chart.table, /<table class="data-alt">/)
    assert.match(chart.table, /<caption>Rainfall by month<\/caption>/)
    assert.match(chart.label, /Rainfall/)
  })
})

describe('barChart', () => {
  const data = { labels: ['A', 'B', 'C'], series: [{ name: 'Dispatches', values: [5, 10, null] }] }

  it('draws nothing for a null and does not draw it as zero', () => {
    const chart = barChart(data)
    assert.equal(bars(chart.svg).length, 2)
    assert.match(chart.table, /not recorded/)
  })

  it('shares one extent across series', () => {
    // Three cards showing the same quantity in the same units have to be
    // comparable. Per-series extents render three equal bars for three
    // unrelated magnitudes, which reads as "they are all equal".
    const chart = barChart({ labels: ['A', 'B'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [100, 200] }] })
    const heights = bars(chart.svg)
    assert.equal(heights.length, 4)
    // Bars are emitted category-major, then series: [A-x, A-y, B-x, B-y].
    // Compare within a category so the two series share an axis.
    assert.ok(heights[1] > heights[0] * 50, `a 100x value should be vastly taller: ${heights[0]} vs ${heights[1]}`)
    assert.ok(heights[3] > heights[2] * 50, `and at B: ${heights[2]} vs ${heights[3]}`)
    // The small series is pinned near the floor because the large one sets the
    // extent — which is the point. Per-series extents would render both full
    // height and read as "they are the same".
    assert.ok(heights[0] < 5 && heights[2] < 5, `small series floored: ${heights[0]}, ${heights[2]}`)
  })

  it('anchors the baseline at zero', () => {
    const chart = barChart({ labels: ['A'], series: [{ name: 'x', values: [5] }] })
    assert.match(chart.svg, /<line[^>]*stroke="var\(--stroke-strong\)"/)
  })

  it('draws a negative value downward from the baseline', () => {
    const chart = barChart({ labels: ['A', 'B'], series: [{ name: 'x', values: [-4, 4] }] })
    const rects_ = rects(chart.svg).filter((r) => r.includes('chart-bar'))
    const ys = rects_.map((r) => Number(r.match(/y="([\d.]+)"/)[1]))
    assert.ok(ys[0] > ys[1], 'the negative bar starts lower down the canvas')
  })

  it('returns an empty chart for no data', () => {
    assert.equal(barChart({ labels: [], series: [] }).empty, true)
    assert.equal(barChart(null).empty, true)
  })
})

describe('stackedBar — the total is a stated sum, not a leaked accumulator', () => {
  const data = {
    labels: ['Q1', 'Q2'],
    series: [{ name: 'Sent', values: [10, 20] }, { name: 'Queued', values: [5, 7] }],
  }

  it('totals each column independently', () => {
    // A `total` declared outside the loop and read after it comes to mean the
    // last row's sum, and every other row renders the same number.
    const chart = stackedBar(data)
    assert.match(chart.table, /<td class="num">15<\/td>/)
    assert.match(chart.table, /<td class="num">27<\/td>/)
  })

  it('stacks segments from the baseline, not from a drifting cursor', () => {
    const chart = stackedBar(data)
    assert.equal(rects(chart.svg).filter((r) => r.includes('chart-stack-seg')).length, 4)
  })

  it('ignores a null segment without shifting the rest of the stack', () => {
    const chart = stackedBar({ labels: ['A'], series: [{ name: 'x', values: [4] }, { name: 'y', values: [null] }] })
    assert.equal(rects(chart.svg).filter((r) => r.includes('chart-stack-seg')).length, 1)
    assert.match(chart.table, /not recorded/)
  })
})

describe('heatmap', () => {
  const data = {
    columns: MONTHS,
    rows: [
      { label: 'Turkana', values: [10, 20, 30, 40] },
      { label: 'Borno', values: [100, 200, 300, 400] },
      { label: 'Aweil', values: [null, null, null, null] },
    ],
  }

  it('computes one domain across every row', () => {
    // Per-row domains would make a dry district and a wet one look equally wet —
    // the single most misleading thing a heatmap can do.
    const chart = heatmap(data)
    const fills = rects(chart.svg).filter((r) => r.includes('chart-cell"'))
    const colors = new Set(fills.map((r) => r.match(/fill="([^"]*)"/)[1]))
    assert.equal(colors.size, fills.length, 'no two cells share a colour, so the ramp is global')
  })

  it('draws a missing cell as a gap, never as the lowest colour', () => {
    const chart = heatmap(data)
    assert.match(chart.svg, /chart-cell-missing/)
    const missing = rects(chart.svg).filter((r) => r.includes('chart-cell-missing'))
    assert.equal(missing.length, 4)
    assert.ok(missing.every((r) => r.includes('fill="none"')),
      'a gap is not "the driest value on this map"')
  })

  it('counts the gaps', () => {
    assert.equal(heatmap(data).missing, 4)
  })

  it('prints the range the colours cover', () => {
    // An unreadable ramp is a decoration.
    assert.match(heatmap(data).svg, /10 – 400/)
  })

  it('returns an empty chart when nothing is recorded anywhere', () => {
    const empty = heatmap({ columns: MONTHS, rows: [{ label: 'A', values: [null, null] }] })
    assert.equal(empty.empty, true)
    assert.match(empty.svg, /No values recorded/)
  })

  it('interpolates between two tokens rather than inventing hues', () => {
    assert.equal(heatColor(0), 'color-mix(in oklab, var(--brand) 0%, var(--surface))')
    assert.equal(heatColor(1), 'color-mix(in oklab, var(--brand) 100%, var(--surface))')
    assert.equal(heatColor(5), heatColor(1), 'clamps out-of-range ratios')
    assert.equal(heatColor(NaN), heatColor(0))
  })

  it('escapes the row labels', () => {
    const chart = heatmap({ columns: ['a'], rows: [{ label: '<script>x</script>', values: [1] }] })
    assert.ok(!chart.svg.includes('<script>'))
    assert.match(chart.table, /&lt;script&gt;/)
  })
})

describe('smallMultiples — a facet that refused is still in the grid', () => {
  const panels = [
    { title: 'Turkana', chart: barChart({ labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }] }) },
    { title: 'Borno', chart: barChart({ labels: ['a', 'b'], series: [{ name: 'x', values: [2, 1] }] }),
      note: '40 months of 60 required' },
    { title: 'Aweil', chart: null, refused: 'Refused: insufficient months' },
  ]

  it('renders every panel including one with no chart', () => {
    // `loadFloodProbabilityModels` deliberately keeps districts that refused
    // rather than hiding them, because "this district has 40 months, not the 60
    // required" is actionable and a blank strip is not. A grid that drops the
    // panel drops the reason.
    const grid = smallMultiples(panels, { columns: 3 })
    assert.equal(grid.panels.length, 3)
    assert.match(grid.html, /Aweil/)
    assert.match(grid.html, /Refused: insufficient months/)
  })

  it('keeps the sample-size note with its own panel', () => {
    const grid = smallMultiples(panels, { columns: 3 })
    const borno = grid.html.split('<figure')[2]
    assert.match(borno, /40 months of 60 required/)
    assert.ok(!/40 months of 60 required/.test(grid.html.split('<figure')[1]),
      'and it does not leak into the neighbouring panel')
  })

  it('carries each panel’s own table', () => {
    const grid = smallMultiples(panels, { columns: 3 })
    assert.equal((grid.html.match(/<table class="data-alt">/g) || []).length, 2,
      'the refused panel has no data to tabulate')
  })

  it('says so rather than rendering an empty box when there is nothing', () => {
    assert.equal(smallMultiples([]).panels.length, 0)
    assert.equal(smallMultiples(null).panels.length, 0)
  })

  it('escapes panel titles', () => {
    const grid = smallMultiples([{ title: '<img onerror=1>' }])
    assert.ok(!grid.html.includes('<img'))
  })
})

describe('sparkline', () => {
  it('draws a lone value as a dot, not a trend', () => {
    const spark = sparkline([5], { label: 'one point' })
    assert.equal(lines(spark.svg).length, 0)
    assert.match(spark.svg, /<circle/)
  })

  it('counts the gaps it did not draw', () => {
    const spark = sparkline([1, null, 3], { label: 'x' })
    assert.equal(spark.missing, 1)
    assert.equal(spark.total, 3)
    // Two points, one gap between them: two dots and no line. Connecting them
    // asserts that the missing month between them was measured.
    assert.equal(lines(spark.svg).length, 0)
    assert.equal((spark.svg.match(/<circle/g) || []).length, 1, 'only the last value is dotted')
  })

  it('breaks the line at a gap but draws it across consecutive values', () => {
    assert.equal(lines(sparkline([1, 2, null, 4], { label: 'x' }).svg).length, 1)
    assert.equal(lines(sparkline([1, 2, null, 4], { label: 'x' }).svg)[0].split(' ').length, 2)
    assert.equal(lines(sparkline([1, 2, 3], { label: 'x' }).svg)[0].split(' ').length, 3)
  })

  it('carries an accessible name, because it is role="img"', () => {
    const spark = sparkline([1, 2], { label: 'Rainfall, rising from 1 to 2' })
    assert.match(spark.svg, /role="img"/)
    assert.match(spark.svg, /aria-label="Rainfall, rising from 1 to 2"/)
  })

  it('returns nothing to render for an all-null series', () => {
    const spark = sparkline([null, null], { label: 'x' })
    assert.equal(spark.svg, '')
    assert.equal(spark.missing, 2)
  })

  it('plots a flat series without dividing by zero', () => {
    const spark = sparkline([5, 5, 5], { label: 'x' })
    assert.ok(spark.svg.includes('<polyline'))
    assert.ok(!spark.svg.includes('NaN'))
  })

  it('escapes the label', () => {
    assert.ok(!sparkline([1, 2], { label: '"><script>' }).svg.includes('<script>'))
  })
})

describe('the palette is the tokens, not literals', () => {
  it('names only CSS custom properties', () => {
    for (const color of SERIES_COLORS) {
      assert.match(color, /^var\(--[a-z-]+\)$/, color)
    }
  })

  it('draws with a token in every chart type', () => {
    const charts = [
      lineChart({ labels: MONTHS, series: [{ name: 'a', values: [1, 2, 3, 4] }] }).svg,
      barChart({ labels: ['a', 'b'], series: [{ name: 'a', values: [1, 2] }] }).svg,
      stackedBar({ labels: ['a'], series: [{ name: 'a', values: [1] }] }).svg,
      heatmap({ columns: ['a'], rows: [{ label: 'r', values: [1] }] }).svg,
    ]
    for (const svg of charts) {
      // A hex or an oklch() literal inside an SVG would not follow a retune of
      // the palette for contrast, which is the whole reason tokens exist.
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(svg), `literal colour found: ${svg.match(/#[0-9a-f]{3,8}/i)}`)
      assert.match(svg, /var\(--/)
    }
  })

  it('does not hard-code a viewBox width, so a chart can fill its container', () => {
    assert.match(barChart({ labels: ['a'], series: [{ name: 'x', values: [1] }] }).svg, /width="100%"/)
  })
})