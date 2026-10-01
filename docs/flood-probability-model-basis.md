# Flood Probability: Model Basis Proposal

**Status: proposal for review. Not implemented, deliberately.**

This document exists because rainfall intensity/duration → flood probability
must have an *agreed, documented model basis* before any code is written.
Invented coefficients that look authoritative are worse than no output, so
nothing here is fitted, tuned, or recommended for production without sign-off.

Reviewed on 2026-10-01. Every availability claim below was checked live on that
date; every limitation is one we could reproduce.

---

## 1. What we can actually reach

| Input | Reachable? | Evidence (2026-10-01) |
|---|---|---|
| Daily rainfall, 1990–2026 | Yes, keyless | Open-Meteo archive, `archive-api.open-meteo.com`: 13,422 daily values for 3.1 N 35.6 E, 36 complete years |
| Sub-daily rainfall | Partially | `hourly=precipitation` returns hourly points; daily-only by default |
| CHIRPS-2.0 daily | Dates yes, values no | `data.chc.ucsb.edu` serves gzip GeoTIFF per day; our connector reports availability and dates, not pixels |
| SoilGrids (clay, etc.) | Yes, keyless, needs a decoder | `maps.isric.org/mapserv?map=/map/clay.map` WCS `GetCoverage` → tiled deflate GeoTIFF, predictor 2, int16 |
| MERIT Hydro flow paths | **No** | Unreachable and EULA-gated. No catchment delineation |
| scipy / GEV libraries | **No** | Project depends only on `pg`. Any extreme-value fit would be hand-written |

### What the rainfall record looks like

Daily precipitation sums, 3.1 N 35.6 E (Lodwar), 1990–2026:

- 36 complete years; 2026 is partial (273 days) and **excluded** — a partial
  year biases its annual maximum low.
- Annual maxima: mean 26.1 mm, sd 5.9 mm, range 12.3–38.8 mm.
- 1,953 wet days (≥1 mm, 14.6%), 41 days ≥25 mm.
- Max 3-day 92.7 mm, max 7-day 165.2 mm.

### The problem with that record

**ERA5 underestimates tropical extremes.** Abel et al. (2024), *Quarterly
Journal of the Royal Meteorological Society*, evaluating ERA5 against 5,637
stations 2001–2020, finds tropical station mean annual-maximum 1-day
precipitation of **63.3 mm against 108.1 mm observed** — and recommends ERA5 be
used mainly for *extratropical* precipitation monitoring.

That is a ~40% underestimate in precisely the region and the tail a flood model
cares about. A GEV fitted to this record would return return levels that are
systematically too low, and would look perfectly well-formed while doing so.

### Second problem: 36 years is the floor, not a comfortable margin

Extreme-value literature commonly treats 30 years as a practical minimum for
GEV parameter estimation and 50+ as preferable. We have exactly 36, from a
source with a documented dry bias in the tail. Parameter uncertainty would be
large enough to matter at the 50- and 100-year return levels — which are the
levels an anticipatory trigger would actually be calibrated against.

---

## 2. Candidate approaches

### Option A — Rational method with a fitted IDF curve

`Q = C·i·A`, with an intensity-duration-frequency curve derived from local
rainfall.

- **Needs:** catchment area `A` (MERIT Hydro — **unavailable**), a runoff
  coefficient `C` per soil class (SoilGrids — reachable, needs a raster
  decoder), and an IDF curve fitted from ≥30 years of *unbiased* rainfall.
- **Blocked on:** the rainfall record. ERA5's tail is not defensible.
- **If taken, the IDF curve would have to come from CHIRPS + gauges**, not
  ERA5. CHIRPS values are not currently decoded by our connector.

### Option B — Regionalised, index-flood approach

Fit a single dimensionless index-flood parameter per region and scale by
catchment characteristics.

- **Needs:** a documented regionalisation method and an observed flood
  catalogue to calibrate against.
- **Blocked on:** we have no observed flood record. GDACS tells us a flood
  happened, not how deep or how large the catchment response was.
