# Enhancement status

What has actually shipped, verified against the tree rather than against the commit log.
Regenerate with `node docs/improvements/_build-status.mjs` after editing any
`_status-*.json`.

**29 shipped, 1 partial, 0 not started,** of 30.

A status is **partial** when some of the described change is in the tree and the rest is
not, and the detail says which is which. An exported function with no call site is not
shipped.

---
## Group A — Trust: make the honesty reach the payload

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-01 | Deny-by-default authorization from an explicit route→scope table | shipped | `test/route-scope-coverage.test.js`, `test/auth-deny-by-default.test.js` |
| ENH-02 | Honesty envelopes on every numeric response, policed in CI | shipped | `test/flood-score-honesty.test.js` |
| ENH-03 | Per-region calibration and a trust score | shipped | `test/calibration-trust.test.js` |
| ENH-04 | Three tiers of uncertainty on every number | shipped | `test/flood-score-honesty.test.js` |
| ENH-05 | Model-drift monitoring | shipped | `test/drift-monitoring.test.js` |

## Group B — Ingestion fidelity, quality, timeliness

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-06 | Freshness SLAs by cadence, with an `ok \| quiet \| stale \| broken` verdict | shipped | `test/freshness-verdicts.test.js`, `test/ingestion-wiring.test.js` |
| ENH-07 | Per-source data assertions with quarantine-on-fail | shipped | `test/source-assertions.test.js`, `test/ingestion-wiring.test.js` |
| ENH-08 | Watermarks, incremental fetch, resumable backfill | shipped | `test/watermarks.test.js`, `test/watermark-persistence.test.js` |
| ENH-09 | Source-agreement cross-validation | partial | `test/source-agreement.test.js` |
| ENH-10 | Connector health scoring and circuit breaking | shipped | `test/connector-circuit.test.js`, `test/ingestion-wiring.test.js` |
| ENH-11 | Enforce the rate limits that are already declared | shipped | `test/rate-limit.test.js`, `test/rate-limit-wiring.test.js`, `test/rapidpro-webhook-auth.test.js` |
| ENH-12 | Raw payload retention, replay, and fixture seeding | shipped | `test/payload-capture.test.js` |
| ENH-13 | Bitemporal records | shipped | `test/bitemporal-history.test.js` |
| ENH-14 | Completeness tripwires for capped pagination | shipped | `test/completeness-wiring.test.js` |
| ENH-15 | Record-level provenance with real transform versions | shipped | `test/record-provenance.test.js`, `test/ingestion-wiring.test.js` |

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
| ENH-27 | Export that carries the narrative | shipped | `scripts/check-no-flood-probability.mjs` |
| ENH-28 | A donor-inspectable, hash-chained audit trail | shipped | `test/parametric-trigger.test.js` |

## Group E — Platform foundations

| | Enhancement | Status | Guarded by |
|---|---|---|---|
| ENH-29 | A store conformance suite, a real schema, and migrations | shipped | `test/store-conformance.test.js`, `test/migrations.test.js` |
| ENH-30 | API substrate: pagination, conditional requests, idempotency, readiness | shipped | `test/api-substrate.test.js` |

---

## What each open item is missing

### ENH-09 — Source-agreement cross-validation

**partial.** `src/agreement.js` computes what the item asks for — Pearson and Spearman correlation with `minPearson: 0.5`, a paired-month count floor, a sign-disagreement rate capped at 0.25, and a four-value verdict of `agree | marginal | disputed | unavailable` — and it pairs on `period`, never on array index, which is the mistake that makes naive cross-product comparison meaningless. `unavailable` is returned rather than a fabricated verdict when either side is flat (`dx === 0 || dy === 0`), because a flat product carries no ordering information. Two things are missing: there is still no GeoTIFF reader (CHIRPS declines to decode pixels at src/connectors/chirps.js:23), so the two products cannot actually be compared in production; and no route surfaces `agreementReport` — the module is a library with no caller, which is the same defect ENH-16 has.

Evidence:

- `src/agreement.js`
- `src/connectors/chirps.js:23`

---

## Verification

Every `path:line` above and every guard filename is resolved against the tree when
this file is generated; a claim that cannot be checked is not written. What the
current tree says:

- **30 items**, each with evidence and a status.
- **0 broken references** among the 171 evidence paths and guard names.
- **1 module named here with no production caller.**
- **0 items naming no guard test.**

### Built, tested, called by nothing

The module is in the tree and has tests, but nothing outside `test/` imports it.
The status of the item it belongs to should say so — an exported function with no
call site is not shipped.

- ENH-09 `src/agreement.js`

