# ADR-004: Rename the risk percentiles to sensitivity bands

**Status:** Accepted
**Applies to:** `src/analytics.js` (`computeFloodRisk`, `computeClimateConflictRisk`)
**Deciders:** whoever changes the risk scorer

## Context

Every risk record carries three numbers alongside its score. They were named `score_p10`, `score_p50`
and `score_p90`.

They are not quantiles of a predictive distribution. The width is a fixed linear function of an
input-coverage confidence score:

```js
const halfWidth = Math.round((100 - confidence) * 0.4)
```

There is no fitted distribution, no residual variance, and no posterior. Worse, the degenerate case is
silent: a well-populated region returns **p10 == p50 == p90 with `interval_width` 0**, which presents
as *"no uncertainty"* when it means *"enough inputs to compute a point score at all"*.

Every record also carries `calibrated_uncertainty: false`.

The names were the problem. `p10` is a promise of calibration, and a downstream reader — a planner, a
report, a funder — will read it as one. The number was never wrong. The label made it into a claim.

## Decision

Rename them to `sensitivity_low`, `sensitivity_mid`, `sensitivity_high` plus `sensitivity_width`, and
keep the old names as retained aliases so nothing downstream breaks silently. Every record continues
to carry `calibrated_uncertainty: false`.

State plainly in the record that the band is *"a sensitivity band around the point score, NOT a
probabilistic interval"*, and carry a `limits` prose field that says what was not modelled.

## Options considered

### Fit a calibrated distribution and keep the names

| Dimension | Assessment |
|---|---|
| Makes the name true | Yes |
| Data requirement | Enough historical outcomes per region to estimate a predictive distribution |
| Available data | None. The same archive ceiling as [ADR-005](ADR-005-flood-probability-basis.md) |
| Honest? | Only if it works. It does not, here. |

**Rejected.** Renaming to fit a model that does not exist is the same error wearing a hat.

### Keep the names, add a disclaimer field

**Rejected.** A `calibrated_uncertainty: false` flag sits beside `score_p10` and loses. The name is
what gets read; the flag is what gets skipped. `cap.js` is the proof: the CAP renderer previously read
`lead_time_days`, which no alert event carries, so **every alert published as `Immediate`** — including
a low-severity observation. The consumer read a field that was not there.

### Drop the band entirely

**Considered.** It costs nothing to compute and does carry information: how much the score depended on
inputs that were present. A narrower band is a genuine, if weak, statement about input coverage.

**Rejected**, on the grounds that the information is real and only the name was false.

## Consequences

**Easier**

- Nothing downstream can quote `p10` and be quoting a probability.
- The degenerate zero-width case reads as what it is: a well-covered region.
- The rename is greppable, so a future contributor reaching for the old names finds this ADR.

**Harder**

- Six field names retained for compatibility means the payload carries both vocabularies. Anyone
  reading the record sees `sensitivity_mid` and `score_p50` and has to know they are the same number.
- Consumers who built against `score_p50` keep working, which means the misleading name stays reachable.

**Revisit when**

- A calibrated distribution exists — the same precondition as ADR-005. Then this is superseded by a
  real calibrated interval and the retained aliases can go.

## The wider pattern

This is one of four decisions made for the same reason: **a number that was correct as computed and
misleading as read.** The responses were consistent.

| Number | What it actually was | Response |
|---|---|---|
| `score_p10/p50/p90` | input-coverage width | renamed |
| flood probability | reporting-conditioned co-occurrence | refused at a stated floor ([ADR-005](ADR-005-flood-probability-basis.md)) |
| `false_alert` rate | regex over free-text resolution notes | `null` for "not determined" rather than `0` |
| any return period | unsupported | build-time guard ([ADR-010](ADR-010-build-time-claim-guard.md)) |

The false-alert case is the sharpest. It *"scanned resolution_note for /false|invalid|noop/i and
divided by the number of alerts. On the demo data that returned 0%, which reads as 'no false alerts
occurred' when it means 'nobody happened to write the word false'."* Making it tri-state — with `null`
meaning not determined — is what allows the KPI to report "not yet measurable" instead of a confident
zero. **Null is a legitimate answer and, for an unmeasured thing, the only honest one.**

Related: [ADR-005](ADR-005-flood-probability-basis.md), [ADR-010](ADR-010-build-time-claim-guard.md)