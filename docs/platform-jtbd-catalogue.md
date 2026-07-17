# Lindela Lite: Platform JTBD Catalogue

**Generated at:** 2026-08-09
**Method:** Static repository inspection. No app was started and no tests were run. Status assignments are based on reading source modules, route handlers, test descriptions, and documentation. See Caveats.

---

## Status Legend

| Status | Meaning |
|---|---|
| `Live` | Clear implementation in code, at least one matching route or function, and test coverage visible. |
| `Partial` | Code or route exists but end-to-end coverage is incomplete (missing test, missing UI, missing gate, or only partially wired). |
| `Planned` | Specified in docs or PRD but not visibly implemented. |
| `Implied` | Not explicitly specified, but necessary for the platform to function coherently. |
| `Strategic` | Future ecosystem or long-term capability not yet planned in detail. |
| `Missing` | Should exist based on adjacent capabilities or risk, but no implementation or plan was found. |

---

## Actor Glossary

| Actor | Description |
|---|---|
| Operator | Primary platform user. Creates and manages incidents, interventions, alerts, reports, and schedules via dashboard or API. |
| Field Agent | In-field responder. Communicates through RapidPro SMS flows; does not access the platform directly. |
| Response Lead | Senior operator who approves alert dispatches and report distributions. |
| Field Coordinator | Reviews inbound field reports and produces partner-facing updates. |
| Program Manager | Reviews intervention progress, task status, and outcome metrics on a recurring basis. |
| Data Officer | Monitors source freshness, data quality, and confidence signals. |
| External Partner | Receives distributed reports or SMS summaries; has no direct platform access. |
| Scheduler | Automated cron, systemd timer, GitHub Actions, or equivalent. Calls due-run endpoints over HTTP. |
| RapidPro Flow | Inbound webhook source for field report messages sent by field agents via SMS. |
| Webhook Consumer | External system subscribed to platform events via the outbox/webhook bus. |
| Administrator | Configures environment, storage backend, API keys, PII policies, and retention rules. |
| Developer | Writes or validates custom connectors using the connector SDK. |

---

## JTBD Table

