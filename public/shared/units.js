/**
 * ENH-47 — what a number measures, declared once, so two that do not match
 * cannot quietly meet.
 *
 * `src/analytics/numeric.js` is the absent-value gate: it stops "not measured"
 * from arriving as "measured, and zero". This is its unit sibling. A number
 * that arrives under the right name with the wrong unit is worse than a missing
 * one, because nothing downstream can tell it from a correct reading — the same
 * argument, one level down.
 *
 * **Three axes, because two of them are not enough.** A unit name states a
 * dimension, a scale and, for anything that accumulates, a period:
 *
 *   - **dimension** — length, area, duration, temperature, proportion, count,
 *     discharge, angle. Adding a length to a duration is a category error and
 *     the sum has no unit that describes anything.
 *   - **scale** — mm and m are both length; so are km and m. The register's
 *     "mm/metre mix" is this axis, and it is the one a dimension check alone
 *     would pass: `1000 mm` and `1 m` are the same length and a bare dimension
 *     comparison cannot see that `1000` and `1` were written as though equal.
 *   - **period** — this is the axis the register did not anticipate, and the
 *     tree produced it on the first read. `precipitation_mm` is written into
 *     `climate_observations` by `src/connectors/open-meteo.js` twice: once from
 *     the API's `current` block, which is the **preceding 15 minutes**, and once
 *     from its `daily` block, which is the **whole-day total**. Same dimension,
 *     same scale, same field name — and the flood scorer averages them. A 3 mm
 *     quarter-hour and a 40 mm day blend to "21.5 mm", a number describing no
 *     period at all. See the axis note in `aggregation-kinds.js`: it found that
 *     a measurement can be intensive over space and extensive over time; this is
 *     the same lesson with a third axis underneath it.
 *
 * **Why a registry and not a lint.** The failure is not a suspicious token; it
 * is two records whose declarations disagree, and both declarations live at the
 * boundary where the number entered. `scripts/check-unit-mixing.mjs` reads this
 * table and refuses an aggregate that blends periods, so the next instance fails
 * the build instead of waiting for an audit. A field the table does not know is
 * not guessed at: `unitOf` returns `null` and the gate reports it as unknown
 * rather than passing it silently, because a registry that quietly covered
 * nothing is the same defect one level up.
 */

/**
 * The dimensions this tree measures in.
 *
 * `count` is here rather than omitted: a count is a measurement, its unit is
 * "things", and a registry that treated a unitless name as "no unit" could not
 * say why `field_reports` is safe to add while `precipitation_mm` is not.
 */
export const DIMENSIONS = Object.freeze([
  'length', 'area', 'duration', 'temperature', 'proportion', 'count', 'discharge', 'angle',
])

/**
 * Every unit the tree writes, with what it measures.
 *
 * `canonical` is the factor to the dimension's base unit — metres, seconds,
 * degrees Celsius, a fraction of one. It is what makes `1000 mm` and `1 m`
 * comparable *and* what makes them visibly different numbers: a comparison that
 * divided by this factor would silently rescale a caller's data, so
 * `sameMeasurement` compares the factors instead and refuses the pair.
 *
 * `accumulates` is true when a total over a period is a real quantity, which is
 * exactly when a period has to be declared. A depth in mm accumulates; a
 * temperature does not, and a `per_day` temperature would be a category error
 * rather than a missing declaration.
 */
