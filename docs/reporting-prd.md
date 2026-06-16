# PRD: Lindela Lite Reporting

## Summary

Lindela Lite needs a reporting capability that lets operators create, display, distribute, and schedule decision-support reports from the platform's climate, conflict, disaster, intervention, alert, RapidPro, and service-impact data.

The reporting capability should turn raw API outputs into reusable operational products: situation reports, incident briefs, intervention updates, source-quality summaries, and scheduled digests. It must preserve the Lite boundary by remaining transparent, portable, and auditable. It should not recreate proprietary Lindela report-management, classified distribution, AAR, wargaming, or enterprise workflow systems.

## Problem

Lindela Lite now ingests risk and operational data, evaluates alerts, sends RapidPro SMS alerts, and receives field reports. Users can inspect and export records, but they cannot yet package those records into a structured report with narrative context, charts/tables/maps, recurrence, recipients, distribution history, and approval state.

This creates several operational gaps:

- Teams cannot generate a repeatable SITREP from the same template every day.
- Intervention leads cannot attach a report to a specific incident or response plan.
- RapidPro and field-report activity is visible as records, but not summarized into stakeholder-ready updates.
- Exports are raw data snapshots, not authored operational reports.
- There is no schedule, audit trail, or distribution log for reports.

## Goals

- Let users create reusable report templates for common humanitarian and operational workflows.
- Let users create report instances from live platform data and manual narrative sections.
- Display reports in the dashboard with clear sections, data lineage, timestamps, and status.
- Export reports in portable formats suitable for email, printing, sharing, and downstream integration.
- Distribute reports to configured recipients through local download, webhook, email-compatible payloads, and RapidPro/SMS summary alerts.
- Schedule recurring reports with auditable run history.
- Keep all generated content explainable, editable, and attributable to source records.

## Non-Goals

- No proprietary full Lindela reporting system.
- No classified workflow, enterprise report distribution, wargaming, or formal AAR automation.
- No hidden model-generated conclusions without evidence.
- No automated high-impact decision execution from reports.
- No new external dependency unless explicitly approved.

## Users

### Operations Lead

Needs an incident or area SITREP that summarizes risks, open incidents, response status, resources, and field updates.

### Field Coordinator

Needs to review incoming RapidPro field reports and produce a concise update for partners.

### Program Manager

Needs scheduled weekly intervention reports showing open tasks, service impacts, outcomes, and unresolved blockers.

### Data/Monitoring Officer

Needs source freshness, confidence, alert activity, and audit logs packaged into a quality and monitoring report.

### External Partner

Receives a controlled report or short SMS summary, not full platform access.

## Report Types

### Situation Report

Purpose: summarize current climate, conflict, disaster, and operational state for a geography.

Default sections:

- Executive summary
- Current risk posture
- Recent hazard and conflict events
- Open incidents
- Active interventions
- Service impacts
- RapidPro field reports
- Alert events
- Recommended next actions
- Data quality and source freshness

### Incident Brief

Purpose: produce a focused report for one incident.

Default sections:

- Incident overview
- Timeline
- Linked events and risk drivers
- Field reports
- Interventions and tasks
- Resources deployed or reserved
- Alert and RapidPro dispatch history
- Open decisions and next actions

### Intervention Update

Purpose: report progress on one intervention.

Default sections:

- Objective and status
- Task progress
- Resource status
- Field updates
- Impacted service assets
- Risks and blockers
- Outcome metrics

### Data Quality Report

Purpose: communicate reliability and freshness of the data behind operational decisions.

Default sections:

- Source freshness
- Data-quality confidence summaries
- Failed/degraded source runs
- Geocoding coverage
- Record counts
- Known gaps and caveats

### Alert Digest

Purpose: summarize alert rules, alert events, acknowledgements, and dispatches.

Default sections:

- Triggered alerts
- Severity breakdown
- Alert status
- RapidPro dispatch status
- Pending acknowledgement
- Suppression summary

## Core Workflows

### Create A Report Template

1. User chooses a report type.
2. User names the template and selects default filters.
3. User selects sections from an allowed section library.
4. User configures distribution channels and optional schedule.
5. System stores the template as a versioned record.