| ID | Domain | Primary Actor | Job To Be Done | Trigger | Desired Outcome | Current Support | Evidence | Workflow-System Implication | Priority | Notes / Gaps |
|---|---|---|---|---|---|---|---|---|---|---|
| JTBD-001 | Ingestion | Operator | Manually trigger a single ingestion run for one or more named public sources to refresh normalized data and recalculate analytics. | Operator calls `POST /api/v1/ingest/run` with a sources list and region spec. | Normalized records written to store, analytics refreshed, `source_runs` record persisted with status, counts, and diagnostics. | `Live` | `src/ingestion.js:runIngestion`, `POST /api/v1/ingest/run`, `test/lite.test.js:ingests user-supplied conflict and service data` | Checklist gate: require at least one source selected; enforce region spec validation; surface retry outcome. | P0 | No human gate before analytics are applied to downstream decisions. |
| JTBD-002 | Ingestion | Operator | Create default ingestion schedules for all built-in public-source connectors in one action. | Operator calls `POST /api/v1/ingest/schedules/defaults`. | One `ingestion_schedules` record per public source, active, with default intervals and retry policy. | `Live` | `src/ingestion.js:defaultIngestionSchedules`, `POST /api/v1/ingest/schedules/defaults`, `test/lite.test.js:tracks ingestion health and runs due ingestion schedules` | Admin configuration candidate; idempotent re-creation needed. | P0 | No UI confirmation or diff preview before defaults are written. |
| JTBD-003 | Ingestion | Operator | Create a custom ingestion schedule for a specific source with a custom interval, timeout, and retry policy. | Operator submits `POST /api/v1/ingest/schedules` with source, interval, timeout, and retries. | New `ingestion_schedules` record with `active` status and correct `next_run_at`. | `Live` | `src/ingestion.js:normalizeIngestionSchedule`, `POST /api/v1/ingest/schedules`, `test/lite.test.js:tracks ingestion health` | Admin rule candidate; validation for duplicate source schedules should block or warn. | P1 | No guard against duplicate active schedules for the same source. |
| JTBD-004 | Ingestion | Scheduler | Run all overdue active ingestion schedules automatically on a defined interval. | Scheduler calls `POST /api/v1/ingest/run-due` when cron fires. | All schedules whose `next_run_at` has passed are executed; `last_run_at` and `next_run_at` are updated; `source_runs` records written. | `Live` | `src/ingestion.js:runDueIngestionSchedules`, `POST /api/v1/ingest/run-due`, `test/lite.test.js:tracks ingestion health and runs due ingestion schedules` | Background job candidate; must record failures without halting sibling schedules. | P0 | Scheduler is external; no in-process fallback if sidecar fails. |
| JTBD-005 | Ingestion | Operator | Pause or resume an ingestion schedule without deleting its run history. | Operator sends `PATCH /api/v1/ingest/schedules/:id` with `status: paused` or `status: active`. | Schedule status updated; paused schedule is skipped by `run-due`; history retained. | `Live` | `src/ingestion.js:normalizeIngestionSchedule`, `PATCH /api/v1/ingest/schedules/:id`, `test/lite.test.js:tracks ingestion health` | Workflow transition: active -> paused -> active; no cascade to dependent alerts. | P1 | No notification when a schedule is paused by an operator other than the creator. |
| JTBD-006 | Ingestion | Data Officer | Review per-source ingestion status, health, failure streaks, and staleness warnings to identify sources needing attention. | Data officer opens `GET /api/v1/ingest/status` or the dashboard source health panel. | Per-source health, policy, failure streak, last run, and staleness flags visible at a glance. | `Live` | `src/ingestion.js:ingestionStatus`, `GET /api/v1/ingest/status`, `test/lite.test.js:tracks ingestion health` | Operational task: acknowledge or escalate stale sources; no current task projection. | P1 | No escalation or notification when a source crosses a failure streak threshold. |
| JTBD-007 | Ingestion | Operator | Import user-supplied conflict event data from a ACLED-compatible CSV or the Lite conflict schema. | Operator calls `POST /api/v1/ingest/run` with `sources: ["conflict_csv"]` or `acled_csv` and provides a file path or upload. | `conflict_events` records written to store; data quality updated; analytics refreshed. | `Live` | `src/connectors/uploads.js`, `src/schema.js`, `test/lite.test.js:ingests user-supplied conflict and service data` | Checklist gate: ACLED license acceptance required for `acled_csv`; enforce `acled_license_accepted=true`. | P0 | License gate for ACLED is a flag on the connector but has no UI confirmation step. |
| JTBD-008 | Ingestion | Operator | Import service asset data (JSON, CSV, or GeoJSON) to populate the facility and infrastructure layer. | Operator calls `POST /api/v1/service-assets` with a structured payload. | `service_assets` records merged into store; analytics re-run for impact assessments. | `Live` | `POST /api/v1/service-assets`, `src/server.js:338`, `test/lite.test.js:validates service asset imports` | Checklist gate: validate required fields (name, service_type, lat, lon) before write. | P0 | No batch-import progress tracking for large asset files. |
| JTBD-009 | Ingestion | Data Officer | Investigate a source failure streak and decide whether to retry, reconfigure, pause, or escalate. | Data officer sees a source with consecutive failures in `GET /api/v1/ingest/status`. | Decision made with failure reason and retry count visible; action taken and recorded in action log. | `Partial` | `src/ingestion.js:failureStreak`, `GET /api/v1/ingest/status`, `test/lite.test.js:honors ingestion retry settings when a connector throws` | Operational task candidate: "Review and resolve source failure" task projected into work queue. | P1 | No task projection from failure streak; no auto-pause after N consecutive failures. |
| JTBD-010 | Analytics | Operator | Review computed flood risk scores for target regions to assess which areas are at elevated risk. | Operator opens `GET /api/v1/flood-risk` or the dashboard risk panel after ingestion. | Flood risk scores with level, confidence, drivers, and methodology visible per region. | `Live` | `src/analytics.js:computeFloodRisk`, `GET /api/v1/flood-risk`, `test/lite.test.js:computes flood and climate-conflict risk scores from real records` | Workflow input: risk scores trigger incident creation decisions; no formal gate between score and incident. | P0 | No confidence threshold gate before scores are used in downstream alert evaluation. |
| JTBD-011 | Analytics | Operator | Review climate-conflict risk scores to assess compounding hazard and conflict drivers per region. | Operator opens `GET /api/v1/conflict-risk`. | Climate-conflict scores with sub-drivers and confidence level visible. | `Live` | `src/analytics.js:computeClimateConflictRisk`, `GET /api/v1/conflict-risk`, `test/lite.test.js:computes flood and climate-conflict risk scores` | Workflow input for incident and intervention triage. | P1 | No explicit linkage between a conflict risk score and an alert rule. |
| JTBD-012 | Analytics | Operator | Review service delivery impact assessments to identify which facilities are most at risk and prioritize intervention targets. | Operator opens `GET /api/v1/service-impacts`. | Impact assessments with impact level, confidence, and risk drivers per asset visible. | `Live` | `src/analytics.js:computeServiceImpacts`, `GET /api/v1/service-impacts`, `test/lite.test.js:computes service delivery impacts` | Workflow input for intervention targeting; no formal gate requiring human sign-off before resource deployment. | P0 | Impact scores are decision-support signals; no mandatory review gate before escalation. |
| JTBD-013 | Analytics | Data Officer | Review source freshness, confidence, geocoding coverage, and error counts before producing or approving a report. | Data officer opens `GET /api/v1/data-quality` or a report's data-quality section. | Per-source quality summary with freshness, confidence, geocoding coverage, and error count visible; stale sources flagged. | `Live` | `src/analytics.js:computeDataQuality`, `GET /api/v1/data-quality`, `test/lite.test.js:computes source-level data quality` | Checklist gate: block report approval when any required source is stale or low confidence. | P0 | Gate exists in report warnings but is advisory; approval is not blocked by data quality. |
| JTBD-014 | Analytics | Analyst | Apply bias correction to raw climate observations by mapping gridded values to station baselines. | Analyst calls `POST /api/v1/analytics/bias-correct` with observations and station records. | Corrected precipitation and temperature values returned and optionally stored. | `Live` | `src/analytics/downscaling.js:biasCorrectClimate`, `POST /api/v1/analytics/bias-correct`, `test/lite.test.js:maps gridded values to station values via quantile matching` | Preprocessing step for analytics pipeline; not yet integrated into scheduled ingestion. | P2 | Bias correction is callable but not automatically applied in `runIngestion`. |
| JTBD-015 | Analytics | Analyst | Review population-at-risk and facilities-at-risk counts for active hazard events. | Analyst calls `GET /api/v1/impact/population-at-risk` and `GET /api/v1/impact/facilities-at-risk`. | Lists of assets and population estimates co-located with active hazard events. | `Live` | `src/analytics/impact.js`, `GET /api/v1/impact/population-at-risk`, `test/lite.test.js:computes population at risk for hazards near service assets` | Workflow input for intervention scoping; no formal assignment workflow from impact results. | P1 | No aggregate summary of total population at risk across all hazard events. |
| JTBD-016 | Analytics | Analyst | Run a what-if scenario with modified climate inputs (e.g., increased precipitation) to explore risk under perturbed conditions. | Analyst calls `POST /api/v1/scenarios` with a perturbation spec. | Scenario risk output returned with a shareable token encoding the perturbation. | `Live` | `src/scenarios.js:runScenario`, `POST /api/v1/scenarios`, `test/lite.test.js:runs scenarios with precipitation multiplier` | Analytical workflow; no gate preventing scenario results from being presented as operational risk. | P2 | Scenario results are not persisted as named records; only recoverable via token. |
| JTBD-017 | Analytics | Analyst | Retrieve a previously run scenario result by its token to compare or share with a colleague. | Analyst calls `GET /api/v1/scenarios/:token`. | Scenario perturbation decoded and re-run; result returned. | `Live` | `src/scenarios.js:decodeScenarioUrl`, `GET /api/v1/scenarios/:token`, `test/lite.test.js:GET /api/v1/scenarios/:token decodes and reruns scenario` | Stateless retrieval; no saved scenario library or naming system. | P2 | Token expiry and collision handling not addressed. |
| JTBD-018 | Analytics | Operator | Retrieve a combined assessment package (flood risk, conflict risk, impact assessments) in a single request for dashboard display. | Operator calls `GET /api/v1/assessments`. | Unified package with risk scores, impact assessments, data quality, and calibration metadata. | `Live` | `src/analytics.js:calibrationReport`, `GET /api/v1/assessments`, `test/lite.test.js:exposes data quality and confidence-enhanced assessments` | Dashboard integration point; single payload for initial render. | P1 | Package includes calibration metadata but no source freshness gate before serving. |
| JTBD-019 | Analytics | Data Officer | Inspect data lineage records to trace which source run produced a specific normalized record. | Data officer calls `GET /api/v1/data-lineage`. | Lineage records linking source runs to downstream normalized records visible. | `Partial` | `src/lineage.js:recordLineage`, `GET /api/v1/data-lineage`, no dedicated test found | Audit trail for data provenance; needed for report credibility. | P1 | `recordLineage` exists but integration into ingestion pipeline and coverage in tests is not confirmed from static inspection. |
| JTBD-020 | Alerts | Operator | Create an alert rule defining a metric, comparison operator, threshold, severity, and declarative actions for downstream dispatch. | Operator calls `POST /api/v1/alert-rules`. | Alert rule saved as active; visible in rule list; ready for evaluation. | `Live` | `src/alerts.js:normalizeAlertRule`, `POST /api/v1/alert-rules`, `test/lite.test.js:evaluates alert rules into auditable alert events` | Configuration rule candidate; metric namespace documented in schema. | P0 | Alert actions are declarative only; Lite does not send notifications by itself. |
| JTBD-021 | Alerts | Operator | Update an existing alert rule to adjust threshold, severity, or status (active, paused, archived). | Operator calls `PATCH /api/v1/alert-rules/:id`. | Rule updated; paused rules are skipped by evaluation; action log written. | `Live` | `src/alerts.js:normalizeAlertRule`, `PATCH /api/v1/alert-rules/:id`, `test/lite.test.js:evaluates alert rules` | Workflow transition: active -> paused -> active; no impact on open alert events from the rule. | P1 | Pausing a rule does not suppress already-open alert events from that rule. |
| JTBD-022 | Alerts | Operator / Scheduler | Evaluate all active alert rules against the current platform context and generate alert events for triggered rules. | Operator or scheduler calls `POST /api/v1/alerts/evaluate`. | Alert events created for each triggered rule; suppression applied for rules already in active event state; events include metric value and threshold. | `Live` | `src/alerts.js:evaluateAlertRules`, `POST /api/v1/alerts/evaluate`, `test/lite.test.js:evaluates alert rules into auditable alert events` | Background job candidate: schedule periodic evaluation; suppression by bucket prevents duplicate storms. | P0 | Evaluation is manual or externally scheduled; no in-process periodic trigger. |
| JTBD-023 | Alerts | Operator | Review generated alert events, identify which are unacknowledged or unresolved, and prioritize dispatch or response. | Operator opens `GET /api/v1/alert-events` filtered by status or severity. | Alert events list with status (open, acknowledged, resolved), severity, metric value, and rule name visible. | `Live` | `GET /api/v1/alert-events`, `test/lite.test.js:evaluates alert rules into auditable alert events` | Operational task candidate: "Acknowledge unresolved alert events" projected as work queue item. | P0 | No task projection or assignment for open alert events. |
| JTBD-024 | Alerts | Operator | Acknowledge or resolve an alert event and record a decision note. | Operator calls `PATCH /api/v1/alert-events/:id` with `status: acknowledged` or `status: resolved` and a note. | Alert event status updated; action log written; resolved events no longer block suppression bucket. | `Live` | `src/alerts.js:updateAlertEvent`, `PATCH /api/v1/alert-events/:id`, `test/lite.test.js:evaluates alert rules` | Workflow transition: open -> acknowledged -> resolved; no escalation path for unacknowledged events past SLA. | P0 | No SLA timer or escalation when an alert event remains unacknowledged beyond a threshold. |
| JTBD-025 | Alerts | Webhook Consumer | Retrieve an alert event in CAP 1.2 XML format for consumption by EDXL-compatible downstream systems. | Consumer calls `GET /api/v1/alert-events/:id.cap`. | Valid CAP 1.2 XML with alert details, severity, urgency, and area. | `Live` | `src/cap.js:renderCapXml`, `GET /api/v1/alert-events/:id.cap`, `test/lite.test.js:GET /api/v1/alert-events/:id.cap returns XML` | External integration point; no delivery confirmation or retry for CAP consumers. | P2 | No push mechanism; consumer must poll for new CAP events. |
| JTBD-026 | Trigger Protocols | Operator | Create a trigger protocol with custom multi-condition threshold logic for a specific hazard type or region. | Operator calls `POST /api/v1/trigger-protocols`. | Trigger protocol saved; ready for backtest or shadow evaluation. | `Partial` | `src/alerts.js:normalizeTriggerProtocol`, `POST /api/v1/trigger-protocols`, no dedicated test confirmed by static inspection | Configuration rule candidate; more expressive than alert rules; no UI builder visible. | P1 | No dashboard UI for trigger protocol creation; routes exist but no test coverage confirmed. |
| JTBD-027 | Trigger Protocols | Operator | Update an existing trigger protocol to revise thresholds, conditions, or activation region. | Operator calls `PATCH /api/v1/trigger-protocols/:id`. | Protocol updated; action log written; subsequent backtests reflect new settings. | `Partial` | `src/alerts.js:normalizeTriggerProtocol`, `PATCH /api/v1/trigger-protocols/:id`, no dedicated test | Versioning of protocols needed to audit which version was active at time of dispatch. | P1 | No version history for protocol changes; updates overwrite in place. |
| JTBD-028 | Trigger Protocols | Analyst | Run a backtest of a trigger protocol against stored historical data to assess whether past conditions would have triggered it. | Analyst calls `POST /api/v1/trigger-protocols/:id/backtest`. | Backtest result with trigger counts, condition matches, and date summary attached to the protocol record. | `Partial` | `src/alerts.js:backtestTriggerProtocol`, `POST /api/v1/trigger-protocols/:id/backtest`, no dedicated test | Analytical gate: require backtest approval before protocol goes active. | P1 | No formal review gate between backtest result and activation. |
| JTBD-029 | Trigger Protocols | Analyst | Run a shadow evaluation of a trigger protocol against current live data to validate behavior without firing real alerts. | Analyst calls `POST /api/v1/trigger-protocols/:id/shadow-run`. | Shadow run result returned with what would have triggered; no alert events written. | `Partial` | `src/alerts.js:evaluateInShadowMode`, `POST /api/v1/trigger-protocols/:id/shadow-run`, no dedicated test | Dry-run gate before protocol activation; critical for preventing false-positive cascades. | P1 | Shadow run result not persisted for later audit. |
| JTBD-030 | Operations | Operator | Create an incident from operator input, optionally linking it to an event, risk score, or service asset. | Operator calls `POST /api/v1/incidents` with title, type, severity, priority, and optional links. | Incident record created with `open` status; action log written. | `Live` | `src/operations.js:normalizeIncident`, `POST /api/v1/incidents`, `test/lite.test.js:manages incidents, interventions, tasks, field reports, resources` | First-class workflow: open -> monitoring -> responding -> closed; each transition needs actor, reason, and timestamp. | P0 | No formal status lifecycle enforcement; any status string accepted. |
| JTBD-031 | Operations | Operator | Update an incident status, severity, owner, or description as the situation evolves. | Operator calls `PATCH /api/v1/incidents/:id`. | Incident updated; action log written; downstream interventions still linked. | `Live` | `src/operations.js:normalizeIncident`, `PATCH /api/v1/incidents/:id`, `test/lite.test.js:manages incidents` | Workflow transition; no validation that `closed` incidents cannot receive new interventions. | P0 | No guard preventing edits to closed incidents without a reopen action. |
| JTBD-032 | Operations | Operator | Create an intervention plan linked to an incident, defining objective, lead organization, partners, and timeline. | Operator calls `POST /api/v1/interventions` with `incident_id` and plan details. | Intervention record created with `planned` status; linked to incident; action log written. | `Live` | `src/operations.js:normalizeIntervention`, `POST /api/v1/interventions`, `test/lite.test.js:manages incidents, interventions` | First-class workflow: planned -> active -> completed/cancelled; gates on transition to active. | P0 | No check that linked incident is in a valid state before intervention creation. |
| JTBD-033 | Operations | Operator | Update an intervention status, record outcome summary, or mark it complete with success metrics. | Operator calls `PATCH /api/v1/interventions/:id`. | Intervention updated; `completed_at` set on completion; outcome summary recorded; action log written. | `Live` | `src/operations.js:normalizeIntervention`, `PATCH /api/v1/interventions/:id`, `test/lite.test.js:manages incidents` | Terminal state: `completed` or `cancelled`; no current gate requiring outcome evidence before completion. | P1 | No mandatory evidence gate (outcome summary, success metrics) before marking completed. |
| JTBD-034 | Operations | Operator | Create an intervention task with a title, owner, due date, and action type. | Operator calls `POST /api/v1/tasks` with `intervention_id` and task details. | Task record created with `pending` status; linked to intervention; action log written. | `Live` | `src/operations.js:normalizeTask`, `POST /api/v1/tasks`, `test/lite.test.js:manages incidents, interventions, tasks` | Operational task projection: tasks should appear in an assigned operator's work queue. | P0 | No work queue view; no notification to assigned operator. |
| JTBD-035 | Operations | Operator | Update a task status as work progresses (pending -> in_progress -> done). | Operator calls `PATCH /api/v1/tasks/:id`. | Task updated; `completed_at` set when done; action log written. | `Live` | `src/operations.js:normalizeTask`, `PATCH /api/v1/tasks/:id`, `test/lite.test.js:manages incidents, interventions, tasks` | Workflow transition; no SLA enforcement on `due_at`; no escalation for overdue tasks. | P1 | No overdue task detection or escalation; `due_at` is stored but not acted upon. |
| JTBD-036 | Operations | Operator / Field Coordinator | Create a field report manually from direct observation or coordination notes. | Operator calls `POST /api/v1/field-reports` with summary, needs, and optional coordinates. | Field report stored and linked to incident or intervention; action log written. | `Live` | `src/operations.js:normalizeFieldReport`, `POST /api/v1/field-reports`, `test/lite.test.js:manages incidents, interventions, tasks, field reports` | Operational task candidate: review new field reports and link to open incidents. | P1 | No notification to response lead when a new high-priority field report arrives. |
| JTBD-037 | Operations | Operator | Create a response resource record to track a deployable team, supply cache, piece of equipment, or capacity unit. | Operator calls `POST /api/v1/response-resources`. | Resource record created with status, type, quantity, unit, and optional assignment. | `Live` | `src/operations.js:normalizeResource`, `POST /api/v1/response-resources`, `test/lite.test.js:manages incidents, interventions, tasks, field reports, resources` | Resource lifecycle: available -> reserved -> deployed -> recovered; no formal transition model. | P1 | No check for resource conflicts when assigning the same resource to multiple interventions. |
| JTBD-038 | Operations | Operator | Update a response resource status or reassign it to a different intervention. | Operator calls `PATCH /api/v1/response-resources/:id`. | Resource record updated; action log written. | `Live` | `src/operations.js:normalizeResource`, `PATCH /api/v1/response-resources/:id`, `test/lite.test.js:manages incidents` | Workflow transition; no notification to previous assignment on reassignment. | P2 | No audit trail for resource transfer chain between interventions. |
| JTBD-039 | Operations | Response Lead | Review the operations summary to get counts and status breakdowns for incidents, interventions, tasks, and resources at a glance. | Response lead opens `GET /api/v1/operations/summary`. | Counts by status for all operational collections; top-level summary for situational awareness. | `Live` | `src/operations.js:operationalSummary`, `GET /api/v1/operations/summary`, `test/lite.test.js:manages incidents` | Dashboard integration point; also consumed by alert rule evaluation via metric paths. | P0 | Summary is read-only; no interactive escalation or triage actions from summary view. |
| JTBD-040 | Operations | Auditor / Response Lead | Review the append-only action log to audit who created or changed which operational record, and when. | Auditor opens `GET /api/v1/action-logs`, optionally filtered by collection or date. | Chronological list of mutation records with actor, action, record id, timestamp, and summary. | `Live` | `src/operations.js:actionLog`, `GET /api/v1/action-logs`, `test/lite.test.js:manages incidents, interventions, tasks, field reports` | Audit trail; covers operational records but not all admin/config mutations. | P0 | Config mutations (schedule changes, API key rotation) may not produce action log entries. |
| JTBD-041 | RapidPro | Operator | Verify that RapidPro credentials and flow configuration are correctly set before attempting dispatch. | Operator opens `GET /api/v1/rapidpro/status`. | Configuration summary returned without exposing secrets; flow UUID and mode visible. | `Live` | `src/rapidpro.js:rapidProStatus`, `GET /api/v1/rapidpro/status`, `test/lite.test.js:dispatches alert events through RapidPro flow starts` | Pre-flight checklist gate before dispatch; no connectivity test to RapidPro API. | P1 | Status does not confirm that the configured flow UUID actually exists in RapidPro. |
| JTBD-042 | RapidPro | Operator / Response Lead | Dispatch an alert event to field contacts via RapidPro flow start or broadcast SMS. | Operator calls `POST /api/v1/rapidpro/alert-events/:id/send` with recipient URNs and mode. | RapidPro API called; dispatch record created with request, response status, and outcome; action log written. | `Live` | `src/rapidpro.js:sendRapidProAlert`, `POST /api/v1/rapidpro/alert-events/:id/send`, `test/lite.test.js:dispatches alert events through RapidPro flow starts` | Checklist gate: confirm alert event status is not already dispatched; human dispatch gate for high-severity alerts. | P0 | No human approval gate; any authenticated operator can dispatch any alert event. |
| JTBD-043 | RapidPro | Operator | Review RapidPro outbound dispatch logs to confirm SMS delivery or identify failures for retry. | Operator opens `GET /api/v1/rapidpro/dispatches`. | Dispatch records with recipient, mode, status, response code, and error details visible. | `Live` | `GET /api/v1/rapidpro/dispatches`, `test/lite.test.js:dispatches alert events` | Operational task: failed dispatches should surface as actionable items in work queue. | P1 | No automatic retry for failed dispatches; operator must identify and retry manually. |
| JTBD-044 | RapidPro | RapidPro Flow | Post a field report payload from an SMS field update flow; platform parses and stores it as a field report with incident linkage. | RapidPro flow POSTs to `POST /api/v1/rapidpro/field-report` when a contact submits a structured SMS message. | Inbound message stored in `rapidpro_inbound_messages`; field report created and linked to incident or holding incident; coordinates parsed. | `Live` | `src/rapidpro.js:parseRapidProFieldReport`, `POST /api/v1/rapidpro/field-report`, `test/lite.test.js:receives RapidPro webhook payloads as field reports` | Integration gateway; holding incident creation is a safety net for unlinked messages. | P0 | Parser relies on unstructured text conventions; ambiguous messages silently create partial field reports. |
| JTBD-045 | RapidPro | Field Coordinator | Review inbound RapidPro messages and link or reassign unlinked messages to the correct incident or intervention. | Coordinator opens `GET /api/v1/rapidpro/inbound` and reviews unlinked messages. | Inbound message records with from, text, parsed field report id, and incident linkage visible. | `Partial` | `GET /api/v1/rapidpro/inbound`, `test/lite.test.js:receives RapidPro webhook payloads` | Operational task: "Review unlinked inbound messages" as a recurring coordination task; no link-update endpoint exists. | P1 | No endpoint to update the incident or intervention linkage on an existing inbound message record. |
| JTBD-046 | RapidPro | Response Lead | Distribute a report SMS summary to a configured recipient list via RapidPro when a report is approved. | Response lead includes `rapidpro_sms` channel in `POST /api/v1/reports/:id/distribute`. | Short SMS summary sent via RapidPro; dispatch record created; report distribution run persisted. | `Live` | `src/rapidpro.js:sendRapidProReportSummary`, `POST /api/v1/reports/:id/distribute`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Distribution workflow: validate recipient list; enforce summary length; record failure for retry. | P1 | No enforced maximum SMS length; long summaries may exceed RapidPro limits silently. |
| JTBD-047 | Reports | Operator | Create a reusable report template with type, title pattern, default filters, sections, and optional distribution defaults. | Operator calls `POST /api/v1/report-templates`. | Template stored with `active` status and version 1; ready for use in report generation. | `Live` | `src/reports.js:normalizeReportTemplate`, `POST /api/v1/report-templates`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Configuration rule candidate: template defines section library selection and filter defaults. | P0 | No validation that selected sections match the report type's expected section library. |
| JTBD-048 | Reports | Operator | Copy an existing report template to create a variant with a new version-1 record. | Operator calls `POST /api/v1/report-templates/:id/copy`. | New template record created with same settings; caller can diverge independently. | `Live` | `POST /api/v1/report-templates/:id/copy`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Admin utility; no version lineage tracked between original and copy. | P2 | No parent-template reference on the copied record; audit trail breaks. |
| JTBD-049 | Reports | Operator | Update or archive a report template. | Operator calls `PATCH /api/v1/report-templates/:id`. | Template updated or status set to `archived`; archived templates not offered for new reports. | `Live` | `src/reports.js:normalizeReportTemplate`, `PATCH /api/v1/report-templates/:id`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | No cascade: archiving a template does not pause or cancel its schedules. | P2 | No cascade from archived template to its active schedules. |
| JTBD-050 | Reports | Operator | Create a report instance from a template (or from scratch) with scope filters defining country, date range, and focus. | Operator calls `POST /api/v1/reports` with template id and scope. | Report record created with `draft` status; scope and template linked; ready for section generation. | `Live` | `src/reports.js:normalizeReport`, `POST /api/v1/reports`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | First-class workflow: draft -> ready -> approved -> distributed -> archived. | P0 | Status transition guards not fully enforced; see reporting PRD open questions. |
| JTBD-051 | Reports | Operator | Trigger section generation for a draft report to populate deterministic content from current store data. | Operator calls `POST /api/v1/reports/:id/generate`. | Report sections populated with summaries, counts, source refs, and data quality warnings; report status advances to `ready`. | `Live` | `src/reports.js:generateReportSections`, `POST /api/v1/reports/:id/generate`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Gate: block generation when required sources are absent or stale; advisory warnings implemented but not blocking. | P0 | Stale data warnings are recorded but do not block generation or subsequent approval. |
| JTBD-052 | Reports | Program Manager | Review a generated report in the dashboard, inspect section content, source references, and data quality warnings. | Program manager opens report detail view in dashboard or calls `GET /api/v1/reports/:id`. | Report sections, timestamps, source refs, warnings, and status visible; long sections collapsible. | `Partial` | `GET /api/v1/reports/:id`, `src/reports.js`, `docs/reporting-prd.md:Display A Report`; dashboard UI completeness not confirmed by static inspection | Dashboard integration; report detail UI described in PRD but not verified in `public/app.js`. | P1 | Dashboard report detail UI is specified in PRD but implementation in `public/app.js` is unverified from static inspection. |
| JTBD-053 | Reports | Response Lead | Approve a generated report to lock it before external distribution. | Response lead calls `POST /api/v1/reports/:id/approve`. | Report status advances to `approved`; `approved_at` set; report becomes immutable except archival; action log written. | `Live` | `src/reports.js:approveReport`, `POST /api/v1/reports/:id/approve`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Workflow gate: distribution restricted to `ready` or `approved` reports; approval actor recorded. | P0 | No per-reviewer approval policy; any authenticated operator can approve any report. |
| JTBD-054 | Reports | Operator | Export a report as Markdown, JSON, CSV, or GeoJSON for local use, printing, or downstream integration. | Operator calls `GET /api/v1/reports/:id/export.md`, `.json`, `.csv`, or `.geojson`. | Formatted export file returned in the requested format with section content and source appendix. | `Live` | `src/reports.js:renderReportMarkdown`, `GET /api/v1/reports/:id/export.md`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Export action available for any report; no status gate on export (draft reports can be exported). | P2 | Draft reports are exportable; no warning that draft content may be incomplete or unreviewed. |
| JTBD-055 | Reports | Response Lead | Distribute an approved report through one or more channels: markdown download, webhook, or RapidPro SMS. | Response lead calls `POST /api/v1/reports/:id/distribute` with a channels list. | Distribution run records created per channel; payloads sent; successes and failures recorded; `distributed_at` set on report. | `Live` | `src/server.js:distributeReport`, `POST /api/v1/reports/:id/distribute`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Checklist gate: confirm report is `ready` or `approved` before accepting distribution request. | P0 | Report status check exists; channel-specific recipient validation is advisory. |
| JTBD-056 | Reports | Operator | Review report distribution run history to confirm delivery outcomes or identify channels with failures. | Operator opens `GET /api/v1/report-distributions` or `GET /api/v1/report-distributions/:id`. | Per-run records with channel, recipients, status, response code, error, and retry metadata visible. | `Live` | `GET /api/v1/report-distributions`, `test/lite.test.js:creates, displays, approves, and distributes generated reports` | Operational audit trail for distribution; retry visibility. | P1 | No summary view grouping runs by report or showing overall distribution health. |
| JTBD-057 | Reports | Operator | Retry a failed distribution run using the original channel options. | Operator calls `POST /api/v1/report-distributions/:id/retry`. | New distribution run created with `retry_of` linking to the original; attempt recorded. | `Live` | `POST /api/v1/report-distributions/:id/retry`, `test/lite.test.js:keeps reports approved when every distribution channel fails` | Retry workflow; no backoff or max-retry cap. | P1 | No maximum retry count; operators can retry indefinitely. |
| JTBD-058 | Reports | Program Manager | Create a recurring report schedule for a template with recurrence, timezone, and optional auto-distribute. | Program manager calls `POST /api/v1/report-schedules`. | Schedule record created with `active` status and computed `next_run_at`. | `Live` | `src/reports.js:normalizeReportSchedule`, `POST /api/v1/report-schedules`, `test/lite.test.js:schedules report templates and records schedule runs` | Background job candidate; schedule calculates next-run in correct timezone. | P0 | No notification when a scheduled report fails to generate or distribute. |
| JTBD-059 | Reports | Scheduler | Execute all overdue report schedules, generate reports, and optionally distribute them. | Scheduler calls `POST /api/v1/report-schedules/run-due`. | Due schedules executed; report instances created; auto-distribute fires if enabled; schedule run records written. | `Live` | `src/server.js:runDueReportSchedules`, `POST /api/v1/report-schedules/run-due`, `test/lite.test.js:auto-distributes reports from due report schedules` | Background job; must continue sibling schedules when one schedule fails. | P0 | Template deletion causes schedule runs to record a failure but still advance `next_run_at`. |
| JTBD-060 | Reports | Operator | Review the history of report schedule runs to confirm execution, identify failures, and trace generated report ids. | Operator calls `GET /api/v1/report-schedule-runs`. | Schedule run records with status, started/completed at, report id, error details visible. | `Live` | `GET /api/v1/report-schedule-runs`, `test/lite.test.js:schedules report templates and records schedule runs` | Audit trail for scheduled report execution. | P1 | No summary view per schedule showing success rate or streak. |
| JTBD-061 | Reports | Operator | Retry a failed report schedule by re-running the schedule that produced the failed run. | Operator calls `POST /api/v1/report-schedule-runs/:id/retry`. | Schedule re-run; new report instance generated; new run record created. | `Live` | `POST /api/v1/report-schedule-runs/:id/retry`, `test/lite.test.js:records and advances failed report schedules when the template is missing` | Retry workflow; no SLA on how quickly a failed scheduled run must be retried. | P2 | Retry re-runs the schedule not the original run; behavior differs from distribution retry. |
| JTBD-062 | Reports | External Partner | Receive a webhook-delivered report payload or RapidPro SMS summary without direct platform access. | Platform distributes report via webhook channel or RapidPro SMS; partner receives payload. | Report JSON or SMS summary delivered; partner can act on content without platform credentials. | `Partial` | `src/reports.js:formatReportSmsSummary`, `POST /api/v1/reports/:id/distribute`, `test/lite.test.js:creates, displays, approves, and distributes` | External portal workflow candidate: partner-facing read-only report page or signed URL needed. | P1 | No signed or public report link; partner receives raw JSON or SMS summary only. |
| JTBD-063 | STAC/OGC | Data Consumer | Browse the STAC catalog to discover available data collections and understand the Lite data surface. | Consumer calls `GET /stac/catalog.json`. | Valid STAC 1.0 catalog with links to all published collections returned. | `Live` | `src/stac.js:stacCatalog`, `GET /stac/catalog.json`, `test/lite.test.js:GET /stac/catalog.json returns valid STAC Catalog` | Standard geospatial discovery interface; enables downstream GIS catalog integration. | P2 | Catalog does not enumerate dynamically which collections have records vs. which are empty. |
| JTBD-064 | STAC/OGC | Data Consumer | Retrieve a STAC collection for a specific hazard or climate data type with metadata and item links. | Consumer calls `GET /stac/collections/:collectionId`. | STAC Collection object with spatial extent, temporal extent, and item links returned. | `Live` | `src/stac.js:stacCollection`, `GET /stac/collections/:id`, `test/lite.test.js:Lindela Lite STAC` | Interoperability with STAC-aware clients; no STAC search endpoint yet. | P2 | No STAC search (`/stac/search`) endpoint for cross-collection spatial queries. |
| JTBD-065 | STAC/OGC | Data Consumer | Retrieve individual STAC items for specific event or observation records. | Consumer calls `GET /stac/collections/:id/items/:itemId`. | STAC Item with geometry, properties, and links returned in GeoJSON encoding. | `Live` | `src/stac.js:stacItem`, `GET /stac/collections/:id/items/:id`, `test/lite.test.js:Lindela Lite STAC` | Per-record geospatial access; needed for STAC-aware download clients. | P2 | No spatial filter on collection items list; returns all items. |
| JTBD-066 | STAC/OGC | GIS Consumer | Fetch an OGC API Features collection for spatial data processing in GIS tooling. | Consumer calls the OGC features endpoint for a specific collection. | OGC FeatureCollection returned with geometry and properties per record. | `Live` | `src/stac.js:ogcFeatureCollection`, `/ogc/` route in `src/server.js:65`, `test/lite.test.js:Lindela Lite STAC` | OGC API compliance for interoperability with QGIS, ArcGIS, and other OGC clients. | P2 | OGC API conformance declaration endpoint not confirmed. |
| JTBD-067 | Webhooks/Outbox | Administrator | Create a webhook subscription so an external system receives platform events when they are emitted. | Administrator calls `POST /api/v1/webhooks` with a target URL, event filter, and optional secret. | Webhook subscription stored; platform emits events to the outbox; dispatch sends signed payloads to subscriber. | `Live` | `src/webhooks.js:normalizeWebhookSubscription`, `POST /api/v1/webhooks`, `test/lite.test.js:Lindela Lite webhook event bus` | Integration bus; event routing by subscription filter. | P1 | No delivery confirmation loop; failed webhook deliveries are not currently surfaced as operational items. |
| JTBD-068 | Webhooks/Outbox | Operator / Scheduler | Dispatch all pending outbox events to registered webhook subscribers in a batch. | Operator or scheduler calls `POST /api/v1/outbox/dispatch`. | Pending events dispatched to matching subscriptions; delivery records written; delivered events cleared from pending queue. | `Live` | `src/outbox.js:dispatchPending`, `POST /api/v1/outbox/dispatch`, `test/lite.test.js:dispatches pending events to webhooks with mock fetch` | Background job candidate; max-batch and timeout parameters control delivery load. | P1 | No backoff or dead-letter queue for persistently failing webhook targets. |
| JTBD-069 | Webhooks/Outbox | Operator | Review the outbox queue to inspect pending or recently emitted events and confirm delivery state. | Operator opens `GET /api/v1/outbox`. | Outbox event records with event name, payload summary, and delivery status visible. | `Live` | `GET /api/v1/outbox`, `src/outbox.js:emit`, `test/lite.test.js:emits events to outbox` | Operational visibility into async event delivery; no per-event delivery history. | P2 | Outbox does not retain delivered event history; only pending events are inspectable post-dispatch. |
| JTBD-070 | Auth/RBAC | Administrator | Configure API key authentication to prevent unauthorized mutations in deployed environments. | Administrator sets `LINDELA_LITE_API_KEY` in environment before starting the service. | Mutating API requests without the correct key receive `401`; GET requests remain open; action log actor uses authenticated identity. | `Live` | `src/server.js:isAuthorizedMutation`, `LINDELA_LITE_API_KEY`, `test/lite.test.js:requires the configured API key for mutating requests` | Security gate; single shared key with no per-user identity. | P0 | Single shared key provides no per-user audit trail; any key holder has full write access. |
| JTBD-071 | Auth/RBAC | Administrator | Configure per-scope token authentication to grant different levels of access to different callers. | Administrator configures token-to-scope mapping; callers include Bearer token in requests. | Tokens with limited scopes (e.g., read-only, ingestion-only) accepted; out-of-scope requests rejected with `403`. | `Partial` | `src/auth.js:parseTokens`, `src/auth.js:authenticate`, `src/auth.js:requireScope`, `src/auth.js:scopeForRoute` | RBAC building block; multi-scope token system exists in code but no user management or token issuance UI. | P1 | Scope enforcement is wired in server.js but no token management API or admin UI exists. |
| JTBD-072 | Auth/RBAC | RapidPro Flow | Authenticate an inbound field-report webhook from a RapidPro flow using a shared secret, without requiring the general API key. | RapidPro flow includes `x-rapidpro-secret` or `Authorization: Bearer <secret>` header. | Inbound request authenticated with `RAPIDPRO_WEBHOOK_SECRET`; accepted independently of `LINDELA_LITE_API_KEY`. | `Live` | `src/rapidpro.js:verifyRapidProWebhook`, `src/server.js:174`, `test/lite.test.js:receives RapidPro webhook payloads as field reports` | Integration security gate; prevents spoofing of inbound field reports. | P0 | Secret is shared; no per-flow or per-contact authentication. |
| JTBD-073 | PII/Retention | Administrator | Configure a PII redaction policy so personal identifiers in field reports and inbound messages are masked before persistence or export. | Administrator provides a PII policy file; platform applies `redactPii` on write. | PII fields (names, phone numbers, contact UUIDs) masked according to policy; redacted records persisted. | `Partial` | `src/pii.js:redactPii`, `src/pii.js:loadPolicy`, no dedicated test for PII redaction confirmed | Privacy compliance gate; especially relevant for field report contact data. | P1 | Redaction policy loading exists but integration point in ingestion/field-report path is not confirmed from static inspection. |
| JTBD-074 | PII/Retention | Administrator | Apply retention policy to purge field reports and inbound RapidPro messages older than the configured retention period. | Administrator or scheduler calls `POST /api/v1/maintenance/apply-retention`. | Records older than `retentionDays` removed from `field_reports` and `rapidpro_inbound_messages`; remaining records written back to store. | `Partial` | `src/pii.js:applyRetention`, `POST /api/v1/maintenance/apply-retention`, `src/server.js:311`; no dedicated test confirmed | Data lifecycle compliance; critical for humanitarian data-protection obligations. | P0 | No audit log entry for retention application; no dry-run mode to preview what would be purged. |
| JTBD-075 | Observability | Administrator | Scrape the Prometheus-format metrics endpoint to monitor HTTP request volumes, error rates, and latency histograms. | Monitoring system scrapes `GET /metrics` or `GET /api/v1/metrics` on a polling interval. | Prometheus text-format metrics returned with request counters and latency histograms by route and status. | `Live` | `src/observability.js`, `GET /metrics`, `src/server.js:70` | Infrastructure observability; no alerting on metrics thresholds from within Lite. | P2 | Ingestion success/failure counters and report generation durations are not present as dedicated metrics. |
| JTBD-076 | Observability | Administrator | Review structured JSON request logs to trace slow, failed, or anomalous requests during an incident. | Administrator inspects log stream or output file while service is running. | JSON log lines with method, route, status, elapsed_ms, and contextual fields visible and filterable. | `Partial` | `src/observability.js:timer`, `src/server.js:logger.info`, no dedicated logging test | Log correlation with action logs is not standardized; no request-id propagation. | P2 | No request-id header or correlation token linking logs to action log entries. |
| JTBD-077 | Storage | Administrator | Select and configure the storage backend (JSON file, pg0 local PostgreSQL, or external PostgreSQL) for the deployment environment. | Administrator sets `LINDELA_LITE_DB_MODE` and `LINDELA_LITE_DATABASE_URL` environment variables before startup. | Service starts with the configured backend; health endpoint reports storage mode. | `Live` | `src/storage.js`, `src/pg0.js`, `src/postgres-store.js`, `test/lite.test.js:Lindela Lite storage modes` | Infrastructure configuration; `auto` mode degrades gracefully through backends. | P0 | `auto` mode selects backends silently; health endpoint surfaces mode but no startup warning if pg0 is unavailable. |
| JTBD-078 | Configuration | Administrator | Configure all required and optional environment variables for RapidPro, API key, storage mode, port, and scheduler settings. | Administrator edits `.env` file or deployment configuration before starting the service. | Service starts with correct settings; unconfigured integrations (RapidPro) degrade gracefully without crashing. | `Implied` | `docs/configuration.md`, `.env.example`, `deploy/one-click.sh` | Admin configuration flow; no interactive configuration UI or validation on startup. | P1 | Startup does not validate all required environment variables and fail fast with actionable errors. |
| JTBD-079 | CI/Release | Developer | Run the validation script to confirm that docs, OpenAPI spec, API reference, and deployment artifacts are internally consistent before publishing. | Developer runs `node scripts/validate.mjs` or CI pipeline runs it. | Validation passes; inconsistencies between OpenAPI spec and API docs reported as errors. | `Live` | `scripts/validate.mjs`, `test/lite.test.js:passes the docs and deployment validation script` | Release gate; part of CI pipeline (`ci.yml`). | P1 | Validation script scope not confirmed to cover all new routes added since v0.1.0. |
| JTBD-080 | CI/Release | Developer / CI | Run the full test suite to validate all routes, module functions, analytics, storage modes, and integrations before merging or releasing. | Developer runs `npm test` or CI triggers on push. | All test suites pass; coverage reported; no regressions. | `Live` | `test/lite.test.js`, `.github/workflows/ci.yml` | Quality gate; test file covers all major API routes, analytics, storage, reports, RapidPro, STAC, scenarios, and webhooks. | P0 | Test coverage for trigger protocols, PII, retention, lineage, and data lineage is not confirmed complete. |
| JTBD-081 | CI/Release | Administrator | Run the one-click deployment script to provision a local production-like stack with PostgreSQL, scheduler sidecar, and health verification. | Administrator runs `./deploy/one-click.sh` on the target host. | Stack starts; health check passes; default ingestion schedules initialized; service accessible on configured port. | `Partial` | `deploy/one-click.sh`, `deploy/verify-pg0.mjs`, `docs/deployment.md`; end-to-end deploy test not in test suite | Production deployment workflow; Docker image build and compose orchestration. | P1 | One-click script is not exercised by the test suite; failures are only discoverable at deploy time. |
| JTBD-082 | CI/Release | Release Maintainer | Publish a new version by updating CHANGELOG, SECURITY, and OpenAPI version, building a tagged Docker image, and confirming no regressions. | Maintainer cuts a release tag and triggers CI/CD pipeline. | Tagged release created; Docker image published; changelog entry added; version bump in package.json. | `Planned` | `CHANGELOG.md`, `SECURITY.md`, `README.md:Security And Releases`, `package.json`; no automated release pipeline confirmed | Release workflow; no automated versioning or release CI job visible. | P1 | No release CI job in `.github/workflows/`; process is manual. |
| JTBD-083 | Connector SDK | Developer | Define a new custom connector using the connector spec SDK with declared id, sources, options, and validation. | Developer creates a connector file using the spec API and calls `defineConnector`. | Connector spec validated; connector frozen and ready for use in ingestion runs. | `Live` | `src/connectors/spec.js`, `test/lite.test.js:Lindela Lite connectors SDK:exports spec, validates specs, rejects invalid specs, defines new connectors` | Extension point; connector spec validation prevents malformed connectors from entering the registry. | P2 | No automated test template for new connectors; spec validation is code-only. |
| JTBD-084 | Connector SDK | Developer | Load and use a custom connector from a user-supplied registry file in ingestion runs, without modifying built-in source code. | Developer places connector file at the registry path; calls ingestion run with the custom source id. | Custom connector resolved from registry; ingestion runs as with built-in connectors; source run recorded. | `Live` | `src/server.js:getConnectorRegistry`, `connectors.registry.json`, `test/lite.test.js:defines new connectors and freezes them` | Extension point; enables community connectors without forking. | P2 | Registry file is loaded at request time; no hot-reload or registry validation on startup. |
| JTBD-085 | Connector SDK | Contributor | Add a new built-in connector for a new public data source by implementing the connector spec and adding tests. | Contributor follows the extension-point pattern in `docs/architecture.md`. | New connector available as a built-in source id; ingestion run tested; schema and OpenAPI updated. | `Implied` | `docs/architecture.md:Extension Points`, `src/connectors/`, `CONTRIBUTING.md` | Ecosystem growth path; no connector contribution checklist or CI gate for new connector quality. | Strategic | No automated gate requiring test coverage for contributed connectors. |
| JTBD-086 | PWA/i18n | Operator | Install the Lite dashboard as a progressive web app on a mobile or desktop device for offline-capable access. | Operator opens the dashboard in a PWA-capable browser and installs from browser prompt. | PWA installed; service worker registered; manifest returned with correct name, icons, and start URL. | `Partial` | `public/manifest.webmanifest`, `/sw.js`, `test/lite.test.js:GET /manifest.webmanifest returns 200`, `test/lite.test.js:GET /sw.js returns 200` | Mobile-first field access; offline data access strategy not confirmed. | P2 | Service worker scope and offline caching strategy not verified from static inspection. |
| JTBD-087 | PWA/i18n | Operator | Use the dashboard in a non-English locale, with UI labels and messages translated via the i18n system. | Operator selects a locale; dashboard fetches `/i18n/<locale>.json` and applies translations. | UI labels displayed in the selected locale; RTL layout applied for Arabic and similar languages. | `Partial` | `src/i18n.js`, `GET /i18n/en.json`, `test/lite.test.js:GET /i18n/en.json`, `test/lite.test.js:t() translates`, `test/lite.test.js:isRtl() returns true for Arabic` | i18n system in place; only English locale confirmed from test coverage. | P2 | Only `en.json` locale file confirmed; other locales not verified to exist. |
| JTBD-088 | Dashboard | Operator | View an at-a-glance operational overview of current risks, open incidents, recent alerts, and data freshness in the dashboard. | Operator opens the dashboard root (`/`). | Dashboard renders with risk summary, incident counts, alert status, and source freshness panels. | `Partial` | `public/index.html`, `public/app.js`, `test/lite.test.js:falls back to the dashboard shell for unknown static routes` | Dashboard shell verified; panel content relies on API calls; implementation completeness not confirmed from static inspection. | P1 | Dashboard UI completeness cannot be verified without running the app. |
| JTBD-089 | Dashboard | Operator | Filter events, risks, incidents, or reports by country, date range, severity, or status to focus on relevant records. | Operator applies filter controls in the dashboard or passes query parameters to the API. | Filtered results returned; pagination handled; filter state preserved across navigation. | `Partial` | `src/utils.js:filterRecords`, used throughout API; dashboard filter UI not confirmed from static inspection | Cross-collection filtering is consistent at the API layer; dashboard filter state management unverified. | P1 | No URL-persistent filter state in the dashboard; refreshing resets filters. |
| JTBD-090 | Dashboard | Operator | Export all platform event and service data in GeoJSON or CSV format for use in external GIS tools or reporting. | Operator calls `GET /api/v1/export.geojson` or `GET /api/v1/export.csv`. | All events and service features returned as GeoJSON FeatureCollection or CSV respectively, with bbox filter support. | `Live` | `GET /api/v1/export.geojson`, `GET /api/v1/export.csv`, `test/lite.test.js:filters events and exports CSV and GeoJSON` | Bulk export; no authentication gate on GET exports even when API key is set. | P1 | Bulk GeoJSON and CSV exports are unauthenticated GET endpoints; may expose operational data unintentionally. |
| JTBD-091 | Search | Operator | Search for a specific incident, field report, or intervention by keyword or free-text content. | Operator enters a search term in the dashboard or API client. | Matching records returned ranked by relevance. | `Missing` | No full-text search endpoint found in `src/server.js`; `filterRecords` in `src/utils.js` is field-match only | Search workflow candidate; no implementation or plan found. | P1 | Without search, operators must scan full lists to locate specific records. |
| JTBD-092 | Auth/RBAC | Administrator | Manage multiple named users with different roles (reader, operator, reviewer, distributor) and enforce per-resource permissions. | Administrator creates user records and assigns scopes through an admin UI or API. | Each user authenticated with their own credentials; audit log records individual actor identity; permission violations rejected. | `Missing` | `src/auth.js` has scope functions but no user management API or identity store; `docs/architecture.md:Authentication Model` explicitly notes this is out of scope | Multi-user RBAC workflow; Lite design defers this to reverse proxy or gateway layer. | Strategic | Upstream proxy or gateway is recommended; no in-platform RBAC planned. |
| JTBD-093 | Operations | Operator | Link an alert event to an existing incident to create an explicit traceability chain from threshold breach to operational response. | Operator patches an alert event or incident to add a cross-reference id. | Alert event and incident linked; linked context visible in both records and in reports. | `Implied` | `src/operations.js:linkedContext`; incidents have `linked_event_id` and `risk_score_id` fields; no alert_event -> incident link endpoint confirmed | Traceability gap between alert lifecycle and incident lifecycle. | P1 | No `PATCH /api/v1/alert-events/:id` field for `incident_id`; linkage is one-directional. |
| JTBD-094 | Operations | Operator | Formally close or archive a resolved incident with an outcome summary and root-cause note. | Operator patches incident status to `closed` or `archived` and provides a summary. | Incident status updated; `closed_at` timestamp set; action log records actor and reason; incident removed from open count. | `Partial` | `PATCH /api/v1/incidents/:id` accepts status updates; no `closed_at` field or formal close workflow confirmed in `src/operations.js:normalizeIncident` | Terminal state workflow: closed incidents should be immutable and excluded from open counts. | P0 | No `closed_at` timestamp; no guard preventing reopening a closed incident without explicit reopen action. |
| JTBD-095 | Operations | Program Manager | Review intervention outcome metrics and whether success criteria were met at the point of completion. | Program manager reviews a completed intervention record or runs an intervention update report. | Completed intervention shows `outcome_summary`, `success_metrics`, `completed_at`, and linked task completion rate. | `Implied` | `src/operations.js:normalizeIntervention`; `success_metrics` and `outcome_summary` fields exist; no summary analytics or report section dedicated to outcome review | Workflow gate: require outcome evidence before marking an intervention complete. | P1 | No mandatory outcome summary gate; intervention can be marked completed with empty fields. |
| JTBD-096 | Reports | Operator | Export a report as a PDF for printing, email attachment, or offline archiving. | Operator chooses PDF export from the report detail view. | PDF file returned with formatted sections, headers, and source appendix. | `Planned` | `docs/reporting-prd.md:Future channels: PDF export` | Future distribution channel; no implementation exists. | P2 | Requires a PDF rendering dependency not currently in the project. |
| JTBD-097 | Reports | Response Lead | Distribute an approved report via SMTP email to configured recipients. | Response lead selects email channel in the distribute action. | Email sent with report summary body and attachment or link; distribution run recorded. | `Planned` | `docs/reporting-prd.md:Future channels: Email SMTP` | Future distribution channel; no implementation exists. | P2 | Requires an SMTP dependency and recipient management not currently present. |
| JTBD-098 | Observability | Data Officer | Receive an automatic notification when a source crosses a staleness threshold or consecutive failure count. | A source crosses the stale-after period or failure-streak limit while the platform is running. | Notification delivered to the data officer (email, SMS, webhook) with source name, last run time, and recommended action. | `Missing` | `src/ingestion.js:failureStreak`, `src/ingestion.js:ingestionStatus`; no notification emitter found for source health events | Notification/escalation candidate; staleness is computable but no event is emitted. | P1 | Staleness data exists but no event is emitted to the outbox or RapidPro when a source goes stale. |
| JTBD-099 | Reports | Response Lead | Generate a time-limited public link for an approved report so an external partner can read it without platform credentials. | Response lead requests a signed share URL for an approved report. | Signed URL created with expiry; partner can open report in browser without logging in. | `Planned` | `docs/reporting-prd.md:Future channels: Signed public report link` | External portal workflow; requires token-based URL signing and public report renderer. | Strategic | Requires public URL infrastructure and report rendering endpoint not currently present. |
| JTBD-100 | Data | Administrator | Perform bulk geocoding remediation to fill in missing latitude/longitude values on records that imported without coordinates. | Administrator identifies records with zero geocoding coverage in the data quality summary and triggers a remediation run. | Geocoding gaps reduced; affected records updated with resolved coordinates; data quality updated. | `Missing` | `src/analytics.js:computeDataQuality` tracks `geocode_coverage_pct`; no remediation endpoint or bulk geocoding tool found | Data remediation workflow; gap reported but no tooling provided to close it. | P2 | Geocoding remediation would require an external geocoding service or manual CSV upload. |

