# Defect catalogue — audit 2026-10

**Disjoint from the prior audit.** `docs/improvements/defects.md` uses
`SEC / DAT / DATA / ING / INT / PRIV / TEST / WEB`. This catalogue uses fresh
prefixes — `VUL` (security), `VER` (data veracity), `CON` (concurrency), `SCL`
(scalability), `OBS` (observability), `ARC` (architecture), `CAP` (capability gap),
`QUA` (test quality) — so no ID here restates one there.

**Line numbers** were re-verified against the tree at `72a6b63`, not copied from
the audit notes; where a note's line drifted, the verified line is used.

**Severity.** CRITICAL = silent wrong answer or credential/internal-network
exposure. HIGH = wrong or lost data, or an outage class. MEDIUM = degraded
behaviour, real but bounded. LOW = latent or cosmetic-with-teeth.

---

## Security

### VUL-01 — CRITICAL — SSRF in report distribution; `channel.url` is fetched unguarded
`src/server.js:2909` `await fetch(required(channel.url, 'url'), { method: 'POST', … })`.
`channel.url` arrives from the request body via `normalizeDistributionChannels`
(`src/server.js:3030`, `url: channel.url || null`) and is used as-is.
`assertSafeWebhookUrl` is **never called in `src/server.js`** — the guarded path is
`src/webhooks.js:164` (shape + DNS re-check), called only from the outbox.

**Exploit.** `POST /api/v1/reports/<id>/distribute` with
`{"channels":[{"channel":"webhook","url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}]}`.
The server fetches the metadata endpoint; `readExternalResponse` (`src/server.js:3072`)
parses the body, which is persisted into `report_distribution_runs` and returned in
the 201 response. The same primitive scans RFC-1918 hosts. Requires the reports
write scope — a lower bar than admin.

**Fix.** Call `assertSafeWebhookUrl(channel.url)` before the fetch, as the outbox
does. ENH-78 turns this into a regression spec.

### VUL-02 — HIGH — RapidPro webhook secret accepted from the query string
`src/rapidpro.js:363` `|| url.searchParams.get('secret')`, compared by
`constantTimeEquals`. The body-signature path (`:358`) is preferred, so this is the
shared-secret fallback — but a secret in a URL is written to access logs, proxy
logs, the `Referer` of downstream requests and browser history. The leaked value is
the same secret that authenticates inbound webhooks.

### VUL-03 — MEDIUM — Partner-org scoping is inert for reports and by-id reads
`scopeToPartnerOrg` (`src/auth.js:455`) has zero callers. `filterRecords` scopes
only when a record carries the field (`src/utils.js` `item?.partner_org === partnerOrg`),
and `normalizeReport` (`src/reports.js`) never sets `partner_org`. The by-id read
(`src/server.js:2617` `data.reports.find(…)`) does not pass through `filterRecords`
at all. A token scoped to partner org A reads org B's reports and any record lacking
the field. This is a per-object authorization gap that holds for an authenticated,
scoped caller — distinct from the unauthenticated-GET class the prior audit covered.

### VUL-04 — MEDIUM — Dead role checks imply authorization that does not exist
`src/server.js:3908–3909` compute `isAdmin` and `isOperator`; neither is referenced
again in the file. The parametric routes read as if they gate on role but gate only
on scope. A reviewer trusting these variables assumes an admin/operator distinction
that is not enforced.

**Fixed 2026-10-10.** The dead variables were the symptom; the defect was that the
scope vocabulary could not express what `docs/api.md` already promised. Four
documented routes named an audience the gate refused: `POST /api/v1/chw/report` and
`/chw/reply` are documented "`role:chw` or `*`", `POST /api/v1/community-feedback`
"`role:chw`, `write:incidents`, or `*`", and `POST
/api/v1/parametric-rules/:id/simulate` "`role:operator` or `admin:*`". A CHW token
holds `role:chw` and no data scope, so the report the whole surface exists to send
answered 403 to the phone meant to send it — and `/simulate` was unreachable by the
role its own document names.

Two limits in `src/auth.js` caused it, both fixed:

- The table held **one scope per prefix**, so a documented disjunction could only
  name one of its audiences. A scope may now be an alternation —
  `role:chw|write:incidents` — tried left to right, each a complete requirement.
