# Lindela-Lite



**Lindela Lite is an open-source coordination engine for climate-health and climate-conflict response.** It turns climate, health, conflict and field signals into pre-authorised district action: when a threshold crosses, the alert is already approved by a protocol the district signed, and the playbook executes.

Lindela Lite is the public, MIT-licensed edition of the Lindela platform. The full platform is deployed operationally with **IGAD** and the **Eastern Africa Standby Force (EASF)**. Lindela Lite runs the same coordination engine against public data sources and is live at **`lindela.co.ke`**.

It is built for fragmented, low-resource environments: offline-first, SMS / USSD / voice IVR, one runtime dependency, no framework, no build step.

---

## What It Does

- **Ingests** public climate, flood, fire, seismic, ENSO, food-security, disease and conflict-event data through a registry of source connectors, each with declared rate limits, retries and timeouts.
- **Correlates** multiple signals into an operating picture and prioritises alerts by severity and derivation.
- **Evaluates** threshold rules and trigger protocols with point-in-time backtests. A protocol is a pre-authorised condition: the district signs it once; when its metric crosses the threshold, the alert is auto-approved.
- **Executes** a pre-authorised playbook — notify via RapidPro, open an incident, create an intervention, attach a task — with a full audit chain naming the protocol version and approvers.
- **Tracks** incidents, interventions, tasks, field reports and response resources.
- **Reports** in donor-grade quarterly and operational formats, with refusal semantics: where a sample is too small, the report prints "not measured" with the reason rather than a figure.
- **Distributes** reports by local download, webhook and RapidPro SMS summary, each recorded as a distribution run.
- **Routes** over a real road network, refuses to route over impassable segments, and reports road access status per hazard.
- **Simulates** flood depth from a forecast water level against a DEM, answering "which facilities are under water, and how deep" — a static water-surface calculation, not a hydrological forecast.
- **Measures** equity per district: dispatches sent, acknowledged, and the share nobody acted on.
- **Serves** formatted JSON, GeoJSON and CSV through `/api/v1/*`.
- **Runs offline-first** through a service-worker outbox with exactly-once delivery.

---

## What It Does Not Do

- It does not include Lindela's commercial calibrated prediction models, multi-INT fusion, source-reliability scoring, wargaming, AAR, classified workflow, or enterprise orchestration.
- It does not ingest GDELT.
- It does not compute rainfall-intensity-to-flood-probability. That requires an agreed hydrological model basis and a long validated annual-maxima record; inventing coefficients that look authoritative is worse than returning nothing. What *is* shipped is the downstream operational question: given a forecast water level, which facilities are under water and how deep.
- It does not provide epidemic/outbreak surveillance or IPC food-security tracking at district resolution. IPC data requires a licence we do not have; WHO outbreak data available keyless is national-annual and cannot drive district response.
- It does not send an SMS without RapidPro configured. When the gateway is unconfigured, the `notify` action is recorded as **refused** with the reason, and the alert remains sendable by hand.

---

## Architecture

Lindela Lite is a coordination layer, not a dashboard. It is three layers, each independently testable.

```mermaid
flowchart TD
    subgraph Inputs[Signal Detection]
        A[Weather and rainfall]
        B[River discharge and flood]
        C[Conflict events]
        D[CHW SMS reports]
        E[School attendance]
        F[IoT sensors]
    end

    subgraph Intelligence[Intelligence Layer]
        G[Connector registry]
        H[Multi-signal correlation]
        I[Threshold rules and trigger protocols]
        J[Alert prioritisation]
    end

    subgraph Action[Action Layer]
        K[District alert]
        L[RapidPro SMS / USSD / IVR]
        M[Incidents and interventions]
        N[Reports and equity]
    end

    A --> G
    B --> G
    C --> G
    D --> G
    E --> G
    F --> G
    G --> H --> I --> J
    J --> K --> L
    K --> M
    M --> N
```

### Layer 1 — Signal detection

Source connectors live in `src/connectors/`, each declared in `connectors.registry.json` with rate limits, retries and timeout. A source that returns nothing reports `degraded` with the reason — never `success`. This is enforced by the minimum-records rule in [docs/ingestion.md](docs/ingestion.md).

### Layer 2 — Intelligence and pre-authorisation

`src/alerts.js` holds threshold rules with suppression windows and hysteresis, plus trigger protocols with point-in-time backtests and precision-lift scoring.

`src/protocols.js` is the pre-authorised executor. It supports two modes:

- **Shadow** — records what would have fired without acting. A district adopts a protocol in shadow before trusting it in live mode.
- **Live** — builds the alert with `approval.state = 'auto_approved'`, then runs the playbook: `notify`, `intervention`, `task`. Every action either executes or is recorded as **refused** with a reason. One refusal does not abort the playbook; the execution status is `executed`, `partial` or `refused` based on the results, not on the input.

