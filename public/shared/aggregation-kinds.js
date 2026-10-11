/**
 * ENH-45 — what a measurement is allowed to do when it meets its siblings.
 *
 * VER-01 was precipitation summed across stations: `nearby()` collects every
 * climate observation within 125 km, each a *point* total, and adding them adds
 * the same storm once per station. Five stations reporting 20 mm scored three
 * times one station reporting the identical 20 mm, so the risk score was a map
 * of where the sensors are. The fix was a mean — and a mean is the right answer
 * for every quantity of that kind, which is the point this module makes
 * explicit rather than leaving to whoever reads the line next.
 *
 * The classification is the one dimensional analysis already uses:
 *
 *   - **extensive** — scales with the extent of what it measures. Counts,
 *     totals over a fixed period, areas of disjoint regions. Adding two is
 *     meaningful; `reduce(sum)` is the natural aggregate.
 *   - **intensive** — a property of a point or a state. A temperature, a rate,
 *     a percentage, a distance, a duration, a concentration, a reading in mm.
 *     Adding two is a category error: the sum has no unit that describes
 *     anything. The aggregate is a mean, a max, or a distribution.
 *
 * **Why a registry and not a lint.** The failure is not a suspicious token; it
 * is a mismatch between a field's kind and the aggregate applied to it, and
 * both halves live at the call site. `scripts/check-aggregation-kinds.mjs`
 * reads this table and flags a `reduce(sum)` over an intensive field, so the
 * next instance fails the build instead of waiting for an audit. A name it does
 * not recognise is not guessed at: `aggregationKindFor` returns `null`, and the
 * gate reports it as an unknown rather than passing it silently — a registry
 * that quietly covered nothing would be the same defect one level up.
 *
 * The unit suffix decides the kind, because the suffix is what the field name
 * actually states and it is stable across the tree: `precipitation_mm` says
 * millimetres at a point, `battery_pct` says a proportion of a whole. Names
 * without a suffix are counts (`field_reports`, `hazard_events`) and are
 * extensive — an array of N things adds.
 *
 * **The axis, because one kind is not enough.** A measurement can be intensive
 * over space and extensive over time, and rainfall is the example that makes it
 * unavoidable: 20 mm at each of five stations 100 km apart is one storm
 * reported five times and must be averaged, while 20 mm on each of five
 * consecutive days at one station is 100 mm of accumulated rain and must be
 * summed. Same unit, same suffix, opposite answers — the kind is a property of
 * the measurement *and the axis*, so this registry names both. Summing over the
 * wrong axis is the whole of VER-01; leaving the axis implicit is how the same
 * line gets written correctly in one module and wrongly in the next.
 */

/**
 * Units that make a measurement intensive, with the aggregate each one wants.
 *
 * The `aggregate` field is not decoration: it is the answer a caller needs, and
 * writing it here is what makes the refusal actionable. A gate that says "no"
 * and stops is a gate people route around; one that says "use a mean" is a gate
 * they satisfy.
 */
export const INTENSIVE_UNITS = Object.freeze({
  mm: 'a depth at a point — a spatial mean, or a max for a worst-case reading',
  c: 'a temperature — a mean, or a max/min for a peak',
  pct: 'a proportion of a whole — a mean, or a max for a peak rate',
  m3s: 'a discharge at a gauge — a mean, or a max for a flood peak',
  km: 'a distance — a mean, a max, or a distribution, never a total across sites',
  km2: 'a density-like extent — a mean over the sampled area',
  ha: 'an area at a site — a mean, or a sum only over disjoint sites',
  hours: 'a duration — a mean or a median, never a total across observations',
  minutes: 'a duration — a mean or a median, never a total across observations',
  deg: 'an angular precision — a mean or a worst case',
})

/**
 * Units that make a measurement extensive.
 *
 * Only one entry earns its place here, and it is the reason this half of the
 * table exists: a table that lists only what is forbidden cannot tell "this is
 * allowed" from "nobody has thought about this yet."
 */
export const EXTENSIVE_UNITS = Object.freeze({
  sq_km: 'an area of disjoint regions — areas add',
})

