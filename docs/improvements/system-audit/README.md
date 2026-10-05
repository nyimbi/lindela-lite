# System audit — Lindela Lite

**Date:** 2026-10-05
**Scope:** the tree at `7f468c4` — 222 files, 88,636 lines (`src` 28,144 · `public` 22,156 · `test` 32,682 · `scripts` 5,654)
**Method:** six domain analysts working read-only against the source, followed by verification of every load-bearing claim by hand.

| Document | Contents |
|---|---|
| [01-remediation.md](01-remediation.md) | **92 defects** requiring remediation — disjoint from the 50. Defects, anti-patterns, concurrency anomalies, scalability bottlenecks, observability deficits, security vulnerabilities. |
| [02-enhancements.md](02-enhancements.md) | **50 enhancements** — each with a named metric, the order-of-magnitude claim, complexity before/after, and a weighted score. |
| [03-roadmap.md](03-roadmap.md) | Six phases, dependency graph, critical path, resource allocation, and the sequencing constraints that are not negotiable. |

Three further veracity findings were verified by hand after the analysts reported them
and are the most consequential thing in [01-remediation.md](01-remediation.md) section H:
`pct()` inflates every rate in [0,1] by 100× **and is non-monotone** (a true 1% renders
as 100%, a true 1.5% renders as 1.5%); `false_alert_rate` has **three definitions on four
surfaces that disagree in direction on live data**; and eleven independent
null-to-zero coercions sit behind comments that name the exact hazard class and fix it
for `0` while leaving `null` broken.

This is a **second audit**. `docs/improvements/` already holds a 30-item enhancement
pass (all shipped), a ~55-item defect list, and 19 capability items. Those are not
re-litigated here; [02-enhancements.md](02-enhancements.md) carries a dedup ledger
against all three. Where this audit *contradicts* a prior document's claim that
something was fixed, that is recorded explicitly rather than quietly re-filed.

---

## Two findings reframe everything else

### 1. The product has never been offline-capable

`public/sw.js` carries eleven top-level `export` statements (lines 41, 91, 116, 143,
159, 187, 198, 209, 239, 270, 520). It is registered as a **classic** script:

```js
// public/shared/runtime.js:15
_swRegistration = navigator.serviceWorker.register('/sw.js').catch(() => null)
```

Verified in a real browser at a secure origin (`window.isSecureContext === true`):

```
navigator.serviceWorker.register('/sw.js')            → FAILED: ServiceWorker script evaluation failed
navigator.serviceWorker.getRegistrations()            → 0
navigator.serviceWorker.register('/sw.js',{type:'module'}) → REGISTERED http://127.0.0.1:4177/
navigator.serviceWorker.getRegistrations()            → 1
```

Every offline capability is downstream of an install that cannot happen: `precache()`
(sw.js:326) never runs, the three read buckets (`CACHE_POLICIES`, sw.js:41) never
exist, Background Sync never registers, `replayQueue()` (sw.js:626) never runs, and
none of the `install`/`activate`/`fetch`/`sync`/`message` listeners ever attach.

`git log --reverse public/sw.js` — the exports were introduced by `aaac84f`
(fix:offline), `b7e1297` (fix:sw) and `363adc1` (fix:offline, **ENH-22**). Three
consecutive offline-hardening commits, one of them a shipped enhancement, hardened a
worker no browser will install.

Two things hid it. `.catch(() => null)` makes a registration failure
indistinguishable from "this browser has no service workers" in every log the product
has. And `test/web-chw-offline.test.js` does `await import('../public/sw.js')` — a
Node ESM import, which **works**, because Node honours the module syntax the browser
rejects. The test suite exercises the worker's exported functions and passes 45
assertions while the registration path that would install it is broken.

This is the single most consequential finding in the audit, and it is one line to fix
— which is precisely why it survived a 30-item improvement pass, a UX audit, a
21-document architecture set and 2,056 tests.

### 2. Nothing raises an alert unless a human asks

`evaluateAlertRules` has exactly one call site: `src/server.js:2349`, inside
`handleAlertEvaluation`, reachable only via `POST /api/v1/alerts/evaluate`
(`src/server.js:1104-1105`).

The deployment's scheduler calls two things:

```yaml
# docker-compose.yml:59-62
curl -fsS -X POST http://app:4177/api/v1/ingest/run-due        ... || true
curl -fsS -X POST http://app:4177/api/v1/report-schedules/run-due ... || true
```

and the `run-due` handler does this:

```js
// src/server.js, POST /api/v1/ingest/run-due
const result  = await runDueIngestionSchedules(store, data, body)
const analytics = await refreshAnalytics(store)     // computes and stores risk_scores
const logs = [...]
if (logs.length) await store.merge({ action_logs: logs })
jsonResponse(res, 201, { ... })
return
```

`refreshAnalytics` (`src/analytics.js`) does not call `evaluateAlertRules` — verified,
no alert-creating call in it. So the cycle is: ingest → score → **stop**. A hazard
crossing an alert threshold produces a risk score in the database and nothing else: no
alert event, no SMS, no workflow instance, no log line. `|| true` then swallows any
error from the whole cycle.

