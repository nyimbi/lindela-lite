# Lindela Lite

Lindela Lite is a standalone, open-source climate-conflict and flood-impact toolkit. It ingests selected public data sources, normalizes them into simple schemas, computes transparent baseline risk scores, exposes formatted data through an API, and provides a lightweight dashboard.

This package is intentionally separate from the full Lindela platform. It does not include Lindela's proprietary fusion, source reliability, calibrated prediction, report management, wargaming, classified workflow, or enterprise orchestration systems.

## What It Does

- Ingests public climate, disaster, flood, fire, and service-asset data.
- Supports optional conflict-event imports through user-supplied ACLED-compatible CSV or the Lite conflict schema.
- Computes baseline flood risk, climate-conflict risk, and service-delivery impact scores.
- Serves formatted JSON, GeoJSON, and CSV through `/api/v1/*` endpoints.
- Provides a local dashboard at `/`.

## What It Does Not Do

- It does not ingest GDELT.
- It does not copy or depend on WorldMonitor code.
- It does not include Lindela's commercial models, calibrated coefficients, intelligence fusion, report distribution, AAR, or wargaming systems.

## Run

```bash
npm test
npm start
```

The server listens on `LINDELA_LITE_PORT` or `4177`.

```bash
curl http://127.0.0.1:4177/api/v1/health
curl -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' \
  -d '{"sources":["open_meteo","gdacs"],"regions":[{"name":"Turkana","lat":3.1,"lon":35.6,"country":"KE"}]}'
```

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

- `open_meteo`
- `gdacs`
- `glofas`
- `chirps`
- `nasa_firms`
- `service_assets`
- `acled_csv`
- `conflict_csv`

The registry rejects `gdelt` to keep this package aligned with the open-source boundary.

## API

See [docs/api.md](docs/api.md).

## Open-Source Boundary

See [docs/open-source-boundary.md](docs/open-source-boundary.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Trigger Protocol Examples

Example downstream trigger configurations are in [examples/trigger-protocols](examples/trigger-protocols).
