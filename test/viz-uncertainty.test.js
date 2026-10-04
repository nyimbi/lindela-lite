#!/usr/bin/env node
/**
 * ENH-17 — uncertainty drawn as geometry.
 *
 * The assertions here are mostly about *what a reader could conclude wrongly*.
 * A band that renders correctly and reads as a confidence interval is a failed
 * chart: it is worse than no chart, because it converts a coverage artefact into
 * a probability in the reader's head and every downstream decision inherits it.
 * So the tests check the caption, the hatching, the vocabulary, the refusal, and
 * the map opacity ladder — and only incidentally check that some coordinates
 * are finite.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  BAND_DISCLAIMER, assertSensitivity, bandCaption, bandOf, sensitivityBandChart,
  sensitivityRange, uncertaintyStyle,
} from '../public/shared/viz-uncertainty.js'

/** A risk record shaped exactly as `src/analytics.js` emits one. */
const risk = (over = {}) => ({
  id: 'risk-flood-abc',
  type: 'flood_risk',
  region_name: 'Kisumu',
  score: 55,
  sensitivity_low: 40,
  sensitivity_mid: 55,
  sensitivity_high: 70,
  sensitivity_width: 30,
  score_p10: 40,
  score_p50: 55,
  score_p90: 70,
  interval_width: 30,
  calibrated_uncertainty: false,
  confidence: 25,
  drivers: { precipitation_mm: 20, climate_observations_in_scope: 12 },
  limits: 'Rainfall intensity to flood probability is not modelled.',
  ...over,
})

describe('a band cannot be mistaken for a confidence interval', () => {
  it('names what the band is in every rendering, not only in one', () => {
    // The caption is in the same object as the geometry. A caller that renders
    // the geometry and drops the caption has to have gone looking for it.
    const chart = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, 40], high: [70, 70] }],
    })
    assert.ok(chart.caption.includes('NOT a confidence interval'))
    assert.equal(chart.basis, 'sensitivity')
    const range = sensitivityRange(risk())
    assert.ok(range.caption.includes('NOT a confidence interval'))
    assert.equal(range.basis, 'sensitivity')
  })

  it('says the band is not a probability before the first sentence ends', () => {
    const c = bandCaption(risk())
    // Within the first sentence, not on the third line: a disclaimer the reader
    // reaches late has already been read past.
    assert.ok(c.indexOf('NOT a confidence interval') < 100, c.slice(0, 120))
    assert.ok(c.indexOf('NOT a probability') < 200, c.slice(0, 240))
  })

  it('never uses a percentile name anywhere it renders the band', () => {
    // `p10`/`p90` is the exact defect ADR-004 exists to undo. A reader who
    // knows probabilistic charts looks for a percentile label; there must not be
    // one to find.
    const { svg, table, caption } = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, 40], high: [70, 70] }],
    })
    for (const markup of [svg, table, caption]) {
      assert.ok(!/\bp10\b|\bp90\b|\bpercentile\b/i.test(markup), `percentile vocabulary found: ${markup}`)
    }
  })

  it('hatches the band rather than filling it', () => {
    // A soft ribbon is the visual grammar of a predictive interval. A hatch is
    // not, and it survives greyscale and every form of colour blindness.
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, 40], high: [70, 70] }],
    })
    assert.match(svg, /<pattern id="viz-uncertainty-hatch"/)
    assert.match(svg, /url\(#viz-uncertainty-hatch\)/)
    assert.match(svg, /data-basis="sensitivity"/)
    // And it is hatched, not a gradient: no `linearGradient` anywhere.
    assert.ok(!svg.includes('linearGradient'), 'a gradient is the confidence-interval grammar')
  })

  it('labels the edges with the band vocabulary, in the drawing', () => {
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, 40], high: [70, 70] }],
    })
    assert.match(svg, /sensitivity high 70/)
    assert.match(svg, /sensitivity low 40/)
  })

  it('gives every rendered band a role, a title and a description', () => {
    const chart = sensitivityBandChart({
      title: 'Kisumu flood risk over 2026',
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, 40], high: [70, 70] }],
    })
    assert.match(chart.svg, /role="img"/)
    assert.match(chart.svg, /<title id="viz-unc-t">Kisumu flood risk over 2026<\/title>/)
    // The description is what a screen reader reads, and it is the only place
    // the band-vs-interval distinction reaches a non-visual reader.
    assert.match(chart.svg, /not a confidence or predictive interval/)
  })

  it('says in the table caption that the bounds are not a confidence interval', () => {
    const { table } = sensitivityRange(risk())
    assert.match(table, /sensitivity bounds, not a confidence interval/)
  })

  it('refuses a record that claims to be calibrated rather than relabelling it', () => {
    // The dangerous case is a real predictive interval arriving and being
    // published under a caption saying it is a coverage artefact.
    assert.throws(
      () => sensitivityRange(risk({ calibrated_uncertainty: true })),
      /calibrated_uncertainty/,
    )
    assert.throws(() => bandOf(risk({ calibrated_uncertainty: true })), /predictive/)
    assert.throws(() => assertSensitivity({ calibrated_uncertainty: true }), /sensitivity caption/)
  })

  it('does not refuse a record that correctly says it is uncalibrated', () => {
    assert.doesNotThrow(() => bandOf(risk({ calibrated_uncertainty: false })))
    assert.equal(bandOf(risk()).basis ?? 'sensitivity', 'sensitivity')
  })
})

