# Remediation catalog

93 defects requiring remediation. **Disjoint from the 50 enhancements** in
[02-enhancements.md](02-enhancements.md): nothing here is a proposal, everything here
is a repair. Where a repair is large enough to be a proposal, it is filed there and
cross-referenced with a `→ ENH-nn` tag rather than duplicated.

Severity is consequence-in-the-field, not exploitability:
**S1** the system does not do the thing it exists to do ·
**S2** a class of failure is silent or a control is absent ·
**S3** measurable waste, brittleness or drift.

---

## A. Critical — the system does not do its job

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-01** | The service worker cannot install. Offline is entirely dead; every offline capability is unreachable code. | `public/sw.js:41` has 11 top-level exports; `public/shared/runtime.js:15` registers it as a classic script. Reproduced in-browser: `ServiceWorker script evaluation failed`, `getRegistrations()` → 0. With `{type:'module'}` → registered. | S1 |
| **R-02** | Nothing raises an alert automatically. `evaluateAlertRules` is called only from `POST /api/v1/alerts/evaluate`; the scheduler calls neither that nor anything that calls it; `refreshAnalytics` does not evaluate. A threshold crossing produces a risk score and nothing else. | `src/server.js:1104-1105`, `:2349`; `docker-compose.yml:59-62`; `run-due` handler read in full | S1 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-03** | The scheduler discards every error it can produce. `\|\| true` makes a 401, a 500 and "nothing was due" indistinguishable, and nothing collects the loop's stdout. | `docker-compose.yml:59-62` | S1 |
| **R-04** | Alert → SMS is manual and unretried. A failed dispatch sets `status='failed'` and returns 502 to the caller; there is no retry, no timer, and nothing raises an alert about the failed dispatch. A focal point approves a trigger and no SMS reaches anyone. | `src/server.js:2235`; `src/rapidpro.js:58-61`, `:63-77` | S1 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-05** | A full ingestion run's records live only in RAM until every source finishes. `store.merge` at the end is the only persistence. `gdacs_archive` alone is ~166 requests / ~4.2 h worst case; a kill at hour 3.9 loses the run and the next run restarts from 1985, a hardcoded constant. | `src/ingestion.js:392`; `src/connectors/gdacs-archive.js:60-62`, `:74-76` | S1 |
| **R-06** | Partner isolation is not applied on three live routes. Scoping is an opt-in third argument to `filterRecords`; three handlers do not pass it, and the by-id branch does not scope at all. A partner token reads every organisation's field reports. | `src/server.js:2536`, `:2393`, `:1501`, `:2543`; `src/utils.js:130`, `:182` | S1 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->

---

## B. Security

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-07** | "Deny by default" holds for writes and not for reads. An unmapped GET falls back to `read:hazards` — a real, routinely-issued scope — rather than to denial. A test asserts the fallback, pinning the hole. | `src/auth.js:300` (`DENIED_SCOPE = 'admin:*'` at `:19`); `test/route-scope-coverage.test.js:161` | S2 |
| **R-08** | ~20 GET routes are readable by the narrowest legitimate scope: `/audit/verify`, `/kpi/quarterly{,.md,.pdf}`, `/kpi/monthly-series`, `/parametric-disbursements`, `/equity/*`, `/analytics/*`, `/model-drift`, `/data-lineage`, `/data-quality`, `/flood-probability/*`, `/scenarios`, `/parametric-rules`, `/trigger-protocols`, `/report-distributions`. | `src/auth.js:300`; enumerated against `READ_SCOPES` | S2 |
| **R-09** | No inbound rate limiting of any kind. `src/rate-limit.js` is an **outbound** connector limiter whose only importer is `src/connectors/http.js:68`. No `429`, no `remoteAddress`, no `x-forwarded-for`. One upload can saturate the store; `/ingest/run` fans out to ~46 countries × 2 real third-party requests. | `src/rate-limit.js:12-13`; `grep` shows one importer | S2 |
| **R-10** | The service worker caches API responses in a bucket that does not vary on the token. `jsonResponse` emits no `Vary`; `networkFirst` keys the cache on the request. A shared device serves org A's data to org B, surviving logout, with a 7-day TTL on the detail bucket. | `public/sw.js:440`, `:451`; `src/utils.js:463-497` | S2 |
| **R-11** | The outbound rate limiter is 100% inert. All 14 connector call sites pass neither `source` nor `rateLimit`, so `RATE_LIMIT_POLICIES` is dead configuration and `ipc_hdx` runs an unbounded ~46-way `Promise.all` — 92 requests against a declared 20/min — with no `Agent`. | `src/connectors/http.js:186-187`, `:230`, `:260-261`; `src/connectors/ipc-hdx.js:265`; 14 call sites enumerated | S2 |
| **R-12** | `community_feedback` is the only PII-bearing collection with no retention rule. It carries `reporter_urn_hash` and free-text `message` and is never expired, while the two collections holding the same class of data are. Retention is POST-only and unscheduled. | `src/server.js:779-790`; `src/community.js:31-36` | S2 |
| **R-13** | `/stac/*` and `/ogc/*` sit entirely outside the auth gate, dispatching before `handleApiRequest`. `stacItem` spreads every field of the source record into `properties` with no redaction. No field reports reach it today; clinic, water-point and road locations do. | `src/server.js:104-107`, `:200`; `src/stac.js:171-173` | S2 | <!-- line-drift-ok: quoted as it was; R-13 is fixed (`ad5d8f6`) and the ENH-60 extraction moved every line the citation names -->
| **R-14** | The container runs as root and `.dockerignore` misses `.omc`. `docs/` ships in the runtime image and is served **unauthenticated** at `/docs`. | `Dockerfile:1-24`; `.dockerignore:5`; `src/server.js:3301-3312` | S3 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-15** | `isPublicPath` prefix-matches, so `/api/v1/health/anything` is public — and executes a full-table `store.read()` first. An unauthenticated read amplifier. | `src/auth.js:153`; `src/server.js:486` | S3 |

### Checked and clean — stated so they are not re-audited

| Checked | Result |
|---|---|
| SQL injection | **None.** Every value parameterised, including batch inserts (`UNNEST`) and the `pruneVersions` window. No dynamic `ORDER BY`, `LIMIT` or identifier interpolation anywhere. `src/postgres-store.js:206-220`, `:302-317`, `:334-349` |
| Path traversal | **None.** `safeJoin` resolves then relativises and rejects `..`; `hasTraversalSegment` additionally rejects `..` on the decoded raw URL including double-encoding. `src/server.js:3314-3321`, `:3447` | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| SSRF | **None.** `NON_PUBLIC_IPV4` in `src/webhooks.js` blocks RFC1918, loopback, link-local (so `169.254.169.254`), CGNAT, multicast and reserved, handles IPv4-in-IPv6, and resolves DNS **at dispatch time** not at registration, closing rebind. 5 s abort. `src/outbox.js:26`, `:69` |
| Webhook signature | **Correct.** HMAC-SHA256 over exact raw bytes, `timingSafeEqual` over digests of both sides so length cannot be probed, raw body buffered before verification, absent secret is 503 not an open door. `src/rapidpro.js:298-356`; `src/server.js:432` |
| Upload traversal | **Not applicable.** CSV-only. No filesystem write, no filename, no storage location. `src/upload.js` |
| `Math.random()` for security | **None.** The only use is outbound jitter (`src/rate-limit.js:513`). Token ids are `crypto.randomUUID`; pseudonyms are keyed HMAC truncated to 128 bits (`src/pii.js:171-175`) |
| CAP XML injection | **None.** Every interpolated value passes `escapeXml`; the module throws at import if a status has no `msgType`. `src/cap.js:90-121`, `:34-38` |
| CSV formula injection | **Fixed.** `neutraliseFormula` applies to header rows as well as values. `src/utils.js:398` |
| Log injection | **None.** `observability.js:46` serialises every line with `JSON.stringify`. |
| 5xx error disclosure | **Fixed.** `error.message` exposed only for deliberate 4xx; 5xx returns a UUID and logs the detail. `src/server.js:142-161` |

---

## C. Concurrency

| id | Anomaly | Window | Reachable | Sev |
|---|---|---|---|---|
| **R-16** | The idempotency store never reserves a key. The entry is written **after** the handler returns; `createIdempotencyStore`'s own docstring describes a `{commit: fn}` shape no code produces. A client that times out and retries re-executes the whole handler — for `/ingest/run`, the entire ingestion. | `src/server.js:400`, `:413`, `:420`; `src/utils.js:274-276`, `:297-301` | Yes | S2 |
| **R-17** | Watermarks are last-writer-wins at the persistence layer. `advanceWatermark` is correctly forward-only *inside the connector's own state*; the merge has no such guard. Two overlapping runs make the store's cursor move backwards. | `src/watermarks.js:307`; `src/ingestion.js:207-213`; `src/store.js:437` | Yes, via R-16 | S3 |
| **R-18** | Two `JsonStore` instances on one path collide on the temp filename and fail with ENOENT. Keyed on pid only. | `src/store.js:290`, `:293` — reproduced | Low | S3 |
| **R-19** | `captureBody` pushes into **every** live recording, and `beginFetchRecording` has no `try/finally`. A leaked key permanently owns `[0]`, and every later run reports a stale `upstream_url_or_endpoint`. Under any source parallelism every lineage row's URL is another source's. | `src/connectors/http.js:338-340`; `src/ingestion.js:201`, `:260` | Yes | S3 |
| **R-20** | Re-emitting an outbox event resets its retry counter, so `maxRetries = 5` is unreachable for any re-emitted event. The "exponential backoff" the comment promises does not exist — no `next_attempt_at`, no time check. | `src/outbox.js:10`, `:97`, `:109`, `:28` — reproduced | Yes | S3 |
| **R-21** | `dispatchPending` has no mutual exclusion between its read and its merge. Two concurrent dispatches deliver twice. No `advisory_lock` or equivalent exists anywhere. | `src/outbox.js:28`, `:119`; `grep -ni advisory_lock src/` → 0 | Yes | S3 |
| **R-22** | `emit()` precedes `merge()` in every caller, non-atomically. A failure of the second leaves an outbox event announcing a transition that never happened, and subscribers act on it. | `src/server.js:3215`, `:3248`, `:2360`; `src/outbox.js:19` | Yes | S3 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->

### Checked and clean

`JsonStore.#serialise` (`src/store.js:279`) has **no** lost-update window — 20 concurrent
merges on one instance all landed (1,790 ms). No cross-instance lost update either:
`read()` re-stats per call, so a stale snapshot self-heals. `runConnectorWithRetries`
(`src/ingestion.js:600-614`) correctly guards negative retries. `endFetchRecording`
is reached on the connector-throw path. No floating promises in `capture.js`.

---

## D. Scalability

