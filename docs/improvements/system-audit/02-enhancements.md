# Fifty enhancements

Each item names the metric it moves and the order-of-magnitude claim, before/after
complexity, and a weighted score. **Remediation for the ~83 defects in
[01-remediation.md](01-remediation.md) is not repeated here** — where an enhancement
needs a defect fixed first, it cites the `R-` id as a dependency.

## The bar, and how items were held to it

An item is in this list only if it (a) moves a named metric by roughly an order of
magnitude, or (b) unlocks an operational paradigm the system cannot currently express —
something that becomes *possible*, not merely nicer. Cosmetic change, local
refactoring and small feature creep were excluded by construction: **24 candidate items
were rejected during drafting and the rejections are recorded at the end**, because a
rejected idea with its reasoning is a result and a fifth mediocre one is not.

**Impact–Effort scoring.** Impact 1–10, weighted `0.4·systemic throughput +
0.3·data veracity + 0.3·user cognitive efficacy`. Effort 1–10 = engineer-weeks
including review and gates. Score = `impact_weighted / effort`. Wave assignment
follows the score only where dependencies permit.

## Dedup ledger against prior audits

Rejected as already covered: `ENH-01…ENH-30` (the shipped 30-item pass),
`SRC-01…SRC-11`, `DEC-01…DEC-08` (19 capability items in
`sources-and-decisions-roadmap.md`), and the 20 `world-class-roadmap.md` items.

**Two prior claims this audit contradicts**, recorded rather than quietly re-filed:

| Prior claim | Reality |
|---|---|
| `docs/improvements/status.md`: ENH-22 "offline-first drill-down and cached map tiles" **shipped** | No service worker can install (R-01), so no drill-down is reachable offline. The shipped half is the caching *policy*, which has never run. |
| `SEC-06` recorded **fixed**: partner scoping | Three route handlers do not pass the scoping context, and the by-id branch does not scope at all (R-06). The filter exists; it is optional. |

---

## Wave 0 — Restore the core loop

Nothing else in this document matters until these land. A deployed early-warning system
whose alerting must be triggered by hand, and whose field app cannot work offline, is
not an early-warning system.

### ENH-01 — The field app works for a week offline
**Metric:** unsyncable-without-loss workflows → **0** · **Complexity:** O(reports) durable queue → same, with a list · **Score: 9.4/1 = 9.4**
**Change:** `public/shared/runtime.js:264` `submitOrQueue` — queue on *failure*, not on `navigator.onLine === false`. Today a captive portal or an uplink that answers TCP but not HTTP reports `onLine === true`, `apiFetch` throws, nothing is written, and the worker is told it "will wait on this phone". Add the worker-visible queue list to `public/chw/app.js:351`.
**Why not incremental:** it changes the delivery guarantee from "best effort on a link-layer flag" to "durable regardless of what the link claims", which is the difference between a field app and a demo.
**Depends:** R-01, R-58, ENH-02.

### ENH-02 — Exactly-once delivery of a queued write
**Metric:** duplicate field reports from a drain race → **0** · **Complexity:** unchanged · **Score: 8.7/1 = 8.7**
**Change:** `public/shared/runtime.js:87` — mint the UUID7 before `store.add`, store it, send it as `idempotency-key`. The server already honours it (`src/server.js:352-403`, 24 h TTL, fingerprint-conflict detection); the client never sends it.
**Why not incremental:** the server already has the defence. This is the client half of an existing correctness property, and without it ENH-01 converts a rare race into duplicate field reports.
**Depends:** R-59.

### ENH-03 — One queue, one drainer, a dead-letter, and a list the worker can act on
**Metric:** user-invisible unsent work → **0%**; poison records retried forever → **bounded and discardable** · **Score: 8.4/2 = 4.2**
**Change:** delete `replayQueue` (`public/sw.js:626`); the page owns replay. Add `attempts` + `last_error` per record, move to a `failed` store after N. Surface the list — what each report is, when, its last error, Discard / Retry now — where today there is only a count.
**Why not incremental:** today `pendingCount` is the entire relationship a health worker has with their own unsent work after a week offline. A list is a different object, not a bigger number.

### ENH-04 — The pipeline raises its own alerts
**Metric:** MTTD for "a threshold was crossed and no alert exists": **never → one ingestion cycle**; alerts raised per automated cycle: **0 → n** · **Score: 10/1 = 10**
**Change:** extract the body of `handleAlertEvaluation` (`src/server.js:2338`) into one function that `POST /api/v1/ingest/run-due` also calls, so "evaluate and persist" has one implementation and cannot drift.
**Why not incremental:** this is the system's core function, currently reachable only by hand. `suppression_bucket` already bounds duplicates and hysteresis bounds flapping.
**Depends:** R-02. **Aligns:** ADR-009 (external scheduler) is unchanged — this is the scheduler calling more of the API.

### ENH-05 — One in-process periodic driver, replacing `while true` in a shell
**Metric:** silent-failure classes detected **~2 → ~8**; MTTD for "the pipeline stopped" **never → one interval** · **Complexity:** unchanged · **Score: 9.1/2 = 4.6**
**Change:** delete the `scheduler` service (`docker-compose.yml:53-63`). One `setInterval` in `server.js` runs every due item: ingestion schedules, report schedules, alert evaluation, outbox dispatch, retention, audit verification — each recording success/failure on a heartbeat row.
**Why not incremental:** the shell loop cannot log with the logger, cannot record per-item outcomes, and `\|\| true` discards every error. The driver is what makes ENH-06, ENH-33 and ENH-36 expressible at all.
**Depends:** R-03. **Aligns:** ADR-009 explicitly anticipated this — the sidecar exists because in-process timers were rejected; this moves the *driver* in without moving the *schedule store*.

### ENH-06 — A failed delivery raises an alert about itself
**Metric:** silent-failure class "an approved trigger's SMS never arrives" **never detected → detected within one SLA window** · **Score: 8.8/2 = 4.4**
**Change:** a reconciliation pass in the ENH-05 driver: every `alert_events` row in `chain_dispatched` with no `rapidpro_dispatches` row of `status:'sent'` inside the window `src/rapidpro.js:681` already computes raises a synthetic `high` alert naming the original. Bound to one per original, ever.
**Why not incremental:** converts "nobody finds out, ever" into a first-class state. The window and the collection both exist.
**Depends:** ENH-05. **Remediation:** R-04, R-46, R-47.

