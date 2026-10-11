# Fifty enhancements — audit 2026-10

**Scope.** Non-incremental changes: each either moves a systemic quantity by an
order of magnitude (throughput, veracity, or cognitive cost) or opens an
operational paradigm the platform cannot currently express. Cosmetic work,
localised refactors and feature creep are excluded by construction — an item that
cannot state its order-of-magnitude claim in one sentence does not appear here.

**Relation to the prior audit.** `docs/improvements/enhancements.md` holds
`ENH-01..ENH-30` (trust, ingestion, visualisation, response, foundations). This
set is `ENH-31..ENH-80` and is disjoint from it; no item below restates one above.
The prior audit asked whether the platform is honest and whether its claims work.
This one asks what it cannot yet *do*, and what it does too slowly.

**Scoring.** Impact and Effort are 1–5. `Score = 0.6·Impact + 0.4·(6−Effort)`,
so a high-impact, low-effort item (5,1 → 5.0) outranks a high-impact, high-effort
one (5,5 → 3.4). Effort is engineering weeks at the current team size, not
calendar time: 1 ≈ days, 5 ≈ a quarter.

---

## Status against the tree — verified 2026-10-11

Every row below was checked against the code, not against the note beneath it.
The per-item notes carry the detail; this is the summary, and it exists because
the two had drifted: three items were marked shipped while four others were
shipped and unmarked, and the register was the last place anyone looked.

| Verdict | Count | Items |
|---|---|---|
| IMPLEMENTED | 13 | 31, 35, 37, 40, 46, 48, 49, 61, 63, 64, 65, 66, 81 |
| PARTIAL | 12 | 32, 33, 42, 50, 51, 52, 55, 57, 59, 70, 72, 78 |
| ABSENT | 26 | 34, 36, 38, 39, 41, 43, 44, 45, 47, 53, 54, 56, 58, 60, 62, 67, 68, 69, 71, 73, 74, 75, 76, 77, 79, 80 |

PARTIAL means the substrate exists and the item's own claim does not: ENH-32
pulls from DHIS2 and does not push, ENH-33 has districts and no org-unit codes
or parents, ENH-59 has three tables checked against each other and no single
declaration they are generated from. Reading a PARTIAL as done is the error this
table exists to prevent.

---

## Group G — Interoperability substrate: push, not only pull

The platform can *ingest* from the humanitarian ecosystem and cannot *publish*
to it. For a coordination platform that is the wrong half: DHIS2, HDX and
KoboToolbox all expect to consume, and none of them will poll a bespoke JSON API.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-31 | HXL-tagged CSV export | 4 | 1 | 4.4 |
| ENH-32 | DHIS2 `dataValueSet` push | 4 | 2 | 4.0 |
| ENH-33 | Administrative org-unit registry | 5 | 3 | 4.2 |
| ENH-34 | Versioned datasets with citable handles | 4 | 3 | 3.6 |
| ENH-35 | OGC API Features + STAC catalogue | 3 | 3 | 3.0 |
| ENH-36 | CAP 1.2 profile validation and feed permalinks | 3 | 2 | 3.4 |
| ENH-37 | Streaming bulk export (NDJSON/Arrow) | 5 | 2 | 4.6 |

**ENH-31 — HXL-tagged CSV export.** A one-line change to the CSV writer that
emits an HXL hashtag row above the header (`#loc+name`, `#date+occurred`,
`#affected+flooded`). HDX's whole ingestion pipeline keys on it; without it a
partner must hand-map every column. `src/server.js` `export.csv` route; the
hashtag registry belongs in `src/schema.js` beside the field definitions.

**Shipped 2026-10-11.** `src/hxl.js` holds the registry and `toCsv(records, {hxl})`
emits the row; `GET /api/v1/export.csv?hxl=1` serves it. Two deviations from the
note above, both deliberate.

The registry went in its own module rather than in `src/schema.js`. `schema.js`
holds the *store's* vocabulary — the status and type enumerations a record is
validated against — and this registry is keyed by the *export's* column names,
which are what `flattenRecord` makes of a record key: a nested field becomes a
dotted path (`location.admin1`), an underscored one stays underscored
(`source_id`). Putting it beside the field definitions would have invited
writing it against the store's names, and that mistake is silent — the tag
simply never matches a header and the column reads as unmapped.

The row is built by looking each header up (`hxlRow(headers)`), not by walking
the registry. A row built by walking the registry emits every hashtag in
registry order, and `toCsv` sorts its headers, so the file would carry tags that
are each correct and each on the wrong column with nothing downstream able to
tell. The canary that walks the registry fails 3 cases.

