/**
 * ENH-07 — declarative per-source assertions, and quarantine on failure.
 *
 * Four connectors each hand-rolled one guard for one specific past breakage:
 * GloFAS detected the rss.xml path becoming a web app, CHIRPS detected the
 * raster index losing its year directories, NASA FIRMS detected a missing
 * MAP_KEY, WHO detected a query that silently returned nothing. Four guards for
 * four breakages, and a *partial* break — the one that leaves records parsing
 * but few of them, or in the wrong place, or with a field quietly null — matches
 * none of them. The knowledge is preserved here as data, per source, so the
 * next source is a list entry rather than another bespoke function.
 *
 * THE RECORD-COUNT CASE IS THE ONE THAT MATTERS. The GDACS archive answers each
 * quarterly query with at most ~100 features and says nothing about it. A
 * forty-year walk that returns 4,000 of 40,000 parses cleanly, raises no error,
 * and reports success. No guard that only checks "did it throw" or "is the
 * count greater than zero" can see that; only a comparison against what this
 * source returned last time can.
 *
 * What the wiring needs (ENH-07 integration):
 *   - `runAssertions({ source, records, trailingRecords })` → `{ ok, failures, stats }`.
 *     Call it per source per collection after the connector returns, before
 *     `store.merge`. Pass the previous runs' record counts as `trailingRecords`
 *     (numbers, per-run arrays, or objects carrying `records_processed`).
 *   - `ok === false` → call `quarantineRecords(...)` and merge the result into
 *     `quarantine_<collection>` instead of publishing, and set the run's status
 *     to `degraded` with `failures` in `diagnostics`. Do not publish a partial
 *     batch and do not report zero: a condemned batch is a finding to be read,
 *     not a number to be averaged into a trend.
 *   - Where a connector truncates, call `recordCountsFound(...)` (or
 *     `capRecords(...)`) so `counts_found` lands in the run's diagnostics.
 *     CHIRPS caps 730 probed files at 30 (ING-08) and records neither.
 *   - `ASSERTED_SOURCES` and `ASSERTION_KINDS` are exported so a test can
 *     require that every source in `schema.SOURCE_IDS` is asserted and that
 *     every declared kind is used. This repo's recurring defect is a list
 *     maintained in one place and checked nowhere; a list that cannot be
 *     iterated cannot be checked.
 *
 * ZERO IS A VALUE. `required_fields` is a presence test (`?? null`), never a
 * truthiness test. A rainfall total of 0 mm, a fire with 0 MW FRP, a conflict
 * event with 0 fatalities and a facility with 0 capacity are all real, measured
 * answers, and a `!value` check condemns every one of them. `null` and
 * `undefined` are the absences; `''` is treated as an absence too because an
 * empty string carries no value and this repo's own `required()` says so.
 */

import { canonicalHash, nowIso, stableId, toNumber } from './utils.js'
import { numericOrNull } from './analytics/numeric.js'
// The IoT normalizer's own sensor-type enum, so the assertion below cannot
// drift from the set the normalizer accepts. `field-signals.js` imports only
// `utils.js`, so this is not a cycle.
import { IOT_SENSOR_TYPES } from './field-signals.js'

/**
 * The assertion vocabulary. Every kind a source may declare, and nothing else —
 * the anti-vacuous test requires each entry here to be used by at least one
 * source, so adding a kind nobody uses fails the suite instead of sitting in
 * the map as dead config.
 */
export const ASSERTION_KINDS = Object.freeze([
  'required_fields',
  'coordinate_bounds',
  'value_range',
  'value_vocabulary',
  'min_count_vs_trailing',
  'monotonic_dates',
])

/**
 * Which collection each source writes, mirroring `OUTPUT_COLLECTIONS` in
 * `src/ingestion.js`. Declared here rather than imported so this module can be
 * imported by the wiring without a cycle; `test/source-assertions.test.js`
 * cross-checks every value against the real list, because a collection name
 * typed in two places is exactly the kind of list that rots.
 */
export const SOURCE_COLLECTIONS = Object.freeze({
  open_meteo: 'climate_observations',
  gdacs: 'hazard_events',
  glofas: 'hazard_events',
  chirps: 'climate_observations',
  nasa_firms: 'hazard_events',
  usgs_earthquake: 'hazard_events',
  noaa_enso: 'climate_observations',
  ipc_hdx: 'food_security_records',
  who_gho: 'disease_observations',
  gdacs_archive: 'hazard_events',
  open_meteo_archive: 'climate_observations',
  open_meteo_flood: 'climate_observations',
  open_meteo_forecast: 'weather_forecasts',
  reliefweb_epidemics: 'disease_observations',
  service_assets: 'service_assets',
  acled_csv: 'conflict_events',
  conflict_csv: 'conflict_events',
  dhis2: 'climate_observations',
  kobo: 'field_reports',
  iot: 'iot_observations',
})

const GLOBAL_BOUNDS = Object.freeze({ latitude: { min: -90, max: 90 }, longitude: { min: -180, max: 180 } })

/**
 * The assertion map. Data, not code: every entry is a plain frozen object so a
 * test can read it, count it, and require that nothing is declared without
 * being measured.
 *
 * Each `note` says where the assertion came from. A threshold with no history
 * behind it is a guess someone will later tune into meaninglessness.
 */
