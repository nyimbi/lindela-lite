# Improvements review

A deep-dive audit of Lindela Lite, commissioned to answer one question: what would
make this platform dramatically more useful, and what is currently broken.

Three deliverables, plus the evidence they rest on.

| Document | What it contains |
|---|---|
| [enhancements.md](enhancements.md) | **30 enhancements**, grouped and sequenced, each with evidence, value, and what it does not license |
| [defects.md](defects.md) | **~55 defects**, security holes and architectural deficiencies, and the five root causes behind them |
| [roadmap-extension.md](roadmap-extension.md) | **All 20 items** from `docs/plans/world-class-roadmap.md`, with verified status: 5 shipped, 15 partial, 0 rejected |

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

---

## What the audit found about the project's own habit

The most useful pattern in this review is not a defect. It is the way the codebase
fails: **it builds the capability and then does not finish the wiring.**

Five of the fifteen partial roadmap items would be *shipped* by adding a test that
fails today.

- `analytics/impact.js` counts each asset once per nearby hazard. It has **100% line
  coverage**.
- `retention` reports `{success: true, expired: 1}` and deletes nothing, because
  `merge` has no delete path.
- `redactPii` is implemented, tested, and never called from a request path.
- `signPayload` is defined in one module and called from another that never imports
  it. Every secret-protected webhook is dead, silently.
- `scopeToPartnerOrg` is dead code, and the partner portal renders the filter as
  applied.

And one that is not about wiring at all: **falsy-zero conflation, in both
directions, in a codebase that has written the rule down twice.**
`src/server.js:2205` warns against it, `src/analytics.js` carries the comment
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

**And the build is green while most of it is true.** `main` passes 370 of 370.
The two guards written specifically for the connector-registration bug class
assert that a string appears in `src/ingestion.js`, and they grep the accumulator
— which is correct — while the actual defect sits in `countRecords` fifty lines
away. Refactoring the accumulator to derive from the same shared list *fixes the
bug* and *fails both tests*. A green build here is evidence that a particular
string is still present.

---

## Three things that are cheap and were not expected

- **There is no bulk upload.** No multipart, no `FormData`, no `<input type="file">`
  on any of the eight surfaces. `src/connectors/uploads.js:54` accepts CSV as a
  **string inside a JSON body** (`options.service_assets_csv`). A district officer
  with a 4 MB ACLED export has no path in. This is the hardest adoption blocker in
  the platform and it appears on no existing roadmap.
- **There is no charting layer at all.** No library, no `<canvas>`, no reusable
  chart component anywhere in `public/`. The complete inventory of graphics
  primitives in the product is 39 `svgEl()` calls in `public/app.js` (the map), one
  200×40 px sparkline at `public/co/app.js:328`, CSS-`<div>` bars at
  `public/co/app.js:236`, and CSS-`<div>` bars again at `public/scenarios/app.js:342`.
  Seven of eight users see no chart of anything; what they see instead is a
  `<span>` holding a sentence.
- **Declared rate limits are honoured nowhere.** Every connector declares a
  `rateLimit`; none is enforced. IPC fans ~92 concurrent requests against a documented
  20/min budget, and `gdacs_archive` can hold a request socket for ~4.2 hours.
- **A district map drops every record on the equator and prime meridian**, because
  `public/districts/app.js:208` filters coordinates with `p.lat && p.lon` and 0 is
  falsy. The severity filter on the console is inverted for the same reason: set it
  to `critical` and the map keeps showing everything (`public/app.js:1173`).

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
4. **ENH-25** — bulk upload, so users can get their own data in.
5. **ENH-06 and ENH-07** — freshness verdicts and assertions. Unglamorous, and the
   difference between an operator trusting source health and ignoring it.
6. **ENH-16 first**, because the chart library makes the other seven visualization
   items composition rather than invention.