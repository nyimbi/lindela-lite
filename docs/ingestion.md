# Lindela Lite Ingestion Guide

This guide explains how Lindela Lite ingests public/open-source data and user-supplied data, how schedules work, how failures are recorded, and how operators should monitor source health.

## Source Types

Lite has two source categories.

Regular public/open-source sources:

- `open_meteo`
- `gdacs`
- `glofas`
- `chirps`
- `nasa_firms`
- `usgs_earthquake`
- `noaa_enso`
- `ipc_hdx`
- `who_gho`

User-supplied sources:

- `service_assets`
- `conflict_csv`
- `acled_csv`
- `dhis2`

`gdelt` is intentionally excluded.

### Sources That Need Configuration

`nasa_firms` is **not** keyless. FIRMS requires a free MAP_KEY delivered by
email from `firms.modaps.eosdis.nasa.gov/api/map_key`. Set `NASA_FIRMS_MAP_KEY`
and the source works; leave it unset and the connector reports an error and zero
records rather than sending a placeholder key and reporting HTTP 400s. The
source catalog marks it `requires_credentials: true` so this is visible before
an operator runs anything.

### Verifying Sources Against Live Upstreams

Fixtures describe what the code expects, not what a provider actually serves.
Three connectors reported success while ingesting nothing, and no fixture test
caught any of them:

| Source | Failure | Why fixtures missed it |
|---|---|---|
| `chirps` | Product index moved to year subdirectories, so the filename pattern matched zero times | The fixture encoded the old flat layout, confirming the bug |
| `glofas` | Published RSS URL served the EFAS web app; parse found no items | Fixture was valid RSS, and the parse of valid RSS was correct |
| `nasa_firms` | No keyless access; placeholder key returned HTTP 400 per region | Fixture supplied its own body, bypassing the key check |

`npm run check:live-sources` probes every public source against its real
upstream and reports records, errors, and timing. Pass `--strict` to exit
non-zero when any source errors or returns nothing.

```
npm run check:live-sources
```

It runs on a daily CI schedule (not every push — it depends on third parties
being reachable and on their rate limits) and is non-strict there, so an
upstream outage is reported without blocking commits.

A run distinguishes three states: **ok** (records returned), **error** (the
connector said so), and **empty** (records expected, none returned, no error).
That last one is the dangerous state and the reason this script exists.

### Seasonal Context: `noaa_enso`

NOAA CPC Niño 3.4 SST anomaly index, from a keyless fixed-width ASCII feed
verified live on 2026-10-01:
`https://www.cpc.ncep.noaa.gov/data/indices/detrend.nino34.ascii.txt`

Emits `climate_observations` with the anomaly in °C. Three behaviours are
deliberate and worth knowing before using the output:

- **Coordinates are `null`.** Niño 3.4 is a basin-wide equatorial Pacific
  index. The nearest-region assignment that other climate connectors use would
  make a global signal look like a district reading.
- **`episode_declared` requires five consecutive overlapping three-month
  seasons** at ±0.5 °C, per CPC's published definition. `overlapping_seasons`
  reports the count out of five, and `advisory_run_months` counts consecutive
  months on one side of the threshold. One warm month is not an ENSO event.
  Runs break at any gap in the series, so a feed that skips months cannot
  manufacture an episode out of two unrelated warm periods.
- **The field is the ONI, not the RONI.** Per NWS Public Information Statement
  26-05, CPC now uses the Relative Oceanic Niño Index for official ENSO
  monitoring, but RONI has no stable keyless monthly feed. Each record carries
  `index_used: 'ONI'` and an `index_note` rather than mislabelling the data.

This is a monthly SST anomaly index. It is not a rainfall forecast and not a
flood probability, and nothing downstream treats it as one.

### Food Security: `ipc_hdx`

IPC Acute Food Insecurity classifications, published through the Humanitarian
Data Exchange (keyless, CC0 / public domain, verified live 2026-10-02). This
supersedes the earlier scoping that concluded IPC needed a FAO/WFP licence:
HDX carries the same classifications, including the subnational area CSV the
licence-gated channels were wanted for.

