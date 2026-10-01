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

### Changed

- GDACS parsing reads namespaced RSS tags by local name and extracts event type
  codes, bbox, and country. The previous literal-prefix match returned null for
  all three.

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
