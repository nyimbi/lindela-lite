# ADR-005: Flood probability is empirical co-occurrence, not hydrology

**Status:** Accepted — agreed and implemented 2026-10-02
**Applies to:** `src/flood-probability.js`, `docs/flood-probability-model-basis.md`
**Deciders:** whoever ships a number to a duty officer

## Context

The product has to answer a question a planner asks before releasing food: *is this district about to
flood?* The natural way to answer it is a hydrological model — return periods, GEV fits on annual
maxima, IDF curves, the rational method.

The data does not support one.

- **No validated discharge record.** A return period needs 30+ years of annual maxima at a gauge. There
  is no such record for the pilot basins.
- **MERIT Hydro is unreachable** and EULA-gated, so the obvious open alternative is not available.
- The reporting data that *does* exist — GDACS — is **reporting-conditioned**. It records floods that
  were reported and entered an archive. It is not a gauge record, and absence from it is not absence of
  flooding.

The uncomfortable consequence is that the model, built honestly, refuses to answer for the districts
it is meant to serve.

## Decision

Compute an **empirical co-occurrence probability**:

> P( a GDACS-reported flood within 150 km of the district point starting in a calendar month | that
> month's rainfall statistics )

Features are month-end summaries: largest 7-day total, trailing 30-day, trailing 90-day. A month
participates only if its 90-day window is at least 90% populated; gaps are skipped, never zero-filled.

Two output forms, both required: contingency counts (months above the training 90th percentile per
feature, flood months among them, Wilson 95% interval, lift over base rate) and a fitted
L2-regularised logistic regression with standardised features. Validation is leave-one-year-out,
reporting Brier, Brier-of-base-rate, and the skill difference.

**The refusals are part of the model, not error paths.** `MIN_MONTHS = 60`, `MIN_EVENTS = 5`,
all-one-class, and a non-finite feature at scoring time each return no number with a stated reason.

### The refusals are expected, not temporary

A full 1985–2026 walk of the GDACS archive retains **93** Sub-Saharan flood events. Matched at 150 km
against the three pilot districts, that is **1 flood-label month for Turkana, 2 for Mogadishu, 0 for
Juba** in 41 years.

Every pilot district therefore refuses at the `MIN_EVENTS` floor. **That refusal is the measured
ceiling of this archive at this radius, not a gap that better data next month would close.** The
dashboard shows the refusal, with its reason, rather than a number.

## Options considered

### Return periods from a fitted GEV distribution

| Dimension | Assessment |
|---|---|
| Familiarity | High — this is what a hydrologist expects to see |
| Data requirement | 36+ years of validated annual maxima per basin |
| Available data | None for the pilot basins |
| Honest? | No — a fit on a short proxy record produces confident-looking coefficients from nothing |

**Rejected.** `flood-probability.js` records the rejection as `rejection_reasons`: *"MERIT Hydro
(unreachable, EULA-gated) and gauge-based GEV annual maxima (no validated 36-year discharge record
for the pilot basins)."*

### IDF curves / the rational method

**Rejected.** These transform rainfall to design intensity over a fixed storm duration — a design
tool for drainage, not a forecast of whether a district floods.

### Ensemble discharge thresholds from GloFAS

**Considered and kept as a second variant.** `MODEL_BASIS_DISCHARGE` labels a month whose maximum
daily GloFAS discharge exceeds that cell's own 95th percentile of monthly maxima. The percentile is
deliberately *not* a fitted parameter. Its `label_caveat` states it measures *"how far point-rain
statistics anticipate basin-scale river response — an anticipation-skill question, not a hydrological
identity."* It carries the same `MIN_EVENTS` floor and the same refusal.

### Return no probability at all

**Rejected**, because the empirical co-occurrence is genuinely informative where the sample supports
it, and because refusing entirely would leave the console with no flood reasoning on a product whose
whole premise is early warning.

## Consequences

**Easier**

- Every number can be explained to a duty officer in one sentence, because it is one sentence.
- Refusals are checkable. A reviewer can recompute the contingency table and see why it stopped.
- The model cannot overreach, because its ceiling is written into the code as a constant.

**Harder**

- The product cannot say "1-in-20-year flood" for the pilot districts, which is the phrasing people
  use. Someone will ask, and the answer is a refusal with a number of months attached.
- The empirical relationship is local. It does not transfer to a district the archive never saw, and
  `MODEL_BASIS.what_a_probability_is_not` says so in the record itself.
- Two variants (rainfall-conditioned and discharge-conditioned) means two things to explain.

**Revisit when**

- A validated gauge record exists for any pilot basin. Then the GEV path is worth re-deriving
  properly, and this ADR should be superseded rather than amended.
- The archive accumulates past `MIN_EVENTS` for a district — roughly another decade at one flood-label
  month per district per decade.

## The guard that keeps this honest

`scripts/check-no-flood-probability.mjs` scans `src`, `public`, `scripts`, `test` and `docs` plus the
README, CHANGELOG and connector registry for `return_period`, `annual_exceedance`,
`flood_return_period`, `inundation_probability` and siblings. Its header says why:

> *"A return-period capability silently appearing in a README would pass every functional test; it must
> not pass the build."*

Two files are exempt, listed explicitly rather than pattern-matched *"so that adding a new document
cannot quietly join the exemption."* The guard is the durable half of this decision — the model is the
half that can be recomputed when better data arrives.

Related: [ADR-004](ADR-004-sensitivity-is-not-a-probability.md), [ADR-010](ADR-010-build-time-claim-guard.md)