export const SOURCE_ASSERTIONS = deepFreeze({
  open_meteo: [
    {
      name: 'open_meteo.every reading is identified and dated',
      kind: 'required_fields',
      fields: ['id', 'source', 'region_name', 'observed_at'],
      note: 'The API answered with a current block and a daily block; a record missing either anchor cannot be plotted or aged.',
    },
    {
      name: 'open_meteo.forecast points land in the operating hemisphere',
      kind: 'coordinate_bounds',
      // The region list is operator-supplied (`options.regions`) and defaults to
      // Turkana, Mogadishu and Juba, so the box covers Africa with margin rather
      // than three towns: adding Dakar or Cape Town must not quarantine a run.
      latitude: { min: -40, max: 72 },
      longitude: { min: -30, max: 55 },
      note: 'Catches a swapped lat/lon or a decimal shift, not a new region.',
    },
    {
      name: 'open_meteo.temperature in degrees Celsius',
      kind: 'value_range',
      field: 'temperature_c',
      min: -90,
      max: 60,
      note: 'Physical bound, not a climate bound. `null` means the field was not in the response and passes.',
    },
    {
      name: 'open_meteo.one reading per configured region',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: false,
      note: 'The endpoint returns a reading for every requested region on every call, so a collapsed count means regions were dropped in this process, upstream, or in the request.',
    },
    // Deliberately no monotonic_dates: records are pushed region by region
    // (each region's whole forecast before the next region's today), so the
    // batch is not date-ordered by design. Asserting it would quarantine every
    // healthy run and teach operators to ignore quarantine.
  ],

  open_meteo_forecast: [
    {
      name: 'open_meteo_forecast.every reading is identified, placed and dated',
      kind: 'required_fields',
      fields: ['id', 'source', 'region_name', 'observed_at', 'as_of'],
      // `as_of` is required, not optional: the report groups a district's latest
      // forecast issue by it, and a record without one can neither be grouped
      // nor aged — it would render as current weather with no issue time.
      note: 'The overlay draws from these records directly; one missing anchor is a glyph with no provable age.',
    },
    {
      name: 'open_meteo_forecast.district points land in the pilot region',
      kind: 'coordinate_bounds',
      // The default region list is the five pilot districts, so unlike
      // open_meteo's hemisphere-wide box this one can be tight: the region of
      // interest with margin, which catches a swapped lat/lon rather than only
      // a sign error.
      latitude: { min: -8, max: 18 },
      longitude: { min: 24, max: 55 },
      note: 'Operator-supplied regions can legitimately sit outside this box; the defaults cannot.',
    },
    {
      name: 'open_meteo_forecast.temperature in degrees Celsius',
      kind: 'value_range',
      field: 'temperature_c',
      min: -90,
      max: 60,
      note: 'Physical bound, not a climate bound. Daily records carry temperature_max_c instead and pass with null, which is absence, not a reading.',
    },
    {
      name: 'open_meteo_forecast.weather_code is a WMO code',
      kind: 'value_range',
      field: 'weather_code',
      min: 0,
      max: 99,
      note: 'WMO 4677 codes run 0-99; a value outside that is a parse failure, not a new kind of weather.',
    },
    {
      name: 'open_meteo_forecast.one batch per configured district',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: false,
      note: 'Every district yields a current reading plus the daily points on every call, so a collapsed count means districts were dropped in this process, upstream, or in the request.',
    },
    // No monotonic_dates here either, for the same reason as open_meteo:
    // records are pushed district by district, each district's whole week
    // before the next district's today.
  ],

  gdacs: [
    {
      name: 'gdacs.alerts carry an id, a type and a date',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at'],
      // `latitude`, `longitude`, `country` and `severity` are deliberately NOT
      // required. The connector nulls coordinates when GDACS attaches a
      // region-scale bbox whose centre is hundreds of kilometres away, and
      // nulls severity when alertlevel falls outside the published vocabulary.
      // Those nulls are the connector being honest; asserting them would
      // condemn the exact records it worked hardest to keep honest.
      note: 'Coordinates and severity are null by design when the feed does not support a confident value.',
    },
    {
      name: 'gdacs.coordinates are on the globe',
      kind: 'coordinate_bounds',
      ...GLOBAL_BOUNDS,
      note: 'The RSS is worldwide, so a regional box would be wrong. This bound only catches sign swaps and decimal shifts, which put an event in the ocean.',
    },
    {
      name: 'gdacs.affected population is a plausible headcount',
      kind: 'value_range',
      field: 'affected_population',
      min: 0,
      max: 2e9,
      note: 'Scraped out of the alert prose as free text, so a comma or a stray word is the expected failure. 0 is a real figure for a small event.',
    },
    {
      name: 'gdacs.alerts do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.4,
      zero_is_legitimate: false,
      note: 'GDACS publishes continuously; a quiet fortnight is a few alerts, not none.',
    },
  ],

  glofas: [
    {
      name: 'glofas.forecast items are titled and dated',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'title', 'occurred_at'],
      // The 2026-10-01 breakage, translated. The rss.xml path began serving the
      // EFAS single-page app: HTTP 200, HTML body, zero items, no error, and
      // the run reported "no floods forecast". Under this map that batch has no
      // records to check the fields on, so the count assertion is what fires —
      // and it fires because a continuously-published forecast feed returning
      // nothing is a breakage, not a quiet week.
      // `severity`, `latitude` and `longitude` are null by construction and are
      // NOT required: the feed publishes none, and inferring them was the bug
      // before this (see the connector's own comment).
      note: 'Translated from the connector\'s looksLikeFeed() guard, which could only catch the whole feed being replaced, not a partial one.',
    },
    {
      name: 'glofas.the forecast feed published something',
      kind: 'min_count_vs_trailing',
      ratio: 0.25,
      zero_is_legitimate: false,
      note: 'Copernicus publishes on a fixed cycle; an empty batch means the endpoint changed shape, not that there are no floods.',
    },
  ],

  chirps: [
    {
      name: 'chirps.rainfall records are identified, dated and located',
      kind: 'required_fields',
      fields: ['id', 'source', 'type', 'observed_at', 'region_name'],
      // `precipitation_mm` is still not required, and the reason changed on
      // 2026-10-14. It used to be null on *every* record because the connector
      // did not decode pixels. It now decodes them, so the field is populated —
      // but a null is still legitimate and still not zero rainfall: a region
      // over ocean or outside the 50S-50N extent samples nodata, and a raster
      // that fails to decode leaves the record without a value. Requiring the
      // field would condemn those runs, which are honest ones.
      //
      // What must never be absent is `region_name`. It was the literal 'global'
      // on every record until the connector began sampling per region, which is
      // exactly why nothing could be paired against a region's Open-Meteo
      // series — a record with no region cannot join to one.
      note: 'precipitation_mm may be null for a nodata cell or an undecodable raster, and its values_note says which; region_name is what makes the record joinable.',
    },
    {
      name: 'chirps.precipitation values are plausible millimetres',
      kind: 'value_range',
      field: 'precipitation_mm',
      // Daily CHIRPS is mm/day. The record high for a 0.05-degree cell is well
      // under 1000; a negative value is the nodata sentinel (-9999) leaking
      // through the mask, which is the failure this catches — a reader that
      // dropped the mask would store -9999 as a measurement and every
      // downstream mean would be quietly wrong.
      min: 0,
      max: 1000,
      note: 'Negative values are the CHIRPS nodata sentinel (-9999) escaping the mask; the upper bound is far above any real daily total.',
    },
    {
      name: 'chirps.every record says why it holds the value it does',
      kind: 'required_fields',
      fields: ['metadata.values_note'],
      // Reading pixels means downloading rasters, and a download can fail or a
      // cell can be nodata. Both leave `precipitation_mm: null`, and both are
      // legitimate — but neither may be left for a reader to guess at, because
      // the guess a reader makes about a null rainfall figure is "no rain fell".
      // The note names the case; this requires it to be there.
      //
      // The run-level counterpart — how many rasters a run decoded and how many
      // failed — lives in the connector's completeness block, which the
      // assertion framework never sees (`runAssertions` is handed records, not
      // the run's return value). It is asserted in `test/fixtures.test.js`
      // against the connector directly, rather than plumbed through here.
      note: 'A null precipitation_mm must carry the reason it is null; a reader must never have to infer "no rainfall" from an absent value.',
    },
    {
      name: 'chirps.daily file dates do not go backwards',
      kind: 'monotonic_dates',
      field: 'observed_at',
      order: 'descending',
      // The connector sorts dates and reverses them, so descending is the
      // expected order; ascending would mean a truncated sort silently
      // re-ordered the batch, which is how a probe of the wrong year directory
      // would look.
      note: 'Expected order is newest-first; anything else means the sort or the year walk changed.',
    },
    {
      name: 'chirps.daily rasters do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.3,
      zero_is_legitimate: false,
      note: 'The product root stopped listing files directly and began listing year directories (2026-10-01). A year directory that yields no filenames is a layout change, and this count is how it shows up in the batch rather than only in an error string nobody reads.',
    },
  ],

  nasa_firms: [
    {
      name: 'nasa_firms.detections are identified, dated and located',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at', 'latitude', 'longitude'],
      note: 'The connector skips rows whose coordinates do not parse, so a record that exists has both. A missing coordinate means the skip stopped working.',
    },
    {
      name: 'nasa_firms.detections fall inside the queried regional boxes',
      kind: 'coordinate_bounds',
      // The three boxes are fixed in the connector: East Africa / Horn
      // (33,-5,52,15), Central Africa (15,-5,35,10), Sahel / West
      // (-15,5,15,25). A detection outside all of them came from a query
      // response that was not a response.
      latitude: { min: -6, max: 26 },
      longitude: { min: -16, max: 53 },
      note: 'The union of the three bboxes with a small margin; a detection elsewhere means the CSV parse picked up the wrong columns.',
    },
    {
      name: 'nasa_firms.fire radiative power is a plausible megawatt figure',
      kind: 'value_range',
      field: 'metadata.frp',
      min: 0,
      max: 5000,
      // min 0, not min 1: a small detection can carry 0 MW FRP. A truthiness
      // test here would condemn the smallest fires on the map and, because the
      // count would then shrink, look like the feed shrank.
      note: 'FRP of exactly 0 is a real detection, not a missing value.',
    },
    {
      name: 'nasa_firms.active fire does not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.25,
      zero_is_legitimate: false,
      // The translated FIRMS guard. There is no keyless access — verified
      // 2026-10-01, the API answers HTTP 400 "Invalid MAP_KEY." — so a batch of
      // exactly zero almost always means the MAP_KEY went missing, and the
      // connector's own error string is the only thing saying so today.
      note: 'Fire detections in the Horn every day; zero means the key, not the planet.',
    },
  ],

  usgs_earthquake: [
    {
      name: 'usgs.quakes are identified, dated and located',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at', 'latitude', 'longitude'],
      note: 'A GeoJSON feature with no geometry has no place on a map; it should never have reached the store.',
    },
    {
      name: 'usgs.coordinates are on the globe',
      kind: 'coordinate_bounds',
      // Global, deliberately, and this is the case worth arguing for: the
      // platform's footprint is East Africa and the Horn, and a narrow
      // operational box is tempting. It would be wrong. This feed is worldwide
      // by design, an M7 in Chile or an M5 in the Aleutians is a true record,
      // and quarantining it would train operators to read quarantine as noise.
      // The bound exists for the failures it can actually see: lon/lat
      // transposed, a sign lost, 0/0 for a feature that has no geometry.
      ...GLOBAL_BOUNDS,
      note: 'Global because the source is global. The bound catches sign and transpose errors, not events outside the footprint.',
    },
    {
      name: 'usgs.magnitude is a plausible moment magnitude',
      kind: 'value_range',
      field: 'metadata.magnitude',
      min: -2,
      max: 10,
      note: 'M-2 is a quarry blast and M10 is beyond anything recorded; both ends are far enough out to catch a column shift.',
    },
    {
      name: 'usgs.quakes do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.2,
      // M2.5+ worldwide runs to roughly 46 per day at the connector's current
      // bounds, so the floor is deliberately low: a swarm is real and a quiet
      // fortnight happens. The assertion is here for the batch that returns two
      // when it returned forty-six, not for the batch that returns forty.
      zero_is_legitimate: true,
      note: 'Zero quakes in a window is possible; a tenth of the trailing window is not.',
    },
  ],

  noaa_enso: [
    {
      name: 'noaa_enso.months are identified and dated',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'metric', 'observed_at'],
      note: 'A month with no period cannot be placed in an ENSO episode; the episode walk runs on `observed_at`.',
    },
    {
      name: 'noaa_enso.Niño 3.4 anomaly is in degrees Celsius',
      kind: 'value_range',
      field: 'value',
      min: -6,
      max: 6,
      note: 'The record anomaly runs about ±2.6; ±6 is far enough out to catch a Kelvin/Celsius mix-up or a misplaced decimal.',
    },
    {
      name: 'noaa_enso.months do not go backwards',
      kind: 'monotonic_dates',
      field: 'observed_at',
      order: 'descending',
      note: 'The connector slices the series and reverses it; a forward-ordered batch means the slice changed.',
    },
    {
      name: 'noaa_enso.months do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: false,
      note: 'The CPC file is a fixed monthly series, so the record count is known, not merely hoped for.',
    },
  ],

  ipc_hdx: [
    {
      name: 'ipc_hdx.classifications are identified, dated and scoped',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'country', 'observed_at'],
      // No coordinates required and none are produced: an area name is not a
      // point, and the connector keeps latitude/longitude null for that reason.
      note: 'IPC publishes areas, not points; a coordinate here would be an invention.',
    },
    {
      name: 'ipc_hdx.phase 3+ fraction is a proportion',
      kind: 'value_range',
      field: 'phase3plus_fraction',
      min: 0,
      max: 1,
      note: 'A fraction above 1 means the Percentage column stopped being a percentage.',
    },
    {
      name: 'ipc_hdx.classifications do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.25,
      zero_is_legitimate: false,
      // The translated guard. `food_security_records` was missing from
      // OUTPUT_COLLECTIONS' counters, so a fully successful run reported
      // "degraded — expected at least 1 records; received 0". The count here is
      // what catches a real zero rather than a bookkeeping one.
      note: 'HDX carries analysis months continuously; zero means the scrape or the counter broke.',
    },
  ],

  who_gho: [
    {
      name: 'who_gho.observations are identified, placed and valued',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'indicator_code', 'country', 'year', 'observed_at', 'value'],
      note: 'The connector drops rows that are not COUNTRY/YEAR/numeric before they get here, so a survivor has all of it.',
    },
    {
      name: 'who_gho.national counts are not absurd',
      kind: 'value_range',
      field: 'value',
      min: 0,
      max: 1e8,
      // The bound is loose on purpose. CHOLERA_0000000003 is a case fatality
      // ratio in 0..1 while CHOLERA_0000000001 is a national case count in the
      // hundreds of thousands, and a single shared bound that fits both is
      // useless. This one only catches a unit or column shift; per-indicator
      // plausibility is the summariser's job, not the gate's.
      note: 'Loose enough to hold both counts and ratios; its purpose is to catch a column shift, not to judge the epidemiology.',
    },
    {
      name: 'who_gho.indicators do not empty out silently',
      kind: 'min_count_vs_trailing',
      ratio: 0.25,
      // The honest complication. Cholera's series ends at 2016 and meningitis at
      // 2014 (verified 2026-10-02), so a *current* window legitimately returns
      // nothing for those indicators. Asserting non-zero would quarantine a
      // correct staleness finding and, worse, would push an operator to patch
      // the connector to fabricate rows. Silence is not breakage; the fact that
      // silence is indistinguishable from breakage is the finding, and it is
      // stated in `stats.zero_records_expected` rather than papered over.
      zero_is_legitimate: true,
      note: 'Verified staleness (cholera ends 2016) is legitimate silence, so a zero passes and is reported as expected rather than as a pass.',
    },
    // No monotonic_dates: the OData payload arrives in whatever order the
    // service chose, `$orderby` is silently ignored (probed 2026-10-02), and
    // the connector deliberately fetches unordered and selects in process.
    // Asserting an order here would quarantine the honest implementation.
  ],

  gdacs_archive: [
    {
      name: 'gdacs_archive.flood events are identified and dated',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at'],
      note: 'The archive retains only eventtype FL records with a country in the filter set; the surviving shape is fixed.',
    },
    {
      name: 'gdacs_archive.coordinates are on the globe',
      kind: 'coordinate_bounds',
      ...GLOBAL_BOUNDS,
      note: 'The archive is worldwide and `countries: "all"` is supported, so a regional bound would be wrong here too.',
    },
    {
      name: 'gdacs_archive.quarters walk forwards in time',
      kind: 'monotonic_dates',
      field: 'occurred_at',
      // Ascending, unlike CHIRPS and NOAA above: the archive walks year by year
      // and quarter 1..4 within each. A batch that runs backwards is a
      // paginated query returning a different slice than it did last time,
      // which on this feed is indistinguishable from the ~100 cap unless the
      // ordering is checked.
      order: 'ascending',
      note: 'Forward walk expected; a reversal means the quarterly paging changed shape.',
    },
    {
      name: 'gdacs_archive.flood severity is not a fabricated zero',
      kind: 'value_range',
      field: 'severity',
      min: 0,
      max: 1e6,
      // Flood severitydata is a placeholder ("Magnitude 0.00"), so the
      // connector maps it to null. A published 0 here is the placeholder
      // leaking back in and would read as "no area affected".
      note: 'severity stays null for floods; a numeric 0 is the placeholder, not a measurement.',
    },
    {
      name: 'gdacs_archive.windows are not silently truncated',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: false,
      // Scoped to runs that walked a comparable number of quarters. The batch
      // size is the quarter count times the density of floods in those
      // quarters, and SAE-27 made the quarter count vary by design: the first
      // run walks the whole archive, every run after it re-reads the one
      // quarter still open. Comparing a one-quarter batch against a
      // hundred-and-sixty-eight-quarter baseline is not a collapse, it is two
      // different objects, and without this the second run of every archive
      // read as degraded.
      //
      // The ~100-per-query cap that motivated the assertion is caught
      // independently by `assessPagination` — a window that comes back exactly
      // full is `possibly_incomplete` and the walk says which windows hit it.
      // This one covers what that cannot: a walk that read every planned
      // window, hit no cap, and still returned far fewer events than the same
      // walk did before.
      scope: 'windows',
      note: 'Same number of quarters, a fraction of the events: the walk completed and the feed shrank.',
    },
  ],

  open_meteo_archive: [
    {
      name: 'open_meteo_archive.series are identified and anchored at both ends',
      kind: 'required_fields',
      fields: ['id', 'region_name', 'observed_at', 'series_start', 'series_end', 'series_days', 'daily'],
      note: 'One record per region carrying the whole daily array, so both ends must be stated; a series that does not say where it ends is not a training series.',
    },
    {
      name: 'open_meteo_archive.series length is plausible',
      kind: 'value_range',
      field: 'series_days',
      min: 1,
      max: 20000,
      note: 'ERA5 daily from 1940 is under 32,000 days; the cap is a column-shift guard, not a policy.',
    },
    {
      name: 'open_meteo_archive.regions do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.8,
      zero_is_legitimate: false,
      note: 'One record per requested region; a region that stopped being fetched looks identical to a source that stopped answering.',
    },
  ],

  open_meteo_flood: [
    {
      name: 'open_meteo_flood.series are identified and anchored at both ends',
      kind: 'required_fields',
      fields: ['id', 'region_name', 'observed_at', 'series_start', 'series_end', 'series_days', 'daily'],
      note: 'A region with no GloFAS river reach is recorded as an error and skipped, never as a series of zeros.',
    },
    {
      name: 'open_meteo_flood.series length is plausible',
      kind: 'value_range',
      field: 'series_days',
      min: 1,
      max: 20000,
      note: 'Same bound as the archive series; both come off the same daily grid.',
    },
    {
      name: 'open_meteo_flood.regions do not collapse against the trailing window',
      kind: 'min_count_vs_trailing',
      ratio: 0.8,
      // Zero is legitimate here in principle — a district headquarter with no
      // river reach in the GloFAS grid produces no series. But it is not the
      // normal case and the connector already reports it per region as an
      // error, so the count assertion is what stops a whole-region loss from
      // reading as a clean run.
      zero_is_legitimate: false,
      note: 'A grid cell with no river reach is legitimate and reported per region; losing every region is not.',
    },
  ],

  service_assets: [
    {
      name: 'service_assets.assets are identified and typed',
      kind: 'required_fields',
      fields: ['id', 'name', 'service_type'],
      note: 'Operator-supplied rows. The fields checked are the ones the rest of the platform filters on; the rest are optional by design.',
    },
    {
      name: 'service_assets.assets are on the globe',
      kind: 'coordinate_bounds',
      ...GLOBAL_BOUNDS,
      note: 'Operator-uploaded assets are worldwide and the uploader knows best; the bound catches a lat/lon transpose in a spreadsheet, not a location.',
    },
    {
      name: 'service_assets.capacity is not negative',
      kind: 'value_range',
      field: 'capacity',
      min: 0,
      max: 1e7,
      // 0 is a real capacity: a borehole with a broken pump, a clinic with an
      // empty tank. A truthiness check here would quarantine the facilities
      // that are down, which are exactly the ones worth knowing.
      note: 'Capacity 0 is a facility that is out of service, not a missing number.',
    },
    {
      name: 'service_assets.uploads do not shrink unexpectedly',
      kind: 'min_count_vs_trailing',
      ratio: 0.3,
      // An operator uploading nothing is the normal state of this source, and
      // the connector is on-demand only. Asserting non-zero would condemn an
      // idle system on every run.
      zero_is_legitimate: true,
      note: 'This source runs on demand and is idle most of the time; an empty upload is not a fault.',
    },
  ],

  acled_csv: [
    {
      name: 'acled.events are identified, dated and located',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at', 'latitude', 'longitude'],
      note: 'The normalizer drops rows without a date, so every survivor has one. Licensed user-supplied data; the assertions are about the CSV round-trip, not the licence.',
    },
    {
      name: 'acled.coordinates are on the globe',
      kind: 'coordinate_bounds',
      ...GLOBAL_BOUNDS,
      note: 'ACLED is a global product; an operator importing Kenyan rows will also import the rest, and a global bound does not punish that.',
    },
    {
      name: 'acled.fatalities is a plausible death count',
      kind: 'value_range',
      field: 'fatalities',
      min: 0,
      max: 1e6,
      // The falsy-zero case in its purest form. A protest with no deaths is the
      // overwhelming majority of ACLED rows and carries fatalities: 0. Any
      // truthiness check on this field quarantines most of a licensed export.
      note: 'fatalities: 0 is the most common real value in this dataset and must survive every presence check.',
    },
  ],

  conflict_csv: [
    {
      name: 'conflict_csv.events are identified, dated and located',
      kind: 'required_fields',
      fields: ['id', 'source_id', 'event_type', 'occurred_at', 'latitude', 'longitude'],
      note: 'Same normalizer as the ACLED path; the assertions are about the upload round-trip.',
    },
    {
      name: 'conflict_csv.coordinates are on the globe',
      kind: 'coordinate_bounds',
      ...GLOBAL_BOUNDS,
      note: 'Operator-supplied and worldwide by content, not by platform footprint.',
    },
    {
      name: 'conflict_csv.fatalities is a plausible death count',
      kind: 'value_range',
      field: 'fatalities',
      min: 0,
      max: 1e6,
      note: '0 deaths is a real observation about an event that happened.',
    },
    {
      name: 'conflict_csv.uploads do not shrink unexpectedly',
      kind: 'min_count_vs_trailing',
      ratio: 0.3,
      zero_is_legitimate: true,
      note: 'On-demand upload; nothing uploaded is the normal state.',
    },
  ],

  dhis2: [
    {
      name: 'dhis2.records are identified when the sync is enabled',
      kind: 'required_fields',
      fields: ['id'],
      note: 'The connector is an off-by-default scaffold that returns nothing and says so in `errors`. Asserting anything it cannot yet emit would be asserting a fiction.',
    },
    {
      name: 'dhis2.nothing to compare until it is wired',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: true,
      note: 'Zero is the scaffold\'s correct output until LINDELA_LITE_DHIS2_ENABLED is on and a base_url is configured.',
    },
  ],

  reliefweb_epidemics: [
    {
      name: 'reliefweb_epidemics.records are identified, typed and dated',
      kind: 'required_fields',
      fields: ['id', 'source', 'source_id', 'disease', 'observed_at'],
      note: 'The RSS backend guarantees a GLIDE id as source_id (it comes from the /disaster/ link path); the API id is the item id. A survivor without one is a parse drift, not a sparse feed.',
    },
    {
      name: 'reliefweb_epidemics.geometry, when present, is in the Horn of Africa; absent is honest (unknown)',
      kind: 'coordinate_bounds',
      latitude: { min: -12, max: 18 },
      longitude: { min: 20, max: 55 },
      // Null coordinates are legitimate here — an unplaced record has
      // granularity 'unknown' and the map draws nothing for it.
      zero_is_legitimate: true,
      note: 'A transposed or foreign coordinate suggests the geocoder matched text it had no business matching; nulls are the honest fallback, not the failure.',
    },
    {
      name: 'reliefweb_epidemics.granularity is one of the three honesty labels',
      kind: 'value_vocabulary',
      field: 'granularity',
      values: ['subnational', 'national', 'unknown'],
      note: 'This label is what keeps a country-centroid aggregate from reading as district evidence; anything outside the vocabulary is a rendering hazard.',
    },
    {
      name: 'reliefweb_epidemics.case counts are plausible, absent, or null',
      kind: 'value_range',
      field: 'cases',
      min: 0,
      max: 1e7,
      zero_is_legitimate: true,
      note: 'Heuristic extraction from glance text; null (not stated) is the normal case and passes as absence.',
    },
    {
      name: 'reliefweb_epidemics.death counts are plausible, absent, or null',
      kind: 'value_range',
      field: 'deaths',
      min: 0,
      max: 1e6,
      zero_is_legitimate: true,
      note: 'Same as cases: 0 deaths is a real published figure; absence is the default.',
    },
    {
      name: 'reliefweb_epidemics.the feed may legitimately be empty',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: true,
      note: 'No current epidemic disaster is a reading, not a silence to condemn; a collapse from a large trailing count is still worth its row.',
    },
  ],

  kobo: [
    {
      name: 'kobo.field reports are identified, formed and sourced',
      kind: 'required_fields',
      fields: ['id', 'external_id', 'form_id', 'source'],
      // `external_id` is the Kobo `_id`. A submission without one is a parse
      // drift rather than a sparse form: every submission Kobo returns carries
      // it, and `stableId` falls back to the array index when it is missing —
      // which would key two different reports to one id on the next pull.
      note: 'The id is what makes a re-pull idempotent; the external_id is what makes it checkable against Kobo.',
    },
    {
      name: 'kobo.a field report keeps a body',
      kind: 'required_fields',
      fields: ['body'],
      // The raw submission *is* the report — the connector stringifies it so
      // every form field the author chose survives. An empty body means the
      // submission was not read, which is the failure this connector exists to
      // avoid reporting as success.
      note: 'A field report with no body is a record of a submission nobody can read.',
    },
    {
      name: 'kobo.submitted_at is null or a timestamp, never a guess',
      kind: 'value_vocabulary',
      field: 'source',
      values: ['kobotoolbox'],
      note: 'The source names the provider, and the CHW route writes the same collection with a different one — a record that lost its provenance reads as locally filed.',
    },
    {
      name: 'kobo.the pull may legitimately return nothing',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: true,
      note: 'A form nobody submitted today is a quiet day, not a dead connector; a collapse from a large trailing count is still worth its row.',
    },
  ],

  iot: [
    {
      name: 'iot.readings are identified, placed and dated',
      kind: 'required_fields',
      fields: ['id', 'sensor_id', 'sensor_type', 'observed_at'],
      // `normalizeIotObservation` owns these, so a missing one is not a sparse
      // gateway — it is a record that bypassed the normalizer, which is the one
      // way a malformed reading reaches the store.
      note: 'The normalizer guarantees these; a batch missing one did not come through it.',
    },
    {
      name: 'iot.readings are a known sensor type',
      kind: 'value_vocabulary',
      field: 'sensor_type',
      // Read from the normalizer's own enum rather than retyped. A hand-typed
      // copy of a discoverable set is this repository's most-repeated defect,
      // and here it would be worse than usual: the normalizer *throws* on an
      // unknown type, so a copy that drifted wider than the enum would assert
      // a value the connector can never emit, and a copy that drifted narrower
      // would condemn a reading the normalizer accepted.
      values: IOT_SENSOR_TYPES,
      note: 'The closed enum is what keeps a typo in a gateway config from becoming a new sensor class nothing thresholds on.',
    },
    {
      name: 'iot.a reading is a real number',
      kind: 'value_range',
      field: 'value',
      min: -1e6,
      max: 1e6,
      // A water level of 0 m, a rainfall of 0 mm and a battery at 0% are all
      // measurements. The bound is a sanity rail against a unit or decimal
      // shift, not a claim about what the sensor can read.
      zero_is_legitimate: true,
      note: 'Physical sanity bound, not a sensor range: null passes as absence, and 0 is a reading.',
    },
    {
      name: 'iot.battery percentage is a percentage when present',
      kind: 'value_range',
      field: 'battery_pct',
      min: 0,
      max: 100,
      zero_is_legitimate: true,
      note: 'A flat battery is 0%, which is the reading an operator most needs; a value above 100 is a unit error.',
    },
    {
      name: 'iot.a sensor network may legitimately report nothing',
      kind: 'min_count_vs_trailing',
      ratio: 0.5,
      zero_is_legitimate: true,
      note: 'A gateway with no new readings is a quiet window, not a dead feed; a collapse from a large trailing count is still worth its row.',
    },
  ],
})

