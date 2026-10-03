# Sources and Decisions: the second capability roadmap

Status: proposed — 2026-10-03
Related: [enhancements.md](enhancements.md) (ENH-01..30), [roadmap-extension.md](roadmap-extension.md) (items 1–20), [world-class-roadmap.md](../plans/world-class-roadmap.md)

## What this document is

`enhancements.md` answers *can this platform be trusted*. ENH-01 denies by default, ENH-02 attaches an honesty envelope to every number, ENH-06 says whether a feed is stale, ENH-12 keeps raw payloads. Almost none of it adds a fact the platform did not previously have.

`roadmap-extension.md` answered *is the existing capability actually working* — and its verdicts are mostly "Partial", "and dead", "Shipped, defective". Items 2, 3, 4, 5, 13, 14, 15, 17, 18 are things that were built and are not working.

This document adds a third axis: **what the platform does not know yet**. Thirty-one items, in five groups:

| Prefix | Group | What it adds |
|---|---|---|
| SRC-01..11 | Sources | Facts the platform cannot currently state |
| DEC-01..09 | Decisions | Judgements it cannot currently make |
| OPS-01..06 | Operations | States a response team must move through |
| PLT-01..04 | Platform | Ways for the data to leave and be queried at scale |
| CC-01 | Cold chain | One vertical taken end to end |

The two earlier documents are substrate and honesty. This one is content and consequence. They do not compete: ENH-12 (raw payload retention) is what makes SRC-10's live probe possible, and SRC-01 (a real GloFAS retirement) frees the ingestion budget that OPS-01 spends on dispatch.

## What this document is not

It is not a rewrite of ENH-01..30. Every item here assumes those land. In particular there is no item here about authorization, uncertainty rendering, calibration, or source health scoring, because `enhancements.md` owns those and two documents claiming the same work produce two half-implementations.

Nor is it `world-class-roadmap.md`. That document is the umbrella; this one is the item-level evidence for the half of it that concerns sources rather than platform mechanics.

## Dedup ledger

The instruction was no duplication and no contradiction. Here is every item in this document against every prior list, with the verdict.

