# Flood Probability: Model Basis

**Status: agreed and implemented (2026-10-02).** The basis below was proposed,
reviewed against live-verified data availability, and approved by the operator:
implement the most functional defensible option. The proposal section is kept
at the bottom as the record of how the choice was made; sections 1–4 describe
what is now running.

---

## 1. The implemented basis: empirical rainfall–flood co-occurrence

Code: `src/flood-probability.js`, trained via
`POST /api/v1/flood-probability/train`, scored via
`GET /api/v1/flood-probability/score`.

The model is empirical and local, not hydrological:

> P( a GDACS-reported flood within 150 km of the district point starting in a
> calendar month | that month's rainfall statistics )

with month-end features:

| Feature | Definition |
|---|---|
| `max_7_day` | largest 7-day precipitation total inside the month (intensity × short duration) |
| `sum_30_day` | trailing 30-day total at month end (saturated-catchment proxy) |
| `sum_90_day` | trailing 90-day total at month end (antecedent wetness) |

A month participates only if its trailing 90-day window is ≥ 90 % populated and
inside the series. Gaps are skipped, never zero-filled.

Two output forms, both required by the basis:

1. **Contingency counts** (the transparent primary): months above a threshold
   (the training 90th percentile per feature), flood months among them,
   conditional probability with a Wilson 95 % interval, and lift over the base
   rate. No coefficients; a reader can redo the arithmetic from the counts.
2. **Fitted logistic regression**, L2-regularised (λ = 1), full 4×4 Newton
   with step-halving on the penalised log-likelihood, features standardised.
   The model card carries coefficients per standardised unit, the intercept,
   λ, training months, flood months, and base rate.

**Validation**: leave-one-year-out. Each held-out year is scored by a model
fitted on the others; the card reports Brier score, Brier score of always
predicting the training base rate, and the skill difference. Refusal when a
fold would be empty.

### Hard refusals — part of the model, not a failure message

- fewer than **60 months** with valid features → no number
- fewer than **5 flood-label months** → no number
- all-one-class samples → no number ("no contrast to fit")
- non-finite feature at scoring time → same-window refusal

Coefficients that look authoritative without a sample are the specific failure
this gate exists to prevent. A district with 34 months returns "only 34 of the
required 60 months available", and the dashboard shows it.

### What the probability honestly means

The labels are *GDACS-reported* floods. The probability is

> P(flood enters the GDACS archive near this district in this calendar month)

which is conditioned on reporting coverage as much as on hydrology. Every
model card and every scored response carries
`what_a_probability_is_not: 'reporting-conditioned: P(flood enters the GDACS
archive), not P(water reaches a given ground elevation)'`.

### Known, accepted residuals

- **Reporting delay / month-boundary events**: a flood's reported start may
  post-date its rains or sit within days of a month boundary. Both land in the
  neighbouring month as attribution noise. A lag window was tested and
  rejected — it double-labelled neighbouring months and inverts the fit.
- **ERA5 tail dryness** (Abel et al. 2024, ~40 % tropical extreme
  underestimation) cuts both ways here: the model never claims return
  periods, so no extrapolated tail exists to bias. Extreme months with
  reported floods are still under-represented relative to physical reality;
  the contingency counts state the empirical relationship that exists in the
  paired record, which is the claim the model makes.
- **Single point** rainfall cannot resolve district-scale drainage or
  orographic variation; stated on every archive record.

---

## 2. Data sources (verified keyless, 2026-10-02)

- **Rainfall**: Open-Meteo ERA5 archive (`archive-api.open-meteo.com`),
  daily `precipitation_sum` back to 1981, one request per district point.
  Connector `open_meteo_archive`.
- **Floods**: GDACS archive event search
  (`gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=&toDate=`),
  flood events 1985 onward. The API caps a full-range query at ~100 events,
  so the connector walks quarter-by-quarter windows; the `eventtype`
  parameter is accepted upstream and ignored, so the flood filter runs in
  our process. Flood `severitydata` is a fill-in zero and stored as null.
  Connector `gdacs_archive`, scoped to Sub-Saharan Africa (same country set
  as the IPC ingestion).

Both are backfill sources (`regular: false`), ingested on demand so that a
default ingestion run never issues a 40-year crawl.

## 3. Endpoints

- `POST /api/v1/flood-probability/train` — fits per pilot district from the
  store (climate_observations carrying `open_meteo_archive` series +
  `hazard_events` from `gdacs`/`gdacs_archive`). Writes models into
  `flood_probability_models`. Returns per-district refusals alongside trained
  models.
- `GET  /api/v1/flood-probability/score?max_7_day&sum_30_day&sum_90_day&region`
  — probability plus the full model card, basis, sample counts, and folds.
  Without a trained model: `scored: false` with the refusal text.
- `GET  /api/v1/flood-probability/models` — the trained models, refusals
  included.

The dashboard strip reads the models endpoint and shows, per district, either
the base rate/skill card or the refusal — a refusal is a fact about the data,
not a widget missing.

## 4. Blocked on this basis, kept for the record

- **MERIT Hydro** catchment delineation: unreachable and EULA-gated → no
  rational method, no terrain-based routing.
- **Gauge-based GEV annual maxima**: no validated 36-year discharge record
  for the pilot basins. Fitting return levels to ERA5 alone was rejected
  (sections 5–6 of the proposal record).
- **Depth mapping from the probability**: the probability is a month-scale,
  district-scale statement. It does not compose with the static flood-depth
  simulator, which needs a supplied water level.

---

## 5. Record of the proposal (2026-10-01, unchanged)

The original proposal recommended Option C (observed-record exceedance only)
with Option A deferred. The live check found something the 2026-10-01 review
missed: **both halves of the rainfall–flood pairing exist keyless with
decades of depth** — not just the rainfall side. That made a fourth option
possible and strictly more useful than C, because it is calibrated against
actual reported floods rather than merely restating the rainfall record:

> **Option D — empirical rain–flood co-occurrence.** Month-grain contingency
> counts plus a fitted, regularised, validated logistic model over the paired
> archive record, with hard refusals on thin samples.

The operator selected option D on the "most functionality, most honesty"
criterion: contingency counts are as transparent as C, the fitted layer
carries sample sizes and out-of-year skill, and every output states its
reporting condition. The original data-availability table and option analysis
follow, with the two live-API findings (quarterly pagination; ignored
`eventtype` parameter; ERA5 tail bias standing) unchanged.

---

# Original proposal text (2026-10-01, retained as research record)

This document exists because rainfall intensity/duration → flood probability
must have an *agreed, documented model basis* before any code is written.
Invented coefficients that look authoritative are worse than no output, so
nothing here was fitted, tuned, or recommended for production without sign-off.

## What we could reach (2026-10-01)

| Input | Reachable? | Evidence (2026-10-01) |
|---|---|---|
| Daily rainfall, 1990–2026 | Yes, keyless | Open-Meteo archive, `archive-api.open-meteo.com`: 13,422 daily values for 3.1 N 35.6 E, 36 complete years |
| Sub-daily rainfall | Partially | `hourly=precipitation` returns hourly points; daily-only by default |
| CHIRPS-2.0 daily | Dates yes, values no | `data.chc.ucsb.edu` serves gzip GeoTIFF per day; our connector reports availability and dates, not pixels |
| SoilGrids (clay, etc.) | Yes, keyless, needs a decoder | `maps.isric.org/mapserv?map=/map/clay.map` WCS `GetCoverage` → tiled deflate GeoTIFF, predictor 2, int16 |
| MERIT Hydro flow paths | **No** | Unreachable and EULA-gated. No catchment delineation |
| scipy / GEV libraries | **No** | Project depends only on `pg`. Any extreme-value fit must be hand-written |

### The problem with the rainfall record

**ERA5 underestimates tropical extremes.** Abel et al. (2024) evaluating ERA5
against 5,637 stations 2001–2020 finds tropical station mean annual-maximum
1-day precipitation of **63.3 mm against 108.1 mm observed** — a ~40 %
underestimate in precisely the region and tail a return-period model cares
about. A GEV fitted to this record would return return levels systematically
too low while looking perfectly well-formed. This finding stands, and is why
no return-period layer ships.

## Candidate approaches as originally stated

- **Option A — Rational method with fitted IDF.** Blocked on MERIT (catchment
  area), a bias-corrected rainfall record, and a GeoTIFF decoder. Still blocked.
- **Option B — Regionalised index-flood.** Degenerates into a made-up
  coefficient without an observed flood catalogue. Rejected then; still rejected.
- **Option C — Observed-record exceedance.** Honest, ships nothing that needs
  a sample. Superseded by option D, whose contingency counts give the same
  transparency calibrated *against floods*.
- **Option D — implemented** (see section 1).

## References

- Abel, B.D. et al. (2024). *An evaluation of ERA5 precipitation for climate
  monitoring.* Quarterly Journal of the Royal Meteorological Society.
  https://doi.org/10.1002/qj.4351
- Open-Meteo ERA5 archive API. https://open-meteo.com/en/docs/archive-api
- GDACS event search API. https://www.gdacs.org/gdacsapi/
- NOAA CPC Niño 3.4 index (context for ENSO-conditioned climatology).
  https://cpc.ncep.noaa.gov/products/analysis_monitoring/enso/oni/v6/
- ISRIC SoilGrids WCS documentation. https://docs.isric.org/globaldata/soilgrids/wcs.html
- UCSB CHC CHIRPS-2.0 daily product index.
  https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/