### Generate A Report

1. User selects a template or starts from a blank report.
2. User sets scope: country, bbox, incident, intervention, service type, date range, severity, status, or source.
3. System resolves source records.
4. System generates report sections from deterministic summaries.
5. User edits narrative fields and marks caveats.
6. User previews the report.
7. User saves as draft, approves, distributes, or schedules.

### Display A Report

1. User opens the report list.
2. User filters by type, status, scope, owner, date, or schedule.
3. User opens a report detail page.
4. System displays report sections, source-record links, generated timestamps, distribution history, and export actions.

### Distribute A Report

1. User chooses distribution channel.
2. System validates recipients and report status.
3. System creates a distribution run.
4. System sends or prepares channel-specific payloads.
5. System records success/failure, response status, and retry hints.

Supported MVP channels:

- Local HTML preview
- JSON report payload
- CSV/GeoJSON data appendix
- Downloadable Markdown report
- Webhook POST
- RapidPro SMS summary linked to a full report URL or report ID

Future channels:

- PDF export
- Email SMTP
- Google Drive/Docs
- Signed public report link

### Schedule A Report

1. User selects a template and recurrence.
2. User configures timezone, start date, and optional end date.
3. User chooses whether scheduled reports are draft-only or auto-distributed.
4. Scheduler creates report runs when due.
5. System records run status, generated report ID, and distribution results.

## Functional Requirements

### Report Templates

- Users can create, list, view, update, pause, and archive report templates.
- Templates include report type, default title pattern, filters, sections, distribution defaults, schedule defaults, and owner.
- Templates are versioned when materially changed.
- Templates can be copied.

### Report Instances

- Users can create reports from templates or from scratch.
- Reports have statuses: `draft`, `ready`, `approved`, `distributed`, `archived`.
- Reports include generated sections and editable narrative sections.
- Reports store source-record references for traceability.
- Reports store generated timestamps and data freshness warnings.
- Reports can be regenerated while in draft.
- Approved or distributed reports are immutable except for archival metadata.

### Section Library

The system provides deterministic section builders:

- `executive_summary`
- `risk_summary`
- `events_summary`
- `incident_summary`
- `intervention_summary`
- `service_impact_summary`
- `field_report_summary`
- `rapidpro_activity_summary`
- `alert_summary`
- `data_quality_summary`
- `recommended_actions`
- `appendix_sources`

Each section has:

- `id`
- `title`
- `type`
- `content`
- `source_refs`
- `generated_at`
- `warnings`

### Filters And Scope

Reports support filters already used elsewhere in Lite:

- `country`
- `bbox`
- `from`
- `to`
- `source`
- `severity`
- `status`
- `priority`
- `incident_id`
- `intervention_id`
- `service_type`

### Display

- Dashboard includes a report list, template list, report detail view, preview pane, and distribution history.
- Report detail shows status, owner, scope, generated time, source freshness, and warnings.
- Section source references are inspectable.
- Long sections can be collapsed.
- Report text must remain readable on mobile and desktop.

### Distribution

- Users can distribute a report only when it is `ready` or `approved`.
- Each distribution creates a distribution run record.
- Runs include channel, recipients, payload summary, status, response, error, and retry metadata.
- RapidPro distribution sends a short SMS summary, not the full report body.
- Webhook distribution sends a structured JSON report payload.
- Local exports require no external credentials.

### Scheduling

- Users can schedule a template.
- Schedules support `daily`, `weekly`, `monthly`, and simple interval recurrence.
- Schedules include timezone and next-run time.
- Schedule runs create report instances and optional distribution runs.
- Failed runs are visible and retryable.
- Schedules can be paused without deleting history.

### Auditability

- All create/update/approve/distribute/schedule actions write action-log entries.
- Report distribution is linked to report ID and template ID.
- Reports record source IDs used during generation.
- External dispatch errors are retained.

### Permissions

Lite currently has API-key protection for mutating endpoints. Reporting should respect that model:

- `GET` report endpoints are public in local mode unless broader auth is introduced.
- `POST`, `PATCH`, distribution, approval, and schedule actions require the existing mutating endpoint API-key guard when configured.
- Future RBAC can layer on owner/reviewer/distributor roles.

## Data Model

### `report_templates`

```json
{
  "id": "report_template_...",
  "name": "Daily SITREP",
  "report_type": "situation_report",
  "status": "active",
  "version": 1,
  "title_pattern": "Daily SITREP - {{country}} - {{date}}",
  "default_filters": { "country": "KE" },
  "sections": ["executive_summary", "risk_summary", "incident_summary"],
  "distribution_defaults": [
    { "channel": "markdown_download" },
    { "channel": "rapidpro_sms", "groups": ["group-uuid"] }
  ],
  "owner": "ops",
  "created_at": "2026-05-18T00:00:00.000Z",
  "updated_at": "2026-05-18T00:00:00.000Z"
}
```

### `reports`

```json
{
  "id": "report_...",
  "template_id": "report_template_...",
  "report_type": "situation_report",
  "status": "draft",
  "title": "Daily SITREP - KE - 2026-05-18",
  "scope": { "country": "KE", "from": "2026-05-18" },
  "sections": [],
  "source_refs": [],
  "warnings": [],
  "generated_at": "2026-05-18T00:00:00.000Z",
  "approved_at": null,
  "distributed_at": null,
  "owner": "ops"
}
```

### `report_distribution_runs`

```json
{
  "id": "report_distribution_...",
  "report_id": "report_...",
  "channel": "rapidpro_sms",
  "recipients": { "urns": ["tel:+254700000000"] },
  "status": "sent",
  "payload_summary": "Daily SITREP: 2 high risks, 1 open incident",
  "response_status": 201,
  "response_body": {},
  "error": null,
  "created_at": "2026-05-18T00:00:00.000Z"
}
```

### `report_schedules`

```json
{
  "id": "report_schedule_...",
  "template_id": "report_template_...",
  "status": "active",
  "timezone": "Africa/Nairobi",
  "recurrence": { "type": "daily", "time": "07:00" },
  "auto_distribute": false,
  "next_run_at": "2026-05-19T04:00:00.000Z",
  "last_run_at": null,
  "created_at": "2026-05-18T00:00:00.000Z"
}
```

### `report_schedule_runs`

```json
{
  "id": "report_schedule_run_...",
  "schedule_id": "report_schedule_...",
  "report_id": "report_...",
  "status": "completed",
  "started_at": "2026-05-19T04:00:00.000Z",
  "completed_at": "2026-05-19T04:00:02.000Z",
  "error": null
}
```

## API Requirements

### Templates

- `GET /api/v1/report-templates`
- `POST /api/v1/report-templates`
- `GET /api/v1/report-templates/:id`
- `PATCH /api/v1/report-templates/:id`

### Reports

- `GET /api/v1/reports`
- `POST /api/v1/reports`
- `GET /api/v1/reports/:id`
- `PATCH /api/v1/reports/:id`
- `POST /api/v1/reports/:id/generate`
- `POST /api/v1/reports/:id/approve`
- `POST /api/v1/reports/:id/distribute`
- `GET /api/v1/reports/:id/export.md`
- `GET /api/v1/reports/:id/export.json`

### Distribution

- `GET /api/v1/report-distributions`
- `GET /api/v1/report-distributions/:id`
- `POST /api/v1/report-distributions/:id/retry`

### Schedules

- `GET /api/v1/report-schedules`
- `POST /api/v1/report-schedules`
- `GET /api/v1/report-schedules/:id`
- `PATCH /api/v1/report-schedules/:id`
- `POST /api/v1/report-schedules/:id/run`
- `GET /api/v1/report-schedule-runs`

## UI Requirements

### Reports Navigation

Add a top-level reporting area with tabs:

- Reports
- Templates
- Schedules
- Distribution Runs

### Report List

Columns:

- Title
- Type
- Status
- Scope
- Owner
- Generated at
- Distributed at

Actions:

- New report
- Generate
- Preview
- Approve
- Distribute
- Export

### Report Builder

Inputs:

- Report type
- Template
- Title
- Scope filters
- Sections
- Narrative notes
- Warnings/caveats

Preview:

- Rendered report sections
- Source-record counts
- Data-quality warnings
- Distribution readiness

### Schedule Builder

Inputs:

- Template
- Recurrence
- Timezone
- Auto-distribution toggle
- Recipients
- Pause/resume

## Distribution Channel Requirements

### Local Markdown

- Render a readable Markdown report.
- Include generated timestamp, scope, warnings, and source appendix.

### JSON

- Return the complete structured report.
- Suitable for downstream systems.

### Webhook

- POST structured report JSON to a configured URL.
- Record HTTP status, response body, and errors.

### RapidPro SMS

- Send a short report summary through existing RapidPro integration.
- Include report title, severity summary, open incident count, and report ID or URL.
- Never send sensitive full report text over SMS by default.

## Scheduling Design

MVP should avoid adding cron dependencies. Scheduling can be implemented with an explicit runner endpoint first:

- Store schedules and next-run times.
- Expose `POST /api/v1/report-schedules/run-due`.
- Let deployment environments call the endpoint from cron, systemd timer, GitHub Actions, or another scheduler.

Future enhancement:

- Optional in-process scheduler enabled by `LINDELA_LITE_SCHEDULER=1`.

## Acceptance Criteria

### Creation

- User can create a report template.
- User can create a report from a template.
- User can create a report from scratch.
- Generated reports include deterministic sections and source references.

### Display

- User can list and filter reports.
- User can open a report detail page.
- User can see data-quality warnings and source lineage.
- User can export Markdown and JSON.

### Distribution

- User can distribute an approved report through at least one local channel.
- User can distribute a report summary through RapidPro when configured.
- Every distribution attempt is recorded.
- Failed distribution records include error details.

### Scheduling

- User can create a schedule.
- User can manually run due schedules.
- Schedule run creates a report instance.
- Auto-distribution can be enabled or disabled.
- Schedule run history is inspectable.

### Audit

- Template creation, report generation, approval, distribution, schedule creation, and schedule runs create action-log records.
- Report records include source references.

## Metrics

- Number of reports generated per week.
- Number of scheduled report runs.
- Distribution success rate.
- RapidPro dispatch success rate.
- Time from alert/incident creation to first report.
- Number of reports with stale data warnings.

## Risks

- Reports may imply more certainty than Lite data supports.
- Scheduled distribution could send stale or low-confidence information.
- SMS summaries can omit nuance.
- Webhook distribution may leak sensitive operational data if misconfigured.
- Report immutability and regeneration rules need to be strict enough for auditability but flexible enough for operators.

## Mitigations

- Always show confidence and freshness warnings.
- Require explicit approval before distribution in MVP.
- Keep SMS summaries short and link/reference the report instead of sending full text.
- Store distribution and schedule history.
- Make source appendix mandatory for generated reports.

## Implementation Plan

### Phase 1: Report Records And Markdown Export

- Add report collections to schema and store.
- Add report template and report CRUD APIs.
- Add deterministic section builders.
- Add Markdown and JSON export.
- Add tests for report generation and source refs.

### Phase 2: Dashboard Reporting UI

- Add report list, template list, and report detail.
- Add report builder and preview.
- Add status transitions: draft, ready, approved, archived.
- Add action logs.

### Phase 3: Distribution

- Add distribution run records.
- Add local Markdown/JSON distribution.
- Add webhook distribution.
- Add RapidPro SMS summary distribution.
- Add retry support for failed runs.

### Phase 4: Scheduling

- Add schedule records.
- Add manual `run-due` endpoint.
- Add schedule run history.
- Add optional auto-distribute.

### Phase 5: Hardening

- Add stale-data gates.
- Add report immutability after approval/distribution.
- Add visual QA for dashboard report views.
- Add OpenAPI and docs examples.

## Open Questions

- Should report approval be required for every distribution or only external channels?
- Should reports support public share links in Lite, or only local/exported artifacts?
- What SMS summary length should be enforced for RapidPro channels?
- Should schedules run in-process or only through an external scheduler trigger?
- Which report sections should be mandatory for each report type?