| Item | Verdict | Overlaps | Relationship |
|---|---|---|---|
| SRC-01 Promote `open_meteo_flood`, delete `glofas` | **replaces** | extension 11, README | Extension 11 fixed CAP encoding but kept a connector whose feed is unverified. The CAP item is done; the source half is not. |
| SRC-02 Fix or retire CHIRPS | **new** | — | Appears in `docs/ingestion.md:47` as a known failure with no disposition. A dead connector that still appears in `SOURCE_POLICIES` is worse than an absent one: it reports a source that cannot succeed. |
| SRC-03 NASA FIRMS → keyless GIBS fire tiles | **extends** | ENH-22 | `src/connectors/nasa-firms.js` already returns fire points. ENH-22 asks for cached map tiles offline; this asks for the *hazard layer* to be drawn at all. Different deliverable, shared substrate. |
| SRC-04 OSM roads and water via Overpass | **new** | extension 4 | Extension 4 is about downscaling *rainfall*. Roads and water bodies are static vector geometry with nothing to do with precipitation. |
| SRC-05 Health facilities from HDX or Overpass | **new** | — | `SERVICE_TYPES` includes `health` and the demo seeds eight facilities by hand (`scripts/seed-demo.mjs:360`). Real deployments have none of them. |
| SRC-06 IOM DTM displacement | **new** | — | No connector matches `displacement` in `src/connectors/`. |
| SRC-07 SPI/SPEI from the stored ERA5 series | **new** | — | The ERA5 reanalysis series is already fetched (`src/connectors/open-meteo-archive.js`, 1981 onward). The drought indices are arithmetic on data already in hand; only the code is missing. |
| SRC-08 Soil moisture and evapotranspiration | **new** | — | No connector matches either term. |
| SRC-09 Sentinel-2 NDVI | **new** | ENH-23 | Not a theming item. ENH-23 is colourblind-safe palettes; this is a data layer. |
| SRC-10 UN WPP population | **new** | — | Denominators for every rate in the platform. `equityByDistrict` (`src/equity.js:15`) divides by populations that must currently be seeded. |
| SRC-11 UNHCR/IFRC displacement and shelters | **extends** | SRC-06 | DTM gives the movement; this gives where the people went. Same output table, different upstream. |
| DEC-01 Reach-matched catchment rainfall | **extends** | extension 4 | Extension 4 corrects the *values*; this attaches them to a catchment geometry so a gauge 40 km away cannot speak for a subbasin. |
| DEC-02 River-discharge threshold alerting | **new** | — | Alert rules today read `temperature_max_c`, `rainfall_mm` and similar station-scale metrics. Discharge is the variable that actually breaks. |
| DEC-03 Calibration and verification surfaces | **subsumed** | ENH-03, ENH-21 | **Already covered.** ENH-21 is forecast-versus-observed verification charts; ENH-03 is per-region calibration and a trust score. Writing them again here would be exactly the duplication asked against. Not carried forward as a separate item — listed so the reader can see it was considered and rejected. |
| DEC-04 Detection and false-alarm KPIs (POD/POFD/PROG) | **new** | ENH-07, DATA-03/05/07 | `false_alert_rate` now exists and is correctly defined (`src/districts.js`, `src/equity.js`). What is missing is the *forecast* half — skill scores over a matched sample, not an administrative verdict rate. |
| DEC-05 Rainfall onset and crop-calendar conditioning | **new** | — | No connector or module matches either term. |
| DEC-06 Compound multi-hazard risk | **new** | — | `computeRoadAccess` (`src/road-access.js`) takes a worst-case hazard today; it does not know that a flood plus a landslide plus a failed road is worse than the max of the three. |
| DEC-07 IBF backtest kept queued rather than run at request time | **fixes** | extension 3, 6 | Extension 3 is "Shipped, broken on Postgres" and extension 6 is "Shipped, defective". This is not a new feature; it is the remediation those two items already earned. |
| DEC-08 Bias-corrected downscaling | **already present** | extension 4 | Extension 4 already describes this item as "Partial, degenerate". Not re-listed. |
| OPS-01 State machines for the four operational collections | **new** | — | `INCIDENT_STATUSES` etc. exist as enums (`src/operations.js:134,165,194,280`) but nothing validates a *transition*. Any status can follow any status. |
| OPS-02 Work queue with escalation | **new** | — | `tasks` is a collection; it has no ordering, no assignee, no age-based escalation. |
| OPS-03 Actually dispatch the outbox | **fixes** | extension 13 | Extension 13 is "Partial, and non-functional". `POST /api/v1/outbox/dispatch` (`src/server.js:570`) exists and is never called by a scheduler. |
| OPS-04 Multi-user RBAC with principals in the audit log | **extends** | extension 14, ENH-01 | `src/auth.js` authenticates *tokens*, not people. `action_logs` records `actor` as a string. There is no principal with a role. |
| OPS-05 Audit evidence on every transition | **extends** | ENH-28 | ENH-28 is the hash-chained trail. This is the guarantee that a trail has no holes — a transition with no corresponding log entry is a defect, not a formatting question. |
| OPS-06 Signed report links, PDF and email distribution | **extends** | ENH-27, extension 16 | ENH-27 is export that carries the narrative; extension 16 is signed releases and SBOM. This is signed *per-report* links for distribution to a partner who has no account. |
| PLT-01 Spatial indexing and a real query layer | **new** | — | `lite_records` is a JSON document table. Every spatial filter in the platform is a linear scan in JavaScript. |
| PLT-02 WebSocket or SSE live push | **new** | ENH-24 | ENH-24 is shareable dashboard *state*. Nothing in the platform pushes; the console polls (`public/sw.js` records a 30-second poll across twelve endpoints). |
| PLT-03 `GET/POST /stac/search` and OGC API Features | **extends** | extension 10 | Extension 10 is "Shipped" and it is — `/stac/catalog.json`, `/stac/collections/{id}`, `/ogc/collections/{id}/items` (`src/server.js:200,205,242`). All three are GET-only catalog reads. Query is what makes STAC a query API. |
| PLT-04 Contract tests plus a scheduled live probe | **extends** | ENH-07 | ENH-07 is per-source data assertions with quarantine. This is the upstream half: proving the *shape* we parse has not changed under us. |
| CC-01 Cold chain and vaccine viability | **new** | SRC-05 | Detailed below. |