It is opt-in (`?hxl=1`), because an export that changed shape when an option was
added would break every consumer already parsing it and the change would look
like an improvement in the diff. `?hxl=maybe` is a 400, not a truthy read —
`Boolean('maybe')` is true, so a truthiness test tags the export for a caller who
did not ask. Eleven cases in `test/hxl-export.test.js`; canaried in three
directions (registry-order row: 3 failures; truthiness: 1; a malformed hashtag in
the registry: 5).

**ENH-32 — DHIS2 `dataValueSet` push.** `src/connectors/dhis2.js` already speaks
DHIS2 to *pull*. The push half is a serializer plus a scheduled job: map the KPI
rollups to org-unit/dataElement/period triples and POST to `/api/dataValueSets`.
Today interoperability is one-way, which for a national platform is a blocker.

**ENH-33 — Administrative org-unit registry.** District resolution is scattered
across `src/districts.js`, `src/utils.js`, `src/kpi.js`, `src/analytics/metrics.js`,
`src/calibration.js`, `src/reports.js` and `public/shared/districts-view.js`, each
re-deriving the hierarchy. A registry with codes, a parent pointer and boundaries
turns a district split from a data migration into a config change, and gives every
aggregation one source. This is the DHIS2 org-unit primitive the platform lacks.

**ENH-34 — Versioned datasets with citable handles.** `/api/v1/export.*` returns a
live query with an ETag. A report citing "the flood-risk dataset" cannot name which
vintage it read. Snapshot exports into an immutable, licence-tagged, handle-addressable
collection so a downstream consumer can cite a version and reproduce it.

**ENH-35 — OGC API Features + STAC catalogue.** The vector layers and raster
products are served bespoke. OGC API Features and a STAC catalogue make them
discoverable by QGIS, GDAL and any geospatial client without custom code.

