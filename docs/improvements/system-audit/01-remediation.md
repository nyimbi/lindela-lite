# Remediation catalog

92 defects requiring remediation. **Disjoint from the 50 enhancements** in
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
| **R-02** | Nothing raises an alert automatically. `evaluateAlertRules` is called only from `POST /api/v1/alerts/evaluate`; the scheduler calls neither that nor anything that calls it; `refreshAnalytics` does not evaluate. A threshold crossing produces a risk score and nothing else. | `src/server.js:1104-1105`, `:2349`; `docker-compose.yml:59-62`; `run-due` handler read in full | S1 |
| **R-03** | The scheduler discards every error it can produce. `\|\| true` makes a 401, a 500 and "nothing was due" indistinguishable, and nothing collects the loop's stdout. | `docker-compose.yml:59-62` | S1 |
| **R-04** | Alert → SMS is manual and unretried. A failed dispatch sets `status='failed'` and returns 502 to the caller; there is no retry, no timer, and nothing raises an alert about the failed dispatch. A focal point approves a trigger and no SMS reaches anyone. | `src/server.js:2235`; `src/rapidpro.js:58-61`, `:63-77` | S1 |
| **R-05** | A full ingestion run's records live only in RAM until every source finishes. `store.merge` at the end is the only persistence. `gdacs_archive` alone is ~166 requests / ~4.2 h worst case; a kill at hour 3.9 loses the run and the next run restarts from 1985, a hardcoded constant. | `src/ingestion.js:392`; `src/connectors/gdacs-archive.js:60-62`, `:74-76` | S1 |
| **R-06** | Partner isolation is not applied on three live routes. Scoping is an opt-in third argument to `filterRecords`; three handlers do not pass it, and the by-id branch does not scope at all. A partner token reads every organisation's field reports. | `src/server.js:2536`, `:2393`, `:1501`, `:2543`; `src/utils.js:130`, `:182` | S1 |

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
| **R-13** | `/stac/*` and `/ogc/*` sit entirely outside the auth gate, dispatching before `handleApiRequest`. `stacItem` spreads every field of the source record into `properties` with no redaction. No field reports reach it today; clinic, water-point and road locations do. | `src/server.js:104-107`, `:200`; `src/stac.js:171-173` | S2 |
| **R-14** | The container runs as root and `.dockerignore` misses `.omc`. `docs/` ships in the runtime image and is served **unauthenticated** at `/docs`. | `Dockerfile:1-24`; `.dockerignore:5`; `src/server.js:3301-3312` | S3 |
| **R-15** | `isPublicPath` prefix-matches, so `/api/v1/health/anything` is public — and executes a full-table `store.read()` first. An unauthenticated read amplifier. | `src/auth.js:153`; `src/server.js:486` | S3 |

### Checked and clean — stated so they are not re-audited

