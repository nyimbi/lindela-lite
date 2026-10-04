// =============================================================
// Lindela Lite — forecast versus observed
// =============================================================
// ENH-21. `src/connectors/open-meteo.js` ingests both a forecast and what
// actually happened, stores them side by side in `climate_observations`, and
// nothing in the product ever compares them. This module is that comparison.
//
// **Why the visual has to be careful.** The default reading of any reliability
// diagram is flattering: bin the forecasts, plot observed frequency, and if the
// line happens to sit near the diagonal the product looks trustworthy. Two
// failure modes make that dishonest, and this module is built to refuse both.
//
// 1. **An unverified forecast is not a good one.** A diagram that plots only
//    the forecasts that were later observed makes the product look better the
//    shorter its verification window — the opposite of the truth. So every
//    return value separates `verified` from `pending`, `pending` is counted
//    rather than dropped, and the chart renders pending forecasts as an
//    explicitly unverified row in a distinct token. The coverage number is on
//    the face of the chart, not in a footnote: a reliability diagram read at
//    30% verification coverage is a claim about 30% of forecasts.
// 2. **Small bins look like skill.** A bin holding one observation lands exactly
//    on 0 or 1 and reads as a perfect or a disastrous forecast. So bin width is
//    a parameter with a default that refuses to go below 5, every bin carries
//    its `n` in the label, and bins with no observations are drawn as empty
//    rather than omitted — an absent bin is a statement about sample size.
//
// **What the metrics are.** Brier score, the base rate, and a reliability
// summary. Brier is chosen over more familiar names because it has one honest
// definition: mean squared error of a probability against a 0/1 outcome. It does
// not require a population to be Gaussian, does not need a "climatology" of
// which we have none (see ADR-005), and is defined when there is exactly one
// verification. Skill scores of the form "beats the base rate" are reported
// against the *observed base rate*, and are `null` rather than `0` when there is
// nothing to compare against — an unmeasured comparison is not a failed one,
// and reporting it as 0 is the same defect as the false-alert rate ADR-004
// describes.
//
// **Pairing, which is the part that can quietly go wrong.** A forecast and an
// observation are the same *event* only if they refer to the same place and the
// same valid time. Pairing on proximity alone would match a Day-1 forecast with
// a Day-3 observation and score it as a miss, which measures the join key and
// not the forecast. `pairForecasts` therefore requires an explicit matching key
// and reports every unmatched record on both sides — the ones that fell out are
// as interesting as the ones that stayed, because a high unmatched rate means
// the join is wrong and the whole diagram is then measuring the wrong thing.
//
// Pure: arrays in, SVG strings and plain objects out.

import { esc } from './fmt.js'

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const round = (v, dp = 4) => {
  const n = num(v)
  return n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp
}

/**
 * Bin edges for a reliability diagram.
 *
 * Width is in **percentage points of forecast probability**, so `[0, 20)` means
 * forecasts that said 0%–19% rain. Ten points wide is the default: below that a
 * bin's observed frequency moves in steps of 10 points, and a diagram whose
 * every bin is noisier than its own bins is a diagram nobody can read a skill
 * out of. `minWidth` is a floor rather than a default for the same reason.
 */
export function binEdges({ count = 5, max = 100, minWidth = 10 } = {}) {
  const width = Math.max(minWidth, Math.min(100, Math.round((max / Math.max(1, count)) / minWidth) * minWidth))
  const edges = []
  for (let v = 0; v < max; v += width) edges.push([v, Math.min(max, v + width)])
  return edges
}