/** Every source with at least one declared assertion, frozen and iterable. */
export const ASSERTED_SOURCES = Object.freeze(Object.keys(SOURCE_ASSERTIONS))

/**
 * Run every assertion declared for `source` against `records`.
 *
 * Returns `{ ok, failures, stats }`. `stats` reports what was measured, so a
 * pass over an empty batch is visibly different from a pass over a full one:
 * `record_count`, per-field coverage, the trailing baseline that the count
 * assertion was judged against, and `unmeasured` — the assertions that had
 * nothing to look at. A source that stops emitting coordinates will otherwise
 * pass the coordinate assertion every day, in perfect silence, because there
 * are no coordinates to be wrong.
 *
 * @param {string} source          source id, as in `schema.SOURCE_IDS`
 * @param {object[]} records       the batch this run produced
 * @param {object[]|number[]} [trailingRecords]
 *   previous runs, in any of the forms the store hands them back: numbers
 *   (counts), arrays (per-run record batches), or run objects carrying
 *   `records_processed` / `count` / `records`. A flat array of record objects
 *   is read as one previous run.
 * @param {object} [options]       `{ now }`, for deterministic tests
 */
export function runAssertions({ source, records = [], trailingRecords = [], options = {} } = {}) {
  const now = options.now || new Date()
  const batch = Array.isArray(records) ? records : []
  const declared = SOURCE_ASSERTIONS[source]

  if (!declared) {
    // A stated result, not a silent pass. An unknown source with no assertions
    // would otherwise return ok: true, and `ok: true` is the one value nobody
    // reads closely. `unasserted_source` is deliberately not in
    // ASSERTION_KINDS: it is not declared by any source, and the anti-vacuous
    // test requires every declared kind to be used.
    return {
      ok: false,
      failures: [{
        assertion: 'source.has_assertions',
        kind: 'unasserted_source',
        message: `No assertions are declared for source "${source}". An unasserted source is unmeasured, not clean.`,
        detail: { source, known_sources: ASSERTED_SOURCES },
      }],
      stats: baseStats({ source, batch, declared: 0, now, unmeasured: ['source.has_assertions'], source_known: false }),
    }
  }

  const failures = []
  const fieldStats = {}
  const unmeasured = []
  // Measured once and reported, so a reader of the run can see what the count
  // assertion was judged against without having to re-run it.
  const counts = trailingCounts(trailingRecords)
  const trailing = { runs: counts.length, counts, median: median(counts) }

  for (const assertion of declared) {
    const context = { batch, trailingRecords, fieldStats, unmeasured, options }
    switch (assertion.kind) {
      case 'required_fields':
        failures.push(...checkRequiredFields(assertion, context))
        break
      case 'coordinate_bounds':
        failures.push(...checkCoordinateBounds(assertion, context))
        break
      case 'value_range':
        failures.push(...checkValueRange(assertion, context))
        break
      case 'value_vocabulary':
        failures.push(...checkValueVocabulary(assertion, context))
        break
      case 'min_count_vs_trailing':
        failures.push(...checkCount(assertion, context))
        break
      case 'monotonic_dates':
        failures.push(...checkMonotonicDates(assertion, context))
        break
      default:
        // Unreachable given the frozen map and the anti-vacuous test, but a
        // typo in a kind must not silently assert nothing.
        failures.push({
          assertion: assertion.name,
          kind: assertion.kind,
          message: `Unknown assertion kind "${assertion.kind}"; the assertion was not evaluated.`,
          detail: { known_kinds: ASSERTION_KINDS },
        })
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    stats: baseStats({ source, batch, declared: declared.length, now, unmeasured, fieldStats, source_known: true, trailing }),
  }
}

/**
 * Shape a condemned batch for `quarantine_<collection>`.
 *
 * Quarantine rather than publish, and rather than reporting zero. Publishing a
 * 4,000-of-40,000 batch fills the store with a plausible-looking history that
 * nobody can tell from a complete one; reporting zero discards the evidence
 * that something went wrong. The row carries the original record and the
 * failures that condemned it, so the batch is re-admittable once the cause is
 * known and readable in the meantime.
 *
 * `failures` are batch-level, so every quarantined row carries the same set:
 * a partial batch is condemned as a whole, and splitting the blame per record
 * would imply a precision the assertions do not have.
 *
 * @returns {object[]} rows shaped for a quarantine collection
 */
export function quarantineRecords({ source, records = [], failures = [], sourceRunId = null, collection = null, now } = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : (now ? String(now) : nowIso())
  const target = collection || SOURCE_COLLECTIONS[source] || 'records'
  const condemned = Array.isArray(failures) ? failures : []

  return (Array.isArray(records) ? records : []).map((record, index) => ({
    id: stableId('quarantine', [source, sourceRunId, target, index, canonicalHash(record)]),
    source,
    source_run_id: sourceRunId ?? null,
    collection: target,
    quarantine_collection: quarantineCollectionName(target),
    record_index: index,
    record_id: record?.id ?? null,
    record,
    failures: condemned,
    failure_count: condemned.length,
    failure_kinds: [...new Set(condemned.map((failure) => failure.kind))],
    payload_hash: canonicalHash(record),
    quarantined_at: timestamp,
    first_seen_at: timestamp,
    // Stated so the row cannot be read as a correction of the source. These
    // records are held because they failed a check, not because they are true.
    quarantine_reason: 'failed_source_assertion',
  }))
}

/** `quarantine_<collection>` — the name a condemned batch is held under. */
export function quarantineCollectionName(collection) {
  return `quarantine_${collection || 'records'}`
}

/**
 * ING-08: record the count that was *found* wherever a cap is applied.
 *
 * CHIRPS caps a run at 30 files out of 730 probed and records neither the 730
 * nor the cap, so the run reads as a complete picture of a short month. A
 * `counts_found` beside a truncated `records_processed` makes the truncation
 * arithmetic instead of invisible.
 *
 * @returns {object} a diagnostics fragment; spread it into `diagnostics`
 */
export function recordCountsFound({ source, collection, found, returned, cap = null, capName = null, reason = null } = {}) {
  // `numericOrNull` for the same reason as everywhere else in this file: a
  // caller that passes `found: null` — the honest value when nothing was
  // counted — was recorded as having found zero, and `capped` then compared
  // against it.
  const foundCount = numericOrNull(found)
  const returnedCount = numericOrNull(returned)
  const capped = foundCount !== null && returnedCount !== null ? returnedCount < foundCount : false
  return {
    source: source ?? null,
    collection: collection ?? null,
    counts_found: foundCount,
    records_returned: returnedCount,
    // How many were dropped. The number an operator needs is the difference,
    // and it is the one number the old code computed and then threw away.
    records_dropped: foundCount !== null && returnedCount !== null ? Math.max(foundCount - returnedCount, 0) : null,
    capped,
    cap: cap ?? null,
    cap_name: capName ?? null,
    cap_note: reason
      || (capped ? `Cap applied: ${returnedCount} of ${foundCount} records retained${capName ? ` (${capName})` : ''}.` : null),
  }
}

/**
 * Apply a cap while recording what it dropped. Prefer this over a bare
 * `.slice()` so a truncation cannot happen without leaving a count behind.
 *
 * @returns {{records: object[], counts_found: object}}
 */
export function capRecords({ records = [], limit = null, source = null, collection = null, capName = null, reason = null } = {}) {
  const all = Array.isArray(records) ? records : []
  // `Number(null)` is 0, so a Number.isFinite test on the limit reads "no limit"
  // as "keep nothing" and every uncapped batch silently becomes an empty one.
  // The null check comes first, and this is exactly the falsy-zero class the
  // rest of this module is about, caught by its own test.
  //
  // `numericOrNull` closes the rest of the same hole: the explicit null check
  // caught `null` and `undefined` and left `''`, `'  '`, `false` and `[]` to
  // reach `Number`, each of which is 0 — so an empty-string limit kept nothing.
  const parsedLimit = numericOrNull(limit)
  const bounded = parsedLimit !== null && parsedLimit >= 0 ? parsedLimit : null
  const kept = bounded === null ? all : all.slice(0, bounded)
  return {
    records: kept,
    counts_found: recordCountsFound({
      source,
      collection,
      found: all.length,
      returned: kept.length,
      cap: bounded,
      capName,
      reason,
    }),
  }
}

// -------------------------------------------------------------------
// Assertion implementations
// -------------------------------------------------------------------

/**
 * Presence, not truthiness. `??` rather than `||`, `!value` or `Boolean()`.
 *
 * `0` and `false` are answers; `null`, `undefined` and `''` are the absence of
 * one. Written this way on purpose: the previous generation of this repo lost
 * records at 0/0 and to falsy-zero filters, and `test/falsy-zero.test.js`
 * exists because the rule kept being broken in both directions.
 */
function isAbsent(record, path) {
  const value = path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), record)
  return (value ?? null) === null || value === ''
}

