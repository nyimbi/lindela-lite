# Lindela Lite API

All endpoints return JSON unless otherwise noted. The default server is local and unauthenticated. Set `LINDELA_LITE_API_KEY` to require `x-api-key` on mutating endpoints.

## Endpoints

- `GET /api/v1/health` returns service status, storage mode, store counts, and available source ids.
- `GET /api/v1/sources` lists source capabilities and last source runs.
- `POST /api/v1/ingest/run` runs one or more ingestors.
- `GET /api/v1/events` returns hazard and conflict events.
- `GET /api/v1/climate` returns climate observations.
- `GET /api/v1/flood-risk` returns flood risk scores.
- `GET /api/v1/conflict-risk` returns climate-conflict risk scores.
- `GET /api/v1/service-assets` returns imported service assets.
- `POST /api/v1/service-assets` imports service assets from JSON, CSV, or GeoJSON.
- `GET /api/v1/service-impacts` returns service-delivery impact assessments.
- `GET /api/v1/assessments` returns a combined assessment package.
- `GET /api/v1/export.geojson` returns event and service features as GeoJSON.
- `GET /api/v1/export.csv` returns events as CSV.

## Common Filters

- `bbox=west,south,east,north`
- `country=KE`
- `source=gdacs`
- `event_type=flood`
- `severity=high`
- `from=2026-01-01`
- `to=2026-01-31`
- `limit=100`

## Ingestion Example

```json
{
  "sources": ["open_meteo", "gdacs", "glofas", "chirps", "nasa_firms"],
  "regions": [
    { "name": "Turkana", "lat": 3.1, "lon": 35.6, "country": "KE" }
  ]
}
```

`gdelt` is not a valid source id.

## OpenAPI

The OpenAPI 3.1 contract is available at [openapi.yaml](openapi.yaml).