describe('the degenerate zero-width band reads as what it is', () => {
  it('says the inputs were sufficient, not that the outcome is certain', () => {
    // ADR-004 names this case: width 0 presents as "no uncertainty" when it
    // means "enough inputs to compute a point score at all". Both halves of that
    // sentence have to be in the caption.
    const c = bandCaption(risk({ sensitivity_width: 0, interval_width: 0, sensitivity_low: 55, sensitivity_high: 55, score_p10: 55, score_p90: 55 }))
    assert.match(c, /inputs were sufficient/)
    assert.match(c, /not that the outcome is certain/i)
  })

  it('draws a zero-width band as a visible rule, not as nothing', () => {
    const { svg, band } = sensitivityRange(risk({ sensitivity_width: 0, interval_width: 0, sensitivity_low: 55, sensitivity_high: 55, score_p10: 55, score_p90: 55 }))
    assert.equal(band.width, 0)
    // width:max(1,…) — the band collapses to a hairline rather than vanishing,
    // because "the band is empty" and "there is no band here" are different.
    assert.match(svg, /class="viz-uncertainty-band"/)
    assert.match(svg, /low 55/)
    assert.match(svg, /high 55/)
  })
})

describe('the record prose travels with the band', () => {
  it('appends the record\'s own limits after the generic statement', () => {
    const c = bandCaption(risk())
    assert.match(c, /What was not modelled: Rainfall intensity to flood probability is not modelled\./)
    // Generic first, specific second: the specific list is only meaningful once
    // the reader knows what kind of band they are looking at.
    assert.ok(c.indexOf(BAND_DISCLAIMER.slice(0, 40)) < c.indexOf('What was not modelled'))
  })

  it('reads the ADR-004 names in preference to the retained aliases', () => {
    // The aliases exist for compatibility and are retained deliberately; a
    // future removal of them must not blank every band on the map.
    const record = { sensitivity_low: 10, sensitivity_high: 20, score_p10: 999, score_p90: 1000 }
    assert.equal(bandOf(record).low, 10)
    assert.equal(bandOf(record).high, 20)
  })

  it('still reads the aliases when the new names are absent', () => {
    const b = bandOf({ score_p10: 10, score_p50: 15, score_p90: 20, interval_width: 10 })
    assert.equal(b.low, 10)
    assert.equal(b.high, 20)
    assert.equal(b.width, 10)
  })

  it('reports null rather than a number when there is no band at all', () => {
    assert.equal(bandOf({ score: 40 }), null)
    assert.equal(bandOf(null), null)
  })
})