function readPath(record, path) {
  return path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), record)
}

function checkRequiredFields(assertion, { batch, fieldStats, unmeasured }) {
  const offenders = []
  const coverage = Object.fromEntries(assertion.fields.map((field) => [field, { present: 0, missing: 0 }]))

  for (const [index, record] of batch.entries()) {
    for (const field of assertion.fields) {
      if (isAbsent(record, field)) {
        coverage[field].missing += 1
        if (offenders.length < 5) {
          offenders.push({
            field,
            record_id: record?.id ?? null,
            record_index: index,
            // The offending value, named. `?? null` rather than `||` so a field
            // holding 0 or '' is reported as what it is.
            value: readPath(record, field) ?? null,
          })
        }
      } else {
        coverage[field].present += 1
      }
    }
  }

  for (const [field, counted] of Object.entries(coverage)) {
    fieldStats[field] = {
      ...(fieldStats[field] || {}),
      present: counted.present,
      missing: counted.missing,
      coverage: batch.length ? counted.present / batch.length : null,
    }
  }
  if (!batch.length) unmeasured.push(assertion.name)

  const missingTotal = Object.values(coverage).reduce((total, counted) => total + counted.missing, 0)
  if (!missingTotal) return []
  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `Assertion failed: ${missingTotal} record${missingTotal === 1 ? '' : 's'} missing a required field across ${assertion.fields.length} required field(s) out of ${batch.length} record(s).`,
    detail: {
      records_with_failures: offenders.length,
      offenders,
      // A field missing on every record is a shape change, not a data quirk.
      fields: Object.entries(coverage)
        .filter(([, counted]) => counted.missing > 0)
        .map(([field, counted]) => ({ field, missing: counted.missing, present: counted.present })),
    },
  }]
}

