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

User-supplied sources:

- `service_assets`
- `conflict_csv`
- `acled_csv`

`gdelt` is intentionally excluded.

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

User-supplied sources do not have regular schedules by default.

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

The one-click Docker Compose stack includes a scheduler sidecar that calls this endpoint.

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
- Scheduler sidecar/cron logs.
- API key header on scheduler calls.

### Service Asset Import Fails

Service assets require:

- `service_type`
- `country`
- `latitude`
- `longitude`

See [service-assets.md](service-assets.md).