describe('gaps break the band instead of bridging it', () => {
  it('draws two separate bands where the middle month has no bound', () => {
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
      series: [{ name: 'Kisumu', values: [50, 52, 55, 58, 60], low: [40, 41, null, 48, 50], high: [70, 71, null, 78, 80] }],
    })
    // Bridging would draw a bound for February, a month with no measurement.
    // Two runs of two points each, so two polygons and no segment between them.
    const bands = [...svg.matchAll(/<polygon class="viz-uncertainty-band"[^>]*points="([^"]*)"/g)]
    assert.equal(bands.length, 2)
    for (const b of bands) assert.ok(!b[1].includes('NaN'))
  })

  it('draws no band for a run of one bounded month, rather than a sliver', () => {
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'Kisumu', values: [50, 55], low: [40, null], high: [70, null] }],
    })
    // A single bounded month has no width to fill. Filling it would invent a
    // second edge from nothing.
    assert.ok(!svg.includes('viz-uncertainty-band"'), svg)
  })

  it('draws one polygon across a run of two bounded months', () => {
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb', 'Mar'],
      series: [{ name: 'Kisumu', values: [50, 52, 55], low: [40, 41, 45], high: [70, 71, 75] }],
    })
    assert.equal([...svg.matchAll(/<polygon class="viz-uncertainty-band"/g)].length, 1)
  })

  it('breaks the point score across a gap too', () => {
    const { svg } = sensitivityBandChart({
      labels: ['Jan', 'Feb', 'Mar'],
      series: [{ name: 'Kisumu', values: [50, null, 55], low: [40, null, 45], high: [70, null, 75] }],
    })
    // Two runs of one point each, so neither becomes a polyline — and both draw
    // as dots rather than vanishing, because an invisible measurement is worse
    // than a gap: the reader would see an absence where there is a number.
    assert.equal([...svg.matchAll(/<polyline class="viz-uncertainty-score"/g)].length, 0)
    assert.equal([...svg.matchAll(/<circle class="viz-uncertainty-score"/g)].length, 2)
  })

  it('reports the missing months in its count', () => {
    const c = sensitivityBandChart({
      labels: ['Jan', 'Feb', 'Mar'],
      series: [{ name: 'Kisumu', values: [50, null, 55], low: [40, null, 45], high: [70, null, 75] }],
    })
    assert.equal(c.missing, 1)
    assert.equal(c.total, 3)
    assert.match(c.table, /not recorded/)
  })
})

describe('the one-record range', () => {
  it('shows the band as a distance on a bounded 0..100 track', () => {
    const { svg, band } = sensitivityRange(risk())
    assert.deepEqual([band.low, band.mid, band.high, band.width], [40, 55, 70, 30])
    assert.match(svg, /0<\/text>/)
    assert.match(svg, /score 55/)
    assert.match(svg, /low 40/)
    assert.match(svg, /high 70/)
  })

  it('describes the numbers in its own accessible description', () => {
    const { svg } = sensitivityRange(risk())
    // The reader who cannot see the bar gets the whole claim in prose.
    assert.match(svg, /point score is 55/)
    assert.match(svg, /from 40 to 70, a width of 30 points/)
    assert.match(svg, /not a confidence interval or a probability/)
  })

  it('puts the un-calibrated fact in the table as a row, not as prose', () => {
    const { table } = sensitivityRange(risk())
    assert.match(table, /<th scope="row">calibrated uncertainty<\/th><td class="num">no — this is a sensitivity band<\/td>/)
    assert.match(table, /input coverage confidence/)
  })

  it('reports an absent band as not recorded rather than as zero width', () => {
    const r = sensitivityRange({ id: 'x', score: 40 })
    assert.equal(r.empty, true)
    assert.equal(r.missing, 1)
    assert.match(r.table, /not recorded/)
    // Zero width would read as "well covered" — the ADR-004 degenerate case.
    assert.ok(!/<td class="num">0<\/td>/.test(r.table))
  })
})

