# Changelog

## Unreleased

Flood, access-risk, and seasonal-signal capability. All additions are additive;
no existing endpoint changed shape.

### Added

- `GET /api/v1/flood-depth`. Static inundation from an operator-supplied water
  surface elevation, using keyless AWS Terrarium (SRTM) terrain — no API key and
  no data licence to obtain. Returns point depth, a level profile, an area grid,
  `extent_geojson`, and terrain context.
- `GET /api/v1/road-access` and `/api/v1/road-access/summary`. Flood and landslide
  events matched against road segments by bounding box rather than centre
  distance, so a large hazard polygon cuts the roads it actually contains. Reports
  passable / restricted / impassable with reasons.
- `POST /api/v1/routing/plan`. Dijkstra over imported road assets, returning the
  route, severed-segment diagnostics, and restricted-route penalties. Separates
  foot and vehicle classification, and reports infeasibility rather than returning
  a straight line.
- Flood-depth and road-status overlays on the operations map, with depth-banded
  shading and a legend. The water level is an operator input, not a forecast; the
  UI labels it a simulation.
- `noaa_enso` connector. NOAA CPC Niño 3.4 SST anomaly index from a keyless
  fixed-width ASCII feed, verified live on 2026-10-01. Emits
  `climate_observations` with coordinates deliberately null, because a
  basin-wide Pacific index must not be attributed to a district by proximity.

### Known limitations

- Flood depth is a static water-surface calculation: **no flow routing, channel
  geometry, or storage is modelled.** A water surface at *L* shades everything
  below *L* that is hydraulically connected, which in reality is only some of it —
  a closed basin below *L* does not become a lake. Every response carries this
  statement and the vertical resolution (±15 m, inherited from SRTM) so a caller
  can judge whether the question is answerable at their margin.
- ENSO output is **advisory strength, not a declared event.** CPC declares an
  episode only after ±0.5 °C holds for five consecutive overlapping three-month
  seasons; the connector reports how many consecutive seasons currently qualify
  and never asserts an episode from fewer.
- The ENSO connector reads the **ONI**. Per NWS Public Information Statement
  26-05, CPC now uses RONI for official ENSO monitoring, but RONI is not published
  as a stable keyless monthly feed, so reading ONI and labelling it RONI would be
  a fabricated capability. Recorded in each record's `index_used` and `index_note`.
- Rainfall intensity and duration to flood probability is **not implemented.** It
  requires an explicitly agreed hydrological model basis and a long validated
  annual-maxima record; no coefficients were invented.
- Landslide clearance is a **fixed 5 km radius** around the reported location,
  not a run-out model. It is a screening radius chosen to reflect that debris
  travels further than standing water, not a slope-stability or volume estimate.
  Treat it as "this road needs checking", not "this road is safe".

### Changed

- `?bbox=` now returns events the source reported as an **area** overlapping the
  box, not only events with a point inside it. GDACS reports most events as a box
  and the connector withholds a point when that box is regional, so a point-only
  filter told a caller asking about a district that nothing was there for hazards
  the source had explicitly placed there.
- The map requests the operational area and recent global events as two separate
  queries. It previously requested only the 50 most recent events worldwide, which
  with GDACS and USGS both live is always the same Pacific and Caribbean
  earthquakes: the seeded flood and landslide that the road-access and routing
  walkthrough depends on were paginated out and never drawn.
- Planning a route now **frames the map on that route**, the way a flood
  simulation frames on its extent. The Lodwar corridor is four roads inside six
  kilometres, so a region-wide frame collapsed the reroute into one unreadable
  cluster. The frame is derived from the returned hops, not the requested
  endpoints, because a plan that detours around a cut segment passes through
  neither. Clearing the route returns the region frame.
- The map has a **minimum rendered height**. `.map-container` is a flex column
  that also holds the seasonal strip, filters, flood controls and routing panel,
  so `flex: 1` gave the map only the leftover space: on a 1440x900 laptop it
  rendered at 195x122 with 82% of the width unused and legend text at 2.4px. The
  cells were present in the DOM, so every assertion passed while the map was
  effectively invisible. `.map-section` now scrolls instead of clipping.
- The flood status line reports the inundated area in km² and names the box the
  percentage is a share of, stating that it is not a share of the district. It
  previously read "40% of the area", which invites reading 40% of the district as
  underwater.
- Landslide hazards now render with their own class and appear in the map legend.
  `.hazard-landslide` was declared in CSS but no code path ever applied it, so a
  landslide fell through to the generic marker and looked like any other event
  even though road-access models it differently from flood.
- GDACS parsing reads namespaced RSS tags by local name and extracts event type
  codes, bbox, and country. The previous literal-prefix match returned null for
  all three.