function checkCoordinateBounds(assertion, { batch, unmeasured }) {
  const offenders = []
  let checked = 0

  for (const record of batch) {
    const lat = readPath(record, assertion.latitude_field || 'latitude')
    const lon = readPath(record, assertion.longitude_field || 'longitude')
    // A null coordinate is the source declining to publish one, which several
    // connectors do deliberately and correctly. There is nothing to bound.
    if (lat === null || lat === undefined || lon === null || lon === undefined) continue
    checked += 1
    const latBad = !Number.isFinite(lat) || lat < assertion.latitude.min || lat > assertion.latitude.max
    const lonBad = !Number.isFinite(lon) || lon < assertion.longitude.min || lon > assertion.longitude.max
    if ((latBad || lonBad) && offenders.length < 5) {
      offenders.push({
        record_id: record?.id ?? null,
        latitude: lat,
        longitude: lon,
        latitude_allowed: assertion.latitude,
        longitude_allowed: assertion.longitude,
        // Which one is wrong, named: a transposed pair is the usual cause and
        // "out of bounds" alone sends people looking in the wrong direction.
        out_of_range: [latBad ? 'latitude' : null, lonBad ? 'longitude' : null].filter(Boolean),
      })
    }
  }

  if (!checked) unmeasured.push(assertion.name)
  if (!offenders.length) return []
  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `${offenders.length}${offenders.length >= 5 ? '+' : ''} coordinate pair(s) outside the plausible box for this source's geography.`,
    detail: { coordinates_checked: checked, offenders },
  }]
}

