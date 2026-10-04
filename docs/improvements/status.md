# Enhancement status

What has actually shipped, verified against the tree rather than against the commit log.
Regenerate with `node docs/improvements/_build-status.mjs` after editing any
`_status-*.json`.

**18 shipped, 8 partial, 4 not started,** of 30.
The two that shipped before this round were the two the project was built to make possible
anyway: the API substrate a caller can integrate against (`ENH-30`) and a way to get your
own data in (`ENH-25`). The five since are the ones where a claim had become load-bearing —
a quarantine collection that had to exist for the store not to drop condemned batches on the
floor (`ENH-07`), a history that had to exist before the next overwrite destroyed the only
record of the previous value (`ENH-13`), and three that had stopped being honest.

A status is **partial** when some of the described change is in the tree and the rest is
not, and the detail says which is which. An exported function with no call site is not
shipped: three of the chart library's six primitives are exported, tested, and called by
nothing in the product.

---
## Group A — Trust: make the honesty reach the payload

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-01 | Deny-by-default authorization from an explicit route→scope table | shipped | `test/route-scope-coverage.test.js`, `test/auth-deny-by-default.test.js` |
| ENH-02 | Honesty envelopes on every numeric response, policed in CI | shipped | `test/flood-score-honesty.test.js` |
| ENH-03 | Per-region calibration and a trust score | shipped | — |
| ENH-04 | Three tiers of uncertainty on every number | shipped | `test/flood-score-honesty.test.js` |
| ENH-05 | Model-drift monitoring | shipped | — |

## Group B — Ingestion fidelity, quality, timeliness

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-06 | Freshness SLAs by cadence, with an `ok \| quiet \| stale \| broken` verdict | shipped | `test/freshness.test.js`, `test/ingestion-wiring.test.js` |
| ENH-07 | Per-source data assertions with quarantine-on-fail | shipped | `test/assertions.test.js`, `test/ingestion-wiring.test.js` |
| ENH-08 | Watermarks, incremental fetch, resumable backfill | partial | `test/watermarks.test.js` |
| ENH-09 | Source-agreement cross-validation | shipped | `test/source-agreement.test.js` |
| ENH-10 | Connector health scoring and circuit breaking | shipped | `test/circuit.test.js`, `test/ingestion-wiring.test.js` |
| ENH-11 | Enforce the rate limits that are already declared | partial | `test/rate-limit.test.js`, `test/rate-limit-wiring.test.js`, `test/rapidpro-webhook-auth.test.js` |
| ENH-12 | Raw payload retention, replay, and fixture seeding | shipped | `test/capture.test.js` |
| ENH-13 | Bitemporal records | shipped | `test/bitemporal-history.test.js` |
| ENH-14 | Completeness tripwires for capped pagination | shipped | `test/completeness.test.js` |
| ENH-15 | Record-level provenance with real transform versions | shipped | `test/provenance.test.js`, `test/ingestion-wiring.test.js` |

## Group C — Visualization depth

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-16 | A chart component library, shared by all eight surfaces | partial | `test/charts.test.js` |
| ENH-17 | Render uncertainty as geometry, not as a footnote | partial | `test/charts.test.js` |
| ENH-18 | Time-slider playback of hazard history | **not started** | — |
| ENH-19 | Map → chart → record drill-down, with a `/explain` endpoint | **not started** | — |
| ENH-20 | Month × year seasonal calendar heatmap | partial | `test/seasonal-calendar.test.js`, `test/charts.test.js` |
| ENH-21 | Forecast-versus-observed verification charts | **not started** | — |
| ENH-22 | Offline-first drill-down and cached map tiles | partial | `test/web-chw-offline.test.js`, `test/sw-cache-eviction.test.js` |
| ENH-23 | Colourblind-safe and high-contrast themes | partial | `test/web-console.test.js` |
| ENH-24 | Shareable, deep-linked, per-role dashboard state | partial | — |

## Group D — Response and delivery

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-25 | Bulk upload with a validation report | shipped | `test/upload.test.js` |
| ENH-26 | Two-way SMS acknowledgement, escalation, and delivery tracking | **not started** | — |
| ENH-27 | Export that carries the narrative | shipped | — |
| ENH-28 | A donor-inspectable, hash-chained audit trail | shipped | `test/parametric-trigger.test.js` |

