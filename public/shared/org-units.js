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
 * `parent_code` is an existing district makes it a child; a caller that
 * aggregates by parent gets the new unit without a code change, because the
 * walk that does the aggregating reads this tree rather than a per-module list.
 * That is the property the defect named as missing.
 *
 * **This file is the data; the walks over it are in `src/org-units.js`.** The
 * browser loads this file to place a district on the map and never walks the
 * hierarchy, so the traversal helpers — `orgUnitFor`, `descendantsOf`,
 * `rollupSlugsFor` and the rest — would be dead weight on the first load. They
 * are pure functions over `ORG_UNITS`, so they sit beside the server that calls
 * them, and this file stays a constant.
 *
 * This module imports nothing, so `src/schema.js` and `src/districts.js` can
 * both derive their constants from it without a cycle.
 *
 * **ENH-33. It lives in `public/shared/` because the browser needs it too.** The
 * map carried `PILOT_DISTRICTS` (`public/shared/basemap.js`), a hand-typed list
 * of the same five districts with the same centres and radii, kept in step by a
 * comment that read "matching src/districts.js". That is a second source of
 * truth for the geography, and the reason the registry is in the shared tree
 * rather than under `src/`: a browser may not import `src/`, and the map frame,
 * the outbreak geocoder and the district overlay all need the same centres the
 * server aggregates by. `src/org-units.js` re-exports this file, so a
 * server-side caller has one import and there is one copy of the data.
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
