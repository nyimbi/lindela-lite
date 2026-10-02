# Research: keyless flood-label sources for flood-probability training

**Date: 2026-10-02.** Question: the agreed empirical model
(`docs/flood-probability-model-basis.md`) trains on GDACS-reported floods,
but a full 1985–2026 archive walk leaves only 0–2 flood-label months per
pilot district — every district refuses at the MIN_EVENTS = 5 floor. Is
there a denser, still-keyless flood signal?

## Sources surveyed live

| Source | Keyless? | Verdict | Evidence |
|---|---|---|---|
| GDACS archive (implemented) | yes | too sparse at pilot districts | 1985–2026 walk → 93 SSA floods → 1/2/0 label months within 150 km of Turkana/Mogadishu/Juba |
| **Open-Meteo flood API — GloFAS v4 river discharge** | yes | **adopted** | `flood-api.open-meteo.com/v1/flood?latitude=&longitude=&start_date=&end_date=&daily=river_discharge`; consolidated reanalysis to July 2022, continued by the operational run |
| ReliefWeb v2 reports API | no | blocked | HTTP 403: "You are not using an approved appname" — registration required, unreviewed |
| Copernicus EMS activations | no | blocked | HTTP 403 WAF ("Request Rejected") on all activation-list endpoints |
| CHIRPS rain → own flood detection | yes | rejected (no label) | rainfall alone cannot label floods without a hydrological or reporting component |

## GloFAS v4 discharge — live measurements (2026-10-02, region points from `src/schema.js`)

- **Turkana** (3.1167, 35.6): non-null daily discharge from 1997-01-01;
  10 867 valid days; max 1 431.2 m³/s. Real reach.
- **Juba** (4.8594, 31.5713): dense record; p95 of monthly maxima 6 728.8
  m³/s. White Nile reach. *Process note: an earlier probe at 8.3272,
  30.0167 — which is not the region point — read a near-dry cell (max
  0.19, all values ≤ 0.19) and a "no reach in the neighbourhood" verdict
  was drawn from it plus a ±0.2–1° dry-season sweep (max 2.03 m³/s).
  Wrong coordinate, wrong verdict: low dry-season flow is not absence of a
  reach. Always verify against the region point the model will actually
  use.*
- **Mogadishu** (2.0469, 45.3182): no reach — null across all 15 616 days.

## Decision

Adopted: **discharge-month label (`glofas_discharge`)**, implemented in
`src/flood-probability.js` (`buildDistrictSamplesFromDischarge`) and fed by
the new `open_meteo_flood` backfill connector. A month is a flood month when
its maximum daily GloFAS discharge exceeds that cell's 95th percentile of
monthly maxima — a fixed definition, not a fitted parameter, computed from
the discharge record alone (no leakage into the fit). Features, month grain,
coverage gates, contingency layer, logistic fit, LOYO validation: unchanged.
Documented as an amendment to the basis; every model card carries the
`label_caveat` that the label is model-conditioned hydrology.

**Measured result of the adoption (honest bottom line):** the label is
dense enough to train (Turkana and Juba: 357 months, 17 flood-months,
base rate 0.0476) but month-grain **point-rain statistics do not anticipate
it better than the base rate** — LOYO skill −0.038 (Turkana) and −0.036
(Juba); per-feature lifts 0.6–1.8. The numbers ship as measured, on the
card, not tuned away. Interpretation: a district point's rain is a weak
proxy for basin-scale river response; districts pairing a point with the
reach that its rain actually drives would need reach-matched points (an
operator data decision, recorded here as the follow-up).

## Rejected options and why

- **Widening the GDACS match radius** past 150 km: label becomes
  region-scale noise at month grain; documented radius stays.
- **ReliefWeb as an event source**: requires appname registration; revisit
  only if an operator registers.
- **Copernicus EMS activations**: 403 on automation; blocked.
- **GloFAS forecast feed for labels**: forecasts are not observations; the
  reanalysis reanalysis-consolidated record is the label, the operational
  continuation is coverage, the `glofas` (broken RSS) connector is a
  separate, unlifted blockage.

## Sources

- Open-Meteo flood API docs: https://open-meteo.com/en/docs/flood-api
- GloFAS v4 (Copernicus Emergency Management / CEMS global flood awareness):
  https://global-flood-database.ecmwf.int (context) — discharge accessed via
  Open-Meteo above.
- ReliefWeb API appname requirement:
  https://apidoc.reliefweb.int/parameters#appname
- GDACS archive API (implemented earlier):
  https://www.gdacs.org/gdacsapi/