| Checked | Result |
|---|---|
| SQL injection | **None.** Every value parameterised, including batch inserts (`UNNEST`) and the `pruneVersions` window. No dynamic `ORDER BY`, `LIMIT` or identifier interpolation anywhere. `src/postgres-store.js:206-220`, `:302-317`, `:334-349` |
| Path traversal | **None.** `safeJoin` resolves then relativises and rejects `..`; `hasTraversalSegment` additionally rejects `..` on the decoded raw URL including double-encoding. `src/server.js:3314-3321`, `:3447` |
| SSRF | **None.** `webhooks.js:9-36` blocks RFC1918, loopback, link-local (so `169.254.169.254`), CGNAT, multicast and reserved, handles IPv4-in-IPv6, and resolves DNS **at dispatch time** not at registration, closing rebind. 5 s abort. `src/outbox.js:26`, `:69` |
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
| **R-22** | `emit()` precedes `merge()` in every caller, non-atomically. A failure of the second leaves an outbox event announcing a transition that never happened, and subscribers act on it. | `src/server.js:3215`, `:3248`, `:2360`; `src/outbox.js:19` | Yes | S3 |

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
| **R-25** | `store.write()` is a full-table `DELETE` + reinsert for a one-record edit. Four routes call it to add a single parametric rule. | `O(N + B)` per edit | `src/postgres-store.js:181`; `src/server.js:2807`, `:2834`, `:2853`, `:2931` | S2 |
| **R-26** | `pruneVersions()` window-scans the entire version table on every bitemporal merge, partitioned and ordered on two unindexed JSONB extractions. | `O(V)` = 31,549 rows / 85 MB per merge | `src/postgres-store.js:302-317` | S2 |
| **R-27** | Pagination is `findIndex` + `slice` over a fully materialised array, behind 18 chained `.filter()` passes, and `total` makes it structurally non-lazy. | `O(M)` for a page of L; **no `LIMIT`/`OFFSET` exists anywhere in `src/`** | 8.2 ms to produce a 50-row page from 31,549 rows; `src/utils.js:182-253` | S2 |
| **R-28** | The JSON store's write cache is invalidated by every write. `#writeFile` sets `#parsed = next` **and** `#parsedStamp = null`, so the next read re-stats and re-parses the whole file. The comment claims the opposite. | ~100× on read-after-write | warm 0.2 ms / cold-after-write 24.9 ms, measured; `src/store.js:298-299` vs `:233-237` | S2 |
| **R-29** | `JSON.stringify(next, null, 2)` — 112.6 ms vs 17.6 ms compact. Pretty-printing is 84% of merge cost and inflates the file ~40%. | 6.4× | measured at 37.8 MB; `src/store.js:292` | S2 |
| **R-30** | The two `region`/`observed_at` generated columns and their indexes are written and maintained on every INSERT and UPDATE, and **no query in the repository reads either**. | write amplification | `src/migrations.js:90-156`; `grep` in `postgres-store.js` → no readers | S3 |
| **R-31** | Six of the eight filters `filterRecords` actually implements have no index of any kind; `bbox` is a comparison on two JSONB-extracted numbers. | `O(N)` per filter | `src/utils.js:184-197` vs `src/migrations.js` | S3 |
| **R-32** | `upsertCollection` ships every `payload_hash` in a collection to Node to build a Set. | `O(C)` rows per merge | 4,517 rows for `food_security_records`; `src/postgres-store.js:320-325` | S3 |
| **R-33** | The health check is the load generator. `Dockerfile:23-24` and `docker-compose.yml:41` poll `/api/v1/health` every 30 s, and that request executes the full-table `read()`. Readiness exists and is unused by either. | full read every 30 s, forever | `src/server.js:486`, `:506-536`; `Dockerfile:23-24` | S2 |
| **R-34** | The KPI cache key is seven array lengths. A run that revises 99 field reports to 100 between two dashboard loads returns a 5-minute-stale figure for a quarter whose numbers changed. | correctness | `src/kpi.js:15-27` | S3 |
| **R-35** | Store ordering is not identical between the two adapters, contrary to the comment. JSON fixes order at write time; Postgres re-sorts on every read. A write path that appends without sorting leaves the two stores disagreeing, with no error. | correctness | `src/store.js:443` vs `src/postgres-store.js:161-163`; `src/server.js:2834` | S3 |
| **R-36** | `CAPTURE_COLLECTION = 'payload_captures'` is not in `SCHEMA`, so `assertDeclaredCollections` throws on it. The capture store cannot be persisted through either adapter, contrary to the comment. | correctness | `src/capture.js:33-35`, `:53` | S3 |

---

## E. Observability and silent failure

Full silent-failure inventory in the analyst's domain report; the load-bearing rows:

| id | Failure class | How it presents | Who finds out | Sev |
|---|---|---|---|---|
| **R-37** | Metric label cardinality is unbounded. `normalizeRoute` collapses only id-shaped segments, so any unmatched path becomes a permanent series. | `/metrics` grows without limit | Nobody | S2 |
| **R-38** | `histogram()` retains every sample forever (`entry.values.push`) and `render()` re-walks the whole array per scrape, although `buckets` is declared and never used for accumulation. | scrape cost `O(requests since boot)` | Nobody | S2 |
| **R-39** | Label-less histograms render invalid Prometheus text — `''.slice(0,-1)` leaves no opening brace. Both current histograms have labels, so this is latent. | series silently discarded | Nobody | S3 |
| **R-40** | No correlation ID exists anywhere. One focal point approval produces a workflow row, an outbox row and an `action_log` row in three non-atomic writes with no shared token. An operator cannot trace one action across the pipeline. | untraceable | Nobody | S2 |
| **R-41** | The circuit breaker can never trip. State is created per `runIngestion` call and each source is visited once, so `consecutive_failures` cannot reach a threshold of 3. `/ingest/status` reports a health score for a breaker that does not exist. | breaker never opens | Nobody | S2 |
| **R-42** | Every source's `min_count_vs_trailing` assertion is dead in production: `runSourceAssertions` is called without `trailingRecords`, so the baseline is `median([])` = null and it is always reported `unmeasured`. The assertion that would catch GDACS collapsing 40,000 → 4,000 never executes. Tests pass `trailingRecords` in 21 places; production in zero. | count drift invisible | Nobody | S2 |
| **R-43** | The assertion report is never persisted. `stats`, `unmeasured` and each failure's structured `detail` are discarded; only flattened `.message` strings survive. | diagnostics thrown away | Nobody | S3 |
| **R-44** | `freshnessReport` has no production caller. `ingestionStatus` recomputes the verdict ad hoc with no `recentRecordCounts` and no `now`, so the three-run window is dead code and `quiet`/`ok` always keys off a single run. | verdict less reliable than designed | Nobody | S3 |
| **R-45** | A connector returning 200 with an empty body is classified `quiet` — "nothing new, and nothing is due yet" — indistinguishable from a genuinely quiet feed. The conflation ENH-06 exists to eliminate, surviving on the exact case it names. | a dead source reads as a quiet one | Nobody | S2 |
| **R-46** | An outbox event with zero subscribers is recorded `sent`. Combined with R-03, `events_outbox` accumulates rows reading `status: 'sent'` that nothing attempted. | delivery looks complete | Nobody | S2 |
| **R-47** | Outbox retries cap at 5 with no backoff and no dead-letter surface. `/api/v1/outbox` has no status rollup and no UI reads it. | permanent failures invisible | Nobody | S2 |
| **R-48** | Schema drift is unobservable. `schemaStatus()` computes exactly `{current, expected, pending}` and has zero callers. A v1 database under a v3 build surfaces only as a 500 on every request. | undiagnosed outage | Whoever hits the first 500 | S3 |
| **R-49** | `ENOSPC` on a store write leaves a `.tmp` file of the store's full size on disk, doubling disk use at exactly the moment disk is exhausted. Nothing checks free space; `/health` does not report it. | cascading 500s | Nobody | S2 |
| **R-50** | The calibration snapshot write swallows every error. A disk-full or permission failure produces a stale `latest.json` forever with no log line, no counter, no field. | calibration silently frozen | Nobody | S3 |
| **R-51** | Audit-chain verification is on-demand only. A tampered or truncated `action_logs` is detected when someone requests the proof, or never. | tamper-evidence is not evidence | Nobody | S2 |
| **R-52** | `watermark_state` has no route at all. A backfill that died three weeks ago is fully recoverable from the store and completely invisible. | recoverable state invisible | Nobody | S3 |
| **R-53** | Schedule slip is unreported. `computeNextRunIngestionRunAt` anchors on completion time, so a persistently slow provider pushes the schedule out forever while the system reports `ok`. | monitoring degrades silently | Nobody | S3 |
| **R-54** | `/api/v1/health` asserts exactly one thing and then returns the literal string `ok`. It does not assert ingestion is running, schedules honoured, alerts evaluated, SMS delivering, schema current, or disk available. | liveness ≠ readiness | Nobody | S2 |
| **R-55** | `logger` exposes only `info\|warn\|error` while `LOG_LEVELS` declares `debug`, so `LINDELA_LITE_LOG_LEVEL=debug` buys nothing; and every request is logged at `info`. | 6 call sites; a firehose on a district link | — | S3 |

---

