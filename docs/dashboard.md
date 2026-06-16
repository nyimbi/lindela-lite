# Lindela Lite Dashboard Guide

This guide describes the operator dashboard served at `/`.

## Opening The Dashboard

Start the server:

```bash
npm start
```

Open:

```text
http://127.0.0.1:4177
```

The dashboard is a static interface backed by `/api/v1/*`. It does not require a frontend build process.

## API Key Field

If `LINDELA_LITE_API_KEY` is configured, read-only panels still load without a key, but mutating actions require the key.

Paste the key into the top-bar API key field. The dashboard stores it in browser local storage and sends it as `x-api-key` for mutating requests.

Actions that need the key include:

- Run selected sources.
- Create public schedules.
- Run due sources.
- Import service assets.
- Create incidents, interventions, tasks, and alert rules.
- Evaluate alerts.
- Send RapidPro alerts.
- Create, generate, approve, distribute, and schedule reports.

## Dashboard Areas

### Ingestion

Use this panel to:

- Set region, country, latitude, and longitude.
- Select public source connectors.
- Run selected sources.
- Create default public-source schedules.
- Run due ingestion schedules.

After ingestion, review:

- Source Freshness
- Data Quality
- Flood Risk
- Climate-Conflict Risk
- Recent Events
- GeoJSON Viewer

### Service Assets

Paste CSV or GeoJSON service assets and import them.

Required fields:

- `service_type`
- `country`
- `latitude`
- `longitude`

Service assets are included in service-impact assessments and map rendering.

### Operations

Use this panel to create:

- Incidents
- Interventions
- Tasks
- Alert rules

The panel is intentionally compact. For full operational records and updates, use the API reference in [api.md](api.md).

### RapidPro

The dashboard shows:

- RapidPro configuration status.
- Dispatch history.
- Inbound field-report messages.

To send an alert through RapidPro:

1. Create or evaluate an alert rule so an open alert event exists.
2. Enter RapidPro URNs.
3. Click `Send Latest Alert`.

### Reporting

Use the reporting panel to:

- Create a report template.
- Generate a report.
- Approve the latest report.
- Prepare a Markdown export.
- Create a report schedule.
- Run due report schedules.

The report preview renders Markdown text safely in a `<pre>` block. Report list tables show generated reports, templates, schedules, and distribution runs.

### GeoJSON Viewer

The viewer plots geocoded records from:

- Flood risk
- Climate-conflict risk
- Events
- Service assets
- Incidents
- Field reports
- Response resources

Pins are approximate and meant for quick inspection, not precision GIS work. Use `/api/v1/export.geojson` for GIS tools.

## Refresh Behavior

The dashboard does not use websockets. Click `Refresh` after API calls made outside the dashboard.

Most dashboard actions refresh automatically after successful completion.

## Empty Dashboard Checklist

If panels are empty:

1. Run selected sources.
2. Import service assets.
3. Click Refresh.
4. Check `/api/v1/health`.
5. Check `/api/v1/ingest/status`.
6. Check whether an API key is required for the action you attempted.

## Security Notes

- Do not use the dashboard API-key field on shared browsers.
- Use HTTPS when exposing the dashboard outside localhost.
- Put the app behind an access-controlled reverse proxy for multi-user deployments.
- Do not paste sensitive field-report payloads into public demos.

