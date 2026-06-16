# Lindela Lite Operations

The operations layer turns risk and impact monitoring into portable response coordination records. It is intentionally lightweight: records can be exported, audited, and integrated into downstream systems without adding proprietary Lindela workflow internals.

## Core Records

- `incidents` capture operational situations that need monitoring or response.
- `interventions` capture response plans linked to an incident.
- `intervention_tasks` capture assigned work under an intervention.
- `field_reports` capture field updates, observed impact, and needs.
- `response_resources` capture supplies, teams, equipment, or other deployable capacity.
- `action_logs` capture create/update activity from mutating operational endpoints.
- `alert_rules` and `alert_events` provide lightweight, auditable trigger evaluation for downstream notification or ticketing systems.

## Typical Flow

1. Run ingestion and review `/api/v1/flood-risk`, `/api/v1/conflict-risk`, `/api/v1/service-impacts`, and `/api/v1/data-quality`.
2. Create an incident manually or with `linked_event_id` / `risk_score_id`.
3. Create one or more interventions against the incident.
4. Add tasks, field reports, and resources as response work progresses.
5. Create alert rules and evaluate them through `/api/v1/alerts/evaluate` when automated monitoring is needed.
6. Send alert events through RapidPro when SMS outreach is configured.
7. Receive RapidPro field-report webhooks as updates from field teams.
8. Review `/api/v1/operations/summary`, `/api/v1/alert-events`, `/api/v1/rapidpro/dispatches`, `/api/v1/rapidpro/inbound`, and `/api/v1/action-logs`.
9. Export snapshots through `/api/v1/export.geojson` or `/api/v1/export.csv`.

## Safety Notes

- Scores and confidence are decision-support signals, not automated determinations.
- Human review is still required for high-impact or resource-moving actions.
- Action logs are append-only through the public API; do not edit them manually except for local test fixtures.
- Lite does not include proprietary orchestration, source-reputation, report-distribution, AAR, or wargaming systems.
- Alert actions are declarative; Lite records intended actions but does not send external notifications by itself.
- RapidPro dispatch is the built-in SMS sending path; failed RapidPro requests are recorded as dispatch records for follow-up.