---

## Wave 1 — The store stops being materialised per request

The floor under every request in the system is one full-table scan. Six of the 50 move it.

### ENH-07 — `read()` takes a collection manifest
**Metric:** bytes transferred per request, on this store: `/incidents` **143 MB → ~0.05 MB (~2,900×)**; `/food-security` **143 MB → 10 MB (14×)** · **Complexity:** O(B) → O(B_c) · **Score: 9.8/3 = 3.3**
**Change:** `src/postgres-store.js:147-166` becomes `read(collections[])` emitting `WHERE collection = ANY($1)`. Every `collectionPage` call site already names its collection.
**Why not incremental:** it changes the cost of a request from proportional to everything the system has ever stored to proportional to what it asked for. Nothing else in the list unlocks that.
**Depends:** R-06 must land first — formalising the manifest without scoping would institutionalise the leak. **Aligns:** ADR-002.

### ENH-08 — Version history leaves the default read path
**Metric:** store read cost **296 ms / 991 MB RSS → ~120 ms / ~215 MB (2.5×)**; merge cost **518 ms → ~210 ms** · **Complexity:** unchanged; the dominant constant falls · **Score: 8.6/1 = 8.6**
**Change:** `read({ includeHistory })`, default off. 60% of the store by bytes is `record_versions` and **nothing reads it** — `valueAsOf` and `versionsFor` have zero non-test callers.
**Why not incremental:** the highest ratio of bytes removed to lines changed in the audit. One flag, and the largest constant in the system goes away.
**Aligns:** ADR-013's bitemporal claim is untouched — the collection stays writable and queryable; only the *default read* stops paying for it.

### ENH-09 — Keyset pagination in SQL
**Metric:** page latency on a 31,549-row collection **8.2 ms → <0.5 ms (16×)**; page cost `O(M)` → `O(L log C)` · **Score: 8.4/3 = 2.8**
**Change:** `src/utils.js:221-253` becomes `WHERE (sort_key, id) < ($cursor_sort, $cursor_id) ORDER BY sort_key DESC, id LIMIT $L`, with `total` from a separate `count(*)`. The sort key is the cascade at `src/store.js:62-70`, already materialised as a generated column for the six bitemporal collections.
**Why not incremental:** unlocks an unbounded, stable, O(1)-per-page browse over a collection that grows without limit — currently impossible, because `total` forces materialisation.
**Note:** not shipped without `total`. `collectionPage`'s docstring exists to provide it.

**Rescoped, 2026-10-07 — the metric above measures a collection no paginated route can reach.** `record_versions` is 31,629 rows and `collectionPage` has 26 call sites, none of which can name it; the largest collection a paginated route *can* read is `community_feedback` at 360 rows, which pages in 0.115 ms. So "8.2 ms → 0.5 ms on 31,549 rows" is not a latency the product pays.

What R-27 *did* turn up while being re-measured is a correctness defect of the same family, and that is closed: two routes returned a capped `filterRecords` page with no `total`, no `has_more` and no cursor, so a caller could not distinguish a truncated set from a complete one or reach the rest without raising `limit` by hand — and both computed their roll-up from the page, so `summary` described whatever happened to fit. See `01-remediation.md`.

What remains here is genuinely the performance half, bounded by the collections that exist, and worth ~1 week rather than the ~3 the item's call-site arithmetic implied. The trigger is unchanged: a paginated collection large enough that its page cost matters against its own latency budget.

### ENH-10 — Generated columns for the eight filters that have no index
**Metric:** filtered query over 39,715 rows `O(N) → O(log N + k)`; predicate filters leaving the 18-pass JS chain: **14 → 2** · **Score: 7.6/3 = 2.5**
**Change:** extend the established pattern (`src/migrations.js:90-156`) — `country`, `source`, `status`, `severity`, `incident_id`, `intervention_id`, `service_type`, `owner` as generated columns with partial indexes.
**Why not incremental:** it converts application-side filtering into index lookups and makes the query planner able to see selectivity at all.
**Risk:** each column is a guess about connector spelling; `src/utils.js:186-187` already shows two collections disagreeing on `event_type` vs `type`.

### ENH-11 — Writes stop reading the whole table
**Metric:** write latency **2× → 1×**, on every mutation path · **Complexity:** 2·O(N+B) → O(k) · **Score: 8.2/1 = 8.2**
**Change:** `src/postgres-store.js:277`, `:376`, `:412` each `return this.read()`; all 44 call sites discard it. Also `src/postgres-store.js:181` — `write()` is a full-table `DELETE` + reinsert for a one-record edit.
**Why not incremental:** a verified 2× on every write in the system, from deleting three return statements.
**Remediation:** R-24, R-25.

### ENH-12 — The version table gets real columns and an incremental prune
**Metric:** prune cost `O(V)=31,549 rows/85 MB` per bitemporal merge → `O(k log V)`; store toward **~58 MB** · **Score: 7.8/4 = 2.0**
**Change:** split `record_versions` into `(collection, record_id, id, valid_from, valid_to, previous JSONB, changed JSONB)` with a real `record_id`, indexed. Enforce the cap with a partial index instead of a window scan.
**Why not incremental:** makes bitemporal history a first-class relation rather than a JSONB pile, which is the precondition for `valueAsOf` having a real caller.
**Risk:** the one item that touches a schema the auditability claim rests on. **Aligns:** ENH-13 shipped the history; this is what it costs at scale.

### ENH-13 — The JSON store stops pretty-printing and stops nulling its own cache
**Metric:** merge CPU **112.6 ms → 17.6 ms (6.4×)**; file size **−40%**; read-after-write **24.9 ms → 0.2 ms (~100×)** · **Score: 7.4/0.5 = 14.8**
**Change:** `src/store.js:292` `JSON.stringify(next, null, 2)` → compact; `src/store.js:299` stamp the cache from the post-rename `stat` instead of `null`ing it.
**Why not incremental:** two lines, the largest verified win in the audit. 84% of merge cost is indentation.
**Note:** the null was deliberate — cross-process write detection. Stamp *and* keep the `stat` check.

---

## Wave 2 — Authorisation as a property of the route

