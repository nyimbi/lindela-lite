# Service Asset Imports

Service assets represent facilities or infrastructure that may be affected by flood or climate-conflict risk.

## Required Fields

- `name`
- `service_type`: one of `health`, `water`, `road`, `school`, `power`, `telecom`, `market`, `other`
- `country`
- `latitude`
- `longitude`

Optional fields include `admin1`, `status`, `capacity`, `id`, and `updated_at`.

## JSON Import

```bash
curl -X POST http://127.0.0.1:4177/api/v1/service-assets \
  -H 'content-type: application/json' \
  -d '{"service_assets":[{"name":"Clinic A","service_type":"health","country":"KE","latitude":3.13,"longitude":35.63}]}'
```

## CSV Import

```csv
name,service_type,country,latitude,longitude,status
Clinic A,health,KE,3.13,35.63,open
Water Point 1,water,KE,3.11,35.61,unknown
```

Submit it as `service_assets_csv`.

## GeoJSON Import

Each feature must be a Point. Properties should include at least `name`, `service_type`, and `country`. Coordinates provide longitude and latitude.

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [35.63, 3.13] },
      "properties": { "name": "Clinic A", "service_type": "health", "country": "KE" }
    }
  ]
}
```

Validation errors return HTTP 400 with row-level messages.