/**
 * Match forecasts to later observations.
 *
 * `forecasts` and `observations` are arrays of records. Both are keyed by
 * `key(record)` — a caller passes something like
 * `(r) => \`${r.region_name}|${r.observed_at}\``, which is exactly the join the
 * archive can support. The default refuses rather than guesses: no key, no
 * pairing.
 *
 * Each pair is `{ forecast, observation, probability, outcome, lead_days,
 * status }` where `status` is:
 *
 *   `verified` — an observation exists for this key and yields a 0/1 outcome
 *   `pending`  — the forecast is for a future valid time; nothing to check yet
 *   `no_outcome` — an observation exists but the event definition could not be
 *                evaluated against it (no threshold, or no measurement)
 *   `unusable` — the forecast carries no probability, so it cannot be binned
 *
 * A `pending` pair is kept, not filtered. Dropping it is what makes a product's
 * verification look better the less it has verified.
 *
 * `eventOf(observation, { threshold })` returns 1 if the event happened, 0 if it
 * did not, and `null` if it cannot be determined. It must be supplied for
 * anything to be verified; without it every pair is `no_outcome`, which is the
 * honest answer for a diagram whose event was never defined.
 */
export function pairForecasts(forecasts, observations, options = {}) {
  const key = typeof options.key === 'function' ? options.key : null
  if (!key) throw new Error('viz-verify: pairForecasts needs `key(record)`; matching a forecast to an observation without an explicit join key would score the join rather than the forecast')
  const eventOf = typeof options.eventOf === 'function' ? options.eventOf : null
  const asOf = num(options.asOf) ?? null

  const forecastsList = Array.isArray(forecasts) ? forecasts : []
  const observedList = Array.isArray(observations) ? observations : []

  const byKey = new Map()
  for (const o of observedList) {
    const k = key(o)
    if (k === null || k === undefined || k === '') continue
    // Two observations for one key: keep the earlier one. An observation filed
    // later is a revision of the same measurement, and scoring a forecast
    // against both would count one forecast twice.
    const existing = byKey.get(k)
    const parsed = Date.parse(o?.observed_at)
    // Compare the parsed numbers. Comparing against `existing.at` — a string —
    // makes `at < existing.at` a string-to-string comparison, and the earlier
    // revision loses every time its digits happen to sort later.
    if (!existing || (Number.isFinite(parsed) && Number.isFinite(existing.parsed) && parsed < existing.parsed)) {
      byKey.set(k, { record: o, at: o?.observed_at ?? null, parsed })
    }
  }

  const pairs = []
  const matchedObservationKeys = new Set()
  for (const f of forecastsList) {
    const k = key(f)
    const probability = num(f?.probability ?? f?.precipitation_probability_pct)
    const validMs = Date.parse(f?.valid_at ?? f?.observed_at ?? '')
    const issuedMs = Date.parse(f?.issued_at ?? f?.created_at ?? '')
    const leadDays = Number.isNaN(validMs) || Number.isNaN(issuedMs) ? null : Math.round(((validMs - issuedMs) / 86400e3) * 10) / 10
    const base = { forecast: f, key: k ?? null, probability, lead_days: leadDays, outcome: null }

    if (probability === null) {
      pairs.push({ ...base, observation: null, status: 'unusable', reason: 'the forecast carries no probability to bin' })
      continue
    }
    if (asOf !== null && !Number.isNaN(validMs) && validMs > asOf) {
      // In the future as of the evaluation date. Not pending-by-accident: this
      // is the case where nothing *can* yet be known, and it is the one a
      // diagram has to display rather than drop.
      pairs.push({ ...base, observation: null, status: 'pending', reason: `valid ${f?.valid_at || f?.observed_at}, which is after the evaluation date` })
      continue
    }
    const hit = byKey.get(k)
    if (!hit) {
      pairs.push({ ...base, observation: null, status: 'no_outcome', reason: 'no observation carries this key, so the forecast cannot be checked' })
      continue
    }
    matchedObservationKeys.add(k)
    if (!eventOf) {
      pairs.push({ ...base, observation: hit.record, status: 'no_outcome', reason: 'no event definition was supplied, so the observation cannot be turned into an outcome' })
      continue
    }
    let outcome = null
    try {
      outcome = eventOf(hit.record, options)
    } catch {
      outcome = null
    }
    if (outcome !== 0 && outcome !== 1 && outcome !== true && outcome !== false) {
      pairs.push({ ...base, observation: hit.record, status: 'no_outcome', reason: 'the event definition returned no 0/1 outcome for this observation' })
      continue
    }
    pairs.push({ ...base, observation: hit.record, outcome: outcome === true ? 1 : outcome === false ? 0 : outcome, status: 'verified' })
  }

  const unmatchedObservations = observedList.filter((o) => {
    const k = key(o)
    return k !== null && k !== undefined && k !== '' && !matchedObservationKeys.has(k)
  })

  const counts = pairs.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc }, {})
  return {
    pairs,
    verified: pairs.filter((p) => p.status === 'verified'),
    pending: pairs.filter((p) => p.status === 'pending'),
    counts,
    total: pairs.length,
    // The number a reader must see before the diagram: of everything forecast,
    // how much has actually been checked.
    coverage: pairs.length ? round(counts.verified / pairs.length, 3) : null,
    unmatchedObservations: unmatchedObservations.length,
    // The share of observations no forecast reached. Zero matched is the most
    // suspect case of all, not a special one that escapes the check — a diagram
    // built on a join nothing survived is measuring the join.
    joinSuspect: observedList.length > 0 && unmatchedObservations.length / observedList.length > 0.5,
    unmatched: unmatchedObservations,
  }
}