Every execution carries the protocol version and approver list in the audit chain (`derivation.engine.rule_schema = 'protocol/1'`). A single atomic `store.merge` per run ensures a crash cannot leave a playbook committed without the alert that justified it.

### Layer 3 — Action and audit

`src/rapidpro.js` handles two-way SMS, USSD and voice IVR with a reply grammar (`ACK`, `ESCALATE`, `RESOLVED`, `NAK`) and SLA escalation. Silence is never read as "all fine" — every severity has an escalation deadline.

`src/reports.js`, `src/kpi.js` and `src/pdf.js` produce operational and quarterly reports. `src/audit-chain.js` signs every export. `src/routing.js` and `src/road-access.js` route over imported road assets; an impassable segment is removed from the network entirely rather than penalised, because no finite cost is a barrier. `src/flood-depth.js` simulates static water surface against a DEM and prints what the percentage is a share of — the surveyed box, not the district.

### Data model
### Record flow

How a signal becomes an auditable action. Every box is a collection; every
arrow is a write the executor actually performs.

```mermaid
flowchart LR
    subgraph S[Signals]
        CO[climate_observations]
        HE[hazard_events]
        CE[conflict_events]
    end

    subgraph D[Decision]
        TP[trigger_protocols]
        AE[alert_events]
        PE[protocol_executions]
    end

    subgraph A[Action]
        IN[incidents]
        IV[interventions]
        IT[intervention_tasks]
    end

    subgraph C[Communication]
        RD[rapidpro_dispatches]
        RI[rapidpro_inbound_messages]
        FR[field_reports]
    end

    subgraph R[Reporting]
        RP[reports]
        RDR[report_distribution_runs]
    end

    CO --> TP
    HE --> TP
    CE --> TP
    TP --> PE
    PE --> AE
    AE --> RD
    PE --> IN
    IN --> IV
    IV --> IT
    RD --> RI
    RI --> FR
    FR --> AE
    AE --> RP
    RP --> RDR
```

Read it left to right. A signal crosses a protocol threshold (`TP`). The
executor writes an execution row (`PE`) and, in live mode, an auto-approved
alert (`AE`). The playbook then branches: the notify action writes a dispatch
(`RD`), the intervention action writes an incident, an intervention and a task
(`IN` → `IV` → `IT`). A reply arrives as an inbound message (`RI`) and becomes
a field report (`FR`), which can inform the next alert evaluation.

`protocol_executions` is the join point. It carries `alert_id`, the protocol
version, and the action results. That is the audit chain the demo shows.

