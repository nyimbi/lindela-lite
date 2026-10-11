/**
 * CAP-03 — the administrative hierarchy, as a registry rather than a derivation.
 *
 * Two constants held the same geography in different shapes: `KNOWN_DISTRICTS`
 * (`src/districts.js`) with `slug`/`name`/`center`/`radius_km`, and
 * `DEFAULT_REGIONS` (`src/schema.js`) with `name`/`country`/`lat`/`lon`. Seven
 * modules resolved a district against one or the other, and `resolveDistrict`
 * consulted a synonym table the record matcher did not — which is how the
 * Karamoja page read `people_reached: 0` while 3,504 Moroto recipients existed.
 * A third name for the same place is not a naming problem, it is a second
 * source of truth.
 *
 * **What this registry adds that neither constant had.**
 *
 *   - a **code** per unit, so a reference is an identifier rather than a name
 *     that has to be matched case-insensitively against free text;
 *   - a **parent pointer**, so the hierarchy is data. Aggregating to a country,
 *     or to a district that contains others, is a walk up the tree rather than
 *     a re-derivation per module;
 *   - **level**, so "roll this up" has a defined answer.
 *
 * **The boundary is a centre and a radius, and it says so.** This platform has
 * no polygons — `boundary_kind` on every unit is `center_radius`, which is the
 * resolution every distance and overlap figure in the codebase already assumes.
 * Calling it a boundary without that field would invite a reader to treat a
 * 200 km circle as an administrative edge.
 *
 * **A split is now an entry, not a migration.** Adding a unit whose
 * `parent_code` is an existing district makes it a child; `rollupOf` returns it
 * with its siblings, and a caller that aggregates by parent gets the new unit
 * without a code change. That is the property the defect named as missing.
 *
 * This module imports nothing, so `src/schema.js` and `src/districts.js` can
 * both derive their constants from it without a cycle.
 */

/**
 * Every administrative unit, flat, with its parent named by code.
 *
 * The five districts are the ones the platform publishes pages for; the two
 * additional level-2 units (Mogadishu, Juba) are the ones the weather
 * connectors have always pulled for and which `DEFAULT_REGIONS` carried. They
 * are in the same tree now rather than in a parallel list.
 */
export const ORG_UNITS = Object.freeze([
  Object.freeze({ code: 'KE', name: 'Kenya', level: 1, parent_code: null, country: 'KE', kind: 'country' }),
  Object.freeze({ code: 'SS', name: 'South Sudan', level: 1, parent_code: null, country: 'SS', kind: 'country' }),
  Object.freeze({ code: 'UG', name: 'Uganda', level: 1, parent_code: null, country: 'UG', kind: 'country' }),
  Object.freeze({ code: 'SO', name: 'Somalia', level: 1, parent_code: null, country: 'SO', kind: 'country' }),

  // The five the platform publishes a page for, in the order the page lists
  // them. `publishes_page` is the flag `KNOWN_DISTRICTS` filters on; it is
  // declared rather than inferred from "has a slug", because whether a unit
  // gets a page is a product decision, not a property of the geography.
  Object.freeze({
    code: 'KE-TURKANA', slug: 'turkana', name: 'Turkana', level: 2, parent_code: 'KE', country: 'KE',
    kind: 'district', center: Object.freeze({ lat: 3.1167, lon: 35.6 }), radius_km: 200, boundary_kind: 'center_radius', publishes_page: true, weather_default: true,
  }),
  Object.freeze({
    code: 'SS-AWEIL', slug: 'aweil', name: 'Aweil', level: 2, parent_code: 'SS', country: 'SS',
    kind: 'district', center: Object.freeze({ lat: 8.767, lon: 27.4 }), radius_km: 150, boundary_kind: 'center_radius', publishes_page: true, weather_default: false,
  }),
  Object.freeze({
    code: 'SS-BOR', slug: 'bor', name: 'Bor', level: 2, parent_code: 'SS', country: 'SS',
    kind: 'district', center: Object.freeze({ lat: 6.207, lon: 31.548 }), radius_km: 150, boundary_kind: 'center_radius', publishes_page: true, weather_default: false,
  }),
  Object.freeze({
    code: 'UG-KARAMOJA', slug: 'karamoja', name: 'Karamoja', level: 2, parent_code: 'UG', country: 'UG',
    kind: 'district', center: Object.freeze({ lat: 2.5333, lon: 34.6667 }), radius_km: 200, boundary_kind: 'center_radius', publishes_page: true, weather_default: false,
  }),
  Object.freeze({
    code: 'KE-MANDERA', slug: 'mandera', name: 'Mandera', level: 2, parent_code: 'KE', country: 'KE',
    kind: 'district', center: Object.freeze({ lat: 3.9366, lon: 41.8569 }), radius_km: 150, boundary_kind: 'center_radius', publishes_page: true, weather_default: false,
  }),
  // Known to the hierarchy, no page of its own. The weather connectors have
  // always pulled for these two; they were in `DEFAULT_REGIONS` and in no
  // district list, which is the parallel-registry shape CAP-03 names.
  Object.freeze({
    code: 'SS-JUBA', slug: 'juba', name: 'Juba', level: 2, parent_code: 'SS', country: 'SS',
    kind: 'district', center: Object.freeze({ lat: 4.8594, lon: 31.5713 }), radius_km: 150, boundary_kind: 'center_radius', publishes_page: false, weather_default: true,
  }),
  Object.freeze({
    code: 'SO-MOGADISHU', slug: 'mogadishu', name: 'Mogadishu', level: 2, parent_code: 'SO', country: 'SO',
    kind: 'district', center: Object.freeze({ lat: 2.0469, lon: 45.3182 }), radius_km: 150, boundary_kind: 'center_radius', publishes_page: false, weather_default: true,
  }),
])

/**
 * The units the weather connectors default to, in the order they are pulled.
 *
 * A selection with an order, declared here rather than re-listed in
 * `src/schema.js`. It is not "every district" — it is the three a default run
 * covers — so it is a code list, and a code is what a selection should name.
 */
export const WEATHER_DEFAULT_CODES = Object.freeze(['KE-TURKANA', 'SO-MOGADISHU', 'SS-JUBA'])

/**
 * Names the data uses that are not the names the platform publishes.
 *
 * The single table now. It governed `resolveDistrict` and not the record
 * matcher, so `moroto` resolved to Karamoja on one path and matched nothing on
 * the other. One table consulted by every resolution is the fix; a second table
 * is the bug.
 */
export const ORG_UNIT_SYNONYMS = Object.freeze({ moroto: 'UG-KARAMOJA' })

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
