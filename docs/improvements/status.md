# Enhancement status

What has actually shipped, verified against the tree rather than against the commit log.
Regenerate with `node docs/improvements/_build-status.mjs` after editing any
`_status-*.json`.

**2 shipped, 11 partial, 17 not started,** of 30.
The two shipped are the two the project was built to make possible anyway: the API
substrate a caller can integrate against (`ENH-30`) and a way to get your own data in
(`ENH-25`).

A status is **partial** when some of the described change is in the tree and the rest is
not, and the detail says which is which. An exported function with no call site is not
shipped: three of the chart library's six primitives are exported, tested, and called by
nothing in the product.

---
## Group A — Trust: make the honesty reach the payload

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-01 | Deny-by-default authorization from an explicit route→scope table | partial | `test/auth-deny-by-default.test.js` |
| ENH-02 | Honesty envelopes on every numeric response, policed in CI | partial | `test/flood-score-honesty.test.js` |
| ENH-03 | Per-region calibration and a trust score | **not started** | — |
| ENH-04 | Three tiers of uncertainty on every number | partial | `test/flood-score-honesty.test.js` |
| ENH-05 | Model-drift monitoring | **not started** | — |

## Group B — Ingestion fidelity, quality, timeliness

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-06 | Freshness SLAs by cadence, with an `ok \| quiet \| stale \| broken` verdict | **not started** | — |
| ENH-07 | Per-source data assertions with quarantine-on-fail | **not started** | — |
| ENH-08 | Watermarks, incremental fetch, resumable backfill | **not started** | — |
| ENH-09 | Source-agreement cross-validation | **not started** | — |
| ENH-10 | Connector health scoring and circuit breaking | **not started** | — |
| ENH-11 | Enforce the rate limits that are already declared | partial | `test/rapidpro-webhook-auth.test.js` |
| ENH-12 | Raw payload retention, replay, and fixture seeding | **not started** | — |
| ENH-13 | Bitemporal records | **not started** | — |
| ENH-14 | Completeness tripwires for capped pagination | **not started** | — |
| ENH-15 | Record-level provenance with real transform versions | **not started** | — |

## Group C — Visualization depth

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-16 | A chart component library, shared by all eight surfaces | partial | `test/charts.test.js` |
| ENH-17 | Render uncertainty as geometry, not as a footnote | partial | `test/charts.test.js` |
| ENH-18 | Time-slider playback of hazard history | **not started** | — |
| ENH-19 | Map → chart → record drill-down, with a `/explain` endpoint | **not started** | — |
| ENH-20 | Month × year seasonal calendar heatmap | **not started** | — |
| ENH-21 | Forecast-versus-observed verification charts | **not started** | — |
| ENH-22 | Offline-first drill-down and cached map tiles | partial | `test/web-chw-offline.test.js`, `test/sw-cache-eviction.test.js` |
| ENH-23 | Colourblind-safe and high-contrast themes | partial | `test/web-console.test.js` |
| ENH-24 | Shareable, deep-linked, per-role dashboard state | partial | — |

## Group D — Response and delivery

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-25 | Bulk upload with a validation report | shipped | `test/upload.test.js` |
| ENH-26 | Two-way SMS acknowledgement, escalation, and delivery tracking | **not started** | — |
| ENH-27 | Export that carries the narrative | **not started** | — |
| ENH-28 | A donor-inspectable, hash-chained audit trail | partial | `test/parametric-trigger.test.js` |

## Group E — Platform foundations

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-29 | A store conformance suite, a real schema, and migrations | partial | `test/store-conformance.test.js` |
| ENH-30 | API substrate: pagination, conditional requests, idempotency, readiness | shipped | `test/api-substrate.test.js` |

---

## What each partial is missing

### ENH-01 — Deny-by-default authorization from an explicit route→scope table