- **Risk score bands renamed to say what they are.** `score_p10` / `score_p50` /
  `score_p90` / `interval_width` are a *sensitivity range driven by input
  coverage*, not quantiles of a predictive distribution. A well-populated region
  returned `p10 == p90` with `interval_width: 0`, which reads as certainty while
  actually meaning inputs were sufficient. Responses now carry
  `sensitivity_low` / `_mid` / `_high` / `_width`, `calibrated_uncertainty: false`,
  and a `limits` string. The old names remain as aliases with identical values,
  so stored records and consumers keep working. No calibrated bands ship with
  this release and no Brier/CRPS calibration report exists.

### Fixed

- **Three connectors reported success while ingesting nothing.** CHIRPS matched
  filenames against a product index that now lists year directories, so the
  pattern matched zero times. GloFAS's published RSS URL serves the EFAS web app,
  so the parse found no items. NASA FIRMS has no keyless access and the
  placeholder key returned HTTP 400 per region while the catalog claimed no
  credentials were needed. Each now reports an error instead of an empty success,
  and their fixtures reproduce the real upstream responses.
- **A source returning zero records can no longer report `success`.**
  `minimum_records` was 0 on four regular sources, so an empty parse passed the
  health check as fresh. Every regular public source now declares a floor of 1,
  verified against live record counts first. User-supplied sources keep a floor
  of 0, since uploading an empty CSV is a legitimate operator action.
- **Country-scale hazard bboxes no longer block distant roads.** A GDACS green
  flood alert for France arrived with a bbox spanning ~40°, and bbox containment
  is authoritative in the road-access matcher — every road in the Horn of Africa
  came back restricted by an alert 2,051 km away. Only hazard-scale boxes
  (≤5°, ~555 km) may block on containment; wider ones fall back to proximity
  matching around the reported centre.
- `POST /api/v1/routing/plan` rejects coordinate objects with an error naming the
  problem. They previously produced "Unknown origin or destination road", which
  is indistinguishable from missing data.
- The demo seed reports a degraded source as degraded. `runIngestion` does not
  throw for one, so every source was labelled "ok".

## v0.2.0 - 2026-10-01

Hardening pass focused on operational integrity and payment compliance. No breaking
API changes; all additions are additive.

### Added

- USGS real-time earthquake ingestion (`usgs_earthquake`), emitting `hazard_events`
  so existing risk scoring and alerting pick it up unchanged. Follows the connector
  spec and is registered in `schema.js`, `ingestion.js`, and `connectors.registry.json`.
  Offline fixture tests cover parsing and upstream failure.
- OFAC SDN sanctions screening on parametric disbursement simulation. A match returns
  HTTP 409 and records nothing; clean screens are stamped on the disbursement so an
  audit can distinguish screened from unscreened payments. Name-based only — see
  Limitations in `docs/parametric.md`.
- `DELETE` on operational collections with soft-delete semantics. Records are stamped
  `deleted_at` / `deleted_by` rather than removed, so action-log history and
  referential links survive. Hidden from lists and `GET` unless `?include_deleted=true`;
  writing to or re-deleting a deleted record returns 409.
- Request body size cap (5 MB default, `LINDELA_LITE_MAX_BODY_BYTES`) returning 413,
  and 400 with a clear message for malformed JSON.

### Changed

- PostgreSQL `merge()` now upserts only the request's records instead of
  `DELETE`-ing and reinserting the whole table. Ten single-record merges against
  5,000 rows: 23,515 ms → 201 ms. `payload_hash` moved to an indexed column and
  backfilled from existing bodies on startup, so upgrades keep dedupe working.
- `operationalSummary()` and `counts()` exclude soft-deleted records, so
  `/api/v1/health` and `/api/v1/operations/summary` agree.

### Fixed

- USGS connector used an endpoint that returns HTML rather than JSON; every live
  ingest failed to parse. Now uses the `feed/v1.0/summary` GeoJSON paths.

## v0.1.0 - 2026-05-18

Initial public release candidate for Lindela Lite.

### Added

- Public climate, hazard, fire, flood, service-asset, and optional conflict CSV ingestion.
- Baseline flood risk, climate-conflict risk, and service-impact scoring.
- JSON, pg0, and external PostgreSQL storage modes.
- REST API, CSV export, GeoJSON export, and static dashboard.
- Service asset import endpoint and dashboard CSV/GeoJSON import controls.
- OpenAPI contract, storage docs, contribution docs, security policy, and trigger protocol examples.
- CI workflow with Node 20/22 and PostgreSQL integration coverage.

### Excluded

- GDELT ingestion.
- WorldMonitor code.
- Proprietary Lindela fusion, calibrated models, report management, wargaming, classified workflows, and source reputation systems.
