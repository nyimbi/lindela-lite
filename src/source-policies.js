/**
 * R-77 — the per-source ingestion policies, in a leaf module.

 * These lived in `src/ingestion.js` and were imported back by
 * `src/freshness.js:53`, which `src/ingestion.js:26` imports in turn — a
 * genuine module cycle. It resolved, because every use of the binding is at
 * call time and ESM defers the link, which is exactly what made it durable:
 * nothing failed, so nothing pointed at it.

 * The block is a pure literal — twenty frozen records of numbers and booleans,
 * no imports, no calls — so moving it here costs nothing and removes the
 * cycle. `src/ingestion.js` re-exports it, so every existing importer
 * (including `scripts/validate.mjs` and the tests that read it off
 * `ingestion`) keeps working unchanged; the identity of the export is
 * preserved, which is what makes this a move rather than an API change.
 *
 * The comments below travel with their entries because they are the reasoning
 * for each threshold, and a threshold with no history behind it is a guess
 * someone later tunes into meaninglessness.
 */
export const SOURCE_POLICIES = Object.freeze({
  open_meteo: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  // minimum_records is 1 rather than 0 for every source that is expected to
  // return something. With 0, a connector that silently parses nothing still
  // reports status "success", which is how CHIRPS, GloFAS, and NASA FIRMS all
  // hid broken ingestion. Verified 2026-10-01 across repeated runs: gdacs
  // returns 222 and usgs_earthquake 46, so a zero result means something broke.
  gdacs: { interval_minutes: 60, timeout_ms: 20000, retries: 2, stale_after_minutes: 180, minimum_records: 1, regular: true },
  glofas: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  chirps: { interval_minutes: 720, timeout_ms: 20000, retries: 2, stale_after_minutes: 1440, minimum_records: 1, regular: true },
  nasa_firms: { interval_minutes: 360, timeout_ms: 30000, retries: 2, stale_after_minutes: 720, minimum_records: 1, regular: true },
  usgs_earthquake: { interval_minutes: 60, timeout_ms: 20000, retries: 2, stale_after_minutes: 180, minimum_records: 1, regular: true },
  noaa_enso: { interval_minutes: 720, timeout_ms: 20000, retries: 2, stale_after_minutes: 1440, minimum_records: 1, regular: true },
  // IPC classifications come out per analysis month and HDX scrapes them
  // promptly, so 24 h beats the feed without hammering a 3.6 MB CSV. WHO GHO
  // publishes yearly, so its staleness window is long: a national-annual
  // figure is "stale" here only when something breaks, not week to week.
  ipc_hdx: { interval_minutes: 1440, timeout_ms: 30000, retries: 2, stale_after_minutes: 2880, minimum_records: 1, regular: true },
  who_gho: { interval_minutes: 1440, timeout_ms: 20000, retries: 2, stale_after_minutes: 20160, minimum_records: 1, regular: true },
  // Historical backfills, never on the regular schedule: a full gdacs_archive
  // walk is a paginated quarter-by-quarter crawl of 40 years, and re-running
  // it hourly would be abuse of a free service. They run on demand (public
  // ingestion or the ingestion run API) to stock training data.
  //
  // ENH-11. `budget_ms` is the deadline for the *source*, where `timeout_ms`
  // bounds one request. A full walk is 1985→now quarter by quarter — 168
  // requests at two retries each — so 168 × 3 × 30s reaches ~4.2 h while every
  // individual call is a healthy 30s. ING-06 measured the runaway; the budget
  // is what stops it, and the connector checks it between windows so the run
  // can say why it stopped instead of being reaped by a socket that outlives
  // the process. 15 minutes is roughly four times the slowest observed run
  // across every source in the demo store (ipc_hdx, 174.8s) and still leaves
  // the walk bounded, which is the point.
  gdacs_archive: { interval_minutes: 0, timeout_ms: 30000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false, budget_ms: 900000 },
  open_meteo_archive: { interval_minutes: 0, timeout_ms: 60000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false },
  open_meteo_flood: { interval_minutes: 0, timeout_ms: 60000, retries: 2, stale_after_minutes: 43200, minimum_records: 1, regular: false },
  // Same cadence as open_meteo: the forecast is refreshed upstream roughly
  // hourly and the overlay is only honest while the issue time is recent. The
  // staleness window is the one WEATHER_STALE_AFTER_MINUTES publishes.
  open_meteo_forecast: { interval_minutes: 180, timeout_ms: 20000, retries: 2, stale_after_minutes: 360, minimum_records: 1, regular: true },
  // The plan asked for minimum_records: 0 ("no epidemic in the window is
  // legitimate"), but every regular PUBLIC source is held to a floor by the
  // no-silent-empty-success rule (R-41 family, enforced in test/lite.test.js).
  // The honest vocabulary for legitimate emptiness already exists: two
  // consecutive zero-record runs report the freshness verdict empty_response —
  // "the source answers, but has had nothing for us" — while a FIRST empty run
  // reads degraded, which is the correct suspicion.
  reliefweb_epidemics: { interval_minutes: 360, timeout_ms: 20000, retries: 2, stale_after_minutes: 720, minimum_records: 1, regular: true },
  service_assets: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  acled_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  conflict_csv: { interval_minutes: null, timeout_ms: 5000, retries: 0, stale_after_minutes: null, minimum_records: 0, regular: false },
  dhis2: { interval_minutes: 360, timeout_ms: 20000, retries: 1, stale_after_minutes: 720, minimum_records: 0, regular: false },
  // Kobo and IoT are the same shape as dhis2: a connector that stays inert
  // until an operator sets the env gate and supplies credentials for an
  // instance only they know. `regular: false` and `minimum_records: 0` say
  // that out loud — there is no publisher to be overdue against and no floor
  // to hold an unconfigured pull to. Judging either against a clock produces
  // the noise that trains people to ignore the freshness signal.
  kobo: { interval_minutes: 360, timeout_ms: 20000, retries: 2, stale_after_minutes: 720, minimum_records: 0, regular: false },
  iot: { interval_minutes: 360, timeout_ms: 20000, retries: 2, stale_after_minutes: 720, minimum_records: 0, regular: false },
})