| id | Bottleneck | Complexity | Measured / read | Sev |
|---|---|---|---|---|
| **R-23** | `read()` selects the whole table, sorts in SQL **and** in JS, and runs a linear `COLLECTIONS.includes()` per row — on every request, before routing. | `O(N log N + B)` per request | 87 ms (JS sort) + 53 ms (membership) per request; N=39,715 | S2 |
| **R-24** | `merge()`, `remove()` and `replaceAnalytics()` each end in a second full-table read whose result **all 44 call sites discard**. Every write costs 2× the read. | 2× per write | `src/postgres-store.js:277`, `:376`, `:412`; 44 discarded `await store.merge(...)` | S2 |
| **R-25** | `store.write()` is a full-table `DELETE` + reinsert for a one-record edit. Four routes call it to add a single parametric rule. | `O(N + B)` per edit | `src/postgres-store.js:181`; `src/server.js:2807`, `:2834`, `:2853`, `:2931` | S2 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-26** | `pruneVersions()` window-scans the entire version table on every bitemporal merge, partitioned and ordered on two unindexed JSONB extractions. | `O(V)` = 31,549 rows / 85 MB per merge | `src/postgres-store.js:302-317` | S2 |
| **R-27** | Pagination is `findIndex` + `slice` over a fully materialised array, behind 18 chained `.filter()` passes, and `total` makes it structurally non-lazy. | `O(M)` for a page of L; **no `LIMIT`/`OFFSET` exists anywhere in `src/`** | 8.2 ms to produce a 50-row page from 31,549 rows; `src/utils.js:182-253` | S2 | <!-- the 8.2 ms was the 18-filter chain, which SCL-03 removed; re-measured 2026-10-16 at 7.04 ms for the chain and 0.38 ms for the shipped single pass, same 34,058-row collection -->
| **R-28** | The JSON store's write cache is invalidated by every write. `#writeFile` sets `#parsed = next` **and** `#parsedStamp = null`, so the next read re-stats and re-parses the whole file. The comment claims the opposite. | ~100× on read-after-write | warm 0.2 ms / cold-after-write 24.9 ms, measured; `src/store.js:298-299` vs `:233-237` | S2 |
| **R-29** | `JSON.stringify(next, null, 2)` — 112.6 ms vs 17.6 ms compact. Pretty-printing is 84% of merge cost and inflates the file ~40%. | 6.4× | measured at 37.8 MB; `src/store.js:292` | S2 |
| **R-30** | The two `region`/`observed_at` generated columns and their indexes are written and maintained on every INSERT and UPDATE, and **no query in the repository reads either**. **Fixed 2026-10-15:** migration 7 drops them. The audit's "no readers" was exactly right and the cause is one layer up: `PostgresStore.read` issues a single `SELECT collection, body … WHERE <collection|history|partner>` and `normaliseReadOptions` accepts no filter, so *no* query names any of the ten columns migrations 3 and 5 added, and no index on that table is reachable by anything. Wiring them to their filters instead was measured and rejected: `recordInDistrict` matches case-insensitively, splits on `[,;/]`, falls back to haversine and traverses `incident_id`/`intervention_id`/`alert_event_id` to a located record, and the time filter tries nine timestamp fields — so a predicate on one column returns *fewer* rows than the filter it replaces, and `area` (which the column COALESCE'd) is not a spelling the filter accepts at all. Wrong answer in place of a slow one. | write amplification | `src/migrations.js:335`; `test/store-cost.test.js`, `test/migrations-postgres.test.js` | S3 |
| **R-31** | Six of the eight filters `filterRecords` actually implements have no index of any kind; `bbox` is a comparison on two JSONB-extracted numbers. **Fixed 2026-10-15:** same defect as R-30 and the same repair — the eight migration-5 columns (`country`, `source`, `status`, `severity`, `incident_id`, `intervention_id`, `service_type`, `owner`) are dropped by migration 7. They were added *for* these filters and are unreachable for the reason above; each was also non-equivalent to its filter (`incident_id`/`intervention_id` also match `item.id`). The filters keep working, unchanged, in JavaScript — asserted through `filterRecords` on a migrated database in `test/migrations-postgres.test.js`. An index that would be correct here is one over the row set the filter computes, which is a function of the body and the district relations, not a column. | `O(N)` per filter | `src/utils.js:193` vs `src/migrations.js:58`; `test/store-cost.test.js` | S3 |
| **R-32** | `upsertCollection` ships every `payload_hash` in a collection to Node to build a Set. | `O(C)` rows per merge | 4,517 rows for `food_security_records`; `src/postgres-store.js:320-325` | S3 |
| **R-33** | The health check is the load generator. `Dockerfile`'s `HEALTHCHECK` and the `app` healthcheck in `docker-compose.yml` polled `/api/v1/health` every 30 s, and that request executes the whole-store `read()` (38 of 65 collections; `collectionsForRequest` returns `null`). Readiness existed and was unused by either. **Fixed 2026-10-13:** both probes now curl `/api/v1/ready` — one scoped read of `action_logs` + `events_outbox` behind a 2000 ms timeout, answering 503 not 500 when the store is down. Guarded by `test/deployment-probe.test.js`, which judges every `/api/v1/…` path either deployment file curls. | full read every 30 s, forever | `src/routes/liveness.js:83`; `Dockerfile:59`; `docker-compose.yml:73` | S2 |
| **R-34** | The KPI cache key is seven array lengths. A run that revises 99 field reports to 100 between two dashboard loads returns a 5-minute-stale figure for a quarter whose numbers changed. **Fixed 2026-10-15:** `kpiCacheKey` now digests the *content* of all seven collections, streamed into one `sha256` with a per-collection terminator, so a same-length in-place revision — the common case, since a correction changes a value and not a count — moves the key. The aperture the audit named (99 → 100) was the narrow one; a richer projection (lengths plus newest id) would have left a corrected row in the middle of an array invisible, which is the same defect with a smaller hole. A row that will not serialise mixes a nonce in rather than throwing, so a cache-key problem never becomes a 500 on a route that used to answer. `api_uptime_pct` stays out of the key and is still restamped in place on the cached path (QUA-01), so the identity assertion in `test/observability-substrate.test.js` still holds. Guarded by `test/kpi-cache-key.test.js`, canaried by reverting the key to the length-join — 4 of 9 tests fail. | correctness | `src/kpi.js:35` | S3 |
| **R-35** | Store ordering is not identical between the two adapters, contrary to the comment. JSON fixes order at write time; Postgres re-sorts on every read. A write path that appends without sorting leaves the two stores disagreeing, with no error. | correctness | `src/store.js:443` vs `src/postgres-store.js:161-163`; `src/server.js:2834` | S3 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-36** | `CAPTURE_COLLECTION = 'payload_captures'` is not in `SCHEMA`, so `assertDeclaredCollections` throws on it. The capture store cannot be persisted through either adapter, contrary to the comment. | correctness | `src/capture.js:33-35`, `:53` | S3 |

---

## E. Observability and silent failure

Full silent-failure inventory in the analyst's domain report; the load-bearing rows:

| id | Failure class | How it presents | Who finds out | Sev |
|---|---|---|---|---|
| **R-37** | Metric label cardinality is unbounded. `normalizeRoute` collapses only id-shaped segments, so any unmatched path becomes a permanent series. | `/metrics` grows without limit | Nobody | S2 |
| **R-38** | `histogram()` retains every sample forever (`entry.values.push`) and `render()` re-walks the whole array per scrape, although `buckets` is declared and never used for accumulation. | scrape cost `O(requests since boot)` | Nobody | S2 |
| **R-39** | Label-less histograms render invalid Prometheus text — `''.slice(0,-1)` leaves no opening brace. Both current histograms have labels, so this is latent. | series silently discarded | Nobody | S3 |
| **R-40** | No correlation ID exists anywhere. One focal point approval produces a workflow row, an outbox row and an `action_log` row in three non-atomic writes with no shared token. An operator cannot trace one action across the pipeline. **Fixed 2026-10-13:** the store's merge funnel stamps `_request_id` from `currentRequestId()` onto every record it lands, so all three rows of one approval share the token and the pair can be rejoined from either side. The seam is the funnel, not the three constructors: `actionLog()` and `emit()` would cover two of the three and miss the workflow row, and forty-odd merge call sites make a stamp at the remembered ones a gate at three of them. Ambient, so a driver tick or a script stamps nothing rather than `null` — "belongs to a request we failed to record" is a different and false claim. Stamped in both adapters *and* in Postgres's `#mergeLocked`, which is the second funnel the outbox's read-modify-write takes. | untraceable | `src/store.js:512`; `src/postgres-store.js:685`; `src/postgres-store.js:833`; `src/bitemporal.js:47`; `test/request-correlation-rows.test.js`; `test/pg-write-lock.test.js:212` | S2 |
| **R-41** | The circuit breaker can never trip. State is created per `runIngestion` call and each source is visited once, so `consecutive_failures` cannot reach a threshold of 3. `/ingest/status` reports a health score for a breaker that does not exist. | breaker never opens | Nobody | S2 |
| **R-42** | Every source's `min_count_vs_trailing` assertion is dead in production: `runSourceAssertions` is called without `trailingRecords`, so the baseline is `median([])` = null and it is always reported `unmeasured`. The assertion that would catch GDACS collapsing 40,000 → 4,000 never executes. Tests pass `trailingRecords` in 21 places; production in zero. | count drift invisible | Nobody | S2 |
| **R-43** | The assertion report is never persisted. `stats`, `unmeasured` and each failure's structured `detail` are discarded; only flattened `.message` strings survive. | diagnostics thrown away | Nobody | S3 |
| **R-44** | `freshnessReport` has no production caller. `ingestionStatus` recomputes the verdict ad hoc with no `recentRecordCounts` and no `now`, so the three-run window is dead code and `quiet`/`ok` always keys off a single run. | verdict less reliable than designed | Nobody | S3 |
| **R-45** | A connector returning 200 with an empty body is classified `quiet` — "nothing new, and nothing is due yet" — indistinguishable from a genuinely quiet feed. The conflation ENH-06 exists to eliminate, surviving on the exact case it names. | a dead source reads as a quiet one | Nobody | S2 |
| **R-46** | An outbox event with zero subscribers is recorded `sent`. Combined with R-03, `events_outbox` accumulates rows reading `status: 'sent'` that nothing attempted. | delivery looks complete | Nobody | S2 |
| **R-47** | Outbox retries cap at 5 with no backoff and no dead-letter surface. `/api/v1/outbox` has no status rollup and no UI reads it. | permanent failures invisible | Nobody | S2 |
| **R-48** | Schema drift is unobservable. `schemaStatus()` computes exactly `{current, expected, pending}` and has zero callers. A v1 database under a v3 build surfaces only as a 500 on every request. **Fixed 2026-10-13:** `/ready` reports `schema` (`{supported, current, expected, pending, current_build_is_ahead}`); a non-empty `pending` is `ready: false` (missing columns this build writes to, so every touching request 500s), while a database *ahead* of the build is reported and served — the module's own stated refusal to push an operator into a manual downgrade. The JSON store answers `supported: false`, which is not drift. | undiagnosed outage | `src/routes/liveness.js:269`; `src/store.js:608`; `src/postgres-store.js:363`; `test/liveness-route-module.test.js` | S3 |
| **R-49** | `ENOSPC` on a store write leaves a `.tmp` file of the store's full size on disk, doubling disk use at exactly the moment disk is exhausted. Nothing checks free space; `/health` does not report it. **Temp-file half fixed 2026-10-13:** `JsonStore.#writeFile` unlinks the temp file on any failure, not only a successful rename, so a write that fails at `ENOSPC` no longer leaves a full-size orphan behind. **Free-space half fixed 2026-10-13:** `store.storageUsage()` reports `{store_bytes, free_bytes, total_bytes, used_ratio}` and `/ready` fails closed on the predicate the write path actually obeys — `free_bytes < store_bytes`, since the rewrite needs a second copy of the store to land. A Postgres client reports the database size and `free_bytes: null` with the reason (it cannot see the server's filesystem), which is unknown, not broken. | cascading 500s | `src/store.js:636`; `test/store-write-cleanup.test.js` | S2 |
| **R-50** | The calibration snapshot write swallows every error. A disk-full or permission failure produces a stale `latest.json` forever with no log line, no counter, no field. **Fixed 2026-10-13:** the refresh still does not fail — that decision stands — but the failure is counted (`calibration_snapshot_write_failed_total{code}`) and logged at `warn` with the directory and the errno. `LINDELA_LITE_CALIBRATION_DIR=off` is a deliberate refusal and is not counted. | calibration silently frozen | `src/analytics.js:509`; `test/calibration-snapshot-failure.test.js` | S3 |
| **R-51** | Audit-chain verification is on-demand only. A tampered or truncated `action_logs` is detected when someone requests the proof, or never. | tamper-evidence is not evidence | Nobody | S2 |
| **R-52** | `watermark_state` has no route at all. A backfill that died three weeks ago is fully recoverable from the store and completely invisible. | recoverable state invisible | Nobody | S3 |
| **R-53** | Schedule slip is unreported. `computeNextRunIngestionRunAt` anchors on completion time, so a persistently slow provider pushes the schedule out forever while the system reports `ok`. | monitoring degrades silently | Nobody | S3 |
| **R-54** | `/api/v1/health` asserts exactly one thing and then returns the literal string `ok`. It does not assert ingestion is running, schedules honoured, alerts evaluated, SMS delivering, schema current, or disk available. **Fixed:** the literal `ok` is gone. `/health` reports `pipeline` — `healthy`, `last_success_age_seconds`, `interval_seconds`, `last_failure` (the label of the first failed item), `never_started` and `process_uptime_seconds` — from the `system_heartbeat` row the periodic tick writes, whose `items` carry per-item `ok`/`ms`/`error` for all seven `DRIVER_ITEMS` (ingestion schedules, alert evaluation, outbox dispatch, report schedules, trigger protocol execution, retention, delivery reconciliation — the last of which is where a failed SMS delivery surfaces). The other three the row names are on `/ready`, which is where "can this instance serve a request" belongs: `schema` (current vs expected, pending), `storage` (store bytes, free bytes, used ratio), and `audit`/`outbox` rollups. Three states, not two: `starting` for a process inside its two-interval grace, `never_started` for one that has served longer than that without a heartbeat. | liveness ≠ readiness | `src/routes/liveness.js:84`; `src/server.js:143`; `src/server.js:358` | S2 | <!-- line-drift-ok: quoted as it was; R-54 is fixed and the extraction moved the heartbeat builder and the summariser -->
| **R-55** | `logger` exposes only `info\|warn\|error` while `LOG_LEVELS` declares `debug`, so `LINDELA_LITE_LOG_LEVEL=debug` buys nothing; and every request is logged at `info`. | 6 call sites; a firehose on a district link | — | S3 |