---

## Workflow Readiness Assessment

### Ingestion

- Existing lifecycle states: `success`, `degraded`, `failed` on `source_runs`; `active`, `paused`, `archived` on `ingestion_schedules`.
- Missing lifecycle states: no `queued` or `in_progress` state for running ingestions (runs appear only after completion).
- Existing transitions: manual run, scheduled run, pause, resume.
- Missing transitions: auto-pause after N consecutive failures; re-enable after corrective action.
- Existing gates: source id validation; region spec required.
- Missing gates: confidence threshold gate before analytics are applied; staleness gate before report generation.
- Existing tasks/assignments: none (ingestion is fire-and-forget from operator perspective).
- Missing task projections: "Investigate failing source" task when failure streak crosses threshold.
- Existing SLA/escalation support: none.
- Missing SLA/escalation support: stale-after timer with escalation notification.
- Existing notifications: none.
- Missing notifications: outbox event when source fails streak; webhook event on schedule completion.
- Existing audit evidence: `source_runs` records with diagnostics and errors; action logs for schedule changes.
- Missing audit evidence: no action log for `run-due` executions; no log of who initiated a manual run.

### Analytics

- Existing lifecycle states: no explicit state; analytics are regenerated on demand.
- Missing lifecycle states: `stale`, `current` flag on risk score sets to signal when re-generation is needed.
- Existing transitions: `refreshAnalytics` called after each ingestion run.
- Missing transitions: invalidation trigger when a key source goes stale.
- Existing gates: confidence score computed and reported.
- Missing gates: block downstream report generation or alert evaluation when confidence falls below a minimum.
- Existing tasks: none (analytics are automatic).
- Missing task projections: analyst review task when confidence score drops below acceptable threshold.
- Existing SLA: none.
- Missing SLA: freshness SLA on risk scores; warn when risk scores are older than a configurable limit.
- Existing notifications: none.
- Missing notifications: outbox event when risk level changes from low to high.
- Existing audit evidence: `generated_at` on risk scores; calibration report.
- Missing audit evidence: no record of who requested analytics refresh or what inputs were used.