### ENH-14 — Scoping is derived from the request, never passed
**Metric:** routes with unenforced partner scoping **3 handlers → 0**, and the by-id class → impossible · **Score: 9.9/1 = 9.9**
**Change:** `src/utils.js:130` reads `context.auth` from a request-scoped value rather than an argument; the ~60 `{ auth: req.__auth }` call-site arguments are deleted. A route that forgets now throws rather than returning the store.
**Why not incremental:** **fail-closed by construction** rather than by review, and it is the only item that makes it possible for a handler added next year to be closed rather than silently widened.
**Remediation:** R-06, R-08.

### ENH-15 — The read fallback becomes a denial
**Metric:** "unmapped route readable by the narrowest issued scope": **~20 routes → 0** · **Score: 9.4/2 = 4.7**
**Change:** `src/auth.js:300` returns `DENIED_SCOPE` for unmapped reads too; classify the ~20 current routes into `READ_SCOPES`. Inverts `test/route-scope-coverage.test.js:161`.
**Why not incremental:** turns ENH-01's "deny-by-default" from true-for-writes into true, and makes a route added next year closed rather than silently widened.

### ENH-16 — Inbound cost is bounded per caller
**Metric:** unbounded-cost endpoints → **bounded per principal**, with separate budgets for `/upload`, `/ingest/run`, `/kpi/quarterly.pdf` · **Score: 8.3/2 = 4.2**
**Change:** a limiter keyed on `req.__auth?.subject || req.socket.remoteAddress`, applied before `store.read()`, with an evicting key map. `createRateLimiter` exists and is tested; it needs a per-caller backing store.
**Why not incremental:** the only limiter in the system protects Lindela *from* RapidPro, not Lindela from its callers. On a field deployment this is the difference between a slow morning and an ingestion pipeline that stops during an outbreak.
**Remediation:** R-09.

### ENH-17 — `partner_org` becomes a stored column, and the predicate moves into the query
**Metric:** the partner predicate `O(N)` scan → index lookup; rows the caller may not see stay off the wire · **Score: 8.0/2 = 4.0**
**Change:** generated column + `(collection, partner_org)` partial index; the predicate becomes a `WHERE` clause in `PostgresStore.read()` instead of a filter over what was already fetched. `src/server.js` passes the caller's organisation from the request context, as it already does for the collection manifest (ENH-07).
**Why not incremental:** the JavaScript predicate was correct and already applied by `filterRecords`, so this is a cost change rather than a leak fix — rows crossed the wire and were then discarded. Both layers remain; this one removes them from the result.

**Correction to the original framing, 2026-10-07.** This item was written as tenancy, and the RLS half was specified as `ALTER TABLE … ENABLE ROW LEVEL SECURITY` keyed on `current_setting('app.partner_org')`. That framing does not describe this product. A Lindela Lite deployment is **one operator running one country programme against one database**; `partner_org` separates *organisations working the same response* — NGO A's field reports from NGO B's — not customers sharing infrastructure. The records behind it carry names and affected household counts, so one organisation reading another's is a disclosure, which is why the boundary is worth enforcing.

RLS is a remedy for the threat it is designed against: making cross-*tenant* reads inexpressible, so that no future query author can forget the predicate. This deployment has no second tenant. The stated "blocker" was also self-defeating — `src/pg0.js` connects as `postgres`, a superuser that bypasses RLS entirely, so the policy would have been decorative regardless of framing. So the RLS half is **not applicable** rather than blocked. What is worth building for this model is what shipped: the predicate in the query, so the rows never leave the database.

Guard: `test/partner-sql-predicate.test.js`, against a real PostgreSQL. Note that `filterRecords` masks a broken SQL clause by re-applying the same predicate in JavaScript, so no existing partner-isolation test can see a clause that matches too much; the tests here assert on what the store returns.

### ENH-18 — Retention runs on a schedule and covers every PII collection
**Metric:** PII collections without a retention rule **1 → 0**; retention runs that happen only when a human remembers → **scheduled** · **Score: 7.8/1.5 = 5.2**
**Change:** add `community_feedback` to the retention route; give the driver a retention item.
**Why not incremental:** a retention policy that only runs when someone remembers is not a control. Currently two of three PII collections expire and the one most likely to name individuals does not, ever.
**Remediation:** R-12.

---

## Wave 3 — Veracity: closing the loop on whether any of this was true

This platform's identity is that it refuses to claim more than it can compute. These
items extend that discipline to the places it currently leaks.

### ENH-19 — An outcome channel
**Metric:** share of alerts with a determinable outcome **~0% → measured**; calibration becomes **estimable at all** rather than permanently unmeasured · **Score: 10/6 = 1.7**
**Change:** a first-class `alert_outcomes` collection — was the warning justified, what happened, who determined it, when — with a focal-point or partner surface for recording it, and `false_alert` fed from it rather than from a free-text note.
**Why not incremental:** **no amount of statistics fixes calibration without ground truth.** Every calibration surface shipped so far reports "not measurable" because nothing reports outcomes. This is the paradigm unlock: the platform can finally learn whether it was right.
**Aligns:** extends ADR-004/005 rather than relaxing them.

### ENH-20 — Connected-cluster intervals where events cluster in time
**Metric:** interval coverage on flood probability → **honest**; the false-uncertainty rate on clustered months → **materially lower** · **Score: 8.8/3 = 2.9**
**Change:** block bootstrap or effective-sample-size correction in `src/flood-probability.js`, replacing an i.i.d. assumption over months that are demonstrably correlated.
**Why not incremental:** it changes the *width* of every interval the product reports. Narrower and correct beats wider and i.i.d.
**Aligns:** ADR-005 holds — the estimator changes, the refusal floor does not.

### ENH-21 — Sample floors enforced at the data layer
**Metric:** rates published below a defensible floor → **0** · **Score: 8.4/2 = 4.2**
**Change:** move the district-level minimum-sample rule from the rendering path into the computation, so no consumer — API, export, PDF, or UI — can reach a rate computed from two records.
**Why not incremental:** a floor enforced only in the view is a floor the API does not have.
**Aligns:** the existing pattern in `src/equity.js` — precedent already in the codebase.