## F. Client

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-56** | `hidden` is defeated by an author `display` rule on the console's highest-visibility chrome. `.offline-banner { display: flex }` outranks the UA `[hidden]` rule, so the amber "Offline" bar renders on **every load, online or not**, at `z-index: 1000` above the navbar. Measured: `hidden` present, `display: flex`. | `public/styles.css:149`; `public/app.js:1272-1275` — screenshot confirmed | S2 |
| **R-57** | The same class on the four inactive tab panels: `.rail-panel { display: flex }` beats `hidden`, so 58 keyboard-focusable controls sit in invisible panels at identical coordinates with `opacity: 0` — invisible focus ring too. 99 visible controls at boot, 58 in dead panels. | `public/styles.css:713-729`; `public/index.html:466,500,527,575` — measured per panel | S2 |
| **R-58** | Offline "it will wait on this phone until there is one" is a promise nothing keeps. Queueing is gated on `navigator.onLine === false` only, which is a link-layer flag: a captive portal, a satellite uplink that answers TCP but not HTTP, or a blackholed DNS all report `onLine === true`. `apiFetch` throws, nothing is written to IndexedDB, and the worker is told it will send. | `public/chw/app.js:626-636`, `:382-393`, `:146`, `:737`, `:860`; `public/shared/runtime.js:264` | S1 |
| **R-59** | Two independent queue drains, no claim, no idempotency key. `flush()` (online, 30 s tick, load) and `replayQueue()` (Background Sync, `flushQueue` message) both `getAll()` and `delete` independently. Latent only because of R-01; **fixing R-01 activates it.** | `public/shared/runtime.js:149-186`; `public/sw.js:626`; `grep idempot public/` → 0 | S2 |
| **R-60** | No queue cap, no dead-letter, no discard, no per-record error, and no queue list anywhere. A record the server permanently rejects stays queued forever, retried every 30 s, never surfaced, and cannot be discarded — while `pendingCount` stays inflated and the banner keeps promising delivery. | `public/shared/runtime.js:70`, `:124`; `public/sw.js:636-643`; `public/chw/app.js:351` | S2 |
| **R-61** | `i18nText`'s English fallback is overwritten five lines later. `navbar.js:412-414` sets the correct text and then adds `data-i18n`, so the next sweep overwrites it with `catalog[key] \|\| key` — the key. Measured in a Somali session: 48/56 on `/portal/`, 17/78 on `/chw/`, 16/23 on `/focal-point/` render raw keys. | `public/shared/navbar.js:376-378`, `:412-414`, `:486-487`; `public/shared/runtime.js:287`, `:337-340` | S2 |
| **R-62** | `initI18n` does not load English as the base layer at boot — only in `set()`, which runs only on a locale change. Coverage is 49% (sw), 23% (so), 12% (ar/din/km/nk). `check-i18n-offers.mjs:20` justifies the design with "English is the base layer", which is false at boot. | `public/shared/runtime.js:272-282`, `:316`; `scripts/check-i18n-offers.mjs:20` | S2 |
| **R-63** | `lang` and `dir` are wrong at boot on every non-console surface. `applyLocaleToDocument` is called only from the console and from `set()`. Arabic is offered on `/chw/`, `/co/`, `/portal/`, `/districts/` and renders as `lang="en" dir="ltr"`. | `public/shared/fmt.js:318`; `public/app.js:176,187`; `public/shared/runtime.js:313` | S2 |
| **R-64** | The console's alert rail asserts "No alerts. All rules quiet." while the same screen says nothing has been checked. `state.failedSources` is populated every refresh and exactly one renderer reads it; the rail branches on row count. `shared/states.js` exists for this and is adopted by 3 of 8 surfaces — the console is the one that did not. | `public/app.js:2679`, `:3039`, `:3624-3630` — screenshot confirmed | S2 |
| **R-65** | The precache graph cannot see any `lazy()` target. `shellGraph`'s import pattern matches `import('…')`, not `import(/** … */ path)`, so 28 of 73 public files are not precached — including `workflow/panel.js`, which **is** ENH-22's offline drill-down. The Node oracle test scans `from "…"` literals only, so it agrees with the broken traversal. | `public/sw.js:224-230`; `test/web-chw-offline.test.js:474-511` — measured, 45 of 73 | S2 |
| **R-66** | `CACHE_NAME = 'lindela-lite-v4'` is a hand-maintained literal nothing validates against `package.json`'s version. A deploy that changes `app.js` without editing `sw.js` leaves the old worker installed with no re-precache trigger, and a mixed module set loads silently when exports match. | `public/sw.js:1-4`; `grep lindela-lite-v` → `sw.js` only | S2 |
| **R-67** | Raw `fetch` survives where `apiFetch` existed to remove it — 7 call sites across `app.js` and `co/app.js`, without `res.ok` checks or timeouts. A service-worker offline-miss body parses fine as data, so a disconnected console blanks a metric with no error. | `public/app.js:3133-3137`; `public/co/app.js:661-665`; the rule stated at `public/shared/runtime.js:196-202` | S2 |
| **R-68** | `state.selectedRecordId` is never declared in the `state` literal but is written and read, riding on the deep-link `selected=` param — a state key the object does not document, dropped by any `Object.keys(state)`-driven reset. | `public/app.js:43-89`, `:3329`, `:3399` | S3 |
| **R-69** | Hardcoded light-theme colours on two surfaces duplicate a tokenised rule and do not flip: a dark-theme field device gets `#fef3c7` on `#0b0d12` from focal-point and portal. CHW does it correctly with `var(--warn-wash)`. | `public/portal/index.html:224-225`; `public/focal-point/index.html:348-349` vs `public/styles.css:139` | S3 |
| **R-70** | 59,460 bytes of inline `<style>` across 7 surfaces, redefining the four highest-traffic shared components (`.offline-banner`, `.toast`, `.table-wrap`, `.kpi-tile`) that `components.css` already ships. `districts/index.html` is 82% inline CSS. | per-surface byte counts in the domain report | S3 |
| **R-71** | Four of eight surfaces ship a private copy of a module that already exists: `districts/app.js` has its own `pagedList`, `currentView`, `updateShareControl` and third `t()` resolver. `shared/navbar.js` is used by 3 surfaces; all 8 render one. | `public/districts/app.js:28`, `:197`, `:363-424` | S3 |
| **R-72** | 45 of 452 `en.json` keys are never referenced by any `data-i18n` or `t()` literal — dead strings the coverage gate still gates on. | computed against the full catalogue | S3 |