Emits `food_security_records`, one record per area and validity window, with
every phase's published population in a `phases` map and the Phase 3+ figure
lifted to `phase3plus_number` / `phase3plus_fraction`. Default scope is all
Sub-Saharan Africa (`countries: 'all'` widens further).

- **Relayed, not re-derived.** IPC is an analytical classification by National
  IPC Technical Working Groups. A home-grown phase number would carry
  triggering consequences under famine and anticipatory-action policy that no
  protocol of this platform stands behind.
- **Fractions, not percent.** The source `Percentage` column is a fraction of
  the analysed population: `0.2` means 20%. Every record says so.
- **Bbox-only geometry.** Area polygons come from per-country GeoJSON
  resources; only the bounding box is stored, and it includes neighbouring
  ground the classification does not cover. Coordinates stay `null`.
- **Validation windows are labelled** (`current`, `first_projection`,
  `second_projection`); projections are IPC's, not forecasts by this platform.

### Outbreak Context: `who_gho`

WHO Global Health Observatory outbreak-relevant indicators (cholera, meningitis,
measles, yellow fever, plague), keyless OData, verified live 2026-10-02.

Emits `disease_observations` as national-annual aggregates. Deliberate limits:

- **Not district evidence.** The source reports COUNTRY/YEAR; the platform
  works at district level. Records carry `coordinates: null` and say so.
- **Staleness is labelled, not hidden.** Series stop publishing (cholera ends
  2016, verified). The API summary marks each indicator `current` / `aging` /
  `stale` against the calendar; a stale series is a data fact, not a disease fact.
- **No derived rates.** No denominators or reporting-quality metadata are
  available, so no trends or incidence rates are computed.
- **Policy note on every record:** outbreak figures can move funding and
  stigmatise areas; decision-support context with attribution, not an alert trigger.

### Flood Archive Backfill: `gdacs_archive`

GDACS historical flood events via the event-search archive API, keyless,
verified live 2026-10-02. Backfill source for flood-probability training; the
live `gdacs` feed reaches back weeks, models need decades.

Emits `hazard_events` (1985 onward, Sub-Saharan Africa scope, same country
set as the IPC ingestion). Deliberate behaviour:

- **Quarter-by-quarter walk.** A full-range archive query returns only the
  most recent ~100 events, so the connector asks for one quarter at a
  time and pages across ~160 windows. Slow by design; run on demand,
  never on the regular schedule — do not re-crawl 40 years of a free
  service hourly. Pass `archive_start_year` to narrow the walk.
- **The upstream `eventtype` filter is ignored by the API** (verified:
  `eventtype=FL` returns droughts, cyclones, earthquakes too). The flood
  filter runs in this process, visible in review.
- **Severity is null.** GDACS publishes flood `severitydata` as a fill-in
  zero ("Magnitude 0.00"). Stored as null — a placeholder zero is not a
  measurement.
- **Event points are representative**, not observed flood locations; the
  metadata says so, because downstream district matching runs on them.

### Rainfall Archive Backfill: `open_meteo_archive`

ERA5 reanalysis daily precipitation via the Open-Meteo archive API, keyless,
verified live 2026-10-02, series from 1981. Backfill source for
flood-probability training.

Emits `climate_observations` — exactly one record per region carrying the
whole daily array (`daily: [{date, precipitation_mm}]`). Null days are
preserved as nulls, never zero-filled; a model reading gaps must treat them
as unknown. Limits stated on every record:

- **Reanalysis, not gauge observations** — in data-sparse regions ERA5 is
  partially model-informed.
- **A single point** cannot resolve district drainage or orography.
- **The series ends at the archive's last complete day**; staleness is
  stated, not hidden.

