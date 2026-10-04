// =============================================================
// Lindela Lite — uncertainty as geometry
// =============================================================
// ENH-17. The band is the product's central claim about its own honesty, and
// drawing it was the last thing standing between that claim and a number with a
// caveat attached — which, in a dashboard, is a caveat nobody reads.
//
// **What this band is.** A sensitivity band around a point score, whose width is
// a fixed linear function of an input-coverage confidence score:
//
//     halfWidth = round((100 - confidence) * 0.4)
//
// **What it is not.** A predictive interval, a confidence interval, or a
// probability of anything. There is no fitted distribution, no residual
// variance, and no posterior. `src/analytics.js` says so on every record with
// `calibrated_uncertainty: false`, and
// `docs/architecture/decisions/ADR-004-sensitivity-is-not-a-probability.md`
// exists because the previous field names (`score_p10/p50/p90`) promised a
// calibration that no computation performed.
//
// **So how does a reader not get it wrong?** Four mechanisms, all structural,
// none of them a footnote:
//
// 1. **The band is hatched, never a smooth gradient.** A hatched region reads as
//    "bounded by what we could measure" and survives greyscale printing and
//    every form of colour blindness, where a tinted gradient just becomes a
//    slightly different shade of the background. A confidence interval *wants*
//    to be drawn as a soft ribbon, and the contrast is the point: this is not
//    that.
// 2. **The edges carry the band's own vocabulary.** The bounds are drawn and
//    labelled as `sensitivity low` / `sensitivity high`, never as `p10`/`p90`
//    or a percentage. A reader who has seen a probabilistic chart elsewhere in
//    their working life is looking for a percentile label and will not find one.
// 3. **The caption is part of the return value, not an option.** Every function
//    here returns a `caption` string that names the band's basis and says
//    plainly what a zero-width band means. A caller cannot render the geometry
//    without the sentence, because the sentence is in the same object as the
//    geometry and the wiring step copies the whole thing.
// 4. **A record that claims calibration is refused, not relabelled.** See
//    `assertSensitivity` below.
//
// The map has the same problem in a different costume, and ENH-17 names the fix:
// at lower confidence a polygon should thin and hatch rather than flatten.
// `uncertaintyStyle` returns the opacity and hatch decision for a map feature so
// that every surface draws a thin-support polygon the same way.
//
// Pure, like `charts.js`: SVG strings out, no DOM, no globals.

import { esc } from './fmt.js'

/**
 * The sentence that travels with every band drawn by this module.
 *
 * It is exported so a caller that renders the caption somewhere other than the
 * default slot (a `<details>`, a footnote, a print-only line) uses the same
 * words rather than writing their own summary of a band they may have
 * misremembered.
 */
export const BAND_DISCLAIMER = 'Sensitivity band — NOT a confidence interval, NOT a predictive interval, NOT a probability. '
  + 'It is the spread of the score under different levels of input coverage: '
  + 'a zero-width band means the inputs were sufficient to compute a point score, not that the outcome is certain.'

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const formatScore = (v) => (num(v) === null ? '—' : String(Math.round(Number(v) * 100) / 100))

/**
 * Refuse anything that claims to be calibrated.
 *
 * The temptation this guards against is the one that produced ADR-004: a record
 * appears with a fitted interval, the shared primitive reaches for
 * `sensitivity_*` out of habit, and a real predictive interval gets published
 * under a caption saying it is a coverage artefact. A thrown error here is the
 * only version of this that fails loudly — a caption that quietly says "not
 * calibrated" would be its own lie.
 */
export function assertSensitivity(record) {
  if (record && record.calibrated_uncertainty === true) {
    throw new Error(
      'viz-uncertainty: record claims calibrated_uncertainty: true, so its bounds are a real predictive '
      + 'interval. Rendering them with a sensitivity caption would mislabel a probability. Use a primitive '
      + 'built for calibrated intervals, or clear the flag once the numbers are genuinely calibrated.',
    )
  }
  return record
}