---

## G. Maintainability and testability

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-73** | 19 of 39 `public/*.js` modules cannot be imported by Node — 12,053 of 17,988 front-end lines (67%). The suite's response is source surgery: `test/chw-wizard-honesty.test.js:209` strips every `import ` line and `vm.runInContext`s the remainder, with a hand-appended probe naming eight private locals. | per-file import attempt, 19 failures | S2 |
| **R-74** | The mitigation is duplicated **7×** — 2,957 lines of the 32,682-line suite. `registerHooks` solves it in ~8 lines and is already written at `test/web-console.test.js:69`. All seven copies were written against Node 20 and will break on the host's Node 26, where `navigator` is getter-only. | `registerHooks` grep → 7 files | S3 |
| **R-75** | `handleApiRequest` is a 1,122-line function holding 83 `jsonResponse` calls, 54 method gates and 56 path literals. | `src/server.js:424` | S3 |
| **R-76** | **7 of 17 gates never run in CI**, including every accessibility and layout invariant this project wrote 842 + 432 + 214 + 207 lines to express. `check-budget.mjs` needs neither Chrome nor a server and is the cheapest possible gate to wire. | `.github/workflows/ci.yml`; `scripts/validate.mjs:255-264` imports only four | S2 |
| **R-77** | Three import cycles, all live on deferred bindings. `ingestion ↔ freshness`, `analytics ↔ calibration`, `analytics ↔ drift`. | `src/ingestion.js:22` ↔ `src/freshness.js:53`; `src/analytics.js:7` ↔ `src/calibration.js:2`; `src/analytics.js:8` ↔ `src/drift.js:2` | S3 |
| **R-78** | Nothing enforces the frontend/backend split. `src/` → `public/` and `public/` → `src/` are both 0 edges today, by convention only. A one-line gate would hold it. | full import graph, 430 edges | S3 |
| **R-79** | Adding a connector requires 7 edits across 6 files, four of them source-id-keyed parallel lists in three files that do not check each other's key equality. `docs/ingestion.md`'s row is the best-enforced item in the repo; the lists are the gap. | `src/schema.js:1`, `src/ingestion.js:25`, `:59`, `src/assertions.js:70`, `:99` | S3 |