**Twenty-five carried, three explicitly rejected as duplicates (DEC-03, DEC-08, and the SEP/IBF half of extension 6 already inside DEC-07), three that extend an existing item by adding a deliverable rather than repeating one (SRC-03, PLT-03, PLT-04).**

---

## Tier A — Sources

### SRC-01 — Promote `open_meteo_flood`, retire `glofas`

**Now.** `src/ingestion.js:78-79` registers both `open_meteo_archive` and `open_meteo_flood` with `interval_minutes: 0` and `regular: false`. `README.md:93` marks the GloFAS feed "currently unverified". `README.md:112` records that the GloFAS RSS URL now serves the EFAS web application — the connector is fetching an HTML page and parsing it as a feed, or failing silently until someone reads the run log.

**Then.** `open_meteo_flood` is a documented, keyless, modelled daily discharge series with a documented provenance. It should carry the identity `glofas` currently carries in the UI, because the model basis in [flood-probability-model-basis.md](../flood-probability-model-basis.md) is empirical co-occurrence, not hydrology — a modelled discharge series and an empirical co-occurrence rate are compatible inputs, and one unverified feed is not.

The retirement is a deletion, not a flag. A connector in `SOURCE_POLICIES` that cannot succeed is a health-check entry that fails forever.

### SRC-02 — Fix or retire CHIRPS

**Now.** `docs/ingestion.md:47`: "Product index moved to year subdirectories, so the filename pattern matched zero times | The fixture encoded the old flat layout, confirming the bug."

The bug is diagnosed. The fix is one index parser. What has not happened is a decision, and an undiagnosed connector that is diagnosed-but-unfixed still occupies the source list, the health panel and a slot in every operator's morning.

Two options, one of which must be chosen deliberately: repair against the current CHIRPS layout and add a fixture encoding *that* layout, or remove the source. The argument for removal is that the platform's rainfall story is ERA5 (SRC-07) and Open-Meteo; CHIRPS is a fourth opinion that adds nothing ENH-09 does not already formalise as cross-validation between sources that are actually running.

### SRC-03 — NASA FIRMS to keyless GIBS active-fire tiles

**Now.** `src/connectors/nasa-firms.js` exists and returns fire points. FIRMS requires a MAP_KEY for the API; the GIBS tile endpoint is keyless.

**Then.** Produce a raster tile layer for the map and expose it to all eight surfaces, so an operator without a FIRMS key still sees fire. This is the same layer ENH-22 needs cached for offline; the tile is the deliverable ENH-22 then caches.

**Reject.** Shipping the FIRMS key as a documented config value. A key that must be configured is a key that will not be configured, and the resulting blank layer looks identical to "no fires".

### SRC-04 — OSM roads and water via Overpass

**Now.** `SERVICE_TYPES` includes `road`, and road assets must be imported by hand. Overpass needs no key and no account.

**Then.** A connector that fetches the road network and water bodies for a district. This is what makes `computeRoadAccess` mean anything beyond the roads someone typed in: a hand-seeded list of three roads in Turkana describes nothing about whether Kakuma is reachable.

### SRC-05 — Health facilities from HDX or Overpass

**Now.** Eight facilities, all hand-seeded (`scripts/seed-demo.mjs:360`), each with a `beds` count and a `beneficiaries` count that exist nowhere but the seed file.

**Then.** Real facilities. HDX first (it carries the humanitarian-specific attributes — organisation, facility type, status), Overpass as the fallback.