/**
 * Read a record's sensitivity bounds, accepting the ADR-004 names.
 *
 * The `score_p*` aliases are read but the `sensitivity_*` names win, because the
 * aliases are retained purely for compatibility and a future removal of them
 * must not silently blank every band on the map.
 */
export function bandOf(record) {
  assertSensitivity(record)
  const low = num(record?.sensitivity_low ?? record?.score_p10)
  const high = num(record?.sensitivity_high ?? record?.score_p90)
  const mid = num(record?.sensitivity_mid ?? record?.score_p50 ?? record?.score)
  if (low === null && high === null) return null
  return {
    low: low === null ? mid : low,
    high: high === null ? mid : high,
    mid,
    // ADR-004 calls out the degenerate case explicitly: width 0 presents as "no
    // uncertainty" when it means "enough inputs to compute a point score at
    // all". Callers need both numbers, not one that conflates them.
    width: num(record?.sensitivity_width ?? record?.interval_width) ?? (low !== null && high !== null ? high - low : 0),
    confidence: num(record?.confidence),
  }
}

/**
 * The caption for one record's band, with the record's own `limits` prose
 * appended when it carries any.
 *
 * A record's `limits` is the specific list of what was not modelled. Dropping it
 * in favour of the generic disclaimer would lose the part that is true only of
 * *this* district; keeping only the generic one would lose the fact that the
 * band says nothing about the model at all. Both, in that order.
 */
export function bandCaption(record) {
  const parts = [BAND_DISCLAIMER]
  const width = num(record?.sensitivity_width ?? record?.interval_width)
  if (width === 0) {
    parts.push(`This record's band is ${width} points wide: the inputs were sufficient, so the score does not move when input coverage changes. It is not a claim that the flood will not happen.`)
  }
  const limits = record?.limits
  const limitsText = Array.isArray(limits) ? limits.filter(Boolean).join(' ') : limits
  if (limitsText) parts.push(`What was not modelled: ${limitsText}`)
  return parts.join(' ')
}

const HATCH_ID = 'viz-uncertainty-hatch'

/**
 * The hatch pattern, as an SVG `<defs>` fragment.
 *
 * 45° lines at 4px. Dense enough to survive a 200px-wide map polygon, coarse
 * enough that two adjacent hatches do not moiré into a solid fill. The stroke is
 * `--stroke-strong` rather than the series colour so that a hatched band over a
 * coloured line still has a visible boundary, and so the hatch means "coverage"
 * everywhere it appears in the product rather than meaning whatever hue the
 * caller passed in.
 */
function hatchDef() {
  return `<defs><pattern id="${HATCH_ID}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="4" stroke="var(--stroke-strong)" stroke-width="1.4"/>` +
    `</pattern></defs>`
}

const DEFAULT = Object.freeze({
  width: 480, height: 200, pad: { top: 16, right: 16, bottom: 44, left: 46 },
})

const boxOf = (o) => ({
  x0: o.pad.left, x1: o.width - o.pad.right,
  y0: o.pad.top, y1: o.height - o.pad.bottom,
})

/**
 * Sensitivity bands over a time series.
 *
 * `data` is `{ labels, series: [{ name, values, low, high }], title }`. Each
 * series' `low`/`high` are the same length as `values`; a null in either leaves
 * the band edge-broken at that point, because a bound interpolated across a month
 * nobody measured is a number with no source.
 *
 * Returns the usual `{ svg, table, label, caption, ... }` plus `basis`, which is
 * the literal string `'sensitivity'`. A caller that wants to badge the panel
 * reads that rather than hard-coding wording, so the badge cannot disagree with
 * the caption it is next to.
 */