### Checked and good — stated so it is not re-audited

`src/` is at **97.2% direct module coverage** (69 of 71 modules; untested: `src/index.js`
at 8 lines and `src/lineage.js` at 20). Only 38 of 2,056 tests assert on source text —
**1.9%, far lower than the brief assumed**, and the largest remaining one fails closed.
Store conformance, migrations (against a real provisioned Postgres 16 cluster, 0
skipped), auth, ingestion failure and the offline queue are all genuinely covered.
`emptyStore()`'s duplication of `SCHEMA` is guarded from both sides by two tests.
Adding a *collection* costs 3–6 file edits and 0 migrations, with four guard tests that
fail closed if you forget. Do not spend effort here.
---

## H. Data veracity — where the refusal discipline leaks

This project refuses to claim more than it can compute. These are the places the code
does not honour that, each verified against this checkout.

| id | Defect | Evidence | Sev |
|---|---|---|---|
| **R-83** | **`pct()` inflates every rate in [0,1] by 100×, and is non-monotone.** `Math.abs(n) <= 1 ? n * 100 : n` cannot tell a 0–1 fraction from a 0–100 percentage. Measured: `0.005 → 0.5%`, `0.5 → 50.0%`, **`1 → 100.0%`**, **`1.5 → 1.5%`**, `2 → 2.0%`. A higher true rate can render as a lower one. | `public/shared/fmt.js:51` — executed | S1 |
| **R-84** | **Three definitions of `false_alert_rate`, one name, disagreeing in direction on live data.** On Mandera — the one district with a confirmed false alert — `kpi.js` computes **50%**, `districts.js` computes **0%**, `equity.js` computes **0%**. The confirmed alert's note reads *"Reading traced to a faulty sensor"*, which matches none of the three keywords `/false\|invalid\|noop/i` the district and equity paths scan for. The district page therefore reports that alerting is **clean** for the only district where it was not. | `src/kpi.js:190`; `src/districts.js:151`, `:168`; `src/equity.js:104-105`; computed against the live store | S1 |
| **R-85** | The two wrong definitions have comments **arguing for them**. `src/districts.js:154-166` explains at length why the denominator "stays every alert the district raised" and why `reviewedAlerts.length` gates the result — while the numerator is scanned over alerts that gate excludes. Two different populations, adjacent in the source. | `src/districts.js:154-168` | S2 |
| **R-86** | The falsy-zero class is not retired: **eleven** independent instances of `Number(null) === 0`, `x \|\| 0`, `Number([]) === 0`, `?? 0` on a nullable, or `Number.isFinite(Number(null))` across `impact.js`, `ensemble.js`, `downscaling.js`, `parametric.js`, `flood-depth.js`, `road-access.js`, `kpi.js`, `districts.js`, `viz-uncertainty.js`. **Each has a nearby comment naming the exact hazard class and fixing it for `0` while leaving `null` broken.** | `src/analytics/impact.js:9-12`; `src/analytics/ensemble.js:1-39`, `:56`; `src/analytics/downscaling.js:42-49`; `src/parametric.js:176`; `src/flood-depth.js:512-513`; `src/road-access.js:186-211`, `:393`; `src/districts.js:135-147` | S1 |
| **R-87** | `computePopulationAtRisk` returns **0** for a null population, because `Number(null) === 0` takes the first branch and the `beneficiaries` fallback is dead code. Measured: **0 of 34 service assets carry `population_served` and 0 carry `beneficiaries`**; the result is 105 hazard rows every one reading `population_at_risk: 0`. "13 facilities affected, 0 people at risk" is a published claim that nobody is exposed, derived from a field no connector populates. | `src/analytics/impact.js:9-12` — measured on the live store | S1 |
| **R-88** | `downscaling.js` launders a null observation into a real 0 mm reading: `Number(o[field] \|\| 0)`. It also bails only at `length < 2`, so with **2 stations** an observation of 900 mm is published as 90 mm — a 10× reduction of the most extreme event in the record, from a two-value lookup table. And `bias_correction_source` is `stationGroup[0].source` regardless of which station the map returned, so rows are attributed to a station that contributed neither number. | `src/analytics/downscaling.js:42`, `:44`, `:49`, `:50` | S2 |
| **R-89** | `pearson`/`spearman` filter the two series **independently** and then zip by index. One one-sided non-finite value misaligns every subsequent pair: measured `pearson` → **−0.621** where the aligned survivors give **+1**. The correlation comes out **sign-inverted**. | `src/agreement.js:57-59` — executed | S2 |
| **R-90** | A **null** correlation is read as agreeing. `pearsonValue ?? 0` and `rankValue ?? 1` — both defaults point at the "agree" side, so a dead sensor is certified `agree` with a live one. And `paired_months` reports **key presence**, not measurement, so 3 of 6 months unmeasured publishes as `coverage: "both"`, `paired_months: 6`, verdict `agree`, from a correlation computed on 3 points. | `src/agreement.js:178-179`, `:292`, `:331` | S2 |
| **R-91** | `people_reached` counts **failed** dispatches — `status: "failed"`, `sent_at: null`, HTTP 503 — as people reached: **1,399 people**, with Bor overstated 25%. District attribution joins `alert.scope.district`, which disagrees with the dispatch's own `metadata.region` on 12 of 20 dispatches. Recipients are summed without de-duplication: 22,130 across 20 distinct phone numbers. | `src/districts.js:129-135` — measured on the live store | S2 |
| **R-92** | `Math.max(comparable, 1)` converts "no information" into a confident classification: a basin is labelled `"slope"` from zero comparable samples. Same shape at `road-access.js:186-211`, where a missing hazard coordinate yields `distanceKm = 0` and a `severity: "green"` advisory then closes a trunk road at a distance the module does not know, at `confidence: 90`. | `src/flood-depth.js:512-513`; `src/road-access.js:186-211` — 91 bbox-only hazards in the live store | S2 |
| **R-93** | Rates published from **n=1**: three in `districts.js` (`feeding_repositioning_rate`, `cold_chain_protection_rate`, and a "median" from `lags[floor(n/2)]` which is also the **wrong estimator** — `[1,2,3,4]` → 3, not 2.5, systematically +20% at even n), plus `agreement.js` and `ensemble.js`. `calibration.js` already does this correctly at `MIN_DETERMINED_ALERTS`; the pattern exists and was not propagated. | `src/districts.js:141-147`, `:178`; `src/kpi.js:69`; `src/analytics/ensemble.js:41-58` | S2 |
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