Full column-level schema in [docs/data-model.md](docs/data-model.md).
The store is a declared-schema document store, switchable between JSON and Postgres (see [Storage](#storage)). Forty-plus collections, grouped:

- **Signals** — `climate_observations`, `hazard_events`, `conflict_events`, `school_attendance_observations`, `iot_observations`, `field_outcomes`
- **Decisions** — `alert_rules`, `alert_events`, `trigger_protocols`, `protocol_executions`
- **Operations** — `incidents`, `interventions`, `intervention_tasks`, `field_reports`, `response_resources`
- **Communication** — `rapidpro_dispatches`, `rapidpro_inbound_messages`, `community_feedback`
- **Reporting** — `report_templates`, `reports`, `report_distribution_runs`, `report_schedules`
- **Geospatial** — `service_assets`, `impact_assessments`, `risk_scores`, `population_at_risk_rows`, `facilities_at_risk_types`
- **Audit** — `action_logs`, `data_lineage`, `events_outbox`

Undeclared collections refuse to write rather than dropping silently. Rejected records go to quarantine homes. Full schema in [docs/data-model.md](docs/data-model.md).

### Offline-first

`public/sw.js` plus the CHW outbox implement exactly-once delivery through connectivity loss. A repository gate stops the server and walks the full arc — cold start, offline capture, restart, delivery, exactly once — on every change.

### Tests

Over two thousand automated tests, plus seven repository gates (budget, OpenAPI, accessibility, offline, i18n coverage, schema, license). The tests are the specification: refusal semantics, offline delivery, USSD/IVR grammar, i18n coverage floors.

---

## Run

```bash
npm test
npm start
```

The server listens on `LINDELA_LITE_PORT` or `4177`.

`npm start` binds **every interface**, because a container bound to loopback would make a published port unreachable. On a laptop that publishes the platform to your network, and with no API key configured, authentication is off. Use `./run.sh` for development — it binds loopback, reports what it is doing, and refuses to start unauthenticated on any wider address:

```bash
./run.sh --check        # preflight only
./run.sh --seed         # seed a demo store, then serve it
./run.sh --key devkey   # require an API key
```

For deployment see [docs/deployment.md](docs/deployment.md): `deploy/one-click.sh` for Docker Compose, `install.sh` for `curl … | bash` on a bare host, and `scripts/deploy.sh` to push over SSH.

```bash
curl http://127.0.0.1:4177/api/v1/health
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["open_meteo","gdacs"],"regions":[{"name":"Turkana","lat":3.1,"lon":35.6,"country":"KE"}]}'
```

Create default public-source schedules and run sources that are due:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/defaults
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run-due
curl http://127.0.0.1:4177/api/v1/ingest/status
```

## Demo data

A reproducible demo store covers five East African pilot regions: **Turkana (KE)**, **Bor (SS)**, **Aweil (SS)**, **Moroto (UG)** and **Mandera (KE)**.

```bash
npm run demo:seed
```

Or over HTTP with the server running:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/demo/seed
```

Both methods are safe to run multiple times — records deduplicate by stable ID derived from content. For a clean slate, point at a fresh store file:

```bash
LINDELA_LITE_STORE=/tmp/fresh-store.json npm run demo:seed
LINDELA_LITE_STORE=/tmp/fresh-store.json npm start
```

The demo guide with the full walkthrough is in [docs/demo-guide.md](docs/demo-guide.md).

## One-Click Deployment

For the default production-like deployment, run:

```bash
./deploy/one-click.sh
```

This creates `.env` with local secrets, builds the Docker image, starts PostgreSQL, starts the app, waits for health, and initializes default public-source ingestion schedules. Periodic work runs inside the app process — ingestion, alert evaluation, outbox dispatch and report schedules — and records a heartbeat that `/api/v1/health` reports on, so there is no second container to watch.

See [docs/deployment.md](docs/deployment.md).

## Storage

Lindela Lite supports four storage modes:

- `auto` defaults to external Postgres when `LINDELA_LITE_DATABASE_URL` or `DATABASE_URL` is set, then tries local `pg0`, then falls back to JSON.
- `pg0` starts a local pg0 PostgreSQL instance and stores records in Postgres.
- `postgres` uses an external PostgreSQL database URL.
- `json` uses the original local JSON file store.

```bash
LINDELA_LITE_DB_MODE=pg0 npm start
LINDELA_LITE_DB_MODE=postgres LINDELA_LITE_DATABASE_URL=postgresql://user:pass@host:5432/db npm start
LINDELA_LITE_DB_MODE=json npm start
```

See [docs/storage.md](docs/storage.md).

## Sources

Built-in source ids:

| id | what it is | keyless? |
|---|---|---|
| `open_meteo` | forecast and historical precipitation and temperature | yes |
| `gdacs` | GDACS global disaster alerts | yes |
| `glofas` | Copernicus GloFAS river discharge | yes, **feed currently unverified** |
| `chirps` | CHIRPS blended rainfall, monthly | yes |
| `nasa_firms` | NASA FIRMS active fire detections | **no** — needs `NASA_FIRMS_MAP_KEY` |
| `usgs_earthquake` | USGS earthquake catalogue | yes |
| `noaa_enso` | NOAA CPC Niño 3.4 SST anomaly (ONI) | yes |
| `ipc_hdx` | IPC acute food insecurity phases (national + subnational, via HDX) | yes — CC0 |
| `who_gho` | WHO GHO outbreak indicators (cholera, meningitis, measles, yellow fever, plague; national-annual) | yes — attribution required |
| `gdacs_archive` | GDACS historical flood archive (1985 onward) — flood-probability training backfill | yes |
| `open_meteo_archive` | ERA5 reanalysis daily precipitation (1981 onward) — flood-probability training backfill; not gauge observations | yes — attribution required |
| `open_meteo_flood` | GloFAS v4 modelled daily river discharge (1984 onward where a reach exists) — discharge-label training backfill; not gauge observations | yes — attribution required |
| `open_meteo_forecast` | current conditions and 7-day daily forecast per pilot district — feeds the map weather overlay via `GET /api/v1/weather` | yes — attribution required |
| `reliefweb_epidemics` | ReliefWeb epidemic disaster events for the pilot countries — feeds the outbreak-map layer; keyless RSS (20 latest disasters worldwide, country-centroid placement) or the v2 API with subnational coordinates once a ReliefWeb-approved appname is set (`LINDELA_LITE_RELIEFWEB_APPNAME`) | yes, keyless RSS; v2 API needs a free approved appname |
| `dhis2` | DHIS2 data-quality aggregate | user-supplied instance |
| `service_assets` | imported roads, clinics, boreholes | — |
| `acled_csv` | ACLED-compatible conflict CSV, user-supplied | user licence |
| `conflict_csv` | Lite conflict schema CSV, user-supplied | user licence |

`GET /api/v1/sources` is the authority: it reports each source's credential requirement and the outcome of its last run. Two sources are **not** currently returning data, and the app says so rather than substituting something weaker:

- `glofas` — the published RSS URL now serves the EFAS web app, not a feed. No replacement endpoint has been confirmed, so no data is claimed.
- `nasa_firms` — FIRMS has no keyless access. Without a MAP_KEY it reports zero records and names the missing configuration.

`npm run check:live-sources` reports live status for every source with the reason for any failure.

## Operations

Lite includes a portable intervention-management layer for public-good response coordination:

- Create incidents from operator input or linked event/risk context.
- Track interventions, tasks, field reports, and response resources.
- Review action logs and operations summaries through the API and dashboard.
- Keep high-impact actions human-reviewed; Lite remains decision support, not an automated command system.

## RapidPro SMS

Set RapidPro environment variables to send alert events through RapidPro and receive field reports from RapidPro flows:

```bash
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=your-token
RAPIDPRO_ALERT_FLOW_UUID=your-alert-flow-uuid
RAPIDPRO_WEBHOOK_SECRET=shared-inbound-secret
npm start
```

- `POST /api/v1/rapidpro/alert-events/:id/send` sends an alert event to RapidPro.
- `POST /api/v1/rapidpro/field-report` receives RapidPro webhook payloads and creates field reports.
- `GET /api/v1/rapidpro/status`, `/dispatches`, and `/inbound` expose integration state and audit logs.

When RapidPro is not configured, the protocol executor records the `notify` action as **refused** with the reason and leaves the alert sendable by hand. This is deliberate: an unconfigured gateway is a deferred delivery, not a failed playbook step.

See [docs/rapidpro.md](docs/rapidpro.md).

## Reporting

Lite includes dependency-light reporting for operational products:

- Create reusable templates for SITREPs, incident briefs, intervention updates, data-quality reports, and alert digests.
- Generate deterministic report sections with source references and data-quality warnings.
- Preview reports in the dashboard and export Markdown or JSON.
- Record local, webhook, and RapidPro SMS-summary distribution runs.
- Schedule templates with explicit `run-due` execution for cron, systemd timers, GitHub Actions, or another deployment scheduler.

Every export prints what it refused and why, and carries a signature. See [docs/reporting-prd.md](docs/reporting-prd.md) for the full product requirements and implementation shape.

## Trigger protocols

Example downstream trigger configurations — the pre-authorised conditions that make the executor work — are in [examples/trigger-protocols](examples/trigger-protocols).

The executor itself is in `src/protocols.js`. See the module docblock for the design rationale, the shadow-versus-live distinction, and the audit-chain schema.

## API

Start with the [platform guide](docs/platform.md). The docs directory also includes focused guides for [architecture](docs/architecture.md), [data model](docs/data-model.md), [ingestion](docs/ingestion.md), [dashboard usage](docs/dashboard.md), [configuration](docs/configuration.md), [operations runbooks](docs/runbook.md), [developer workflows](docs/developer-guide.md), [API reference](docs/api.md), [OpenAPI](docs/openapi.yaml), and [service assets](docs/service-assets.md).

Public paths on the production deployment include `/api/v1/health`, `/api/v1/ready`, `/api/v1/climate`, `/api/v1/events`, `/api/v1/weather`, `/api/v1/river-discharge`, `/api/v1/flood-risk`, `/api/v1/conflict-risk`, `/api/v1/disease-observations`, `/api/v1/food-security`, `/api/v1/road-access`, `/api/v1/service-impacts`, `/api/v1/sources`, and `/api/v1/basemap/tiles`. Console surfaces require authentication.

## Open-Source Boundary

Lindela Lite is **MIT-licensed**. See [LICENSE](LICENSE).

Open in Lite:

- The server (`src/server.js`), one runtime dependency (`pg`), no framework, no build step
- All console surfaces (`public/`)
- Every connector (`src/connectors/`)
- The decision, execution and reporting engine, including `src/protocols.js`
- The map, the report templates, and the routing and flood-depth modules

Not open:

- Deployment configurations with credentials
- The demo dataset
- Lindela's commercial models, source-reliability scoring, intelligence fusion, wargaming, classified workflow, or enterprise orchestration
- The operational EASF platform at `easf.lindela.io`

Full split in [docs/open-source-boundary.md](docs/open-source-boundary.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security And Releases

See [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).
```