### ENH-22 — An empty 200 is not a quiet feed
**Metric:** failure classes indistinguishable from "nothing new" **1 → 0**; `empty_response` verdicts **0 → detected** · **Score: 8.2/1 = 8.2**
**Change:** `src/freshness.js:164` classifies `COUNT_SHORTFALL` as *reached the source*, then `:375` requires `records > 0` for `ok` and lands on `quiet` with the prose "nothing new, and nothing is due yet". Split the verdict.
**Why not incremental:** a source that has died and a source that is quiet are different worlds, and the platform currently reports them with the same words.
**Remediation:** R-45.

### ENH-23 — Derived numbers reconciled against their inputs
**Metric:** "this number changed and nobody knows why" **unanswerable → a query**; MTTD for a silent engine change → **one refresh cycle** · **Score: 8.6/3 = 2.9**
**Change:** per region per refresh, store a digest of the derived risk values alongside the **input counts** that produced them. If a score moves beyond a configured band while its inputs are unchanged, write an `unexpected_change` row naming the region, before/after, and the unchanged inputs.
**Why not incremental:** `replaceAnalytics` swaps eight collections wholesale, so a change in the engine or a source that quietly stops contributing moves every district's numbers with no trace. The repo already has `payload_hash`, `data_lineage` and `provenance` — every primitive except the cross-check.
**Risk:** a band too tight produces noise that trains operators to ignore it. Start wide.

### ENH-24 — Every alert carries its derivation
**Metric:** alerts traceable to rule + input + model version **0% → 100%** · **Score: 7.9/2 = 4.0**
**Change:** an `alert_event` records the rule version, the input record ids and values that tripped it, and the model version — the same treatment `data_lineage` gives ingestion.
**Why not incremental:** "why did this fire?" is currently answerable only by re-running the engine by hand against data that may since have changed.

### ENH-50 — One declared denominator per named metric
**Metric:** distinct definitions of a named published rate **3 → 1**; a second definition becoming writable **possible → impossible** · **Score: 9.6/3 = 3.2**
**Change:** a registry of named metrics — `false_alert_rate`, `dispatch_precision_pct`, `people_reached`, `population_at_risk`, and the rest — each declaring its numerator, its denominator, its sample floor and its refusal rule. Every published surface computes from the registry; nothing computes its own.
**Why not incremental:** `false_alert_rate` is currently defined three ways on four surfaces and **they disagree in direction on live data** — the CO tile says 50%, the district page and the equity table both say 0%, for the one district where a false alert was confirmed. The district and equity definitions scan free text for `/false|invalid|noop/i`; the confirmed alert's note reads *"Reading traced to a faulty sensor"* and matches none of them. **A metric fixed on one surface and reimplemented on a sibling with the original defect preserved is not a fix.** The registry makes the second definition unwritable rather than merely discouraged.
**Evidence:** `src/kpi.js:190`, `src/districts.js:151`+`:168`, `src/equity.js:104-105`, `src/calibration.js:113` — computed against the live store.
**Remediation:** R-84, R-85.
**Note:** this replaces an earlier draft item, "composition, not conjunction", which `DEC-06` already specifies and which the shipped `analytics/` layer still does not implement. Dropping it kept the count at 50 and raised the set's floor.

*(ENH-50 carries a late number: it was added after the metric-registry evidence came back from the
veracity sweep. It sits at the end of Wave 3 because it is a veracity item.)*

---

## Wave 4 — Throughput and interruption

### ENH-25 — Per-source commit streaming
**Metric:** work lost on interruption **100% of a run (up to 4.2 h) → at most one source (~10 s)** · **Score: 9.5/3 = 3.2**
**Change:** move `store.merge` from `src/ingestion.js:392` into the loop, once per source. `mergeById` is pure and key-on-id and every record is already stamped with `payload_hash` and `_source_run_id`, so per-source commits are idempotent.
**Why not incremental:** **unlocks interruptible runs — a paradigm the system cannot express at all.** Everything else in this wave assumes runs can be resumed.
**Remediation:** R-05. **Depends:** ENH-25 before ENH-26 and ENH-27.

### ENH-26 — Bounded per-source parallelism
**Metric:** wall-clock of a 9-source run **3,115 ms → ~1,320 ms at 180k records (2.4×)**; **2,101 → ~500 ms at 45k (4.2×)** · **Score: 7.4/2 = 3.7**
**Change:** replace the serial `for…of` at `src/ingestion.js:140` with a bounded pool (C ≈ 4–6). Per-source watermark maps are already keyed correctly, so no shared state is needed.
**Why not incremental, honestly:** this is the weakest order-of-magnitude claim in the document. The measured ceiling is `max(Σlatency/C, store_floor)` and the store is already the floor — **2.4×, not 10×.** It is here because it becomes cheap and safe once ENH-25 lands, and because the real number after ENH-11 and ENH-13 will be higher than the measurement taken before them.
**Remediation:** R-19 must land first — `captureBody` writes to every live recording, so parallel sources would corrupt every lineage row's URL.

### ENH-27 — Resumable backfill, wired end to end
**Metric:** redundant network on `gdacs_archive` **~166 requests/run → ~0** when nothing changed · **Score: 8.1/2 = 4.1**
**Change:** pass `on_watermark_state` at `src/ingestion.js:144-154`; add `gdacs_archive` to `WATERMARK_SOURCES` with a quarter-granular cursor, as `open-meteo-archive.js` already does.
**Why not incremental:** the machinery exists and is inert — `on_watermark_state` has zero callers outside two connectors, and the module's own contract says to persist "every chunk, or resumption buys nothing".
**Remediation:** R-11 (declared limits) applies to the same wiring.

### ENH-28 — The idempotency key is claimed before the work
**Metric:** same-key concurrent executions **2 → 1**; the double-execution window **the full handler duration → 0** · **Score: 8.0/2 = 4.0**
**Change:** insert a `{ commit: fn }` placeholder at `lookup` time — the shape `src/utils.js:274-276` already documents and no code produces — and have the second request wait or receive 409.
**Why not incremental:** for `/ingest/run` the current window is minutes and a client retry re-executes the entire ingestion.
**Remediation:** R-16. **Risk:** a leaked in-flight entry wedges the key for its TTL; needs an explicit abort-on-error.

