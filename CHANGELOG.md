# Changelog

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
