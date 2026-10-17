# Improvements review

A deep-dive audit of Lindela Lite, commissioned to answer one question: what would
make this platform dramatically more useful, and what is currently broken.

Four deliverables, plus the evidence they rest on.

> **This audit has been implemented and superseded by [audit-2026-10/](audit-2026-10/)** —
> fifty further enhancements (`ENH-31..80`) and sixty-eight defects across eight
> domains, disjoint from the items below. Read that set for what is still wrong and
> what the platform cannot yet do; read this one for the foundation it built on.

| Document | What it contains |
|---|---|
| [enhancements.md](enhancements.md) | **30 enhancements**, grouped and sequenced, each with evidence, value, and what it does not license |
| [status.md](status.md) | **What has actually shipped** of those 30, verified against the tree: 30 shipped, 0 partial, 0 not started, with the evidence and the guarding test for each |
| [defects.md](defects.md) | **~55 defects**, security holes and architectural deficiencies, and the five root causes behind them |
| [roadmap-extension.md](roadmap-extension.md) | **All 20 items** from `docs/plans/world-class-roadmap.md`, with verified status: 16 shipped, 4 partial, 0 rejected |
| [sources-and-decisions-roadmap.md](sources-and-decisions-roadmap.md) | **30 capability items** — the sources, decisions and operational states the platform could not express, each deduplicated against the three above. Verified 2026-10-16: **6 complete, 7 partly built, 17 unbuilt** — the row statuses are in the register |

The three earlier documents ask whether the platform is trustworthy (ENH) and whether
what it claims to do actually works (items 1–20). The fourth asks a different
question: **what does it not know yet**. It carries its own dedup ledger, so an item
already owned elsewhere is listed and rejected rather than written twice.

Supporting material is in [_research/](_research/), one file per audit domain. Each
is long-form and evidence-dense; the three documents above are the synthesis.

| Research file | Covers |
|---|---|
| [00-audit-baseline.md](_research/00-audit-baseline.md) | Reproduced baseline: failing tests, coverage table, doc-link check, roadmap staleness |
| [backend-security.md](_research/backend-security.md) | `server.js`, auth, input validation, SSRF, resource limits |
| [ingestion.md](_research/ingestion.md) | All 17 connectors, fidelity, timeliness, retry and dedup behaviour |
| [analytics-models.md](_research/analytics-models.md) | Flood probability, flood depth, terrain, KPI, alerts, model honesty audit |
| [storage-ops.md](_research/storage-ops.md) | Postgres/JSON divergence, migrations, audit trail, reports, dead code |
| [ops-deploy-security.md](_research/ops-deploy-security.md) | Container, CI, supply chain, secrets, test coverage assessment |
| [integrations-intent.md](_research/integrations-intent.md) | Alerts, CAP, RapidPro, parametric, JTBD catalogue verification |
| [frontend-visualization.md](_research/frontend-visualization.md) | The eight surfaces, charting, a11y, offline, XSS — 20 defects, 14 enhancements |

`proposed-fixes.patch` holds working fixes for the two highest-value defects
(DAT-02 and DAT-05), prepared by the audit and reverted from the working tree so
every line number here reproduces from a clean `HEAD`.

**Both are now applied**, along with DAT-01, DAT-03 and DAT-07. Fixes are marked
inline in [defects.md](defects.md) with the test that guards them. `proposed-fixes.patch`
is kept for provenance only — do not reapply it.

---

## The short version

**The platform's defining asset is that it refuses to overclaim.** Flood probability
is empirical co-occurrence and every record says so. Risk "percentiles" were
*renamed* to sensitivity bands precisely so they would stop reading as quantiles.
Alerts carry `false_alert: null` when nobody has determined one, so a KPI can report
"not yet measurable" instead of a confident zero. A CI check fails the build if a
forbidden capability claim reappears anywhere in the tree. That discipline is
genuinely unusual and it is the reason this codebase is worth improving rather than
replacing.

Two findings dominate everything else.

**One: the honesty does not reach the payload.** Of 28 numeric outputs, 13 carry a
qualification in the documentation that never reaches the response body. A user
integrating this reads a bare `probability` at `src/server.js:583`; a user reading
the source sees a Wilson interval and a contingency table that stay on the server.
`/score` with no `region` silently scores whichever district trained most recently
(`src/server.js:560-563`). The district overview reports a truncated 30-row slice as
a total (`src/districts.js:73`). Two surfaces render the same unknown as `null` and
as `0%`. The discipline is real, and it stops at the HTTP boundary.

