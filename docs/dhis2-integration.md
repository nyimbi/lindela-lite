# DHIS2 Integration

The `dhis2` connector in `src/connectors/dhis2.js` is a **scaffold**. It registers correctly in the ingestion pipeline and returns a documented error when `base_url` is not configured. No real network calls are made unless `LINDELA_LITE_DHIS2_ENABLED=on` is set.

## Inbound direction (DHIS2 to Lindela)

Configure in the Operator Console under Settings > DHIS2 sync scaffold:

| Field | Description |
|---|---|
| Base URL | Root URL of your DHIS2 instance (e.g. `https://play.dhis2.org/40.2.2`) |
| API token | Personal access token from DHIS2 user profile |
| Org units | DHIS2 org unit UIDs, one per line |
| Data elements | Data element UIDs to pull, one per line |
| Period | DHIS2 period notation (e.g. `2026Q3`) |

Settings are stored in browser `localStorage` only. They are never sent to the backend unless you click "Test connection", which calls `POST /api/v1/ingest/run` with `sources: ['dhis2']`.

To activate real ingestion:
1. Set `LINDELA_LITE_DHIS2_ENABLED=on` in the server environment.
2. Pass `base_url` and `api_token` in the ingestion request body.
3. Implement the fetch logic in `src/connectors/dhis2.js` `dhis2Ingest` function.

## Outbound direction (Lindela to DHIS2)

Every workflow state transition emits an event via `src/outbox.js`. Any `workflow.transitioned` event can be routed to a DHIS2 webhook subscription:

```json
{
  "url": "https://your-dhis2/api/dataValueSets",
  "events": ["workflow.transitioned"],
  "headers": { "Authorization": "ApiToken <token>" }
}
```

Register via `POST /api/v1/webhooks`. Lindela will POST the event payload to DHIS2 on each transition. The outbound payload format matches the Lindela outbox schema; a DHIS2-specific transformer is left for the implementer.

## Data mapping guidance

| Lindela collection | DHIS2 concept |
|---|---|
| `climate_observations` | Data values on climate data elements |
| `hazard_events` | Events in a program stage |
| `field_reports` | Events or tracked entity instances |
| `interventions` | Program stages with status attributes |

Full data-element mapping requires coordination with the country DHIS2 administrator.
