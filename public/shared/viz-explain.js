// =============================================================
// Lindela Lite — record provenance: why does this number exist?
// =============================================================
// ENH-19. The `/explain` route is HTTP and belongs to someone else; this is the
// payload that route returns and the drill-down panel renders. It is the most
// valuable part of that item, because it is the only part that makes "where did
// this number come from" answerable without opening the raw JSON.
//
// **The defect it answers.** A score arrives on a map as a bare number with a
// colour. The reader's next question is always the same — how? — and today the
// only route to an answer is the payload itself, which means the honest answer
// is technically present and practically unreachable. The payload's job is to
// make the chain legible: the inputs, which ones were actually used, the rule
// that combined them, and the arithmetic.
//
// **The chain, in order**, the order the question is asked:
//
//   `inputs`   → what was read, per term, with the value and whether it was present
//   `terms`    → the rule: name, input, weight, points contributed, saturation
//   `equation` → the score as a literal expression a reader can check by hand
//   `limits`   → what was not modelled, carried verbatim from the record
//
// **Honesty rules this module enforces.** These are why it is not a formatter:
//
// 1. **An absent input contributes nothing and is named.** `src/analytics.js`
//    carries `missing_precipitation_records` because a climate record with
//    `precipitation_mm: null` contributes nothing while a district can still look
//    covered. An explanation that printed the sum without naming the dropped term
//    would make the score look computed from data that does not exist.
// 2. **The reported score is the record's; the recomputed sum is reported beside
//    it.** They agree today. When they do not, `consistent` is `false` and both
//    numbers travel — a self-check that fails is information, not something to
//    smooth over.
// 3. **A saturated term says it saturated.** `Math.min(25, …)` in the source
//    means a district with 40 hazard events is not scoring 40 events' worth of
//    pressure, and a reader shown "24 points from hazards" without that is being
//    told something the arithmetic did not.
// 4. **The band is described as a sensitivity band** — same rule as ADR-004 and
//    `viz-uncertainty.js`, repeated here so a record opened in the drill-down
//    and the same record opened as raw JSON say the same thing about its bounds.
//
// **The rules are transcribed, and transcription is the risk.** A weight changed
// in `src/analytics.js` and not here would make every explanation confidently
// wrong, and nothing else in the suite would notice. `checkRuleDrift` exists for
// exactly that: it reads the source and fails when the two have parted.
//
// Pure: JSON in, JSON out. No DOM, so the same object can be asserted on in a
// test, returned from the route, and rendered by whichever surface clicked.

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
 * The scoring rules, as data.
 *
 * Transcribed from `src/analytics.js` — `computeFloodRisk` at ~:195-225 and
 * `computeClimateConflictRisk` at ~:342-357. `source` on each rule is the exact
 * substring `checkRuleDrift` looks for, so a retune on the analytics side fails
 * the test rather than silently leaving every explanation wrong.
 *
 * Three term shapes, because the three real formulas are genuinely different:
 *
 *   `linear`  → `driver x weight`, no saturation (flood precipitation, hazard)
 *   `capped`  → `min(cap, f(driver))` (climate conflict pressure)
 *   `sumOf`   → a sum over the source records behind a count, which needs the
 *               records, not just the count
 *
 * `flood_hazard_events` is a count, but the score is
 * `sum(severityWeight(event) x 30)` — a count cannot produce it. So that term is
 * `sumOf` and reports itself as not recomputable from the record alone. That is
 * not a gap in this module; it is the truth about what a count is worth, and an
 * explanation that quietly substituted `count x 30` would be inventing a number.
 */