function checkValueRange(assertion, { batch, unmeasured }) {
  const offenders = []
  let checked = 0

  for (const record of batch) {
    const value = readPath(record, assertion.field)
    if (value === null || value === undefined) continue
    checked += 1
    const numeric = Number(value)
    // A string where a number belongs is itself the failure this is here for:
    // "1,234", "12.5 mm", a shifted CSV column. Range-checking a NaN silently
    // passes, which is how a unit string got stored as a measurement.
    if (!Number.isFinite(numeric) || numeric < assertion.min || numeric > assertion.max) {
      if (offenders.length < 5) {
        offenders.push({ record_id: record?.id ?? null, field: assertion.field, value, allowed: { min: assertion.min, max: assertion.max } })
      }
    }
  }

  if (!checked) unmeasured.push(assertion.name)
  if (!offenders.length) return []
  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `${offenders.length}${offenders.length >= 5 ? '+' : ''} value(s) of ${assertion.field} outside [${assertion.min}, ${assertion.max}] or not numeric.`,
    detail: { values_checked: checked, offenders },
  }]
}


/**
 * Closed vocabulary check. Exists because the granularity label is the
 * honesty payload of the outbreak records: a granularity outside
 * subnational/national/unknown would render an aggregate as district
 * evidence or drop an honest record without a reason. Absence passes —
 * the label is optional the way the engine treats absence everywhere
 * else; the connector guarantees it when it matters (record shapes that
 * must carry it do).
 */