---

## F. Client

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-56** | `hidden` is defeated by an author `display` rule on the console's highest-visibility chrome. `.offline-banner { display: flex }` outranks the UA `[hidden]` rule, so the amber "Offline" bar renders on **every load, online or not**, at `z-index: 1000` above the navbar. Measured: `hidden` present, `display: flex`. | `public/styles.css:149`; `public/app.js:1272-1275` — screenshot confirmed | S2 |
| **R-57** | The same class on the four inactive tab panels: `.rail-panel { display: flex }` beats `hidden`, so 58 keyboard-focusable controls sit in invisible panels at identical coordinates with `opacity: 0` — invisible focus ring too. 99 visible controls at boot, 58 in dead panels. | `public/styles.css:713-729`; `public/index.html:466,500,527,575` — measured per panel | S2 |
| **R-58** | Offline "it will wait on this phone until there is one" is a promise nothing keeps. Queueing is gated on `navigator.onLine === false` only, which is a link-layer flag: a captive portal, a satellite uplink that answers TCP but not HTTP, or a blackholed DNS all report `onLine === true`. `apiFetch` throws, nothing is written to IndexedDB, and the worker is told it will send. | `public/chw/app.js:626-636`, `:382-393`, `:146`, `:737`, `:860`; `public/shared/runtime.js:264` | S1 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-59** | Two independent queue drains, no claim, no idempotency key. `flush()` (online, 30 s tick, load) and `replayQueue()` (Background Sync, `flushQueue` message) both `getAll()` and `delete` independently. Latent only because of R-01; **fixing R-01 activates it.** | `public/shared/runtime.js:149-186`; `public/sw.js:626`; `grep idempot public/` → 0 | S2 |
| **R-60** | **Closed 2026-10-13.** Dead-letter, discard, retry, per-record error and a queue list all exist — `MAX_QUEUE_ATTEMPTS = 8` and a 4xx mark a record `failed`, `claimBatch` skips it, `pendingCount()` excludes it, and `runtime.js` exposes `list({failed:true})` / `retry(id)` / `discard(id)`. The list and both actions had **zero callers** in `public/` until 570c772 wired them into `refreshQueueStatus()`, which had asked only `pendingCount()` and so rendered a phone holding refused reports exactly like an empty one. **The last claim — no cap on the record count — is closed by `MAX_QUEUE_RECORDS = 500` and `enqueueRecord`:** `MAX_QUEUE_ATTEMPTS` bounded attempts per record and nothing bounded the records, so a phone out of signal for a season accumulated every report filed on it and the failure arrived as a quota refusal *after* the worker was told the report was saved. The refusal is now a number that is known, returned as `{queued:false, reason:'full'}` rather than thrown, and the CHW surface renders it (`chw.queue_full`, translated in en/so/sw) instead of reporting "the queue did not confirm" — which sent the worker looking for a fault in an app working as designed. Failed records count toward the cap, because they are the ones that never leave and the Remove button on a held row is how room is made. The count fails *open* when the store cannot be read: bytes cost less than a report the worker was told was safe. | `public/shared/queue-core.js` (`MAX_QUEUE_RECORDS`, `enqueueRecord`); `public/shared/runtime.js` (`enqueue`); `public/chw/app.js` (`queueReport`); `test/queue-capacity.test.js` — canaried three ways, each call site reverted separately | S2 |
| **R-61** | `i18nText`'s English fallback is overwritten five lines later. `navbar.js:412-414` sets the correct text and then adds `data-i18n`, so the next sweep overwrites it with `catalog[key] \|\| key` — the key. Measured in a Somali session: 48/56 on `/portal/`, 17/78 on `/chw/`, 16/23 on `/focal-point/` render raw keys. | `public/shared/navbar.js:376-378`, `:412-414`, `:486-487`; `public/shared/runtime.js:287`, `:337-340` | S2 |
| **R-62** | `initI18n` does not load English as the base layer at boot — only in `set()`, which runs only on a locale change. Coverage is 49% (sw), 23% (so), 12% (ar/din/km/nk). `check-i18n-offers.mjs:20` justifies the design with "English is the base layer", which is false at boot. | `public/shared/runtime.js:272-282`, `:316`; `scripts/check-i18n-offers.mjs:20` | S2 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-63** | `lang` and `dir` are wrong at boot on every non-console surface. `applyLocaleToDocument` is called only from the console and from `set()`. Arabic is offered on `/chw/`, `/co/`, `/portal/`, `/districts/` and renders as `lang="en" dir="ltr"`. | `public/shared/fmt.js:318`; `public/app.js:176,187`; `public/shared/runtime.js:313` | S2 |
| **R-64** | The console's alert rail asserts "No alerts. All rules quiet." while the same screen says nothing has been checked. `state.failedSources` is populated every refresh and exactly one renderer reads it; the rail branches on row count. `shared/states.js` exists for this and is adopted by 3 of 8 surfaces — the console is the one that did not. | `public/app.js:2679`, `:3039`, `:3624-3630` — screenshot confirmed | S2 |
| **R-65** | The precache graph cannot see any `lazy()` target. `shellGraph`'s import pattern matches `import('…')`, not `import(/** … */ path)`, so 28 of 73 public files are not precached — including `workflow/panel.js`, which **is** ENH-22's offline drill-down. The Node oracle test scans `from "…"` literals only, so it agrees with the broken traversal. | `public/sw.js:224-230`; `test/web-chw-offline.test.js:474-511` — measured, 45 of 73 | S2 |
| **R-66** | `CACHE_NAME = 'lindela-lite-v4'` is a hand-maintained literal nothing validates against `package.json`'s version. A deploy that changes `app.js` without editing `sw.js` leaves the old worker installed with no re-precache trigger, and a mixed module set loads silently when exports match. **Fixed 2026-10-13:** the name is now `` `lindela-lite-v__CACHE_VERSION__` `` and `preparedStatic` fills it from `APP_VERSION` on the way out (`fillCacheVersionMarker`, the same injection every HTML surface already gets for the same class of drift). The bump is a consequence of the release rather than a step in it, so it cannot be forgotten. The placeholder is deliberately not a valid cache name, so a server that fails to fill it opens an obviously wrong cache rather than a plausible stale one. | a deploy ships a fix nobody receives | `public/sw.js:17`; `src/server.js:1324` (`fillCacheVersionMarker`); `src/server.js:1401` (the `preparedStatic` injection); `test/sw-cache-version.test.js`; `test/lite.test.js:2223` | S2 |
| **R-67** | Raw `fetch` survives where `apiFetch` existed to remove it — 7 call sites across `app.js` and `co/app.js`, without `res.ok` checks or timeouts. A service-worker offline-miss body parses fine as data, so a disconnected console blanks a metric with no error. | `public/app.js:3133-3137`; `public/co/app.js:661-665`; the rule stated at `public/shared/runtime.js:196-202` | S2 |
| **R-68** | `state.selectedRecordId` is never declared in the `state` literal but is written and read, riding on the deep-link `selected=` param — a state key the object does not document, dropped by any `Object.keys(state)`-driven reset. | `public/app.js:43-89`, `:3329`, `:3399` | S3 |
| **R-69** | Hardcoded light-theme colours on two surfaces duplicate a tokenised rule and do not flip: a dark-theme field device gets `#fef3c7` on `#0b0d12` from focal-point and portal. CHW does it correctly with `var(--warn-wash)`. | `public/portal/index.html:224-225`; `public/focal-point/index.html:348-349` vs `public/styles.css:139` | S3 |
| **R-70** | **Re-measured 2026-10-15 — the row's figures are wrong in every direction, and its conclusion does not follow.** Measured against the current tree: **60,298 bytes of inline `<style>` across 8 surfaces** (not 7 — `panels/settings.html` was missed), of which **16,535 bytes are comments**, so live CSS is **43,763**. `districts/index.html` is **69% inline** (9,022 live of 13,020 raw), not 82%. The four "redefined" components are mostly not redefined: `.kpi-tile` was **already promoted** into `components.css` and the inline blocks hold tombstone comments saying so (`public/co/index.html:113-121`, `public/districts/index.html:332`), `.offline-banner` likewise at `public/portal/index.html`. Of **332 inline rules**, exactly **4** are strictly redundant with a shared rule of the same selector and value (`.retry-btn:hover` in chw, `.back-link:hover` and `.table-wrap` in districts, `.dialog-close:hover` in focal-point). The rest are surface-specific overrides that the shared sheet does not carry — chw's `.toast` is a full-bleed bottom bar where the shared one is a 26rem centred card, and chw's `.offline-banner` uses `--warn-wash` where the shared one is a fixed top bar using `--warn`. Deleting them in favour of the shared rules would change the rendered surface. **The remaining work is the 4 redundant rules and the dead `.table-wrap` override, not a 60 KB dedup** — the audit read a byte count that includes documentation as duplication, and the file that documents why a rule was promoted reads to a grep as the rule still being there. | measured 2026-10-15: inline `<style>` per surface, live vs comment split, and a same-selector/same-value diff against `components.css` + `styles.css` + `tokens.css` | S3 |
| **R-71** | **Re-measured and fixed 2026-10-15.** The row named four duplicates; three claims were stale or wrong and the real defect was larger. (1) **`pagedList` has no counterpart to duplicate**: `public/shared/paging.js` exports `pageWindow`/`setPage`/`resetPages`/`fetchAllPages`, a page-*state* module with a different contract, and `pagedList` is a collapsible-list *renderer* used only by districts (7 call sites). Nothing else renders one. (2) **`currentView` and `updateShareControl` are genuinely duplicated** — `public/app.js:4920` and `public/app.js:4949` against `public/districts/app.js:355` and `public/districts/app.js:416` — but they are not the same function: the console's reads eight DOM controls and its `updateShareControl` gates on `isCustom`, districts' reads two filter fields and gates on `isDistrictsViewCustom`. They are two surfaces' views over two different view modules (`shared/view-state.js` vs `shared/districts-view.js`), which is the split the shared modules were built for. Left as they are. (3) **`shared/navbar.js` is imported by 7 surfaces, not 3** (`public/index.html`, `portal`, `co`, `districts`, `focal-point`, `scenarios`, `parametric`), and all 8 render one; the eighth, `chw`, has its own field-device chrome deliberately. (4) **The `t()` count was worse than the row said: five private resolvers, not four, in three different shapes** — the console (`t(key, vars)`), `districts` (`t(key, fallback)` reading `window.__i18n.catalog`), `co` (`t(key, fallback)` reading a local `i18n` object), `scenarios` (same, exported), `parametric` (`t(key, fallback)` via a private `lookup`). Three surfaces (`chw`, `focal-point`, `portal`) imported the shared `t` and the five did not, so the same key resolved through two code paths that disagreed on fallback semantics: the shared one returned the key, the private ones returned the fallback. **All five are gone; all eight surfaces now import the shared `t` and `initI18n`, and none owns a resolver** (measured: 5 at HEAD, 0 now). The shared `t` takes a fallback *or* an interpolation map, told apart by type, so the 185 two-argument call sites needed no rewrite — 183 pass a fallback byte-identical to `public/i18n/en.json`'s English, so the second argument is dead weight the shared function now absorbs; the 2 that differ are `co.equity_breach` and `co.spark_single`, both because the private resolver could not interpolate. `co`'s private copy of the *loader* is gone too (it re-implemented `set()` without re-reading English as the base, which is R-62 on that surface). The console's copy was the worst shape: `t(key, vars)` dropped the fallback at `public/app.js:4365` (`statusbar.lag_unmeasurable`), and its loader never set `window.__i18n`, so `navbar.js`'s `i18nText` read an empty catalogue and the bar rendered English in every language. The shared sweep gained `data-i18n-placeholder`, which only the console uses. `public/app.js` shrank **220 gzipped bytes**; the shared runtime grew **259**, and the first-load total is **229.7 KB** under the unchanged 230 KB ceiling. | `public/shared/runtime.js`; `public/app.js:4365`; `public/districts/app.js:355`; `public/districts/app.js:416`; `public/co/app.js`; `public/scenarios/app.js`; `public/parametric/app.js`; `public/shared/paging.js`; `public/shared/navbar.js`; `test/web-locale-boot.test.js` | S3 |
| **R-72** | 45 of 452 `en.json` keys are never referenced by any `data-i18n` or `t()` literal — dead strings the coverage gate still gates on. **Fixed 2026-10-15:** re-measured against the current tree at **21 unreferenced of 540** (the catalogue grew from 452; the count moved with it). One of the 21 was not dead but *unwired* — `action.distribute` rendered raw English at `public/panels/reports.js:60` while ten locales held its translation — and is now wired through `data-i18n`. The other 20 are deleted from all ten catalogues (122 entries). `scripts/check-i18n.mjs` gained **rule 4**, which reads every `public/`, `src/` and `scripts/` source for a key's literal spelling with a word boundary, and honours template-built keys by deriving the prefix set from the source and keeping only prefixes that name a namespace the catalogue has (so `token_${n}` in `src/auth.js` excuses nothing). A prefix covering more than a quarter of the catalogue is *reported* rather than trusted. The rule names three honoured prefixes — `map.field_`, `workflow.`, `playbook.status.` — and 13 keys reachable only through them. Guard: `test/i18n-reachability.test.js` (10 tests, drives `--self-test`, canaried both directions). The `sw` coverage floor fell 281 → 269 because it counted 12 of the dead keys; sw's coverage of *live* strings is 269 before and after, so the ratchet is intact. | `scripts/check-i18n.mjs`; `test/i18n-reachability.test.js`; `public/panels/reports.js:60` | S3 |