**partial.** The security behaviour shipped and is tested: unmapped mutations map to DENIED_SCOPE 'admin:*' and are refused (src/auth.js:19, src/auth.js:255-259, src/server.js:445-450), malformed or empty token config throws rather than returning [] (src/auth.js:126-167, src/server.js:423-452), GETs now sit behind the gate with an explicit public-path list (src/auth.js:99-112, src/server.js:434-444). What is missing is the checkability the entry asks for: there is no single exported ROUTE_SCOPES table — the two tables at src/auth.js:22 and src/auth.js:52 are module-private, so nothing external can iterate them — two mutating routes (POST /api/v1/routing/plan at src/server.js:1025 and POST /api/v1/equity/scan at src/server.js:1221, both named in the entry's reproduced list) are absent from WRITE_SCOPES and therefore closed to every scoped token, no test asserts that every route in server.js appears in the table, and /api/v1/health (src/server.js:503-519) reports no auth posture — only the token-bearing /api/v1/auth-info does (src/server.js:486-501).

Evidence:

- `src/auth.js:19`
- `src/auth.js:22`
- `src/auth.js:52`
- `src/auth.js:99`
- `src/auth.js:126`
- `src/auth.js:255`
- `src/server.js:423`
- `src/server.js:434`
- `src/server.js:446`
- `src/server.js:486`
- `src/server.js:503`
- `src/server.js:1025`
- `src/server.js:1221`
- `test/auth-deny-by-default.test.js:128`
- `test/auth-deny-by-default.test.js:181`

### ENH-02 — Honesty envelopes on every numeric response, policed in CI

**partial.** The caveat travels with the number on exactly one route: GET /api/v1/flood-probability/score returns uncertainty.by_feature with the contingency counts and their Wilson intervals plus an explicit note that it is not a confidence interval (src/server.js:1001-1011, keyed per feature at src/server.js:317-330). The standard envelope is not there: no response anywhere carries value/limits/evidence/not_included — the closest is a prose string named `limits` on risk scores (src/analytics.js:139, src/analytics.js:205), and evidence{source_ids,basis_doc,retrieved_at} and not_included[] appear nowhere in src/. The CI rule is also absent: scripts/check-no-flood-probability.mjs is 221 lines of blocked-vocabulary scanning (scripts/check-no-flood-probability.mjs:61, :142) and contains no assertion that a route returning a probability returns a limits object.

Evidence:

- `src/server.js:317`
- `src/server.js:1001`
- `src/server.js:1008`
- `src/analytics.js:139`
- `src/analytics.js:205`
- `scripts/check-no-flood-probability.mjs:61`
- `scripts/check-no-flood-probability.mjs:142`
- `scripts/check-no-flood-probability.mjs:221`
- `test/flood-score-honesty.test.js:134`

### ENH-03 — Per-region calibration and a trust score

**not started.** No alert_outcomes collection exists, nothing joins an alert to its outcome, and there is no trust score on any surface. What is present is the pre-existing tri-state honesty the entry cites as evidence, not the change: false_alert_rate is computed over determined or resolved alerts only and stays null otherwise (src/kpi.js:182-186, src/districts.js:166-168, src/equity.js:105-119), with the reason reported as a data gap (src/kpi.js:229). No Wilson interval is applied to the false-alert rate anywhere.

Evidence:

- `src/kpi.js:182`
- `src/kpi.js:229`
- `src/districts.js:166`
- `src/equity.js:105`
- `src/equity.js:117`

### ENH-04 — Three tiers of uncertainty on every number

**partial.** One of the three tiers exists, on one route. Sampling is carried per feature as a Wilson interval with months_above_threshold beside it (src/flood-probability.js:298, src/flood-probability.js:332-340, surfaced at src/server.js:1008-1011) and is tested against the payload at test/flood-score-honesty.test.js:146-188. The model tier is absent — the Hessian is used only as a Newton step (src/flood-probability.js:400-412) and the fit returns coefficients with no standard errors or covariance (src/flood-probability.js:434-443), so nothing measures parameter uncertainty. The coverage tier is absent as a named list, and the effective-n correction for the serial correlation of overlapping windows is not implemented: wilsonInterval is called with the raw above.length (src/flood-probability.js:296-298).

Evidence:

- `src/flood-probability.js:296`
- `src/flood-probability.js:298`
- `src/flood-probability.js:332`
- `src/flood-probability.js:400`
- `src/flood-probability.js:434`
- `src/server.js:1008`
- `test/flood-score-honesty.test.js:146`
- `test/flood-score-honesty.test.js:160`

### ENH-05 — Model-drift monitoring

**not started.** No evidence outside the spec itself. There is no drift flag on any score, no model_drift_events collection, and no /api/v1/model-drift route; a repo-wide search for model.drift, drift_flag and drift_events matches only docs/improvements/enhancements.md:134-135 and the research note. The cited data-age concept does exist and is untouched by any model monitoring — freshnessPenaltyFor (src/analytics.js:470) is called once, for source staleness in a confidence score (src/analytics.js:354), and nothing compares a stored coefficient vector against a training run.

Evidence:

- `src/analytics.js:354`
- `src/analytics.js:470`
- `docs/improvements/enhancements.md:134`

### ENH-06 — Freshness SLAs by cadence, with an `ok | quiet | stale | broken` verdict

**not started.** SOURCE_POLICIES still carries only stale_after_minutes and a flat minimum_records; there is no cadence_days or min_expected_delta anywhere in src/. The health route (src/server.js:1339) returns sourceHealth(), which emits never_run|failed|stale|degraded|fresh — never `quiet` or `broken` — and the global 2/14/45-day clock at src/analytics.js:470-489 is untouched. minimum_records is still 1 for every regular source (src/ingestion.js:55-72).

Evidence:

- `src/ingestion.js:54-84`
- `src/ingestion.js:368-378`
- `src/server.js:1339`
- `src/analytics.js:470-489`

### ENH-07 — Per-source data assertions with quarantine-on-fail

**not started.** No declarative assertion map and no quarantine collection exist; the four hand-written guards are all that is there (chirps.js:97, glofas.js:24, nasa-firms.js and who-gho.js equivalents). counts_found is recorded nowhere — src/connectors/chirps.js:105-106 slices to a 30-record limit and returns silently. Failed batches are published as usual via store.merge at src/ingestion.js:192.

Evidence:

- `src/connectors/chirps.js:97-106`
- `src/connectors/glofas.js:24`
- `src/ingestion.js:192`

### ENH-08 — Watermarks, incremental fetch, resumable backfill

**not started.** No watermark or cursor state is persisted (no watermark/last_cursor/last_success_at identifiers in src/); open-meteo-archive.js:47-48 and open-meteo-flood.js:48 still default endDate to today and re-walk from 1981 every run, and both mint their record id from endDate (open-meteo-archive.js:73), so a fresh id is minted daily. Backfills remain synchronous loops with no progress or resume (gdacs-archive.js:45-74).

Evidence:

- `src/connectors/open-meteo-archive.js:35-48`
- `src/connectors/open-meteo-archive.js:73`
- `src/connectors/open-meteo-flood.js:48`
- `src/connectors/gdacs-archive.js:45-74`

### ENH-09 — Source-agreement cross-validation

**not started.** There is no GeoTIFF reader and no agreement check: src/analytics/downscaling.js is 60 lines and contains no correlation, Pearson, disagreement or `disputed` logic, and no such identifiers exist in src/. CHIRPS still explicitly declines to decode pixels (chirps.js:23, chirps.js:91), so the two products cannot be compared. The volume-based confidence term in computeDataQuality (src/analytics.js:355) is unchanged.

Evidence:

- `src/analytics/downscaling.js:1-60`
- `src/connectors/chirps.js:23`
- `src/analytics.js:355`

### ENH-10 — Connector health scoring and circuit breaking

**not started.** failure_streak is still computed at src/ingestion.js:293 and read nowhere else — no circuit, no half-open probe, no skipped_circuit_open status. runDueIngestionSchedules (src/ingestion.js:236-264) retries every due schedule regardless of prior failures, and there is no connector success-rate/latency/payload-drift score.

Evidence:

- `src/ingestion.js:293`
- `src/ingestion.js:236-264`
- `src/ingestion.js:309-323`

### ENH-11 — Enforce the rate limits that are already declared

**partial.** Only the RapidPro client timeout shipped: src/rapidpro.js:370-379 aborts via RAPIDPRO_REQUEST_TIMEOUT_MS and is guarded by test/rapidpro-webhook-auth.test.js:214-224. The token bucket, concurrency cap, jitter and Retry-After handling in src/connectors/http.js do not exist — that file is 25 lines of plain exponential backoff — and the declared rateLimit fields (e.g. src/connectors/ipc-hdx.js:417 perMinute 20 against the unbounded Promise.all at ipc-hdx.js:265) remain documentation. The webhook branch of distributeReport still fetches with no timeout or AbortSignal (src/server.js:1814-1819), and there is no API rate limiter.

Evidence:

- `src/rapidpro.js:370-379`
- `test/rapidpro-webhook-auth.test.js:214-224`
- `src/connectors/http.js:1-25`
- `src/connectors/ipc-hdx.js:265`
- `src/connectors/ipc-hdx.js:417`
- `src/server.js:1814-1819`

### ENH-12 — Raw payload retention, replay, and fixture seeding

**not started.** No connector captures a response body: there is no raw_payload/capture/retrieval_url machinery in src/ — fetchWithRetry returns the parsed body and discards it (src/connectors/http.js:1-25). No replay mode exists for connectors, and no script seeds test/fixtures from captures; the 10 hand-assembled fixtures are consumed only by test/fixtures.test.js, which mocks globalThis.fetch per file.

Evidence:

- `src/connectors/http.js:1-25`
- `test/fixtures.test.js:1-26`
- `test/fixtures/`

### ENH-13 — Bitemporal records

**not started.** Store semantics are unchanged: mergeById overwrites by id (src/store.js:161-173) and no collection in src/schema.js carries valid_from/valid_to. The only valid_from/valid_to in the codebase are the upstream IPC analysis-window columns copied at src/connectors/ipc-hdx.js:211-212, not record versioning — the prior value of a revised record remains unrecoverable.

Evidence:

- `src/store.js:161-173`
- `src/schema.js:242`
- `src/connectors/ipc-hdx.js:211-212`

### ENH-14 — Completeness tripwires for capped pagination

**not started.** No pagination bookkeeping exists. gdacs-archive walks quarter windows and discards everything about each page except feature count (src/connectors/gdacs-archive.js:51-68) — no pages fetched, records seen, provider total, or full-last-page flag — and chirps.js:105-106 applies its 30-record cap without recording what it dropped. The possibly_incomplete flag appears nowhere in src/.

Evidence:

- `src/connectors/gdacs-archive.js:51-68`
- `src/connectors/chirps.js:105-106`

### ENH-15 — Record-level provenance with real transform versions

**not started.** src/lineage.js is unchanged: upstream_url_or_endpoint is still hardcoded null and transform_version the constant '0.1.0' (lines 13-14), and no _provenance envelope exists on any record. The run-wide union bug the item describes is still present at src/ingestion.js:185-189, where allRecords is rebuilt from the full merged set inside the per-run loop, so a nine-source run still writes nine identical lineage rows. No test asserts on lineage content — data_lineage appears in tests only as an empty input collection (test/remaining-defects.test.js:295).

Evidence:

- `src/lineage.js:13-14`
- `src/ingestion.js:184-190`
- `test/remaining-defects.test.js:295`

### ENH-16 — A chart component library, shared by all eight surfaces

**partial.** `public/shared/charts.js` (640 lines) exists with all five named primitives plus `sparkline` and the scale helpers, and is exercised by `test/charts.test.js` (50 tests). It is imported by 2 of 8 surfaces — `public/co/app.js:11` (static) and `public/app.js:1010` (lazy) — and only `barChart`, `sparkline` and `smallMultiples` have call sites anywhere outside the library; `lineChart`, `stackedBar` and `heatmap` have none.

Evidence:

- `public/shared/charts.js:204`
- `public/shared/charts.js:341`
- `public/shared/charts.js:407`
- `public/shared/charts.js:477`
- `public/shared/charts.js:563`
- `public/shared/charts.js:599`
- `public/co/app.js:11`
- `public/co/app.js:354`
- `public/co/app.js:417`
- `public/app.js:1010`
- `public/app.js:1050`
- `public/app.js:1071`
- `public/index.html:302`
- `public/components.css:760`

### ENH-17 — Render uncertainty as geometry, not as a footnote

**partial.** `lineChart` can draw an uncertainty band (`public/shared/charts.js:232-256`) and two tests guard it, but `lineChart` has zero call sites outside its own test file — no chart in the product passes `low`/`high`. There is no `not_included` caption anywhere in `public/` or `src/`, and no map uncertainty mode: no confidence-driven opacity or hatch exists in `public/app.js`.

Evidence:

- `public/shared/charts.js:192`
- `public/shared/charts.js:232`
- `public/shared/charts.js:253`
- `test/charts.test.js:145`
- `test/charts.test.js:157`

### ENH-18 — Time-slider playback of hazard history

**not started.** No scrubber, play/pause or speed control in any surface. A search for `input type="range"`, `scrub` and `playback` across `public/` returns nothing; the only `setInterval` uses are the 30s queue flush (`public/shared/runtime.js:172`) and the console's self-rescheduling poll (`public/app.js:4176`), neither of which replays hazard frames.

Evidence:

- `public/shared/runtime.js:172`
- `public/app.js:4176`

### ENH-19 — Map → chart → record drill-down, with a `/explain` endpoint

**not started.** No `/api/v1/explain/:kind/:id` route exists — the route table in `src/server.js` has no matching path. A map click opens `openDetailDialog` (`public/app.js:3781`), which renders the record's own fields as a flat `<dl>` — no time series, no underlying records, no per-term coefficient breakdown. The adjacent evidence defect did get fixed: `calibrationReport` is now routed from `/api/v1/assessments` (`src/server.js:1276`), but that is the calibration metadata, not the equation endpoint.

Evidence:

- `public/app.js:3781`
- `public/app.js:3786`
- `src/server.js:1276`
- `src/analytics.js:258`

### ENH-20 — Month × year seasonal calendar heatmap

**not started.** The `heatmap` primitive exists and is tested (`test/charts.test.js:264-319`) but has no call site outside the library. No surface builds a month×year matrix, nothing computes departure from a climatological median, and there is no flood/alert overlay on a grid. `public/shared/seasonal.js` still has exactly one consumer, `public/app.js:7`, which renders the single-summary strip.

Evidence:

- `public/shared/charts.js:477`
- `public/shared/seasonal.js`
- `public/app.js:7`
- `public/app.js:615`
- `public/app.js:2321`
- `test/charts.test.js:264`

### ENH-21 — Forecast-versus-observed verification charts

**not started.** No reliability diagram, no forecast-probability binning, no lead-time axis anywhere in `src/` or `public/`; `lead_time_days` appears only as a fixture field (`test/lite.test.js:127`) and a display string in `public/workflow/ops.js:43`. `src/analytics/ensemble.js` remains dead: `computeEnsembleStats` is called only from itself and from tests, and both connectors still write `ensemble_p10/p50/p90: null`.

Evidence:

- `src/analytics/ensemble.js:1`
- `src/analytics/ensemble.js:49`
- `src/connectors/open-meteo.js:49`
- `src/connectors/glofas.js:56`
- `test/lite.test.js:924`
- `public/workflow/ops.js:43`

### ENH-22 — Offline-first drill-down and cached map tiles

**partial.** Three of the five changes shipped: the precache list is now a computed breadth-first closure of the real import graph (`public/sw.js:111`, guarded by `test/web-chw-offline.test.js:437-513`); the queue throws unless IndexedDB confirms the write (`public/shared/runtime.js:66-95`, `submitOrQueue` at `:251`, guarded by 12 tests); and `/api/v1/*` GETs are network-first with an API cache fallback and an `x-lindela-offline` header (`public/sw.js:210-240`, read at `public/shared/runtime.js:217`) under a tested eviction cap. Missing: there is no tile cache of any kind in `public/sw.js`, and no "last synced" indicator — no surface reads the offline header or renders per-panel staleness.

Evidence:

- `public/sw.js:111`
- `public/sw.js:167`
- `public/sw.js:210`
- `public/sw.js:227`
- `public/shared/runtime.js:66`
- `public/shared/runtime.js:217`
- `public/shared/runtime.js:251`
- `test/web-chw-offline.test.js:256`
- `test/web-chw-offline.test.js:437`
- `test/sw-cache-eviction.test.js:22`

### ENH-23 — Colourblind-safe and high-contrast themes

**partial.** The secondary-encoding half shipped and is guarded: `hazardShape` (`public/app.js:1356`) and `severityDash` (`public/app.js:1373`) are applied to every map and legend severity class, with six tests in `test/web-console.test.js:214-262` asserting distinct shapes, distinct dash patterns and that an ungraded record is not painted as "low". The palette half did not: `public/tokens.css` is a single dark `:root` with no deuteranopia/protanopia/tritanopia check, no high-contrast mode, and no `prefers-contrast`/`forced-colors` theme; `scripts/check-a11y.mjs:24` audits WCAG contrast but only against that one theme.

Evidence:

- `public/app.js:1356`
- `public/app.js:1373`
- `public/app.js:1770`
- `public/app.js:1807`
- `public/app.js:1989`
- `public/tokens.css:3`
- `public/tokens.css:35`
- `test/web-console.test.js:214`
- `test/web-console.test.js:237`
- `scripts/check-a11y.mjs:24`

### ENH-24 — Shareable, deep-linked, per-role dashboard state

**partial.** The console encodes and restores six filter/time-window params — `sev`, `source`, `range`, `cold`, `alerts`, `workflow` — through `syncFiltersToUrl`/`restoreFiltersFromUrl` (`public/app.js:2867-2921`), called from 5 sites including boot at `:4185`; scenarios has a share token in the URL hash plus a copy button. Missing: map extent and selected feature are not in the URL, there is no per-role saved default view anywhere (`public/shared/runtime.js` exports no view-config API), and no test exercises any of it — the only `replaceState` reference in `test/` is a stub. Shipped, unguarded.

Evidence:

- `public/app.js:2867`
- `public/app.js:2878`
- `public/app.js:2907`
- `public/app.js:2132`
- `public/app.js:4185`
- `public/scenarios/app.js:434`
- `public/scenarios/index.html:366`
- `public/shared/runtime.js:12`
- `test/i18n-scenarios.test.js:146`

### ENH-26 — Two-way SMS acknowledgement, escalation, and delivery tracking

**not started.** No structured reply verbs anywhere: src/rapidpro.js parses inbound field reports and free text only, and no ACK/ESCALATE/RESOLVED verb or reason code exists in src/ or public/. There is no per-recipient delivery state, no delivery-report endpoint (the four rapidpro routes are status, response-metrics, dispatches, inbound, field-report — src/server.js:2841-2845), and no escalation tree or acknowledgement SLA. The response_rate_pct rework at src/rapidpro.js:255 is the ALERT-05 fix, not this enhancement, and inbound webhooks are still written unconditionally with no idempotency guard (src/server.js:2036-2050).

Evidence:

- `src/rapidpro.js:185`
- `src/rapidpro.js:255`
- `src/server.js:2841`
- `src/server.js:2036`

### ENH-27 — Export that carries the narrative

**not started.** GET /api/v1/export.csv and /api/v1/export.geojson (src/server.js:1284, 1300) still return only the flattened source-record appendix — toCsv writes record keys and nothing else (src/utils.js:335) — with no warnings, no caveats and no pointer to export.md. No XLSX, no KMZ and no signed PDF exists in src/ or scripts/. markdown_download still records a byte count rather than the artefact (src/server.js:1806), and no per-row provenance stamp (source_id, observed_at, payload_hash) is added at export time.

Evidence:

- `src/server.js:1284`
- `src/server.js:1300`
- `src/utils.js:335`
- `src/server.js:1806`

### ENH-28 — A donor-inspectable, hash-chained audit trail

**partial.** Two of the four parts shipped. The money path is now audited: the three parametric writes write action logs with the token subject as actor (src/server.js:2521, 2553, 2633), asserted by test/parametric-trigger.test.js:300. action_logs is read-only by route guard — POST, PATCH and DELETE all answer 405 (src/server.js:2275, 2295, 2313) — and a read-only audit view renders it in the workflow panel (public/workflow/panel.js:135, 168). Missing: there is no hash chain — prev_hash/row_hash appear nowhere in the tree, so tampering is undetectable — and there is no audit export a donor can inspect independently of the operator running the server.

Evidence:

- `src/server.js:2521`
- `src/server.js:2553`
- `src/server.js:2633`
- `src/server.js:2275`
- `src/server.js:2295`
- `src/server.js:2313`
- `public/workflow/panel.js:135`
- `public/workflow/panel.js:168`
- `test/parametric-trigger.test.js:300`

### ENH-29 — A store conformance suite, a real schema, and migrations

**partial.** Part 1 shipped: test/store-conformance.test.js runs one behavioural contract against JsonStore and PostgresStore and is in both the npm test glob and the coverage set (package.json:9, package.json:13). It is also unguarded in practice for the backend that matters — the Postgres half only runs when LINDELA_LITE_TEST_DATABASE_URL is set (test/store-conformance.test.js:24) and no CI job sets it, so CI exercises the conformance suite against one adapter. Parts 2 and 3 are untouched: there is no migration runner and no schema_version column — src/schema.js:213 still hardcodes version: 1 and ensureSchema still issues hand-written ALTER TABLE statements (src/postgres-store.js:22-53) — and the single lite_records JSONB table remains, with no per-collection columns or indexes.

Evidence:

- `test/store-conformance.test.js:57`
- `test/store-conformance.test.js:24`
- `package.json:9`
- `package.json:13`
- `.github/workflows/ci.yml:33`
- `src/schema.js:213`
- `src/postgres-store.js:22`

---

## The patterns

Three shapes recur, and each one is this repository's own defect class rather than a
coincidence of what happened to get built.

**A capability landed where one call site existed and nowhere else.** The chart library
(`ENH-16`) is 640 lines with 50 tests and is imported by 2 of 8 surfaces; `lineChart`,
`stackedBar` and `heatmap` are exported, tested, and called by nothing in the product.
`ENH-17`, `ENH-20` and `ENH-21` all need one of those three, so three items are blocked
behind call sites that do not exist. Same shape in `ENH-04`: sampling uncertainty reached
`/api/v1/flood-probability/score` and no other route.

**Uncertainty stopped at one boundary.** `ENH-02` (the envelope), `ENH-04` (three tiers),
`ENH-17` (uncertainty as geometry) and `ENH-21` (forecast verification) are four items
about the same idea. One tier, on one route, in prose in the docs and a Wilson interval in
one response field. Every one of them says the same thing: the caveat has to travel with the
number, and it currently travels with about one number.

**A list written once and checked nowhere.** `ENH-01` ships deny-by-default as *behaviour*
but keeps its route→scope table module-private, so the test cannot iterate it and a route
added without a scope fails closed to `admin:*` rather than being caught. `ENH-29` runs a
conformance suite against Postgres only when a CI job nobody sets provides a database, so CI
exercises one adapter and reports both. `ENH-24` has no test at all.

Group B is the outlier and the honest answer is that it was not started: nine of ten items
are untouched, and the one that moved (a request timeout on the RapidPro client) was a
defect fix that happened to land inside the item's scope.