### Alerts

- Existing lifecycle states: `open`, `acknowledged`, `resolved` on `alert_events`; `active`, `paused`, `archived` on `alert_rules`.
- Missing lifecycle states: `dispatched` on `alert_events` to track when SMS was sent; `suppressed` to record suppression decisions.
- Existing transitions: evaluate -> create event; acknowledge event; resolve event.
- Missing transitions: auto-escalate when event remains unacknowledged past a threshold; link event to incident.
- Existing gates: suppression bucket prevents duplicate events within a time window.
- Missing gates: human approval gate before dispatch for high-severity alerts; link-to-incident gate before resolution.
- Existing tasks: none.
- Missing task projections: "Acknowledge unresolved alert" tasks in operator work queue.
- Existing SLA: none.
- Missing SLA: acknowledgement SLA; escalation to response lead after N minutes without action.
- Existing notifications: RapidPro dispatch for alert events; declarative action targets.
- Missing notifications: outbox event when alert event is created; escalation notification for unacknowledged events.
- Existing audit evidence: `action_logs` for create/acknowledge/resolve; RapidPro dispatch records.
- Missing audit evidence: no reason code on acknowledgement or resolution; no actor recorded for evaluation runs.

### Trigger Protocols

- Existing lifecycle states: protocol records with backtest metadata; shadow-run result in memory.
- Missing lifecycle states: `draft`, `in_review`, `active`, `archived` on protocol records; backtest must precede activation.
- Existing transitions: create, update, backtest, shadow-run.
- Missing transitions: formal activate/deactivate with human sign-off; version history on update.
- Existing gates: shadow-run provides pre-activation validation without firing alerts.
- Missing gates: mandatory backtest gate before protocol can be activated; reviewer sign-off.
- Existing tasks: none.
- Missing task projections: "Review and approve trigger protocol" task for response lead.
- Existing SLA: none.
- Missing SLA: review SLA on submitted protocols.
- Existing notifications: none.
- Missing notifications: notification to response lead when a new protocol is submitted for review.
- Existing audit evidence: action logs on create/update/backtest.
- Missing audit evidence: shadow-run result not persisted; no record of who approved activation.

