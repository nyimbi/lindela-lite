# 20 High-Impact Improvements for Lindela Lite

Grouped by theme. Each names *what*, *where it plugs in*, and *why it matters* for a world-class humanitarian climate-ops platform.

## Data & Science (the credibility layer)

**1. Probabilistic risk with calibrated uncertainty bands**
Replace `computeFloodRisk` / `computeClimateConflictRisk` point-scores in `src/analytics.js` with quantile outputs (p10/p50/p90) plus a Brier/CRPS calibration report written to `data/calibration/`. *Why:* deterministic scalars mislead field responders; calibrated intervals are the minimum bar for decision support and let you show honest confidence without importing the proprietary calibration stack.

**2. Ensemble & multi-model forcing**
Extend `src/connectors/open-meteo.js` and `glofas.js` to persist raw ensemble members, not just deterministic runs. Add a lightweight `src/analytics/ensemble.js`. *Why:* single-run forecasts hide the tails that matter for flood/heat impact; ensembles are the standard practice at ECMWF/GloFAS and cheap to store.

**3. Impact-based forecasting (IBF) join**
Add a `src/analytics/impact.js` that crosses hazard footprints with `service_assets` + population rasters (WorldPop / GHSL) to produce *people-at-risk* and *facilities-at-risk*, not just hazard intensity. *Why:* WMO and IFRC have moved to IBF, hazard-only scores are considered obsolete for operational triggering.

**4. Bias-corrected downscaling for local skill**
Add a quantile-mapping module that bias-corrects CHIRPS/Open-Meteo against station observations (or user-uploaded gauges via `uploads.js`). *Why:* raw gridded products systematically miss coastal East Africa and orographic zones, a well-documented failure mode that erodes trust in the first bad season.

**5. Data-quality lineage graph**
Extend `computeDataQuality` to emit per-record provenance (source, retrieval time, transform version, upstream checksum) into a `data_lineage` table. *Why:* auditability is the difference between decision support and shadow IT; donors and ministries increasingly require this.

## Ops, Triggering & Response