function checkValueVocabulary(assertion, { batch, unmeasured }) {
  const offenders = []
  let checked = 0

  for (const record of batch) {
    const value = readPath(record, assertion.field)
    if (value === null || value === undefined) continue
    checked += 1
    if (!assertion.values.includes(String(value))) {
      if (offenders.length < 5) {
        offenders.push({ record_id: record?.id ?? null, field: assertion.field, value, allowed: assertion.values })
      }
    }
  }

  if (!checked) unmeasured.push(assertion.name)
  if (!offenders.length) return []
  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `${offenders.length} value(s) of ${assertion.field} outside the declared vocabulary.`,
    detail: { values_checked: checked, allowed: assertion.values, offenders },
  }]
}


/**
 * The trailing runs a count assertion may legitimately be judged against.
 *
 * A count is a measurement of the ground the run covered as much as of the feed
 * it read, so two counts are comparable only when the ground is. `gdacs_archive`
 * is the source that made this visible: SAE-27 gave it a cursor, and from the
 * second run on it re-reads the one quarter still open instead of the whole
 * archive. Its batch went from thousands of events to a handful, and the count
 * assertion — comparing against a baseline built from full walks — reported
 * every resumed run as a collapse. The number was right and the comparison was
 * wrong.
 *
 * The rule is per-assertion because the ground is per-source: `scope` names a
 * field the trailing window carries, and a run whose scope differs from this
 * run's is dropped from the baseline rather than allowed to poison it. Runs
 * from before the scope was recorded (`undefined`) are kept, so adding a scope
 * to a source does not silently empty its history.
 */
function scopeTrailing(assertion, trailingRecords, options) {
  const field = assertion?.scope
  if (!field) return trailingRecords
  const entries = Array.isArray(trailingRecords) ? trailingRecords : []
  const mine = options?.scope?.[field] ?? null
  if (mine === null) return entries
  return entries.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    // `numericOrNull`, not `Number`. A run that recorded `windows: null` — the
    // second spelling of "not recorded", and the one a JSON round-trip produces
    // from an `undefined` — became `Number(null) === 0`, so it compared as a run
    // that covered *zero* windows. Against a current run covering one window it
    // was dropped from the baseline, which is the opposite of the rule above:
    // a run with no recorded scope is kept, because dropping it is what empties
    // the history this function exists to preserve.
    const theirs = numericOrNull(entry[field])
    return theirs === null || theirs === mine
  })
}