This is a prerequisite for CC-01 and for DEC-04, both of which are denominated in facilities.

### SRC-06 — IOM DTM displacement

**Now.** No connector matches `displacement`.

**Then.** The DTM's flow and stock layers give movement without a name attached. Pair with SRC-11 to answer "who moved and where did they go" rather than only "how many pixels changed".

**Note on honesty.** DTM is modelled, not observed. It should carry `model_limit` in `source_health` exactly as `src/connectors/glofas.js` now does for severity — a modelled quantity presented as a count is the same defect at a different scale.

### SRC-07 — SPI and SPEI from the stored ERA5 series

**Now.** `src/connectors/open-meteo-archive.js` pulls the 45-year daily series from 1981. It is stored. No index is computed from it.

**Then.** SPI (Standardised Precipitation Index, precipitation only, 3/6/12-month timescales) and SPEI (which adds potential evapotranspiration, so it needs SRC-08 first for full fidelity — or runs precipitation-only with the omission stated).

**This is arithmetic on data already in hand**, which makes it the cheapest substantive item in this document. A drought index is a rolling sum, a fitted distribution, and a percentile. The reason it is not built is that nobody wrote it, not that it is hard.

It also unlocks DEC-05: onset and crop calendar are meaningless without a drought history to condition on.

### SRC-08 — Soil moisture and evapotranspiration

**Now.** Neither term appears in `src/`.

**Then.** Soil moisture as an antecedent-state predictor — the difference between "it rained" and "the ground could absorb it" — and evapotranspiration as the PET term SPEI requires. Both are available from ERA5-derived products without a key.

**Reject.** Deriving them from precipitation and temperature by formula and calling them observations. A computed PET is a model output; it must be labelled as one wherever the observed one is absent.

### SRC-09 — Sentinel-2 NDVI

**Now.** Nothing in the platform describes vegetation state.

**Then.** NDVI as a slow-moving damage proxy. A district whose NDVI drops 0.3 between two cloud-free composites has had a crop failure or a flood regardless of what the rainfall gauge said.

**Boundary.** 10-day at 30 m, so this is a slow signal. It is not a substitute for SRC-07's drought indices on a weekly cadence, and pairing it with them as if they measure the same thing would be the kind of unit error the platform has been cleaned of elsewhere.

### SRC-10 — UN World Population Prospects

**Now.** Every rate — coverage, equity, detection — divides by a population that must currently be seeded. A rate over a seeded denominator is exact and meaningless.

**Then.** District-level annual population with an interpolated year, and an explicit statement in the response envelope that the denominator is a projection rather than a count.

**This is the highest-leverage item in Tier A.** Not because population data is interesting, but because it converts every existing ratio from "correct arithmetic over an invented number" to "correct arithmetic over a published number".

### SRC-11 — UNHCR and IFRC displacement, IDP and shelter data

**Now.** Nothing.

**Then.** Registered populations and shelter sites, which give the platform a *location* for the people DEC-01's catchment polygons describe, and a target for OPS-02's task queue.

---

## Tier B — Decisions

### DEC-01 — Reach-matched catchment rainfall

Extension 4 corrects rainfall values. This attaches them to a geometry: the subbasin a station actually drains, so a gauge forty kilometres away and a flood in an adjacent valley are not summed as though they were the same catchment. Requires catchment polygons — which is the first consumer of PLT-01's spatial layer, and the reason PLT-01 is not optional.

### DEC-02 — River-discharge threshold alerting

Alert rules read station-scale metrics (`temperature_max_c`, `rainfall_mm`). The variable that actually breaks a levee is discharge, and it is the one variable with a defensible absolute threshold.

Requires SRC-01 to be done first, or it alerts on an unverified feed.

### DEC-03 — Calibration and verification surfaces

**Rejected as a duplicate.** ENH-21 (forecast-versus-observed verification charts) and ENH-03 (per-region calibration and a trust score) already own this, with the evidence and the acceptance criteria. Re-listing it here would create two owners for one piece of work, which is the failure mode the dedup instruction exists to prevent.