**ENH-36 — CAP 1.2 profile validation and feed permalinks.** `src/cap.js` emits CAP
XML. Add strict 1.2 profile validation (so a consumer's parser does not reject it)
and a stable `/feed` permalink per alert, which is how GDACS and FEWS NET are
consumed in practice.

**ENH-37 — Streaming bulk export.** `collectionPage` materialises the full result
set in memory before serialising (see SCL-03). A chunked NDJSON/Arrow export that
streams from the store keeps memory bounded regardless of table size and lets a
partner pull millions of rows. This is the substrate ENH-31/32/34 all ride on.

**Fixed 2026-10-11.** `/api/v1/export.ndjson` streams via `store.iterateRecords`.
Measured on the demo store before the fix: `export.csv` returned **501 lines — 500
data rows — against 12,929** non-history records, and `?limit=5000` returned 1,343.
The cap is `parseLimit`'s `DEFAULT_LIMIT`, applied to a route that never says it is
paged, in a `text/csv` body with no marker — a silent truncation of 12,429 records
on the surface a partner is most likely to treat as the record of truth. The
streamed route returns all 12,937 records (the extra 8 arrive after the CSV read),
`?collection=field_reports` returns 168, an unknown collection is a 400, and
`?limit=`/`?cursor=` are refused rather than honoured or ignored — `filterRecords`
reads both, so honouring `limit` would reintroduce the cap through a second door
and ignoring it would be the `?district=` defect. NDJSON rather than streamed CSV
because a CSV header is the union of every record's flattened keys and is not known
until the last record; each NDJSON line is self-describing. Arrow was not built —
it needs a schema before the first row, the same problem, and adds a dependency
this package does not carry. Tests: `test/streaming-export.test.js` (11).

The route first shipped dispatched *below* the line that reads the whole store,
so it streamed its output while holding its input: on a store past SCL-01's
read-row budget — the one store this route exists for — it answered 503 before
the first byte, and below the budget it materialised everything anyway. Probed,
not reasoned: a 100-row store with a 10-row budget returned 503, and now returns
200 with 100 lines. The route moved above that read, and takes the district
parent collections it needs (`districtRelationCollections`) through a narrow read
rather than being handed the whole store. Both halves are canaried — reverting
the move fails the budget test, dropping the narrow read fails the attribution
test, and neither canary touches the other's test.

`export.csv` and `export.geojson` were truncating too, and stayed that way for
the first pass of this work: the register's measurement — 500 of 12,929 — was a
statement about the *existing* CSV route, and a new correct route beside a
truncating one leaves the truncation on the format partners actually file. Both
now pass `unlimited: true`. The cap saved nothing there — the dispatcher has
already materialised every collection for a wide route — it only made the file
lie. Pinned in the same test file, and canaried by removing the flag.

---

## Group H — Offline-first field system (ODK/KoboToolbox class)

The outbox gives exactly-once *intent*. What it lacks is a versioned form model,
which is the primitive ODK is built on and the reason a district can change a
question without a redeploy.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-38 | Versioned form definitions | 5 | 4 | 3.4 |
| ENH-39 | Conflict-free submission merge | 5 | 4 | 3.4 |
| ENH-40 | Durable outbox with client idempotency keys | 4 | 2 | 4.0 |
| ENH-41 | Field-level two-way sync | 4 | 5 | 2.8 |
| ENH-42 | Offline map tile packs | 3 | 3 | 3.0 |
| ENH-43 | SMS/USSD submission fallback | 4 | 4 | 3.2 |
| ENH-44 | Submission quality gates | 4 | 2 | 4.0 |

**ENH-38 — Versioned form definitions.** The CHW wizard is hard-coded
(`public/chw/app.js`, 1,179 lines). A form is a first-class, versioned artifact
(question, type, constraint, skip logic) stored server-side and served to the
client. A district changes a question without a redeploy; the mobile app and the
web wizard share one schema.

**ENH-39 — Conflict-free submission merge.** Each submission carries a UUID and the
form version it was filled against. The server merges on that key, so two versions
in the field reconcile instead of overwriting. This is ODK's instanceID primitive
and the reason offline submissions are safe to sync.

**ENH-40 — Durable outbox with client idempotency keys.** `src/server.js`
idempotency requires a client `Idempotency-Key` the service worker does not
generate (see CON-06). Mint one per queued mutation so a retry after a process
restart is deduped rather than duplicated, and make the store durable rather than
in-process-capped at 1,000 entries.

**ENH-41 — Field-level two-way sync.** Vector-clock or per-field last-writer-wins
so an edit made offline on a phone and an edit made online in the console converge
without one clobbering the other. The hard version of ENH-39; the payoff is a
genuinely collaborative record.

**ENH-42 — Offline map tile packs.** `basemap.js` is inline polygons and fetches
nothing, so the offline map is a fixed asset. Let an operator define a bbox and
generate a downloadable pack (PMTiles) so a CHW's phone has the terrain for their
ward without a connection.

**ENH-43 — SMS/USSD submission fallback.** A structured SMS grammar for the field
report subset, and USSD for feature phones. The RapidPro two-way layer
(`src/rapidpro.js`) already exists; this extends the inbound verb grammar to
submissions so the platform reaches the last mile it claims to serve.

**ENH-44 — Submission quality gates.** GPS accuracy, timestamp skew versus receipt
time, and near-duplicate detection at submission, carried on the record rather than
silently dropped. The field-report path has a coordinate guard; generalise it to a
quality verdict so a coordinator can weight a report by how much to trust it.

---

## Group I — Veracity enforcement engine (make honesty mechanical)

The platform's discipline is real but *written*, not *enforced*: a comment says
"an absent forecast is not a 0% chance," and three lines below, `?? 0` does exactly
that (VER-02). These items turn the discipline into checks the build cannot pass
while violating.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-45 | Aggregation-kind registry | 5 | 2 | 4.6 |
| ENH-46 | Absent-value linter as a gate | 4 | 2 | 4.0 |
| ENH-47 | Unit and dimension registry | 4 | 3 | 3.6 |
| ENH-48 | Provenance-stamped exports | 4 | 2 | 4.0 |
| ENH-49 | Contingency-table integrity monitor | 4 | 2 | 4.0 |
| ENH-50 | Model-card and floor registry | 4 | 3 | 3.6 |
| ENH-51 | Reconciliation ledger | 5 | 4 | 3.4 |

**ENH-45 — Aggregation-kind registry.** Declare every metric `additive`,
`intensive` (a mean — must not be summed) or `extensive`. A helper that refuses to
`reduce` an intensive quantity makes VER-01 (precipitation summed across stations,
`src/analytics.js:452`) impossible to write rather than merely fixed. The bug is a
map of station density; the registry is the cure for the class.

**ENH-46 — Absent-value linter as a gate.** `?? 0`, `|| 0` and `Number(null)` on a
nullable field are the repository's named defect class. A static gate over `src/`
that flags a numeric fallback on a field the schema marks nullable turns each
instance (VER-02, VER-12) from a bug found by audit into a build failure.

**Shipped 2026-10-11.** `scripts/check-absent-values.mjs`, registered
`self-contained` in `scripts/run-gates.mjs`.

One deviation from the note above, and it is the whole design. The gate does not
read nullability from the schema, because the schema does not carry it — `SCHEMA`
in `src/store.js` lists collections, not field types, and inventing a parallel
field-type table would be a second source of truth for a fact the code already
states. **It reads the declaration the tree makes instead**: a field is nullable
when the same module publishes a `<subject>_refusal` beside it. That is this
codebase's own convention for "the number is absent, and here is why" —
`src/kpi.js:301`, `src/equity.js:105`, `src/calibration.js:363` — and a module
that has adopted it has said in code that the number can be missing. A
hand-written field list was the alternative and it is the worse one: it goes
stale silently, and the field that gets added next is exactly the one nobody
remembers to add to it.

That decision is what makes the scope defensible in both directions, which is
the only thing a gate of this kind is judged on. Too broad and it flags the
`?? 0` in `data.field_reports?.length ?? 0` — a count of an array with no third
state — and it is turned off within a week, correctly. Too narrow and it stops
matching the fields that matter while still reporting a number that looks like
coverage. Twelve canaries pin both edges, and the test file asserts the canary
expectations are not uniform, so a scanner returning a constant cannot satisfy
them.

The refusal is per *site*, not per field, because the same expression is right
in one place and wrong in another: `total += row.false_alert_rate ?? 0` inside an
accumulator whose divisor is the count of measured rows is not the same act as
publishing that field in a payload. Telling those apart needs a type system; the
gate takes the conservative reading and gives the accumulator an escape hatch —
`absent-ok: <reason>`, with the reason required, so a judgement call becomes a
line a reviewer reads. It found one site in the tree, `warning_to_action_field_samples`,
which is a genuine count returned on both branches of `fieldActionLatency` and now
carries its marker.

Canaried in both directions against the real tree: injecting `?? 0` into
`src/kpi.js`'s `false_alert_rate` makes the gate exit 1 and name the site;
restoring it exits 0.

**ENH-47 — Unit and dimension registry.** Millimetres, metres, hours, people,
percent — declared with dimensions, and checked at the boundary where a number
enters or leaves. `src/analytics/numeric.js` is the absent-value gate; this is its
unit sibling. It catches a mm/metre mix that currently renders as a plausible number.

**ENH-48 — Provenance-stamped exports.** Every exported row carries `source_id`,
`observed_at` and `payload_hash` (the record already stores the hash —
`src/ingestion.js:392`). An export a partner cannot trace is an export they cannot
defend; the stamp is what makes ENH-34 citable.

**ENH-49 — Contingency-table integrity monitor.** VER-03 is a filter and a labeller
reading different date fields (`src/flood-probability.js:101` vs `:194`), so an
event is counted but never labels a month. A check that the set admitted by the
prefilter equals the set the label function can see turns that class into a failing
test.

**Shipped 2026-10-11.** The monitor is `events_unlabelled` and `label_coverage`,
returned by `buildDistrictSamples` and published on `/api/v1/flood-probability`
beside `events_matched` (`src/flood-probability.js:130-140`, `src/server.js:2031`).
Two deviations from the entry as written:

- **The label function returns the events, not a boolean.** `monthHasFlood` became
  `monthFloodEvents` (`src/flood-probability.js:220`), and the sample's `label` is
  `matched.length > 0` over the same array the monitor counts. That is what makes
  the two halves agree *by construction* rather than by two implementations that
  happen to match today — which is exactly the failure VER-03 was, one level up.
- **The residual is published, not refused.** With the date fields agreeing, an
  event the pre-filter admits and no sampled month can label is one outside the
  months the rainfall series could sample: a record from before the CHIRPS window,
  or from a month whose trailing window was too sparse to keep. That is a real
  state, so `label_coverage` reports the share rather than the fit refusing — but
  it reports, because `events_matched` alone reads as "this many events informed
  the fit" and only some of them did. `label_coverage` is `null` when no event was
  admitted, this module's convention for a ratio over an empty set.

Guarded by four cases in `test/lite.test.js`, one of which is the VER-03 canary:
an event dated only by `from` must reach the label and the coverage count. Verified
failing on the reverted labeller (1 fail, `occurred_at` alone).

**ENH-50 — Model-card and floor registry.** Every model publishes its basis, its
sample floors and its refusal vocabulary in one machine-readable place
(`MODEL_BASIS` is the seed). `check-no-flood-probability.mjs` reads it today; a
registry lets every surface render "not measured" from the same declaration the
model refuses with.

**ENH-51 — Reconciliation ledger.** Join the bitemporal history and the provenance
layer so every published number traces to the inputs and the run that produced it,
and a number that changed with unchanged inputs (already logged at
`src/analytics.js:417`) becomes a reconcilable event rather than a log line. This
is the substrate for the determinism claim in ENH-76.

---

## Group J — Decision and planning (novel operational paradigms)

The platform reports. It does not yet *decide*, and the difference is the whole
point of an early-warning system.

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-52 | Anticipatory Action trigger engine | 5 | 4 | 3.4 |
| ENH-53 | Resource pre-positioning optimiser | 5 | 5 | 3.0 |
| ENH-54 | Value-of-information estimator | 4 | 4 | 3.2 |
| ENH-55 | Scenario comparison workbench | 4 | 4 | 3.2 |
| ENH-56 | Compound-hazard risk model | 5 | 5 | 3.0 |
| ENH-57 | Scheduled multi-audience briefing | 4 | 3 | 3.6 |
| ENH-58 | Counterfactual impact evaluation | 4 | 5 | 2.8 |

**ENH-52 — Anticipatory Action trigger engine.** A forecast crossing a declared
threshold fires a pre-agreed action within a funding window, with the trigger, the
crossing and the action all recorded. This is the paradigm shift from "here is a
risk score" to "here is what happens next and who is funded" — the reason
anticipatory action exists as a field.

**ENH-53 — Resource pre-positioning optimiser.** Given the forecast distribution
and the road network (`src/road-access.js`), compute where to stage stock to
minimise expected unmet demand. A stochastic allocation over the uncertainty the
platform already carries, not a point estimate.

**ENH-54 — Value-of-information estimator.** Rank the *data gaps* by how much
closing each would reduce decision loss. Turns the honesty about what is not
measured (all seven regions currently refuse drift with a reason) into a
procurement priority.

**ENH-55 — Scenario comparison workbench.** Side-by-side interventions with their
uncertainty, over the same region and window, so a coordinator compares rather
than reads one number at a time.

**ENH-56 — Compound-hazard risk model.** Flood, conflict and disease interact
(`computeClimateConflictRisk` exists in isolation). A joint model with explicit
dependence beats three independent scores a planner must combine by hand.

**ENH-57 — Scheduled multi-audience briefing.** `src/narrator.js` audits its own
output against the fact set. Extend it to scheduled generation of role-specific
briefings (district officer, national coordinator, partner) from the same grounded
fact set, so the narrative cannot invent a figure for any audience.

**ENH-58 — Counterfactual impact evaluation.** Given a dispatch and a matched
comparison set, estimate what the intervention changed. This is what turns the
platform from a reporting tool into an accountability one.

---

## Group K — Platform substrate (throughput, concurrency, observability)

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-59 | Single route-table generator | 5 | 3 | 4.2 |
| ENH-60 | Router extraction from the god object | 5 | 4 | 3.4 |
| ENH-61 | Streaming cursor reads | 5 | 3 | 4.2 |
| ENH-62 | Content-addressed derived cache | 4 | 3 | 3.6 |
| ENH-63 | Durable cross-replica idempotency + outbox lock | 5 | 3 | 4.2 |
| ENH-64 | End-to-end request/correlation id | 4 | 2 | 4.0 |
| ENH-65 | Per-server state, not module globals | 4 | 2 | 4.0 |
| ENH-66 | Backpressure and admission control | 4 | 3 | 3.6 |
| ENH-67 | Read-replica split with a query budget | 4 | 4 | 3.2 |

**ENH-59 — Single route-table generator.** Five tables describe the routes and
drift: `src/server.js` (68 literal conditions + 16 helpers), `src/route-manifests.js`
(183 entries), `docs/openapi.yaml` (150 paths), `src/auth.js` scopes (91 entries)
and the client's 29 endpoints. Generate all five from one declaration. Adding a
route then touches one file, and "nine live routes went undocumented" cannot recur.

**ENH-60 — Router extraction.** `handleApiRequestInContext` is 1,597 lines
(`src/server.js:763–2360`) and entangles routing, auth, validation, business logic
and serialisation. Behind the ENH-59 table it splits into ~15 modules, each
testable in isolation. This unblocks every other substrate item.

**ENH-61 — Streaming cursor reads.** `PostgresStore.read()` issues
`SELECT collection, body FROM lite_records WHERE …` with no `LIMIT`
(`src/postgres-store.js:267`) and materialises every row into the heap. A cursor
API bounded by request keeps memory flat and makes ENH-37 possible.

**Fixed 2026-10-11.** `iterateRecords(options, { batchSize })` on both adapters:
`DECLARE lindela_stream NO SCROLL CURSOR` → repeated `FETCH n` → `CLOSE` in a
`finally` that also releases the client, so an abandoned stream (the ordinary
case — a partner closes the socket mid-export) does not bleed a pool connection
per export. `readPredicate(options)` was extracted and is now shared by `#readWith`
and the cursor, because the partner clause is a visibility boundary and a second
copy would be a second answer to "which rows may this caller see". The batch
default is 1,000 and the walk is verified at 2,500 rows in batches of 1,000.
Tests: `test/streaming-export.test.js` (3 of the 9).

**ENH-62 — Content-addressed derived cache.** `refreshAnalytics` recomputes eight
derived collections on every run and reads the store twice
(`src/analytics.js:226`, `:283`). Key each derived value by the digest of its
inputs (`inputDigestFor` exists) and skip recomputation when nothing changed.

**ENH-63 — Durable cross-replica idempotency and outbox lock.** The dispatch lock
is an in-process `WeakMap` (`src/outbox.js:129`) and the idempotency store is
in-process (`src/server.js:637`). Two replicas both POST the same outbox row.
`pg_advisory_lock` plus a durable key table makes exactly-once real across a fleet.

**ENH-64 — End-to-end request/correlation id.** No request id exists anywhere
(`grep request_id|correlation src/` is empty). Mint one at ingress, put it on every
log line and every response, and propagate it into the ingestion run id — so a 500
returned to a client joins to the log entry for that request.

**ENH-65 — Per-server state.** `idempotency` (`src/server.js:637`), the driver
timers (`:225`) and the metrics registry are module-global, so two servers in one
test process share them and tests are order-dependent. Threading them through
`createServer` makes isolation the default.

**ENH-66 — Backpressure and admission control.** The outbound rate-limit queue is
unbounded (`src/rate-limit.js:213`) and the store read is unbounded (SCL-01).
Bounded queues with a 503 + `Retry-After` under sustained load convert a
memory-exhaustion failure into a refusal, which is the platform's own idiom.

**ENH-67 — Read-replica split with a query budget.** Analytical reads
(`filterRecords`, `refreshAnalytics`, `/ready`) go to a replica; writes stay on the
primary. A per-request query budget fails a route that scans the whole store rather
than letting it degrade every other caller.

---

## Group L — Cognitive efficacy (order-of-magnitude user cost)

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-68 | Grounded natural-language query | 5 | 4 | 3.4 |
| ENH-69 | Expected-value alert triage | 5 | 3 | 4.2 |
| ENH-70 | Uncertainty-first map | 4 | 2 | 4.0 |
| ENH-71 | Intent-driven progressive disclosure | 4 | 3 | 3.6 |
| ENH-72 | Explainable ranking everywhere | 4 | 2 | 4.0 |
| ENH-73 | Time-to-decision instrumentation | 4 | 2 | 4.0 |
| ENH-74 | Collaborative annotation threads | 3 | 3 | 3.0 |

**ENH-68 — Grounded natural-language query.** "Which districts crossed the flood
threshold last week and have no dispatch?" answered over the store, grounded in the
same fact set `narrator.js` audits against, refusing when it cannot ground. The
console's 144 controls exist because the operator must assemble the query by hand;
this collapses that.

**ENH-69 — Expected-value alert triage.** Rank alerts by cost-weighted expected
loss, not recency. The alert engine raises events; the triage surface should order
them by what acting now is worth, using the severity weights (currently three
inconsistent implementations — ARC-04) and the exposure of what is downstream.

**ENH-70 — Uncertainty-first map.** The map shows what is known; what is *not*
known (records outside the frame, areas too large to place, undetermined
classifications — already computed in `public/app.js`) should be as prominent as
the data. An operator reading a clean map should see the gaps in it.

**ENH-71 — Intent-driven progressive disclosure.** HX-05 counted 144 controls above
the fold; the command band reclaimed the pixels. The deeper fix is to show controls
for the task the operator is doing, not all controls at once — a role-and-intent
driven surface rather than a layout one.

**ENH-72 — Explainable ranking everywhere.** `viz-explain.js` explains a record's
score. Every ranked list — alerts, districts, assets — should state its arithmetic
and its gaps, so a ranking is an argument rather than an assertion.

**ENH-73 — Time-to-decision instrumentation.** Measure how long it takes an
operator to reach a decision from a surface, not clicks. The redesign's whole
premise (band 195px → 55px) is a hypothesis about cognitive cost that nothing
currently measures.

**ENH-74 — Collaborative annotation threads.** A coordination platform's users need
to talk to each other on a record. Threaded annotations with the same provenance
discipline as the record itself.

---

## Group M — Assurance, supply chain and federation

| ID | Enhancement | Impact | Effort | Score |
|---|---|---|---|---|
| ENH-75 | Client-side audit-chain verification | 4 | 3 | 3.6 |
| ENH-76 | Deterministic replay harness | 5 | 4 | 3.4 |
| ENH-77 | Synthetic-population load model | 4 | 3 | 3.6 |
| ENH-78 | Executable security regression suite | 5 | 3 | 4.2 |
| ENH-79 | Jurisdiction-aware data residency | 3 | 4 | 2.8 |
| ENH-80 | Federated multi-node deployment | 4 | 5 | 2.8 |

**ENH-75 — Client-side audit-chain verification.** `src/audit-chain.js` verifies
server-side with an out-of-band anchor. A browser verifier (the chain is a hash
walk) lets a partner confirm a record's integrity without trusting the server that
served it — the property a tamper-evident log is supposed to have.

**ENH-76 — Deterministic replay harness.** Given a captured run (`src/capture.js`
exists), reproduce any published number bit-for-bit. This is the strongest possible
version of the platform's honesty claim: not "we say what we computed" but "you can
recompute it."

**ENH-77 — Synthetic-population load model.** Drive the API from a model of real
access patterns (a CHW syncing, a console polling, a partner pulling) to find the
capacity ceiling before a flood season does.

**ENH-78 — Executable security regression suite.** SSRF (VUL-01), tenant isolation
(VUL-03) and authz (VUL-04) as specs that fail the build, modelled on the existing
`assertSafeWebhookUrl` guard. A guard that exists for webhooks and not for
distribution is a guard that was never generalised.

**ENH-79 — Jurisdiction-aware data residency.** Field data is PII-adjacent
(`src/pii.js` already HMAC-pseudonymises). Route and retain per jurisdiction so a
deployment can honour a residency requirement without a fork.

**ENH-80 — Federated multi-node deployment.** Multiple Lindela nodes (national,
regional, partner) that peer-sync with the store layer's own conformance contract,
so no single central store is a chokepoint or a single point of failure. The
bitemporal model is the substrate; this is the topology it enables.

---

## Filed after the audit

**ENH-81 — The console follows `next_cursor`.** Found while fixing ARC-06.
Every list route already pages properly — `matchedAndPage` returns
`next_cursor` and refuses a cursor that names no record — and no client reads
it. The console fetches one page (`/api/v1/alert-events?limit=30`) and pages
inside that window with `pageWindow`, so on a set larger than the fetch the
rows past it are unreachable. ARC-06 stopped the *count* from claiming
completeness; it did not make the rows reachable. This is the paging
implementation the client never had: walk the cursor, or fetch a page sized to
the operator's actual viewport and page the server rather than the array.

Order-of-magnitude claim: a deployment with more alerts than its fetch limit
currently cannot reach them at all, from any surface. That is unbounded rows
unreachable against a fixed number reachable.

**Fixed 2026-10-11.** `fetchAllPages` in `public/shared/paging.js` walks
`next_cursor` to the end of the set, or to a `maxPages` cap. It is DOM-free and
takes `fetchPage` as an argument, so it is unit-tested without a browser — nine
tests in `test/paging.test.js`, including the 61-row case the entry describes
(30 fetched, 31 unreachable before).

The cap is the part that needed care, and it is where the entry's own logic
extends one layer down. A walk that stops at `maxPages` and returns what it
holds, saying nothing, is the same defect: a page that reads as the whole set.
So the return carries `truncated`, set by two causes that must not be conflated
with "complete" — the cap was reached with the set still going, or a page failed
mid-walk. Both leave a list that is real and incomplete, which is a thing the
operator can be told; `failed` distinguishes them.

The rail now fetches through the walk (`limit: 200, maxPages: 20`) instead of
`?limit=30`, and `renderPagerScope` gained a `capped` case. Without it the
pager's own arithmetic said "**0 are not loaded**" over a capped walk — the walk
holds every row the count came from — which is precisely the sentence this entry
exists to remove. It now reads "older alerts were not fetched — narrow the
filter to reach them."

Canaried four ways: stopping the walk after one page (18/22, all four
walk-dependent tests), reporting the cap as completion (21/22, only the cap
test), disabling the capped copy (56/57, only the copy test), and a no-op
replacement of the point guard that correctly changed nothing. `check-budget`
passes at 214.4 KB against 216 KB — 1.6 KB of headroom, no raise.

---

## Scoring matrix (all fifty, ranked)

| Rank | ID | Impact | Effort | Score | Group |
|---|---|---|---|---|---|
| 1 | ENH-37 | 5 | 2 | 4.6 | G |
| 1 | ENH-45 | 5 | 2 | 4.6 | I |
| 3 | ENH-31 | 4 | 1 | 4.4 | G |
| 4 | ENH-33 | 5 | 3 | 4.2 | G |
| 4 | ENH-59 | 5 | 3 | 4.2 | K |
| 4 | ENH-61 | 5 | 3 | 4.2 | K |
| 4 | ENH-63 | 5 | 3 | 4.2 | K |
| 4 | ENH-69 | 5 | 3 | 4.2 | L |
| 4 | ENH-78 | 5 | 3 | 4.2 | M |
| 10 | ENH-32 | 4 | 2 | 4.0 | G |
| 10 | ENH-40 | 4 | 2 | 4.0 | H |
| 10 | ENH-44 | 4 | 2 | 4.0 | H |
| 10 | ENH-46 | 4 | 2 | 4.0 | I |
| 10 | ENH-48 | 4 | 2 | 4.0 | I |
| 10 | ENH-49 | 4 | 2 | 4.0 | I |
| 10 | ENH-64 | 4 | 2 | 4.0 | K |
| 10 | ENH-65 | 4 | 2 | 4.0 | K |
| 10 | ENH-70 | 4 | 2 | 4.0 | L |
| 10 | ENH-72 | 4 | 2 | 4.0 | L |
| 10 | ENH-73 | 4 | 2 | 4.0 | L |
| 21 | ENH-34 | 4 | 3 | 3.6 | G |
| 21 | ENH-47 | 4 | 3 | 3.6 | I |
| 21 | ENH-50 | 4 | 3 | 3.6 | I |
| 21 | ENH-57 | 4 | 3 | 3.6 | J |
| 21 | ENH-62 | 4 | 3 | 3.6 | K |
| 21 | ENH-66 | 4 | 3 | 3.6 | K |
| 21 | ENH-71 | 4 | 3 | 3.6 | L |
| 21 | ENH-75 | 4 | 3 | 3.6 | M |
| 21 | ENH-77 | 4 | 3 | 3.6 | M |
| 30 | ENH-36 | 3 | 2 | 3.4 | G |
| 30 | ENH-38 | 5 | 4 | 3.4 | H |
| 30 | ENH-39 | 5 | 4 | 3.4 | H |
| 30 | ENH-51 | 5 | 4 | 3.4 | I |
| 30 | ENH-52 | 5 | 4 | 3.4 | J |
| 30 | ENH-60 | 5 | 4 | 3.4 | K |
| 30 | ENH-68 | 5 | 4 | 3.4 | L |
| 30 | ENH-76 | 5 | 4 | 3.4 | M |
| 38 | ENH-43 | 4 | 4 | 3.2 | H |
| 38 | ENH-54 | 4 | 4 | 3.2 | J |
| 38 | ENH-55 | 4 | 4 | 3.2 | J |
| 38 | ENH-67 | 4 | 4 | 3.2 | K |
| 42 | ENH-35 | 3 | 3 | 3.0 | G |
| 42 | ENH-42 | 3 | 3 | 3.0 | H |
| 42 | ENH-53 | 5 | 5 | 3.0 | J |
| 42 | ENH-56 | 5 | 5 | 3.0 | J |
| 42 | ENH-74 | 3 | 3 | 3.0 | L |
| 47 | ENH-41 | 4 | 5 | 2.8 | H |
| 47 | ENH-58 | 4 | 5 | 2.8 | J |
| 47 | ENH-79 | 3 | 4 | 2.8 | M |
| 47 | ENH-80 | 4 | 5 | 2.8 | M |