### Operations

- Existing lifecycle states: `open`, `monitoring`, `responding`, `closed`, `resolved`, `archived` (implied by PATCH); `planned`, `active`, `completed`, `cancelled` for interventions; `pending`, `in_progress`, `done`, `cancelled` for tasks; `available`, `reserved`, `deployed` for resources.
- Missing lifecycle states: `on_hold`, `escalated` for incidents; formal `reopened` state; `closed_at` timestamp.
- Existing transitions: create, update status fields via PATCH.
- Missing transitions: formal reopen with reason; formal close with outcome evidence gate; escalate with assigned reviewer.
- Existing gates: referenced incident/intervention must exist before creating child records.
- Missing gates: outcome evidence gate before marking interventions complete; task completion gate before closing incident.
- Existing tasks: `intervention_tasks` as operational records; no projection into a work queue system.
- Missing task projections: operator's personal task queue; overdue task detection; assignment notification.
- Existing SLA: `due_at` stored on tasks.
- Missing SLA: breach detection; escalation on overdue tasks; SLA dashboard.
- Existing notifications: none.
- Missing notifications: new task assigned; overdue task alert; high-priority field report received; incident escalated.
- Existing audit evidence: `action_logs` for all operational mutations.
- Missing audit evidence: reason codes on status transitions; before/after field diff on updates.