describe('map uncertainty is opacity and hatching, never a flattened feature', () => {
  it('fades and hatches a thinly covered polygon', () => {
    const s = uncertaintyStyle(risk({ confidence: 25 }))
    assert.equal(s.hatch, true)
    assert.equal(s.level, 'thin')
    assert.ok(s.opacity <= 0.5, `expected a faded polygon, got ${s.opacity}`)
    assert.match(s.reason, /hatched and faded/)
  })

  it('draws a well-covered polygon at full strength', () => {
    const s = uncertaintyStyle(risk({ confidence: 95 }))
    assert.equal(s.hatch, false)
    assert.equal(s.level, 'well-covered')
    assert.ok(s.opacity >= 0.9)
  })

  it('uses named levels rather than a continuous ramp', () => {
    // A ramp invites a reader to read a difference out of a difference they
    // cannot see; three levels can go in a legend and cannot be over-read.
    const opacities = new Set([10, 30, 50, 65, 75, 85, 100].map((c) => uncertaintyStyle(risk({ confidence: c })).opacity))
    assert.equal(opacities.size, 3)
  })

  it('treats a missing coverage score as the least trustworthy case', () => {
    // Not as full confidence. Absence of a number is not evidence of coverage.
    const s = uncertaintyStyle({ score: 40 })
    assert.equal(s.hatch, true)
    assert.equal(s.level, 'unknown')
    assert.ok(s.opacity <= 0.5)
  })

  it('refuses to style a record whose band is a real interval', () => {
    assert.throws(() => uncertaintyStyle(risk({ calibrated_uncertainty: true })), /calibrated/)
  })
})

describe('nothing in the module can be mistaken for the forbidden interval', () => {
  it('never emits the words "confidence interval" without negating them', () => {
    const artifacts = [
      sensitivityRange(risk()).svg,
      sensitivityRange(risk()).table,
      sensitivityRange(risk()).caption,
      sensitivityBandChart({ labels: ['Jan'], series: [{ name: 'a', values: [1], low: [0], high: [2] }] }).svg,
      bandCaption(risk()),
      BAND_DISCLAIMER,
    ]
    for (const text of artifacts) {
      const hits = [...text.matchAll(/confidence interval/gi)]
      for (const hit of hits) {
        const around = text.slice(Math.max(0, hit.index - 40), hit.index + 40).toLowerCase()
        assert.match(around, /not |n't|never|no /, `unnegated "confidence interval": ...${around}...`)
      }
    }
  })

  it('carries the disclaimer out of this module rather than restating it per caller', () => {
    const source = readFileSync(new URL('../public/shared/viz-uncertainty.js', import.meta.url), 'utf8')
    // The other modules call `bandCaption`; none of them re-derives the wording.
    assert.match(source, /export const BAND_DISCLAIMER/)
    assert.ok(source.includes("'viz-uncertainty: record claims calibrated_uncertainty: true"))
  })

  it('escapes every value it renders', () => {
    const nasty = sensitivityBandChart({
      labels: ['<script>'],
      series: [{ name: '"><img src=x>', values: [50], low: [40], high: [70] }],
    })
    assert.ok(!nasty.svg.includes('<script>'))
    assert.ok(!nasty.svg.includes('<img'))
    const evil = sensitivityRange(risk({ region_name: '<script>alert(1)</script>' }))
    assert.ok(!evil.svg.includes('<script>'))
  })
})

describe('the empty cases still tell the truth', () => {
  it('draws no band and claims no skill when there is no series', () => {
    const c = sensitivityBandChart({ series: [] })
    assert.equal(c.empty, true)
    assert.ok(!c.svg.includes('viz-uncertainty-band'))
    // Even the empty state says what a band would have been.
    assert.match(c.svg, /NOT a confidence interval/)
  })

  it('produces finite coordinates rather than NaN when a bound is a string', () => {
    const c = sensitivityBandChart({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'a', values: ['50', '55'], low: ['40', ''], high: ['70', ''] }],
    })
    assert.ok(!c.svg.includes('NaN'), c.svg)
  })
})