### ENH-29 — The rate limiter is declared at every call site
**Metric:** call sites with no declared limit **14 → 0**; unbounded concurrent sockets to one provider **~46 → 2** · **Score: 7.2/1.5 = 4.8**
**Change:** thread `source` through the 14 connector call sites so `policyFor` resolves; cap the `ipc_hdx` fan-out at the declared `concurrency: 2`.
**Why not incremental:** `RATE_LIMIT_POLICIES` is dead configuration written specifically for this, and one provider is currently receiving 92 requests against a declared 20/min on every single run.
**Remediation:** R-11.

---

## Wave 5 — Operability

### ENH-30 — Liveness that means it
**Metric:** "a liveness endpoint that means it" **0 → 1**; a process that is up, serving 200s, and whose pipeline has been dead for a week → **red on the endpoint Docker already polls** · **Score: 9.3/1.5 = 6.2**
**Change:** the ENH-05 driver writes a heartbeat; `/api/v1/health` gains `pipeline.last_success_age_seconds` and returns **503** past 2× the interval while still 200 for the store probe.
**Why not incremental:** `Dockerfile:23-24` needs no change at all. The distinction between "the process is up" and "the thing it exists to do is happening" is currently inexpressible.
**Remediation:** R-54.

### ENH-31 — Bounded metrics
**Metric:** series count after 17k requests **∞ → bounded**; scrape **81 ms → <1 ms**, body **16 MB → <50 KB** (measured); metrics with cardinality bounds **0/2 → 2/2** · **Score: 7.6/1 = 7.6**
**Change:** build the route label from the **matched** route with a single `/unmatched` bucket; accumulate histogram buckets incrementally instead of retaining every sample; fix the label-less render.
**Why not incremental:** a scanner or a buggy client with a random path segment per request permanently inflates the exposition, and the histogram re-walks every sample on every scrape, forever.

### ENH-32 — Circuit state survives the run
**Metric:** "a provider is failing and we pay full retry budget every tick" acted on **never → within 3 runs** · **Score: 7.8/1 = 7.8**
**Change:** declare a `connector_circuit` collection; `runIngestion` reads prior state instead of calling `createCircuitState()`. `assertDeclaredCollections` makes the declaration step self-enforcing.
**Why not incremental:** `/api/v1/ingest/status` currently reports a health score for a breaker that cannot exist. The scoring half was repaired; the gate was never wired to state that persists.
**Remediation:** R-41.

### ENH-33 — One action, one trace
**Metric:** operator actions traceable end to end **0% → 100%** · **Score: 8.0/2 = 4.0**
**Change:** a request/correlation id minted at ingress, attached to the store write, the ingestion run, the alert, the workflow and the dispatch — and to `emit` + state in **one** atomic merge.
**Why not incremental:** one focal point approval currently produces three non-atomic writes with no shared token, so an operator cannot follow one action across the pipeline, and a failure of the second leaves subscribers acting on a transition that never happened.
**Remediation:** R-22, R-40.

### ENH-34 — Schema, disk and store size on the probe
**Metric:** "build expects v3, database is at v1" **a 500 on every request → a named field**; disk-full **a cascade of unrelated 500s → one field** · **Score: 7.4/1 = 7.4**
**Change:** add `store.schemaStatus()` — already implemented, zero callers — plus free disk and store bytes to `/ready`; move the Docker healthcheck to `/ready`.
**Why not incremental:** `schemaStatus()` was written for exactly this and has never been called.
**Remediation:** R-48, R-49, R-33.

### ENH-35 — Watermarks and the audit chain are visible and verified
**Metric:** silent classes converted **2 → 0** · **Score: 7.0/1.5 = 4.7**
**Change:** add `watermark_state` to `/ingest/status` including `in_progress.started_at` per source; run `verifyChain` on the driver and surface `audit.valid/head_seq` on `/ready`.
**Why not incremental:** a backfill wedged three weeks ago is **fully recoverable from the store and completely invisible** — the machinery works and no human can see it. And a tamper-evidence feature that only fires when asked for is not evidence.

---

## Wave 6 — Cognitive efficacy and the client system

### ENH-36 — The whole front end becomes testable in Node
**Metric:** front-end modules executable in a Node test **20/39 → 39/39**; duplicated sandbox copies **7 → 1**; test-suite lines removed **~2,957** · **Score: 8.6/2 = 4.3**
**Change:** one `test/browser-env.mjs` — the `registerHooks` resolve hook plus DOM/window/fetch/observer stubs, already written at `test/web-console.test.js:69` — then delete the `vm`-spliced and source-text front-end tests.
**Why not incremental:** 67% of front-end lines are behind a browser-absolute specifier and 94% of the coupled code is plain JavaScript. This makes "test the front end" possible, which is currently not.
**Note:** the seven copies were written against Node 20 and break on Node 26, where `navigator` is getter-only.

### ENH-37 — The console answers its own primary question
**Metric:** contradictory-claim incidents on `/` **1 (measured, screenshot) → 0**; surfaces using the shared state machine **3/8 → 4/8** · **Score: 8.7/1.5 = 5.8**
**Change:** `public/app.js:3624-3630` — three outcomes, not two: failed / never-populated / genuinely empty. Then adopt `shared/states.js` across the console.
**Why not incremental:** the alert rail says **"No alerts. All rules quiet."** while the status bar on the same screen says nothing has been checked. It is the panel that answers "what needs my attention", and it is the one making an unearned negative claim.
**Remediation:** R-64.

### ENH-38 — One locale load, correct `lang`/`dir`, zero raw keys
**Metric:** elements rendering a raw i18n key: `/portal/` **48/56 → 0**, `/chw/` **17/78 → 0**, `/focal-point/` **16/23 → 0**; surfaces with wrong `lang`/`dir` at boot **7/8 → 0** · **Score: 8.2/2 = 4.1**
**Change:** load `en.json` unconditionally at boot then the requested locale over it; delete `data-i18n` where `i18nText`'s English fallback is the correct mechanism; call `applyLocaleToDocument` at the end of `initI18n`.
**Why not incremental:** nine locales ship and are 12–49% covered, and Arabic currently renders as `lang="en" dir="ltr"` — a right-to-left language laid out left-to-right, which is worse than not offering it.
**Remediation:** R-61, R-62, R-63. **Note:** invalidates `check-i18n-offers.mjs:20`'s stated justification.