function checkCount(assertion, { batch, trailingRecords, unmeasured, options }) {
  const scoped = scopeTrailing(assertion, trailingRecords, options)
  const counts = trailingCounts(scoped)
  const baseline = median(counts)
  const count = batch.length
  const zeroAllowed = assertion.zero_is_legitimate === true

  if (count === 0 && zeroAllowed) {
    // The falsy-zero rule applied to counts. A quiet week, an indicator that
    // stopped publishing, an operator who uploaded nothing: all legitimate, all
    // recorded, none of them a pass by accident.
    return []
  }

  if (baseline === null) {
    // No trailing window to judge against. Said plainly and listed as
    // unmeasured rather than reported as a pass, because "compared against
    // nothing" and "compared against last week" are different claims.
    unmeasured.push(assertion.name)
    return []
  }

  // `toNumber`, not `Number.isFinite(Number(x))`. The old expression returned
  // `Number(null)` for an absent ratio — 0 — and `required` is
  // `Math.ceil(baseline * ratio)`, so a declared assertion with no ratio
  // required **zero** records and could never fire. That is the count assertion
  // switched off by the field that configures it, which is the worst possible
  // failure for the one check that catches a source collapsing from 40,000
  // records to 4,000.
  //
  // A literal `ratio: 0` is treated the same way, and deliberately. No assertion
  // in this file declares one, `required` would be 0, and the assertion would be
  // dead on arrival — a value whose only effect is to disable its own check is a
  // typo, not a setting. If a source ever genuinely needs "never collapse-alarm",
  // it should say so by not declaring the assertion.
  const configured = toNumber(assertion.ratio)
  const ratio = configured !== null && configured > 0 ? configured : 0.25
  const required = Math.ceil(baseline * ratio)
  if (count >= required) return []

  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `${count} record(s) against a trailing median of ${baseline} (${trailingRunCount(trailingRecords)} prior run(s)); expected at least ${required}.`,
    detail: {
      records_found: count,
      trailing_median: baseline,
      trailing_counts: counts,
      runs_compared: counts.length,
      required_ratio: ratio,
      required_count: required,
      // Spelled out because the two look identical in a log: an empty batch in
      // a quiet source is fine, and the same empty batch in a source that
      // publishes every cycle is the feed changing shape.
      zero_is_legitimate: zeroAllowed,
      note: assertion.note || null,
    },
  }]
}

function checkMonotonicDates(assertion, { batch, unmeasured }) {
  const direction = assertion.order === 'descending' ? -1 : 1
  const offenders = []
  let previous = null
  let previousIndex = null
  let checked = 0

  for (let index = 0; index < batch.length; index += 1) {
    const raw = readPath(batch[index], assertion.field)
    if (raw === null || raw === undefined) continue
    const at = Date.parse(raw)
    if (!Number.isFinite(at)) {
      if (offenders.length < 5) offenders.push({ record_index: index, record_id: batch[index]?.id ?? null, field: assertion.field, value: raw, problem: 'unparseable date' })
      continue
    }
    checked += 1
    if (previous !== null && (at - previous) * direction < 0 && offenders.length < 5) {
      offenders.push({
        record_index: index,
        record_id: batch[index]?.id ?? null,
        value: raw,
        previous_value: batch[previousIndex]?.[assertion.field] ?? null,
        previous_index: previousIndex,
        problem: `went backwards in a batch ordered ${assertion.order || 'ascending'}`,
      })
    }
    previous = at
    previousIndex = index
  }

  if (checked < 2) unmeasured.push(assertion.name)
  if (!offenders.length) return []
  return [{
    assertion: assertion.name,
    kind: assertion.kind,
    message: `${offenders.length}${offenders.length >= 5 ? '+' : ''} date(s) out of order or unparseable in ${batch.length} record(s).`,
    detail: { field: assertion.field, order: assertion.order || 'ascending', dates_checked: checked, offenders },
  }]
}

// -------------------------------------------------------------------
// Trailing-window helpers
// -------------------------------------------------------------------

/**
 * Read a trailing window of prior runs out of whatever shape the store hands
 * back: numbers, per-run record arrays, run rows with `records_processed`, or a
 * flat list of records read as one previous run. Returns one count per run,
 * which is what the comparison is actually about.
 */
export function trailingCounts(trailingRecords) {
  const window = Array.isArray(trailingRecords) ? trailingRecords : []
  return window
    .map((entry) => {
      if (typeof entry === 'number') return entry
      if (Array.isArray(entry)) return entry.length
      if (entry && typeof entry === 'object') {
        // `numericOrNull`, not `Number(...)` behind an `isFinite` test. A
        // trailing run that recorded `''` or `false` as its count became 0 and
        // joined the baseline as a genuine zero-count run, which drags the
        // median down and makes the collapse this assertion exists to catch
        // look ordinary. The fallback below is what "no count stated" is meant
        // to reach, and the coercion was short-circuiting it.
        const stated = numericOrNull(entry.records_processed ?? entry.count)
        if (stated !== null) return stated
        if (Array.isArray(entry.records)) return entry.records.length
        // Anything else object-shaped is a record from one previous run, so it
        // counts once. Returning NaN here instead would silently drop the whole
        // window and leave the count assertion permanently unmeasured.
        return 1
      }      return NaN
    })
    .filter((count) => Number.isFinite(count))
}

function trailingRunCount(trailingRecords) {
  return Array.isArray(trailingRecords) ? trailingRecords.length : 0
}

/**
 * Lower median rather than mean, and rather than the usual two-element average.
 * One 40,000-row backfill among nine 40-row runs does not drag a mean, and it
 * barely moves the true median — but averaging the middle pair of
 * [40, 40, 40, 40, 40, 40, 40, 40, 40_000] hands back 20,020 and makes every
 * healthy daily run look like a 99% shortfall. The floor has to be the kind of
 * number the source normally produces.
 */
function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!numbers.length) return null
  return numbers[Math.floor((numbers.length - 1) / 2)]
}

function baseStats({ source, batch, declared, now, unmeasured = [], fieldStats = {}, source_known, trailing = null }) {
  const fields = fieldStats || {}
  const measuredFields = Object.entries(fields).filter(([, counted]) => counted.present > 0).length
  return {
    source: source ?? null,
    source_known: source_known,
    assertions_declared: declared,
    assertions_evaluated: declared,
    record_count: batch.length,
    empty_batch: batch.length === 0,
    // How much of the batch was actually looked at. A pass over 40,000 records
    // and a pass over none are both `ok: true` unless something says otherwise.
    records_measured: batch.length,
    fields_measured: measuredFields,
    field_coverage: fields,
    // What the count assertion was judged against. `median: null` means there
    // was no window to judge against, which is a different statement from
    // "compared and passed".
    trailing,
    unmeasured,
    // Present so a zero batch that passed on a legitimate silence is visibly
    // different from a zero batch that passed because nothing checked it.
    zero_records_expected: batch.length === 0,
    measured_at: (now instanceof Date ? now : new Date()).toISOString(),
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}