export const SCORING_RULES = Object.freeze({
  flood_risk: Object.freeze({
    title: 'Flood risk',
    source: 'Math.round((precipitation ?? 0) * 1.5 + (maxProbability ?? 0) * 0.35 + hazardPressure)',
    formula: 'mean precipitation_mm x 1.5 + precipitation_probability_pct x 0.35 + sum(severityWeight x 30 per hazard event)',
    terms: [
      { name: 'Precipitation', shape: 'linear', driver: 'precipitation_mm', weight: 1.5, unit: 'mm', driverLabel: 'mean forecast rainfall across in-scope observations' },
      { name: 'Rain probability', shape: 'linear', driver: 'precipitation_probability_pct', weight: 0.35, unit: '%', driverLabel: 'highest in-scope daily rain probability' },
      { name: 'Hazard pressure', shape: 'sumOf', driver: 'flood_hazard_events', unit: 'events', driverLabel: 'count of in-scope hazard events', needs: 'the severity of each event', perEvent: 'severityWeight x 30' },
    ],
    confidenceParts: [
      { part: 'observations carrying a rainfall reading', driver: 'climate_observations_in_scope', minus: 'missing_precipitation_records', weight: 45 },
      { part: 'in-scope hazard events', driver: 'flood_hazard_events', weight: 40 },
      { part: 'observations carrying a probability forecast', driver: 'climate_observations_in_scope', minus: 'missing_probability_records', weight: 15 },
    ],
    confidenceNote: 'An absent input lowers how sure the score is rather than lowering the score.',
  }),
  climate_conflict_risk: Object.freeze({
    title: 'Climate and conflict risk',
    source: 'Math.round(climatePressure + hazardPressure + conflictPressure + servicePressure)',
    formula: 'min(35, rainfall) + min(25, 12 x severity weight per event) + min(30, 4 + 0.8 x fatalities per event) + min(10, 1.5 x assets)',
    terms: [
      { name: 'Climate pressure', shape: 'capped', cap: 35, driver: 'climate_observations', unit: 'mm', driverLabel: 'in-scope climate observations', needs: 'the rainfall reading on each one', aggregate: 'sum of precipitation_mm' },
      { name: 'Hazard pressure', shape: 'capped', cap: 25, driver: 'hazard_events', unit: 'events', driverLabel: 'in-scope hazard events', needs: 'the severity of each event', aggregate: 'sum of 12 x severityWeight' },
      { name: 'Conflict pressure', shape: 'capped', cap: 30, driver: 'conflict_events', unit: 'events', driverLabel: 'in-scope conflict events', needs: 'the fatality count on each event', aggregate: 'sum of 4 + 0.8 x fatalities' },
      { name: 'Service exposure', shape: 'linear', cap: 10, driver: 'nearby_service_assets', weight: 1.5, unit: 'assets', driverLabel: 'in-scope service assets' },
    ],
    confidenceParts: [
      { part: 'climate observations carrying a rainfall reading', driver: 'climate_observations', minus: null, weight: 30 },
      { part: 'hazard events', driver: 'hazard_events', weight: 25 },
      { part: 'conflict events', driver: 'conflict_events', weight: 30 },
      { part: 'service assets', driver: 'nearby_service_assets', weight: 15 },
    ],
    confidenceNote: 'Every CHIRPS record carries precipitation_mm: null by construction, so an in-scope climate observation is not an input.',
  }),
})

/** The weights `severityWeight` in `src/schema.js` assigns. 1 = critical. */
export const SEVERITY_WEIGHT = Object.freeze({ critical: 1, high: 0.78, medium: 0.52, low: 0.25, unknown: 0.18 })

/** Rules for a record type, or null when the type is unknown. */
export function rulesFor(record) {
  return SCORING_RULES[record?.type] || null
}

/**
 * Read one driver off a record.
 *
 * `0` and `absent` are different answers and the payload keeps them apart: a
 * district with zero hazard events read zero hazard events; a district with no
 * `hazard_events` key was never measured. Collapsing them is how a blank field
 * becomes a confident zero somewhere downstream — the falsy-zero defect class
 * this repository has already been bitten by twice.
 */
function driverOf(record, key) {
  const drivers = record?.drivers || {}
  if (!Object.prototype.hasOwnProperty.call(drivers, key)) return { value: null, present: false, source: 'absent' }
  const value = num(drivers[key])
  if (value === null) return { value: null, present: false, source: 'null' }
  return { value, present: true, source: 'drivers' }
}

const absentReason = (source) => (source === 'null' ? 'reported as null on this record' : 'not reported on this record')

/**
 * Build the chain that explains one record.
 *
 * `record` is a risk record as `src/analytics.js` emits it. `lookup` is an
 * optional `(kind, record) => Array<record>` a caller passes to attach the source
 * records behind each count; without it a term still reports what the record
 * knows, and with it the term also carries ids a reader can click through to.
 * That optional lookup is the last hop of the map → chart → record chain, and it
 * is optional because the *arithmetic* explanation has to be complete even when
 * the source records are not in hand.
 *
 * Returns `{ kind, id, title, known, score, band, equation, inputs, terms,
 * confidence, limits, missing, computed, consistent, provenance, caption }`.
 */