export const UNITS = Object.freeze({
  // length — the register's own example lives on this row
  mm: Object.freeze({ dimension: 'length', canonical: 0.001, accumulates: true, note: 'a depth — millimetres, the rainfall and flood-depth unit' }),
  m: Object.freeze({ dimension: 'length', canonical: 1, accumulates: false, note: 'a height or a distance in metres' }),
  km: Object.freeze({ dimension: 'length', canonical: 1000, accumulates: false, note: 'a distance in kilometres' }),
  // area — the tree writes both spellings, so both are declared
  km2: Object.freeze({ dimension: 'area', canonical: 1e6, accumulates: true, note: 'an area in square kilometres' }),
  sq_km: Object.freeze({ dimension: 'area', canonical: 1e6, accumulates: true, note: 'an area in square kilometres; the flood grid spells it this way' }),
  ha: Object.freeze({ dimension: 'area', canonical: 1e4, accumulates: true, note: 'an area in hectares' }),
  // duration
  days: Object.freeze({ dimension: 'duration', canonical: 86400, accumulates: false, note: 'a duration or a cadence in days' }),
  hours: Object.freeze({ dimension: 'duration', canonical: 3600, accumulates: false, note: 'a duration in hours' }),
  minutes: Object.freeze({ dimension: 'duration', canonical: 60, accumulates: false, note: 'a duration in minutes' }),
  s: Object.freeze({ dimension: 'duration', canonical: 1, accumulates: false, note: 'a duration in seconds' }),
  ms: Object.freeze({ dimension: 'duration', canonical: 0.001, accumulates: false, note: 'a duration in milliseconds' }),
  // everything else
  c: Object.freeze({ dimension: 'temperature', canonical: 1, accumulates: false, note: 'a temperature in degrees Celsius' }),
  pct: Object.freeze({ dimension: 'proportion', canonical: 1, accumulates: false, note: 'a proportion of a whole, in percent' }),
  m3s: Object.freeze({ dimension: 'discharge', canonical: 1, accumulates: false, note: 'a river discharge in cubic metres per second' }),
  deg: Object.freeze({ dimension: 'angle', canonical: 1, accumulates: false, note: 'an angle or an angular precision in degrees' }),
})

/**
 * The periods a measurement may be stated over, as a duration in seconds.
 *
 * `null` is a declared absence: the measurement is a point value that does not
 * accumulate, so no period applies. `'unspecified'` is different and is the
 * important one — it is a real measurement whose period nobody declared, and it
 * is what every pre-ENH-47 record carries. Those must keep working (an older
 * client still files), so an aggregate over records that are *all* unspecified
 * publishes as before; only two *differently declared* periods refuse to blend.
 */
export const PERIODS = Object.freeze({
  per_15_min: 900,
  per_hour: 3600,
  per_day: 86400,
})

/** The basis of a measurement whose period nobody declared. Not `null` — that
 *  means "does not accumulate". See the note above; the distinction is load-bearing. */
export const UNSPECIFIED_PERIOD = 'unspecified'

/**
 * Which period each writing connector states, keyed `source:type`.
 *
 * Each entry names the **field** it is about and the **period** it is stated
 * over. Both halves are needed: the field is how a reader finds the declaration
 * (a reader knows it is reading `precipitation_mm`, not which connector wrote
 * the row), and the period is the thing that was missing. A table keyed only by
 * `source:type` could not answer "is this field written at more than one
 * period", which is the only question that matters here — the first draft of
 * this table did exactly that and reported every accumulating unit in the tree
 * as mixed.
 *
 * This is here rather than in each connector for the reason the whole repository
 * keeps re-learning: a fact written down in six places is six facts, and the one
 * that goes stale is the one nobody reads.
 *
 * The entries are the two the tree actually writes today, and they are the
 * defect: `open_meteo` writes both, into `climate_observations`, under the same
 * field name. Everything else that writes `precipitation_mm` writes `null`
 * (CHIRPS reports which rasters exist, not what fell) or nests its series under
 * `daily` and leaves the top-level field null.
 */
export const MEASUREMENT_PERIODS = Object.freeze({
  'open_meteo:current_weather': Object.freeze({ field: 'precipitation_mm', period: 'per_15_min' }),
  'open_meteo:precipitation_forecast': Object.freeze({ field: 'precipitation_mm', period: 'per_day' }),
  'open_meteo_forecast:weather_current': Object.freeze({ field: 'precipitation_mm', period: 'per_15_min' }),
  'open_meteo_forecast:weather_forecast_daily': Object.freeze({ field: 'precipitation_mm', period: 'per_day' }),
})