**Two: the production storage backend is untested and lossy.**
`src/postgres-store.js` has **23% line and 0% function coverage** in CI, because the
coverage script omits the integration test and that test skips itself without env
vars CI never sets — while the aggregate reads 87% and the gate is set to 75%. In
that untested module: `write()` issues an unfiltered `DELETE FROM lite_records` and
re-inserts without `payload_hash`, permanently disabling content-addressed dedup
after a single call; and `replaceAnalytics` takes four parameters where the caller
passes six, so `population_at_risk` and `facilities_at_risk` are computed and never
stored on Postgres. The JSON store loses writes under concurrency — 20 concurrent
POSTs left 6 survivors.

And underneath both: **every GET route is unauthenticated** (`src/server.js:237`),
including `GET /api/v1/export.csv`, which returns field reports and RapidPro messages
— even when API keys are correctly configured. That last detail is what makes it
serious. A deployment with auth enabled *looks* secured.

> **All three of the above are closed, and the text is kept as the finding**
> (verified 2026-10-16). Authorization is deny-by-default: `isPublicRequest`
> returns false for anything but `GET`/`HEAD` on an explicitly configured
> `LINDELA_LITE_PUBLIC_PATHS` (`src/auth.js:431-434`), guarded by
> `test/auth-deny-by-default.test.js`. Postgres `write()` upserts through
> `insertRecords` and persists `payload_hash` (DAT-01), and `replaceAnalytics`
> replaces all six derived collections in one transaction (DAT-05); both are in
> `test/store-conformance.test.js`. The JSON store serialises mutations through a
> chain with a temp-file rename (DAT-03), same guard. The coverage gap that let
> the backend go untested is the one thing here that was structural rather than a
> defect, and it is why ENH-29 exists.

---

## What the audit found about the project's own habit

The most useful pattern in this review is not a defect. It is the way the codebase
fails: **it builds the capability and then does not finish the wiring.**

Five of the fifteen partial roadmap items would be *shipped* by adding a test that
fails today.

> **All five are now wired, and this list is kept as the finding rather than as the
> state** (verified 2026-10-16). Each names the shape of the failure, which is why
> it is worth keeping; none is true of the tree any more, and a reader acting on
> this list as current would be sent to five dead ends.
>
> - `analytics/impact.js` counts each asset once — `test/facilities-at-risk-counting.test.js`
>   asserts it over three hazards reaching one asset (DATA-03, DAT-06).
> - `retention` expires through a real `store.remove()` on both backends
>   (`src/routes/maintenance.js:104-129`); the route that reported `success: true`
>   while deleting nothing was DAT-07.
> - `redactPii` is called from eleven sites on the RapidPro inbound path
>   (`src/routes/rapidpro.js`), guarded by `test/privacy-rapidpro-inbound.test.js`
>   and `test/pii.test.js`.
> - `signPayload` is imported and called at `src/outbox.js:382`, which sets
>   `x-signature` on every webhook delivery.
> - `scopeToPartnerOrg` is exercised by `test/partner-isolation.test.js`, and the
>   scoping is pushed into SQL as `partner_org = $2` (`src/store.js:552-567`) —
>   the field it read, which `authenticate()` never set, is the reason it was dead
>   and is now carried on the token.

And one that is not about wiring at all: **falsy-zero conflation, in both
directions, in a codebase that has written the rule down twice.**
`src/server.js:2205` warns against it, `src/analytics.js` carries the comment <!-- line-drift-ok: quoted as it was; the audit entry is a statement about the tree as audited -->
*"an absent forecast is not a 0% chance of rain"*, and commit `4a1ce17` exists
solely to fix one instance. Yet `src/pii.js:34` treats a coordinate at 0° as absent,
`public/districts/app.js:208` drops every record on the equator and prime meridian
from the district officer's map, and `public/app.js:1173` **inverts** the severity
filter for null severity so a `critical` filter shows everything. Three instances,
two directions, one lint rule away from being zero.

