# Roadmap extension: all 20 items from `docs/plans/world-class-roadmap.md`

The user asked that everything in the existing roadmap also be covered here. This
document does that, with a twist: rather than restating the proposals, it records
**what actually shipped**.

The finding that matters is that `docs/plans/world-class-roadmap.md` is badly
stale. Written before most of the platform existed, it now describes as future work
things that are implemented, tested and in the module inventory. At least 14 of its
20 items have shipped. An engineer or agent picking it up cold would re-propose
eight or nine capabilities the project already has, and would rank them as the
top priorities.

**Recommendation: retire that file, or replace it with a status table like this
one.** As a planning document it now actively misleads. See also
[_research/00-audit-baseline.md](_research/00-audit-baseline.md#b6-docsplansworld-class-roadmapmd-is-stale-and-should-not-be-used-as-a-source-of-planned-work).

Status vocabulary: **Shipped** — implemented and wired. **Partial** — exists but
does not do what the roadmap asked, usually for a reason worth reading.
**Open** — not implemented. **Rejected** — deliberately not done, with reasoning.

**This document is in two parts, and the status in a section heading is not the
current one.** Items 1–20 below are the audit note as written on 2026-10-05: each
names what was wrong at that tree, with the `file:line` that showed it. The
[Summary](#summary) table near the end is the status **re-verified on 2026-10-16**,
and where the two disagree the table is right — it names the file and the test
that closed each defect. Eight headings disagree with it (1, 2, 4, 5, 8, 13, 14,
15): every one was corrected upward, because the defect had already been fixed.
(Item 7 was the ninth until 2026-10-17, when its CAP half was closed and its
heading corrected with it; item 11 was the tenth and the only one that disagreed
*downward* — its heading said "Shipped, semantically broken" over a table reading
Partial — and it left the list the same day, when the three semantic defects its
body named were checked and all three were closed. A heading that contradicts its
own table in either direction is the same defect, and this list counts both.) The
headings are kept as written rather
than edited, because the
gap between what a note claimed and what the tree does is the finding — but a
reader who stops at a heading and not the table is reading a 2026-10-05 status.
**The body prose was swept on 2026-10-17, and thirteen items had the same defect
the heading list counts: their bodies named a defect the Summary table marks
fixed.** Eight of the thirteen are the headings above (1, 2, 4, 5, 8, 13, 14, 15), and
five more (3, 6, 9, 12, 19) have headings that *agree* with their rows, which is
why the list could not count them. Each of the thirteen now carries a closure
paragraph naming the fix and the guard, and the list above is unchanged — a
closure paragraph corrects the body, not the heading.
Several of the audit note's citations are to a tree that has since moved
(`src/lineage.js` no longer exists; the route table split out of `src/server.js`
into `src/routes/`), so treat a `file:line` in items 1–20 as a record of where the
defect was, not as a pointer to code today.

---

## Data & science

### 1. Probabilistic risk with calibrated uncertainty bands — **Partial**

*Replace point scores with quantile outputs plus a Brier/CRPS calibration report.*

The quantile work is done and was then deliberately walked back. `src/analytics.js:90-96`
records that the fields were originally `score_p10/p50/p90`, that they read as
predictive quantiles, and that they were renamed to sensitivity bands. The
`p10`/`p50`/`p90` aliases are retained for stored consumers. That is a better
outcome than the roadmap proposed.

What is missing: `calibrationReport` is computed at `src/analytics.js:5` and **never
routed** (`src/server.js:835` exports no such endpoint). A calibration report nobody
can fetch does not calibrate anything. Covered by **ENH-03** and **ENH-04**.

**Both halves closed 2026-10-17, and the quantile half was a deliberate walk-back
rather than a loss.** `calibrationReport` is routed: `src/routes/events.js:85`
calls it on the assessment response under a `calibration` key, so the report is
fetchable. The note's `src/server.js:835` is a citation to a tree that has since
moved — the route table split out of `src/server.js` into `src/routes/`, which the
header warns about. The rename the body describes is the better outcome the note
itself concedes: `score_p10/p50/p90` read as predictive quantiles, they are
sensitivity bands, and the aliases are kept for stored consumers. Guard:
`test/lite.test.js`.

### 2. Ensemble & multi-model forcing — **Partial, and dead**

*Persist raw ensemble members; add `src/analytics/ensemble.js`.*

The module was written. It has no live data: no connector sets `ensemble_*`
fields, `spreadSkillIndex` has zero callers, `computeEnsembleStats` is called only
by a test, and the `ensemble_used` branch in `src/analytics.js:53` is
unreachable. `docs/architecture/system-overview.md` §4 lists it in the module
inventory as a working capability.

Decision required: wire it to a real ensemble source, or delete it. **ENH-21** is
what would earn it a place, because ensemble skill verification is the only thing
that would justify preferring `ensemble_p90`.

**The decision was taken and the answer was "wire it", 2026-10-17.** Every claim
in this body is now false against the tree. The module has a live source:
`src/connectors/open-meteo.js:126` calls `computeEnsembleStats` on the members the
API returns, gated on `include_ensemble`, and writes `ensemble_members`,
`ensemble_p10/p50/p90` and `ensemble_source: 'open_meteo_ensemble'` (`:128-136`)
where the connector previously returned quantiles and no members. `spreadSkillIndex`
has a production caller — `src/analytics.js:892` calls it inside `computeFloodRisk`,
which reports `ensemble_spread_index` / `ensemble_spread_basis` /
`ensemble_spread_floor` — so the "zero callers" and "called only by a test" claims
are both stale. The `ensemble_used` branch is reachable, and
`docs/architecture/system-overview.md` §4 was right rather than wrong to list the
module. ENH-21's verification is what justified the preference, which is exactly
the condition this note set. Guards: `test/veracity-followups.test.js`,
`test/lite.test.js`. What the note got right is that the module was dead *when it
was written* — the wiring landed afterwards, and the heading was never revisited.

### 3. Impact-based forecasting (IBF) join — **Shipped, broken on Postgres**

*Cross hazard footprints with service assets and population rasters to produce
people-at-risk and facilities-at-risk.*

`src/analytics/impact.js` exists and is called. Two problems:

- **DAT-05**: `PostgresStore.replaceAnalytics` discards `population_at_risk` and
  `facilities_at_risk` entirely, so on the production backend the figures are
  computed and never stored. Works on JSON, silently absent on Postgres.
- **DATA-03**: `src/analytics/impact.js:71` counts each asset once per nearby
  hazard, inflating both facility counts and population served.

Shipped in shape, wrong in substance, and 100% line-covered while wrong.

**Both closed 2026-10-17.** DAT-05 was two defects in three lines —
`replaceAnalytics` took four parameters where the caller passes six, and used
`merge()` where `replace()` was meant. It now takes one payload and rebuilds all
six `DERIVED_COLLECTIONS` from it in a single transaction
(`src/postgres-store.js:1068`), so the figures the model computes are the figures
the production backend stores. DATA-03 is the assets-outer pass: `distinctAssets`
(`src/analytics/impact.js:29`) collects each asset once and is called on both the
per-hazard path (`:55`) and the union total (`:120`), which is why the note at
`:51` can tell a reader not to sum `population_at_risk` across rows. Both are held
by `test/facilities-at-risk-counting.test.js` and `test/store-conformance.test.js`.
The heading is kept: it named the tree of 2026-10-05 and the *shape* it described —
capability built, wiring missing — is the finding this whole document is about.

### 4. Bias-corrected downscaling for local skill — **Partial, degenerate**

*Quantile-mapping against station observations or uploaded gauges.*

`src/analytics/downscaling.js` exists at 35% line coverage with its entire body
(lines 24-60) uncovered. `quantileMap` returns a constant given one station, and
its `|| 0` coercion puts missing rainfall at zero rather than absent — the same
null-vs-zero conflation the rest of the codebase warns against. The downscaled
output is preferred over observation.

**All three closed 2026-10-17.** The degeneracy is a named, null-refusing floor:
`MIN_STATIONS_FOR_QUANTILE_MAP = 3` beside a grid floor (`src/analytics/downscaling.js:18`,
checked at `:50` and again at `:134`), and below it the map returns `null` for
both value and trace rather than a constant — so the caller is told the correction
could not be made instead of being handed a number that looks like one. The
`|| 0` coercion is gone: non-finite values are filtered out of both distributions
before the mapping (`numericOrNull`, `:118`), so missing rainfall is absent rather
than zero. The coverage figure was true of the tree it was written against and the
body is exercised now. Guard: `test/lite.test.js`.

### 5. Data-quality lineage graph — **Partial, and wrong**

*Emit per-record provenance into a `data_lineage` table.*

The single most genuinely open item on the roadmap, and the one area the codebase
has never examined. `src/lineage.js` is implemented and tested and produces
attribution that is wrong: `src/ingestion.js:181-188` rebuilds a run-wide record
union inside the per-source loop, so a nine-source run writes nine identical
lineage rows with identical `record_count` and `upstream_checksum`.
`upstream_url_or_endpoint` is always null, `transform_version` is a constant, and
IPC and WHO are excluded entirely.

This is **ENH-15**.

**All four claims closed 2026-10-17, and `src/lineage.js` no longer exists.**
`src/provenance.js` replaces it and its header states each of the note's four
defects as the thing it was written to fix: the run-wide record union rebuilt
inside the per-source loop is gone, so a nine-source run writes nine rows with
their own `record_count` and `payload_hashes` rather than nine identical ones
(`:227`, `:256`); `upstream_url_or_endpoint` is no longer always null; the
`transform_version: '0.1.0'` constant is replaced by
`summariseTransformVersions` (`:341`), which reports the versions actually
present; and IPC and WHO are no longer excluded, because the envelope is built
from the connector's own run rather than a hand-kept list. One lineage row per
source run is the shape now (`:223`), with an id that is
`stableId('lineage', [source, source_run_id])` and carries no clock. Guard:
`test/record-provenance.test.js`. The note's judgement — "the single most
genuinely open item on the roadmap" — was right when it was written and is the
reason it got a module rather than a patch.

## Ops, triggering & response

### 6. Anticipatory-action trigger protocols with dry-run + backtest — **Shipped, defective**

*Versioned schema, backtest against history, shadow mode.*

All three exist: `src/alerts.js`, `examples/trigger-protocols/` (5 protocols),
shadow mode. But **INT-02**: the backtest at `src/alerts.js:163-200` ignores
`protocol.metric`, `protocol.operator` and `protocol.threshold` entirely. It counts
whether a hazard followed an ingestion run. `misses` is arithmetically always
zero, so precision and recall are the same meaningless number, and it reports
100%/100%. Under the roadmap's own stated motivation — donor pre-arranged finance
requiring documented trigger histories — a backtest that does not test the trigger
is worse than none, because it produces evidence.

**Closed 2026-10-17.** The backtest evaluates the protocol's own condition:
`resolveMetric(context, protocol.metric)` against
`compare(value, protocol.operator, protocol.threshold)` (`src/alerts.js:467`,
`:478`), and `misses` is incremented on the branch where the condition held and no
hazard followed (`:487`) rather than being structurally zero. The three fields are
carried onto the result (`:502`) so the report says which trigger it tested.
Guard: `test/trigger-backtest.test.js`. The framing above is kept because it is
the reason the check matters — a backtest that does not test the trigger is worse
than none — not because it is still true.

### 7. Human-in-the-loop approval for high-severity alerts — **Shipped**

*`alert_events.approval` state machine with reviewer identity; wire into the SMS
send path.*

The state machine shipped in `src/alerts.js` and `src/workflows.js`, and the SMS
path is gated (then `src/server.js:1582`; now `src/routes/rapidpro.js`). The CAP
endpoint (then `src/server.js:1649-1661`; now `src/routes/alerting.js`) had <!-- line-drift-ok: quoted as it was before the move -->
**no approval gate**, so a human review requirement
enforced on SMS is bypassed by requesting CAP XML instead — the stricter channel is
the ungated one.

**Closed 2026-10-17.** CAP was the second of the two ways an alert leaves the
building, and it now carries the same gate as SMS. CAP 1.2 already has the value
for it: `<status>Draft</status>` is *"a preliminary template or draft, not
actionable in its current form"*, against `Actual`'s *"actionable by all targeted
recipients"* (OASIS CAP v1.2, `<status>` code values, archived at
`sources/CAP-v1.2-os.html`). The renderer hardcoded `Actual`, so an alert no human
had approved published to a national relay with this platform asserting it was
cleared for action. `resolveCapStatus` (`src/cap.js`) now takes the dispatch
path's own predicate — approved means `approved` or `auto_approved`, and an absent
approval is `proposed` — so the two paths cannot disagree. The feed
(`src/cap-profile.js`) marks an unapproved entry `DRAFT (not approved)` rather than
dropping it, because a consumer that dedupes on `<id>` would otherwise keep the
last version it saw and never learn the alert was never approved. `test/cap-encoding.test.js`
holds both paths, including an assertion that CAP and the dispatch gate agree on
every state the store can hold.

The roadmap's framing was right and remains right: *"the code doesn't enforce it
yet"* was true of the CAP path when this note was written, and is now true of
neither.

### 8. Two-way RapidPro flow correlation — **Partial**

*Correlate inbound field reports back to the outbound alert that triggered them;
surface a response rate per alert.*

Inbound free-text parsing exists. Correlation does not. `response_rate_pct`
(`src/rapidpro.js:214`) divides replies by dispatch count rather than recipients, so
a broadcast to 500 people can report 300% (ALERT-05). There is no delivery tracking
and no inbound idempotency, so a retried webhook double-SMs (ALERT-06).

This is **ENH-26**.

**Both closed 2026-10-17, and the heading was wrong in the note's own favour.**
Correlation *does* exist: `correlateReply` (`src/rapidpro.js:907`) matches an
inbound reply to the dispatch it answers, `responseMetrics` counts **responders**
— `metrics.response_count` is incremented inside a `responders.has` guard (`:278`),
so a second message from one person does not raise the numerator and the rate
cannot exceed 100% — and `deliveryReport` (`:1322`) reports delivery. ALERT-05 is
held by `test/rapidpro-response-metrics.test.js`. The inbound idempotency exists
too: `reconcileInbound` (`:948`) keys on
`stableId('rapidpro_inbound', [source_id, from, text])`, so a retried webhook is
recognised and not re-applied, and the send path has a real timeout with retry and
backoff (`:419`, `:55`). Guard: `test/rapidpro-response-metrics.test.js`.
**ENH-26 is what remains**, and the residual is narrower than the note: replies
correlate, but the *content* of a free-text reply is not yet parsed into a
structured assessment.

### 9. Offline-first PWA dashboard — **Shipped**

*Service worker, IndexedDB caching of API responses, background sync queue.*

Shipped and beyond the original ask: `public/sw.js:219-287` precaches the module
graph and queues writes. The console boots offline (fixed in `2a74feb`).

Two gaps remain: API responses are not cached for drill-down, and map tiles are
not cached, so an offline map degrades to an empty frame (**ENH-22**).

**Both closed 2026-10-17.** API GETs are network-first with a cache fallback
under a tested eviction cap (`CACHE_POLICIES.api`, `public/sw.js:64`; the
network-first path at `:689`, dispatched at `:540`), and raster basemap tiles
have their own bucket — 400 entries, a 7-day TTL, routed by prefix at `:165`
rather than sharing the 48-entry map bucket, so a panning session cannot evict
the record payloads the offline path exists to serve. The note's second gap was
the one with a real design question behind it and ADR-013 answers it: tiles are
immutable imagery served same-origin under `/api/v1/basemap/tiles/`, so they get
their own policy instead of the general API one. Guard: the offline round-trip
drill (`test/web-chw-offline.test.js`).

## Platform & integrations

### 10. First-class OGC / STAC compliance — **Shipped**

`src/stac.js`, `/stac/catalog.json`, `/ogc/` Features. Fixed in `36ad94e` after
publishing 233 hazard events at Null Island. Conformance is asserted in
`docs/architecture/system-overview.md` §6 and the standard outputs are correctly
described there as trustworthy, which means errors in them propagate.

### 11. CAP export — **Shipped**

`src/cap.js`. The XML itself is **schema-valid**: correct 1.2 namespace, correct
`xs:sequence` ordering, all required elements, correct escaping in every
server-populated field, and Circle is a legal CAP geometry. That is better than the
roadmap asked for.

Three semantic defects were found under it, and **all three are closed**:

- **ALERT-01 — `Cancel` was unreachable**, because the renderer keyed on
  `rejected`/`cancelled` while `ALERT_EVENT_STATUSES` is
  `open`/`acknowledged`/`resolved`, so rejected alerts kept publishing as live
  alerts. `CAP_MSG_TYPES` is now a total map over the status vocabulary and the
  module **throws** on a status it cannot classify, so a status added to
  `schema.js` without a CAP meaning fails at import rather than publishing as an
  `Alert`. Guard: `test/cap-encoding.test.js`.
- **ALERT-07 — `<scope>` was hardcoded `Public`** for every alert including
  security and conflict. `resolveScope` honours a `scopeOverride` and refuses a
  value outside CAP's three, so a misspelt scope is an error rather than a silent
  `Public`. Guard: `test/cap-encoding.test.js`.
- **ALERT-02 — the CAP path had no approval gate.** `renderCapXml` hardcoded
  `<status>Actual</status>` — CAP 1.2's *"actionable by all targeted
  recipients"* — for every alert, while the SMS dispatch path refuses a
  `proposed` alert with a 409. The CAP document was the second way out of the
  building and the ungated one. `resolveCapStatus` takes the dispatch path's own
  predicate, and the feed marks an unapproved entry. Closed 2026-10-17; see
  `CHANGELOG.md`.

**One residual, and it is bounded rather than blocked.** D30: the area is a
centroid and a radius, and the prose called it a "district extent" — Turkana's
200 km disc covers ~125,000 km² against a county area near 80,000, so a consumer
activating on the circle alerts people well outside the district. Real boundary
polygons would settle it and the repo ingests none, so the fix is to make the
prose agree with the geometry: `areaDesc` and the description now both say
"approximate" and name the radius, and neither claims a boundary. **Closed
2026-10-17** on that basis; the polygon half stays open and is a data-acquisition
item, not a renderer one. Guard: `test/lite.test.js` asserts the wording *and*
that no "district extent" claim survives beside the circle.

### 12. Pluggable connector SDK + registry manifest — **Shipped**

`src/connectors/spec.js`, `connectors.registry.json`, validation in
`test/lite.test.js` and `scripts/validate.mjs`. Done as specified.

The registry has drifted from the code in two places: a `gho_top_years` option
that does not exist, and an IPC default country list of `['KE','SO','SS']` against
46 codes in the connector.

**Both closed 2026-10-17, and the second was not what this note said.**
`gho_top_years` is gone; the registry offers `gho_min_year`, which is what
`src/connectors/who-gho.js` reads. The second was never a `defaults` key — it was
prose inside the `schemas.input.countries` **description string**, naming a default
the connector does not have (`DEFAULT_COUNTRIES` holds 46 Sub-Saharan ISO3 codes,
`src/connectors/ipc-hdx.js:58`). So it was documentation that misinformed rather
than configuration that did nothing, which is a weaker defect than the row claimed,
and it is corrected rather than "fixed". The class needed the check:
`test/connector-registry-parity.test.js` now compares the registry's
`schemas.input` against each connector's live `spec.schema.requestSchema`, with the
`INTERNAL` and `NO_SPEC` exemptions themselves asserted so neither outlives its
reason. **What it compares is the key set, not the descriptions**, so the
`countries` text would still drift silently — the honest scope of the fix.

### 13. Webhook-driven event bus (outbox pattern) — **Partial, and non-functional**

*Durable `events_outbox`, subscription API, dispatcher.*

`src/outbox.js` and `src/webhooks.js` exist at **17.32% line and 25% function
coverage**. Worse than thin coverage, the signed path cannot work:

- **INT-01**: `src/outbox.js:54` calls `signPayload`, defined at
  `src/webhooks.js:44` and imported nowhere. The `ReferenceError` is swallowed by an
  empty `catch`; `last_error` is never written. **Reproduced:** signed subscription
  delivers nothing after 5 retries; unsigned delivers immediately.
- **ING-11**: the backoff is fictional — no `next_attempt_at`, events dropped
  permanently after five tries.
- The outbox write is not transactional with the state change that produced it
  (`src/server.js:1162-1163`), and dispatch marks an event sent if *any* subscriber
  succeeded.
- Nothing schedules dispatch; it requires an explicit POST.

This is the roadmap item that most needs finishing and least looks finished.

**All four closed 2026-10-17.** The signed path works: `signPayload` is imported
and called at `src/outbox.js:382`, setting `x-signature` on every delivery, where
the note's `ReferenceError` was swallowed by an empty `catch`. The backoff is real
— `next_attempt_at` is written and consulted (`src/outbox.js:114`, `:183`), and a
five-try event dead-letters as `failed` rather than vanishing. The write is
transactional with the state change that produced it: `emit` and `emitMany` take
`store.withLock` (`:70`, `:146`) and decide and write inside one transaction, which
is CON-01's fix. And dispatch is scheduled — `runPeriodicTick` drives it on a
timer (`src/server.js:120`, started at `:437`) rather than waiting for a POST.
Guards: `test/outbox-delivery.test.js`, `test/outbox-cross-replica.test.js`. What
this note was right about is the *shape*: it was the item that least looked
finished, and every one of its four claims had a mechanism present and a caller
missing — which is the pattern this document exists to record.

## Security, privacy & compliance

### 14. AuthN/AuthZ with scoped API tokens and audit log — **Partial, and worse than nothing**

*Replace the unauthenticated `/api/v1/*` with scoped tokens; append-only audit log.*

No OIDC exists; `src/auth.js` is a bespoke token table. The roadmap's premise was
right — *"the current server would fail any donor security review"* — and the
implementation did not resolve it:

- **SEC-01**: `src/server.js:237` never rejects an unauthenticated **GET**, so even
  with keys configured, `GET /api/v1/export.csv` returns field reports, RapidPro
  messages and interventions. The deployment looks secured.
- **SEC-03**: a `read:hazards` token can perform every route outside five special
  cases. **Reproduced** 201 on `community-feedback`, `webhooks`, `chw/reply`,
  `outbox/dispatch`, `equity/scan`.
- **SEC-04**: a typo in `LINDELA_LITE_TOKENS` disables auth silently.
- **SEC-06**: `scopeToPartnerOrg` is dead code, yet the portal renders the filter as
  applied.
- **SEC-09**: 8 characters of the bearer token are persisted as the actor in every
  action log.
- The audit log exists but is self-asserted, has no UI, and the three parametric
  write paths write none at all.

**ENH-01** and **ENH-28** are this item, finished.

**All six closed 2026-10-17, and the heading is the most wrong thing in the
document.** "Worse than nothing" was the audit note's judgement on a tree where
the gate failed open; that tree is gone. SEC-01: the GET exemption is replaced by
deny-by-default with an explicit, operator-named allowlist
(`LINDELA_LITE_PUBLIC_PATHS`, `src/auth.js:400`, `:445`), so an unlisted GET is
401 rather than served. SEC-03: the five special cases are replaced by explicit
read and write scope tables, and a mutation with no row fails closed to `admin:*`
(`src/auth.js:19`, `:205`, `:601`). SEC-04: a malformed token table throws
instead of parsing to `[]`. SEC-06 was **not** what the note said — the function
is not dead code, it was never *given* anything: `authenticate()` returned no
`partner_org` field, so `scopeToPartnerOrg` read `undefined` and passed every
record through. The field is set now (`src/auth.js:543`), and the same predicate
is applied on both adapters — `scopeToPartner` filters every collection on the
JSON store (`src/store.js:562`) and Postgres pushes `partner_org = $2` into the
query (`src/postgres-store.js:173`) — with `?partner_org=` refused at the ingress
and the caller's own scope reported by `GET /api/v1/auth-info`. SEC-09: the actor is a SHA-256 fingerprint
(`src/auth.js:544`) and the comparison is `timingSafeEqual`, length-equalised
first (`:526-528`); the note's `token_SUPERSEC` is not recoverable from a log.

The audit-log sentence is closed too, and the second half of it was the larger
claim. The log is no longer self-asserted: `src/audit-chain.js` chains each entry
to its predecessor's *recomputed* hash and `verifyChain` never reads a stored
linkage field as truth, so an attacker who rewrites the whole file and re-chains
it consistently still fails. It has a UI — `public/portal/app.js:206` fetches
`/api/v1/audit/verify` and re-walks the chain **in the browser**
(`verifyChainInBrowser`, `/shared/audit-chain-core.js`), which is the property a
tamper-evident log is for: the check runs somewhere the operator does not
control, and the panel says so plainly when it has no entries to walk rather than
claiming a check that did not run. And the parametric write paths write a row —
the generic create, update and delete in `src/routes/operational.js` each carry
one (`:189-190`, `:223-224`, `:235`), where the note's "three parametric write
paths write none" was true. Guards: `test/auth-deny-by-default.test.js`,
`test/partner-isolation.test.js`, `test/audit-chain.test.js`. What remains is
**ENH-01's** and **ENH-28's** own residuals, not this item's.

### 15. Field-report PII minimisation + retention — **Partial, non-functional**

*Configurable redaction and a background retention task that ages out raw personal
data.*

`src/pii.js` implements both `redactPii` and `applyRetention` with **zero tests**.
Neither is wired:

- `redactPii` is never called from the HTTP field-report path
  (`src/server.js:2240-2248`); reporter name and phone are stored in cleartext. <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
  **Reproduced** in unauthenticated `GET /rapidpro/inbound` and in `export.csv`.
  The RapidPro path *does* redact. The two paths disagree.
- `redactNames` defaults to **false**; the hash is unsalted and truncated to 32
  bits, dictionary-reversible for a bounded name set; the geo-coarsening guard
  uses `if (latitude && longitude)`, so 0° is treated as absent.
- **DAT-07**: the retention route merges only `kept`, and `merge` cannot delete.
  **Reproduced:** a 400-day-old record reported `expired: 1` and remained readable.
  `docs/api.md:567-573` documents a `dry_run` flag that does not exist.

The legal exposure the roadmap identified is real and currently unmet.

**All three closed 2026-10-17, and the "zero tests" claim was false when it was
written.** `redactPii` and `applyRetention` are exercised by `test/pii.test.js`,
and the two wiring paths by `test/privacy-chw-report.test.js`,
`test/privacy-rapidpro-inbound.test.js` and
`test/maintenance-route-module.test.js`. The first bullet is closed: the generic
create path calls `redactPii` on the built record (`src/routes/operational.js:188`),
so the two paths no longer disagree — and it is called *after* the build, not
before, because `normalizeFieldReport` defaults `reported_by` to the literal
`'operator'` and a redactor running first would hash a caller's name while
leaving that system label in cleartext, two shapes in one column decided by
whether the field was sent. The second is closed in all three parts:
`redactNames` defaults **true** (`src/pii.js:12`) — a privacy control that ships
off is a function nobody has to remember to call — the pseudonym is a keyed
HMAC-SHA256 digest at 128 bits, not a truncated unsalted hash (`:329-331`; the
old scheme truncated the *prefixed* string, so every redacted name came out as
the literal `sha256:a`, a dictionary of one entry that names everyone), and the
geo guard tests `lat !== null && lon !== null` (`:115-117`), so 0° is a
coordinate rather than an absence. DAT-07 is closed and the fix is the one the
note implies: `store.remove()` on both backends (`src/routes/maintenance.js:133`,
`src/store.js:1137`, `src/postgres-store.js:841`) where `merge` keyed on id had
left every expired record exactly where it was while the route reported
`{success: true, expired: 1}`. `docs/api.md` now documents the route's real body
— none, and a `400` that names every window the policy could have set — rather
than a `dry_run` flag that does not exist on it. Guards: `test/pii.test.js`,
`test/maintenance-route-module.test.js`, `test/store-conformance.test.js`. What
stays Partial is the *scope*: retention covers `field_reports`,
`rapidpro_inbound_messages`, `community_feedback` and annotations, each with its
own window, and the legal exposure is a deployment's policy to set, not code
still missing.

### 16. Signed, reproducible releases and SBOM — **Partial**

*SLSA provenance, CycloneDX SBOM, cosign image signing.*

SBOM shipped: the CycloneDX job at `.github/workflows/ci.yml:145`. The rest did not.

Three supply-chain defects were named here, and **two of the three are closed**:

- **Unpinned build-time fetches.** Closed. `npx --yes trivy` was not even a
  command — Trivy is not published to npm — so that step failed rather than
  fetching anything; it is `aquasecurity/trivy-action@a9c7b0f…` (v0.36.0) now, and
  the `cyclonedx-npm` and `wait-on` invocations carry exact versions
  (`@6.0.1`, `@9.5.1`). All **17** `uses:` in the workflow are SHA-pinned with the
  tag in a trailing comment; **0** are on a mutable tag. Guard:
  `scripts/check-workflows.mjs`.
- **Six of seven jobs have no `permissions:` block.** Closed, and the count was
  wrong: the file carries a **top-level** `permissions: contents: read` that every
  job inherits, so the correct statement was "no *job-level* block", which is a
  different and weaker finding — the default is least-privilege, not
  write-all. `provenance` adds the one block it needs (`id-token: write`,
  `contents: write`). No CodeQL, which stands.
- **No provenance attestation.** Closed. The `provenance` job invokes
  `slsa-framework/slsa-github-generator` (SLSA level 3, `compile-generator: true`)
  on `refs/tags/v*`, attesting exactly the SBOM's hashes. **No cosign** and no
  release signing, which stands — the item is Partial on those two alone.

### 17. OpenTelemetry traces + Prometheus metrics + structured logs — **Partial**

*Instrument `createServer`, `runIngestion`, `PostgresStore.merge`; expose
`/metrics`.*

Metrics and structured logs shipped: `src/observability.js`, counters, histograms,
Prometheus rendering at `/api/v1/metrics`, JSON request logging. No OpenTelemetry,
no tracing, no spans — that is the whole of the remaining gap.

**Both defects named here are closed, and the second was not a defect.**

- `/metrics` was served **before** the auth gate and did its own `authenticate`, so
  it enforced authentication and never authorization — any valid token read request
  rates, error rates and route labels, the last an enumeration aid. It now goes
  through `enforceAuthGate`, the same function the `/api/v1/` dispatch calls, so the
  two cannot drift (VUL-08). This was the gate-at-19-of-27-paths shape: correct
  policy in `auth.js`, no caller reading it.
- The histogram map is **bounded** — `MAX_METRIC_SERIES = 512`, enforced by `touch`
  across counters and histograms together, with an `overflow` series counting what
  it refuses (R-37). "Unbounded with a client-controlled label" was true when the
  note was written and the label is still client-controlled; the bound is what
  closed it.
- The reversed-arguments call site is gone: no `logger.<level>({…}, 'msg')` call
  survives in `src/` (0, measured), and `observability.js`'s signature is
  `(event, fields)`.

## Reliability, observability & scale

### 18. Idempotent ingestion with content-addressed dedup — **Partial**

*Key records by `sha256(canonicalized-payload)`; make `run-due` a resumable job
with a lease.*

**All three citations this note gave for "dedup shipped" were wrong.** The hash is
`src/utils.js:75` — `src/ingestion.js:139-140` is a `catch` block, and was one at
`b07bbe4` too, where the note's other citation pointed: the only thing at `:147`
there is the *call* to `canonicalHash`, which the file imports at `:2` and never
defines. There is **no** unique index on
`(collection, payload_hash)`: `src/migrations.js:117` creates a *non-unique* partial
index, and `:423` records the decision not to make it unique — `CREATE UNIQUE INDEX`
fails on any deployment already holding the duplicate rows this defect produced, and
the window is closed by an advisory lock instead. And `skip-duplicates` is a string
that appears nowhere in `src/`; the check it names is a `SELECT … WHERE collection =
$1 AND payload_hash = ANY($2)` over the batch's own hashes (`src/postgres-store.js:991`).

Of the four defects named, two are closed, one is half closed, and one is open:

- **DAT-01 — closed.** `write()` puts the whole store through one `#insert`
  (`src/postgres-store.js:649`) that carries `payload_hash` as a column, so a full
  write no longer nulls every hash. Guard: *keeps payload_hash through a full write
  so dedup survives*, `test/store-conformance.test.js`.
- **ING-05 — closed.** `canonicalHash` strips the nested fetch stamp at every depth
  (`withoutFetchStamp`, `src/utils.js:63`). The five connectors that stamp
  `metadata.fetched_at` are real; the stamp no longer reaches the hash. The register's
  row cites DAT-01's test for this, which is the wrong guard — the one that fails
  without the fix is *ignores a fetch stamp nested inside metadata, and nothing else
  nested*, `test/lite.test.js`.
- **ING-04 — closed for the incremental path, open for both archive walks.**
  `fetchWindow` is derived from the stored mark rather than the clock
  (`src/watermarks.js:272`), so two quiet days request an identical window and a mark
  sitting on today mints nothing. The archive and flood walks still derive their id
  from `[SOURCE, region.name, startDate, endDate]` (`open-meteo-archive.js:209`), and
  `endDate` is today whenever the mark has not reached today — so the id is a function
  of the requested window, not of the bytes. Measured in the residual note below.
- **DATA-13 — open, and the one thing this item is still Partial on.** The hash is
  not namespaced, so two records differing only by id collide. `mergeById`
  (`src/store.js:1255`) keys its map on `payload_hash` alone and skips an incoming
  record whose hash it already holds, and `canonicalHash` ignores `id`. Reproduced
  against the store: two service assets identical but for their id merge to **one**,
  the second dropped with no error. `POST /api/v1/upload` then answers `success: true`
  with `imported` set to the rows it *submitted* (`src/routes/upload.js:196`), so a
  GeoJSON re-imported after upstream re-ids its features reads as a successful import
  of N records while N−1 were discarded. This is D8 in `_research/ingestion.md`, and
  it is a reporting defect as much as a dedup one: the store's skip is asserted
  deliberately by *merge() skips records whose payload_hash already exists*
  (`test/database.integration.test.js:98`), and nothing tells the caller it happened.

  **D8's proposed repair does not work, and its own scenario is the counterexample.**
  It says to key the map on `${item.source}:${item.payload_hash}`. In the failure it
  describes, both records carry `source: 'service_assets'` — measured through
  `normalizeServiceAsset` on two assets that differ only by `id` — so the namespaced
  key collides exactly as the bare one does. The reason is that the two scenarios this
  item treats as one are opposite: the archive re-run *wants* content to be the
  identity (a moved id is not a new record), and the upload re-import wants the id to
  be (moved ids are new assets). No key over `(source, hash)` can give both, because
  the same pair — one source, one hash, two ids — is the thing the two want decided
  oppositely. What the product needs is a declared per-source identity policy, and
  `SOURCE_POLICIES` carries none today; the honest interim is the second half of D8's
  own suggestion, reporting the skip count so `/upload` can stop answering
  `success: true` for rows it discarded.
- **No lease.** Still true. `runDueIngestionSchedules` (`src/ingestion.js:850`) walks
  the due schedules in a `for` loop that takes no claim, so nothing prevents a second
  invocation of the same tick from running the same sources concurrently. The
  per-source marks are committed as each source finishes (`src/ingestion.js:557`), so
  a *sequential* re-run is cheap — which is not the same guarantee, and is not a lease.

**The heading said "broken on Postgres" and that half is closed.** DAT-01 was the
Postgres defect and it is fixed; DATA-13 lives in the shared `mergeById`, so it is a
both-backends defect rather than a Postgres one.

This was correctly identified as *"the foundation for the lineage graph in #5"*,
and both #5 and #18 are blocked on the same structural weakness.

## Product & community

### 19. Scenario workbench (deterministic what-if) — **Shipped**

`src/scenarios.js`, `/api/v1/scenarios`, and a `public/scenarios/` surface. Done as
specified, with one defect: scenario means are averaged over different region sets
after perturbation (`src/scenarios.js:57`), so a before/after comparison is not
like-for-like.

**Closed 2026-10-17, and it was real.** The region set is *not* perturbation-invariant:
`collectRegions` (`src/analytics.js:1560`) derives it from the points in the data,
and the perturbation can remove them — `offline_asset_ids` filters service assets
out of the clone (`src/scenarios.js:170`) — so the baseline and the scenario means
were averaged over different denominators. The scenario run now recomputes the
baseline from the unperturbed `data` in the same pass
(`src/scenarios.js:188-206`), and the per-asset comparison is paired by
`asset_id` with the baseline (`:222`), so a removed asset yields `null` rather
than silently leaving the mean. `regions_compared` (`:256`) reports how many
regions the delta is over. This was the item's own heading saying "Shipped" over a
body describing a defect, which is the one direction the header's disagreement list
counts — and it is not on that list, because the heading and the row agree.

### 20. Localization, plain-language rendering, RTL/Arabic — **Partial**

*Externalize strings; i18n catalogs for en/fr/pt/sw/ar/am; plain-language report
mode.*

Localization shipped well beyond the ask: 10 locales in `public/i18n/` including
Amharic, Somali, Kinyarwanda, Khmer, **and** a `din` tag that is not valid BCP-47
(D32). Guards exist: `scripts/check-i18n.mjs` and `check-i18n-offers.mjs`.

The gaps are uneven in a way that matters:

- **The three surfaces a district officer actually uses — `districts`, `scenarios`,
  `parametric` — offer English only**, while the console ships 10 languages.
  *(This said "no locale picker at all". There is a picker on each of the three —
  `districts/index.html:400`, `scenarios/index.html:216`,
  `parametric/index.html:90` — and `public/districts/app.js:62` is
  `OFFERED_LOCALES = ['en']`. The picker is not the defect and cannot be the fix:
  `check-i18n-offers.mjs` derives the expected offer from what is actually
  translated, and for all three namespaces that is `['en']` — 83, 74 and 59 keys
  in `en.json` and **zero** of them in any of the nine other catalogues. Nobody
  translated the strings, so a picker offering Kiswahili would offer a language
  the surface cannot render. The finding is the translation gap, and it is
  larger than this bullet implied.)* Translation effort has gone to the audience
  that was easiest to serve.
- RTL for `ar` is implemented **and reachable** — `public/shared/fmt.js:330-333`
  sets `lang` and `dir` together from one table, the catalogue carries
  `ar: { label: 'العربية', rtl: true }`, and `public/focal-point/index.html:491`
  offers `ar` with the whole `focal-point.*` namespace translated to 100%. The
  surfaces a district officer uses still do not: `chw`, `districts`, `scenarios`
  and `parametric` offer no `ar`.
  *(This bullet said "not implemented". It was implemented on 2026-10-13 and
  reachable through the focal-point surface; the residual is the four surfaces
  that cannot reach it.)*
  The duplicate test it also named is **closed 2026-10-17**: `public/chw/app.js`
  wrote `documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'` by hand, one line
  below a `__i18n.set()` call that already applies both attributes from the shared
  table, so the line was redundant *and* a second spelling of the RTL list. It is
  deleted, and the gate that exists to prevent it — R-63's per-surface check in
  `test/web-locale-boot.test.js` — could not see it, because `chw` was the one
  surface absent from the test's own `SURFACES` enumeration. Adding it there
  makes the surface list complete, and the check now fails on the defect it was
  written for: restoring that line reddens two assertions, the per-surface one and
  "fmt.js is the only module that maps a locale to a direction". No surface
  writes `dir` by hand any more, so the "three surfaces" figure in `fmt.js`'s own
  comment is corrected with it.
- Alert SMS is monolingual (`src/rapidpro.js:301`), which is the one channel that
  reaches the field.
- The plain-language report mode was not built. `src/reports.js` is **1,138** lines
  now (849 when this was written) of template assembly, but it is written for an
  analyst audience, not a community one. The coverage figure that stood beside the
  line count — 90.58% — is not re-measured here and is not the axis to read:
  `scripts/check-coverage.mjs` runs the whole suite and reports lines, branches and
  functions against floors of 92/76/90. A single module's line percentage, from
  the era when coverage ran six files out of 162, is the measurement that gate
  exists to replace.

---

## Summary

> **Re-verified 2026-10-16. Nine of these twenty rows described a defect that
> had already been fixed, and the status column is corrected below.** The
> original statuses are kept in the right-hand column, because the gap between
> what a row claimed and what the tree does is itself the finding: a register
> nobody re-reads is a register that stops being evidence. Each correction names
> the file and the test that closed it.

| # | Item | Status now | Was |
|---|---|---|---|
| 1 | Quantile risk + calibration report | **Shipped** — `calibrationReport` is called on `/api/v1/assessments` (`src/routes/events.js:85`) | "report not routed" |
| 2 | Ensemble & multi-model forcing | **Shipped** — the ensemble has a live source (`src/connectors/open-meteo.js:126`, gated on `include_ensemble`), and `spreadSkillIndex` is now reachable: `computeFloodRisk` reports `ensemble_spread_index` / `ensemble_spread_basis` / `ensemble_spread_floor` (`src/analytics.js`), asserted by `test/lite.test.js` | — |
| 3 | Impact-based forecasting | **Shipped** — assets-outer `distinctAssets` (`src/analytics/impact.js:118`); `replaceAnalytics` writes all derived collections in one transaction (`src/postgres-store.js:1068`) | "broken on Postgres, double-counted" |
| 4 | Bias-corrected downscaling | **Shipped** — `MIN_STATIONS_FOR_QUANTILE_MAP = 3`, null-refusing (`src/analytics/downscaling.js:18`), wired at `src/routes/compute.js:58` | "degenerate with one station" |
| 5 | Data-quality lineage graph | **Shipped** — one lineage row per source run with its own counts and hashes (`src/provenance.js:223`, `test/record-provenance.test.js:385`) | "implemented, tested, wrong" |
| 6 | Trigger protocols + backtest | **Shipped** — the backtest reads `protocol.metric`/`operator`/`threshold` (`src/alerts.js:454-491`, `test/trigger-backtest.test.js`) | "backtest does not test the trigger" |
| 7 | Approval gate | **Shipped** — the SMS path is gated (`src/routes/rapidpro.js:145`) and so is CAP: `<status>` is now `Draft` ("not actionable in its current form", CAP 1.2) unless a human approved the alert (`src/cap.js`, `resolveCapStatus`), and the feed marks an unapproved entry (`src/cap-profile.js`). Guard: `test/cap-encoding.test.js` | "Shipped on SMS, absent on CAP" |
| 8 | Two-way RapidPro correlation | **Shipped** — `correlateReply` (`src/rapidpro.js:907`), `responseMetrics`, `deliveryReport` (`:1322`) | "no correlation, no delivery tracking" |
| 9 | Offline-first PWA | **Shipped** | — |
| 10 | STAC / OGC | **Shipped** | — |
| 11 | CAP export | **Shipped** — message-type mapping is a total map over the status vocabulary and throws on an unclassifiable one (`src/cap.js:24-28`), scope is validated (`:171-180`), and the area prose now describes the circle it emits rather than claiming a boundary (`:99`, `:278`) | "XML valid, semantics wrong" |
| 12 | Connector SDK + registry | **Shipped** — the registry's option surface is compared against each connector's live `spec.schema.requestSchema` (`test/connector-registry-parity.test.js`), so a key the connector never reads fails the suite | — |
| 13 | Outbox event bus | **Shipped** — `x-signature` set on every delivery (`src/outbox.js:382`); `next_attempt_at` written and honoured with backoff | "signed path cannot work" |
| 14 | Auth + scoped tokens + audit | **Shipped** — deny-by-default gate, `timingSafeEqual` (`src/auth.js:527`), `/metrics` behind the gate | "GET unauthenticated, fails open" |
| 15 | PII minimisation + retention | **Shipped** — with one open gap (see below) | "implemented, not wired, retention no-op" |
| 16 | Signed releases + SBOM | **Partial** — SLSA level 3 provenance runs (`ci.yml:271`) as well as the CycloneDX SBOM (`:160`); artifact signing (cosign) is still absent | "SBOM only" |
| 17 | OTel + Prometheus + logs | **Partial** — `/metrics` gated and cardinality bounded (`src/observability.js:130-230`); OpenTelemetry is absent | "metrics and logs only" |
| 18 | Idempotent ingestion | **Partial** — DAT-01 and ING-05 are closed: `payload_hash` persists through a full write (`src/postgres-store.js:649`) and a `fetched_at` stamp nested in `metadata` no longer reaches the hash (`src/utils.js:63`). What is open is **DATA-13**: `mergeById` keys on `payload_hash` alone (`src/store.js:1255`) and `canonicalHash` ignores `id`, so a re-import whose records differ only by id is silently discarded and reported `success: true`. Also no lease on `run-due` | "dedup broken on Postgres" |
| 19 | Scenario workbench | **Shipped** | — |
| 20 | Localization + RTL | **Partial** — **10** locales, not 11, and RTL *is* implemented (`public/shared/fmt.js:299-334`); the pickers offer only English | "11 locales, missing on 3 key surfaces" |

**16 shipped, 4 partial, 0 rejected.** The footer read "5 shipped, 15 partial"
until 2026-10-16, which its own table above has never said — counting the rows
gives 7 `Shipped` and 13 `Partial` at the time, and that count was itself made
from rows a third of which were stale. Row 2 moved Partial → Shipped later the
same day, when `spreadSkillIndex` acquired a production caller (see the row); the
footer follows the table, which is the point. A hand-kept total that disagrees with the
table it summarises is the same failure this register catalogues elsewhere, and
nothing checked it when this paragraph was written:
`test/audit-register-structure.test.js` guards `audit-2026-10/`, and this file
was outside its jurisdiction. That gap is closed —
`test/register-totals.test.js` derives the count from these rows and fails when
the footer, the table and the README index disagree, which is why the sentence
above is dated rather than deleted: it records what the register looked like
before the check existed. (It named the wrong file until 2026-10-17, having been
written in the same commit that added the guard it said was absent.)

### What the re-verification found still open

Three residuals, each verified against the tree rather than inferred, and each
narrower than the row it sits under. **All three are now closed**; what each
actually was, and what closes it, is recorded below.

- **A write path called no redactor (item 15) — fixed 2026-10-16.**
  `redactPii` had thirteen call sites across `src/routes/rapidpro.js` and
  `src/routes/chw.js`; the generic create path called `buildCreate` with none of
  them. Tested through the live ingress: `POST /api/v1/field-reports` with
  `reported_by: "Amina Nakuru"` returned and stored that string unhashed, where
  `redactPii` hashes exactly that field (`src/pii.js:92`). The `reporter_name`
  and `reporter_phone` fields were *not* leaked — `normalizeFieldReport`'s
  allowlist drops them — so the exposure was the free-text attribution field, not
  the contact details.

  `src/routes/operational.js` now calls `redactPii` on the built record. After
  the build, not before, so the field is the one the builder produces:
  `normalizeFieldReport` defaults `reported_by` to the literal `'operator'`, and
  a redactor running before it would hash a caller's name while leaving that
  system label in cleartext — two shapes in one column, decided by whether the
  field was sent. Guarded by `test/operational-route-module.test.js`, which
  asserts the pseudonym shape, that the default and a supplied name agree, and
  that a *resource* name is left alone (the redactor was never about it).
- **Two connector-registry key drifts (item 12) — fixed 2026-10-16.**
  `connectors.registry.json` offered `gho_top_years` while
  `src/connectors/who-gho.js:87` reads `gho_min_year` — a key an operator could
  set that changed nothing and raised no error. Removed. The second half is not
  the same defect and the register stated it wrongly: `['KE','SO','SS']` was
  never a `defaults` key in the registry (`git show 0f23d1a:connectors.registry.json`
  — `defaults` holds only `rateLimit`, `retry` and `timeout_ms`). It was prose
  inside the `schemas.input.countries` **description string**, and it named a
  default the connector does not have: `src/connectors/ipc-hdx.js:58` holds 46
  Sub-Saharan ISO3 codes in `DEFAULT_COUNTRIES`, and `optionCountryFilter` falls
  back to that list, not to three countries. So the drift was documentation that
  misinformed rather than configuration that did nothing — a weaker defect than
  the row claimed, and corrected rather than "fixed".

  The class is what needed the check, not the two instances. The registry's
  `schemas.input` is now compared against each connector's live
  `spec.schema.requestSchema` in `test/connector-registry-parity.test.js`, with
  two declarations that are themselves asserted: `INTERNAL` for the request keys
  the runner injects rather than offers (`now`, `on_watermark_state`, the
  watermark cursor), and `NO_SPEC` for the five connectors that predate
  `defineConnector` and export no machine-readable surface. An entry that stops
  being true fails, so an exemption cannot outlive its reason. Three canaries
  fired. **What the check compares is the key set, not the descriptions** — the
  `countries` text above is not machine-readable and would still drift silently,
  which is the honest scope of this fix.
- **Two id-drift defects in dedup (item 18) — fixed 2026-10-16, by the hash and
  not the id.** `src/connectors/ipc-hdx.js:250` stamps `fetched_at` inside
  `metadata`, and `canonicalHash`'s ignore list is top-level only, so that stamp
  was hashed as content: a same-content re-run produced a new `payload_hash`.
  `withoutFetchStamp` (`src/utils.js`) now strips that key at every depth before
  hashing. It is deliberately key-specific rather than a blanket recursive strip,
  because `action_logs.metadata.removed_rule.created_at` is *content* — an
  archived rule's real creation time — and stripping it would make two different
  rules hash alike, which is the defect `canonicalise` exists to fix. A canary
  proves the blanket strip fails a test.

  The archive half is not what the register said. `src/connectors/open-meteo-archive.js`
  puts `endDate` in the id, so **the id does still move with the clock day** —
  measured, `climate_54fbaa9bb207b2f8` on 10-16 against
  `climate_85e7f433bc2019ad` on 10-17 with identical `daily` content. Writing
  "the id no longer drifts" would be a false reason on a true result. What
  prevents the duplicate is that `mergeById` (`src/store.js:1255`) checks
  `payload_hash` **before** the id and skips an incoming record whose hash it
  already holds — so the `fetched_at` fix is what closes this, through the hash
  path. The id was never the guard. There is still no lease or claim mechanism,
  which is why item 18 stays Partial.
- **The hash path is now the *only* guard, which is DATA-13 arriving from the
  other side (item 18) — open.** The same precedence that closes the archive
  churn discards a re-import whose records differ only by id: `canonicalHash`
  drops `id`, so two records identical but for their id hash alike, and
  `mergeById` keeps the stored one and drops the incoming one with no error.
  Reproduced against the store — two service assets, same fields, ids `asset-A`
  and `asset-B`, merge to one row. `POST /api/v1/upload` reports `success: true`
  and `imported: report.rows.length` (`src/routes/upload.js:196`), which is the
  count it *submitted*, not the count that landed. *merge() skips records whose
  payload_hash already exists* (`test/database.integration.test.js:98`) asserts the
  skip deliberately, so the behaviour is intended and the *silence*
  is the defect: a GeoJSON re-imported after upstream re-ids its features reads
  as a successful import of N records while N−1 were discarded. **D8's proposed
  repair does not work**: keying on `${item.source}:${item.payload_hash}` still
  collides here, because both records carry `source: 'service_assets'` — measured.
  The two scenarios are opposite wants on the same pair (one source, one hash, two
  ids): the archive re-run wants content to be the identity, the upload re-import
  wants the id to be. What is needed is a declared per-source identity policy, which
  `SOURCE_POLICIES` does not carry; the honest interim is to have the merge report
  what it skipped, so `/upload` stops answering `success: true` for discarded rows.

The pattern is consistent and worth naming: this project builds the capability and
then does not finish the wiring. Item 3 computes the impact figures and never stores
them on the production backend. Item 5 writes lineage for every source on every run
and attributes it wrongly. Item 11 emits standards-conformant CAP for alerts that
were rejected. Item 15 implements redaction and retention and calls neither from a
request path.

> **That paragraph is the register's thesis and nine of its examples are now
> false.** Items 3, 5 and 15 all shipped, and item 11's semantics were corrected;
> the wiring was finished in each case, which is the outcome the paragraph was
> arguing for. It is kept because the failure mode it names is real — the
> residual list above found a second door with no gate, and a registry that had
> drifted from its connector — but a reader should take the four items named as a
> historical illustration, not as a current defect list. Every residual above is
> now closed, and two of the three were narrower than the row that carried them.

That is a good failure mode — the hard part, the part requiring judgement and
domain knowledge, is done everywhere. What is missing is the class of check that
verifies a built capability is actually reachable: an adapter conformance suite, an
end-to-end "does the figure reach the caller" test, an assertion that a rejected
alert is not published. Five of the fifteen partials would be Shipped by adding a
test that fails today.

> **The five are shipped, and this sentence was still here** (re-verified
> 2026-10-16). It is the same claim `docs/improvements/README.md` carried and the
> same one that file's own note now corrects: the items it points at were wired
> on 2026-10-06 and 2026-10-07. What survives is the diagnosis rather than the
> count — the missing check is still the missing check, which is why ENH-29 and
> ENH-02 remain the two items worth most here even though the five are done.

This is why **ENH-29's conformance suite** and **ENH-02's payload-honesty gate** are
worth more than any single feature in this repository: they convert "we built it"
into "we built it and it is connected".