---

## G. Maintainability and testability

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-73** | 19 of 39 `public/*.js` modules cannot be imported by Node — 12,053 of 17,988 front-end lines (67%). The suite's response was source surgery: `test/chw-wizard-honesty.test.js` stripped every `import ` line and `vm.runInContext`ed the remainder, with a hand-appended probe naming eight private locals. **CLOSED 2026-10-16 by `53e5298`** — the last two sandboxes are gone and every one of the **63** front-end modules imports through `test/browser-env.mjs`. (The figures above are the audited tree; the count is 63 now, and 26,973 lines, because the tree grew.) | `test/web-module-importability.test.js` — imports every module, and fails on either surgery spelling | S2 |
| **R-74** | The mitigation was duplicated **7×** — 2,957 lines of the 32,682-line suite. `registerHooks` solves it in ~8 lines and is already written at `test/web-console.test.js:69`. All seven copies were written against Node 20 and will break on the host's Node 26, where `navigator` is getter-only. **CLOSED 2026-10-16 by `53e5298`** — one harness, `test/browser-env.mjs`, and the two spellings a copy can take (`node:vm`, import-stripping) are both gate-failing. (Re-measured 2026-10-17: the suite is **87,358 lines** across 321 files, and `registerHooks` is named in **3** files — the harness, `test/falsy-zero.test.js:17` and the gate. `test/web-console.test.js:69` holds `installModuleResolution()` now; the line moved with the extraction.) | `registerHooks` grep → 3 files; the gate canaried both ways | S3 |
| **R-75** | `handleApiRequest` is a 1,122-line function holding 83 `jsonResponse` calls, 54 method gates and 56 path literals. **CLOSED 2026-10-13 by the ENH-60 table move** — and every figure is false in the direction the defect asked for. `handleApiRequest` is **9 lines** (`src/server.js:990-998`): resolve the identity once, delegate, return — **0** `jsonResponse` calls. The body it named is `handleApiRequestInContext`, **88 lines** (`:1000-1087`, 1 `jsonResponse`) iterating `src/route-families.js`'s 35-entry table, above `handleApi` at 107 lines. The **350** `jsonResponse` call sites and **97** method gates are spread across the **36 route modules** in `src/routes/`, which is the seam the row asked for. The citation rotted with the file: `src/server.js:424` is a scheduler `setInterval` now — it named a line, not a symbol, and the symbol moved. (Re-measured 2026-10-17; the row carried 9 lines at `:963-971`, 80 at `:973-1052`, a 33-entry table and 34 modules, all of which were right on 2026-10-13 and none of which anything re-checked.) | `src/server.js:990`; `src/route-families.js` — 88 lines of table iteration, zero route logic | S3 |
| **R-76** | **CLOSED 2026-10-12 — both tiers.** 7 of 17 gates never ran in CI, including every accessibility and layout invariant this project wrote 842 + 432 + 214 + 207 lines to express. The self-contained tier was closed first (`5cadf7c`); the browser seven were `workflow_dispatch`-only until the `browser` job took the whole `needs-browser` tier, which required `axe-core` to become a declared devDependency and `audit-a11y` to stop writing into tracked files. See the closed table below. | `.github/workflows/ci.yml` (`npm run gates`, `--tier needs-browser`); `scripts/validate.mjs:255-264` imports only four | S2 |
| **R-77** | **Fixed 2026-10-15 — and the row's count was wrong.** It named three cycles; the tree had **five**. It missed `analytics ↔ reconciliation` entirely, and could not have named `needle ↔ nl-query`, which is reachable only through a dynamic `import()` and is invisible to a graph built from `from '…'` alone. A hand list is the wrong instrument when the enumeration is the thing that is wrong, so the fix is the class: `scripts/check-import-cycles.mjs` builds the graph from all four import spellings after stripping comments, and the sixth cycle fails in CI rather than waiting to be found by reading. Each of the five was broken the same way, by moving the bindings the loop passed through into a leaf: `src/source-policies.js`, `src/envelope.js`, `src/derived-key.js`, `src/nl-vocabulary.js`. Eight canaries, driven by `test/import-cycles-gate.test.js`. Comments must be stripped before scanning — the first draft reported a self-loop on `src/freshness.js`, whose doc comment documents its own usage with an import. | `scripts/check-import-cycles.mjs`; `test/import-cycles-gate.test.js`; `test/leaf-modules.test.js` | S3 |
| **R-78** | **Fixed 2026-10-15 — and the row's own evidence was backwards.** It said `src/` → `public/` and `public/` → `src/` are both 0 edges. The second is 0 and is the invariant; the first is **17 edges across 13 files** (`src/analytics.js`, `src/routes/risk.js`, `src/forms.js`, …) importing `public/shared/units.js`, `flood-bands.js`, `rank-explain.js` — that direction is how the server and the browser run the *same* computation, so a gate asserting it would have failed on a clean tree and been switched off. The jurisdiction is one way: `scripts/check-boundary.mjs` requires nothing under `public/` to import `src/`, because `src/` is not served and the failure is a 404 in a surface that passed every test. Comments are stripped before scanning, so the file documenting the rule is not reported as breaking it. Nine canaries, driven by `test/boundary-gate.test.js`; canaried against a planted `public/app.js` import and watched to exit 1. | `scripts/check-boundary.mjs`; `test/boundary-gate.test.js`; the 17 legitimate edges at `src/analytics.js:7`, `src/districts.js:3`, `src/routes/risk.js:37` | S3 |
| **R-79** | **Fixed 2026-10-15.** Adding a connector touched six source-id-keyed lists in four files and only three of the seven edges had a guard — `SOURCE_ASSERTIONS` and `CADENCE_DAYS` were each checked against `SOURCE_IDS`, and `connectors.registry.json` against `CONNECTORS`, but `CONNECTORS`, `SOURCE_POLICIES`, `SOURCE_COLLECTIONS` and the registry's own edge to `SOURCE_IDS` were checked by nothing. Pairwise guards meant a list could agree with its neighbour and disagree with the root, which reads as coverage while the set drifts. `test/source-id-lists.test.js` compares all six against `SOURCE_IDS` in both directions, names the file to open on failure, and carries a `PARTIAL` map so a deliberately-short list declares itself and an expired exemption fails. Canaried by dropping `iot` from the registry: two cases fail naming `iot` and the file. | `test/source-id-lists.test.js`; lists at `src/schema.js:3`, `src/ingestion.js:46`, `:99`, `src/assertions.js:75`, `:108`, `src/freshness.js:140`, `connectors.registry.json` | S3 |

