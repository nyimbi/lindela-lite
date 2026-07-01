# Lindela Lite Connector SDK

Build pluggable data connectors for Lindela Lite following the `ConnectorSpec` pattern.

## Overview

A connector is an async function that fetches data from an external source and returns structured records. The SDK validates connectors and maintains a registry for discovery.

## Creating a Connector

Import `defineConnector`:

```javascript
import { defineConnector } from '../connectors/spec.js'

async function myConnectorIngest(options = {}) {
  const climate_observations = []
  const errors = []
  
  try {
    // Fetch and parse data
    const data = await fetch('...')
    // Transform to records
    climate_observations.push({ id: '...', latitude: 3.1, longitude: 35.6, ... })
  } catch (error) {
    errors.push(error.message)
  }
  
  return { climate_observations, errors }
}

export const spec = defineConnector({
  id: 'my_connector',
  description: 'Fetches data from MyAPI',
  schema: {
    requestSchema: {
      regions: 'array of {name, country, lat, lon}',
      timeout_ms: 'number',
    },
    outputSchema: ['climate_observations'],
  },
  defaults: {
    rateLimit: { perMinute: 60 },
    retry: { max: 2, backoffMs: 1000 },
    timeout_ms: 20000,
  },
  ingest: myConnectorIngest,
})

// Keep for backward compatibility
export const myConnector = {
  id: 'my_connector',
  ingest: myConnectorIngest,
}
```

## ConnectorSpec

```javascript
{
  id: string                  // Unique identifier (snake_case)
  description: string         // Brief description
  schema: object              // JSON schema-ish docs
    requestSchema: object     // Input parameter docs
    outputSchema: array       // Output collection names
  defaults: object            // Runtime defaults
    rateLimit: object         // Rate limits
    retry: object             // Retry strategy
    timeout_ms: number        // Default timeout
  ingest: async function      // Async ingest function
}
```

## Output Collections

Connectors return one or more output collections:

- `climate_observations` — weather forecasts, temperature, precipitation
- `hazard_events` — floods, earthquakes, fires, droughts
- `conflict_events` — violence, protests, communal tensions
- `service_assets` — health facilities, water points, schools

All records must include `id`, `latitude` and `longitude` if spatial (optional for non-spatial data).

## Error Handling

Return `errors` array alongside successful records:

```javascript
return {
  climate_observations: [...],
  errors: [
    'Region A: API timeout',
    'Region B: Malformed JSON',
  ]
}
```

Ingestion still completes with degraded status if records meet minimum thresholds.

## Registering a Connector

Update `connectors.registry.json` at the repo root:

```json
{
  "id": "my_connector",
  "module": "src/connectors/my-connector.js",
  "description": "My data source",
  "schemas": {
    "input": { "regions": "array of objects" },
    "output": ["climate_observations"]
  },
  "defaults": {
    "rateLimit": {"perMinute": 60},
    "retry": {"max": 2, "backoffMs": 1000},
    "timeout_ms": 20000
  },
  "tags": ["climate", "forecast"],
  "contributor": "core",
  "since": "0.1.0"
}
```

## Discovery

List all connectors with runtime status:

```bash
curl http://localhost:4177/api/v1/connectors
```

Response includes last run, current status, and schema docs per connector.

## Validating Specs

Use `validateConnector(spec)` to check a spec before release:

```javascript
import { validateConnector } from '../connectors/spec.js'

const errors = validateConnector(spec)
if (errors.length) {
  console.error('Invalid connector:', errors)
}
```

## Backward Compatibility

Keep the old named export alongside the new `spec`:

```javascript
// Old (still works)
export const myConnector = { id: '...', ingest: ... }

// New
export const spec = defineConnector({ ... })
```

This ensures existing code using `getConnector('my_connector')` continues to work.
