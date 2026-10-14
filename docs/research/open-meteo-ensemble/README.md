# Open-Meteo Ensemble API — wiring the probabilistic forecast

Research for the `open_meteo` connector's ensemble path. The question was whether
the probabilistic forecast that `src/analytics/ensemble.js` exists to summarise
can be fetched from Open-Meteo at all, and what the response actually looks like
if so.

Verified 2026-10-15 against the live endpoint, not inferred from the docs. Every
response shape below was read off a real request.

## Why this matters

`src/connectors/open-meteo.js` reads a deterministic forecast. It used to invent
percentiles from the point value with a spread of
`0.25 + (1 - probability/100) * 0.75`, published under the field names a real
ensemble uses. The flood scorer preferred `ensemble_p90` over the point value, so
the invented coefficient inflated the score before it was even scaled. The
synthesizer was deleted and replaced with an honest `model_limit` string.

`src/analytics/ensemble.js` is the other half: `computeEnsembleStats(values)`
turns an array of member values into `{p10, p50, p90, mean, stddev, count}`, and
`spreadSkillIndex(records)` measures how wide an ensemble is relative to its own
value. Both were written, tested, and unreachable — nothing set `ensemble_source`,
which is the field `src/analytics.js` gates the read path on. So
`drivers.ensemble_used` could never be `true`.

This note settles whether the data exists to make that path live.

## The endpoint

```
https://ensemble-api.open-meteo.com/v1/ensemble
  ?latitude=&longitude=
  &daily=precipitation_sum
  &forecast_days=
  &models=<model id>          # REQUIRED — no default
  &timezone=UTC
```

A **different host** from the deterministic forecast's `api.open-meteo.com`, which
is why it is a second request rather than another parameter on the first.

**`models` is required and has no default.** Omitting it returns an error, not a
best-match:

```json
{"error": true, "reason": "Model 'best_match' is not supported by the Ensemble API. Please select a specific ensemble model."}
```

An unknown model id also errors rather than falling back:

```
Invalid value: Cannot initialize MultiDomains from invalid String value bogus_mo...
```

Both are refusals, which is the behaviour worth having — a connector that silently
got a different model than it asked for would be publishing someone else's
forecast under this one's name.

## Member naming — measured, and it is not a fixed count

Members arrive as **extra keys in the same `daily` object**, suffixed
`_memberNN`, zero-padded to two digits:

```
daily.time
daily.precipitation_sum              <- the control run
daily.precipitation_sum_member01
daily.precipitation_sum_member02
...
```

Measured member counts (2026-10-15, `forecast_days=1`, one location):

| `models=` | members | + control | note |
|---|---|---|---|
| `icon_seamless` | 39 | 40 | |
| `dwd_icon_seamless_eps` | 39 | 40 | alias of the above |
| `gfs_seamless` | 30 | 31 | |
| `ecmwf_ifs025` | 51 | 51 | the 0.25° open-data distribution |
| `ecmwf_ifs04` | 0 | 1 | **control only — no members returned** |

The docs' own model table lists 20/40/31/51/64 members across models, which
matches. **So the member count must be discovered from the response keys, never
assumed.** A parser that hardcoded 51 would silently read 30 for GFS and report a
p10/p90 computed over a truncated ensemble — an error that looks like a slightly
narrower spread, which is the one failure mode this module exists to detect.

**The suffix is `_memberNN`, and a multi-model request appends the model id
after it**: `precipitation_sum_member27_ncep_gefs_seamless`. A regex anchored at
the end (`/_member\d+$/`) matches the single-model form only. This connector
requests one model per call, so the anchored form is correct here; a multi-model
request would need `/_member(\d+)(?:_|$)/`. Requesting one model keeps the
ensemble a single distribution, which is what a percentile of it means.