### DEC-04 — Detection and false-alarm KPIs

`false_alert_rate` now exists and is defined the same way in both places that compute it — resolved alerts carrying a review note, over all alerts (`src/districts.js`, `src/equity.js`; both also expose `false_alert_determined` so the denominator is visible).

What is missing is the other half. POD, POFD and critical success index need a *matched sample*: a forecast, the hazard that did or did not occur, and a window. That is DEC-04, and it is the metric that distinguishes a system that alerts well from a system that alerts often.

### DEC-05 — Rainfall onset and crop-calendar conditioning

Planting date is region-specific, crop-specific and seasonally fixed. A 40 mm event in March and the same event in July are different events. Requires SRC-07's history and SRC-09's vegetation signal; conditioned on both, it is the difference between an early warning and an alarm.

### DEC-06 — Compound multi-hazard risk

`computeRoadAccess` reports the worst single obstruction. A district with a flood, a landslide and a washed-out bridge in the same week is not "the flood". Severity must compose, and the composition must be stated — because "flood × landslide" means something different from "flood and landslide", and the platform's ethos does not permit shipping the number without the caveat.

### DEC-07 — IBF and trigger-protocol dry-run, computed on a schedule

Extensions 3 and 6 both say the capability shipped and is broken. It is broken on Postgres (extension 3) and defective (extension 6). Running it at request time against a live dataset is also the reason it is slow.

**Then.** Compute on ingest, store the result with the run that produced it, and serve the stored value. Same defect class as idempotency (PLT-01 substrate, extension 18): work that must not be recomputed differently on every read.

### DEC-08 — Bias-corrected downscaling

**Already present.** Extension 4 owns it, marked "Partial, degenerate". Not re-listed.

---

## Tier C — Operations

### OPS-01 — State machines for incidents, interventions, tasks and resources

**Now.** `src/operations.js:134,165,194,280` validate that a status is *in* the enum. Nothing validates that a status is *reachable*. An intervention can go from `planned` to `complete` to `planned` to `cancelled` with no objection and no record that it did.

**Then.** A transition table per collection, enforced on write, with the illegal transitions rejected at the boundary rather than discovered in a report a quarter later. This is the substrate OPS-05's audit evidence attaches to.

### OPS-02 — A work queue with escalation

`tasks` is a collection. It has no priority ordering across districts, no assignee, no age, and nothing that makes an unclaimed task visible to anyone.

A queue is the minimum thing that makes the platform an operational tool rather than a database with a map on it: unassigned, oldest-first, escalating when it ages past a threshold.

### OPS-03 — Dispatch the outbox

**Now.** `POST /api/v1/outbox/dispatch` (`src/server.js:570`) works. Nothing calls it. Extension 13's verdict — "Partial, and non-functional" — is exact: the mechanism is correct and the trigger is absent.

Alert actions and community-feedback events are written to the outbox and sit there. **Then:** the same scheduler that already runs `POST /api/v1/ingest/run-due` and `POST /api/v1/report-schedules/run-due` gains a dispatch pass. The scheduler exists; this is one more job in it.

### OPS-04 — Multi-user RBAC with principals in the audit log

`src/auth.js` authenticates tokens. A token carries scopes and a partner org; it is not a person. `action_logs.actor` is a string supplied by the caller.

For a platform whose users are district staff, ministry officials and partner organisation personnel, that is the wrong grain: you cannot answer "who approved this alert" or "which officer has seen this incident", because there are no officers.

**Then.** A principal entity — user, organisation, role — with the token bound to one; every audit entry carrying a principal rather than a free string. Scopes become roles. ENH-01's route→scope table becomes the enforcement point rather than the whole model.

### OPS-05 — Audit evidence on every transition

ENH-28 gives the trail integrity. This gives it *coverage*: an invariant that every state change under OPS-01 emits exactly one log entry, checked in CI.