export function explainRecord(record, options = {}) {
  if (!record || typeof record !== 'object') {
    throw new Error('viz-explain: explainRecord needs a record object')
  }
  const rule = rulesFor(record)
  const drivers = record?.drivers || {}
  const score = num(record.score)

  if (!rule) {
    // An unknown type gets the honest minimum rather than a fabricated chain:
    // here is the record, here is what can be said about it, and here is the
    // fact that no rule is registered for it. A guessed breakdown is worse than
    // an absent one.
    return {
      kind: record.type || 'unknown',
      id: record.id ?? null,
      title: `How ${record.region_name || record.id || 'this record'} was produced`,
      known: false,
      score,
      band: describeBand(record),
      equation: 'No scoring rule is registered for this record type, so its score cannot be decomposed here.',
      inputs: Object.entries(drivers).map(([key, value]) => ({ key, value: num(value), present: num(value) !== null, used: false })),
      terms: [],
      confidence: explainConfidence(record, null),
      limits: normaliseLimits(record.limits, null),
      missing: [],
      computed: null,
      consistent: null,
      provenance: provenanceOf(record),
      caption: 'This record type has no registered scoring rule, so the number cannot be broken into contributing terms. The drivers it carries are listed below.',
    }
  }

  const inputs = []
  const terms = []
  const missing = []

  for (const term of rule.terms) {
    const read = driverOf(record, term.driver)
    const base = {
      name: term.name,
      reads: term.driver,
      driverLabel: term.driverLabel,
      unit: term.unit,
      cap: term.cap ?? null,
    }
    const input = {
      key: term.driver,
      value: round(read.value, 2),
      unit: term.unit,
      present: read.present,
      used: read.present,
      term: term.name,
      describes: term.driverLabel,
    }

    if (!read.present) {
      missing.push({ key: term.driver, term: term.name, reason: absentReason(read.source) })
      input.used = false
      inputs.push(input)
      terms.push({ ...base, shape: term.shape, weight: term.weight ?? null, contribution: null, saturated: false, recomputable: false, contributing: false, note: `Absent, so it contributed nothing rather than a zero reading.` })
      continue
    }

    if (term.shape === 'sumOf') {
      // The count is here; the number it multiplies into is not. Saying so is
      // the whole point — `count x 30` would be a number with no computation
      // behind it, and it would look identical to a real one. A count of zero,
      // though, sums to zero whatever the per-event weight is, and that one *is*
      // recomputable.
      terms.push({
        ...base,
        shape: term.shape,
        weight: null,
        contribution: read.value === 0 ? 0 : null,
        saturated: false,
        recomputable: read.value === 0,
        contributing: read.value > 0,
        note: `${read.value} in scope; contributes ${term.perEvent}, which cannot be recomputed from this record alone — it needs ${term.needs}.`,
        sources: collectSources(options.lookup, 'hazard_events', record, term.driver),
      })
      inputs.push(input)
      continue
    }

    if (term.shape === 'capped') {
      // The aggregate is over the source records behind the count, so the
      // contribution is bounded by the cap but not recoverable from the count.
      // Zero in scope is the one case that is recoverable: the sum of nothing is
      // nothing.
      terms.push({
        ...base,
        shape: term.shape,
        weight: null,
        contribution: read.value === 0 ? 0 : null,
        saturated: false,
        recomputable: read.value === 0,
        contributing: read.value > 0,
        note: `${read.value} in scope; contributes ${term.aggregate}, capped at ${term.cap}, which cannot be recomputed from this record alone — it needs ${term.needs}.`,
        sources: collectSources(options.lookup, 'climate', record, term.driver),
      })
      inputs.push(input)
      continue
    }

    const weighted = read.value * term.weight
    const contribution = term.cap ? Math.min(term.cap, weighted) : weighted
    const saturated = term.cap ? contribution < weighted : false
    terms.push({
      ...base,
      shape: term.shape,
      weight: term.weight,
      contribution: round(contribution, 2),
      saturated,
      recomputable: true,
      // Zero contributes zero. The falsy-zero defect class in reverse: a term
      // that reads 0 must report 0, and must not be promoted to "contributes"
      // because a `sumOf` sibling with the same count does.
      contributing: contribution > 0,
      note: saturated
        ? `Capped at ${term.cap}: ${read.value} x ${term.weight} would be ${round(weighted, 2)}.`
        : `${read.value} x ${term.weight}`,
    })
    inputs.push(input)
  }

  // Only terms this module can actually recompute go into the arithmetic. A
  // `sumOf` term has a known non-zero direction but an unknown magnitude, and
  // guessing it to complete the sum would be inventing a number.
  const recomputable = terms.filter((t) => t.recomputable)
  const computed = recomputable.length
    ? round(recomputable.reduce((sum, t) => sum + (t.contribution ?? 0), 0), 2)
    : null
  const reported = score === null ? null : round(score, 2)
  const unexplained = terms.filter((t) => t.contributing && !t.recomputable)

  const stated = [
    ...recomputable.filter((t) => t.contribution).map((t) => `${t.contribution} (${t.name.toLowerCase()})`),
    ...unexplained.map((t) => `${t.name.toLowerCase()} (contributes, but not recomputable from this record)`),
  ]
  const equation = stated.length
    ? `${record.region_name || record.id} = ${stated.join(' + ')}`
      + (computed !== null ? ` = ${computed} from the recomputable terms alone` : '')
    : 'No contributing term could be recovered from this record.'

  return {
    kind: record.type,
    id: record.id ?? null,
    title: `How ${record.region_name || record.id || 'this score'} was produced`,
    known: true,
    score: reported,
    band: describeBand(record),
    equation,
    inputs,
    terms,
    confidence: explainConfidence(record, rule),
    limits: normaliseLimits(record.limits, rule),
    missing,
    computed,
    // The self-check, and it is a three-state answer on purpose. `null` means
    // "not checkable" — a record whose score is mostly unrecomputable terms —
    // which is materially different from "checked and agreed".
    // A check that ignores an unknown term is not a check. When any contributing
    // term is unrecoverable, `null` is the only honest answer — `false` would
    // say "checked and wrong" and `true` would say "checked and agreed".
    consistent: reported === null || computed === null || unexplained.length
      ? null
      : Math.abs(reported - computed) <= 0.5,
    provenance: provenanceOf(record),
    caption: explainCaption(missing, unexplained, reported, computed),
  }
}