### Checked and good — stated so it is not re-audited

`src/` is at **97.2% direct module coverage** (69 of 71 modules; untested: `src/index.js`
at 8 lines and `src/lineage.js` at 20). Only 38 of 2,056 tests assert on source text —
**1.9%, far lower than the brief assumed**, and the largest remaining one fails closed.
Store conformance, migrations (against a real provisioned Postgres 16 cluster, 0
skipped), auth, ingestion failure and the offline queue are all genuinely covered.
`emptyStore()`'s duplication of `SCHEMA` is guarded from both sides by two tests.
Adding a *collection* costs 3–6 file edits and 0 migrations, with four guard tests that
fail closed if you forget. Do not spend effort here.

> **Re-measured 2026-10-17 — the first two figures are the audited tree's, and
> neither is a figure any instrument produces.** The 71 is real: `72a6b63` and
> `5bc71e8` both hold **71** `.js` modules under `src/`, `src/lineage.js` is
> **20** lines, and `src/index.js` is **8** lines still. Everything after it has
> moved. `src/` holds **167** modules; **166** are reached by a test and the one
> exception — `cors.js`, a middleware whose behaviour is response headers on a
> real request — is named in `check-module-coverage.mjs`'s allowlist. That gate
> is the instrument this paragraph never had: it reports
> `clean — 167 module(s) under src/, 321 test file(s) searched`, and it fails on
> an unreached module *and* on an allowlist entry a test now imports, because an
> exemption that outlives its reason is how an allowlist becomes a hiding place.
> `src/lineage.js` is gone — `da64321` (2026-10-11) deleted it, and the gate's own
> docstring names it as the module the hand count could not see.
>
> **The 2,056 does not reproduce and the 1.9% has no instrument.** At `5bc71e8`
> the tree held 89 test files and 2,043 `it(`/`test(` calls, and
> `STATUS-2026-10-05.md` records the suite as 2,323 — a third number. The suite
> is **4,922** tests now. For the source-text share I measured both readings a
> person might take: **31** of 4,876 tests have a body that reads a `src/` or
> `public/` file as text and asserts on it (0.6%), and **600** tests sit in a file
> that reads one at all (12.3%). The old figure is between them and matches
> neither, and nothing here is gated — so it is a number that will drift again.
> What *is* true and worth keeping is the direction: the rule is stated at
> `docs/improvements/_research/00-audit-baseline.md:67` and the largest remaining
> offenders fail closed. Read the percentage as a claim about 2026-10-05.
>
> The last two sentences still hold and I re-checked them rather than assuming:
> `test/store-schema-declaration.test.js` derives `COLLECTIONS` from `SCHEMA` and
> asserts `emptyStore()` agrees in **both** directions.
---

## H. Data veracity — where the refusal discipline leaks

This project refuses to claim more than it can compute. These are the places the code
does not honour that, each verified against this checkout.

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-83** | **`pct()` inflates every rate in [0,1] by 100×, and is non-monotone.** `Math.abs(n) <= 1 ? n * 100 : n` cannot tell a 0–1 fraction from a 0–100 percentage. Measured: `0.005 → 0.5%`, `0.5 → 50.0%`, **`1 → 100.0%`**, **`1.5 → 1.5%`**, `2 → 2.0%`. A higher true rate can render as a lower one. | `public/shared/fmt.js:51` — executed | S1 |
| **R-84** | **Three definitions of `false_alert_rate`, one name, disagreeing in direction on live data.** On Mandera — the one district with a confirmed false alert — `kpi.js` computes **50%**, `districts.js` computes **0%**, `equity.js` computes **0%**. The confirmed alert's note reads *"Reading traced to a faulty sensor"*, which matches none of the three keywords `/false\|invalid\|noop/i` the district and equity paths scan for. The district page therefore reports that alerting is **clean** for the only district where it was not. | `src/kpi.js:190`; `src/districts.js:151`, `:168`; `src/equity.js:104-105`; computed against the live store | S1 |
| **R-85** | The two wrong definitions have comments **arguing for them**. `src/districts.js:154-166` explains at length why the denominator "stays every alert the district raised" and why `reviewedAlerts.length` gates the result — while the numerator is scanned over alerts that gate excludes. Two different populations, adjacent in the source. | `src/districts.js:154-168` | S2 |
| **R-86** | The falsy-zero class is not retired: **eleven** independent instances of `Number(null) === 0`, `x \|\| 0`, `Number([]) === 0`, `?? 0` on a nullable, or `Number.isFinite(Number(null))` across `impact.js`, `ensemble.js`, `downscaling.js`, `parametric.js`, `flood-depth.js`, `road-access.js`, `kpi.js`, `districts.js`, `viz-uncertainty.js`. **Each has a nearby comment naming the exact hazard class and fixing it for `0` while leaving `null` broken.** | `src/analytics/impact.js:9-12`; `src/analytics/ensemble.js:1-39`, `:56`; `src/analytics/downscaling.js:42-49`; `src/parametric.js:176`; `src/flood-depth.js:512-513`; `src/road-access.js:186-211`, `:393`; `src/districts.js:135-147` | S1 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-87** | `computePopulationAtRisk` returns **0** for a null population, because `Number(null) === 0` takes the first branch and the `beneficiaries` fallback is dead code. Measured: **0 of 34 service assets carry `population_served` and 0 carry `beneficiaries`**; the result is 105 hazard rows every one reading `population_at_risk: 0`. "13 facilities affected, 0 people at risk" is a published claim that nobody is exposed, derived from a field no connector populates. | `src/analytics/impact.js:9-12` — measured on the live store | S1 |
| **R-88** | `downscaling.js` launders a null observation into a real 0 mm reading: `Number(o[field] \|\| 0)`. It also bails only at `length < 2`, so with **2 stations** an observation of 900 mm is published as 90 mm — a 10× reduction of the most extreme event in the record, from a two-value lookup table. And `bias_correction_source` is `stationGroup[0].source` regardless of which station the map returned, so rows are attributed to a station that contributed neither number. | `src/analytics/downscaling.js:42`, `:44`, `:49`, `:50` | S2 |
| **R-89** | `pearson`/`spearman` filter the two series **independently** and then zip by index. One one-sided non-finite value misaligns every subsequent pair: measured `pearson` → **−0.621** where the aligned survivors give **+1**. The correlation comes out **sign-inverted**. | `src/agreement.js:57-59` — executed | S2 |
| **R-90** | A **null** correlation is read as agreeing. `pearsonValue ?? 0` and `rankValue ?? 1` — both defaults point at the "agree" side, so a dead sensor is certified `agree` with a live one. And `paired_months` reports **key presence**, not measurement, so 3 of 6 months unmeasured publishes as `coverage: "both"`, `paired_months: 6`, verdict `agree`, from a correlation computed on 3 points. | `src/agreement.js:178-179`, `:292`, `:331` | S2 |
| **R-91** | `people_reached` counts **failed** dispatches — `status: "failed"`, `sent_at: null`, HTTP 503 — as people reached: **1,399 people**, with Bor overstated 25%. District attribution joins `alert.scope.district`, which disagrees with the dispatch's own `metadata.region` on 12 of 20 dispatches. Recipients are summed without de-duplication: 22,130 across 20 distinct phone numbers. | `src/districts.js:129-135` — measured on the live store | S2 |
| **R-92** | `Math.max(comparable, 1)` converts "no information" into a confident classification: a basin is labelled `"slope"` from zero comparable samples. Same shape at `road-access.js:186-211`, where a missing hazard coordinate yields `distanceKm = 0` and a `severity: "green"` advisory then closes a trunk road at a distance the module does not know, at `confidence: 90`. | `src/flood-depth.js:512-513`; `src/road-access.js:186-211` — 91 bbox-only hazards in the live store | S2 |
| **R-93** | Rates published from **n=1**: three in `districts.js` (`feeding_repositioning_rate`, `cold_chain_protection_rate`, and a "median" from `lags[floor(n/2)]` which is also the **wrong estimator** — `[1,2,3,4]` → 3, not 2.5, systematically +20% at even n), plus `agreement.js` and `ensemble.js`. `calibration.js` already does this correctly at `MIN_DETERMINED_ALERTS`; the pattern exists and was not propagated. | `src/districts.js:141-147`, `:178`; `src/kpi.js:69`; `src/analytics/ensemble.js:41-58` | S2 | <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
| **R-94** | District pages sum overlapping populations. Turkana and Karamoja centres are 122 km apart with 200 km radii, so **17 of 34 assets appear on both pages** and a reader summing them double-counts. `SYNONYMS` maps `moroto → karamoja` in `resolveDistrict` but is never consulted by `inDistrict`, so the Karamoja page reads `people_reached: 0` while 3,504 Moroto recipients exist. | `src/districts.js:29-30`, `:33-35` — measured | S2 |
| **R-95** | `operations.js:425` sums `population_at_risk` **across hazards**, so an asset within two hazards' range contributes twice — the clustered-events regime, which is the normal regime for flood events. | `src/operations.js:425` | S2 |

### Checked and correct

`flood-probability.js` enforces its refusal floor (ADR-005). `calibration.js` refuses
below `MIN_DETERMINED_ALERTS`. `alerts.js:60-70` documents and fixes the keyword-scan
problem — and is then reimplemented with the original defect in two other files.
`analytics/downscaling.js`'s stated limits are accurate as written; only its null
handling contradicts them.

### Not fixable with current data