### RapidPro

- Existing lifecycle states: `sent`, `failed` on dispatches; `processed`, `error` on inbound messages.
- Missing lifecycle states: `pending_dispatch` state on alert events; `linked`, `unlinked` on inbound messages.
- Existing transitions: dispatch alert -> dispatch record; receive inbound -> field report creation.
- Missing transitions: retry dispatch automatically on failure; link inbound message to incident post-creation.
- Existing gates: webhook secret verification for inbound; alert event id must exist for dispatch.
- Missing gates: human approval gate for SMS dispatch to large groups; duplicate inbound detection.
- Existing tasks: none.
- Missing task projections: "Review unlinked inbound messages" as coordinator task; "Retry failed dispatch" as operator task.
- Existing SLA: none.
- Missing SLA: inbound message processing SLA; dispatch retry timing.
- Existing notifications: none (RapidPro itself sends SMS outbound; platform receives inbound).
- Missing notifications: internal notification when a high-priority inbound field report arrives.
- Existing audit evidence: dispatch records with request/response; inbound message records.
- Missing audit evidence: no reason on dispatch failure; no actor recorded on manual dispatch.

### Reports

- Existing lifecycle states: `draft`, `ready`, `approved`, `distributed`, `archived` on reports; `active`, `paused`, `archived` on templates and schedules.
- Missing lifecycle states: `pending_approval` with an assigned reviewer; `recalled` for post-distribution corrections.
- Existing transitions: create -> generate -> approve -> distribute; schedule create -> run-due -> run -> report.
- Missing transitions: reject (send back to draft from ready); recall after distribution; re-approve after edit.
- Existing gates: distribution only on `ready` or `approved` reports; `approved` reports are immutable.
- Missing gates: stale data blocking gate before approval; mandatory reviewer sign-off; section completeness gate.
- Existing tasks: none.
- Missing task projections: "Review and approve report" task for response lead; "Distribute report" reminder.
- Existing SLA: none.
- Missing SLA: report approval SLA; distribution freshness window.
- Existing notifications: none.
- Missing notifications: report ready for approval notification; scheduled report failure alert; distribution failure alert.
- Existing audit evidence: action logs for all report lifecycle actions; distribution run records; source refs in reports.
- Missing audit evidence: reason on approval or rejection; before/after on report edits.

---

## First-Class Workflow Candidates

| Candidate Workflow | Source JTBD IDs | Subject | Why First-Class | Initial States | Terminal States | Key Gates | Priority |
|---|---|---|---|---|---|---|---|
| Incident Response | JTBD-030, 031, 032, 033, 034, 035, 036, 037, 038, 039, 040, 093, 094, 095 | `incidents` | Central operational object; all response activity (interventions, tasks, field reports, resources) depends on incident state; currently no enforced lifecycle. | `open` | `closed`, `archived` | Risk or event linkage on creation; outcome evidence gate before close; reopen with reason. | P0 |
| Alert Lifecycle | JTBD-020, 021, 022, 023, 024, 042, 043, 093 | `alert_events` | Alert events bridge the analytics layer to operational response; currently missing acknowledgement SLA, dispatch gate, and incident linkage. | `open` | `resolved`, `suppressed` | Human dispatch gate for high-severity; acknowledgement SLA; link to incident before resolution. | P0 |
| Report Production | JTBD-047, 050, 051, 052, 053, 054, 055, 056, 057 | `reports` | Multi-step approval and distribution workflow; currently linear transitions exist but no reviewer assignment, SLA, or rejection path. | `draft` | `distributed`, `archived` | Stale data gate before approve; reviewer sign-off before distribute; immutability after approve. | P0 |
| Trigger Protocol Activation | JTBD-026, 027, 028, 029 | `trigger_protocols` | High-impact configuration change requiring backtest evidence and human sign-off before activation; currently no formal review gate. | `draft` | `active`, `archived` | Backtest required before review; shadow-run before activation; reviewer approval. | P1 |
| Ingestion Health Recovery | JTBD-006, 009, 098 | `ingestion_schedules` + `source_runs` | Source failures silently accumulate; operators need a structured path from failure detection to corrective action. | `failure_detected` | `resolved`, `paused` | Failure streak threshold triggers task; operator acknowledges and acts; recovery confirmed by success run. | P1 |
| RapidPro Inbound Triage | JTBD-044, 045 | `rapidpro_inbound_messages` | Unlinked inbound messages become orphan field reports; coordinator needs a structured review and link workflow. | `unlinked` | `linked`, `discarded` | Message parsed and held; coordinator assigns to incident; field report confirmed. | P1 |
| Scheduled Report Execution | JTBD-058, 059, 060, 061 | `report_schedules` | Recurring report runs need failure handling, retry, and notification; currently runs are silent when they fail. | `scheduled` | `completed`, `failed` | Template must exist and be active; stale data check before generate; failure notification. | P1 |

---

## Operational Task Candidates

Tasks that should be projected into an operator's work queue when triggered by a system event:

| Task | Trigger | Actor | Blocking Condition | JTBD IDs |
|---|---|---|---|---|
| Investigate failing source | Source failure streak crosses threshold N | Data Officer | Source is used in active alert rules or recent reports | JTBD-006, 009, 098 |
| Acknowledge unresolved alert event | Alert event open for more than T minutes | Operator / Response Lead | Alert event is `open` and unacknowledged | JTBD-023, 024 |
| Review and link inbound field report | New inbound RapidPro message with no incident id | Field Coordinator | Message has no `incident_id` or `intervention_id` | JTBD-044, 045 |
| Review and approve report | Report status advances to `ready` | Response Lead | Report is `ready` but not yet `approved` | JTBD-052, 053 |
| Retry failed distribution run | Distribution run status is `failed` | Operator | Run has `error` set and `retry_of` is null | JTBD-057 |
| Close completed intervention | Intervention status is `completed` but outcome summary is empty | Program Manager | `outcome_summary` is blank | JTBD-033, 095 |
| Review overdue task | Task `due_at` has passed and status is not `done` | Operator | Task is overdue | JTBD-035 |
| Apply retention after retention period | N days since last retention application | Administrator | `field_reports` or `rapidpro_inbound_messages` contain records older than policy | JTBD-074 |

---

## Checklist / Evidence Gate Candidates

Gates that should block a lifecycle transition until specific evidence conditions are met:

| Gate | Point in Lifecycle | Evidence Required | Collections Checked | JTBD IDs |
|---|---|---|---|---|
| ACLED license acceptance | Before `acled_csv` ingestion | `acled_license_accepted=true` in request | Connector options | JTBD-007 |
| Minimum source freshness before report approve | `draft` -> `approve` | All required sources have run within `stale_after_minutes` | `data_quality`, `source_runs` | JTBD-013, 053 |
| Backtest evidence before trigger protocol activation | `draft` -> `active` | `backtest.last_run_at` is set and result has non-zero evaluation | `trigger_protocols` | JTBD-028 |
| Outcome evidence before intervention close | `active` -> `completed` | `outcome_summary` is non-empty | `interventions` | JTBD-033, 095 |
| Section completeness before report approval | `ready` -> `approved` | All selected sections have `content` and `generated_at` | `reports.sections` | JTBD-051, 053 |
| Human approval before high-severity SMS dispatch | Before `POST /rapidpro/alert-events/:id/send` | Alert event severity is `critical` or `high`; manual approval flag set | `alert_events` | JTBD-042 |
| Report status before distribution | Before `POST /reports/:id/distribute` | Report status is `ready` or `approved` | `reports` | JTBD-055 |

---

## Admin Rule / Configuration Candidates

Configuration objects that should be managed as versioned, auditable rules rather than raw environment variables:

| Rule Type | Current Mechanism | Desired Mechanism | JTBD IDs |
|---|---|---|---|
| Alert rule | API-managed `alert_rules` records | Already an API-managed record; add version history on update | JTBD-020, 021 |
| Trigger protocol | API-managed `trigger_protocols` records | Versioning and activation audit trail needed | JTBD-026, 027 |
| Ingestion schedule | API-managed `ingestion_schedules` records | Already managed; add auto-pause rule for failure streaks | JTBD-003, 009 |
| Report schedule | API-managed `report_schedules` records | Already managed; add failure-notification rule | JTBD-058 |
| PII redaction policy | File-based `pii-policy.json` loaded at startup | Convert to API-managed policy with version history and audit | JTBD-073 |
| Retention policy | File-based loaded in `pii.js:loadPolicy` | API-managed policy with dry-run mode and audit log | JTBD-074 |
| RapidPro configuration | Environment variables only | Admin API to validate and test configuration without restarting service | JTBD-041, 078 |
| Storage backend | Environment variables only | Health endpoint already exposes mode; add startup validation with actionable error messages | JTBD-077 |