/**
 * Reliability bins plus the metrics that go with them.
 *
 * Only `verified` pairs enter a bin. Every other status is counted and named, so
 * a caller rendering the chart cannot accidentally plot them and cannot
 * accidentally omit them either.
 */
export function reliability(pairs, options = {}) {
  const list = Array.isArray(pairs) ? pairs : []
  const verified = list.filter((p) => p?.status === 'verified' && num(p.probability) !== null && (p.outcome === 0 || p.outcome === 1))
  const edges = binEdges({ count: options.bins ?? 5, max: 100, minWidth: options.minWidth ?? 10 })

  const bins = edges.map(([lo, hi]) => {
    const members = verified.filter((p) => {
      const pct = (num(p.probability) / 100) * 100
      return pct >= lo && (hi >= 100 ? pct <= hi : pct < hi)
    })
    const outcomes = members.map((p) => p.outcome)
    const hits = outcomes.reduce((n, o) => n + o, 0)
    return {
      lo,
      hi,
      label: `${lo}–${hi}%`,
      n: members.length,
      // Null, not zero, for an empty bin. A frequency of 0 in a bin holding no
      // forecasts says the product never forecasts below 0%; a frequency of 0
      // in a bin holding ten forecasts says all ten were wrong. Only one of
      // those is a claim about the world, and it is the wrong one for the empty
      // bin.
      forecast: members.length ? round(members.reduce((s, p) => s + num(p.probability), 0) / members.length / 100, 4) : null,
      observed: members.length ? round(hits / members.length, 4) : null,
      hits,
      leadDays: members.length ? round(members.reduce((s, p) => s + (num(p.lead_days) ?? 0), 0) / members.length, 1) : null,
    }
  })

  const n = verified.length
  const brier = n ? round(verified.reduce((s, p) => s + Math.pow(num(p.probability) / 100 - p.outcome, 2), 0) / n, 4) : null
  const baseRate = n ? round(verified.reduce((s, p) => s + p.outcome, 0) / n, 4) : null
  // Brier of always forecasting the observed base rate — the only climatology
  // available, since there is no validated record of outcomes to build one from.
  const baseBrier = n ? round(verified.reduce((s, p) => s + Math.pow(baseRate - p.outcome, 2), 0) / n, 4) : null
  // Null rather than 0 when it is undefined: a negative skill score means the
  // forecast was worse than the base rate, and 0 means it was exactly as good,
  // and reporting the undefined case as 0 is the same defect ADR-004 describes
  // for the false-alert rate.
  const skill = brier !== null && baseBrier !== null && baseBrier > 0 ? round(1 - brier / baseBrier, 4) : null

  const pending = list.filter((p) => p?.status === 'pending').length
  return {
    bins,
    n,
    total: list.length,
    pending,
    unverified: list.filter((p) => p?.status !== 'verified').length,
    coverage: list.length ? round(n / list.length, 3) : null,
    brier,
    baseRate,
    baseBrier,
    skill,
    /** Bins holding fewer than this are too small to carry a conclusion. */
    minBin: options.minBin ?? 5,
    trustworthy: n >= (options.minBin ?? 5),
    statement: n === 0
      ? 'Nothing has been verified yet. A forecast with no observation behind it has no measured skill, and this diagram deliberately shows none rather than an empty diagonal.'
      : skill === null
        ? `Brier score ${brier} over ${n} verification(s). Skill against the observed base rate is not defined — there is no spread in outcomes to beat.`
        : `Brier score ${brier} over ${n} verification(s); skill against the observed base rate ${skill > 0 ? 'is positive' : skill < 0 ? 'is negative' : 'is exactly zero'}. `
          + (skill < 0 ? 'A negative skill score means the forecasts were worse than always quoting the observed base rate.' : ''),
  }
}