**Recipient de-duplication.** 20 dispatches, 20 distinct phone numbers, no stable
household or person identifier in the payload. A union would be guesswork, and a guess
here inflates or deflates the funder's headline reach number. The honest resolution is
to say so on the surface, not to fake it.


---

## Status as of 2026-10-05

Recorded against the ids rather than in the rows, so the tables stay readable.
Every entry below is closed *with a test that fails without the fix* — the
commit for each is on `fix/storage-and-ingestion-correctness`.

### Closed in the final pass (2026-10-05)

| id | closed by | the guard that fails without it |
| --- | --- | --- |
| R-03 | `229c301` — report schedules moved into the driver, then the sidecar went | `test/periodic-driver.test.js` |
| R-04, ENH-06 | `ec19c41` — bounded retry; a reconciliation that raises one alert per undelivered chain, ever | `test/dispatch-delivery-reconciliation.test.js` |
| R-09 | `ad5d8f6`, then `a003381` — inbound budgets; assets and documents outside them, `/stac` and `/ogc` inside | `test/inbound-rate-limit.test.js` |
| R-10 | `cd91e74` — `Vary` on the credential, on the 304 too | `test/shared-device-cache.test.js` |
| R-11 | `6f6be48` — the five remaining ceilings, with the reasoning for the values | `test/rate-limit-coverage.test.js` |
| R-12 | `ad5d8f6` — community feedback's own window, applied by the driver | `test/retention-scheduled.test.js` |
| R-13 | `ad5d8f6` — catalogues gated and redacted | `test/stac-authz.test.js` |
| R-14 | `ad5d8f6` — non-root image, `/docs` behind auth | `test/container-hardening.test.js` |
| R-15 | `6f6be48` — shipped public paths match exactly | `test/store-concurrency.test.js` |
| R-18 | `6f6be48` — the temp file name is unique per write | `test/store-concurrency.test.js` |
| R-21 | `6f6be48` — one dispatch at a time, per store | `test/outbox-delivery.test.js` |
| R-22 | `6f6be48` — emit and its writes in one merge | `test/outbox-delivery.test.js` |
| R-25 | `6f6be48` — `replaceCollection` instead of a store-wide rewrite | `test/parametric-edit-scope.test.js` |
| R-52 | `12d916b` — `GET /api/v1/watermarks`, with cadence-aware staleness | `test/watermark-visibility.test.js` |
| R-53 | `6f6be48` — fixed-rate next run; the lateness is measured and reported | `test/schedule-slip.test.js` |
| R-65, ENH-41 | `55aaf01` — the precache closure reaches the lazy graph (45 → 74 paths) | `test/sw-bootstrap-assets.test.js` |
| R-62, R-63 | `f7502a8` — the locale layer boots through the same two-step as a switch | `test/web-locale-boot.test.js` |
| R-76 | `5cadf7c` — the self-contained tier runs in the `test` job. The audit found 7 of 17 gates unrun; the self-contained tier was **18** gates at that commit and **all 18 ran on every push** (24 today, 31 across both tiers), which is the number that matters because it is the whole tier and not a subset someone chose. `check-workflows.mjs` validated the edit, and the step was canaried by planting a dead `/api/v1/…` literal in `public/sw.js` and watching `npm run gates` exit 1 before reverting it. | `.github/workflows/ci.yml` (`npm run gates`), `scripts/run-gates.mjs --tier self-contained` |
| R-76 (browser tier) | **The seven gates that need Chrome now run on every push.** The row above closed the self-contained tier; the browser six were still `workflow_dispatch`-only, which is a gate that has never run. Three things blocked them, and each was a precondition rather than plumbing. (1) `axe-core` was imported by `audit-a11y.mjs` and declared in neither `package.json` nor `package-lock.json`, so `npm ci` in CI installed only `pg` — verified by simulating a CI checkout (`git archive HEAD \| tar -x` then `npm ci`), which left `node_modules/axe-core/axe.min.js` missing. It is a devDependency now. (2) `audit-a11y` wrote its two findings into **tracked** files, so the job would leave the checkout dirty; it writes to `$RUNNER_TEMP/lindela-a11y/` when that is set, and the job uploads that directory as an artifact instead. (3) The `dashboard` job ran one of the seven by name. It is `browser` now and runs `node scripts/run-gates.mjs --tier needs-browser`, so a gate added later joins by being *classified* rather than by someone remembering to name it here. **Canaried twice**: a planted failure in `check-a11y` made the tier report `FAIL` and the runner exit non-zero (and a planted failure in `check-i18n` confirmed the runner's `0/1 gates ok` / `failed: …` exit path on a fast gate); the tier was then run clean and serially to **7/7 gates ok**, ~8 minutes. | `.github/workflows/ci.yml` (`browser` job), `scripts/run-gates.mjs --tier needs-browser`, `scripts/audit-a11y.mjs` (`RUNNER_TEMP`) |
| **R-80** | **CI was red on every push, and the green step above was green underneath it.** `5cadf7c` wired the self-contained tier correctly — the failure was in the `test` and `coverage` jobs it runs beside, and had been there since before it. Three tests passed under Node 26 (the laptop) and failed under Node 22 (what CI pins): two awaited an `unref`'d timer that never fires once the loop drains, and one deleted its own temp fixture in a `finally` that raced the async `import()` reading it. A fourth defect was older still: `check-coverage.mjs`'s `parseTotals` matched the totals row as `ℹ all files` or bare, and Node 22 prefixes it `# `, so the gate reported "could not find the `all files` row" against a log containing it — on every run it had ever had, confirmed against three historical commits. Fixed in `21c7eb7` (the three tests) and `5ed1a01` (the coverage parser). **The lesson is the one this register keeps relearning: a gate's local pass says nothing about CI, because the run happens on a different Node.** Run `fnm exec --using 22 node --test` before believing a green suite, and read the *run history* rather than the job's YAML. | `fnm exec --using 22.23.0 node --test test/*.test.js` — 4,408/4,408 with 0 cancelled; `scripts/check-coverage.mjs` ok on both versions |
| R-12 (second half) | `2a82069` — the retention route and the retention driver read *different windows*. `apply-retention` refused on the general window while `applyScheduledRetention` used each collection's own, so a deployment setting only `communityFeedbackDays` got a 400 saying "Nothing was deleted" from a route whose scheduled twin was expiring `community_feedback` every tick. Found while extracting both into `src/routes/maintenance.js` (ENH-60). The route now applies per-collection windows and refuses only when none is set. | `test/maintenance-route-module.test.js` — runs both call sites against one policy and asserts they agree; canaried by restoring the pre-extraction body |
| R-33 | **The probe was the load generator.** `Dockerfile`'s `HEALTHCHECK` and the `app` healthcheck in `docker-compose.yml` both curled `/api/v1/health` every 30 s, and `/api/v1/health` reads the store to report `counts` — `collectionsForRequest` returns `null` for it, a whole-store read (38 of 65 collections; 97.8% of the bytes on the demo store, tens of MB on Postgres). Both probes now curl `/api/v1/ready`: one scoped read of `action_logs` + `events_outbox` behind a 2000 ms timeout, answering `503` rather than `500` when the store cannot be read. Narrowing `/health` was measured and rejected — `counts()` needs 38 of the 65 collections, so a manifest saves 2.2%. | `test/deployment-probe.test.js` — reads both deployment files, extracts every `/api/v1/…` path a `curl` asks for, and fails any that `collectionsForRequest` maps to a whole-store read; canaried by reverting each file's probe and watching it fail |

### Closed earlier on this branch, verified rather than re-done

R-01, R-02, R-06, R-07, R-08, R-16, R-17 (`mergeWatermarkForward`), R-19
(async-local fetch recording), R-20 (`next_attempt_at` consulted), R-23, R-24,
R-26, R-28, R-29, R-41, R-42, R-44, R-67.

**R-26's closure had no named evidence until 2026-10-16.** The row above still
reads as the audited defect, and the only thing asserting it was fixed was the
list you are reading. It is measured now: on 30,000 version rows the prune plans
as a `Bitmap Index Scan` on migration 4's `lite_records_version_record_idx` in
**0.17 ms**, against **3.1 ms and a Seq Scan** with that index dropped
(`scripts/probe-enh12-prune.mjs`) — the fix is the index the prune's own
predicate can reach, which is what `pruneVersions` now scopes by. The same probe
refutes the rest of ENH-12's proposal: a real `record_id` column with its own
index and a predicate that names it comes in at **0.99×** of the expression index
(0.6×–1.1× over runs).

**R-08, re-opened and closed for real, 2026-10-13.** The row above lists ~20 GET
routes readable by the narrowest scope, and it was closed when the *fallback*
changed — `scopeForRoute` now returns `DENIED_SCOPE` for an unmapped read instead
of `read:hazards`. That closed the leak and left the second half of ENH-15 undone:
"classify the ~20 current routes into `READ_SCOPES`". Nothing classified them, so
every route the fallback had been serving started returning **403** instead. The
coverage test could not see it because it enumerated *mutating* routes only — the
same shape as R-07, one layer over: the check existed and its jurisdiction was
half the surface.

Found by probing a running server rather than reading the table, which is the
only way this class shows up: a `read:hazards` token got **403 on
`/api/v1/weather`** and on every `/api/v1/basemap/tiles/*` the console's map
fetches on each pan. Ten console routes 403'd to a token carrying every read
scope; all ten answer now, re-probed against the same server. Twenty-one rows
were added to `READ_SCOPES`, classified by what each route serves rather than by
prefix shape — a route with a write row takes the read that mirrors it, so one
audience does not need two grants for one surface. The guard is
`test/route-scope-coverage.test.js`'s "maps every documented read that the gate
checks": it enumerates documented GET routes, excludes the four prefixes
`src/server.js` answers in front of the gate, and proves each exclusion really is
above the gate by its *last* mention in the file — a prefix answered above and
again below would otherwise pass while the second copy served an unchecked read.
Canaried twice: removing the `/api/v1/weather` row fails it with that path named,
and planting a second `/api/v1/metrics` mention below the gate fails the ordering
assertion at the line numbers.

### Closed but never marked — found 2026-10-13

The row tables above carry the audit's own text and were never updated as the
fixes landed, so a row with no closure marker is not evidence the defect is open.
Sixteen were re-checked against the tree on 2026-10-13 and each has both an
implementation that names the id and a test that fails without it. They are
recorded here rather than by editing the audit's rows, because the row is a
statement about the tree *as audited* and rewriting it would destroy the only
record of what was found. WEB-04 was the same shape one layer down: the fix had
shipped and only the index had not caught up.

| id | what it was | the guard that fails without it |
| --- | --- | --- |
| R-05 | A run's records lived in RAM until every source finished; now committed per source inside the loop, with a skip written as a run | `src/ingestion.js:496`; `test/ingestion-silence.test.js` |
| R-32 | `upsertCollection` shipped every `payload_hash` in a collection to Node to build a Set; it now asks only about the batch's hashes | `src/postgres-store.js:936`; `test/store-cost.test.js` |
| R-35 | The two adapters returned different orders; `sortRecords` is applied at read time on both | `src/store.js:752`; `test/store-cost.test.js` |
| R-36 | `CAPTURE_COLLECTION` was outside `SCHEMA`, so `assertDeclaredCollections` threw on capture; `payload_captures` is declared | `src/store.js:232`; `test/store-cost.test.js` |
| R-37 | Metric label cardinality was unbounded; `MAX_METRIC_SERIES` evicts and counts the eviction | `src/observability.js:169`; `test/observability-bounds.test.js` |
| R-38 | `histogram()` retained every sample forever and re-walked the array per scrape; a bounded trailing window of 20, bucketed at observation time | `src/observability.js:284`; `test/observability-bounds.test.js` |
| R-39 | Label-less histograms rendered invalid Prometheus text (`''.slice(0,-1)`); the label string is built, not sliced | `src/observability.js:364`; `test/observability-bounds.test.js` |
| R-43 | The assertion report was computed and dropped; it is persisted | `src/ingestion.js:450`; `test/ingestion-silence.test.js` |
| R-45 | A connector returning 200 with an empty body was `quiet` forever; a consecutive-zero-run streak makes it `stale` | `src/freshness.js:74`; `test/freshness-verdicts.test.js` |
| R-47 | Outbox retries had no dead-letter surface; the rollup and `/api/v1/outbox` expose it | `src/outbox.js:507`; `test/outbox-route-module.test.js` |
| R-51 | Audit-chain verification was on-demand only; `/ready` reports `audit.valid` and fails closed, and `auditChainWarning` logs it once per broken head | `src/routes/liveness.js:220`; `test/liveness-route-module.test.js` |
| R-55 | `logger` had no `debug`, so `LINDELA_LITE_LOG_LEVEL=debug` changed nothing; the method exists | `src/observability.js:99`; `test/observability-bounds.test.js` |
| R-56 | `hidden` was defeated by an author `display` rule on the console chrome | `test/web-hidden-display.test.js` |
| R-64 | The alert rail asserted "all rules quiet" while the same screen said nothing had been evaluated | `test/web-alert-rail-honesty.test.js` |
| R-87 | `computePopulationAtRisk` returned 0 for a null population; it returns null | `src/analytics/metrics.js:113`; `test/numeric-veracity.test.js` |
| R-89 | `pearson`/`spearman` filtered the two series independently and zipped by index | `src/agreement.js:47`; `test/agreement-alignment.test.js` |
| R-90 | A null correlation was read as agreeing (`?? 0` / `?? 1`) | `src/agreement.js:393`; `test/agreement-alignment.test.js` |

### Closed but never marked — the second sweep, found 2026-10-16

The 2026-10-13 sweep re-checked sixteen and left **twenty with no status at all**:
R-46, R-49, R-57, R-58, R-59, R-61, R-68, R-69, R-73, R-74, R-83, R-84, R-85,
R-86, R-88, R-91, R-92, R-93, R-94, R-95. Each was verified against the tree on
2026-10-16, and **all twenty are closed**. Four of them had no guard that fails
without the fix, which the canaries below found rather than the reading — those
four now have one, written in this pass.

R-49 is closed with a residual, recorded here rather than left to read as
complete: its `/health` still does not report free space (`/ready` does, and is
the probe the deployments use).

R-73/R-74 had the same residual when this paragraph was written — the harness was
in place and every module imported, but two `vm.runInContext` sites remained
(`test/chw-wizard-honesty.test.js:318`, `test/web-chw-offline.test.js:307`)
against seven before it. **`53e5298`, later the same day, removed those two as
well.** Both files now import through `test/browser-env.mjs`, and the gate fails
on either surgery spelling rather than on `runInContext` alone — a predicate
matching only that call would let a copy that filters source by its `import `
lines straight through, which is the half that decides what the module can see.

| id | what it was | the guard that fails without it |
| --- | --- | --- |
| R-46 | A zero-subscriber event was recorded `sent`; it is left `pending` with `undeliverable: true` and `last_error` naming why | `test/outbox-route-module.test.js` (canaried: dropping the `undeliverable` counter fails it) |
| R-49 | The temp file is unlinked on any write failure, and `#freeSpace` probes with `fs.statfs` — `/ready` degrades on `free_bytes < store_bytes` | `test/liveness-route-module.test.js`, `test/store-write-cleanup.test.js` (canaried: forcing `diskFull` false fails it) |
| R-57 | `components.css` carries `[hidden] { display: none !important }`, so no author rule can beat it; the per-site `.rail-panel[hidden]` rules are belt-and-braces behind that | `test/web-hidden-display.test.js` — resolves the cascade per surface (canaried: the backstop's `!important` is what fails; removing the per-site rule alone does not) |
| R-58 | `submitOrQueue` attempts first and queues on failure; `onLine === false` only skips the attempt, and never decides whether to save | `test/offline-delivery.test.js` (canaried: removing the attempt fails it) |
| R-59 | One claim and lease in `queue-core.js`; both drains (`flush()`, the worker's) go through it, and the idempotency key closes the millisecond window the claim cannot | `test/queue-capacity.test.js` — **added this pass**, three cases; the claim had no test at all (canaried: `heldByOther = false` fails all three) |
| R-61 | The `data-i18n` attribute is gone from the nav link, so the sweep no longer overwrites the fallback with the raw key | `test/web-locale-boot.test.js` (canaried) |
| R-68 | `selectedRecordId` is declared in the `state` literal | `test/state-keys-gate.test.js` (canaried: renaming the key fails two) |
| R-69 | Both `.offline-banner` blocks are deleted; `--warn-wash` is the token | `test/web-component-layer.test.js` (canaried: planting `#fef3c7` fails it) |
| R-73 / R-74 | Every module under `public/` imports in Node through `test/browser-env.mjs`; the seven sandbox copies are one | `test/web-module-importability.test.js` (canaried: breaking the harness fails it) |
| R-83 | `pct()` takes an explicit `scale` and **throws** on anything else; no inference from magnitude | `test/fmt-pct-scale.test.js` (canaried: restoring `Math.abs(n) <= 1` fails three) |
| R-84 / R-85 | One `METRICS.false_alert_rate`, one `computeMetric` — "the only supported route"; the two wrong definitions and their arguing comments are gone | `test/metric-registry.test.js` (canaried: a local redefinition fails five) |
| R-86 | `numericOrNull` is the only sanctioned conversion, and it replaces `Number.isFinite(Number(x))` rather than living beside it | `test/numeric-veracity.test.js` (canaried) |
| R-88 | The mapper returns `null` — never a number — when unidentifiable, and `MIN_STATIONS_FOR_QUANTILE_MAP` is 3 | `test/downscaling-honesty.test.js` (canaried: the floor at 1 fails two) |
| R-91 | Failed, queued and pending dispatches are excluded and counted as `failed_excluded`; the head-count-as-destination defect is closed too | `test/numeric-veracity.test.js` — **added this pass**, three cases; nothing asserted the exclusion (canaried: dropping the `continue` fails three) |
| R-92 | `terrainLabelForSamples` returns `null` below `MIN_TERRAIN_COMPARABLES`; the bbox-only hazard reports `distanceKm: null` rather than 0 | `test/refusal-floors.test.js` (canaried: the floor at 0 fails two) |
| R-93 | `median()` averages the middle pair; the n=1 rates go through the registry's sample floors | `test/numeric-veracity.test.js`, `test/metric-registry.test.js` (canaried) |
| R-94 | The filter routes through `orgUnitFor`, so a synonym resolves — the third function with its own vocabulary is gone | `test/org-units.test.js` (canaried) |
| R-95 | `population_at_risk_union_total` / `_union_assets` publish the de-duplicated figure beside the per-hazard sum | `test/remaining-defects.test.js` — **added this pass**; the union keys were read by no test (canaried: nulling the union fails it). Reachability measured 2026-10-16: all three keys resolve through `resolveMetric`, so the union figures *are* rule-readable — see the note below for the dead path the same measurement found |

**R-95's union keys are published and read by nothing — measured, and it is not the finding.** The
metric is registered, the de-duplication is correct, and `counts()` computes both keys. The residual
was recorded on the claim that nothing reads them. The claim was checked rather than repeated, by
resolving each key through `resolveMetric` against a real `{ counts, operations, data_quality }`
context: `population_at_risk_total` → `1600`, `population_at_risk_union_total` → `800`,
`population_at_risk_union_assets` → `2`. All three resolve. The union keys *are* reachable — an alert
rule or trigger protocol set to `counts.population_at_risk_union_total` reads the de-duplicated
figure, and the metric registry advertises it. "Read by no route field or client surface" was true
and is not the same claim as "unreachable"; the residual had conflated the two.

Measuring the rest of the picker's vocabulary found the actual dead path. `counts.disease_observations`
has been an option in `public/panels/settings.html`'s `protoMetricList` since the form was written and
was absent from `counts()`, so an operator who picked it built a protocol that could never fire —
`undefined`, `term_unresolvable`, no diagnostic, byte-identical to a threshold that was not met. The
key is added. `test/evaluation-context.test.js` now reads the picker out of the shipped HTML and
resolves every option against a real context, so the class cannot return; canaried by removing the key
(fails, naming the path) and by restoring the short context shape (fails two).

The same measurement found the second half, one namespace out. `operations` existed in two of the four
evaluation contexts — `server.js` and `parametric.js` built `{ counts, operations, data_quality }`
while `protocols.js:liveContext` and `alerts.js:pointInTimeContext` built `{ counts, data_quality }`.
The alert-rule metric field ships `value="operations.counts.open_incidents"` as its **default**, so a
shadow run answered "would not fire" for a rule the scheduler fired. Both now call one
`buildEvaluationContext(data)` in `src/operations.js`, and the test asserts a shadow run and a live run
agree on the form's own default.

### Open, with the measurement or the blocker

This table carried two errors until 2026-10-15, both worth naming because they
are the failure mode a hand-kept register has:

1. **It said the open set was two items and it was four.** The paragraph that
   used to sit between the rows below read "R-27/ENH-09 and ENH-12 are the only
   items remaining genuinely open". **R-30 and R-31 were live at that moment**
   and appeared in neither this table nor any other — they were in the D.
   Scalability table with no status, which reads as "not yet triaged" rather
   than "found and outstanding". An open table that omits what is open is worse
   than no table, because it is the thing a reader trusts to know when to stop.
2. **A paragraph was spliced between two rows**, which breaks the table in any
   renderer that requires rows to be contiguous — the ENH-12 row below rendered
   as body text on the row above it.

The open set is now **empty of actionable items**. R-27 remains listed because
its own row records a residual, and the residual is *blocked* rather than open:
it names a precondition (a read that accepts a filter) which does not exist and
which the same row's own predicate census shows cannot be built from the current
filter set. An item whose mechanism does not exist is not work waiting to be
scheduled, and listing it beside R-30 — which carries the same blocker — is what
stops it being re-opened and re-rescoped a third time.

R-27 is smaller than its own row claims. The performance half is *not* open in
the shape the audit recorded —
`collectionPage` was re-measured on 2026-10-16 at 0.022 ms for a 50-row page
from `food_security_records` and 0.379 ms from `record_versions`, because
SCL-03 had already replaced the 18-filter chain the 8.2 ms figure measured
(reproduced at 7.04 ms against 0.38 ms for the shipped pass, same collection).
SQL keyset pagination is **blocked** rather than pending: three of the eighteen
predicates — district, bbox, and the nine-field date filter — cannot be
reproduced in a `WHERE`, which is R-30's finding one layer over. What the item
did surface was a **client** defect, now fixed and confirmed through the live
ingress rather than in the page function: both overlays asked for `limit=5000`,
the server maximum, and on a 5,650-row collection that silently dropped the
tail. Driven against the demo store, the old request returned 1,673 IPC
area/current rows where the walk returns **2,229** — 556 lost, 24.9%.

**ENH-12 left this table on 2026-10-16** — both halves closed, with the table
half refuted rather than shipped — and its row below carries the measurements. **R-30/R-31 closed 2026-10-15**, kept listed until that edit so
the change was visible rather than a silent disappearance. ENH-17 stays listed
for the reason its own row gives.

**And the shrinking of this table is itself the thing to check, not to celebrate.**
It has twice been wrong by *omission* — R-30 and R-31 were live while the
paragraph above them said the open set was two items. A register whose open list
gets shorter is only good news if each departure names its evidence, which is why
the closed rows stay in the table rather than being deleted from it.

**R-77, R-78 and R-79 all left this table on 2026-10-15, fixed**, and their rows
above carry the evidence.

**R-77 was wrong about the count, and that is the part worth keeping.** The
entry said three cycles; the tree had **five**. It was right about the analytics
pair (`src/analytics.js` ↔ `src/calibration.js` / `src/drift.js`, live on
deferred bindings, every use inside a function body) and right that
`ingestion ↔ freshness` was genuinely circular at the module level — but it
never named `analytics ↔ reconciliation`, and it could not have named
`needle ↔ nl-query`, which is reachable *only* through a dynamic `import()` and
is therefore invisible to any graph built from `from '…'` alone.

A hand list of cycles is the wrong instrument, because the enumeration is the
thing that was wrong. The fix is the class: `scripts/check-import-cycles.mjs`
builds the graph from all four import spellings after stripping comments, so the
sixth cycle fails in CI rather than waiting to be found by reading. Each of the
five was broken the same way — a leaf module holding the bindings the loop
passed through: `src/source-policies.js`, `src/envelope.js`,
`src/derived-key.js`, `src/nl-vocabulary.js`.

The paragraph this replaces deferred the change as touching "the ingestion
module that three other workstreams are editing". That was a guess about other
people's work, not a measurement, and it was the wrong call: the move is
mechanical, it has no behaviour, and it took one session. The lesson is the
one this register keeps relearning — a deferral resting on an assumption about
concurrency is not evidence, and the cost of checking was lower than the cost of
writing the deferral down.

| id | why it is still open |
| --- | --- |
| R-27 / ENH-09 | **The correctness half is closed** (2026-10-07); the performance half is **blocked, not open** — see the last paragraph. `/api/v1/food-security` and `/api/v1/disease-observations` returned `filterRecords(...)` directly, so against the demo store they answered with **500 of 4,517** and **500 of 1,707** records and no `total`, no `has_more` and no cursor — a truncated set indistinguishable from a complete one, the remaining records reachable only by raising `limit` by hand. Both now page properly, and both compute their roll-up from the whole matched set rather than from the page, which was the worse half: `summary` described whatever happened to fit. Guard: `test/r27-silent-truncation.test.js`, which fails both if the pagination envelope is dropped and if the roll-up goes back to the page.<br><br>**What is left is the performance half, and it is smaller than the audit recorded.** Re-measured **2026-10-16** against the **128.5 MB** demo store: `collectionPage` has **29 call sites**, every one of them in `src/routes/`, and `filterRecords` has **7** outside its own module — the ENH-60 extraction moved every route out of `server.js`, so the "26 call sites in `server.js`" this line carried from 2026-10-07 named a file that holds none of them. The substance is unchanged: the largest paginated collection is **`events_outbox` at 1,790 rows** (`src/routes/outbox.js`), not the 360 the earlier figure named, and a 50-row page costs **0.129 ms**; `protocol_executions` at 1,774 pages in **0.041 ms** and `food_security_records` at 5,650 in **0.026 ms**. `record_versions` — 34,058 rows and the collection the audit's 8.2 ms figure was measured against — is still named by **no** `collectionPage` call site, so that latency is one the product does not pay. Keyset pagination is therefore bounded by ~1 week rather than ~3 — but see the last paragraph: it is blocked, not merely small — and the trigger is unchanged in kind: a collection whose page cost matters against its own latency budget. `food_security_records` is the one heading there, at 5,650 and growing — and although `/api/v1/food-security` now pages through `matchedAndPage`, that is a route-level page over a fully materialised array, not a SQL keyset read, so the keyset work it would need is still a precondition rather than an optimisation.<br><br>**One part of this row's own subject moved to closed on 2026-10-16, and not in the direction it predicted.** The `record_versions` read that ENH-12 proposed to fix with a real `record_id` column is fixed by migration 4's existing expression index: see ENH-12 below. The collection is still unreachable from `collectionPage` — the fix was to the history route's read scope, not to pagination — so the performance half above stands as written.<br><br>**The performance half was measured at the wrong layer, and the layer it was measured at is already fixed.** `collectionPage` does its work in **0.022 ms** on `food_security_records` (5,650 rows) and **0.379 ms** on `record_versions` (34,058) — and the 8.2 ms the row above quotes is the 18-filter chain SCL-03 replaced, which reproduces at **7.04 ms** against **0.38 ms** for the shipped single pass on the same 34,058-row collection, ~19×. So there is nothing left to win in the page function. What the *request* pays is elsewhere: `/api/v1/food-security` reads **1 collection, 5,650 rows, 14.16 MB** to return a 50-row page — **99.12% of the transfer discarded** — and `/api/v1/disease-observations` reads 3.23 MB for the same shape. That is the store read, not the pagination, and `total` plus the roll-up are what make it structural: both need every matched row, so neither can be answered from a `LIMIT`ed page.<br><br>**Keyset pagination in SQL is blocked, and R-30 already records why.** Three of the eighteen `filterRecords` predicates cannot be reproduced in a `WHERE`: `recordInDistrict` matches case-insensitively, splits on `[,;/]`, falls back to haversine, and traverses `incident_id`/`intervention_id`/`alert_event_id` through `context.data` — the parent records a SQL predicate cannot reach; `recordInBbox` is the same geo problem; and the `from`/`to` filter tries nine timestamp fields in precedence order and *passes* a record whose dates do not parse. A `WHERE` built from any of them returns fewer rows than the filter it replaces. Same finding as R-30, one layer over: the read accepts no filter, so a predicate pushed into SQL would answer a different question.<br><br>**What was actually broken was the client, and it is fixed.** Both overlays asked for `?limit=5000` — the server maximum — and drew what came back. On the demo store `food_security_records` is **5,650** rows, so the request returned 5,000 with `has_more: true` and the tail was never requested: after the console's own `scope === 'area' && validity_period === 'current'` filter that cost **556 of 2,229** IPC areas, **25% of the overlay**, with the status line counting what it happened to hold. `loadRoadStatus` had reasoned its way to 5,000 to escape the default 500 and stopped one step short of the same edge. Both now walk `next_cursor` through `fetchAllPages` — the ENH-81 helper the alert rail already used — with `maxPages` bounding the walk and `truncated` making a short load say so. `fetchAllPages` gained the route's `summary` on its return, because a roll-up computed over the whole matched set is page-invariant and dropping it reads as "not published" rather than as "the walk lost it". Guard: `test/paging.test.js`, whose summary assertions fail if the walk drops the roll-up. |
| ENH-12 | **The read half is closed (2026-10-16) and the table half is refuted rather than deferred.** What was still open was not the prune but the *read*: `/api/v1/history/:collection/record` answers about one record and did so by reading the whole store. Both history routes resolve to a `null` manifest — they are in `WIDE_ROUTES` — so the read was every declared collection with history on, and `versionsFor`'s `v.record_id === recordId` filter then ran in JavaScript over all 34,058 version rows. Measured end to end against the 128.5 MB demo store (`scripts/probe-enh12-endtoend.mjs`): **50,111 rows and 447.29 ms** to answer about a record with **5** retained revisions, against **6 rows and 5.98 ms** scoped — **8,352×** fewer rows. The scope needs no schema change, which is what settles the table half: migration 4's `lite_records_version_record_idx` already carries `(body->>'record_id')`, and on 36,000 rows the scoped predicate plans as a **BitmapOr of the primary key and that index** against a **Seq Scan** for the unscoped read (`scripts/probe-enh12-scope.mjs`) — a difference in *plan shape*, which is deterministic, where the timings are not: the scoped plan runs in tens of microseconds and repeated medians put the ratio anywhere from **70× to 220×**, so the shape is the evidence and the ratio is indicative. The proposed real `record_id` column buys **1.4× median over 9 paired runs, with a 0.4×–2.9× spread** (`scripts/probe-enh12-read.mjs` — the probe that actually measures a column; the scope probe has no `ADD COLUMN` in it, and the register previously cited it for this figure anyway): both plans are index paths under 0.01 ms, so the ratio is mostly scheduler noise and the honest reading is *no measurable gain*. Either way the ~4-engine-week migration with a data migration for existing deployments is not the schema the auditability claim rests on — the expression index is. Two things the row's own proposal would have missed: the predicate has to be written as an `OR` over two branches, because the natural `CASE WHEN collection = 'record_versions' THEN body->>'record_id' ELSE id END` is a function of a column that **no index can serve** (it plans as a Seq Scan at roughly the unscoped ~4.3 ms); and the fix could not be a manifest, because a non-null manifest moves the route off `WIDE_QUERY_BUDGET` onto the 25,000-row default and `food_security_records` with its history is 29,325 rows — the manifest-shaped fix turns a working request into a 503. Guard: `test/history-record-scope.test.js`, whose both-adapters assertion fails on the ARC-10 divergence where one store honours the scope and the other ignores it. |
| R-30 / R-31 | **Closed 2026-10-15.** Ten STORED generated columns and ten indexes, added by migrations 3 and 5 so that the filters `filterRecords` implements in JavaScript would become index lookups. They never did: `PostgresStore.read` takes no filter, so no query named any of the ten. Dropped by migration 7. Listed here after closing rather than removed, because this table's whole failure was an item going missing from it. |
| ENH-17 | **Shipped, in the form this deployment model warrants** (2026-10-07). The generated column, the partial index, and the predicate in `PostgresStore.read()`'s `WHERE` clause. The audit's RLS half is withdrawn rather than blocked: it was specified as row-level security keyed on `current_setting('app.partner_org')`, which is a remedy for cross-*tenant* reads, and this deployment has one operator, one country programme and one database. `partner_org` separates organisations working the same response — where the records carry names and household counts, so the disclosure is real. Guard: `test/partner-sql-predicate.test.js`. |