/** The sensitivity band, in words that cannot be read as a probability. */
function describeBand(record) {
  const low = num(record?.sensitivity_low ?? record?.score_p10)
  const high = num(record?.sensitivity_high ?? record?.score_p90)
  const mid = num(record?.sensitivity_mid ?? record?.score_p50 ?? record?.score)
  const width = num(record?.sensitivity_width ?? record?.interval_width) ?? (low !== null && high !== null ? high - low : null)
  return {
    low,
    high,
    mid,
    width,
    basis: 'sensitivity',
    calibrated: record?.calibrated_uncertainty === true,
    statement: 'A sensitivity band around the point score, driven by input coverage. '
      + 'Not a confidence interval, not a predictive interval, not a probability. '
      + 'A zero-width band means the inputs were sufficient to compute a point score, not that the outcome is certain.',
  }
}

/**
 * Where the coverage number came from.
 *
 * `confidenceScore` in `src/analytics.js` awards a weight per part that has at
 * least one usable input — presence, not quantity. So one hazard event and four
 * hundred score identically on that part, which is worth saying out loud: the
 * number is a coverage flag in points, not a sample size, and a reader who treats
 * it as the latter will over-trust a thin district.
 */
function explainConfidence(record, rule) {
  const confidence = num(record?.confidence)
  if (!rule) {
    return {
      value: confidence,
      parts: [],
      recomputed: null,
      consistent: null,
      statement: 'Input coverage, scored as points for the presence of each input class — not a sample size, and not a probability.',
    }
  }
  const parts = rule.confidenceParts.map((part) => {
    const read = driverOf(record, part.driver)
    let count = read.value
    let note = part.part
    if (part.minus) {
      const lost = driverOf(record, part.minus)
      count = count === null || !lost.present ? null : count - lost.value
      note = `${part.part} (in scope minus those missing it)`
    }
    return { part: part.part, weight: part.weight, count, awarded: count !== null && count > 0 }
  })
  const awarded = parts.filter((p) => p.awarded).reduce((sum, p) => sum + p.weight, 0)
  return {
    value: confidence,
    parts,
    recomputed: awarded,
    // `null`, not `true`, when a count could not be read: an unreadable part
    // might have been worth points, so agreement here would be luck, not proof.
    consistent: confidence === null || parts.some((p) => p.count === null) ? null : awarded === confidence,
    statement: `Input coverage, scored as points for the presence of each input class — not a sample size, and not a probability. `
      + `One record in a class earns the same ${rule.confidenceParts[0].weight} points as four hundred. `
      + 'This is the quantity the sensitivity band width is drawn from.',
  }
}