## Group E — Platform foundations

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-29 | A store conformance suite, a real schema, and migrations | shipped | `test/store-conformance.test.js`, `test/migrations.test.js` |
| ENH-30 | API substrate: pagination, conditional requests, idempotency, readiness | shipped | `test/api-substrate.test.js` |

---

## What each partial is missing

### ENH-08 — Watermarks, incremental fetch, resumable backfill

**partial.** `src/watermarks.js` (27 tests) implements the per-source watermark, incremental fetch windows, resumable backfill cursors and the resume-after-crash case, but nothing calls it. The two archive connectors still default `endDate` to today and re-walk from 1981 on every run, and both still mint their record id from `endDate`, so a fresh id is minted daily and the whole backfill is re-downloaded forever. `gdacs-archive.js` remains a synchronous loop with no progress and no resume. This is the module-built-but-uncalled shape described under the patterns below: the logic is right and unreachable, and the work left is plumbing it into the three connectors.

Evidence:

- `src/watermarks.js`
- `src/connectors/open-meteo-archive.js:47`
- `src/connectors/gdacs-archive.js:45`

### ENH-11 — Enforce the rate limits that are already declared

**partial.** Unchanged from before and still the item's own words: the token bucket, concurrency cap, jitter and `Retry-After` handling exist as `src/rate-limit.js` with 30 tests, and nothing enforces them. `src/connectors/http.js` is still plain exponential backoff, and the declared `rateLimit` fields — `src/connectors/ipc-hdx.js:417` declares perMinute 20 against the unbounded `Promise.all` at ipc-hdx.js:265 — remain documentation. The webhook branch of `distributeReport` still fetches with no timeout and no AbortSignal (src/server.js:1814-1819), and there is still no API rate limiter. Only the RapidPro client timeout from the previous round is actually live (src/rapidpro.js:370-379).

Evidence:

- `src/rate-limit.js`
- `src/connectors/http.js:42`
- `src/connectors/ipc-hdx.js:265`
- `src/server.js:1814`

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

**partial.** The `heatmap` primitive exists and is tested (`test/charts.test.js:264-319`) but has no call site outside the library. No surface builds a month×year matrix, nothing computes departure from a climatological median, and there is no flood/alert overlay on a grid. `public/shared/seasonal.js` still has exactly one consumer, `public/app.js:7`, which renders the single-summary strip.

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

---

## The patterns

Three shapes recur, and each one is this repository's own defect class rather than a
coincidence of what happened to get built.

**The most recent wave reproduced the first pattern while trying to fix it.** Group B was
the outlier — nine of ten items untouched — so eight modules were built in parallel with
tests, and four of them were then wired into `runIngestion`: quarantine (`ENH-07`), the
circuit gate (`ENH-10`), the freshness verdict on the status route (`ENH-06`) and record
provenance (`ENH-15`). The other four — watermarks (`ENH-08`), agreement (`ENH-09`),
capture (`ENH-12`) and completeness (`ENH-14`) — are still exported, tested and called by
nothing, which is exactly the defect below, now four instances wider and written by the
same effort that was fixing it. The ledger counts them partial for that reason and not
because their logic is unfinished.

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

**A list written once and checked nowhere.** `ENH-01` is the shape this class takes, and
fixing it found the defect: deny-by-default shipped as *behaviour* with its route→scope table
module-private, so nothing could iterate it. Exporting the table found seven mutating routes no
prefix covered - each already failing closed, each a 403 to a caller holding the documented
scope. `ENH-29` still has it: a conformance suite that covers Postgres only when a CI job nobody
sets provides a database, so CI exercises one adapter and reports both. `ENH-24` has no test at
all.

Group B was the outlier and now is not, but it is not done either: four of ten shipped and
six are partial, and in five of those six the missing half is the same half — a module that
works, tested, and has no caller. The rate limiter is the sharpest case: the token bucket and
the `Retry-After` handling are written, and the `perMinute 20` declared beside an unbounded
`Promise.all` in the IPC connector is still documentation.