So the hard part — the part needing domain judgement — is done everywhere. Missing
is the class of check that verifies a built capability is *reachable*: an adapter
conformance suite, an end-to-end "does this figure reach the caller" test, an
assertion that a rejected alert is never published.

That is why the two foundation items, **ENH-29** (store conformance suite) and
**ENH-02** (payload honesty gate, extending a CI check that already exists), are
worth more than any individual feature here.

**And the build is green while most of it is true.** `main` passed 370 of 370 on
the day of the audit; it is 4,835 today. The two guards written specifically for
the connector-registration bug class assert that a string appears in
`src/ingestion.js`, and they grep the accumulator — which is correct — while the
actual defect sits in `countRecords` fifty lines away. Refactoring the accumulator
to derive from the same shared list *fixes the bug* and *fails both tests*. A green
build here is evidence that a particular string is still present, and the count
going up by an order of magnitude does not change that: it is evidence about the
assertions, not about the code.

---

## Three things that are cheap and were not expected

> **Two of the three shipped, the third is half done** (verified 2026-10-16).
> ENH-25 landed 2026-10-03 and ENH-16 2026-10-03; rate-limit *enforcement* is the
> one still open in the shape described.
>
> - **Bulk upload shipped.** `src/upload.js` with `GET`/`POST /api/v1/upload`,
>   accepting CSV through three doors including real multipart
>   (`src/routes/upload.js:5-6`), 52 tests.
> - **A charting layer shipped.** `public/shared/charts.js` — 17 exported
>   primitives, pure string-returning functions with no DOM — with `co/` and the
>   console wired, 50 tests.
> - **Rate limits are declared and still not enforced.** `src/rate-limit.js`
>   normalises a connector's `rateLimit` declaration and the inbound limiter is
>   live, but the *outbound* connector budget the finding is about — IPC's ~92
>   concurrent requests against a documented 20/min — is unchanged.
> - **The falsy-zero coordinate filter is fixed** (WEB-01/WEB-02): the district
>   map tests `lat === null || lat === undefined || lat === ''`
>   (`public/districts/app.js:263`) and the console's severity filter tests
>   `== null` rather than truthiness.

---

## How this was produced

Seven parallel domain audits (backend/security, ingestion, analytics/models,
frontend/visualization, storage/ops, deployment/security, integrations/product-intent),
plus a direct measured baseline. Every non-obvious claim was reproduced rather than
inferred: the concurrency loss, the auth scope escape, the SSRF registration, the
retention no-op, the ReDoS (14.2 s at n=26), the signed-webhook non-delivery against
a live listener, the `format: null` versus `0%` divergence.

Two caveats stated plainly. Line numbers refer to `b07bbe4` and drift; symbol names
do not. And `docs/architecture/system-overview.md` §7 already records several
defects — the `misses ≡ 0` backtest arithmetic, the lineage cross-source array, the
`/metrics` auth bypass, the GloFAS feed that now serves a web app. Those are
credited, not claimed as new findings.

## Recommended order

1. **ENH-01** — gate every GET, make authorization deny-by-default. Until this
   lands, every other item is built on a surface that hands out the district's
   operational picture and PII to anyone who can reach the port.
2. **DAT-01, DAT-02, DAT-03, DAT-05, DAT-07** — small, mechanical, each currently
   losing data or claiming success while doing so. Land with ENH-29's conformance
   suite so they stay fixed.
3. **ENH-02 and ENH-04** — make the honesty travel in the payload. Everything in
   Group C draws on these.
4. **ENH-25** — bulk upload, so users can get their own data in. **SHIPPED** 2026-10-03: `src/upload.js`, `GET`+`POST /api/v1/upload`, 52 tests. Deviations from the proposal (buffered not streamed, no client-side picker) are recorded in `enhancements.md`.
5. **ENH-06 and ENH-07** — freshness verdicts and assertions. Unglamorous, and the
   difference between an operator trusting source health and ignoring it.
6. **ENH-16 first**, because the chart library makes the other seven visualization
   items composition rather than invention. **SHIPPED** 2026-10-03:
   `public/shared/charts.js`, 5 primitives + `sparkline`, 50 tests; `co/` and
   the console wired. Pure string-returning functions, no DOM — see
   `enhancements.md` for why, and for the one existing chart deliberately kept.