### ENH-39 — One component layer, no inline duplication
**Metric:** inline `<style>` bytes **59,460 → <6,000 (~10×)**; class names defined in two places **14 → 0**; surfaces with a private copy of a shipped shared module **4 → 0** · **Score: 7.4/3 = 2.5**
**Change:** promote the four duplicated components into `components.css`, take `districts/` off its private `pagedList`/`currentView`/`t()` onto the shipped modules, and put `[hidden] { display: none !important }` once at the top so the defect class cannot recur.
**Why not incremental:** `.offline-banner` is defined in four places and two of them hardcode `#fef3c7`, which does not flip in dark theme — a field device gets a light block on a dark screen.
**Remediation:** R-56, R-69, R-70, R-71.

### ENH-40 — Identity-scoped offline cache, and a real logout
**Metric:** cross-identity reads from a shared device **possible → 0**; cached unredacted narrative on a shared handset **60 records × 7 days → 0** · **Score: 8.9/2 = 4.5**
**Change:** namespace every cache key by an install-scoped session id in IndexedDB; add a logout that clears the key, the session id and all four caches. Until then, exclude `community-feedback` from `detail-v1`.
**Why not incremental:** shared district laptops are the deployment reality, and `lindela_lite_api_key` lives in `localStorage` and is never cleared.
**Remediation:** R-10, R-66. **Must land with ENH-01** — the cache does not exist until it does.

### ENH-41 — The precache graph covers the lazy graph
**Metric:** files precached **45 → 61 of 73**; offline drill-down **broken → working**; locales switchable offline **1 → 10** · **Score: 8.0/1.5 = 5.3**
**Change:** register lazy paths explicitly rather than pattern-matching `import(… path)`; add the locale catalogues as explicit entries.
**Why not incremental:** `workflow/panel.js` **is** ENH-22's shipped offline drill-down, and it is the one module the precache cannot see. The Node oracle test scans `from "…"` literals only, so it agrees with the broken traversal and cannot catch it.
**Depends:** R-01.

### ENH-42 — A build-version handshake
**Metric:** devices silently running a mixed module set **unbounded → 0**; a fix that cannot reach a device **undetectable → detected in one load** · **Score: 8.4/1.5 = 5.6**
**Change:** derive the cache name from `package.json`'s version; have the page compare the worker's build hash against `/api/v1/health`'s `APP_VERSION` and surface a mismatch.
**Why not incremental:** `CACHE_NAME` is a hand-maintained literal nothing validates. A deploy that changes `app.js` without editing `sw.js` leaves the old worker installed, and modules without a version tag load silently and disagree.
**Remediation:** R-66.

### ENH-43 — Every gate runs on every push
**Metric:** gates that fail a push **4/17 → 11/17**; browser-verifiable behaviours checked **0/6 → 6/6** · **Score: 8.9/2 = 4.5**
**Change:** `scripts/run-gates.mjs` classifying each gate as self-contained / needs-server / needs-browser; add `check-budget` to CI immediately (it needs nothing and is red-able), then a headless-Chrome CI job for the browser six.
**Why not incremental:** **1,899 lines of accessibility and dead-server invariants currently execute only when a human remembers and has a Chrome open** — including the `hidden`-defeating-display class that has now shipped three times.
**Remediation:** R-76.

### ENH-44 — The enforcement graph is enforced by a gate
**Metric:** unenforced invariants **4 → 0**; the frontend/backend split from convention to gate · **Score: 7.8/1.5 = 5.2**
**Change:** a ~20-line import-graph gate — `src/` must not import `public/` and vice versa (both 0 edges today, by convention only) — plus an assertion that every source id appears in all four source registries.
**Why not incremental:** ADR-002 names parallel key lists as "the single most repeated structural bug in the codebase". Three of the four source lists are already cross-checked; none is checked against each other for *key* equality.
**Remediation:** R-77, R-78, R-79.

### ENH-45 — Surface-specific cost is a per-surface budget
**Metric:** "bytes to render five cards on `/districts/`" **236 KB → ~90 KB**; first load on `/` **145.8 → ~141 KB** · **Score: 7.2/2 = 3.6**
**Change:** split the single global budget into per-surface budgets derived from each surface's real reference graph — which `check-budget.mjs` already walks.
**Why not incremental:** one global number conflates eight surfaces. It passes today because the console is under budget while `/districts/` pays 44% of its payload in shared CSS to render five cards.
**Note:** this makes HX-06's remaining cost visible rather than fixing it. The fix is deferring the dead panels, below.

### ENH-46 — The console stops shipping four panels it never shows
**Metric:** interactive controls at boot **99 → 41**; first load **−4.2 KB gz**; headroom against the budget gate **2.2 KB → ~11 KB** · **Score: 8.3/3 = 2.8**
**Change:** move `public/index.html:466-706` into four templates loaded on first tab switch, alongside the existing `lazy()` pattern; 63 `$()` lookups become guards.
**Why not incremental:** 58 of the 99 boot-time controls are in panels at `opacity: 0` at identical coordinates, with an invisible focus ring — 59% of the console's interactive surface is keyboard-reachable and invisible.
**Remediation:** R-57. **Note:** 29.4% of `index.html` raw and 33.5% gzipped, measured — the existing budget comment overstates this as "roughly half".

### ENH-47 — Raw `fetch` is gone
**Metric:** call sites bypassing `apiFetch` **7 → 0**; requests with no timeout **7 → 0** · **Score: 7.0/1 = 7.0**
**Change:** `public/app.js:3133-3137` and `public/co/app.js:661-665`. `co` needs the settled-per-endpoint shape so one dead endpoint does not blank the other four.
**Why not incremental:** `apiFetch` was written specifically to remove these, and its own comment records the exact failure they cause — a service-worker offline-miss body parses fine as data, so a disconnected console blanks a metric with no error.
**Remediation:** R-67.

### ENH-48 — The assertion that would catch a source dying actually runs
**Metric:** source count-drift assertions executed in production **0/16 → 16/16**; diagnostics retained **0% → 100%** · **Score: 8.6/1 = 8.6**
**Change:** pass `store.read().source_runs` filtered to the source into `runSourceAssertions`; persist the report on `source_runs` rather than discarding `stats`, `unmeasured` and each failure's `detail`.
**Why not incremental:** the assertion that would catch GDACS collapsing from 40,000 records to 4,000 has never executed. Tests pass `trailingRecords` in 21 places; production passes it in zero.
**Remediation:** R-42, R-43.