const DEFAULT = Object.freeze({ width: 420, height: 340, pad: { top: 28, right: 16, bottom: 56, left: 44 } })

/**
 * The reliability diagram, drawn honestly.
 *
 * Four things on the face of the chart that a reader cannot miss:
 *
 * 1. **The diagonal**, labelled "perfect calibration", so the reader has a
 *    reference before reading any point.
 * 2. **Every bin labelled with its `n`.** A point at 100% observed frequency in
 *    a bin of 3 is a very different statement from the same point in a bin of
 *    300, and the label is what tells them apart.
 * 3. **Unverified forecasts get their own row**, drawn in `--warn` and labelled
 *    "not yet observed", below the axis. They are never plotted on the
 *    frequency scale, because putting a pending forecast at 0% observed is the
 *    single most misleading thing this chart could do.
 * 4. **The coverage statement**, in the caption the caller cannot omit: what
 *    fraction of forecasts has been checked at all.
 *
 * Empty bins are drawn as hollow circles rather than skipped. The gap in the
 * line is information about the forecast's own spread — a forecast system that
 * only ever issues 40–60% has a reliability diagram with one point and four
 * holes, and that is worth seeing.
 */
export function reliabilityDiagram(summary, options = {}) {
  const opts = { ...DEFAULT, ...options, pad: { ...DEFAULT.pad, ...(options.pad || {}) } }
  const s = summary || { bins: [], n: 0 }
  const box = {
    x0: opts.pad.left, x1: opts.width - opts.pad.right,
    y0: opts.pad.top, y1: opts.height - opts.pad.bottom,
  }
  const x = (p) => box.x0 + p * (box.x1 - box.x0)
  const y = (p) => box.y1 - p * (box.y1 - box.y0)

  let inner = ''
  // Grid at 0/25/50/75/100% on both axes, printed on both. An axis nobody can
  // read is a decoration, and this chart is read by comparing two positions.
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    inner += `<line x1="${x(f).toFixed(1)}" x2="${x(f).toFixed(1)}" y1="${box.y0}" y2="${box.y1}" stroke="var(--stroke)" stroke-width="1"/>` +
      `<line x1="${box.x0}" x2="${box.x1}" y1="${y(f).toFixed(1)}" y2="${y(f).toFixed(1)}" stroke="var(--stroke)" stroke-width="1"/>` +
      `<text x="${x(f).toFixed(1)}" y="${(box.y1 + 16).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink-muted)">${Math.round(f * 100)}%</text>` +
      `<text x="${(box.x0 - 6).toFixed(1)}" y="${(y(f) + 4).toFixed(1)}" text-anchor="end" class="chart-tick" fill="var(--ink-muted)">${Math.round(f * 100)}%</text>`
  }
  // The reference. Dashed so it is never confused with a data point or a grid
  // line — it is the thing being measured against, not a measurement.
  inner += `<line x1="${x(0).toFixed(1)}" y1="${y(0).toFixed(1)}" x2="${x(1).toFixed(1)}" y2="${y(1).toFixed(1)}" stroke="var(--ink-faint)" stroke-width="1.5" stroke-dasharray="5 4"/>`
  inner += `<text x="${x(1).toFixed(1)}" y="${(y(1) - 6).toFixed(1)}" text-anchor="end" class="chart-tick" fill="var(--ink-faint)">perfect calibration</text>`
  inner += `<text x="${((box.x0 + box.x1) / 2).toFixed(1)}" y="${(box.y1 + 34).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink-muted)">forecast probability</text>`
  inner += `<text x="${(box.x0 - 30).toFixed(1)}" y="${((box.y0 + box.y1) / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 ${(box.x0 - 30).toFixed(1)} ${((box.y0 + box.y1) / 2).toFixed(1)})" class="chart-tick" fill="var(--ink-muted)">observed frequency</text>`

  // The verified series, joined only across consecutive occupied bins so the
  // line never crosses an empty one.
  let run = []
  const runs = []
  for (const b of s.bins) {
    if (b.n === 0 || b.forecast === null || b.observed === null) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    run.push(b)
  }
  if (run.length) runs.push(run)
  for (const r of runs) {
    if (r.length < 2) continue
    inner += `<polyline class="viz-verify-line" fill="none" stroke="var(--brand)" stroke-width="2" points="${r.map((b) => `${x(b.forecast).toFixed(1)},${y(b.observed).toFixed(1)}`).join(' ')}"/>`
  }

  for (const b of s.bins) {
    if (b.n === 0 || b.forecast === null || b.observed === null) {
      // A hollow marker, not a skipped one: the reader sees that the bin exists
      // and is empty.
      inner += `<circle class="viz-verify-empty" cx="${x((b.lo + b.hi) / 200).toFixed(1)}" cy="${box.y1}" r="4" fill="none" stroke="var(--stroke-strong)" stroke-width="1.5"/>` +
        `<text x="${x((b.lo + b.hi) / 200).toFixed(1)}" y="${(box.y1 - 8).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--ink-faint)">0</text>`
      continue
    }
    const thin = b.n < (s.minBin ?? 5)
    inner += `<circle class="viz-verify-point${thin ? ' viz-verify-point-thin' : ''}" cx="${x(b.forecast).toFixed(1)}" cy="${y(b.observed).toFixed(1)}" r="6" fill="${thin ? 'var(--surface)' : 'var(--brand)'}" stroke="${thin ? 'var(--warn)' : 'var(--brand)'}" stroke-width="2"/>` +
      `<text x="${x(b.forecast).toFixed(1)}" y="${(y(b.observed) - 10).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="${thin ? 'var(--warn)' : 'var(--ink-muted)'}">${esc(String(b.label))} · n=${esc(String(b.n))}</text>`
  }

  // The unverified row, below the axis and outside the frequency scale.
  if (s.unverified) {
    const yRow = box.y1 + 46
    inner += `<rect class="viz-verify-unverified" x="${box.x0}" y="${(yRow - 11).toFixed(1)}" width="${(box.x1 - box.x0).toFixed(1)}" height="16" rx="3" fill="color-mix(in oklab, var(--warn) 22%, var(--surface))" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 2"/>` +
      `<text x="${((box.x0 + box.x1) / 2).toFixed(1)}" y="${(yRow + 1).toFixed(1)}" text-anchor="middle" class="chart-tick" fill="var(--warn)">${esc(String(s.unverified))} forecast(s) not yet observed — no skill is claimed for these</text>`
  }

  const title = options.title || 'Forecast reliability'
  const desc = s.n === 0
    ? `${title}. No forecast has been verified against an observation yet, so no skill is claimed and no point is plotted. ${s.unverified ? `${s.unverified} forecast(s) await observation.` : ''}`
    : `${title}. ${s.bins.filter((b) => b.n).map((b) => `${b.label}: ${b.observed} observed across ${b.n} forecast(s)`).join('; ')}. `
      + (s.statement || '')
  const svgMarkup = `<svg class="chart viz-verify" viewBox="0 0 ${opts.width} ${opts.height}" width="100%" role="img" aria-labelledby="viz-verify-t" aria-describedby="viz-verify-d" preserveAspectRatio="xMidYMid meet">` +
    `<title id="viz-verify-t">${esc(title)}</title><desc id="viz-verify-d">${esc(desc)}</desc>${inner}</svg>`

  const headers = ['Forecast bin', 'Forecasts', 'Mean forecast', 'Observed frequency', 'Hits', 'Mean lead (days)']
  const rows = s.bins.map((b) => [b.label, String(b.n),
    b.forecast === null ? 'none' : `${Math.round(b.forecast * 100)}%`,
    b.observed === null ? 'not enough verifications' : `${Math.round(b.observed * 100)}%`,
    String(b.hits),
    b.leadDays === null ? '—' : String(b.leadDays)])
  if (s.unverified) rows.push(['not yet observed', String(s.unverified), '—', 'not verified — no skill claimed', '—', '—'])

  const caption = `Verified ${s.n} of ${s.total} forecast(s)${s.coverage === null ? '' : ` (${Math.round(s.coverage * 100)}%)`}. `
    + `${s.statement || ''} An unverified forecast is not a good one: it is an unmeasured one, and it is counted rather than dropped.`

  return {
    svg: svgMarkup,
    table: `<div class="chart-table"><table class="data-alt"><caption>${esc(title)} — observed frequency against forecast probability</caption>` +
      `<thead><tr>${headers.map((h, i) => `<th scope="col"${i === 0 ? '' : ' class="num"'}>${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td class="num">${esc(c)}</td>`)).join('')}</tr>`).join('')}` +
      `<tr><th scope="row">Brier score</th><td class="num" colspan="5">${s.brier === null || s.brier === undefined ? 'not measurable — nothing verified' : esc(String(s.brier))}</td></tr>` +
      `<tr><th scope="row">Skill vs observed base rate</th><td class="num" colspan="5">${s.skill === null || s.skill === undefined ? 'not defined' : esc(String(s.skill))}</td></tr>` +
      '</tbody></table></div>',
    caption,
    label: title,
    verified: s.n,
    unverified: s.unverified,
    coverage: s.coverage,
    trustworthy: s.trustworthy,
  }
}

/**
 * Verification split by lead time — the axis ENH-21 names.
 *
 * Skill is rarely uniform across lead times and a single diagram hides that. A
 * return per lead bucket, each with its own `n` and Brier, so a caller can say
 * "the product is skilful at 1 day and not at 7" instead of averaging the two
 * into one number that describes neither.
 */
export function verificationByLead(pairs, { buckets = [0, 1, 3, 7, 14] } = {}) {
  const list = Array.isArray(pairs) ? pairs : []
  const edges = [...buckets].sort((a, b) => a - b)
  const rows = edges.map((lo, i) => {
    const hi = i === edges.length - 1 ? Infinity : edges[i + 1]
    const inBucket = list.filter((p) => p?.status === 'verified' && num(p.lead_days) !== null && p.lead_days >= lo && p.lead_days < hi)
    const pending = list.filter((p) => p?.status === 'pending' && num(p.lead_days) !== null && p.lead_days >= lo && p.lead_days < hi)
    const stats = reliability(inBucket, { minBin: 1 })
    return {
      label: hi === Infinity ? `${lo}+ days` : `${lo}–${hi === 0 ? lo : hi - 1} days`,
      lo,
      hi: hi === Infinity ? null : hi,
      verified: inBucket.length,
      pending: pending.length,
      brier: stats.brier,
      observedRate: stats.baseRate,
      skill: stats.skill,
    }
  })
  return rows
}