- **Without calibration this degenerates into a made-up coefficient.** Rejected
  on that basis.

### Option C — Observed-record exceedance (no fitted model)

Report only statements directly supported by the record:
"the wettest day in 36 years of local record was 38.8 mm (2011)". No
extrapolation, no return periods.

- **Needs:** nothing beyond what we already have.
- **Honest:** every claim is a fact about the record, with its period stated.
- **Weakness:** says nothing about events rarer than 36 years, which is often
  the question being asked.

---

## 3. Recommendation

**Option C now, Option A later if the inputs are secured.**

Option C is defensible from data already in hand and makes no claim the
evidence does not support. It is genuinely useful for triage — "this is
unprecedented in the local record" is a decision-relevant statement that a
fitted but biased curve would undercut.

Option A becomes viable when, and only when:

1. **A rainfall record free of the tropical dry bias** is available — CHIRPS
   values decoded, ideally cross-checked against gauge observations.
2. **A GeoTIFF decoder exists** for CHIRPS and SoilGrids, or a pre-processing
   step produces the derived rasters.
3. **Catchment delineation is available.** MERIT Hydro is EULA-gated; without
   it, `A` is unknown and the rational method cannot be evaluated.
4. **An agreed minimum record length** is set, and the expected parameter
   uncertainty at the return levels of interest is stated up front.

### What we would want before shipping Option A

- A **calibration artefact**, not just coefficients: fitted parameters, their
  standard errors, the goodness-of-fit test used, and a sensitivity analysis
  showing how the 100-year level moves under plausible parameter shifts.
- An **out-of-sample check** — fit on part of the record, predict the rest.
- A **stated bias-correction method** for the rainfall record, with the source
  of the correction documented.
- **Refusal behaviour**: when input coverage or record length falls below the
  agreed floor, the endpoint should decline rather than extrapolate. A number
  returned outside its validated envelope is exactly the failure mode this
  proposal exists to prevent.

---

## 4. Decisions required before implementation

1. **Which option?** Recommendation: C now, A deferred pending inputs.
2. **Minimum record length** before a fit is permitted. Recommendation: 50
   complete years from a bias-corrected source; we currently have 36
   uncorrected.
3. **Whose record?** CHIRPS is gauge-blended and would need decoding. Is a
   gauge-corrected regional product preferable, and does UNICEF have access to
   one?
4. **Catchment delineation.** MERIT Hydro needs an EULA and data access. Is
   there an alternative, or does Option A remain blocked on this alone?
5. **Return levels of interest.** Which T actually drives a trigger? This
   determines whether 50 years is sufficient or the record must be longer.
6. **Scope boundary.** Option C is a statement about rainfall, not a flood
   model. Is it acceptable to expose it as a *rainfall context* signal rather
   than as anything flood-probabilistic? We think the naming must make that
   distinction unmissable.

---

## 5. What is shipped today

- `GET /api/v1/flood-depth` — static inundation from a **supplied** water
  surface elevation. Not a forecast, not probabilistic. Every response carries
  `model: "static water-surface elevation; no flow routing or storage modelled"`
  and `vertical_resolution_m: 15`.
- Risk scores carry `calibrated_uncertainty: false`, and their band fields are
  named `sensitivity_*` because they reflect input coverage, not uncertainty.
- No endpoint returns a flood probability. Nothing in this repository implies
  otherwise.

## References

- Abel, B.D. et al. (2024). *An evaluation of ERA5 precipitation for climate
  monitoring.* Quarterly Journal of the Royal Meteorological Society.
  https://doi.org/10.1002/qj.4351
- NOAA CPC. Niño 3.4 index: threshold and five-overlapping-season episode
  rule. https://cpc.ncep.noaa.gov/products/analysis_monitoring/enso/oni/v6/
- ISRIC SoilGrids WCS documentation. https://docs.isric.org/globaldata/soilgrids/wcs.html
- UCSB CHC CHIRPS-2.0 daily product index.
  https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs/p05/