The README is careful and does **not** claim automatic alerting — it says the product
"computes transparent baseline risk scores, exposes formatted data through an API, and
provides a lightweight dashboard". So this is a missing capability, not a false claim.
But a deployed early-warning system whose alerting must be triggered by hand is a
system that will not warn anyone, and the scheduler's omission is one line.

---

## Architectural spine

Three facts generate most of the 50 items and most of the remediation list. Each was
assumed settled; none survived contact with the source.

**The store is materialised whole, per request.** `PostgresStore.read()`
(`src/postgres-store.js:147-151`) is

```sql
SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC, collection, id
```

with no `WHERE` and no `LIMIT`, and `src/server.js:486` calls it at the top of
`handleApiRequest` — before the first route test, so every request pays it including
404s and including writes. The `ORDER BY` cannot use
`lite_records_collection_updated_idx (collection, updated_at DESC)` because the sort
leads with `updated_at` globally. Two independent sorts then run: one in SQL, one in
`sortRecords` (JS, measured **87 ms**), plus a linear `COLLECTIONS.includes()` per row
(measured **53 ms**).

The table holds 39,715 rows. 60% of it by bytes — 85.4 MB across 31,549 rows — is
`record_versions`, which **nothing reads**. `grep -rn "record_versions" src/ test/ public/`
returns only store internals and two tests; `valueAsOf` and `versionsFor` have zero
non-test callers. On this store: 296 ms parse, 991 MB RSS, on the read path that
already happened 63 ms ago.

**Enforcement is opt-in, not a property.** `filterRecords` (`src/utils.js:130`) reads
`context.auth?.partner_org`; with no context it is `null`, and `src/utils.js:182` then
returns the collection **unfiltered**:

```js
const matched = (partnerOrg ? records.filter((item) => item?.partner_org === partnerOrg) : records)
```

Three route handlers do not pass one. This is the fourth instance of a pattern the
repo already names in ADR-002 as "the single most repeated structural bug in the
codebase" — a list that must be updated in N places, where missing one silently drops
data.

**A shipped mechanism with no caller.** `markScrollableRegions` had zero call sites
(eight surfaces). `on_watermark_state` has zero call sites outside two connectors.
`beginCapture` has zero call sites. `schemaStatus()` has zero call sites. The read
fallback in `scopeForRoute` is `read:hazards`, and `test/route-scope-coverage.test.js:161`
asserts it. ENH-05, ENH-06, ENH-07, ENH-08, ENH-10, ENH-11, ENH-12 each shipped a
mechanism; several shipped a mechanism and, separately, a test that exercises the
mechanism directly rather than the thing it exists to serve.

## What the analysts rejected, and why

Recorded because a rejected idea is a result.

- **Parallelising the ingestion loop.** Measured: 9 sources at 180k records, wall-clock
  3,115 ms of which 1,800 ms is network and 1,315 ms is the store write. Parallelism
  buys `max(1800/C, 1315)` — **2.4×**, not 10×. The store is already the floor. Fix the
  store first; the parallelisation then costs almost nothing to add.
- **Keyset pagination without `total`.** Real, but `total` is what
  `collectionPage`'s own docstring exists to provide. Shipping the fast half alone
  trades a correctness property for a benchmark.
- **Converting 18 physical CSS properties to logical ones.** 1.6% of declarations, 9
  already paired with `[dir="rtl"]` overrides. The RTL defect that actually bites is a
  missing boot call, not a CSS migration.
- **A Grafana dashboard.** No alerting content. The problem is the absence of a driver,
  not the absence of a visualisation.
- **Sharding the JSON store.** `PostgresStore` already exists and `createStoreFromEnv`
  selects it via `LINDELA_LITE_DB_MODE`. This is an operational decision, not a code
  proposal.
- **More tests, as an end in itself.** `src/` is at 97.2% direct module coverage. The gap
  is that 7 of 17 gates never run in CI, not that tests are scarce.

## Verification performed

Every claim marked **critical** or **high** was independently re-checked against the
source before it was written here. Three of them are load-bearing enough to state what
was done:

- **Offline (§1)** — reproduced in a real browser; both the failing and the succeeding
  registration quoted above.
- **Alert evaluation (§2)** — `grep` for every call site of `evaluateAlertRules` and for
  `/api/v1/alerts/evaluate` across `src/`, `scripts/`, `docker-compose.yml`, `Dockerfile`
  and `.github/`; the `run-due` handler read in full.
- **Partner isolation** — the by-id branch of `handleOperationalRoute` read directly; it
  returns `data[route.collection].find(...)` with no scoping expression of any kind.

Claims that could **not** be verified are marked as such at the point of use. Every
Postgres figure is plan-level reasoning from query text and index definitions — no
populated instance existed on the audit machine and creating one would have been a
mutation. Every JSON-store figure was measured against this checkout.