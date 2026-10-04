# Enhancement status

What has actually shipped, verified against the tree rather than against the commit log.
Regenerate with `node docs/improvements/_build-status.mjs` after editing any
`_status-*.json`.

**30 shipped, 0 partial, 0 not started,** of 30.
The two that shipped before this round were the two the project was built to make possible
anyway: the API substrate a caller can integrate against (`ENH-30`) and a way to get your
own data in (`ENH-25`). The five since are the ones where a claim had become load-bearing —
a quarantine collection that had to exist for the store not to drop condemned batches on the
floor (`ENH-07`), a history that had to exist before the next overwrite destroyed the only
record of the previous value (`ENH-13`), and three that had stopped being honest.

A status is **partial** when some of the described change is in the tree and the rest is
not, and the detail says which is which. An exported function with no call site is not
shipped: three of the chart library's six primitives are exported, tested, and called by
nothing in the product.

---
## Group A — Trust: make the honesty reach the payload

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-01 | Deny-by-default authorization from an explicit route→scope table | shipped | `test/route-scope-coverage.test.js`, `test/auth-deny-by-default.test.js` |
| ENH-02 | Honesty envelopes on every numeric response, policed in CI | shipped | `test/flood-score-honesty.test.js` |
| ENH-03 | Per-region calibration and a trust score | shipped | — |
| ENH-04 | Three tiers of uncertainty on every number | shipped | `test/flood-score-honesty.test.js` |
| ENH-05 | Model-drift monitoring | shipped | — |

## Group B — Ingestion fidelity, quality, timeliness

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-06 | Freshness SLAs by cadence, with an `ok \| quiet \| stale \| broken` verdict | shipped | `test/freshness.test.js`, `test/ingestion-wiring.test.js` |
| ENH-07 | Per-source data assertions with quarantine-on-fail | shipped | `test/assertions.test.js`, `test/ingestion-wiring.test.js` |
| ENH-08 | Watermarks, incremental fetch, resumable backfill | shipped | `test/watermarks.test.js`, `test/watermark-persistence.test.js` |
| ENH-09 | Source-agreement cross-validation | shipped | `test/source-agreement.test.js` |
| ENH-10 | Connector health scoring and circuit breaking | shipped | `test/circuit.test.js`, `test/ingestion-wiring.test.js` |
| ENH-11 | Enforce the rate limits that are already declared | shipped | `test/rate-limit.test.js`, `test/rate-limit-wiring.test.js`, `test/rapidpro-webhook-auth.test.js` |
| ENH-12 | Raw payload retention, replay, and fixture seeding | shipped | `test/capture.test.js` |
| ENH-13 | Bitemporal records | shipped | `test/bitemporal-history.test.js` |
| ENH-14 | Completeness tripwires for capped pagination | shipped | `test/completeness.test.js` |
| ENH-15 | Record-level provenance with real transform versions | shipped | `test/provenance.test.js`, `test/ingestion-wiring.test.js` |

## Group C — Visualization depth

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-16 | A chart component library, shared by all eight surfaces | shipped | `test/charts.test.js`, `test/charts-primitives.test.js` |
| ENH-17 | Render uncertainty as geometry, not as a footnote | shipped | `test/charts.test.js`, `test/viz-uncertainty.test.js` |
| ENH-18 | Time-slider playback of hazard history | shipped | `test/viz-playback.test.js` |
| ENH-19 | Map → chart → record drill-down, with a `/explain` endpoint | shipped | `test/viz-explain.test.js` |
| ENH-20 | Month × year seasonal calendar heatmap | shipped | `test/seasonal-calendar.test.js`, `test/charts.test.js` |
| ENH-21 | Forecast-versus-observed verification charts | shipped | `test/viz-verify.test.js` |
| ENH-22 | Offline-first drill-down and cached map tiles | shipped | `test/sw-offline-detail.test.js`, `test/sw-cache-eviction.test.js`, `test/web-chw-offline.test.js` |
| ENH-23 | Colourblind-safe and high-contrast themes | shipped | `test/theme-tokens.test.js`, `test/theme-choice.test.js`, `scripts/check-a11y.mjs` |
| ENH-24 | Shareable, deep-linked, per-role dashboard state | shipped | `test/view-state.test.js` |

## Group D — Response and delivery

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-25 | Bulk upload with a validation report | shipped | `test/upload.test.js` |
| ENH-26 | Two-way SMS acknowledgement, escalation, and delivery tracking | shipped | `test/rapidpro-two-way.test.js` |
| ENH-27 | Export that carries the narrative | shipped | — |
| ENH-28 | A donor-inspectable, hash-chained audit trail | shipped | `test/parametric-trigger.test.js` |

## Group E — Platform foundations

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-29 | A store conformance suite, a real schema, and migrations | shipped | `test/store-conformance.test.js`, `test/migrations.test.js` |
| ENH-30 | API substrate: pagination, conditional requests, idempotency, readiness | shipped | `test/api-substrate.test.js` |

---

## What each partial is missing

---

## The patterns

Three shapes recur, and each one is this repository's own defect class rather than a
coincidence of what happened to get built.

**The most recent wave reproduced the first pattern while trying to fix it.** Group B was
the outlier — nine of ten items untouched — so eight modules were built in parallel with
tests, and four of them were then wired into `runIngestion`: quarantine (`ENH-07`), the
circuit gate (`ENH-10`), the freshness verdict on the status route (`ENH-06`) and record
provenance (`ENH-15`). The other four — watermarks (`ENH-08`), agreement (`ENH-09`),
capture (`ENH-12`) and completeness (`ENH-14`) — are still exported, tested and called by
nothing, which is exactly the defect below, now four instances wider and written by the
same effort that was fixing it. The ledger counts them partial for that reason and not
because their logic is unfinished.

**A capability landed where one call site existed and nowhere else.** The chart library
(`ENH-16`) is 640 lines with 50 tests and is imported by 2 of 8 surfaces; `lineChart`,
`stackedBar` and `heatmap` are exported, tested, and called by nothing in the product.
`ENH-17`, `ENH-20` and `ENH-21` all need one of those three, so three items are blocked
behind call sites that do not exist. Same shape in `ENH-04`: sampling uncertainty reached
`/api/v1/flood-probability/score` and no other route.

**Uncertainty stopped at one boundary.** `ENH-02` (the envelope), `ENH-04` (three tiers),
`ENH-17` (uncertainty as geometry) and `ENH-21` (forecast verification) are four items
about the same idea. One tier, on one route, in prose in the docs and a Wilson interval in
one response field. Every one of them says the same thing: the caveat has to travel with the
number, and it currently travels with about one number.

**A list written once and checked nowhere.** `ENH-01` is the shape this class takes, and
fixing it found the defect: deny-by-default shipped as *behaviour* with its route→scope table
module-private, so nothing could iterate it. Exporting the table found seven mutating routes no
prefix covered - each already failing closed, each a 403 to a caller holding the documented
scope. `ENH-29` still has it: a conformance suite that covers Postgres only when a CI job nobody
sets provides a database, so CI exercises one adapter and reports both. `ENH-24` has no test at
all.

Group B was the outlier and now is not, but it is not done either: four of ten shipped and
six are partial, and in five of those six the missing half is the same half — a module that
works, tested, and has no caller. The rate limiter is the sharpest case: the token bucket and
the `Retry-After` handling are written, and the `perMinute 20` declared beside an unbounded
`Promise.all` in the IPC connector is still documentation.