Retraining the flood-probability model (`POST /api/v1/flood-probability/train`)
reads these records plus GDACS flood events from the store; see
`docs/flood-probability-model-basis.md`. Both backfills are `regular: false`
and are excluded from default ingestion runs — request them explicitly:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -d '{"sources": ["gdacs_archive", "open_meteo_archive"]}'
```

### River Discharge Backfill: `open_meteo_flood`

GloFAS v4 modelled daily river discharge via the Open-Meteo flood API
(`flood-api.open-meteo.com/v1/flood`), keyless, verified live 2026-10-02.
Backfill source for the discharge-labelled flood-probability variant
(`label_source: 'glofas_discharge'`), which exists because the GDACS
reported-flood label is too sparse to train on at the pilot districts.

Emits `climate_observations` — one record per region **that has a GloFAS
river reach at or under its reference point**, carrying the whole daily
array (`daily: [{date, river_discharge_m3s}]`). Regions without a reach
return null discharge every day and are refused as explicit ingestion
errors, never stored as records of zeros. Limits stated on every record:

- **Modelled hydrology, not gauge measurements** — GloFAS v4, consolidated
  reanalysis to July 2022, seamlessly continued by the operational run.
- **A cell without a reach is a refusal** — the Mogadishu pilot point has
  no GloFAS reach at all (verified 2026-10-02: 15 616 days of null), while
  the Turkana point (non-null daily discharge from 1997-01-01) and the Juba
  point (4.8594, 31.5713, White Nile) do.
- Values before the first valid day are absent reach coverage, not zero flow.

Same backfill policy — `regular: false`, on demand, never on a default run;

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -d '{"sources": ["open_meteo_flood"]}'
```

## Connector Responsibilities

Each connector returns normalized records grouped by collection:

```json
{
  "climate_observations": [],
  "hazard_events": [],
  "conflict_events": [],
  "service_assets": [],
  "errors": []
}
```

Connectors should:

- Parse one source.
- Normalize source data to Lite fields.
- Preserve useful source metadata.
- Return partial records plus errors when partial success is possible.
- Throw only when the connector cannot produce a meaningful result.

The ingestion runner records status, attempts, timeout, retries, record counts, and errors in `source_runs`.

## Manual Ingestion

Run public sources:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{
    "sources": ["open_meteo", "gdacs", "glofas", "chirps", "nasa_firms"],
    "regions": [
      { "name": "Turkana", "country": "KE", "lat": 3.1, "lon": 35.6 }
    ]
  }'
```

Run user-supplied conflict data:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{
    "sources": ["conflict_csv"],
    "conflict_csv": "event_date,event_type,latitude,longitude,country,fatalities,title\n2026-01-01,resource_tension,3.11,35.61,KE,0,Water access tension\n"
  }'
```

Run service assets:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/service-assets \
  -H 'content-type: application/json' \
  -d '{
    "service_assets": [
      {
        "name": "Clinic A",
        "service_type": "health",
        "country": "KE",
        "latitude": 3.13,
        "longitude": 35.63
      }
    ]
  }'
```

## Source Policies

Regular sources have default policies in `src/ingestion.js`:

| Source | Default interval | Timeout | Retries | Freshness |
| --- | ---: | ---: | ---: | ---: |
| `open_meteo` | 180 min | 20 sec | 2 | 360 min |
| `gdacs` | 60 min | 20 sec | 2 | 180 min |
| `glofas` | 180 min | 20 sec | 2 | 360 min |
| `chirps` | 720 min | 20 sec | 2 | 1440 min |
| `nasa_firms` | 360 min | 30 sec | 2 | 720 min |
| `usgs_earthquake` | 60 min | 20 sec | 2 | 180 min |
| `noaa_enso` | 720 min | 20 sec | 2 | 1440 min |
| `ipc_hdx` | 1440 min | 30 sec | 2 | 2880 min |
| `who_gho` | 1440 min | 20 sec | 2 | 20160 min |
| `open_meteo_forecast` | 180 min | 20 sec | 2 | 360 min |
| `reliefweb_epidemics` | 360 min | 20 sec | 2 | 720 min |
| `gdacs_archive` | 0 min | 30 sec | 2 | 43200 min |
| `open_meteo_archive` | 0 min | 60 sec | 2 | 43200 min |
| `open_meteo_flood` | 0 min | 60 sec | 2 | 43200 min |

User-supplied sources do not have regular schedules by default. `dhis2` has a
policy but `regular: false`, because activation depends on an operator
uploading entitlement they hold. `gdacs_archive`, `open_meteo_archive`, and `open_meteo_flood`
are also `regular: false` and carry a `0 min` interval on purpose: they are
historical backfills for flood-probability training, run on demand, and an
interval of 0 means no `next_run_at` is ever computed for them; DHIS2 needs
an instance URL and token configured before it activates.

### Minimum Records

Every regular source declares `minimum_records: 1`. A run returning fewer
records than that is recorded as `degraded` with an explanatory error, not
`success`.

This is load-bearing. Three connectors reported success while ingesting nothing
partly because their floor was `0`, which made an empty parse indistinguishable
from a healthy run. Verified 2026-10-01 across repeated live runs: `gdacs`
returns 222 and `usgs_earthquake` 46, so a zero result means something broke.

User-supplied sources keep `minimum_records: 0` on purpose. Uploading an empty
CSV is a legitimate operator action; an empty ingest of a live feed is not.
Holding the two to the same floor would make empty uploads look broken.

## Run Status

`source_runs.status` can be:

| Status | Meaning |
| --- | --- |
| `success` | Connector completed and met minimum record expectations. |
| `degraded` | Connector completed but returned errors or fewer records than expected. |
| `failed` | Connector threw an error after retries. |

Use `diagnostics` to inspect:

- `attempts`
- `timeout_ms`
- `retries`
- `interval_minutes`
- `stale_after_minutes`
- `duration_ms`
- `records_by_collection`
- `error_count`

## Regular Ingestion Schedules

Create default schedules:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/defaults
```