**6. Anticipatory-action trigger protocols with dry-run + backtest**
Formalize `examples/trigger-protocols/*.json` into a versioned schema in `src/alerts.js` with (a) backtest against historical ingested data and (b) shadow-mode dispatch (compute + log, don't send). *Why:* real AA programs (START Network, IFRC FBF) require documented trigger histories with false-positive/miss rates before donors release pre-arranged finance.

**7. Human-in-the-loop approval workflow for high-severity alerts**
Add an `alert_events.approval` state machine (proposed, reviewed, approved, dispatched) with reviewer identity captured. Wire into `POST /api/v1/rapidpro/alert-events/:id/send`. *Why:* the README already commits to "Lite remains decision support, not an automated command system", the code doesn't enforce it yet.

**8. Two-way RapidPro flow correlation**
Extend `src/rapidpro.js` to correlate inbound `field-report` webhooks back to the outbound `alert_event` that triggered them and surface a response-rate metric per alert. *Why:* dispatch without a feedback loop is broadcasting, not coordination, this is what turns SMS into a real ops channel.

**9. Offline-first PWA dashboard**
Turn `public/` into a service-worker-backed PWA with IndexedDB caching of the last successful `/api/v1/*` responses and a background-sync queue for `incidents`/`field-reports`. *Why:* your target users work in Turkana, South Sudan, coastal Mozambique, connectivity is the binding constraint, not UI polish.

## Platform & Integrations

**10. First-class OGC / STAC compliance**
Serve hazards and service-asset layers via a STAC catalog and OGC API - Features endpoint alongside the existing JSON/GeoJSON. *Why:* every serious GIS client (QGIS, Kepler, ArcGIS, Felt) speaks these; you instantly gain interop with UN Clusters, OCHA HDX, and academic partners with zero client-side code from you.

**11. Common Alerting Protocol (CAP 1.2) export**
Add a `GET /api/v1/alert-events/:id.cap` handler in `src/server.js` that emits WMO CAP XML. *Why:* it's the lingua franca for national met services, mobile carriers, and Google Public Alerts, the on-ramp from Lite to national early-warning pipes.

**12. Pluggable connector SDK + registry manifest**
Extract the informal `ingest(...)` contract used across `src/connectors/*.js` into a documented interface (`ConnectorSpec` with `id`, `schema`, `rateLimit`, `retry`, `test`) plus a `connectors.registry.json`. *Why:* the connector list is where the platform lives or dies, a stable SDK invites CHC-UCSB, GDACS-JRC, and NGO partners to contribute sources without touching core.

**13. Webhook-driven event bus (outbox pattern)**
Add a durable `events_outbox` table plus a `POST /api/v1/webhooks` subscription API and a small dispatcher process. *Why:* every serious integrator (Ushahidi, KoBo, Mattermost, Slack, PagerDuty, IFRC GO) wants push, not poll; the outbox pattern gives you exactly-once semantics without a broker.

## Security, Privacy & Compliance

**14. AuthN/AuthZ with scoped API tokens and audit log**
Replace the currently-unauthenticated `/api/v1/*` with OIDC (via a thin verifier, no dep needed) and per-token scopes (`read:hazards`, `write:incidents`, `admin:schedules`). Log every mutating call to an append-only `audit_log`. *Why:* the current server would fail any donor security review; incidents and field reports frequently contain PII of vulnerable people.

**15. Field-report PII minimization + retention policy**
Add configurable PII redaction (names, phone, precise geo to H3 cell) in `src/schema.js` normalizers and a background `retention` task that ages out raw personal data per a policy file. *Why:* GDPR + national data-protection acts (Kenya DPA, Uganda DPA) apply the moment you touch SMS metadata; this is a legal, not a nice-to-have.

**16. Signed, reproducible releases and SBOM**
Add SLSA-level provenance to the CI (`.github/workflows/ci.yml`), generate a CycloneDX SBOM, sign the Docker image with cosign. *Why:* humanitarian buyers (WFP, UNICEF, ICRC) are actively requiring supply-chain attestations; a zero-runtime-deps posture makes this a cheap win you should broadcast.

## Reliability, Observability & Scale

**17. OpenTelemetry traces + Prometheus metrics + structured logs**
Instrument `createServer`, `runIngestion`, and `PostgresStore.merge` with OTel spans and expose `/metrics`. *Why:* right now nobody can answer "why was yesterday's `run-due` slow?" without grepping logs, the difference between a hobby server and a platform SREs will run.

**18. Idempotent ingestion with content-addressed dedup**
Change `runIngestion` to key records by `sha256(canonicalized-payload)` and reject duplicates at insert time; make `run-due` a resumable job with a lease. *Why:* every connector will double-fire eventually (network retries, scheduler drift); without idempotency you silently corrupt analytics. This is also the foundation for the lineage graph in #5.

## Product & Community

**19. Scenario workbench (deterministic "what-if")**
Add a `POST /api/v1/scenarios` endpoint and a dashboard tab that lets a user perturb inputs (rainfall +30%, asset X offline) and see recomputed risk/impact, pure functions, no ML. *Why:* planners live in scenarios; giving them a shareable, URL-encoded what-if is what converts a monitoring tool into a planning tool, and it stays inside the open-source boundary.

**20. Localization, plain-language rendering, and RTL/Arabic support**
Externalize dashboard and report strings; add i18n message catalogs (English, French, Portuguese, Swahili, Arabic, Amharic) and a plain-language mode for reports in `src/reports.js`. *Why:* the map of climate-conflict overlap runs through Francophone Sahel, Lusophone Mozambique, Arabophone Sudan/Chad, Swahiliphone East Africa, English-only is an adoption ceiling, not a preference.

---

**If forced to sequence:** do **18 (idempotency)**, **14 (auth)**, **17 (observability)** first, they unblock everything else. Then **6 (AA triggers)** and **3 (IBF)**, they are what makes this world-class rather than "another dashboard".