### Closed earlier on this branch, verified rather than re-done

R-01, R-02, R-06, R-07, R-08, R-16, R-17 (`mergeWatermarkForward`), R-19
(async-local fetch recording), R-20 (`next_attempt_at` consulted), R-23, R-24,
R-26, R-28, R-29, R-41, R-42, R-44, R-67.

### Open, with the measurement or the blocker

| id | why it is still open |
| --- | --- |
| R-27 / ENH-09 | Measured again at the audit's scale: **6.96 ms** for a 50-row page from 31,549 rows, flat in page depth (6.96 ms at page 1, 6.99 ms at page 500) — the cost is the filter chain over the array, not the slice. With ENH-07's manifest a list route now reads one collection rather than 39, so the slice is bounded by collection size. Pushing filters into SQL means moving 133 call sites' parameters into the read: ~3 engineer-weeks, and the trigger is a collection whose page cost matters against its own latency budget. |
| ENH-17 | Blocked, and the audit says so: `src/pg0.js:62` connects as `postgres`, a superuser that bypasses RLS entirely. The deployment story changes first — a non-superuser role, `SET app.partner_org` per request — or the policy is decorative. Not attempted rather than attempted and ineffective. |
| ENH-12 | The prune half shipped with R-26 (`O(V)` → `O(k log V)`, 15×). The table half — `record_versions` as a real relation with a real `record_id` — is the one item the audit calls "the schema the auditability claim rests on", ~4 engineer-weeks, with a data migration for existing deployments. |
