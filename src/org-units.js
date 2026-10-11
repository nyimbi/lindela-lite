/**
 * ENH-33 — the server half of the administrative registry.
 *
 * The registry *data* lives in `public/shared/org-units.js`, which the browser
 * loads: the map frame, the outbreak geocoder and the district overlay all place
 * units by the same centre and radius the server aggregates by, and a browser
 * may not import `src/`. This file is the other half — the walks over that tree,
 * which only the server performs — and it reads the data rather than restating
 * it, because the defect ENH-33 names is precisely a second copy of the
 * geography kept in step by hand.
 *
 * Before this file, `public/shared/basemap.js` carried `PILOT_DISTRICTS`, a
 * hand-typed list of the five published districts with the same centres and
 * radii, whose only guarantee was a comment reading "matching src/districts.js".
 * The map and the district page agreed because nobody had edited one of them
 * yet. `basemap.js` now derives its list from this registry, so the two cannot
 * disagree.
 *
 * The split is not tidiness: the traversal helpers are ~1.3 KB gzipped and the
 * browser walks nothing. Keeping them beside the caller that needs them is what
 * keeps the map's copy of the registry to its data alone.
 */
import { ORG_UNITS, ORG_UNIT_SYNONYMS } from '../public/shared/org-units.js'

export { ORG_UNITS, WEATHER_DEFAULT_CODES, ORG_UNIT_SYNONYMS } from '../public/shared/org-units.js'

const BY_CODE = new Map(ORG_UNITS.map((unit) => [unit.code, unit]))

/** The unit with this code, or null. Exact, because a code is an identifier. */
export function orgUnitByCode(code) {
  if (!code) return null
  return BY_CODE.get(String(code).trim().toUpperCase()) || null
}

/**
 * Resolve free text — a code, a slug, a name, or a known synonym — to a unit.
 *
 * Codes are matched exactly (they are identifiers); slugs and names
 * case-insensitively, because those arrive from data. A caller that has a code
 * should use `orgUnitByCode` and get a null rather than a fuzzy match.
 */
export function orgUnitFor(slugOrName) {
  if (!slugOrName) return null
  const raw = String(slugOrName).trim()
  const exact = BY_CODE.get(raw.toUpperCase())
  if (exact) return exact
  const key = raw.toLowerCase()
  // The synonym table maps a name to a *code*, so the resolved value is
  // compared case-insensitively on every field — including the code, which is
  // uppercase and would otherwise miss.
  const resolved = (ORG_UNIT_SYNONYMS[key] || key).toLowerCase()
  return ORG_UNITS.find((unit) => (
    unit.slug === resolved || unit.name.toLowerCase() === resolved || unit.code.toLowerCase() === resolved
  )) || null
}

/** The unit's parent, or null at the root. */
export function parentOf(code) {
  const unit = orgUnitByCode(code)
  return unit ? orgUnitByCode(unit.parent_code) : null
}

/** Every unit whose parent is this one. */
export function childrenOf(code) {
  const unit = orgUnitByCode(code)
  if (!unit) return []
  return ORG_UNITS.filter((candidate) => candidate.parent_code === unit.code)
}

/** Root to the unit, inclusive. */
export function ancestorsOf(code) {
  const chain = []
  let unit = orgUnitByCode(code)
  while (unit) {
    chain.unshift(unit)
    unit = orgUnitByCode(unit.parent_code)
  }
  return chain
}

/**
 * The unit and every unit beneath it.
 *
 * This is the function that makes a district split a config change: a caller
 * aggregating a parent's records asks for its descendants, so a new child
 * appears in the parent's totals the moment its entry exists.
 */
export function descendantsOf(code) {
  const unit = orgUnitByCode(code)
  if (!unit) return []
  const out = [unit]
  for (const child of childrenOf(unit.code)) out.push(...descendantsOf(child.code))
  return out
}

/**
 * The units a rollup at this code covers, as slugs — the vocabulary the store's
 * records carry in their `district` field.
 *
 * A unit with no slug (a country) still returns its children's slugs, which is
 * the answer a caller summing a country wants. `unknown` records are not
 * claimed by any rollup: a record whose district matches nothing is not
 * evidence about a district.
 */
export function rollupSlugsFor(code) {
  return descendantsOf(code).map((unit) => unit.slug).filter(Boolean)
}

/** The registry as a tree, for a caller that wants the shape rather than a walk. */
export function orgUnitTree() {
  const build = (unit) => ({ ...unit, children: childrenOf(unit.code).map(build) })
  return ORG_UNITS.filter((unit) => unit.parent_code === null).map(build)
}