Create one custom schedule:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules \
  -H 'content-type: application/json' \
  -d '{
    "source": "gdacs",
    "interval_minutes": 60,
    "timeout_ms": 20000,
    "retries": 2,
    "next_run_at": "2026-05-19T04:00:00.000Z"
  }'
```

Run due schedules:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run-due
```

Run one schedule immediately:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/schedules/ingestion_schedule_.../run
```

Pause a schedule:

```bash
curl -X PATCH http://127.0.0.1:4177/api/v1/ingest/schedules/ingestion_schedule_... \
  -H 'content-type: application/json' \
  -d '{"status":"paused"}'
```

## Source Health

Inspect source health:

```bash
curl http://127.0.0.1:4177/api/v1/ingest/status
```

Health values:

| Health | Meaning |
| --- | --- |
| `never_run` | No run has been recorded for the source. |
| `fresh` | Latest run succeeded and is within freshness policy. |
| `stale` | Latest successful/degraded run is older than freshness policy. |
| `degraded` | Latest run completed with errors or low record count. |
| `failed` | Latest run failed. |

The health response includes:

- `last_run`
- `last_success`
- `failure_streak`
- `schedule`
- `policy`

## Analytics Refresh

The API refreshes analytics after ingestion endpoints:

- `POST /api/v1/ingest/run`
- `POST /api/v1/ingest/run-due`
- `POST /api/v1/ingest/schedules/:id/run`
- `POST /api/v1/service-assets`

Analytics outputs:

- `risk_scores`
- `impact_assessments`
- `data_quality`

## Deployment Scheduler

Lite intentionally does not hide a background scheduler inside the app process.

Recommended scheduler call:

```bash
curl -fsS -X POST http://127.0.0.1:4177/api/v1/ingest/run-due
```

With API key:

```bash
curl -fsS -X POST http://127.0.0.1:4177/api/v1/ingest/run-due \
  -H "x-api-key: $LINDELA_LITE_API_KEY"
```

The one-click stack runs this from the in-process periodic driver. The endpoint stays callable for deployments that would rather trigger it from cron or a CI job — but not in addition to the driver, which would run every due schedule twice per interval.

## Troubleshooting

### Source Is `never_run`

Run the source manually and inspect the response:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["gdacs"]}'
```

### Source Is `failed`

Check:

- Network access from the host/container.
- Source URL configuration.
- `source_runs[].errors`.
- `source_runs[].diagnostics.attempts`.
- Whether timeout is too short.

### Source Is `degraded`

Check:

- Partial connector errors.
- Minimum record expectations.
- Whether the source legitimately has no current records.
- Whether region or bbox filters are too narrow.

### Source Is `stale`

Check:

- Schedule `status`.
- Schedule `next_run_at`.
- The heartbeat on `GET /api/v1/ready`, and the app log for an item that threw.
- Cron/CI logs, if an external scheduler is what is calling the endpoint.
- API key header on scheduler calls.

### Service Asset Import Fails

Service assets require:

- `service_type`
- `country`
- `latitude`
- `longitude`

See [service-assets.md](service-assets.md).