A hash chain over three entries is a stronger guarantee than no chain. A hash chain over a variable number of entries, where a missing transition produces no entry to chain, is not an audit trail — it is a log with a checksum.

### OPS-06 — Signed report links, PDF and email distribution

ENH-27 makes exports carry the narrative; extension 16 signs releases. This signs an *individual report* so it can be sent to a partner organisation that has no account and no API key: a URL that is verifiable, a PDF that is final, and an email that is sent by the platform rather than forwarded by a person.

**Why it belongs to operations rather than exports:** the distribution record (`report_distributions` already exists) is the evidence that a report reached someone, which is the thing an auditor asks about.

---

## Tier D — Platform

### PLT-01 — Spatial indexing and a real query layer

`lite_records` is one JSON document column. Every bounding-box filter is `JSON.stringify`-and-regex or a post-filter in JavaScript. This works at demo scale and stops working at the scale SRC-04 through SRC-11 will produce — which is to say, this is the item that makes Tier A safe to build.

The Postgres store needs a geography column with a GiST index and a query path that uses it; the JSON store needs a documented "no spatial index" limit rather than pretending.

### PLT-02 — WebSocket or SSE live push

Nothing pushes. The console polls twelve endpoints every thirty seconds (`public/sw.js` documents this poll as the reason the API cache needed bounding). For a district officer watching a flood develop, thirty seconds of latency on a status change is the difference between a live map and a slow one.

SSE is the better fit here: the server already writes NDJSON responses, the client already handles `fetch` streaming for exports, and a WebSocket dependency would be the project's only non-`pg` runtime dependency.

### PLT-03 — `GET/POST /stac/search` and OGC API Features

The catalog endpoints shipped and work. What they do not do is *query*. `/stac/search` is the route that makes a STAC catalog useful to GIS software, and OGC API Features Part 1 requires `bbox`, `datetime` and `limit` on the items endpoint — a query surface, not a listing.

Concretely: `GET /ogc/collections/{id}/items?bbox=…&datetime=…&limit=…` and a `POST /stac/search` taking a full STAC query body. Both are thin over `collectionPage`, which already exists and already accepts query parameters.

Requires PLT-01 to be worth anything at scale.

### PLT-04 — Contract tests against recorded responses, plus a scheduled live probe

ENH-07 asserts our *data* after parsing. Nothing asserts the *upstream shape* we parse. A source that renames a field or drops a nested object does not fail; it returns fewer records, or records with nulls, and the nulls pass ENH-02's honesty envelope because a null with a note is honest.

**Then.** Recorded fixtures per connector, asserted against the parser, so a shape change fails in CI rather than in production. Plus a scheduled live probe against each source's health URL — distinct from ENH-10's circuit breaker, which acts on failure and this observes.

ENH-12's raw payload retention is what makes the fixtures cheap: the recording step already exists.

---

## CC-01 — Cold chain and vaccine viability

This one is written out because it is the clearest illustration of the difference between a process the platform tracks and a question the platform cannot answer.

### Now

Cold chain is a **workflow type**, not a data model:

- `src/workflows.js:5` — `cold_chain_protection` is one of the workflow types, with a state machine at `:16` (`temperature_breach_forecast → moh_notified → action_taken → closed`).
- `src/kpi.js:165` and `src/districts.js:144` — the same three lines, duplicated: filter workflow instances by type, filter again for terminal state, divide.
- `scripts/seed-demo.mjs:360` — eight health facilities with `meta: { cold_chain: true }`, and a seeded trigger protocol `tp-cold` keyed on `temperature_max_c >= 34`.

So the platform can tell you a district ran a cold-chain workflow and closed the ticket.

It cannot tell you whether the vaccine was still viable when it arrived — which is the question cold-chain logistics exists to answer. Three specific reasons:

1. **`cold_chain` is not in `SERVICE_TYPES`** (`src/schema.js:28-37`). A facility's cold-chain status is free-text metadata set by hand at seed time. No import path can set it, because no schema field carries it.
2. **No stock, no telemetry.** There is no representation of a vaccine lot, an ice-pack load, a carrier, a set point or a single temperature reading. `temperature_max_c` is ambient forecast air temperature — the thing the trigger protocol watches is not the thing in the vaccine.
3. **The rate is a process-completion rate.** `cold_chain_protection_rate` is *terminal workflows over all workflows* — the share of tickets closed. Compliance is *time-in-range over time-requiring-in-range*, weighted by what was in the box. The first is measurable from the data the platform already has; the second is the actual question, and a department can have a 100% rate and an excursion rate that would destroy the stock.

### Then

1. **A `cold_chain` member in `SERVICE_TYPES`**, and a `refrigeration_asset` sub-type carrying set point, hold time, power source and last-24h excursion count. Typed rather than metadata, so it is queryable and so `facilities_at_risk` can count it.
2. **Stock and temperature telemetry as user-supplied records** — the same path as service assets, via ENH-25's bulk upload. Lot number, vaccine, carrier, logger ID, timestamp, temperature. This is not a connector: no public feed has a district's fridges. It is the first genuinely operator-supplied dataset in the platform, and it should be shaped like one.
3. **A compliance measure, not a process count.** `excursion_rate` (readings outside range over total readings), `time_in_range_pct` weighted by `hold_time_remaining`, and `stock_at_risk_usd` as a *bounded interval* — the honest form, since the platform cannot know the vaccine's value.
4. **A shelf-life extension model**, using SRC-07's temperature history: vaccines have validated temperature-dependent stability data, and a shipment that spent four hours at 8 °C instead of 2–8 °C has a computable remaining-viability multiplier. This is the one place where the platform could tell an operator something they cannot get from a thermometer.
5. **Keep `cold_chain_protection_rate`**, relabelled as what it is — workflow completion — and stop letting a process count stand in a column headed "protection rate".

**Dependency:** SRC-05 for real facilities. **Extends:** nothing — it is the first vertical where a source, a decision and an operation are the same object.

---

## One line each, if capacity remains

| Item | Why it is not a full item |
|---|---|
| **Vector tiles for the map at scale** | ADR-008 records a deliberate decision to hand-roll SVG rather than take a mapping library. Vector tiles change that decision; it should be re-decided, not quietly adopted as a side effect of SRC-04. |
| **OpenTelemetry and Prometheus exposure** | `src/observability.js` exists and extension 17 owns this. Not a source or a decision. |
| **Two-way RapidPro correlation** | Extension 8, marked "Partial". Depends on OPS-01's state machine to correlate against. |
| **Point-in-time replay over `action_logs` and `source_runs`** | Both collections exist and are append-only in intent. Replay is ENH-13 (bitemporal) applied to operations rather than to hazards. Genuinely useful for after-action review; genuinely not a new capability. |

---

## Sequencing

Three dependencies bind this document, and they are the reason it is ordered this way:

```
SRC-10 population  ─────────────► every rate becomes real
SRC-07 SPI/SPEI  ──┬─► SRC-08 ───► DEC-05 crop calendar
                  └─► DEC-04 detection KPIs
SRC-04/05/11 ─────┬─► CC-01 cold chain (vertical, end to end)
PLT-01 spatial ───┴─► DEC-01 catchments, PLT-03 STAC search
OPS-01 states  ────► OPS-05 audit coverage ──► OPS-04 principals
SRC-01 glofas  ────► DEC-02 discharge alerting
```

**First, because they are cheap and they make everything else honest:** SRC-01, SRC-02, SRC-07, SRC-10.

**First among the operational items, because they are small and they unblock four other items:** OPS-01, OPS-03. OPS-03 in particular is one line in an existing scheduler.

**Then CC-01**, because it is the only item here that is a complete vertical — source, decision and operation on one object — and therefore the only one that proves the platform's shape end to end. A platform that can answer "was the vaccine still viable" has demonstrated something no dashboard mock-up can.

**Then Tier D**, once Tier A has made PLT-01 worth building.

**Last, and only with re-decision:** vector tiles.