/**
 * Every field the table declares at more than one period.
 *
 * A field is mixed when the writers that land in it disagree about the period.
 * `precipitation_mm` is the only one today, and it is the whole reason this
 * module exists: no dimension check and no scale check can see the problem,
 * because both writers are correct about dimension and scale.
 */
export function mixedPeriodFields(periods = MEASUREMENT_PERIODS) {
  const byField = new Map()
  for (const entry of Object.values(periods)) {
    if (!entry?.field || !entry?.period || entry.period === UNSPECIFIED_PERIOD) continue
    if (!byField.has(entry.field)) byField.set(entry.field, new Set())
    byField.get(entry.field).add(entry.period)
  }
  return new Set([...byField.entries()].filter(([, set]) => set.size > 1).map(([field]) => field))
}

/** The unit a field name ends in, or null when it states none this table knows. */
export function unitOf(field) {
  if (typeof field !== 'string' || !field) return null
  const name = field.trim()
  if (!name) return null
  // Longest suffix first, so `_sq_km` is not read as `_m` and `_ms` is not read
  // as `_s`. Sorting by length is what makes the order independent of the
  // declaration order above, which is the kind of coupling that breaks the day
  // someone alphabetises the table.
  const suffixes = Object.keys(UNITS).sort((a, b) => b.length - a.length)
  for (const unit of suffixes) {
    if (name === unit || name.endsWith(`_${unit}`)) return unit
  }
  return null
}

/** The declaration for a field's unit, or null when the name states none known. */
export function declarationFor(field) {
  const unit = unitOf(field)
  return unit === null ? null : UNITS[unit]
}

/** The dimension a field measures in, or null. */
export function dimensionOf(field) {
  return declarationFor(field)?.dimension ?? null
}

/** The canonical factor of a field's unit, or null. */
export function scaleOf(field) {
  return declarationFor(field)?.canonical ?? null
}

/**
 * The period a measurement record states, resolved from its `source` and `type`.
 *
 * A record may carry the period explicitly (`period`), which wins: a caller that
 * knows what it measured says so, and nothing here should overrule it. Otherwise
 * the declaration above decides, keyed on the pair first and the source alone
 * second. A record whose source and type are both unknown to the table is
 * `unspecified`, never `null` — `null` means "does not accumulate", and reading
 * an undeclared accumulating measurement as one that does not would be the
 * silent pass this module exists to prevent.
 */
export function periodOf(record) {
  if (!record || typeof record !== 'object') return UNSPECIFIED_PERIOD
  if (typeof record.period === 'string' && record.period) return record.period
  const source = typeof record.source === 'string' ? record.source : null
  const type = typeof record.type === 'string' ? record.type : null
  if (source && type && MEASUREMENT_PERIODS[`${source}:${type}`]) return MEASUREMENT_PERIODS[`${source}:${type}`].period
  return UNSPECIFIED_PERIOD
}

/**
 * Whether two field names measure the same thing the same way.
 *
 * `false` for a different dimension, a different canonical scale, or — when
 * either accumulates — a different declared period. Returns a reason rather than
 * a bare boolean, because "these do not match" without saying which axis
 * disagreed is a refusal a caller cannot act on, and a refusal nobody can act on
 * is one they route around.
 */
