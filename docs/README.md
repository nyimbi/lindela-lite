# Lindela Lite Documentation

Start with [platform.md](platform.md) for the complete platform guide.

## Guides

- [Platform Guide](platform.md): architecture, workflows, configuration, deployment, operations, troubleshooting, and verification.
- [Architecture](architecture.md): runtime modules, request lifecycle, data flow, storage boundary, scheduling model, and extension points.
- [Data Model](data-model.md): collection reference, common fields, relationships, IDs, and timestamp ordering.
- [Ingestion](ingestion.md): source types, manual ingestion, schedules, retries, source health, and troubleshooting.
- [API Reference](api.md): endpoint list, common filters, and payload examples.
- [Dashboard](dashboard.md): operator dashboard usage, API key behavior, panels, refresh behavior, and security notes.
- [Configuration](configuration.md): environment variables, storage configuration, RapidPro settings, and Docker Compose variables.
- [One-Click Deployment](deployment.md): Docker Compose deployment, generated secrets, scheduler sidecar, updates, backups, and troubleshooting.
- [Operations Runbook](runbook.md): daily checks, incident response, scheduler checks, backups, updates, and release verification.
- [OpenAPI Contract](openapi.yaml): machine-readable OpenAPI 3.1 specification.
- [Storage](storage.md): JSON, pg0, and external PostgreSQL storage modes.
- [Operations](operations.md): incidents, interventions, tasks, field reports, resources, alerts, and action logs.
- [RapidPro](rapidpro.md): outbound SMS alerts/report summaries and inbound field-report webhooks.
- [Service Assets](service-assets.md): service asset JSON, CSV, and GeoJSON import formats.
- [Reporting PRD](reporting-prd.md): reporting product requirements and implementation plan.
- [Developer Guide](developer-guide.md): local setup, extension workflows, testing, and documentation maintenance.
- [Open-Source Boundary](open-source-boundary.md): what is included in Lite and what remains outside it.

## Common Entry Points

- Run the server: `npm start`
- Validate docs/contracts: `npm run validate`
- Run tests: `npm test`
- Dashboard: `http://127.0.0.1:4177`
- Health: `GET /api/v1/health`
- Source health: `GET /api/v1/ingest/status`
- Combined assessment: `GET /api/v1/assessments`