---

## Notification / Escalation Candidates

Events that should emit a notification but currently do not:

| Event | Recipient | Channel | Urgency | JTBD IDs |
|---|---|---|---|---|
| Alert event created (open, high severity) | Response Lead | Outbox event, RapidPro, or webhook | High | JTBD-022, 023 |
| Alert event unacknowledged past SLA | Response Lead | Outbox event or webhook | High | JTBD-024 |
| Source failure streak crossed threshold | Data Officer | Outbox event or webhook | Medium | JTBD-009, 098 |
| Source staleness threshold crossed | Data Officer | Outbox event or webhook | Medium | JTBD-006, 098 |
| High-priority field report received | Operator / Response Lead | Outbox event | High | JTBD-036, 044 |
| Report scheduled run failed | Program Manager | Outbox event | Medium | JTBD-059, 060 |
| Report ready for approval | Response Lead | Outbox event | Medium | JTBD-053 |
| Distribution run failed | Operator | Outbox event | Medium | JTBD-056 |
| New inbound message with no incident linkage | Field Coordinator | Outbox event | Medium | JTBD-044, 045 |
| Task overdue | Task owner | Outbox event | Medium | JTBD-035 |

All of these are candidates for the existing outbox/webhook event bus (`src/outbox.js:emit`) with `dispatchPending` delivering to subscribed external systems.

---

## Background Job Candidates

HTTP-callable background jobs that should be run on a schedule by an external scheduler:

| Job | Endpoint | Frequency | Failure Behavior | JTBD IDs |
|---|---|---|---|---|
| Run due ingestion schedules | `POST /api/v1/ingest/run-due` | Every 15-60 min, per schedule intervals | Record failure in `source_runs`; continue siblings | JTBD-004 |
| Evaluate alert rules | `POST /api/v1/alerts/evaluate` | Configurable; after each ingestion run is natural | Record alert events; suppression prevents storms | JTBD-022 |
| Dispatch outbox events | `POST /api/v1/outbox/dispatch` | Every 5-15 min | Failed delivery retained; no dead-letter queue yet | JTBD-068 |
| Run due report schedules | `POST /api/v1/report-schedules/run-due` | Per schedule recurrence (daily, weekly) | Record failure in `report_schedule_runs`; continue siblings | JTBD-059 |
| Apply retention policy | `POST /api/v1/maintenance/apply-retention` | Daily or per policy period | Partial apply still writes back; no dry-run | JTBD-074 |

---

## External Portal Workflow Candidates

Jobs involving actors who have no direct platform access and need a controlled interaction channel:

| Candidate | External Actor | Access Mechanism | What They Need | Missing | JTBD IDs |
|---|---|---|---|---|---|
| Field report submission via SMS | Field Agent | RapidPro SMS flow -> webhook | Submit structured field updates from the field | SMS parsing is brittle for unstructured messages; no message acknowledgement back to sender | JTBD-044, 045 |
| Report receipt by external partner | External Partner | Webhook payload or RapidPro SMS summary | Receive operational reports without platform access | No signed URL or public report link; webhook requires recipient to operate a server | JTBD-055, 062, 099 |
| Data download by GIS consumer | Data Consumer | STAC API, OGC API, GeoJSON/CSV export | Spatial data in standard formats | No spatial search; no access control on exports | JTBD-063, 064, 065, 066, 090 |
| Alert receipt by downstream system | Webhook Consumer | CAP XML endpoint, outbox webhook | Machine-readable alert events | No push; CAP consumer must poll; no webhook subscription for new CAP events | JTBD-025, 067 |

---

## Gaps, Overlaps, And Duplications

### Jobs Mentioned In Docs But Absent From Code

- **PDF export**: specified in `docs/reporting-prd.md` as a future channel; no implementation in `src/reports.js` or `src/server.js`.
- **Email SMTP distribution**: specified in `docs/reporting-prd.md`; no SMTP integration found.
- **Google Drive/Docs distribution**: specified in `docs/reporting-prd.md`; no implementation.
- **Signed public report links**: specified in `docs/reporting-prd.md`; no URL-signing logic found.
- **In-process optional scheduler** (`LINDELA_LITE_SCHEDULER=1`): mentioned in reporting PRD as future; not implemented.
- **Auto-pause schedule after failure streak**: mentioned in ingestion architecture as a reliability principle; not automated.
- **STAC search endpoint** (`/stac/search`): implied by STAC specification; not implemented.

### Code Capabilities Absent From Docs

- `src/auth.js` scope-based multi-token authentication is implemented but not documented in `docs/api.md` or `docs/architecture.md` auth section.
- `src/scenarios.js` scenario workbench with encoded tokens is implemented and tested but not in `docs/api.md`.
- `src/lineage.js:recordLineage` data lineage collection exists but `docs/api.md` does not document `GET /api/v1/data-lineage`.
- `src/cap.js` CAP 1.2 rendering is implemented and tested but not mentioned in `docs/api.md`.
- `src/analytics/ensemble.js` ensemble statistics are implemented and tested but not described in `docs/architecture.md`.
- `POST /api/v1/analytics/bias-correct` exists and is tested but not in `docs/api.md`.
- `GET /api/v1/impact/population-at-risk` and `/facilities-at-risk` exist and are tested but not listed in `docs/api.md`.
- `src/pii.js` and `POST /api/v1/maintenance/apply-retention` are implemented but not in `docs/api.md`.
- Webhook subscription routes (`/api/v1/webhooks`) and outbox routes exist but are not in `docs/api.md`.
- `POST /api/v1/trigger-protocols` family is implemented but not in `docs/api.md`.
- `GET /api/v1/connectors` registry endpoint exists but not in `docs/api.md`.

### Duplicate Concepts In Multiple Places

- `filterRecords` filtering logic is applied both in route handlers and through query params; no centralized filtering contract.
- `actionLog` is called in both `src/operations.js` and inline in `src/server.js` route handlers; two call sites produce log entries with inconsistent actor fields.
- `enumValue`, `required`, `isoDate`, `arrayValue`, and `objectValue` normalization helpers are duplicated across `operations.js`, `reports.js`, `alerts.js`, and `ingestion.js`.
- `findById` is defined independently in both `operations.js` and `reports.js`.

### UI Actions Without Backend Support

- Dashboard report detail view is specified in PRD (sections, source refs, distribution history) but backend support completeness for section-level source reference display is not confirmed from static inspection.
- Dashboard filter state persistence across page reloads has no backend or localStorage mechanism confirmed.
- Inbound message re-linkage (assign orphan message to correct incident) has no backend endpoint.

### Backend Routes Without UI Support

- `POST /api/v1/trigger-protocols/:id/backtest` and `/shadow-run` have no dashboard UI.
- `POST /api/v1/analytics/bias-correct` has no dashboard UI.
- `POST /api/v1/outbox/dispatch` has no dashboard UI.
- `POST /api/v1/maintenance/apply-retention` has no dashboard UI.
- `GET /api/v1/connectors` registry has no dashboard UI.
- STAC and OGC API endpoints have no dashboard representation.

### Workflows Without Task Projection

- Alert event open and unacknowledged: no task created.
- Source failure streak: no task created.
- Overdue intervention task: no escalation or task created.
- High-priority inbound field report: no coordinator task created.
- Report ready for approval: no reviewer task created.

### Notifications Without Action Targets

- Alert rule evaluation produces `alert_events` with declarative `actions` fields; Lite does not dispatch those actions.
- Outbox events are emitted but only dispatched when `POST /api/v1/outbox/dispatch` is called manually or by a scheduler.
- No notification is sent when a source goes stale, when a task is overdue, or when a scheduled report fails.

### Audit Events Missing Reason Or Evidence

- Status transitions on incidents, interventions, and tasks record a mutation in action_logs but do not capture the reason code, the previous status, or the supporting evidence.
- Alert event acknowledgement does not require a note (note is optional in `updateAlertEvent`).
- Report approval does not record a reviewer statement or evidence.
- Trigger protocol backtest result is attached to the protocol record but the shadow-run result is not persisted.

### Domain Statuses That Should Be Normalized Into Workflow States

- Incident statuses (`open`, `monitoring`, `responding`, `closed`) are free strings; any string is accepted by PATCH; no enforcement of legal transitions.
- Intervention statuses (`planned`, `active`, `completed`, `cancelled`) are validated by `enumValue` but no transition graph exists.
- Task statuses (`pending`, `in_progress`, `done`, `cancelled`) have the same issue.
- Resource statuses (`available`, `reserved`, `deployed`) are field values with no transition logic.

---

## Recommended Workflow Expansion Roadmap

### P0: Control And Correctness

**P0-A: Incident Lifecycle Workflow**
- Related JTBDs: JTBD-030, 031, 032, 033, 034, 035, 039, 040, 093, 094
- Why it matters: Incidents are the central operational object; uncontrolled status transitions and missing `closed_at` timestamps undermine audit integrity and dashboard accuracy.
- Implementation shape: Add a transition table in `src/operations.js`; validate `status` transitions server-side; add `closed_at` on close; require reason code on status change; emit outbox event on status change.
- Dependencies: Outbox event bus (already exists); `src/operations.js` refactor.
- Acceptance criteria: Illegal transitions return `400`; action log records previous status, new status, actor, reason, and timestamp; closed incidents are excluded from open counts.

**P0-B: Alert Event Acknowledgement SLA And Escalation**
- Related JTBDs: JTBD-022, 023, 024
- Why it matters: Unacknowledged alert events are the primary signal that something needs operational response; without SLA and escalation, they silently accumulate.
- Implementation shape: Add `acknowledged_deadline` field computed from severity; emit outbox event when deadline passes; project "Acknowledge alert" task for response lead.
- Dependencies: Outbox event bus; scheduler for periodic check; JTBD-P0-A.
- Acceptance criteria: Alert events past deadline appear in a "needs escalation" view; outbox event emitted; action log records escalation.

**P0-C: Report Approval Gate With Stale Data Block**
- Related JTBDs: JTBD-013, 051, 053
- Why it matters: Reports with stale sources are distributed as if they reflect current conditions; data quality warnings are advisory only.
- Implementation shape: In `approveReport`, check `data_quality` records; block approval when any required source has confidence below a configurable minimum or is stale beyond threshold; return structured error with source details.
- Dependencies: `src/reports.js:approveReport`; `src/analytics.js:computeDataQuality`.
- Acceptance criteria: Approval returns `409` with source freshness details when gate fails; gate can be overridden with explicit `force_approve: true` and a required note.

**P0-D: Human Dispatch Gate For High-Severity SMS**
- Related JTBDs: JTBD-042, 046
- Why it matters: High-severity or critical alert SMS can reach hundreds of contacts; an accidental or premature dispatch is operationally harmful.
- Implementation shape: Add `approved_for_dispatch: false` flag on `alert_events`; require explicit `POST /api/v1/alert-events/:id/approve-dispatch` before `send` is permitted for high-severity events; record approving actor.
- Dependencies: `src/server.js:handleRapidProRoute`; `src/alerts.js`.
- Acceptance criteria: Attempt to dispatch unapproved high-severity event returns `403`; approval action logged; test covers both paths.

### P1: Operational Completeness

**P1-A: Source Failure Streak Notification**
- Related JTBDs: JTBD-006, 009, 098
- Why it matters: Operators have no visibility when a source goes stale; stale data silently degrades risk scores and reports.
- Implementation shape: After `runDueIngestionSchedules`, emit `source.failure_streak_crossed` outbox event when a source crosses a configurable threshold; webhook subscribers receive the event.
- Dependencies: `src/outbox.js:emit`; `src/ingestion.js:failureStreak`.
- Acceptance criteria: Outbox event emitted on streak threshold; event includes source name, streak count, last error; test covers emission.