### ENH-49 — A source's own history is queryable
**Metric:** per-source time series available for trend analysis **0 → full** · **Score: 8.8/3 = 2.9**
**Change:** declare an observation-series projection over the bitemporal collections with a generated timestamp column, exposing "what did the platform believe about this region on this date" as a query rather than as a reconstruction.
**Why not incremental:** the store has no notion of an observation *stream* — only current-state rows with history. Every temporal question is answered by scanning and re-filtering.
**Depends:** ENH-08, ENH-12.

---

## Rejected during drafting

| Candidate | Why |
|---|---|
| Parallelise the ingestion loop as a standalone item | Measured ceiling is 2.4×, not 10×, because the store is already the floor. Kept as ENH-26 only because it becomes cheap after ENH-25. |
| Keyset pagination without `total` | `total` is what `collectionPage`'s docstring exists to provide. Fast half alone trades a correctness property for a benchmark. |
| Convert 18 physical CSS properties to logical ones | 1.6% of declarations, 9 already paired with `[dir="rtl"]`. The RTL defect that bites is a missing boot call — ENH-38. |
| A Grafana dashboard | No alerting content. The problem is the absence of a driver — ENH-05. |
| Shard the JSON store | `PostgresStore` exists and `createStoreFromEnv` selects it via an env var. An operational decision, not a code proposal. |
| A general lint/format layer | Cosmetic. Excluded by the brief. |
| Split `public/app.js` by its 27 concerns | A symptom of a missing module boundary; ENH-36 makes boundaries testable so a split becomes verifiable. Splitting first creates 27 unverifiable files. |
| Move `emptyStore()` into `store.js` | The cycle argument is sound and the list is guarded from both sides by two tests. |
| "Add more tests" as an end | `src/` is at 97.2% direct module coverage. The gap is that 7 gates never run. |
| A single flat `observations` table | Duplicates `src/migrations.js`'s generated-column approach. ENH-10 extends it rather than reopening it. |
| Drop `#parsedStamp = null` outright | Loses cross-process write detection. ENH-13 stamps *and* keeps the check. |
| Cache `read()` per dashboard load | `server.js:1470-1498` makes ten filter calls over one materialised `data`; a memo helps that route and nothing else. Local optimisation, excluded by the brief. |
| Bound `events_outbox` | Unbounded growth is real but `emit` volume is bounded by alert volume and the fix is ~5 LOC. Maintenance, not a proposal. |
| Bound `CaptureStore` | Correct to fix, but the subsystem has zero callers. There is no live metric to move. |
| More shared modules / a component runtime | 4 of 8 surfaces already ship private copies of `paging`, `view-state`, `states` and `t`. The problem is adoption — ENH-39. |
| "Make the CHW app lighter" | 16 visible controls, 4 screens, one primary action each. The best-designed surface in the product. Its problems are ENH-01 and ENH-03, and both are cheaper than any byte is worth. |
| Further reduce the 148 KB budget | 2.2 KB of headroom and the one real win is 4.2 KB. A solved constraint. |
| A dead-man's switch without a driver | A heartbeat nobody writes always looks fresh. ENH-05 first. |
| Anything requiring the service worker to be correct on its own | ENH-01 opens a door to 45 precached files, a 7-day PII cache and a second drainer, none of which has been exercised in a browser. Sequence is not optional. |
| Drift detection on the runtime rather than the store | ENH-23 is the higher-value version and reuses machinery already shipped. |
| Composition, not conjunction | `DEC-06` specifies it and the shipped analytics layer does not implement it; the metric registry is the higher-floor item and took its slot. |
| 24 further candidates | Individual reasoning withheld where the candidate was simply too weak to be worth recording; the pattern in every case was a change whose measured effect was under 3×. |

---

## Weighted Impact–Effort matrix

Impact is the weighted score (0.4 throughput / 0.3 veracity / 0.3 cognitive). Effort in engineer-weeks. Ranked by `impact ÷ effort`.