function normaliseLimits(limits, rule) {
  const own = Array.isArray(limits) ? limits.filter(Boolean) : (limits ? [limits] : [])
  // The rule's own limits are appended only when the record did not already say
  // something that covers them. Both vocabularies carrying the same sentence is
  // the cost ADR-004 named for the field aliases; duplicating it into the
  // explanation would be the same cost paid again in the place a reader is most
  // likely to be misled.
  const ruleLimits = (rule?.limits || []).filter((l) => !own.some((o) => String(o).includes(l.slice(0, 30))))
  return [...own, ...ruleLimits]
}

/** The ids behind a driver count, when the caller supplied a lookup. */
function collectSources(lookup, kind, record) {
  if (typeof lookup !== 'function') return []
  let list = []
  try {
    list = lookup(kind, record) || []
  } catch {
    // A lookup that throws is the caller's problem, not a reason to fail the
    // explanation. The chain stays complete without the source list.
    return []
  }
  return (Array.isArray(list) ? list : []).slice(0, 25).map((r) => ({
    id: r?.id ?? null,
    at: r?.observed_at ?? r?.event_time ?? r?.started_at ?? null,
    severity: r?.severity ?? null,
  }))
}

/** Where the record itself came from. */
function provenanceOf(record) {
  const lat = num(record?.latitude)
  const lon = num(record?.longitude)
  return {
    generated_at: record?.generated_at ?? null,
    methodology: record?.methodology ?? null,
    source: record?.source ?? null,
    region: record?.region_name ?? null,
    country: record?.country ?? null,
    location: lat === null || lon === null ? null : { lat, lon },
  }
}

/**
 * The paragraph a reader gets before the numbers.
 *
 * It leads with what is missing when something is missing, because a score
 * computed over four of its five inputs and a score computed over all five are
 * different numbers that look identical on a map, and the difference is the only
 * thing that makes a low score interpretable.
 */
function explainCaption(missing, unexplained, reported, computed) {
  const parts = []
  if (missing.length) {
    parts.push(`${missing.length} contributing input(s) were absent from this record (${missing.map((m) => m.key).join(', ')}). `
      + 'Absent inputs contribute nothing rather than counting as zero, so this score may understate the risk rather than describe it.')
  }
  if (unexplained.length) {
    parts.push(`${unexplained.length} term(s) contribute to this score but cannot be recomputed from the record alone — they are sums over the source events, and a count is not a sum.`)
  }
  if (reported !== null && computed !== null && Math.abs(reported - computed) > 0.5) {
    parts.push(`The record reports ${reported} and its recomputable terms sum to ${computed}; the two disagree, so at least one is stale.`)
  }
  parts.push('The band is a sensitivity band over input coverage, not a probability.')
  return parts.join(' ')
}

/**
 * Fail loudly when `SCORING_RULES` has drifted from `src/analytics.js`.
 *
 * An explanation is a claim about code this file does not run. If a weight or a
 * cap is retuned on the analytics side and not here, every explanation the
 * product gives is confidently wrong and nothing else in the suite notices. This
 * reads the source text and returns a list of drifts; the test asserts it is
 * empty, so the mismatch is a red test rather than a wrong page.
 */
export function checkRuleDrift(analyticsSource) {
  const source = String(analyticsSource || '')
  const drifts = []
  for (const [type, rule] of Object.entries(SCORING_RULES)) {
    if (!source.includes(`type: '${type}'`)) drifts.push(`${type}: analytics.js no longer emits this record type`)
    if (!source.includes(rule.source)) drifts.push(`${type}: scoring expression not found verbatim: ${rule.source}`)
    for (const term of rule.terms) {
      if (term.shape !== 'capped') continue
      // The cap has to exist as a `Math.min(cap, …)` in the source. A cap
      // retuned in one place only is exactly the drift this catches.
      if (!source.includes(`Math.min(${term.cap},`)) drifts.push(`${type}.${term.name}: cap ${term.cap} not found as Math.min(${term.cap}, in analytics.js`)
    }
  }
  return drifts
}