**P1-B: Trigger Protocol Formal Review Flow**
- Related JTBDs: JTBD-026, 027, 028, 029
- Why it matters: Trigger protocols are high-impact configuration objects; unreviewed protocols can cause alert storms or silences.
- Implementation shape: Add `lifecycle_status: draft | in_review | active | archived` field; require backtest before transitioning to `in_review`; require explicit activation action; persist shadow-run results.
- Dependencies: `src/alerts.js:normalizeTriggerProtocol`; add tests.
- Acceptance criteria: Protocol cannot be activated without a backtest result; activation is a separate action from creation; tests cover lifecycle enforcement.

**P1-C: Inbound Message Re-linkage Endpoint**
- Related JTBDs: JTBD-045
- Why it matters: Unlinked inbound messages become orphan holding incidents that are never resolved.
- Implementation shape: Add `PATCH /api/v1/rapidpro/inbound/:id` to update `incident_id` or `intervention_id` on an inbound message record; update linked field report.
- Dependencies: `src/server.js:handleRapidProRoute`.
- Acceptance criteria: Patch updates both inbound message and linked field report; action log records coordinator actor and previous/new linkage.

**P1-D: Report Scheduled Run Failure Notification**
- Related JTBDs: JTBD-058, 059, 060
- Why it matters: Scheduled reports run silently; operators only discover failures by polling the schedule run history.
- Implementation shape: Emit `report_schedule.run_failed` outbox event after a failed `runReportSchedule`; include schedule id, template name, and error.
- Dependencies: `src/outbox.js:emit`; `src/server.js:runReportSchedule`.
- Acceptance criteria: Outbox event emitted on failure; test covers event emission and content.

**P1-E: Operator Task Work Queue**
- Related JTBDs: JTBD-034, 035, 023, 036
- Why it matters: Tasks and alerts are actionable items without any assignment-notification or aggregated work queue; operators must inspect multiple endpoints to find their work.
- Implementation shape: Add `GET /api/v1/work-queue` that aggregates open alert events (unacknowledged), overdue tasks assigned to the caller, unlinked inbound messages, and pending distribution retries.
- Dependencies: `src/operations.js`; `src/alerts.js`; `src/server.js`.
- Acceptance criteria: Work queue returns items from multiple collections; filterable by actor; empty result for no pending work.

### P2: Efficiency And Ergonomics

**P2-A: Keyword Search Across Operational Records**
- Related JTBDs: JTBD-091
- Why it matters: Operators with many records cannot locate specific incidents or field reports without scrolling.
- Implementation shape: Add `GET /api/v1/search?q=<term>&collections=incidents,field_reports` with application-side text matching across title, description, and summary fields; PostgreSQL mode can use `to_tsvector` for better performance.
- Dependencies: `src/utils.js`; `src/postgres-store.js`.
- Acceptance criteria: Search returns matching records from all requested collections; results include collection type and record id; test covers cross-collection results.

**P2-B: Retention Policy Dry-Run Mode**
- Related JTBDs: JTBD-074
- Why it matters: Retention application is irreversible; operators need to preview what would be purged before committing.
- Implementation shape: Add `dry_run=true` query parameter to `POST /api/v1/maintenance/apply-retention`; return counts of records that would be purged without writing changes.
- Dependencies: `src/pii.js:applyRetention`; `src/server.js`.
- Acceptance criteria: Dry-run returns `{ would_purge: { field_reports: N, rapidpro_inbound_messages: M } }` without modifying the store; test covers dry-run output.

**P2-C: Bias Correction Integration Into Ingestion**
- Related JTBDs: JTBD-014
- Why it matters: Bias correction is callable but is not applied automatically during ingestion; operators must call it manually and results are not reflected in risk scores.
- Implementation shape: Add optional `bias_correct: true` flag to `POST /api/v1/ingest/run`; apply `biasCorrectClimate` to CHIRPS/OpenMeteo observations before storing; record bias-correction metadata in `source_runs.diagnostics`.
- Dependencies: `src/analytics/downscaling.js`; `src/ingestion.js:runIngestion`.
- Acceptance criteria: When enabled, bias-corrected values are stored; diagnostics record correction applied; test covers round-trip.

### Strategic: Ecosystem Expansion

**Strategic-A: Multi-User RBAC**
- Related JTBDs: JTBD-092
- Why it matters: Single API key prevents individual audit trails and role-differentiated access; required for team deployments.
- Implementation shape: Introduce token issuance API; map tokens to named principals and scopes; propagate principal through action logs; scope enforcement via existing `src/auth.js`.
- Dependencies: Identity store; `src/auth.js` already provides scope enforcement.
- Acceptance criteria: Each user has a distinct token; action logs record user identity; scope violations return `403` with principal and required scope.

**Strategic-B: Signed Public Report Links**
- Related JTBDs: JTBD-099, 062
- Why it matters: External partners cannot receive reports without a server to receive webhooks; signed URLs enable controlled read access.
- Implementation shape: Add `POST /api/v1/reports/:id/share` to generate a time-limited HMAC-signed URL; add `GET /api/v1/reports/shared/:token` to serve the report without authentication.
- Dependencies: Token signing key in environment; `src/reports.js:renderReportMarkdown`.
- Acceptance criteria: Signed URL expires; expired token returns `410`; report is readable without authentication via valid token.

**Strategic-C: STAC Search Endpoint**
- Related JTBDs: JTBD-063, 064, 065
- Why it matters: STAC-aware clients expect a search endpoint for cross-collection spatial and temporal queries.
- Implementation shape: Add `POST /stac/search` following the STAC API Search specification; support `bbox`, `datetime`, `collections`, and `limit` parameters.
- Dependencies: `src/stac.js`; spatial filtering in `src/utils.js`.
- Acceptance criteria: Search returns valid STAC FeatureCollection; `bbox` and `datetime` filters work; conformance declaration updated.

**Strategic-D: Connector Contribution Pipeline**
- Related JTBDs: JTBD-085
- Why it matters: Community growth depends on a clear, low-friction path to contribute and maintain connectors.
- Implementation shape: Add a connector contribution checklist to `CONTRIBUTING.md`; add a CI gate requiring connector spec validation, a test fixture, and OpenAPI documentation for any new source id.
- Dependencies: `src/connectors/spec.js:validateSpec`; CI pipeline.
- Acceptance criteria: PR with a new connector without a spec-validated test is rejected by CI; checklist is public.

---

## Definition Of Done For A Workflow-Backed JTBD

A JTBD is considered fully supported by the workflow system when all of the following are true:

1. **Canonical subject exists.** The primary record type (e.g., `incidents`, `alert_events`, `reports`) is stored in a named collection with a stable `id`.
2. **States and terminal states are explicit.** Allowed status values are enumerated; at least one terminal state exists (e.g., `closed`, `resolved`, `archived`).
3. **Legal transitions are explicit.** A transition table or guard function enforces which status changes are legal; illegal transitions return a structured error.
4. **Permissions are enforced server-side.** The action requires at minimum API key authentication; high-impact actions require an additional approval scope or flag.
5. **Required data/documents/evidence are modeled.** Evidence fields (reason code, outcome summary, source refs) are defined in the collection schema and validated at the gate.
6. **Waivers and reason codes are modeled.** Gates can be overridden with an explicit force flag and a mandatory reason; the override is recorded.
7. **SLA, pause, breach, and escalation behavior exists.** Deadlines are stored; breach detection emits an outbox event; escalation target is configured.
8. **Tasks project into the user's work queue.** When a workflow reaches a state requiring human action, a task appears in the operator's work queue (`GET /api/v1/work-queue` or equivalent).
9. **Notifications are actionable.** Outbox events contain enough information for a subscriber to take action without additional API calls.
10. **Audit trail records actor, reason, before/after, evidence, and timestamp.** Action log entry includes: `actor`, `action`, `collection`, `record_id`, `previous_status`, `new_status`, `reason`, `evidence_refs`, `created_at`.
11. **UI shows current state, owner, next action, blockers, deadline, and history.** Dashboard panel for the subject shows all of these without requiring the operator to navigate multiple screens.
12. **Tests cover happy path, blocked path, authority failure, SLA breach, and reversal/reopen.** All five paths have named test cases in `test/lite.test.js` or a dedicated test file.
13. **UI exists to perform the task and implied tasks.** Dashboard actions for all lifecycle transitions are present; no transition is API-only without a corresponding dashboard affordance.

---

## Sources Inspected

| Source | Notes |
|---|---|
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/README.md` | Platform overview, source ids, feature summary |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/architecture.md` | Module map, data flow, auth model, extension points |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/api.md` | Endpoint listing and examples |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/data-model.md` | Collection schema, relationships, field definitions |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/operations.md` | Operations workflow description and safety notes |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/rapidpro.md` | RapidPro configuration, inbound/outbound workflow |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/docs/reporting-prd.md` | Full reporting PRD with phases, acceptance criteria, open questions |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/server.js` | Route matching, handler functions, auth gates (grepped for function names, route patterns, and imports) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/alerts.js` | Alert rule normalization, event evaluation, trigger protocol, backtest, shadow-mode (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/analytics.js` | Risk score computation, service impact, data quality, calibration (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/operations.js` | Incident, intervention, task, field report, resource normalization, action log (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/ingestion.js` | Source registry, ingestion run, schedule management, status, retry (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/reports.js` | Template, report, section generation, export, distribution, schedule (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/rapidpro.js` | Outbound alert, report SMS summary, inbound parse, dispatch record (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/stac.js` | STAC catalog, collection, item, OGC feature collection (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/cap.js` | CAP 1.2 XML rendering (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/scenarios.js` | Scenario run, encode/decode token (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/webhooks.js` | Webhook subscription normalization, event matching, payload signing (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/outbox.js` | Event emission, pending dispatch (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/pii.js` | PII redaction, retention application, policy loading (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/lineage.js` | Data lineage recording (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/observability.js` | Metrics and timer (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/auth.js` | Token parsing, authentication, scope enforcement, route scope mapping (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/analytics/downscaling.js` | Quantile mapping, bias correction (function signatures) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/src/connectors/` | Built-in connectors: chirps, gdacs, glofas, nasa-firms, open-meteo, uploads, spec, http (directory listing) |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/test/lite.test.js` | Test suite: describe and it block names grepped for all domains |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/.github/workflows/ci.yml` | CI pipeline existence confirmed |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/deploy/` | one-click.sh, verify-pg0.mjs confirmed |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/scripts/` | validate.mjs confirmed |
| `/Users/nyimbiodero/src/pjs/Lindela-Lite/examples/trigger-protocols/` | Trigger protocol example JSON confirmed |

---

## Caveats

- **Static inspection only.** This catalogue was produced entirely from reading source files, function signatures, test descriptions, and documentation. No tests were run and the application was not started. Status assignments of `Live` mean that code and a route and at least one test description exist; they do not mean that the behavior was observed at runtime.
- **Test description coverage.** Test case presence was determined by grepping `describe` and `it` call text, not by reading test bodies. A test whose description matches the feature may be incomplete or contain known failures.
- **UI completeness.** Dashboard UI completeness (`public/app.js`, `public/index.html`) was not confirmed by running or rendering the frontend. UI status claims are based on file existence and API surface inference.
- **Trigger protocol tests.** No explicit trigger-protocol test case names were found in the grep output from `test/lite.test.js`; these features are marked `Partial` accordingly.
- **PII and retention.** No dedicated test names for PII redaction or retention application were found; these are marked `Partial`.
- **New files may have been added.** The git status at session start shows several untracked source files (`src/alerts.js`, `src/operations.js`, `src/rapidpro.js`, `src/reports.js`). These were inspected by function-signature grep. Their complete integration path was inferred from server.js imports, not from reading full file bodies.
- **Action log completeness.** The claim that action logs cover all mutations is based on pattern-matching `actionLog` calls in server.js and operations.js, not on exhaustive audit.