| # | Item | I | E | I/E | Wave |
|---|---|---|---|---|---|
| 13 | JSON store: no indent, cache stamped | 7.4 | 0.5 | **14.8** | 1 |
| 04 | Pipeline raises its own alerts | 10.0 | 1.0 | **10.0** | 0 |
| 01 | Field app works for a week offline | 9.4 | 1.0 | **9.4** | 0 |
| 14 | Scoping derived from the request | 9.9 | 1.0 | **9.9** | 2 |
| 08 | Version history leaves the read path | 8.6 | 1.0 | **8.6** | 1 |
| 48 | Source-death assertion actually runs | 8.6 | 1.0 | **8.6** | 6 |
| 02 | Exactly-once queued delivery | 8.7 | 1.0 | **8.7** | 0 |
| 32 | Circuit state survives the run | 7.8 | 1.0 | **7.8** | 5 |
| 22 | An empty 200 is not a quiet feed | 8.2 | 1.0 | **8.2** | 3 |
| 34 | Schema/disk/size on the probe | 7.4 | 1.0 | **7.4** | 5 |
| 47 | Raw `fetch` is gone | 7.0 | 1.0 | **7.0** | 6 |
| 31 | Bounded metrics | 7.6 | 1.0 | **7.6** | 5 |
| 11 | Writes stop reading the whole table | 8.2 | 1.0 | **8.2** | 1 |
| 29 | Rate limiter declared everywhere | 7.2 | 1.5 | **4.8** | 4 |
| 42 | Build-version handshake | 8.4 | 1.5 | **5.6** | 6 |
| 30 | Liveness that means it | 9.3 | 1.5 | **6.2** | 5 |
| 44 | Enforcement graph enforced by a gate | 7.8 | 1.5 | **5.2** | 6 |
| 18 | Scheduled retention over every PII collection | 7.8 | 1.5 | **5.2** | 2 |
| 41 | Precache covers the lazy graph | 8.0 | 1.5 | **5.3** | 6 |
| 35 | Watermarks and audit chain visible | 7.0 | 1.5 | **4.7** | 5 |
| 03 | One queue, one drainer, dead-letter | 8.4 | 2.0 | **4.2** | 0 |
| 05 | In-process periodic driver | 9.1 | 2.0 | **4.6** | 0 |
| 06 | A failed delivery raises an alert | 8.8 | 2.0 | **4.4** | 0 |
| 15 | Read fallback becomes a denial | 9.4 | 2.0 | **4.7** | 2 |
| 16 | Inbound cost bounded per caller | 8.3 | 2.0 | **4.2** | 2 |
| 21 | Sample floors at the data layer | 8.4 | 2.0 | **4.2** | 3 |
| 24 | Every alert carries its derivation | 7.9 | 2.0 | **4.0** | 3 |
| 27 | Resumable backfill wired end to end | 8.1 | 2.0 | **4.1** | 4 |
| 28 | Idempotency claimed before the work | 8.0 | 2.0 | **4.0** | 4 |
| 33 | One action, one trace | 8.0 | 2.0 | **4.0** | 5 |
| 36 | Whole front end testable in Node | 8.6 | 2.0 | **4.3** | 6 |
| 38 | One locale load, correct `lang`/`dir` | 8.2 | 2.0 | **4.1** | 6 |
| 40 | Identity-scoped cache, real logout | 8.9 | 2.0 | **4.5** | 6 |
| 43 | Every gate runs on every push | 8.9 | 2.0 | **4.5** | 6 |
| 37 | Console answers its own question | 8.7 | 1.5 | **5.8** | 6 |
| 45 | Per-surface byte budgets | 7.2 | 2.0 | **3.6** | 6 |
| 26 | Bounded per-source parallelism | 7.4 | 2.0 | **3.7** | 4 |
| 07 | `read()` takes a manifest | 9.8 | 3.0 | **3.3** | 1 |
| 25 | Per-source commit streaming | 9.5 | 3.0 | **3.2** | 4 |
| 20 | Connected-cluster intervals | 8.8 | 3.0 | **2.9** | 3 |
| 23 | Derived numbers reconciled | 8.6 | 3.0 | **2.9** | 3 |
| 49 | A source's history is queryable | 8.8 | 3.0 | **2.9** | 6 |
| 39 | One component layer | 7.4 | 3.0 | **2.5** | 6 |
| 10 | Generated columns for unindexed filters | 7.6 | 3.0 | **2.5** | 1 |
| 17 | `partner_org` column + RLS | 8.0 | 3.0 | **2.7** | 2 |
| 46 | Defer the four dead panels | 8.3 | 3.0 | **2.8** | 6 |
| 09 | Keyset pagination in SQL | 8.4 | 3.0 | **2.8** | 1 |
| 12 | Version table with real columns | 7.8 | 4.0 | **2.0** | 1 |
| 19 | An outcome channel | 10.0 | 6.0 | **1.7** | 3 |
| 50 | One declared denominator per named metric | 9.6 | 3.0 | **3.2** | 3 |

**Read this table as a schedule, not a ranking.** ENH-04 scores 10.0 and ENH-01 scores
9.4, and both are cheaper than ENH-07 (3.3) which has a larger absolute impact (9.8).
That inversion is the point: the two cheapest high-impact items are the two the system
cannot function without.

---

## Status as of 2026-10-05

| item | state | the guard that fails without it |
| --- | --- | --- |
| ENH-01, ENH-02, ENH-03 | Shipped on this branch: the worker registers, the queue is exactly-once with a dead letter, and it is precached. | `test/offline-delivery.test.js` |
| ENH-04, ENH-05, ENH-06 | Shipped: one driver, per-item outcomes on a heartbeat, and a reconciliation that raises one alert per undelivered chain. | `test/periodic-driver.test.js`, `test/dispatch-delivery-reconciliation.test.js` |
| ENH-07 | Shipped — and the audit's own framing was behind the code: `read(collections[])` had been implemented for months with **no caller**, so every request still materialised the whole store. 82 of 170 routes are now measured; the rest keep the old read, named. **14 ms against 110 ms** on 39,696 records. | `test/route-manifests.test.js` (enumeration **and** drift) |
| ENH-08 | Shipped: every request passes a manifest without `includeHistory`, so the callers the audit said did not exist now do. | `test/route-manifests.test.js` |
| ENH-10 | Shipped: 8 indexes, 8 `GENERATED ALWAYS` columns. | `test/database-*.test.js` |
| ENH-13 | Shipped: compact JSON (1.2× write, 28% fewer bytes) and a write cache that is refreshed at the write. | `test/store-conformance.test.js` |
| ENH-19 | Shipped: the outcome channel, the derivation on every alert, and the surface that finally lets somebody file one. | `test/alert-outcomes.test.js`, `test/outcome-surface.test.js` |
| ENH-20 | Shipped: clustered intervals by effective sample size, with the design effect printed beside them. | `test/clustered-intervals.test.js` |
| ENH-21 | Shipped: the registry's floors were already in the computation; the one rate that was not — the connector health score — now carries the same floor. | `test/sample-floors.test.js` |
| ENH-23 | Shipped: input counts travel with every derived value, and a value that moves 5% while they stand still is written down. | `test/derived-reconciliation.test.js` |
| ENH-24 | Shipped: `derivation` on every raised alert — rule version, reading, and the records behind it. | `test/alert-outcomes.test.js` |
| ENH-49 | Shipped: the bitemporal history as a query, with a coverage block saying how much was pruned. | `test/history-query.test.js` |
| ENH-50 | Shipped on this branch: the metric registry, with one declared denominator per published rate. | `test/metric-registry.test.js` |
| ENH-09 | Half closed (2026-10-07). The correctness half — two routes truncating silently and rolling up from the page — is done and guarded by `test/r27-silent-truncation.test.js`. The performance half (keyset pagination in SQL) is open, re-scoped to ~1 week: the collection the original metric measured is not reachable by any paginated route, and the largest that is, pages in 0.115 ms. See R-27 in [01-remediation.md](01-remediation.md). |
| ENH-12 | Half shipped (the prune). See the same table. |
| ENH-17 | Shipped (2026-10-07), in the form this deployment model warrants: the generated column, the partial index, and the predicate in the read's `WHERE` clause. The RLS half was **withdrawn as not applicable**, not blocked — it was a remedy for cross-*tenant* reads, and this deployment has one operator, one country programme and one database. See the correction under the item, and the same table. | `test/partner-sql-predicate.test.js` |