/**
 * The kind of a measurement named by a field, or `null` when the name states
 * no unit this table knows.
 *
 * The suffix is matched against the end of the name and at a `_` boundary, so
 * `precipitation_mm` resolves and `maximum` does not (it ends in `m`, not a
 * unit, and `_mm` is not its suffix). A name with no recognised suffix is a
 * count and resolves to `extensive` — `hazard_events`, `field_reports`,
 * `climate_observations` are all arrays of things.
 */
/**
 * Units that accumulate over time: a total over a period is a real quantity,
 * so summing one along the time axis is correct while summing it across sites
 * is not. See the axis note at the top of this file.
 */
export const ACCUMULATING_UNITS = Object.freeze(['mm', 'ha'])

/** The unit a field name ends in, or null when it states none this table knows. */
export function unitOf(field) {
  if (typeof field !== 'string' || !field) return null
  const name = field.trim()
  if (!name) return null
  for (const unit of [...Object.keys(EXTENSIVE_UNITS), ...Object.keys(INTENSIVE_UNITS)]) {
    if (name === unit || name.endsWith(`_${unit}`)) return unit
  }
  return null
}

/**
 * The kind of a measurement along one axis, or `null` when the name states no
 * unit this table knows.
 *
 * `axis` is `'space'` (the default, and the axis VER-01 got wrong) or `'time'`.
 * A field with no recognised unit suffix is a count and is extensive along
 * both: there is no field in this tree named for a measurement that does not
 * carry its unit, because the unit is the part a reader cannot infer.
 */
export function aggregationKindFor(field, { axis = 'space' } = {}) {
  const unit = unitOf(field)
  if (unit === null) {
    return typeof field === 'string' && /^[a-z][a-z0-9_]*$/.test(field.trim()) ? 'extensive' : null
  }
  if (axis === 'time' && ACCUMULATING_UNITS.includes(unit)) return 'extensive'
  return unit in EXTENSIVE_UNITS ? 'extensive' : 'intensive'
}

/** The aggregate an intensive field wants instead of a sum. */
export function preferredAggregate(field) {
  const unit = unitOf(field)
  if (unit === null || !(unit in INTENSIVE_UNITS)) return null
  return INTENSIVE_UNITS[unit]
}

/**
 * Refuse to sum an intensive field.
 *
 * The runtime half of the registry. `sumField(rows, 'precipitation_mm')` throws
 * rather than returning a number that looks like a measurement, because a wrong
 * number published under a right name is the failure mode this whole module is
 * about — a coordinator cannot tell it from a correct one.
 *
 * Returns the sum for an extensive field, so this is a drop-in for the
 * `reduce` it replaces.
 */
export function sumField(rows, field, { reason = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('sumField: rows must be an array')
  const kind = aggregationKindFor(field)
  if (kind === null) {
    throw new TypeError(`sumField: '${field}' states no unit this registry knows, so its kind is unknown`)
  }
  if (kind === 'intensive') {
    // An explicit escape hatch, for the one case where summing an intensive
    // quantity is correct: disjoint strata that partition the population, where
    // each row's value is already the stratum's own aggregate. It requires a
    // reason, in the same discipline as the absent-value gate's marker.
    if (!reason) {
      throw new TypeError(
        `sumField: '${field}' is intensive — ${preferredAggregate(field)}. ` +
        `Pass { reason } only if the rows partition the population and each value is already its stratum's aggregate.`,
      )
    }
  }
  let total = 0
  for (const row of rows) {
    const value = typeof row === 'number' ? row : row?.[field]
    // A non-finite reading contributes nothing and is not counted as a zero.
    // `Number(null)` is 0, which would fold an outage in as a measured dry day.
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/**
 * The mean of the finite readings of a field, or `null` when there are none.
 *
 * `null` and not 0: no readings is no measurement, and a caller that renders
 * the null says so. This is the aggregate the registry points an intensive
 * field at, and it is here so the answer is one call rather than a pattern each
 * module re-derives — which is how the sum got written in the first place.
 */
export function meanField(rows, field) {
  if (!Array.isArray(rows)) throw new TypeError('meanField: rows must be an array')
  let total = 0
  let count = 0
  for (const row of rows) {
    const value = typeof row === 'number' ? row : row?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) { total += value; count += 1 }
  }
  return count ? total / count : null
}