export function sensitivityBandChart(data, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, ...(options.pad || {}) } }
  const series = (data?.series || []).filter((s) => s && Array.isArray(s.values) && s.values.length)
  if (!series.length) {
    return {
      svg: `<svg class="chart chart-uncertainty" viewBox="0 0 ${opts.width} ${opts.height}" width="100%" role="img" aria-labelledby="viz-unc-empty-t" preserveAspectRatio="xMidYMid meet"><title id="viz-unc-empty-t">${esc(data?.empty || 'No data')}</title><desc>${esc(BAND_DISCLAIMER)}</desc><text x="${opts.width / 2}" y="${opts.height / 2}" text-anchor="middle" fill="var(--ink-faint)">${esc(data?.empty || 'No data')}</text></svg>`,
      caption: bandCaption(null),
      basis: 'sensitivity',
      label: data?.empty || 'No data',
      missing: 0,
      total: 0,
      empty: true,
    }
  }

  const n = series[0].values.length
  const labels = data?.labels || []
  const present = series.flatMap((s) => [...s.values.map(num), ...(s.low || []).map(num), ...(s.high || []).map(num)])
    .filter((v) => v !== null)
  if (!present.length) return sensitivityBandChart({ empty: 'No values recorded' }, options)

  // Fixed 0..100 unless the caller says otherwise. Risk scores are on a bounded
  // scale and drawing them against a data-derived extent makes two districts'
  // bands look comparable when they are not — the reader's eye compares the
  // drawn height, and a stretched axis invites that.
  const reach = num(options.max) ?? Math.max(100, ...present)
  const box = boxOf(opts)
  const y = (v) => box.y1 - ((v / reach) * (box.y1 - box.y0))
  const xAt = (i) => (n > 1 ? box.x0 + (i * (box.x1 - box.x0)) / (n - 1) : (box.x0 + box.x1) / 2)

  let inner = hatchDef()
  for (const v of [0, 0.25, 0.5, 0.75, 1].map((f) => f * reach)) {
    inner += `<line x1="${box.x0}" x2="${box.x1}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--stroke)" stroke-width="1"/>` +
      `<text x="${box.x0 - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="chart-tick" fill="var(--ink-muted)">${esc(formatScore(v))}</text>`
  }

  for (const s of series) {
    const color = s.color || `var(--brand)`
    const lows = s.low || []
    const highs = s.high || []
    // Build the band per contiguous run of present bounds. Joining across a gap
    // is the same defect as bridging a line across a missing month: it draws a
    // bound for a period nobody has a bound for.
    const runs = []
    let run = []
    for (let i = 0; i <= n; i += 1) {
      const lo = i < n ? num(lows[i]) : null
      const hi = i < n ? num(highs[i]) : null
      if (lo !== null && hi !== null) {
        run.push({ i, lo, hi })
      } else {
        if (run.length) runs.push(run)
        run = []
      }
    }
    for (const r of runs) {
      if (r.length < 2) continue
      const top = r.map((p) => `${xAt(p.i).toFixed(1)},${y(p.hi).toFixed(1)}`).join(' ')
      const bottom = [...r].reverse().map((p) => `${xAt(p.i).toFixed(1)},${y(p.lo).toFixed(1)}`).join(' ')
      inner += `<polygon class="viz-uncertainty-band" data-basis="sensitivity" fill="url(#${HATCH_ID})" fill-opacity="0.85" ` +
        `stroke="${esc(color)}" stroke-width="1" stroke-dasharray="4 2" points="${top} ${bottom}"/>`
    }
    // The point score on top, unbroken across gaps the same way the band is not.
    let pts = []
    let path = []
    for (let i = 0; i <= n; i += 1) {
      const v = i < n ? num(s.values[i]) : null
      if (v === null) {
        if (path.length) pts.push(path.join(' '))
        path = []
      } else {
        path.push(`${xAt(i).toFixed(1)},${y(v).toFixed(1)}`)
      }
    }
    for (const run of pts) {
      // A run of one point is a dot, not a trend. A polyline with a single pair
      // of coordinates draws nothing at all, so a score observed in one month
      // and missing the next would be *invisible* — which is worse than a gap,
      // because the reader sees an absence where there is a measurement.
      if (!run.includes(' ')) {
        const [cx, cy] = run[0].split(',')
        inner += `<circle class="viz-uncertainty-score" cx="${cx}" cy="${cy}" r="3.5" fill="${esc(color)}"/>`
        continue
      }
      inner += `<polyline class="viz-uncertainty-score" fill="none" stroke="${esc(color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${run}"/>`
    }
  }

  // Edge labels. These are the second mechanism and the cheapest one: a reader
  // who knows what a percentile band looks like looks for a percentile label.
  const first = series[0]
  const anyBand = (first.low || []).some((v) => num(v) !== null)
  if (anyBand) {
    const firstIdx = (first.low || []).findIndex((v) => num(v) !== null)
    const lo = num(first.low[firstIdx])
    const hi = num(first.high[firstIdx])
    if (lo !== null && hi !== null) {
      const x = xAt(firstIdx)
      inner += `<text class="viz-uncertainty-edge chart-tick" x="${(x + 4).toFixed(1)}" y="${(y(hi) - 4).toFixed(1)}" fill="var(--ink-muted)">sensitivity high ${esc(formatScore(hi))}</text>`
      inner += `<text class="viz-uncertainty-edge chart-tick" x="${(x + 4).toFixed(1)}" y="${(y(lo) + 12).toFixed(1)}" fill="var(--ink-muted)">sensitivity low ${esc(formatScore(lo))}</text>`
    }
  }

  const stride = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((box.x1 - box.x0) / 70))))
  labels.forEach((label, i) => {
    if (i % stride !== 0 && i !== labels.length - 1) return
    inner += `<text x="${xAt(i).toFixed(1)}" y="${box.y1 + 16}" text-anchor="middle" class="chart-tick" fill="var(--ink-muted)">${esc(String(label ?? ''))}</text>`
  })

  const title = data.title || 'Sensitivity bands over time'
  const desc = `${title}. Hatched regions are sensitivity bands: the spread of the score under different levels of input coverage, not a confidence or predictive interval.`
  const svgMarkup = `<svg class="chart chart-uncertainty" viewBox="0 0 ${opts.width} ${opts.height}" width="100%" role="img" ` +
    `aria-labelledby="viz-unc-t" aria-describedby="viz-unc-d" preserveAspectRatio="xMidYMid meet">` +
    `<title id="viz-unc-t">${esc(title)}</title><desc id="viz-unc-d">${esc(desc)}</desc>${inner}</svg>`

  const headers = [data.xLabel || 'Period', ...series.flatMap((s) => [s.name || `Series`, 'sensitivity low', 'sensitivity high'])]
  const rows = (labels.length ? labels.map((l, i) => l ?? `#${i + 1}`) : Array.from({ length: n }, (_, i) => `#${i + 1}`))
    .map((label, i) => [label, ...series.flatMap((s) => {
      const v = num(s.values[i])
      const lo = num((s.low || [])[i])
      const hi = num((s.high || [])[i])
      return [v === null ? 'not recorded' : formatScore(v), lo === null ? 'not recorded' : formatScore(lo), hi === null ? 'not recorded' : formatScore(hi)]
    })])

  const captionText = data.caption || bandCaption({ ...(data.record || {}), limits: data.limits })
  return {
    svg: svgMarkup,
    table: `<div class="chart-table"><table class="data-alt"><caption>${esc(title)} — sensitivity bounds, not a confidence interval</caption>` +
      `<thead><tr>${headers.map((h, i) => `<th scope="col"${i === 0 ? '' : ' class="num"'}>${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td class="num">${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`,
    label: title,
    caption: captionText,
    basis: 'sensitivity',
    disclaimer: BAND_DISCLAIMER,
    missing: series.reduce((sum, s) => sum + s.values.filter((v) => num(v) === null).length, 0),
    total: n * series.length,
  }
}

/**
 * One record's band as geometry: a 0..100 axis, the band hatched in place, the
 * point score as a rule across it.
 *
 * This is the map → chart → record step of ENH-19. A district polygon carries a
 * score and a width but no shape; clicking through has to land somewhere that
 * shows the width as a distance on a bounded scale, because "sensitivity 40–68"
 * and "sensitivity 60–62" are not the same claim and the difference is the
 * band's whole point.
 */
export function sensitivityRange(record, options = {}) {
  assertSensitivity(record)
  const opts = { ...DEFAULT, height: 120, ...options, pad: { ...DEFAULT.pad, top: 18, bottom: 40, ...(options.pad || {}) } }
  const band = bandOf(record)
  const title = options.title || `${record?.region_name || record?.id || 'Score'} — sensitivity band`
  const emptyMarkup = (message) => `<svg class="chart chart-uncertainty" viewBox="0 0 ${opts.width} ${opts.height}" width="100%" role="img" aria-labelledby="viz-range-t" preserveAspectRatio="xMidYMid meet"><title id="viz-range-t">${esc(title)}</title><desc>${esc(BAND_DISCLAIMER)}</desc><text x="${opts.width / 2}" y="${opts.height / 2}" text-anchor="middle" fill="var(--ink-faint)">${esc(message)}</text></svg>`

  if (!band) {
    return {
      svg: emptyMarkup('No sensitivity band on this record'),
      table: `<div class="chart-table"><table class="data-alt"><caption>${esc(title)}</caption><thead><tr><th scope="col">Measure</th><th scope="col" class="num">Value</th></tr></thead><tbody><tr><th scope="row">sensitivity band</th><td class="num">not recorded</td></tr></tbody></table></div>`,
      caption: bandCaption(record),
      basis: 'sensitivity',
      label: title,
      missing: 1,
      total: 1,
      empty: true,
    }
  }

  const reach = num(options.max) ?? Math.max(100, band.high, band.mid ?? 0)
  const box = boxOf(opts)
  const x = (v) => box.x0 + ((v / reach) * (box.x1 - box.x0))
  const yMid = (box.y0 + box.y1) / 2
  const barH = 28

  let inner = hatchDef()
  // The bounded track behind everything, so a reader can see the band against
  // the full scale rather than against its own extent.
  inner += `<rect x="${box.x0}" y="${(yMid - barH / 2).toFixed(1)}" width="${(box.x1 - box.x0).toFixed(1)}" height="${barH}" rx="3" fill="var(--surface)" stroke="var(--stroke)" stroke-width="1"/>`
  inner += `<rect class="viz-uncertainty-band" data-basis="sensitivity" x="${x(band.low).toFixed(1)}" y="${(yMid - barH / 2).toFixed(1)}" ` +
    `width="${Math.max(1, x(band.high) - x(band.low)).toFixed(1)}" height="${barH}" fill="url(#${HATCH_ID})" fill-opacity="0.85" ` +
    `stroke="var(--stroke-strong)" stroke-width="1" stroke-dasharray="4 2" rx="3"/>`
  if (band.mid !== null) {
    inner += `<line class="viz-uncertainty-score" x1="${x(band.mid).toFixed(1)}" x2="${x(band.mid).toFixed(1)}" y1="${(yMid - barH / 2 - 6).toFixed(1)}" y2="${(yMid + barH / 2 + 6).toFixed(1)}" stroke="var(--brand)" stroke-width="2.5"/>`
  }
  inner += `<text x="${x(band.low).toFixed(1)}" y="${(yMid - barH / 2 - 8).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink-muted)">low ${esc(formatScore(band.low))}</text>`
  inner += `<text x="${x(band.high).toFixed(1)}" y="${(yMid - barH / 2 - 8).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink-muted)">high ${esc(formatScore(band.high))}</text>`
  if (band.mid !== null) {
    inner += `<text x="${x(band.mid).toFixed(1)}" y="${(yMid + barH / 2 + 18).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink)">score ${esc(formatScore(band.mid))}</text>`
  }
  inner += `<text x="${box.x0}" y="${opts.height - 6}" text-anchor="start" class="chart-tick" fill="var(--ink-faint)">0</text>`
  inner += `<text x="${box.x1}" y="${opts.height - 6}" text-anchor="end" class="chart-tick" fill="var(--ink-faint)">${esc(formatScore(reach))}</text>`

  const desc = `${title}. The point score is ${band.mid === null ? 'not recorded' : formatScore(band.mid)}; the hatched sensitivity band runs `
    + `from ${formatScore(band.low)} to ${formatScore(band.high)}, a width of ${formatScore(band.width)} points. `
    + 'The band reflects input coverage and is not a confidence interval or a probability.'
  return {
    svg: `<svg class="chart chart-uncertainty" viewBox="0 0 ${opts.width} ${opts.height}" width="100%" role="img" aria-labelledby="viz-range-t" aria-describedby="viz-range-d" preserveAspectRatio="xMidYMid meet">` +
      `<title id="viz-range-t">${esc(title)}</title><desc id="viz-range-d">${esc(desc)}</desc>${inner}</svg>`,
    table: `<div class="chart-table"><table class="data-alt"><caption>${esc(title)} — sensitivity bounds, not a confidence interval</caption>` +
      `<thead><tr><th scope="col">Measure</th><th scope="col" class="num">Value</th></tr></thead><tbody>` +
      `<tr><th scope="row">score</th><td class="num">${band.mid === null ? 'not recorded' : esc(formatScore(band.mid))}</td></tr>` +
      `<tr><th scope="row">sensitivity low</th><td class="num">${esc(formatScore(band.low))}</td></tr>` +
      `<tr><th scope="row">sensitivity high</th><td class="num">${esc(formatScore(band.high))}</td></tr>` +
      `<tr><th scope="row">sensitivity width</th><td class="num">${esc(formatScore(band.width))}</td></tr>` +
      `<tr><th scope="row">input coverage confidence</th><td class="num">${band.confidence === null ? 'not recorded' : esc(formatScore(band.confidence))}</td></tr>` +
      `<tr><th scope="row">calibrated uncertainty</th><td class="num">no — this is a sensitivity band</td></tr>` +
      '</tbody></table></div>',
    caption: bandCaption(record),
    basis: 'sensitivity',
    disclaimer: BAND_DISCLAIMER,
    band,
    label: title,
    missing: band.mid === null ? 1 : 0,
    total: 1,
  }
}

/**
 * How a map feature should look at this confidence.
 *
 * ENH-17's second half: "at lower confidence, reduce opacity and hatch the
 * polygon rather than flattening it." Flattening means dropping the feature, or
 * drawing it at a value the reader cannot distinguish from a real one — both
 * read as "no risk here" when they mean "we could not measure here".
 *
 * `confidence` is the same 0..100 input-coverage score the band width comes
 * from, so the map and the band thin together: a district whose band is wide is
 * the same district whose polygon is pale, and neither is a separate judgement.
 *
 * Returns tokens and a class name, not a style string. The caller sets them on
 * whatever element it draws; no surface invents its own opacity ladder.
 */
export function uncertaintyStyle(record, { thresholds = { hatch: 60, fade: 80 } } = {}) {
  assertSensitivity(record)
  const confidence = num(record?.confidence)
  if (confidence === null) {
    // No coverage figure is not "full confidence". It is the case where the
    // polygon has to look least trustworthy, because that is all we know.
    return { opacity: 0.35, hatch: true, confidence: null, level: 'unknown', reason: 'no input-coverage score on this record' }
  }
  const clamped = Math.max(0, Math.min(100, confidence))
  const hatch = clamped < thresholds.hatch
  // Opacity is a step, not a ramp. A continuous ramp invites a reader to read a
  // difference out of a difference they cannot see; three named levels can be
  // shown in a legend and cannot be over-read.
  const level = clamped < thresholds.hatch ? 'thin' : clamped < thresholds.fade ? 'partial' : 'well-covered'
  const opacity = level === 'thin' ? 0.4 : level === 'partial' ? 0.65 : 0.9
  return {
    opacity,
    hatch,
    level,
    confidence: clamped,
    class: `viz-uncertainty viz-uncertainty-${level}`,
    reason: level === 'thin'
      ? `input coverage ${formatScore(clamped)} — hatched and faded`
      : level === 'partial'
        ? `input coverage ${formatScore(clamped)} — faded`
        : `input coverage ${formatScore(clamped)} — drawn at full strength`,
  }
}