export function compareMeasurements(fieldA, periodA, fieldB, periodB) {
  const a = declarationFor(fieldA)
  const b = declarationFor(fieldB)
  if (!a || !b) {
    return { same: false, axis: 'unknown', reason: `${!a ? fieldA : fieldB} states no unit this registry knows, so the pair cannot be checked` }
  }
  if (a.dimension !== b.dimension) {
    return { same: false, axis: 'dimension', reason: `${fieldA} measures ${a.dimension} and ${fieldB} measures ${b.dimension}` }
  }
  if (a.canonical !== b.canonical) {
    return {
      same: false,
      axis: 'scale',
      reason: `${fieldA} is ${a.dimension} in ${unitOf(fieldA)} and ${fieldB} is ${a.dimension} in ${unitOf(fieldB)} — the same dimension at a factor of ${a.canonical / b.canonical}`,
    }
  }
  // An undeclared period is not a second period, here as in `periodsPresent`
  // and `meanMeasured`. Two *declared* periods meeting is the state that no
  // amount of re-ingestion makes correct; a pre-ENH-47 record that never
  // declared its period is not evidence of a different one, and refusing to
  // compare it would fail every deployment that has not been re-ingested.
  const periodUnknown = (p) => p === UNSPECIFIED_PERIOD || p === null || p === undefined
  if (a.accumulates && b.accumulates && periodA !== periodB && !periodUnknown(periodA) && !periodUnknown(periodB)) {
    return {
      same: false,
      axis: 'period',
      reason: `${fieldA} accumulates and the two records state different periods (${periodA} and ${periodB}), so a total over them describes neither`,
    }
  }
  return { same: true, axis: null, reason: null }
}

/**
 * The periods present among a set of readings of one accumulating field.
 *
 * Returns every declared period seen, in declaration order, plus whether more
 * than one is present. `unspecified` is deliberately *not* mixed with a declared
 * period: an older record that never declared its period is not evidence of a
 * different period, and treating it as one would fail every deployment that has
 * not been re-ingested. The refusal is for two *declared* periods meeting, which
 * is the state no amount of re-ingestion makes correct.
 */
export function periodsPresent(rows, field) {
  const declaration = declarationFor(field)
  if (!declaration?.accumulates) return { periods: [], mixed: false, declared: [] }
  const seen = new Set()
  for (const row of rows || []) {
    const value = typeof row === 'number' ? row : row?.[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    seen.add(periodOf(typeof row === 'number' ? null : row))
  }
  const declared = [...seen].filter((p) => p !== UNSPECIFIED_PERIOD)
  return { periods: [...seen], declared, mixed: declared.length > 1 }
}

/**
 * The mean of one field's finite readings, within a single period.
 *
 * The aggregate the registry points an accumulating field at, with the period
 * axis enforced: readings are grouped by the period their record declares, and
 * the mean is taken over the largest group rather than over everything. When
 * more than one period is present the answer carries `mixed: true` and the
 * per-period means, so a caller publishes the refusal instead of a blend — the
 * same discipline as `null` for an unmeasured value, applied to a mis-measured
 * one.
 *
 * With a single period present (the normal case, including every pre-ENH-47
 * record reading `unspecified`) this is an ordinary mean and returns the same
 * number the call site computed before.
 */
export function meanMeasured(rows, field) {
  if (!Array.isArray(rows)) throw new TypeError('meanMeasured: rows must be an array')
  const byPeriod = new Map()
  for (const row of rows) {
    const value = typeof row === 'number' ? row : row?.[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const period = periodOf(typeof row === 'number' ? null : row)
    if (!byPeriod.has(period)) byPeriod.set(period, [])
    byPeriod.get(period).push(value)
  }
  if (byPeriod.size === 0) return { mean: null, period: null, mixed: false, by_period: {}, readings: 0 }

  const entries = [...byPeriod.entries()]
  const declared = entries.filter(([period]) => period !== UNSPECIFIED_PERIOD)
  const mixed = declared.length > 1
  // The largest group answers, and a declared period beats the unspecified one
  // at equal size: a caller who told us the period measured more than a caller
  // who did not.
  const [period, values] = entries.sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    const aDeclared = a[0] !== UNSPECIFIED_PERIOD ? 1 : 0
    const bDeclared = b[0] !== UNSPECIFIED_PERIOD ? 1 : 0
    return bDeclared - aDeclared
  })[0]

  return {
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    period,
    mixed,
    by_period: Object.fromEntries(entries.map(([p, vs]) => [p, {
      mean: vs.reduce((sum, v) => sum + v, 0) / vs.length,
      readings: vs.length,
    }])),
    readings: entries.reduce((n, [, vs]) => n + vs.length, 0),
  }
}