**The unsuffixed key is the control run, not the ensemble mean.** Checked against
a wet region (`ecmwf_ifs025`, 51 members, 7 days): the plain key equals a member
value exactly on 5 of 7 days and is not within rounding of the mean on any day
(day 6: control 1.1, mean 3.30). So it is one of the members. It is **excluded**
from the percentile computation: including a member twice biases the distribution
toward it, and for a 31-member ensemble that is a 3% weight on a value that is
already represented.

## What the docs do not say, and the measurements that settle it

- **No documented member-suffix convention.** The API docs page says only that the
  endpoint "responds with a JSON hourly weather forecast for 7 days for each
  ensemble member". The naming above is read off the responses.
- **No documented control run.** Nothing on the page names one. The identity
  above is empirical.
- **Cost: "equivalent to 4.0 calls"** — stated on the docs page for an ensemble
  request, against the pricing page's "one API call corresponds to one HTTP API
  request" for the deterministic API. So an ensemble fetch is weighted **4x**.
- **Free tier: 10,000 calls/day, non-commercial.** From the pricing page:
  *"The free API is for non-commercial use, rate-limited to 10,000 calls/day, and
  carries no uptime guarantee."* Ensemble data is also called out as needing the
  Professional plan for *customer* (commercial) use: *"Historical, climate,
  ensemble, and satellite radiation APIs require the Professional API Plan or
  higher."*
- **Licence: CC BY 4.0, attribution required.** *"Open-Meteo relies on open data
  that is licenced under Attribution 4.0 International (CC BY 4.0). This licence
  mandates giving appropriate credit and indicating any modifications made to the
  data."*

## Cost arithmetic for this deployment

Three default regions, one ensemble request each = 3 requests = **12 weighted
calls** per ensemble run. The deterministic forecast already costs 3 calls per
run on a 180-minute cadence. Adding the ensemble takes a run from 3 to 15 calls.

At the 180-minute cadence that is 8 runs/day x 15 = **120 calls/day**, against a
10,000/day limit. The ensemble is affordable on the free tier at this scale, and
the 4x weighting is recorded on the record so that a deployment that widens
`DEFAULT_REGIONS` can see the multiplier it is widening.

## Decision

**Wire it.** The endpoint exists, the response shape is what
`computeEnsembleStats` consumes, and the module that summarises it is already
written and tested. The three uncertainties the research flagged are handled:

1. **Member count** — discovered from the response keys by regex, never assumed.
2. **Cost** — the 4x weighting is published on the record as `ensemble_call_weight`,
   and the fetch is opt-in behind `include_ensemble` so the default run is unchanged.
3. **Attribution** — CC BY 4.0 is added to the connector spec and the registry
   entry, which had no `license` field at all before this.

## Rejected options

- **The `ecmwf_ifs04` model** — returns a control run and zero members, so a
  percentile of it would be a percentile of one number. Rejected as a default;
  the parser handles it correctly (empty member list, `computeEnsembleStats`
  returns all-null) rather than fabricating a spread.
- **Multiple models in one request** — would append the model id to each member
  key and blend two different distributions into one percentile. Rejected: a
  p90 across GFS and ICON is not a p90 of either.
- **Hourly members aggregated to daily here** — the endpoint's `daily` block
  already sums the hourly members, so summing again would double-count. The
  `daily` block is read directly.
- **Assuming the unsuffixed key is the mean** — measured false (above). It is the
  control run.
- **A fixed 51-member read** — wrong for four of the five models measured.

## Sources

Archived beside this note under `sources/`:

- `open-meteo-ensemble-api-docs.txt` — the Ensemble API documentation page,
  retrieved 2026-10-15. Carries the endpoint, the `models` parameter, the model
  member-count table, and the "4.0 calls" weighting statement.
- `open-meteo-pricing.txt` — the pricing page, retrieved 2026-10-15. Carries the
  10,000 calls/day free-tier limit, the non-commercial restriction, the
  Professional-plan requirement for ensemble data, and the CC BY 4.0 attribution
  requirement.
