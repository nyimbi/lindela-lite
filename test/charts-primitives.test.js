#!/usr/bin/env node
/**
 * ENH-16 — the rest of the shared library.
 *
 * `test/charts.test.js` guards the five primitives that shipped in 2026-10-03.
 * This file guards the three that complete the set, and the reason each exists
 * rather than being left to the surface that needed it:
 *
 *   `legend`       — two colours with no key is a chart whose colours mean
 *                    whatever the reader guesses
 *   `caption`      — ENH-17 requires caveats to be readable *with* the chart,
 *                    so the caveat is a primitive every surface gets
 *   `divergingBar` — `scenarios/` has had this as two pixel-height `<div>`s and
 *                    ENH-16 recorded that approximating it with a `barChart`
 *                    loses the zero anchor
 *
 * Same assertions-about-output rule: every test here checks what a reader would
 * see, not that a function returned a string.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SERIES_COLORS, caption, divergingBar, legend } from '../public/shared/charts.js'

describe('legend — a key, not a swatch wall', () => {
  it('names every series in text, so the key survives a screen reader', () => {
    const html = legend([{ name: 'Forecast rainfall', color: 'var(--brand)' }, { name: 'Observed rainfall', color: 'var(--accent)' }])
    assert.match(html, /Forecast rainfall/)
    assert.match(html, /Observed rainfall/)
    assert.match(html, /role="list"/)
  })

  it('hides the swatch from assistive tech, because the text says the same thing', () => {
    const html = legend([{ name: 'Rainfall', color: 'var(--brand)' }])
    // The colour is decoration; the label is the content. Two copies of the same
    // information is one too many.
    assert.match(html, /aria-hidden="true"/)
    assert.equal([...html.matchAll(/Rainfall/g)].length, 1)
  })

  it('drops the colour rather than the label when the colour is missing', () => {
    // A legend entry with no hue still has to say which series it is.
    const html = legend([{ name: 'Rainfall' }])
    assert.match(html, /Rainfall/)
    assert.match(html, /var\(--brand\)/)
  })

  it('renders nothing rather than an empty list for no entries', () => {
    assert.equal(legend([]), '')
    assert.equal(legend(null), '')
    assert.equal(legend([{ color: 'var(--brand)' }]), '', 'an entry with no name is not an entry')
  })

  it('escapes a series name from a payload', () => {
    const html = legend([{ name: '<script>alert(1)</script>' }])
    assert.ok(!html.includes('<script>'))
  })

  it('takes its colours from the tokens, never from a literal', () => {
    const html = legend(SERIES_COLORS.map((color, i) => ({ name: `Series ${i}`, color })))
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(html))
  })
})

describe('caption — the caveat that has to live with the chart', () => {
  it('renders the prose ENH-17 puts under an interval chart', () => {
    const html = caption('Hatching is a sensitivity band, not a confidence interval', { tone: 'caveat' })
    assert.match(html, /chart-caption-caveat/)
    assert.match(html, /sensitivity band, not a confidence interval/)
  })

  it('renders nothing for empty text rather than an empty paragraph', () => {
    assert.equal(caption(''), '')
    assert.equal(caption('   '), '')
    assert.equal(caption(null), '')
  })

  it('escapes record prose, because the caller interpolates `limits`', () => {
    // `limits` is user-influenced text on several routes, and this lands in the
    // DOM on every surface.
    const html = caption('not modelled: <img src=x onerror=alert(1)>', { tone: 'caveat' })
    assert.ok(!html.includes('<img'))
  })

  it('takes a tone as a class hook so no surface invents its own styling', () => {
    assert.match(caption('a', { tone: 'warning' }), /chart-caption-warning/)
    assert.match(caption('a', { tone: 'note' }), /chart-caption-note/)
  })
})

describe('divergingBar — one value against a zero rule', () => {
  it('draws the bar above the zero line when the value is positive', () => {
    const { svg, direction } = divergingBar({ label: 'Rainfall change', value: 18 })
    assert.equal(direction, 'positive')
    const zero = Number(svg.match(/chart-diverge[^>]*|y="([\d.]+)"[^>]*stroke="var\(--stroke-strong\)"/)?.[1] ?? 0)
    assert.ok(zero >= 0)
    assert.match(svg, /chart-diverge-positive/)
  })

  it('gives the two signs different tokens, so the sign is not read off a legend', () => {
    // A single hue for both signs makes the sign depend on a legend nobody
    // looks at.
    const up = divergingBar({ value: 5 })
    const down = divergingBar({ value: -5 })
    assert.match(up.svg, /fill="var\(--brand\)"/)
    assert.match(down.svg, /fill="var\(--cold\)"/)
  })

  it('labels the zero, because the anchor is the content of the chart', () => {
    const { svg } = divergingBar({ value: 12 })
    assert.match(svg, />0</)
  })

  it('labels both arms so the sign is readable without colour', () => {
    const { svg } = divergingBar({ value: 12, positiveLabel: 'More rain', negativeLabel: 'Less rain' })
    assert.match(svg, /More rain/)
    assert.match(svg, /Less rain/)
  })

  it('is symmetric about zero, so +3 does not look smaller than -3', () => {
    const armHeight = (value) => Number(
      divergingBar({ value }).svg.match(/<rect class="chart-bar chart-diverge[^"]*"[^>]*height="([\d.]+)"/)[1],
    )
    assert.equal(armHeight(30), armHeight(-30))
    assert.equal(armHeight(0.1), armHeight(-0.1))
  })

  it('draws a zero value as a hairline rather than nothing', () => {
    const { svg, direction } = divergingBar({ value: 0 })
    assert.equal(direction, 'positive')
    assert.match(svg, /chart-diverge/)
  })

  it('reports an absent value as not recorded, not as zero', () => {
    // Zero is a measurement. `null` is an absence, and the difference is the
    // falsy-zero defect class in a bar chart.
    const r = divergingBar({ label: 'Rainfall change', value: null })
    assert.equal(r.empty, true)
    assert.match(r.label, /Not recorded/)
    assert.ok(!r.svg.includes('chart-diverge-positive'))
  })

  it('ships a table like every other chart in the library', () => {
    const r = divergingBar({ label: 'Rainfall change', value: 18, title: 'March rainfall' })
    assert.match(r.table, /<caption>March rainfall<\/caption>/)
    assert.match(r.table, /<td class="num">18<\/td>/)
    // An explicit title is the caption; without one the label names the measure
    // and carries the value, so the chart still announces something.
    assert.equal(r.label, 'March rainfall')
    assert.match(divergingBar({ label: 'Rainfall change', value: 18 }).label, /Rainfall change: 18/)
  })

  it('takes its colours from tokens', () => {
    const { svg } = divergingBar({ value: 5 })
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(svg))
    assert.match(svg, /var\(--/)
  })

  it('escapes a caller-supplied label', () => {
    const { svg, table } = divergingBar({ label: '<script>alert(1)</script>', value: 3 })
    assert.ok(!svg.includes('<script>'))
    assert.ok(!table.includes('<script>'))
  })

  it('accepts a numeric string, as a payload field arrives', () => {
    const r = divergingBar({ label: 'change', value: '-4.5' })
    assert.equal(r.empty, undefined)
    assert.equal(r.direction, 'negative')
  })
})