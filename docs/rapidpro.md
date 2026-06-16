# RapidPro Integration

Lindela Lite can use RapidPro for two SMS workflows:

- Send alert events to field teams through a RapidPro flow start or broadcast.
- Receive RapidPro webhook payloads and turn them into Lite field reports.

## Configuration

```bash
RAPIDPRO_BASE_URL=https://rapidpro.io
RAPIDPRO_API_TOKEN=your-rapidpro-api-token
RAPIDPRO_ALERT_FLOW_UUID=your-flow-uuid
RAPIDPRO_WEBHOOK_SECRET=shared-inbound-secret
```

Optional settings:

- `RAPIDPRO_ALERT_MODE=flow_start` or `broadcast`
- `RAPIDPRO_ALERT_URNS=+254700000000,+254711111111`
- `RAPIDPRO_ALERT_CONTACTS=contact-uuid-1,contact-uuid-2`
- `RAPIDPRO_ALERT_GROUPS=group-uuid-1`
- `RAPIDPRO_BASE_LANGUAGE=eng`

## Outbound Alert SMS

Evaluate alert rules, then dispatch an alert event:

```bash
curl -X POST http://127.0.0.1:4177/api/v1/rapidpro/alert-events/alert_123/send \
  -H 'content-type: application/json' \
  -d '{"urns":["+254700000000"],"mode":"flow_start"}'
```

`flow_start` mode posts to RapidPro `/api/v2/flow_starts.json` with `flow`, `urns`, `contacts`, `groups`, and `params`. Use this when the RapidPro flow controls the SMS copy, follow-up questions, routing, or acknowledgement behavior.

`broadcast` mode posts to RapidPro `/api/v2/broadcasts.json` with translated message text. Use this for direct one-way alert SMS.

Every attempt is stored in `/api/v1/rapidpro/dispatches` and action logs.

## Inbound Field Reports

Configure a RapidPro flow webhook to POST field updates to:

```text
https://<lindela-lite-host>/api/v1/rapidpro/field-report
```

When `RAPIDPRO_WEBHOOK_SECRET` is set, include it in one of:

- `x-rapidpro-secret: <secret>`
- `Authorization: Bearer <secret>`
- `?secret=<secret>`

If `LINDELA_LITE_API_KEY` is also enabled, a valid `RAPIDPRO_WEBHOOK_SECRET` is sufficient for this inbound webhook endpoint. Other mutating API endpoints still require `x-api-key`.

Accepted payload shape:

```json
{
  "id": "rapidpro-message-1",
  "from": "+254711111111",
  "content": "REPORT incident_abc123 Access blocked needs: fuel, water 3.12,35.63",
  "contact": { "uuid": "contact-1", "name": "Field Agent" },
  "run": { "uuid": "run-1" }
}
```

The parser recognizes:

- `incident_...` and `intervention_...` identifiers.
- `needs: fuel, water` style needs lists.
- `latitude,longitude` coordinates.

If no incident or intervention id is present, Lite creates a holding incident and attaches the field report to it. Inbound payloads are stored in `/api/v1/rapidpro/inbound`.

## Safety

RapidPro dispatches are operational actions. Use alert rules and dispatch logs for auditability, and keep human review for high-impact interventions.
