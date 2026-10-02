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

### Measured ceiling on real data (2026-10-02)

A full 1985–2026 walk of the GDACS archive retains 93 Sub-Saharan flood
events; matched at 150 km against the three pilot districts, that is exactly
**1 flood-label month for Turkana, 2 for Mogadishu, 0 for Juba** in 41 years.
Every pilot district therefore refuses at the MIN_EVENTS floor, and the
refusal is not a temporary data gap — with this archive and this radius it is
the ceiling. The model surfaces exist and are correct; a trained number for
these districts needs a denser flood signal and is an operator decision, not
a code default. That decision is taken below.

---

## 2a. Amendment (2026-10-02): the discharge label, `glofas_discharge`

The measured ceiling above led to one more live survey of keyless flood
signals (record: `docs/research/flood-label-sources/README.md`). ReliefWeb's
API requires an approved appname and Copernicus EMS rejects automated
requests; the Open-Meteo **flood API**
(`flood-api.open-meteo.com/v1/flood`) works and is keyless — GloFAS v4
modelled daily river discharge, consolidated reanalysis to July 2022,
seamlessly continued by the operational run. Live coverage checks at the
region points in `src/schema.js`: the Turkana point (3.1167, 35.6) sits on
a real reach — non-null daily discharge from 1997-01-01, max 1 431.2 m³/s;
the Juba point (4.8594, 31.5713) is on the White Nile with a dense record;
the Mogadishu point (2.0469, 45.3182) has **no reach** — every daily value
null across 15 616 days. (A first probe of "Juba" was later found to have
used a wrong coordinate 1°+ off the region point and read a near-dry cell;
the region point itself is dense.)

So the implemented basis gains a second, documented label. The features, the
month grain, the coverage gates, the contingency layer, the logistic fit,
and the LOYO validation are all unchanged. What changes is the label:

> **`glofas_discharge` label** — a calendar month is a flood month when the
> maximum daily GloFAS discharge at the district's river cell is above that
> cell's **95th percentile of monthly maxima**. The percentile is a fixed
> definition, deliberately not a fitted parameter, and is computed from the
> discharge record alone so it cannot leak into the fit.

and therefore the probability's meaning:

> P(the GloFAS reanalysis shows a flood-level discharge month at the reach |
> that month's rainfall statistics)

**`MODEL_BASIS_DISCHARGE.label_caveat`** (on every discharge model card):
the label is modelled hydrology forced by reanalysis rainfall over the whole
upstream basin, while the features are point rainfall statistics. The fit
measures how far point-rain statistics *anticipate* basin-scale river
response — an anticipation-skill question, not a hydrological identity — and
no gauge record exists at these cells to validate the label itself.

A month joins the sample only when both gates pass: the trailing 90-day
rainfall coverage gate **and** ≥ 90 % discharge coverage in the month at the
reach. A month with absent discharge is skipped, never labelled dry —
absence is not zero flow.

Code: `buildDistrictSamplesFromDischarge` in `src/flood-probability.js`;
connector `open_meteo_flood` (same backfill policy — `regular: false`, on
demand). Trained via
`POST /api/v1/flood-probability/train` with body `{ "label_source":
"glofas_discharge" }`. Model records carry `label_source` (`gdacs_archive`
or `glofas_discharge`) and, for the discharge variant, a `discharge` block
with the threshold (m³/s), its percentile, and the reach's coverage facts.

### Measured outcome of the amendment (2026-10-02, live run)

- **Turkana** (Turkwell/Kerio reach, daily discharge non-null from
  1997-01-01): trains. 357 months kept, 17 flood-months (threshold 994.4
  m³/s at p95 over 358 months), base rate 0.0476. **Leave-one-year-out
  skill over base rate: −0.038** (Brier 0.0471 vs 0.0454 for the base
  rate) — the fitted layer does not beat always predicting the base rate.
  Contingency counts, the primary layer: `sum_90_day` above-threshold lift
  **1.8** (p 0.086, Wilson [0.030, 0.224]), while `max_7_day` and
  `sum_30_day` lift **0.6** — *below* 1: locally intense point rain is,
  if anything, rarer in flood-level months at this reach.
- **Juba** (White Nile reach at 4.8594, 31.5713): trains. 357 months, 17
  flood-months (threshold 6 728.8 m³/s at p95), base 0.0476, **skill
  −0.036**; per-feature lifts 0.6–1.2.
- **Mogadishu** (2.0469, 45.3182): no GloFAS river reach in 15 616 days →
  the connector refuses the region as an ingestion error and training
  refuses it as "no open_meteo_flood discharge series in the store".

The honest reading, which every trained card carries by its numbers: at
these districts, month-grain point-rainfall statistics **do not anticipate**
GloFAS flood-level discharge months better than the base rate. That is a
measured property of the point-to-reach relationship (flashy upland systems
and a basin-scale label), not a defect in the machinery — the contingency
counts are the empirical statement of what the pairing supports, and the
same machinery will score any district where that relationship is stronger.
No number is hidden and no number is inflated: the negative skill ships on
the card where the operator can see it.

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