- The matcher spoke only in **prefixes**, so `/simulate` could not be addressed
  apart from the collection it lives under. A pattern may now carry a `:name`
  segment, and the **longest** match wins rather than the first — which removes the
  order-sensitivity that two comments in the table existed to warn about.

`requireScope` gains one branch: a `role:` requirement is satisfied by `admin:*`
(an administrator holds every role — `hasRole` always said so and is called by
nothing in `src/`). Deliberately one-directional: a role does not satisfy a data
scope, so `role:chw` cannot reach `admin:alerts`. The dead `isAdmin`/`isOperator`
are removed, with the enforcement point named in their place.

### VUL-05 — MEDIUM — CI executes unpinned network tooling and tag-pinned actions
`.github/workflows/ci.yml` runs `npx --yes trivy`, `npx --yes @cyclonedx/cyclonedx-npm`
and `npx --yes wait-on` with no version pin (resolves `latest` at run time), and
pins actions by mutable tag (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`,
`slsa-framework/slsa-github-generator@v1.10.0`). A compromised or typosquatted npm
publish runs arbitrary code in CI with `id-token: write` and `contents: write` on
the provenance job.

### VUL-06 — LOW — Base image not pinned by digest
`Dockerfile:1` `FROM node:20-bookworm-slim` tracks a mutable tag; a rebuild can pull
a different base than the one the SBOM attests.

### VUL-07 — LOW — CSP permits inline scripts
`src/server.js:4702` `script-src 'self' 'unsafe-inline'`. The surfaces are static
today, so this is latent, not live — but it removes the primary XSS mitigation for
any future dynamic content.

---

## Data veracity

### VER-01 — CRITICAL — Precipitation summed across stations; the flood score tracks station density, not rainfall
`src/analytics.js:452` `const precipitation = usablePrecip.reduce((sum, v) => sum + v, 0)`,
folded into the score at `:466` `precipitation * 1.5 + …`. `nearby(…)` collects every
climate observation within 125 km, each a *point* total; summing N readings of the
same storm yields N× the rainfall of one. Correct quantity is a spatial mean.

**Failure.** Five stations reporting 20 mm each → `100*1.5 → 100`; one station
reporting 20 mm → `30`. Same weather, 3× the risk band, from sensor density alone.
A coordinator pre-positions assets in the well-instrumented district and starves the
identical under-instrumented one. The score is a map of where the stations are.

**Fix.** ENH-45: declare precipitation `intensive` and refuse the `reduce`.

### VER-02 — CRITICAL — Absent probability folded in as 0, against the module's own comment
`src/analytics.js:461` computes `maxProbability` as `null` when absent, and the
comment above states "an absent forecast is not a 0% chance of rain" — then `:466`
does `(maxProbability ?? 0) * 0.35`. A district whose forecast feed dropped scores
systematically lower than one with a genuine dry forecast: a data outage reads as
lower risk, the unsafe direction.

**Fix.** Omit the term and renormalise over present inputs, or carry it as unknown
so the score is flagged incomplete. ENH-46 catches the pattern.

### VER-03 — HIGH — Events admitted by `occurred_at || from` are dropped by the labeller, which reads only `occurred_at`
`src/flood-probability.js:101` prefilter `Date.parse(event.occurred_at || event.from || '')`;
`monthHasFlood` at `:194` `Date.parse(event.occurred_at)` — no `|| event.from`.
A GDACS-style event dated only by `from` survives the prefilter, is counted in
`events_matched`, but `Date.parse(undefined)` is `NaN` so it never labels a month.

**Failure.** A district with 12 flood events, 8 dated by `from` only, yields 4
positive months. The contingency table's `a` shrinks; the logistic fit and Wilson
intervals are computed on a corrupted table, biased low exactly where the record is
richest. **Fix.** Read the same field set in both places.

### VER-04 — HIGH — Quarterly KPI latency is measured over all-time dispatches
`src/kpi.js:169` `signalToDispatchHours(data.rapidpro_dispatches)` — the raw store,
not the period-filtered set built at `:120`. The monthly series at `:349` uses the
filtered variable correctly. A quarter whose dispatches were all sub-hour reports a
median diluted by years of slower history — or masks a current-quarter regression.

### VER-05 — HIGH — `computeApiUptime` returns 100.0 when the rate is unmeasured
`src/kpi.js:102` `return 100.0` when `computeShortTermSuccessRate()` is `null`.
`null` means "no requests in the ring buffer," not "perfect." A freshly started or
idle deployment publishes "100% API uptime" from zero observations, on the
dashboard an approver reads. The module's own convention elsewhere is to return
`null` and render "not measured."

### VER-06 — HIGH — `filterForDistrict` drops every id-less record after the first
`src/districts.js:84` `const seen = new Set()` … `if (seen.has(r.id)) continue`.
For a record with no `id`, the first match adds `undefined` to `seen`; every later
id-less match hits `seen.has(undefined)` and is skipped. Id-less records are not
duplicates. A district with 40 un-keyed field reports shows 1.

### VER-07 — HIGH — Region aggregation rounds coordinates to integer degrees (~111 km)
`src/analytics.js` region key `${country}:${Math.round(lat)}:${Math.round(lon)}`. A
1°×1° bucket is ~111 km on a side: distinct districts collapse into one region whose
coordinate is whichever point arrived first, and a district straddling a boundary is
split into two half-regions scored against part of its data. Two counties 100 km
apart are reported as one blended score; a boundary county gets two contradictory ones.

### VER-08 — MEDIUM — Input-shift verdict is `'stable'` when every feature's PSI is null
`src/drift.js:150` `let worst = 0`, so an all-null feature set yields `worst_psi: 0`
and `verdict: 'stable'`. Per-feature verdicts correctly say `'not_measurable'`
(`:158`), but "no feature could be measured" is reported as "distribution stable" —
genuine covariate shift is never flagged.

### VER-09 — MEDIUM — `people_reached` folds a recipient count in as if it were an address
`src/analytics/metrics.js:297` `… ?? d?.recipient_count`, added to the distinct
destination set. `recipient_count: 500` becomes the single string `"500"` — one
destination for 500 people; two such dispatches dedup to one; a genuine address
`"500"` collapses with it. `distinct_destinations` travels beside a "people reached"
label and will be read as one.

### VER-10 — MEDIUM — Doc comment contradicts the constant
`src/analytics/ensemble.js:90` says "two is the smallest count at which…";
`MIN_ENSEMBLES_FOR_SPREAD_SKILL = 3`. A maintainer relying on the doc believes a
2-member ensemble is scored; it returns `null`.

### VER-11 — MEDIUM — Duplicate object key `outcome_coverage`; the first is dead
`src/calibration.js` declares `outcome_coverage` twice in one object literal; the
second silently overwrites the first. Harmless today, a latent trap: an edit to the
first line has no effect.

### VER-12 — LOW — Service-impact confidence coerces absent confidence to 0 via `|| 0`
`src/analytics.js` `(nearestFlood?.item?.confidence || 0)`. An asset outside every
risk radius reports confidence 0, reading as "certain the risk is zero" rather than
"no risk reading for this asset."

---

## Concurrency

### CON-01 — CRITICAL — Cross-replica read-modify-write in `outbox.emit`
`src/outbox.js:64` `const data = await store.read()`, then `:106`
`await store.merge({ events_outbox: [record], … })`. The guard at `:66` and the
whole `record` construction are computed against a snapshot; the merge is a separate
statement. On Postgres two processes both read, both decide an event is absent, both
merge — the `attempts`/`next_attempt_at` carry-forward is decided from stale state.
An event re-emitted mid-dispatch resurrects a row whose backoff was just set.
ENH-63 (`pg_advisory_lock`) is the fix.

### CON-02 — HIGH — No deadlock retry; `write()` vs `merge()` lock inversion
`src/postgres-store.js:336` `DELETE FROM lite_records WHERE collection <> '__schema'`
takes row locks across essentially the whole table inside a txn, while `merge()`
upserts the same rows. No `SET TRANSACTION ISOLATION LEVEL`, no `pg_advisory_lock`,
no retry on `40P01` (grep for `advisory|ISOLATION|deadlock|40P01` in
`postgres-store.js` returns nothing). A `write()` racing a `merge()` returns a raw
deadlock error to the caller with no backoff.

### CON-03 — HIGH — `payload_hash` dedupe SELECT is not serialised against concurrent merges
`src/postgres-store.js` upsert: `SELECT payload_hash … ANY($2)` then a JS `seen` Set
filters, then one `INSERT … ON CONFLICT (collection,id) DO UPDATE`. Two concurrent
merges both run the SELECT before either commits, both see the hash absent, both
insert. `ON CONFLICT` saves only id collisions — two records with **different ids
but the same hash** both persist, defeating the dedupe.

### CON-04 — HIGH — `evaluateAndPersistAlerts` fans out N full read-modify-write cycles
`src/server.js:3337–3363`: one `store.merge`, then `for (const event of raised) await emit(…)`.
Each `emit` does its own `store.read()` + `store.merge()`. A storm raising 200
alerts is 200 sequential whole-store reads and 200 merges, serialised, on the
request/periodic path. O(raised × N).

### CON-05 — MEDIUM — `isSuppressed` re-filters all `alert_events` per rule, per evaluation; `Math.max(...seen)` spread
`src/alerts.js` `data.alert_events.filter(e => e.rule_id === rule.id)` inside
`isSuppressed`, called per active rule; combined with the open-event filter,
evaluation is O(active_rules × alert_events). `Math.max(...seen)` passes one argument
per prior event — a long history can exceed the engine's argument limit and throw
`RangeError: Maximum call stack size exceeded`.

### CON-06 — MEDIUM — Idempotency is not durable and the offline path does not use it
`src/server.js:637` `createIdempotencyStore({ ttlMs: 24h, maxEntries: 1000 })` is
in-process; `idempotencyKey` requires a client `Idempotency-Key` the service-worker
outbox does not mint. A retry after a process restart duplicates the write; a queue
drain of >1,000 mutations evicts earlier keys. `/ready` honestly reports
`{ in_process: true }`. ENH-40/63.

### CON-07 — MEDIUM — In-process-only dispatch lock, acknowledged but not enforced across replicas
`src/outbox.js:129` `_dispatchLocks = new WeakMap()` keyed on the `store` object;
the comment states two replicas need `pg_advisory_lock`. With >1 process,
`dispatchPending` runs concurrently in each and the same pending row is POSTed twice.

### CON-08 — LOW — `reportedHeads` Set grows for the process lifetime
`src/audit-chain.js:458` `const reportedHeads = new Set()`, added to and never
trimmed (only the test seam `resetAuditChainWarnings` clears it). Unbounded memory
proportional to distinct tamper warnings seen.

---

## Scalability

### SCL-01 — CRITICAL — Postgres `read()` materialises every requested row, no `LIMIT`, no cursor
`src/postgres-store.js:267` `SELECT collection, body FROM lite_records WHERE …`, then
`store[row.collection].push(row.body)` per row and `sortRecords` per collection. A
request naming a large collection transfers the whole table into the Node heap per
request, O(total rows) bytes + O(N log N) sort, unbounded. `food_security_records`
is 4,517 rows by the code's own comment; history collections are larger. ENH-61.

### SCL-02 — HIGH — `runPeriodicTick` reads the whole store once per driver item
`src/server.js:229–263` `for (const item of DRIVER_ITEMS) { const data = await store.read() }`
— 7 items → 7 full-store reads per tick, plus each item's own internal reads
(`runIngestion` `src/ingestion.js:177`, `dispatchPending` `src/outbox.js:164`). One
tick is ~10+ full-store materialisations at `intervalSeconds` cadence. O(items × N).

### SCL-03 — HIGH — `filterRecords` chains ~18 full-collection passes then slices
`src/utils.js:207–241`: a fixed chain of `.filter()` calls (bbox, country, source,
event_type, … date-range), each allocating a new array over the full collection,
then `.slice(0, limit)`. Every pass walks the whole collection even when a selective
early filter leaves three rows. O(filters × N) allocations per request.
`buildDistrictRelations` also builds a nested Map over all chains per call.

### SCL-04 — HIGH — `sendFile` reads, sha1-hashes and gzip-syncs on every static request
`src/server.js:4610` `fs.readFile`, `:4624` `etagFor(content)` = sha1 over the whole
body, `:4658` `gzipSync(content)` — synchronous CPU compression on the request path,
no gzip cache. `:4632` `last-modified = new Date().toUTCString()` is *now* on every
response, so `If-Modified-Since` can never 304 (only the ETag path can). Concurrent
static requests serialise on the sync gzip work.

### SCL-05 — MEDIUM — `jsonResponse` stringifies and sha256-hashes every 200 body
`src/utils.js` `jsonResponse`: `JSON.stringify(body)` plus a sha256 over the
serialised bytes to compute the ETag, per response. A 5,000-record page is a full
serialise + hash on the hot path, O(response bytes) sync.

### SCL-06 — MEDIUM — `terrain.js` tile cache is unbounded
`src/terrain.js:35` `const tileCache = new Map()`, set with no size cap and no
eviction (contrast `src/basemap-tiles.js:124`, which bounds with `TILE_CACHE_LIMIT`).
Each decoded terrarium tile is a full elevation raster; panning at zoom ≤ 13
accumulates every distinct `z/x/y` for the process lifetime — tens to hundreds of MB.

### SCL-07 — MEDIUM — `/ready` does two full-store reads and a full chain verification per probe
`src/server.js:839` `await withTimeout(store.read(), …)` for reachability, `:861` a
second read, then `auditRollup(snapshot.action_logs)` (`src/audit-chain.js:493`)
which re-hashes every `action_logs` entry (O(n log n) + O(n) sha256). A load balancer
polling readiness pays this every few seconds — amplification on the endpoint
designed to be polled most.

### SCL-08 — MEDIUM — `pg0.runCommand` accumulates output unbounded; timer not unref'd
`src/pg0.js:67–96`: child `stdout`/`stderr` handlers concatenate into growing
strings with no cap, and the abort `setTimeout` is cleared but never `unref`'d.

### SCL-09 — LOW — `rate-limit.js` `acquire()` queue is unbounded
`src/rate-limit.js:213` `queue.push({ resolve })` with no `maxQueue`. Callers that
`await limiter.acquire()` can grow the queue without bound under sustained overload.
The inbound limiter correctly uses `tryAcquire` and never queues; this bites only
the outbound path. ENH-66.

---

## Observability

### OBS-01 — HIGH — Logger argument order inverted at five call sites; those log lines are malformed
`logger.error`/`info`/`warn` are `(event, fields)` (`src/observability.js:40`,
`logEvent` at `:43` spreads `fields`). These pass `(fieldsObject, 'message')`:
`src/protocols.js:467`, `src/server.js:1276`, `src/server.js:3264`,
`src/server.js:3499`, `src/server.js:3690`, `src/analytics.js:417`. `logEvent` sets
`event = <object>` then spreads a string as `fields`, producing numeric keys
`{0:'o',1:'u',…}`. The emitted JSON has no string `event` field, so any pipeline
keyed on `event` cannot match — including the outbox-emit-failure path an operator
greps during an incident.

### OBS-02 — HIGH — Outbox emit failures on two report paths are swallowed silently
`src/server.js:2631` `try { await emit(store, 'report.created', record) } catch {}`
and `:2751` the same for `report.distributed`. Every other emit site logs and
counters. If the store write fails the event is never enqueued, no webhook fires,
and the handler returns 201 `success: true` — a distributed SITREP reports success
while its subscriber notification was dropped, with no error, counter or dead-letter.

### OBS-03 — MEDIUM — No request or correlation id anywhere
`grep -rni "request_id|correlation" src/` returns nothing. The request log line
(`src/server.js:457`) carries no id; the 500 handler mints `incident_id` but never
puts it on the log line nor propagates it. A 500's id returned to the client cannot
be joined to the log entry for that request. ENH-64.

### OBS-04 — MEDIUM — `/health` returns 200 in `starting` when no heartbeat has ever been written
`src/server.js:948` `const starting = !heartbeat`; `:949` returns 200 when
`pipeline.healthy || starting`. If `startPeriodicDriver` fails (`:4782` logs and the
process stays up), no heartbeat is ever merged and `/health` answers 200/`starting`
indefinitely. The Dockerfile and compose healthchecks poll `/health`, so the
container is reported healthy forever while the pipeline never ran. `/ready` is
correct but no orchestrator probes it.

### OBS-05 — MEDIUM — Observability values computed and never surfaced
`metricsOverflow()` (`src/observability.js:187`) has no caller — the counters for
dropped/bucketed/evicted metric series, which the module documents as "reported,
never silently absorbed," are themselves silently absorbed. `uptimeStats()`
(`src/observability.js:3`) and `piiSaltStatus()` (`src/pii.js:295`) likewise have no
production consumer. `/metrics` calls only `metrics.render()`.

### OBS-06 — MEDIUM — Periodic and failure paths bypass the structured logger
`src/server.js:241`, `:260` (`runPeriodicTick`), `:3359`, `:4782` use `console.error`,
not `logger`. Plain text on stderr: `LINDELA_LITE_LOG_LEVEL` filtering and JSON
aggregation do not apply, so a JSON pipeline loses exactly the messages — a failing
tick, a dead driver — an operator most needs.

### OBS-07 — LOW — `kpi._cache` is bounded but not TTL-swept
`src/kpi.js` evicts oldest on overflow and checks `expires`; module-global across
requests. No correctness issue found; noted for completeness.

---

## Architecture

### ARC-01 — CRITICAL — `handleApiRequestInContext` is a 1,597-line god function
`src/server.js:763–2360` holds the entire `/api/v1` surface: 68 literal
`url.pathname === …` tests plus 16 `match*Route()` helpers dispatched from 16 points
inside the same function, three auth gates (one centralised, two copies at `:366`
and `:392`), per-route inline validation, and business logic that belongs in
`kpi.js`/`reports.js`. A change to one route requires reading 1,600 lines. ENH-60.

### ARC-02 — HIGH — Five parallel route tables, no single source of truth
`src/server.js` (68 conditions + 16 helpers), `src/route-manifests.js` (183 entries),
`docs/openapi.yaml` (150 paths), `src/auth.js:431` scopes (91 entries), and the
client's 29 endpoints. `scripts/check-openapi.mjs` exists precisely because nine
live routes went undocumented; adding a route touches up to five files. ENH-59.

### ARC-03 — HIGH — `/api/v1/demo/seed` imports `scripts/seed-demo.mjs` at request time
`src/server.js:1269`. Production `src/` depends on `scripts/` — inverted layering.
The 75 KB seed script is bundled into the runtime path; an import error there is a
runtime 500 on a live route, and the script cannot be moved without touching the server.

### ARC-04 — HIGH — `normalizeSeverity`/`severityWeight` implemented three times with three mappings
`src/schema.js` `{critical:1, high:0.78, medium:0.52, low:0.25, unknown:0.18}`;
`src/alerts.js` defaults `'medium'` and validates against `PRIORITY_LEVELS`;
`src/road-access.js` `severityWeight` returns **3/2/1** and folds `medium` with
`green`; `public/shared/viz-explain.js` re-hardcodes the schema numbers client-side.
The same record scored through the road-access path and the analytics path yields
different weights, and the client's "why this score" can disagree with the server.

### ARC-05 — MEDIUM — Band classification exists only in the browser
`public/shared/flood-bands.js`, `discharge-bands.js`, `weather-bands.js` define the
operational thresholds (passable/restricted/impassable). No `src/` module classifies.
A partner API or SMS client gets raw depth and must re-implement the banding — or go
without. The honesty claim ("0.3 m impedes movement") is enforced only for browser users.

### ARC-06 — MEDIUM — Pagination implemented twice with two clamp algorithms
`collectionPage`/`matchedAndPage` (`src/utils.js:259`, `:307`) server-side;
`public/shared/paging.js` client-side (`LIST_PAGE_SIZE=25` vs server default 500 /
max 5,000). A paging bug is fixed in one and persists in the other.

### ARC-07 — MEDIUM — Error-envelope shape hand-written 128 times; no error taxonomy
`{success:false, error:…}` is written at every `jsonResponse` site. Zero `code`
field. Clients string-match `error` text. One 422, five 409, twenty-three 405.

### ARC-08 — MEDIUM — The collection manifest is applied at one call site; nine others bypass it
`store.read({collections: collectionsForRequest(…)})` is used once
(`src/server.js:900`); direct whole-store reads remain at `src/server.js:234, 490,
839, 861, 2424, 4344`, `src/kpi.js:395`, `src/analytics.js:226, 285`,
`src/ingestion.js:177`. `handleStacRoute:490` and `handleProtocolRoute:4344` each
materialise the entire store. ENH-07's optimisation is half-applied; the widest
readers are the un-migrated ones.

### ARC-09 — MEDIUM — Storage-format knowledge leaks outside the store layer
`src/reports.js:1029` prints `record.payload_hash || record.content_hash || 'none recorded'`
— the report renderer knows the dedup column; `src/ingestion.js:392` sets it. Three
owners of the record shape; a storage-schema change breaks report output silently.

### ARC-10 — MEDIUM — The two store adapters diverge on the default read
`JsonStore.read()` returns the whole store regardless of the manifest's
`includeHistory` (`src/store.js:308`), while `PostgresStore.read()` excludes
`record_versions` by default (`src/postgres-store.js:213`). A JSON dev box and a
Postgres prod box return different shapes for the same call; the conformance suite
only partially catches it.

### ARC-11 — LOW — Two orphaned "copy" seed scripts committed
`scripts/seed-demo copy.mjs` (74,920 bytes) and `scripts/seed-demo-data copy.mjs`
(10,309 bytes), referenced by nothing. 85 KB of duplicated seed logic; the next
person edits the wrong file.

### ARC-12 — LOW — Orphaned re-export and orphan entry point
`public/app.js` re-exports paging helpers the comment says were moved to
`public/shared/paging.js`; nothing imports app.js for them. `src/index.js` (8 lines)
is `package.json` `"main"` but nothing imports `@lindela/lite` — the public API
surface is undefined and unexercised.

---

## Capability gaps

### CAP-01 — CRITICAL — No offline-capable versioned form model (vs ODK/KoboToolbox)
The outbox has exactly-once intent, but the *form definition* is not a first-class
versioned artifact — the CHW wizard is hard-coded (`public/chw/app.js`, 1,179 lines).
A district cannot change a question without a redeploy; submissions from two form
versions cannot be reconciled; the mobile app shares no schema with the web wizard.
ENH-38/39.

### CAP-02 — HIGH — No bulk/streaming interchange (vs HDX, DHIS2)
`/api/v1/export.csv` and `export.geojson` exist, but no HXL row and no DHIS2
`dataValueSet` export — despite shipping a `src/connectors/dhis2.js` *ingest*
connector. It can pull from DHIS2 and cannot push to it: one-way interoperability.
ENH-31/32/37.

### CAP-03 — HIGH — No administrative-hierarchy / org-unit model (vs DHIS2)
`src/districts.js` and `DEFAULT_REGIONS` exist, but district resolution is scattered
across seven modules and there is no registry with codes, boundaries and a parent
pointer. Every aggregation re-derives the hierarchy; a district split is a data
migration, not a config change. ENH-33.

### CAP-04 — MEDIUM — No publication/dataset versioning for downstream consumers (vs HDX)
`/api/v1/export.*` returns a live query with an ETag. A report citing "the
flood-risk dataset" cannot name which vintage it read. ENH-34.

### CAP-05 — MEDIUM — No impact/needs-assessment taxonomy
`community_feedback` and `field_reports` are flat records with a `category` string;
no taxonomy registry, no per-deployment field definition. A partner cannot add a
question to a field report without a code change.

### CAP-06 — MEDIUM — No CORS / preflight; no HEAD on API routes
No `OPTIONS` handler and no `Access-Control-Allow-*` in `src/` — no browser-based
third-party client can call the API. `HEAD /api/v1/…` falls through to the GET
handler and writes a body (only `sendFile` and the tile route special-case HEAD).

---

## Test quality

### QUA-01 — CRITICAL — Module-level mutable singletons make `createServer` non-isolating
`src/server.js:637` `idempotency` (process-global), `:101` `defaultStorePromise`,
`:102` `connectorRegistry`, `:225` `_driverTimer`/`_driverInFlight`;
`src/utils.js:148` `requestContext = new AsyncLocalStorage()` global. Two servers in
one test process share the idempotency namespace and metrics; a test that injects
`{store}` still shares them. Tests are order-dependent. ENH-65.

### QUA-02 — HIGH — 44 of 162 test files assert on source text, not behaviour
`readFileSync` into a string then `.includes`/`.match`. `test/partner-sql-predicate.test.js:244`
strips comments from `src/server.js` and asserts a *regex* is present — it passes
when the line exists and keeps passing when the behaviour is broken (a `partnerOrg`
expression evaluating to `null` at runtime still matches). Dense also in
`test/viz-uncertainty.test.js` (41), `test/deploy-scripts.test.js` (35),
`test/explain-alert-panel.test.js` (34), `test/severity-chip.test.js` (32). A
refactor fails the test while the code is correct; a semantic break passes. Both
erode trust in the suite.

### QUA-03 — HIGH — `public/app.js` cannot be imported; tested through a hand-rolled DOM stub
`test/web-console.test.js` states it: it runs a boot sequence at import time. 6,324
lines of console logic are exercised via `test/browser-env.mjs` stubs. No unit test
of any render function; the console is only as tested as the stub's fidelity.

### QUA-04 — HIGH — `test:coverage` is vacuous
`package.json:13` runs `--test-coverage-lines=75 --test-coverage-include='src/**'`
against **6 test files** (`lite`, `fixtures`, `flood-bands`, `map-frame`, `seasonal`,
`store-conformance`) out of 162. The 75% threshold measures those six files' reach.
A module with zero tests still passes.

### QUA-05 — HIGH — Operationally important modules with no dedicated test file
`src/pg0.js` (zero-config Postgres bootstrap) and `src/audit-chain.js` (the
tamper-evident log) are the two that matter; also `src/observability.js`,
`src/route-manifests.js`, `src/narrator.js`, `src/sanctions.js`, `src/pdf.js`,
`src/community.js`, `src/bitemporal.js`. `public/sw.js` (930 lines, the offline
outbox whose correctness is an exactly-once claim) is tested by reading its text.

### QUA-06 — MEDIUM — No test asserts a route's response envelope shape consistently
`api-substrate.test.js` covers pagination/ETag/idempotency/readiness on
`service_assets` only. No test walks all 150 documented routes asserting
`{success, data}` vs `{success, …page}` vs bare arrays — so `/api/v1/kpi/snapshots`
returning `data: [...]` unpaged next to a paginated sibling is undetected. The
`check-openapi.mjs` trick (read the surface from the server, require both directions)
generalises to this.

### QUA-07 — MEDIUM — `?limit=abc` returns an empty page indistinguishable from no data
`src/utils.js:215` `Math.min(Math.max(Number(query.get('limit') || 500), 1), 5000)`.
`Number('abc')` is `NaN`; `Math.max(NaN,1)` is `NaN`; `matched.slice(0, NaN)` returns
`[]`. A typo'd query parameter reads as an empty dataset with `total: 0`. The
codebase is otherwise scrupulous about exactly this falsy-zero class — this is an
inconsistency, not a philosophy.

---

## What is done right (calibration)

Do not "fix" these; they are why the defects above stand out.

- **Store layer is a genuine seam.** `JsonStore` and `PostgresStore` share
  `COLLECTIONS`, `sortRecords`, `supersededVersions`, `emptyStore`, and
  `test/store-conformance.test.js` runs both against one contract; `replaceCollection`
  is the correct fix for the O(N) full-table-write defect, documented with its measurement.
- **`src/route-manifests.js` is measured, not derived** — a script instruments the
  store and prints what each route reads, and a test asserts the measurement reproduces.
- **Auth is deny-by-default and the default is secure.** `scopeForRoute` returns
  `DENIED_SCOPE` for an unmapped mutation; `filterRecords` defaults to
  `currentRequestAuth()` rather than an opt-in argument.
- **Honesty semantics are real.** `/api/v1/ready` distinguishes `starting` from
  `degraded`; `/health` reports staleness; `?map=1` refuses to coerce `null` to a
  coordinate; retention refuses when the window is unset rather than reporting
  `expired: 0`. `narrator.js` refuses any sentence whose digit is not in the fact set.
- **The webhook SSRF guard holds** — shape check at registration, DNS re-resolution
  at point of use, credentials-in-URL rejected, IPv4-mapped/6to4/NAT64 handled.
  VUL-01 is its unguarded twin.
- **Absent-value discipline is centralised.** `numericOrNull` in
  `src/analytics/numeric.js` is the one sanctioned absent→number gate; the DEM void
  rule (`terrain.js`) makes nodata `NaN`, never 0, with the historical bug in the comment.
- **Metric cardinality is bounded** (`MAX_METRIC_SERIES = 512`, per-label budgets),
  and the inbound limiter is bounded with `tryAcquire` so overload is refused, not queued.
- **Idempotency claims a bound and reports it** (`in_process: true, ttl_hours: 24`).
