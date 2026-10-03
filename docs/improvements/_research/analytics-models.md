# Analytical and modelling core — audit

Scope: `src/flood-probability.js`, `src/flood-depth.js`, `src/terrain.js`,
`src/road-access.js`, `src/analytics.js`, `src/analytics/{downscaling,ensemble,impact}.js`,
`src/kpi.js`, `src/alerts.js`, `src/equity.js`, `src/scenarios.js`, `src/districts.js`,
`src/parametric.js`, `docs/flood-probability-model-basis.md`,
`docs/architecture/analytics-and-alerts.md`, `docs/data-model.md`,
`test/{flood-bands,seasonal,map-frame}.test.js`.

The project constraint holds in the code that matters. `flood-probability.js` refuses
below `MIN_MONTHS`/`MIN_EVENTS`, ships counts alongside coefficients, carries a Wilson
interval, carries `what_a_probability_is_not`, and ships measured negative skill
(−0.038 on Turkana) rather than hiding it. `alerts.js:determination()` rejects
`"maybe"` rather than coercing it to `false`. `kpi.js` returns `null` for an
underdetermined false-alert rate. `scripts/check-no-flood-probability.mjs` scans docs
and public surfaces, not just `.js`. The defects below are therefore mostly places
where *one* surface kept the old behaviour after the fix landed elsewhere, or where a
guard exists on one entry point and not its sibling. Several are the exact defect
classes the repo already documents elsewhere and then failed to finish applying.

---

## Defects

### D1 — The discharge-label threshold is computed over the held-out year, so LOYO validates against its own test set

**Severity: High**

`src/flood-probability.js:258`

```js
const thresholdCms = quantile(monthlyDischarge.maxima.map((m) => m.max).sort((a, b) => a - b), percentile)
```

`monthlyDischarge.maxima` covers every month in the discharge record. `buildDistrictSamplesFromDischarge`
bakes `label: monthly.max > thresholdCms` into each sample (`:272`), and
`trainDistrictModels` then calls `leaveOneYearOut(samples)` on those already-labelled
samples (`:617`). When the loop at `:496` holds out year *Y*, the label of every month in
*Y* was decided by a threshold whose 95th-percentile value was computed with *Y* in the
distribution.

`docs/flood-probability-model-basis.md:142` claims the opposite:

> The percentile is a fixed definition, deliberately not a fitted parameter, and is
> computed from the discharge record alone so it cannot leak into the fit.

The "cannot leak into the fit" half is true and is the point of the design. It does leak
into the *validation*, which is where the claim about held-out skill lives. The measured
Turkana/Juba skill figures (−0.038, −0.036) are therefore optimistic by an unknown
amount — the effect is small when the 95th percentile of 358 months is insensitive to
twelve of them, but it is not zero, and it is not measured.

**Failure scenario:** a district with a rising discharge trend (operational GloFAS runs
continuing the reanalysis, per `MODEL_BASIS_DISCHARGE.flood_source`) gets a threshold
dragged up by the most recent years. Months in held-out years are then labelled false by
a criterion those months helped set, the fold looks easier, and `skill_over_base_rate`
reads less negative than the honest out-of-sample value. The whole point of the
discharge amendment was that measured negative skill is the finding.

**Fix:** thread the fold boundary into sample construction. Give
`leaveOneYearOut` an option to receive raw monthly discharge maxima, recompute
`thresholdCms` from the training years only, and re-derive the held-out year's labels
inside the loop. Concretely: split `buildDistrictSamplesFromDischarge` so it can return
`samples` plus `monthlyDischarge.maxima`, add a `labelSamplesFromDischarge(trainMaxima, holdoutSamples)`
that rethresholds, and have `trainDistrictModels` call a `leaveOneYearOutDischarge`
variant that does this per fold. The full-sample threshold stays for the shipped model
card — that is legitimate, because the shipped card is descriptive of the whole record.
Also correct `label_caveat` in `MODEL_BASIS_DISCHARGE` to say the threshold is
re-estimated per fold during validation.

---

### D2 — The contingency layer emits a conditional probability from 10 months while the fitted layer refuses below 60

**Severity: High**

`src/flood-probability.js:291-298`

```js
const values = samples.map((s) => s[feature]).filter(Number.isFinite).sort((a, b) => a - b)
if (values.length < 10) {
  return { counts: null, reason: `fewer than 10 months with a finite ${feature}` }
}
const threshold = quantile(values, percentile)
const above = samples.filter((s) => s[feature] > threshold)
const positives = above.filter((s) => s.label).length
const wilson = wilsonInterval(positives, above.length)
```

`MIN_MONTHS = 60` (`:49`) gates the logistic fit. `MIN_EVENTS = 5` (`:50`) gates the
positive count. The contingency layer — which `docs/flood-probability-model-basis.md:36`
calls "the transparent primary" — gates at **ten months and zero events**. A district with
14 months and 2 flood months produces a card entry like
`{ months_above_threshold: 3, flood_months_above_threshold: 1, conditional_probability: 0.3333 }`
with no refusal anywhere, sitting next to a refusal string that says the same district has
insufficient data.

The basis document (`:49-58`) presents hard refusals as "part of the model, not a failure
message". They are applied to one of the two required output forms and not the other.

**Failure scenario:** the contingency table is the layer an operator reads first, because
it needs no coefficients. A district with a 15-month archive and one reported flood
displays "P = 33%" with a Wilson interval of [0.06, 0.79] that no one reads to the
bottom. The fitted layer refuses on the identical sample and the refusal is what the
dashboard shows.

**Fix:** gate `contingencyCount` on `MIN_MONTHS` and on `MIN_EVENTS` positives in the
whole sample, returning the same `{ counts: null, reason }` shape the fit uses. If a
10-month table is wanted for diagnostics, expose it under a different key
(`contingency_diagnostic`) with `sample_sufficient: false` stamped on it.

---

### D3 — `conditional_probability` reports a confident `0` when zero months sit above the threshold

**Severity: Medium**

`src/flood-probability.js:307-308`

```js
conditional_probability: round4(positives / Math.max(1, above.length)),
conditional_probability_wilson: wilson,
```

`Math.max(1, above.length)` turns a zero denominator into `0 / 1 = 0`. The Wilson helper
correctly returns `null` for `total === 0` (`:333`, `if (!total) return null`), so the
payload reads `conditional_probability: 0, conditional_probability_wilson: null` — a hard
zero with the uncertainty field that would have flagged it blanked out.

This is reachable. `threshold` is the value at index `floor(0.9 * n)`, and `above` uses a
**strict** `>`. Features are rounded to 0.1 mm at `:171-173`
(`Math.round(max7 * 10) / 10`), so ties are common in dry districts where most months
round to 0.0. A sample where the 90th-percentile value is the maximum observed value
gives `above.length === 0`.

`lift_over_base_rate` (`:309`) divides by `above.length` unguarded and returns `0` for the
same reason.

**Failure scenario:** an operator reads "conditional probability 0" off a dry-district
card and concludes rainfall does not cause flooding here — when the truthful statement is
"no month in a 200-month record exceeded the threshold, so the conditional is undefined".

**Fix:** when `above.length === 0`, return `conditional_probability: null`,
`lift_over_base_rate: null`, and add `months_above_threshold: 0` alongside a
`reason: 'no month exceeds the 90th-percentile threshold in this sample'`. Replace the
`Math.max(1, ...)` with an explicit branch.

---

### D4 — LOYO silently drops folds whose training subset refuses, biasing the validated sample toward easy years

**Severity: Medium**

`src/flood-probability.js:498-505`

```js
const train = samples.filter((s) => s.month.slice(0, 4) !== year)
const test = samples.filter((s) => s.month.slice(0, 4) === year)
const { model } = fitLogisticRegression(train, options)
if (!model) continue
for (const s of test) {
```

`continue` drops the fold. `fitLogisticRegression` refuses when the training subset has
fewer than `MIN_EVENTS` positives, so any fold that removes the district's flood months
— precisely the extreme years — is discarded. `n_folds` and `validated_months` report the
survivors (`:516-517`), and `trainDistrictModels` stores only the survivors. Nothing
records which years were dropped or why.

**Failure scenario:** a district with exactly 5 flood-label months, all in one wet year,
trains (5 ≥ `MIN_EVENTS`). LOYO holds out that year, the training subset has 4 positives
and refuses, the fold is skipped. `folds` reports `validated_months: 348, n_folds: 30` —
a Brier score over 348 months with the hardest 12 excluded, presented as the validation.

**Fix:** record skipped folds explicitly
(`skipped_folds: [{ year, reason }]`), and refuse the whole validation when any fold is
skipped, rather than reporting a skill number over a self-selected subset. Cheaper
alternative that keeps the number: report `skill_over_base_rate` alongside
`folds_retained / folds_total` and add to `metadata.model_limit` that the skill covers
only the retained folds.

---

### D5 — `GET /flood-probability/score` without `region` scores whichever district was trained most recently

**Severity: High**

`src/server.js:559-566`

```js
const models = (data.flood_probability_models || [])
  .filter((m) => m.model)
  .sort((a, b) => Date.parse(b.trained_at) - Date.parse(a.trained_at))
const latest = region
  ? models.find((m) => String(m.region_name).toUpperCase() === region.toUpperCase())
  : models[0]
```

`region` is optional. Omit it and the response is Turkana's model, whatever the caller
meant. The response *does* echo `region_name: latest.region_name` (`:583`), so the
mismatch is discoverable — but only by reading the payload, and the request that produced
it looked region-scoped.

**Failure scenario:** an integrator reads the endpoint as documented at
`docs/flood-probability-model-basis.md:205` (`?max_7_day&sum_30_day&sum_90_day&region`),
omits `region` because the URL example is truncated in some client library's docs, and
receives a probability for a district they are not working in, labelled with that
district's name. Nothing in the payload says the region was inferred.

**Fix:** make `region` required and return 400 with the list of trained regions
otherwise. If a default is wanted for the dashboard, keep it in the dashboard. Add
`region_source: 'query' | 'inferred'` to the payload in any case, so an inferred region
is visible rather than silent.

---

### D6 — The scored probability ships as a bare number: no interval, no n, no contingency

**Severity: High**

`src/server.js:579-595`

```js
const probability = predict(latest.model, features)
...
data: {
  region_name: latest.region_name,
  probability,
  features,
  trained_at: latest.trained_at,
  model: latest.model,
  folds: latest.folds,
  basis: latest.basis,
```

`months_kept` and `events_matched` are present. `flood_months` and `contingency` are not.
There is no interval of any kind on the point estimate — the contingency table carries a
Wilson interval but only for the fixed 90th-percentile thresholds, not for an arbitrary
scored feature vector.

This is the project's central tension. `MODEL_BASIS.what_a_probability_is_not` and the
whole basis document go to real lengths to say what the number is not, and then the
operational endpoint — the one an integration actually calls — returns `probability:
0.086` as the headline field. Every number in `flood_probability.js` is
better-footed than this, because the model card next to it carries counts. A caller who
stores `probability` in their own database stores the number without the card.

**Fix:** add an approximate interval on the score. Fit the standard errors from the
inverse Hessian already available inside `fitLogisticRegression` (the `H` at `:395` is
`X'WX + λI`; its inverse diagonal gives per-coefficient SEs on the logit scale), store
them on the card, and return `probability_interval` via a delta-method or profile
transform on the logit. State plainly in the payload that it is a *model* interval
conditional on the training sample and carries none of the reporting-coverage or
datum uncertainty, which is the dominant term and is not quantifiable from inside the
model. Also return `contingency` and `flood_months` in the score response.

---

### D7 — `predict` saturates to exactly 0 or 1 with no clamp, so an extrapolation returns a certainty

**Severity: Medium**

`src/flood-probability.js:522-530`

```js
export function predict(model, features) {
  let z = model.intercept
  for (const st of model.standardization) {
    const value = features[st.feature]
    if (!Number.isFinite(value)) return null
    z += model.coefficients.find((c) => c.feature === st.feature)?.value * ((value - st.mean) / st.sd)
  }
  return round4(1 / (1 + Math.exp(-z)))
}
```

At `z = −800`, `Math.exp(800)` is `Infinity`, `p = 1/(1+Infinity) = 0`, and `round4` keeps
it. At `z = +800`, `p = 1`. The only non-finite guard is on the feature, not on `z`. There
is no check that the query vector is inside the training range either — `sum_90_day` of
5 000 mm at a district whose training maximum was 900 mm is a 5.5-sigma extrapolation
that returns whatever the linear term gives.

**Failure scenario:** a caller sends a fabricated or unit-confused feature (mm vs inches,
a seasonal total where a trailing 30-day total was trained) and receives `probability: 0`
or `probability: 1` — the two values that read most authoritatively — from a model whose
documented refusal philosophy is "coefficients that look authoritative without a sample
are the failure this gate exists to prevent."

**Fix:** (a) return `null` when `Math.abs(z) > 30`, with the reason recorded; (b) compare
each query feature against the training min/max carried on the card and return
`extrapolated: true` plus a per-feature flag when outside; (c) floor the returned
probability at something like 1e-6 so a returned number is never a hard zero.

---

### D8 — Serially correlated months are counted as independent in both the Wilson interval and the Brier score

**Severity: Medium**

`src/flood-probability.js:332-340` and `:509-515`

The sample is monthly, and the features are overlapping trailing windows: `sum_90_day` at
month *t* shares 60 of its 90 days with `sum_90_day` at month *t−1*. Labels cluster too —
a flood season produces consecutive positive months. The Wilson interval at `:338`
derives from a binomial with `total` independent trials, and the Brier score at `:509`
weights every month equally.

Effective *n* is therefore smaller than `months_above_threshold`, and the Wilson interval
is narrower than the truth by roughly `sqrt(1 + 2Σρ)`. For a monthly series with 90-day
overlapping windows, the lag-1 autocorrelation of `sum_90_day` is typically 0.7–0.9, which
is a factor of ~1.4–1.6 on the interval width.

**Failure scenario:** `docs/flood-probability-model-basis.md:177` publishes Turkana's
`sum_90_day` contingency as `p 0.086, Wilson [0.030, 0.224]`. The true interval is wider.
The measured lift of 1.8 is real; its stated precision is not.

**Fix:** state the assumption rather than silently making it. Add to the contingency
object an `independence_assumption: 'months treated as independent trials; overlapping 90-day windows and clustered flood months make effective n smaller than months_above_threshold'`, and widen using an effective-sample-size factor
`n_eff = n / (1 + 2Σρ_k)` estimated from the lag-1..3 autocorrelations of the feature
across the sample. `wilsonInterval` gains an optional `effectiveTotal`. Same note on the
Brier skill block.

---

### D9 — The retired `false_alert` keyword scan still runs in `equity.js` and `districts.js`

**Severity: High**

`src/equity.js:43-49`

```js
// False positive = resolved with false/invalid/noop note
if (
  alert.status === 'resolved' &&
  alert.resolution_note &&
  /false|invalid|noop/i.test(alert.resolution_note)
) {
  row.false_positive += 1
}
```

`src/districts.js:107-109`

```js
const falseAlerts = alertEvents.filter(a => a.resolution_note && /false|invalid|noop/i.test(a.resolution_note))
const false_alert_rate = alertEvents.length
  ? (100 * falseAlerts.length) / alertEvents.length : null
```

`src/kpi.js:171-189` deleted this exact pattern, and `src/alerts.js:41-53` documents at
length why: "On the demo data that returned 0%, which reads as 'no false alerts occurred'
when it means 'nobody happened to write the word false'." Neither `equity.js` nor
`districts.js` reads the `false_alert` field that the fix introduced.

This is the worst version of the bug because the three surfaces disagree on one screen.
`GET /api/v1/kpi` returns `false_alert_rate: null` with a `data_gaps` entry; the district
panel for the same quarter returns `false_alert_rate: 0`. Same metric, two numbers, one of
which is a confident zero that nobody determined.

**Failure scenario:** the district overview card shows "0% false alerts" next to the KPI
tile's "not yet measurable". An operator who reads the district card concludes the alerting
is precise. Nothing has been determined.

**Fix:** both call sites switch to
`alert.false_alert !== null && alert.false_alert !== undefined` as the filter, return
`null` when the determined set is empty, and carry the determined/total pair alongside —
the same shape `kpi.js:249-251` uses. In `districts.js` the `kpi_snapshot` block should
carry `false_alert_determined` and `false_alert_of_total` so the denominator travels with
the number. Ideally the four sites share one helper, since this has now been
re-implemented wrongly twice.

---

### D10 — `equity.js` `accuracy_pct` divides a population by a different population

**Severity: High**

`src/equity.js:57-61`

```js
const accuracy_pct =
  row.dispatched > 0
    ? (100 * (row.dispatched - row.false_positive)) / row.dispatched
    : null
```

`dispatched` counts alert events that had a matching dispatch. `false_positive` counts
alert events that were resolved with a keyword in the note. **These are different
subsets.** An alert resolved as false *without* a dispatch subtracts from a count it was
never in, driving `accuracy_pct` below zero. An alert dispatched but not resolved
contributes positively whether or not it was warranted.

The resulting number has no interpretation: it is not precision (no true negatives), not
recall (no denominator of alerts that should have dispatched), and not accuracy (the
labels are not outcomes). `detectAccuracyBreaches` (`:77-82`) then opens an
`equity_audit_action` workflow for any district below 80 — an operational action driven by
a number that is not measuring what its name says.

**Failure scenario:** a district with 10 dispatched alerts, 3 of which were resolved with
"no flood confirmed, invalid report", reports `accuracy_pct: 70`, trips the 80% breach
threshold, and spawns an equity audit workflow. The audit finds nothing, because there was
nothing to find — the district has no coverage problem.

**Fix:** the metric needs a real outcome definition before it drives an action. The
minimum honest version: `precision = 1 - false_positive / dispatched_of_resolved`, with
`dispatched_of_resolved` as the denominator, `null` when no alert in the district has been
both dispatched and resolved, and the sample size carried in the payload. Until an outcome
protocol exists, `detectAccuracyBreaches` should refuse to fire on a metric the project
has not defined — or the name should change to whatever it actually counts.

---

### D11 — District overview silently truncates to 30 records and reports the truncated count as the total

**Severity: High**

`src/districts.js:73-74`

```js
const fieldReports = filterForDistrict(district, data.field_reports || []).slice(0, 30)
const alertEvents = filterForDistrict(district, data.alert_events || []).slice(0, 30)
```

Both are then reported as truth at `:135-136` and fed to `false_alert_rate` at `:108`.

```js
counts: { ..., field_reports: fieldReports.length, alert_events: alertEvents.length, ... }
```

`filterForDistrict` preserves store order, so `.slice(0, 30)` takes the first 30
inserted, not the 30 most recent and not a sample. A district with 400 alerts reports
`alert_events: 30`. And `false_alert_rate`'s denominator is that truncated 30, while the
numerator is a keyword scan over the same 30 — so the rate is computed over an arbitrary
prefix and reported as a district rate. `people_reached` (`:93`) is safe because it derives
from `data.rapidpro_dispatches` unfiltered.

**Failure scenario:** Turkana accumulates 250 alerts over the quarter. The overview says
`alert_events: 30`, `false_alert_rate: 0%`. Nothing in the payload indicates truncation.

**Fix:** separate count from display. `filterForDistrict(...)` for the count,
`.slice(0, 30)` only for the returned array, plus `field_reports_truncated: true` and
`alert_events_truncated: <full count>` on the payload. Better still, sort before slicing
and say what the ordering is.

---

### D12 — `computeFacilitiesAtRisk` counts a facility once per nearby hazard

**Severity: High**

`src/analytics/impact.js:53-75`

```js
for (const hazard of data.hazard_events || []) {
  ...
  for (const asset of data.service_assets || []) {
    const distance = haversineKm(hazard, asset)
    if (distance <= 25) {
      ...
      entry.at_risk_count += 1
      if (hazard.severity === 'high' || hazard.severity === 'critical') entry.high_severity_count += 1
      entry.total_population_served += Number(asset.population_served || asset.beneficiaries || 0)
```

The loops nest hazards outside assets with no dedup on asset identity. A health centre
within 25 km of five hazard events increments `at_risk_count` five times and adds its
`population_served` five times. `at_risk_count` is the field name; nothing says
"facility-hazard pairs".

`computePopulationAtRisk` in the same file gets this right — it keys by hazard and
accumulates within the hazard loop — which is why the two sibling functions in one 79-line
file disagree about what a count is.

**Failure scenario:** a district with one facility served by a regional hospital and
crossed by four hazard polygons reports `at_risk_count: 5` for one building, and
`total_population_served` inflated fourfold. Any humanitarian planning that sums
`total_population_served` across service types over-allocates by the mean hazard overlap.

**Fix:** build a `Set` of asset ids per service type first, count distinct assets, and
either sum `population_served` once per asset or rename the field to
`facility_hazard_pairs` and add `distinct_facilities` beside it. `high_severity_count`
should mean "facilities with at least one high/critical hazard within 25 km", which needs
the same dedup.

---

### D13 — `backtestTriggerProtocol` is not a backtest of the protocol: it ignores the metric, the threshold and the scope, and its `recall` is not a recall

**Severity: High**

`src/alerts.js:163-199`

```js
const leadTimeMs = (protocol.lead_time_days || 3) * 24 * 60 * 60 * 1000
...
const matchedEvents = hazardEvents.filter((event) => {
  if (!event.occurred_at) return false
  const eventDate = new Date(event.occurred_at).getTime()
  return eventDate > runDate && eventDate <= runDate + leadTimeMs
})
if (matchedEvents.length > 0) { truePositives++ } else { falsePositives++ }
...
misses = samples - truePositives - falsePositives
```

`protocol.metric`, `protocol.operator` and `protocol.threshold` are never read. The
function counts "did *any* hazard event anywhere occur in the 3 days after *any* source
run". That is a property of the ingestion schedule and the hazard archive, not of the
protocol. `protocol.scope` is likewise unread (`:152` stores it via
`normalizeTriggerProtocol`).

`misses` is identically zero — every iteration increments exactly one of TP/FP — so
`recall = TP/(TP+0) = TP/samples = precision`, always. `docs/architecture/analytics-and-alerts.md:475-497`
documents both of these and files them under "Unresolved"; the code is unchanged since.

**Failure scenario:** a district-scoped trigger protocol for Turkana with
`threshold: flood_risk >= 80` is backtested against every source run in the system and
every hazard event worldwide. A run in Somalia followed by any hazard anywhere within
three days counts as a true positive. The protocol would be reported as well-tuned; it
was never evaluated.

**Fix:** two changes. (1) Compute the metric against the same `context` shape
`evaluateInShadowMode` uses, at each run's timestamp, restricted to `protocol.scope`, and
only count runs where `would_fire` is true. (2) Give recall a real complement: a window
in which the protocol would have fired and nothing followed. If the intent is
precision-only, delete the `recall` field rather than shipping a number that is
arithmetically identical to precision. Add `scope_applied: true|false` to the response so
a caller can see which of the two ran.

---

### D14 — `backtestTriggerProtocol` returns `precision: 0, recall: 0` when there is no data

**Severity: Medium**

`src/alerts.js:166-168`

```js
if (!sourceRuns.length || !hazardEvents.length) {
  return { samples: 0, true_positives: 0, false_positives: 0, misses: 0, precision: 0, recall: 0 }
}
```

Zero samples with a zero precision. `kpi.js:184-186` gets this right for the false-alert
rate — `null` with a `data_gaps` entry — and `computeDistrictOverview` gets it right for
`feeding_repositioning_rate` (`:99-100`). The backtest is the one place in the analytics
surface that reports a hard zero where the honest answer is "not measurable".

**Fix:** return `{ samples: 0, precision: null, recall: null, reason: 'no source runs or
no hazard events in the store; nothing to score' }`.

---

### D15 — Road access never filters on `occurred_at`, so a decade-old archive flood closes a road today

**Severity: High**

`src/road-access.js:119-134`

```js
function blockingHazards(data) {
  return (data.hazard_events || [])
    .filter((hazard) => ACCESS_BLOCKING_HAZARDS.includes(hazard.event_type))
    .filter((hazard) => Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude) || hazard.bbox)
    .map((hazard) => ({
      ...
      occurred_at: hazard.occurred_at || null,
    }))
}
```

`occurred_at` is mapped at `:132` and never read again — confirmed, it appears nowhere
else in the file. `computeRoadAccess` iterates `data.hazard_events`, which after the
`gdacs_archive` backfill contains floods from 1985 onward. The module docstring says "A
hazard obstructs a road when..." in the present tense and the output field is
`access_status` with a `generated_at` of now.

**Failure scenario:** an operator runs the `gdacs_archive` backfill (a documented,
supported operation — `docs/flood-probability-model-basis.md:92-103`) and then refreshes
analytics. Every road within 2 km of a 2011 flood event flips to `impassable` with
`access_reason: "Blocked by flood (green): <2011 title>"`. `summarizeRoadAccess` reports a
`cut_off_rate_pct` computed over the union of live and historical hazards. Nothing in the
payload carries a date.

**Fix:** filter on recency — an `options.maxAgeDays` (default something like 7, since
`hazard_events` carries live GDACS alerts with `from`/`to`), and carry `occurred_at` and
`hazard_age_days` on each obstruction so a consumer can see why it blocked. Add a
`basis: 'live hazards only; N historical events in store excluded by the recency gate'`
line to `summarizeRoadAccess` so the denominator is stated.

---

### D16 — Road passability has no elevation or depth input; it is a two-module disconnection, not a model

**Severity: High**

`src/road-access.js:139-183`

```js
function obstructionFor(road, hazard, radiusKm) {
  const roadPoint = { latitude: road.latitude, longitude: road.longitude }
  if (hazard.bbox && pointInBbox(roadPoint, hazard.bbox)) { ... }
  if (Number.isFinite(hazard.latitude) && Number.isFinite(hazard.longitude)) {
    const distanceKm = haversineKm(roadPoint, { latitude: hazard.latitude, longitude: hazard.longitude })
    if (distanceKm <= radiusKm) return buildObstruction(hazard, distanceKm, 'proximity', roadPoint)
  }
```

The only road attribute consulted is its point. No DEM sample, no depth, no water level.
The repository *has* all three (`terrain.js`, `flood-depth.js`, `depthPassability` at
`flood-depth.js:117`) and `refreshAnalytics` calls `computeRoadAccess` in the same pass
(`analytics.js:20`), but the two never meet.

**Failure scenario:** a road on the levee crest 3 m above a floodplain, and a road on the
floodplain 200 m away, are treated identically by a 2 km radius. The `DEFAULT_LANDSLIDE_BLOCK_RADIUS_KM = 5`
comment says "debris flow travels beyond the mapped point more readily than standing water
does" — true, but the standing-water case is the one with a DEM behind it and it is not
used. `access_score` (`:228-241`) then multiplies a status by a road-class criticality
constant, which gives the number an authority the input set does not support.

**Fix:** sample the road's own elevation with `elevationAt` and the hazard's water surface
where one is available, and derive passability from `depthPassability(depth)` rather than
from planimetric distance alone. Where no water level exists, say so per record
(`depth_basis: null`) rather than letting the proximity rule stand unqualified. This is
the single largest coherence win available: two modules that both model water and never
talk.

---

### D17 — Two different `severityWeight` functions disagree about the same field, in the same refresh pass

**Severity: Medium**

`src/schema.js:194-202`

```js
export function severityWeight(value) {
  return { critical: 1, high: 0.78, medium: 0.52, low: 0.25, unknown: 0.18 }[normalizeSeverity(value)]
}
```

`src/road-access.js:257-271`

```js
function severityWeight(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical': case 'red': return 3
    case 'high': case 'orange': return 2
    case 'medium': case 'green': return 1
    default: return 0
  }
}
```

Same name, same input, incompatible scales — and the second one accepts GDACS colour
aliases the first does not. `refreshAnalytics` calls `computeFloodRisk` (which uses
schema's) and `computeRoadAccess` (which uses road-access's) in the same function
(`analytics.js:12-20`), so a single stored snapshot contains `risk_scores` where a
`medium` hazard is 0.52 and `road_access` records where it is 1.

**Failure scenario:** an operator compares `risk_scores` against `road_access` for the same
district and concludes that roads are disproportionately cut off relative to risk. The
ratio is an artefact of two weight tables, not of the terrain.

**Fix:** one `severityWeight` in `schema.js`, with an explicit colour→level alias map
(`red → critical`, `orange → high`, `green → medium`) applied once at ingestion, so
downstream code never sees a colour. If road-access genuinely needs a coarser banding
for its `blocking` decision, name it `blockingRank` and document the mapping from the
canonical severity.

---

### D18 — `depthGrid` lacks the negative-elevation guard that `depthAtPoint` has

**Severity: High**

`src/flood-depth.js:57-64`

```js
async function sampleElevation(lat, lon, options) {
  const elevation = await elevationAt(lat, lon, options)
  if (elevation === null) return { error: 'No terrain data covers this location' }
  if (elevation <= NO_DATA_FLOOR_M) {
    return { error: `Terrain void (${Math.round(elevation)} m): elevation data is bathymetry-free and does not cover this point` }
  }
```

`src/flood-depth.js:214-252` (`summarizeGrid`) applies no such test. `elevationFromDecodedTile`
(`:194-211`) returns `NaN` only when one of the four bilinear corners is `NaN`, and
`decodeTerrarium` (`terrain.js:74`) maps only `elevation <= -32768` to `NaN`. Any finite
negative value — bathymetry where the tile mosaic carries it, coastal shelf, a spurious
encoding — is counted as a data cell:

```js
if (Number.isNaN(elevations[i])) continue
dataCells += 1
...
depth[i] = primary - elevations[i]
```

A `level_m` of 20 over a cell at −800 m reports `depth_m: 820`.

**Failure scenario:** `GET /api/v1/flood-depth` over a coastal bounding box (Kismayo,
Barawa, any of the Somali coast pilot assets) returns an `area_sq_km` and a
`depth_grid` dominated by open water, with `coverage_pct` near 100 and no indication that
the "flooded" area is the sea. The same request for the same coordinates through
`depthAtPoint` correctly returns `data_available: false` with a reason. Two endpoints,
two contradictory answers, from one module.

**Fix:** apply `NO_DATA_FLOOR_M` in `elevationFromDecodedTile` (returning `NaN`) exactly as
`terrain.elevationFromTile` returns `null` on void, so the void guard is a property of
the sampler rather than of the caller. Then `coverage_pct` falls for coastal boxes, which
is the correct answer. Report `land_cells` separately from `data_cells`.

---

### D19 — The vertical datum is unchecked while the API contract asserts one

**Severity: High**

`docs/openapi.yaml:575`

```yaml
description: Water surface elevation in metres above sea level.
```

`src/flood-depth.js:43-52`

```js
function validateLevel(levelM) {
  if (!Number.isFinite(levelM)) return { ok: false, reason: 'level_m must be a finite number' }
  if (levelM < -500) { ... }
  if (levelM > 9000) { ... }
  return { ok: true }
}
```

`level_m` is range-checked and nothing else. There is no `datum` parameter on the request,
no `datum` field on the response, and no occurrence of `datum`, `geoid`, `EGM96` or
`orthometric` anywhere in `src/` (verified). Terrarium tiles are EGM96-referenced
orthometric heights; a river gauge staff reading is on a local survey datum; a reservoir
operating level is often on a different one again. Vertical datum offsets between
regional geoids and local datums run to several metres — larger than the entire
0.3 m vehicle-impassability threshold the module applies at `flood-depth.js:120`.

**Failure scenario:** an operator passes 512 m from the gauge at Bor, which is on the
local Nile datum. The DEM is EGM96. If the two differ by 2 m, every facility in that
district is reported 2 m deeper than reality, and `passability` flips from
`restricted` to `impassable_severe` at a 0.3 m threshold. Nothing in the response says a
datum assumption was made.

**Fix:** make the datum explicit on both sides. Add a required `vertical_datum` to the
request (enum: `egm96` | `local_station` | `unknown`) and echo it on the response. When
it is `unknown`, add `datum_offset_uncertain_m` to the depth and widen the effective
vertical resolution — the honest headline is not `vertical_resolution_m: 15` but
"±15 m DEM error plus an unquantified datum offset". This directly serves the module's
own stated purpose ("Every response therefore carries the vertical resolution so a caller
can decide") — it carries half the resolution and none of the datum.

---

### D20 — `computeClimateConflictRisk` still coerces missing precipitation to zero

**Severity: Medium**

`src/analytics.js:160`

```js
const climatePressure = Math.min(35, climate.reduce((sum, item) => sum + Number(item.precipitation_mm || 0), 0))
```

`src/analytics.js:56-59`, twenty lines above, in the sibling scorer, states the rule and
why:

```js
// A missing reading is unknown, not zero. `|| 0` made an absent
// precipitation record look like a measured dry spell, which lowers the
// score — the worst direction for an absent input.
```

The fix landed in one scorer and not the other. Also note `Number(item.precipitation_mm
|| 0)` coerces the string `"0"` and any other falsy value, not just `null`.

**Failure scenario:** a district whose conflict-feed refresh has run and whose climate
feed has not scores `climate_conflict_risk` 0–35 points low for no physical reason, and
the missingness shows up nowhere in `drivers` (which carries only counts,
`analytics.js:200-205`).

**Fix:** `Number.isFinite(Number(item.precipitation_mm)) ? Number(item.precipitation_mm) : 0`
plus a `missing_precipitation_records` count in `drivers` so the shortfall is visible, as
the flood scorer already does at `:110`. Already catalogued at
`docs/architecture/analytics-and-alerts.md:512`; the code has not moved.

---

### D21 — Scenario deltas average over different region sets

**Severity: Medium**

`src/scenarios.js:57-63`

```js
const flood_risk_baseline = baseline_risk_scores
  .filter((r) => r.type === 'flood_risk')
  .reduce((sum, r) => sum + r.score, 0) / (baseline_risk_scores.filter((r) => r.type === 'flood_risk').length || 1)
```

`collectRegions` (`analytics.js:392-418`) derives the region set from the records present.
Three of the four perturbations change which records exist: `offline_asset_ids` removes
service assets (`:31-34`), `added_hazard_events` adds them (`:36-38`),
`added_conflict_events` likewise (`:40-42`). Each can add or remove regions from the
scored set. The baseline mean and the scenario mean are then taken over different
populations, and the reported `flood_risk_delta_mean` conflates "conditions changed" with
"the denominator changed".

`regions_compared: risk_scores.length` (`:119`) reports only the scenario count, so the
mismatch is not detectable from the payload.

**Failure scenario:** adding one hazard event 400 km outside the pilot area creates a new
region with a low score. The scenario mean drops by averaging in a new low value, and the
workbench reports a *reduction* in flood risk caused by adding a flood event.

**Fix:** intersect the two risk-score sets by `region.key` before computing the means, and
report `regions_compared: <intersection size>` plus
`regions_added` / `regions_removed` explicitly. This is the same "compare like with like"
fix the per-asset pairing at `:84-98` already received.

---

### D22 — Quantile mapping collapses to a constant with one station, and puts missing rainfall at zero

**Severity: High**

`src/analytics/downscaling.js:17-19`

```js
const stationIdx = Math.round((rank / sortedGridded.length) * (sortedStation.length - 1))
return sortedStation[stationIdx]
```

`sortedStation.length === 1` makes `sortedStation.length - 1 === 0`, so `stationIdx` is
always `0` and the mapper returns that single station value for every input. The result is
`bias_corrected_precipitation_mm = <the one station's value>` on every observation in the
group, and `bias_correction_source` names that station as the source.

`src/analytics/downscaling.js:42-43`

```js
const gridValues = obsGroup.map((o) => Number(o[field] || 0))
const stationValues = stationGroup.map((s) => Number(s[field] || 0))
```

The `|| 0` again: a missing precipitation reading enters the gridded distribution as a
measured zero, so the quantile map is built against a distribution that says the country
was dry.

And `src/analytics.js:52` prefers the output over the observation:

```js
if (Number.isFinite(item.bias_corrected_precipitation_mm)) return Number(item.bias_corrected_precipitation_mm)
```

**Failure scenario:** an operator posts one station reading to `POST /api/v1/analytics/bias-correct`
permitted by the request shape, receives a corrected series that is that one number
repeated, and the response carries no `station_count`, no method, and no flag beyond
`bias_correction_source` naming the single station. Nothing marks the output as degenerate.

**Fix:** (1) refuse the correction when `stationGroup.length < 3` (a quantile map needs a
distribution on both sides) and return the observations unchanged with
`bias_correction_status: 'refused'`; (2) drop `|| 0` for a finite check, matching
`public/shared/seasonal.js:29-31`, which already solved exactly this; (3) echo
`station_count`, `observation_count`, `field`, and `method` in the response.

---

### D23 — `analytics/ensemble.js` is entirely dead; `calibrationReport` is never served

**Severity: Medium**

`src/analytics.js:5` and `:7`

```js
import { computeEnsembleStats } from './analytics/ensemble.js'
import { biasCorrectClimate } from './analytics/downscaling.js'
```

`computeEnsembleStats` is imported and never called in the file; `biasCorrectClimate` is
imported and never called there either (the real caller is `server.js:664`).
`spreadSkillIndex` (`ensemble.js:35`) has no caller anywhere in the repository — not in
`src`, not in `public`, not in `scripts`, not in `test`.

The reason is upstream: `ensemble_members: []`, `ensemble_p10: null`,
`ensemble_p90: null` are hard-set in both connectors (`connectors/open-meteo.js:49-52`,
`connectors/glofas.js:49-52`). So `hasEnsemble` (`analytics.js:67`) is permanently `false`,
the `ensemble_p90` branch at `:53-55` is unreachable, and `drivers.ensemble_used` never
appears. The p10/p50/p90 machinery that `scenarios.js:19-27` scales by a precipitation
multiplier is scaling `null`.

Separately, `calibrationReport` (`analytics.js:246`) is exported, referenced in
`docs/architecture/analytics-and-alerts.md:256` and cited by
`docs/platform-jtbd-catalogue.md:61` as the evidence for JTBD-018 — and `GET /api/v1/assessments`
(`server.js:835-851`) contains no calibration field. The catalogue's claim that the package
"includes calibration metadata" is false against the shipped route.

**Failure scenario:** a reader of the JTBD catalogue believes calibration metadata ships in
the assessments payload. It does not, and the function that would produce it has never
been called. Separately, an operator reading `scenarios.js`'s ensemble handling believes
scenario runs perturb an ensemble spread; there is no ensemble.

**Fix:** delete `spreadSkillIndex` and the dead `computeEnsembleStats` import, or wire
them to the real ensemble feed (E4). Either way remove `calibrationReport` from the
JTBD catalogue's evidence column until `GET /api/v1/assessments` actually returns it, and
add the ensemble-null assertion to the ingestion tests so the dead branch cannot look live.

---

### D24 — The flood risk score scales with record count, not with conditions

**Severity: High**

`src/analytics.js:63,77`

```js
const precipitation = usablePrecip.reduce((sum, v) => sum + v, 0)
...
const score = clamp(Math.round(precipitation * 1.5 + (maxProbability ?? 0) * 0.35 + hazardPressure), 0, 100)
```

`nearby(data.climate_observations, region, 125)` returns *every* climate record in a 125 km
radius — a 30-day daily forecast series, an ERA5 archive backfill, a bias-corrected
record, all of them. Summing precipitation over that set and multiplying by 1.5 means the
score is dominated by **how many observations exist**, not by how wet it is. Two districts
receiving identical daily totals score in proportion to their record counts.

At 1.5 per mm, 20 daily records averaging 5 mm score 150 and saturate the 0–100 clamp. A
30-day forecast series saturates the score on a moderately wet week alone. `severityWeight × 30`
per hazard (`:76`) has the same property: five concurrent green alerts contribute 150
points to a 100-point scale.

`docs/architecture/analytics-and-alerts.md:87` labels the mermaid subgraph
`score — raises with evidence`, which is the honest description, but the payload's
`methodology` string (`analytics.js:140`) says "Transparent baseline: precipitation
forecast + flood/storm/disaster alerts near exposed locations" and the record carries no
count-dependence warning at all.

**Failure scenario:** the `gdacs_archive` or `open_meteo_archive` backfill runs for one
district and not another. The backfilled district's risk score rises — not because
conditions changed, but because the store now holds more rows in its 125 km radius. The
scenario workbench then reports a positive delta from a run that changed nothing physical.
`computeServiceImpacts` propagates this to every asset within 150 km.

**Fix:** normalise before summing. Use a mean rather than a sum for precipitation, or a
sum over an explicitly deduplicated window (one value per district-day), and cap the
precipitation term rather than letting the clamp absorb it. Record the observation count
in `drivers` — `climate_observations_in_scope` is already there at `:109`, so the raw
material is present and unread. Add a `limits` sentence naming the count dependence.

---

### D25 — The "Unresolved" section of the analytics doc is stale in three places

**Severity: Low**

`docs/architecture/analytics-and-alerts.md:516-520`

```
- `confidence_sum` in `computeDataQuality` is initialised and read but never
  incremented, so `mean_confidence` is always `0`. No comment marks this as
  deliberate.
```

`src/analytics.js:307-310` increments it, and `:346-348` returns `null` rather than `0`
when nothing carried a confidence, with a four-line comment explaining why. The defect is
fixed; the doc still lists it.

`docs/architecture/analytics-and-alerts.md:497-500` describes the calibration report as
if it shipped. It does not (D23).

**Failure scenario:** an auditor working from the doc re-audits a fixed defect and a
never-shipped feature, and concludes the repository is less careful than it is in one case
and more capable than it is in the other. On a project whose central claim is that it
documents its own limitations accurately, a stale limitations list is a real cost.

**Fix:** remove the resolved bullet, add a dated "resolved" note, and add a CI check that
every `src/analytics.js:N` line reference in the doc still points within the file — cheap
and it will catch the next drift.

---

## Enhancements

### E1 — Out-of-sample validation on the contingency layer, with the threshold re-fitted per fold

**Value:** the contingency table is the layer operators read first and the one with no
coefficients to interrogate, and it currently has no validation at all — it is computed on
the full sample and reported beside a fitted layer that *was* validated, which invites
reading it as equally well-founded. Per-fold re-estimation turns it from a description of
the training record into a measured skill statement.

**Evidence:** `src/flood-probability.js:290-321` (`contingencyCount` takes only
`samples`), `:617` (`leaveOneYearOut` is called on the sample set; the contingency path has
no fold loop), `docs/architecture/analytics-and-alerts.md:254-271` (calibration is `null`
because there is no labelled outcome set — the contingency layer already *is* that set).

**Sketch:** inside the existing fold loop, recompute `quantile(training months, p)` per
feature and evaluate the held-out year's months against that fold's threshold, accumulating
held-out `n_above`, `positives_above`, and a held-out Brier. Emit
`contingency_validation: { folds_evaluated, held_out_brier, held_out_brier_of_base_rate,
skill }`. Pair it with D1's per-fold discharge re-labelling so both layers validate on the
same folds.

**Does not license:** a skill number here does not make the contingency table a predictor of
unseen *events* — the label remains reporting-conditioned, and held-out skill over the
same archive validates co-occurrence within the archive, not the physical flood rate. It
must carry the same `what_a_probability_is_not` string.

---

### E2 — Uncertainty intervals on every number the API emits, with the missing term named

**Value:** every numeric output the platform returns today is either a point with no
interval or a band that is not an interval (`calibrated_uncertainty: false`). Attaching a
model interval *and* naming the terms it excludes is the single change that most directly
serves the project's stated ethos: it makes the existing uncertainty more visible rather
than papering over it.

**Evidence:** `src/flood-probability.js:529` returns a bare probability;
`src/analytics.js:98-102` derives `halfWidth` from coverage, not from a distribution;
`src/analytics.js:272` returns `brier_score: null`;
`src/server.js:583` emits `probability` with no interval and no contingency counts.

**Sketch:** three tiers, each labelled. (1) *Model interval* — coefficient SEs from the
inverse Hessian already computed inside `fitLogisticRegression` at `:395`, transformed to
the probability scale. (2) *Sampling interval* — Wilson, with the effective-*n* correction
from D8. (3) *Unquantifiable terms* — a `not_included` array naming reporting coverage,
vertical datum, and stationarity. Return
`{ value: 0.086, intervals: { model: [...], sampling: [...] }, not_included: [...] }`.

**Does not license:** a returned interval is not a predictive interval and must never be
named `p10`/`p90`. It covers the fitted model's own sampling error given the training
record; it does not cover the archive's reporting bias, non-stationarity, or the distance
between a reported flood and a flood on the ground. The `not_included` array is the part
that makes the number safe to publish.

---

### E3 — Sensitivity analysis over thresholds, surfaced in the API

**Value:** the 90th-percentile contingency threshold and the 2 km/5 km road radii are
undisclosed magic numbers with no measured sensitivity anywhere in the payload, so an
operator cannot tell whether a result is robust to them. Publishing the sensitivity curve
turns a hidden assumption into a checkable one at trivial cost.

**Evidence:** `src/flood-probability.js:316` —
`Object.entries(thresholds || { max_7_day: 0.9, sum_30_day: 0.9, sum_90_day: 0.9 })` —
the defaults are inline with no provenance; `src/flood-probability.js:245`
`options.floodPercentile || DISCHARGE_LABEL_PERCENTILE`; `src/road-access.js:32-33`
`DEFAULT_FLOOD_BLOCK_RADIUS_KM = 2`, `DEFAULT_LANDSLIDE_BLOCK_RADIUS_KM = 5`;
`src/terrain.js:32` `MAX_ZOOM = 13` with the justification in a comment at `:29-31` that
no consumer sees.

**Sketch:** sweep each threshold over a small grid (contingency p ∈ {0.80, 0.85, 0.90,
0.95}; flood radius ∈ {1, 2, 5, 10} km) and emit
`threshold_sensitivity: { parameter, values, conditional_probability_by_value,
wilson_by_value, lift_by_value }`. Nothing about the primary output changes; the curve is
an adjunct that shows how flat the estimate is. `docs/architecture/analytics-and-alerts.md`
already publishes exact constants in prose — this puts them where the caller can use them.

**Does not license:** a flat curve over the swept grid does not show the estimate is
correct, only that it is insensitive within the grid. It says nothing about thresholds
outside the grid, and it cannot license lowering `MIN_MONTHS`/`MIN_EVENTS` — those are
floors for footing, not tunables.

---

### E4 — Wire the ensemble path to a real probabilistic feed, or delete it

**Value:** the platform has a complete ensemble branch in the flood scorer that no
connector can ever satisfy, plus a `spreadSkillIndex` that nothing calls. Either
populating it gives the first genuinely probabilistic input the risk model has ever had —
and the only legitimate source of a real percentile — or deleting it stops the codebase
implying a capability it does not have.

**Evidence:** `src/analytics.js:53-55,67` gate on `ensemble_source === 'open_meteo_ensemble'`
with `ensemble_p90`; `src/connectors/open-meteo.js:49-52` and
`src/connectors/glofas.js:49-52` hard-set `ensemble_members: []`, `ensemble_p10/p50/p90: null`;
`src/analytics/ensemble.js:35` `spreadSkillIndex` has no caller anywhere;
`src/scenarios.js:19-27` scales three fields that are always null.

**Sketch:** Open-Meteo's ensemble endpoints return member values per timestep. Populate
`ensemble_members`, set `ensemble_source: 'open_meteo_ensemble'`, and route `p10/p50/p90`
through `computeEnsembleStats`. Then make `spreadSkillIndex` reachable and report it —
it is a coefficient-of-variation measure and is exactly the "how uncertain is this input"
number the sensitivity band currently fakes. If the feed is not adopted, delete
`spreadSkillIndex`, the `ensemble_*` handling in `scenarios.js`, and the dead import in
`analytics.js`, and say in the data model that ensemble fields are reserved.

**Does not license:** a real ensemble percentile is a *forecast* percentile from an
initial-condition ensemble. It is not a predictive interval for the outcome, it does not
cover model error in GloFAS/ERA5, and swapping it into `sum_30_day` does not make the
flood model hydrological. The `calibrated_uncertainty` flag must stay `false` for any
score derived from it until E1's validation runs against it.

---

### E5 — An "explain this score" endpoint that traces inputs to output

**Value:** today an operator reading a risk score has to know which radius, which weight
and which code path produced it, or take it on trust. A trace endpoint makes the
arithmetic inspectable in the same spirit as the contingency layer being "the
transparent primary" — it moves the explanation from the source file into the payload.

**Evidence:** `src/analytics.js:104-113` builds `drivers` (totals and counts, no
per-term contribution); `src/analytics.js:77` computes the score in one expression with
four terms; `src/road-access.js:98-106` records obstructions but not the arithmetic;
`src/analytics/impact.js:33-41` records `distance_km` and population but no derivation.

**Sketch:** `GET /api/v1/explain?collection=risk_scores&id=…` returning, per contributing
term, the matched record ids, the distance, the coefficient applied, the points
contributed, the caps hit, and the exact expression. Same shape for `impact_assessments`
and `road_access`. Store the term breakdown on the record at compute time so the endpoint
is a read, not a recomputation that could drift from the shipped number.

**Does not license:** a trace explains *how* a number was produced. It is not evidence the
number is meaningful — the strongest possible trace still shows a sum over a record count
(D24). The response must carry the same `limits` string as the score it explains, and a
trace must never be rendered in place of the `methodology` field.

---

### E6 — Per-region calibration and trust score, with the reporting-coverage caveat attached

**Value:** `false_alert_rate` is `null` globally because nobody records determinations, and
`brier_score` is `null` because there is no outcome set. Both become measurable per region
if the platform starts recording outcomes against hazard events it already ingests, which
converts the single largest `null` in the KPI surface into a number with a stated
denominator.

**Evidence:** `src/analytics.js:246-274` (`calibrationReport`, `brier_score: null`
unconditionally, unserved per D23); `src/kpi.js:182-189` (the correct
determined-vs-total pattern, currently global only);
`docs/architecture/analytics-and-alerts.md:254-271` (the reason it is null: "the platform
has no record of which past hazard *did* or *did not* occur for a scored region");
`src/alerts.js:53` (`false_alert` tri-state already exists and is populated by nothing).

**Sketch:** a periodic job joins `alert_events` to `hazard_events` by district, time
window and severity — the join `backtestTriggerProtocol` already attempts (D13) — and
writes an `alert_outcomes` collection with `{ alert_event_id, matched_hazard_event_id,
determination, determined_at, determined_by }`. `false_alert_rate` then has a real
denominator per district, and `calibrationReport` gets an outcome set for the first time.
Expose the join's coverage alongside the rate: `determination_coverage_pct`.

**Does not license:** an alert matched to a hazard is not a *true* alert — the same
150 km/proximity matching defects as D15 and D13 apply. A rate computed from an
auto-joined outcome set is a *reporting* rate, not a false-alert rate, until a human or a
documented rule makes the determination. It must not be labelled `false_alert_rate`
without carrying `auto_determined: true` on every record it touches.

---

### E7 — Model-drift monitoring on the trained flood models

**Value:** the fitted coefficients, the standardisation means/sds and the discharge
threshold are frozen at training time and never revisited, so a district whose rainfall
regime or whose GloFAS operational run has drifted keeps serving year-old coefficients
indefinitely with nothing to notice.

**Evidence:** `src/flood-probability.js:434-444` returns the fitted card and nothing
tracks it forward; `src/flood-probability.js:438-440` bakes `coefficients` and
`standardization` at fit time; `src/server.js:566` scores against the most recent
`trained_at` with no staleness bound; `src/analytics.js:454-462`
(`freshnessPenaltyFor`) already implements exactly the right shape of staleness rule for
data quality, but nothing applies it to models.

**Sketch:** on each refresh, recompute the training months' feature means/sds and compare
against the stored card's `standardization`; emit a `model_drift` record per district with
per-feature z-shift, the months since training, and the change in the discharge threshold
percentile. Refuse to score (or score with a `drift_warning`) past a stated staleness
bound. Reuse `freshnessPenaltyFor`'s thresholds rather than inventing new ones.

**Does not license:** a drift statistic is a change in the *input distribution*. It is not
evidence the flood relationship changed, and it does not license keeping a model past the
point where its coefficients stop describing the data — it is a trigger to retrain and
re-validate, not a correction. Non-stationarity here is exactly what E2's `not_included`
list is for.

---

### E8 — Seasonal forecast skill verification

**Value:** the platform ingests the Niño 3.4 series and renders it as an advisory strip,
with careful honesty about the index and the run-length rule, but nothing ever checks
whether the seasonal state was *useful* — which is the only question a planner has about
it. A verification layer would let the strip state its own hit rate.

**Evidence:** `src/connectors/noaa-enso.js:46-52` (the connector computes overlapping
seasons and the episode rule); `public/shared/seasonal.js:36-59` (`readSeasonalState`
returns phase and advisory state, no outcome); `test/seasonal.test.js:1-13` (tests the
parsing and the null path only).

**Sketch:** accumulate a `(season, phase, outcome)` table where outcome is the observed
Niño 3.4 value three months later; report per-phase hit rate, base rate, and Brier of
`P(phase | state)` over the 1949-present record the connector already parses in full.
Expose as `GET /api/v1/seasonal/verification`.

**Does not license:** Niño 3.4 phase skill over the historical record does not transfer to
any individual season, and certainly not to rainfall in the Horn of Africa. This verifies
the index's own persistence, not the platform's flood model, and must not be presented as
skill of the risk score.

---

### E9 — Ensemble forecast skill scoring against observations

**Value:** if E4 lands, the ensemble spread becomes a real uncertainty statement and the
obvious next question — does a wide ensemble actually correspond to a worse outcome? — is
answerable from data the platform already holds, turning `ensemble_p90` from a number that
enters the score into one whose usefulness is measured.

**Evidence:** `src/analytics/ensemble.js:35-53` (`spreadSkillIndex` computes exactly a
coefficient of variation and has no caller); `src/analytics.js:53-55` (the p90 is preferred
over the point value with no verification that it means anything);
`src/analytics.js:67` (`drivers.ensemble_used` — currently unreachable).

**Sketch:** for each forecast-issued observation with members, join the verifying
observation and bin by decile of ensemble spread; report mean absolute error and RMSE per
bin. A monotone relationship is the evidence that the spread is informative; a flat one
means `ensemble_p90` should not be preferred over the point value, and that is a finding
worth having.

**Does not license:** spread-outcome association at 1–14 day lead is not skill at 1–3 month
lead, and neither is skill for the flood outcome specifically. A good spread-verification
curve says the ensemble is honest about *its own* rainfall; it does not license calling the
flood probability more reliable, and it does not touch the reporting-coverage term.

---

### E10 — Subnational downscaling with an explicit skill statement attached

**Value:** the flood model currently runs at one point per district (`DEFAULT_REGIONS`),
which the basis document already names as a residual — "single point rainfall cannot
resolve district-scale drainage". A subnational variant would let the model speak about
the district's wettest ward rather than its centre point, and the *honest* way to ship it
is to ship the skill statement with it.

**Evidence:** `src/flood-probability.js:574` (district point from the archive record);
`docs/flood-probability-model-basis.md:83-84` (the single-point residual, stated on every
archive record); `src/analytics/downscaling.js:1-21` (`quantileMap` exists, with D22's
defects, and is the only downscaling machinery present).

**Sketch:** a `--subnational` training mode that samples ERA5 at several points inside each
district, holds them out geographically (leave-one-point-out, not leave-one-year-out), and
reports the spatial skill alongside the temporal one. Ship the ward-level number only
where the spatial Brier beats the district-point number on held-out points; elsewhere
refuse and say "insufficient spatial skill at this resolution".

**Does not license:** subnational output must not be presented as a flood forecast for a
named locality on the strength of a district-level fit. The unit of validity is the sample
that validated it — a ward-level number backed by a district-level fit is the exact
overclaim `check-no-flood-probability.mjs` exists to prevent, and would need the same
treatment: an explicit basis, a refusal at low skill, and a `what_this_is_not` string on
every record.

---

### E11 — Climate-normal baselines instead of extrapolation vocabulary

**Value:** the project rejected hydrological frequency analysis on data grounds, which leaves
it with no framework at all for "how unusual is this relative to normal". A
climatological-normal baseline — percentile of the current value within the district's own
30-year record — is exactly as forbidden-vocabulary-free, needs no GEV, and answers the
question planners actually ask.

**Evidence:** `src/analytics.js:77` (the score is an absolute weighted sum with no
reference to the region's own history); `src/flood-probability.js:169-174` (monthly
features already exist for every month of the record — the distribution is sitting in the
training sample); `docs/flood-probability-model-basis.md:270-276` (ERA5's ~40 % tropical
extreme underestimate is the reason no tail extrapolation ships — a percentile *of the
observed record* is not an extrapolation and is unaffected).

**Sketch:** for each trained district, compute the empirical percentile of the query
vector's features within the training sample and return
`{ max_7_day_percentile_in_record, sum_30_day_percentile_in_record, months_compared }`.
Stated as a position in the observed distribution, never as a chance of exceedance.

**Does not license:** this is emphatically *not* a frequency estimate, and the vocabulary guard
must keep it that way — the existing check script stays armed and scans these very words. A percentile of the ERA5 record
inherits ERA5's ~40 % tropical extreme underestimate *into the tail of the record itself*;
"the wettest 1 % of months in this record" is a statement about ERA5, not about the basin,
and the payload must say so.

---

### E12 — Make uncertainty visible in the default payload, not only on request

**Value:** the honest-uncertainty machinery already exists and is largely correct, but it
is buried: `limits` is a joined string, `calibrated_uncertainty` is a bare boolean, the
interval terms are spelled out only in a Markdown file. The same information rendered
structurally would reach a dashboard without a documentation link.

**Evidence:** `src/analytics.js:141-148` (a four-sentence `limits` string, joined with
spaces, per region); `src/analytics.js:135` (`calibrated_uncertainty: false` — a boolean
with no pointer to why); `src/analytics.js:98-102` (the band construction whose meaning
is documented in a comment at `:88-97` and in `docs/data-model.md:173-186`, neither of
which reaches a JSON consumer).

**Sketch:** replace the joined string with a structured object —
`limits: { statements: [...], not_a: 'predictive interval', band_meaning: 'input coverage',
zero_band_meaning: 'inputs sufficient' }` — keeping the string form as a rendered
`_text` for existing consumers. Add `evidence: { basis_ref, sample_size, validated }` to
every scored record so a UI can render "based on 357 months, validated out-of-year, skill
−0.038" without a lookup.

**Does not license:** restructuring the payload is not a licence to shorten the prose. The
constraint is that no rendering of these fields may drop `zero_band_meaning` or
`band_meaning` — the whole reason the project renamed the percentiles is that structure
without the qualifier reads as confidence. If a dashboard shows a band width, it must show
the qualifier on the same screen.

---

### E13 — Scenario perturbation validation against a null model

**Value:** `runScenario` reports a delta between two means with no indication of whether
that delta is larger than the noise in the underlying score. Since the score is dominated
by record counts (D24) and the score itself has a sensitivity band, most plausible
perturbations will produce deltas smaller than the machinery's own jitter — and the
workbench cannot say so.

**Evidence:** `src/scenarios.js:105-120` (`diff` block: four means and three deltas, no
dispersion, no n); `src/analytics.js:98-102` (`sensitivity_width` exists per region and is
discarded here); `src/scenarios.js:121` (`model_limit` describes what the delta is not,
but not whether it is distinguishable from zero).

**Sketch:** propagate the per-region `sensitivity_width` through the same weights into the
scenario mean, and report `delta_within_band: true|false` alongside each delta. Add a
permutation null: recompute the baseline means over random equal-sized region subsets and
report the delta's position in that null distribution. Fix D21's region-set mismatch first,
or the null is measuring the wrong thing.

**Does not license:** a null model built on the sensitivity band measures the *band*, which
is a coverage statistic, not sampling error — it is a floor on "could this be noise", not
a confidence interval. A `delta_within_band: false` result must not be rendered as
"significant", and no p-value from this construction should be published.

---

### E14 — Kill the inconsistent copy at the source

**Value:** `false_alert_rate` is implemented three times and is wrong twice; `severityWeight`
is defined twice with different scales; the fold-threshold rule is documented in three
places and holds in one. Every one of D9, D10, D17, D21 and D25 exists because a fix was
applied at one call site rather than at the definition.

**Evidence:** the three `false_alert` sites are `src/kpi.js:182-186` (correct),
`src/equity.js:43-49` (keyword scan), `src/districts.js:107-109` (keyword scan);
`severityWeight` is `src/schema.js:194` and `src/road-access.js:257`;
`docs/architecture/analytics-and-alerts.md:497-520` (three unresolved items, all now
stale or never-shipped).

**Sketch:** one `falseAlertStats(alerts)` helper in `kpi.js` returning
`{ rate, determined, of_total, method }`, with the tri-state filter in one place, imported
by all three callers. One `severityWeight` in `schema.js` with colour aliases applied at
ingestion. A doc-freshness test that asserts every `src/x.js:N` reference in
`docs/architecture/analytics-and-alerts.md` still resolves inside the file.

**Does not license:** deduplication is a correctness measure, not a capability. It does not
make the false-alert rate measurable — with no determinations recorded, the correct output
of the deduplicated helper is still `null`, and D6's second occurrence must preserve that
rather than collapsing it to 0.

---

## Model honesty audit

Every numeric output the API emits, its documented basis, and whether the payload itself
tells the user how much to trust it. "Payload honesty" = does the response object carry
the qualification, without the reader having to leave the response.

| # | Output | Endpoint / source | Basis | Documented | Payload states its own limits? | Verdict |
|---|---|---|---|---|---|---|
| 1 | `probability` | `GET /flood-probability/score` (`server.js:583`) | Empirical co-occurrence, fitted logistic on the training record | Yes — basis doc §1, §2a | **Partly.** `basis`, `folds`, `months_kept` present; **no interval, no `contingency`, no `flood_months`** | **Overclaims by omission** (D6) |
| 2 | `conditional_probability` | same / model card `contingency` | Counts in, counts out | Yes | Yes — `conditional_probability_wilson`, `months_above_threshold`, `flood_months_above_threshold` | Honest, but can be a hard `0` (D3) and fires at n=10 (D2) |
| 3 | `lift_over_base_rate` | model card `contingency` | Ratio of conditional to base rate | Yes | **No** — carries neither n, nor the independence caveat | **Overclaims** (D8, D3) |
| 4 | `brier_score`, `skill_over_base_rate` | model card `folds` | Leave-one-year-out Brier vs climatology | Yes — basis doc §1 | Yes — `validated_months`, `n_folds`; **negative skill ships** | **Honest, and the strongest output in the repo** — undermined by D1 (leakage) and D4 (dropped folds) |
| 5 | `discharge_threshold_mCms` | model card `discharge.threshold_mCms` | p95 of that cell's monthly maxima | Yes | Yes — `threshold_percentile`, `months_used`, `provider` | Honest; label is documented as modelled and unvalidated |
| 6 | `score` (`flood_risk`) | `risk_scores` | Weighted sum of summed precipitation, max probability, hazard pressure | Yes — analytics doc "Composition" | Yes — `methodology`, `limits`, `drivers`, `calibrated_uncertainty: false` | **Qualified but under-disclosed**: the `|| 0` and count-dependence are not in `limits` (D20, D24) |
| 7 | `score` (`climate_conflict_risk`) | `risk_scores` | Same shape, different weights/caps | Yes | Yes — same four fields | **Overclaims relative to its own docstring**: doc §"Climate-conflict" names the `|| 0` policy gap; the payload does not (D20) |
| 8 | `sensitivity_low/mid/high` | `risk_scores` | Coverage-derived band, not a distribution | Yes — analytics doc §"sensitivity band", data-model §"risk_scores" | **Yes** — `calibrated_uncertainty: false` + `limits` names the zero-band meaning | **Honest.** Best-documented non-flood output |
| 9 | `confidence` | `risk_scores`, `impact_assessments`, `data_quality` | Input-coverage indicator | Yes | Partly — `limits` on the flood scorer, **absent on `impact_assessments`** | Under-disclosed on impacts |
| 10 | `impact_score` | `impact_assessments` | 0.55 × nearest flood + 0.45 × nearest conflict, zero beyond 150 km | Yes — analytics doc §"Service impacts" | **No** — `drivers` names the two regions, nothing states the 150 km cutoff or the absent-side-as-zero rule | **Overclaims** |
| 11 | `population_at_risk` | `analytics/impact.js:44` | Sum of `population_served` for assets within 25 km | Thin — radius not stated in payload | **No** — no radius, no asset count on the top-level record | Under-disclosed |
| 12 | `at_risk_count`, `total_population_served` | `computeFacilitiesAtRisk` (`impact.js:66-73`) | Asset–hazard **pairs**, not assets | **No** | **No** | **Overclaims** — the name says facilities (D12) |
| 13 | `access_status` / `access_score` | `road_access` | Planimetric distance to hazard point, severity band, road class | Yes — road-access docstring | Yes — `access_reason`, `matched_by`, `confidence`, obstructions | **Overclaims**: no recency filter (D15), no elevation/depth (D16), no `severityWeight` disclosure (D17) |
| 14 | `cut_off_rate_pct` | `summarizeRoadAccess` | Impassable ÷ all roads in the store | Thin | **No** — no statement that the denominator is unscoped, or that hazards include archive events | **Overclaims** (D15) |
| 15 | `depth_m` | `GET /flood-depth` point | `level_m − elevation` | Yes — module docstring is explicit about non-hydrology | Yes — `model`, `vertical_resolution_m`, `source` | Honest in intent; **omits the vertical datum** the OpenAPI contract asserts (D19) |
| 16 | `area_sq_km`, `coverage_pct` | `GET /flood-depth` grid | Cell count × cell area | Yes | Partly — `coverage_pct` exists; **no negative-elevation guard**, so bathymetry counts as flooded area (D18) | **Overclaims on coastal boxes** |
| 17 | `passability` | `GET /flood-depth` point | Depth vs 0.3 m / 1.0 m conventional cut points | Yes — exposed as options, documented as conventional | Yes — thresholds overridable, docstring says "conventional rather than site-specific" | Honest |
| 18 | `false_alert_rate` (KPI) | `GET /api/v1/kpi` | Determined alerts only | Yes — the correct implementation | **Yes** — `null`, plus `false_alert_determined`, `false_alert_of_total`, `false_alert_method`, and a `data_gaps` entry | **Model reference.** Two siblings contradict it (D9) |
| 19 | `false_alert_rate` (district) | `GET /districts/:slug` | Keyword scan over a truncated list | **No** | **No** | **Overclaims** — reports 0% for undetermined, over ≤30 alerts (D9, D11) |
| 20 | `false_positive` / `accuracy_pct` (equity) | `equityByDistrict` | Keyword scan; mismatched numerator/denominator | **No** | **No** — `_data_gaps` covers only gender/age | **Overclaims** — and drives workflow creation (D9, D10) |
| 21 | `precision` / `recall` (backtest) | trigger-protocol backtest | Source runs vs hazard events; scope and rule ignored | **Yes** — analytics doc §Backtest names both defects | **No** — the payload carries neither caveat | **Overclaims relative to its own documentation** (D13, D14) |
| 22 | `calibrationReport` | never served | none | Yes — `brier_score: null` | N/A | **Dead code** (D23) |
| 23 | `ensemble_p10/p50/p90`, `spread_skill` | `climate_observations` | none — no connector populates them | Implicitly, via `ensemble_source` gating | `drivers.ensemble_used` never set | **Dead branch** (D23) |
| 24 | `bias_corrected_precipitation_mm` | `POST /api/v1/analytics/bias-correct` | Empirical quantile map, gridded → station | **No** — no method, no n, no refusal | `bias_correction_source` only | **Overclaims** — preferred over the raw observation at `analytics.js:52` (D22) |
| 25 | `mean_confidence` | `data_quality` | Mean of record-level `confidence` where present | Yes | Yes — `null` when none present | **Honest.** Doc `analytics-and-alerts.md:516` still lists this as a defect (D25) |
| 26 | `anomalyC`, `episodeDeclared` | `GET /seasonal` via `public/shared/seasonal.js` | CPC Niño 3.4 monthly anomaly + published run-length rule | Yes — connector docstring is unusually careful | **Yes** — `indexUsed`, `indexNote`, `modelLimit`, `advisoryRunMonths`, seasons counted not read | **Honest.** Advisory framing preserved end to end |
| 27 | `flood_risk_delta_mean` | `POST /api/v1/scenarios/run` | Change in mean of an uncalibrated score | Yes | **Yes** — `model_limit` says "not a percentage, not a probability, not a forecast" | **Honest in wording; confounded by D21** |
| 28 | `alert_events[].false_alert` | `alert_events` | Operator determination, tri-state | Yes — alerts.js docstring, architecture doc §tri-state | **Yes** — `null` means not determined, enforced by a throwing validator | **Model reference for "unknown"** |

**Summary of the overclaim set.** Eight of twenty-eight outputs (#1, #3, #6, #7, #10,
#12, #13, #14, #16, #19, #20, #21, #24) carry a qualification in documentation that does
not travel with the payload. The pattern is consistent: **the flood-probability model,
which has the most documentation, is the most honest; the analytics surface around it,
which has less, is where every overclaim lives.** That is worth stating plainly to the
project — the guard script polices capability vocabulary in `src`, `public`, `scripts`,
`test` and `docs`, but nothing polices *payload honesty* on the risk, impact and
road-access routes, and that is where the remaining gap is.

---

## Rejected

- **Fit GEV / return levels to the GloFAS discharge record.** The discharge series is 28+
  years of *modelled* discharge with no gauge validation, and ERA5-forced GloFAS underestimates
  extremes. The basis document already rejects this twice; it remains rejected. D1's fix is
  the correct response to having a discharge series: validate the empirical co-occurrence,
  not extrapolate a tail.
- **Treat `false_alert: null` as 0.** Explicitly rejected by `kpi.js:171-189` and
  `alerts.js:41-53`. D9 exists because two call sites did it anyway; the fix is
  deduplication (E14), not a third policy.
- **Calibrate the risk score to outcomes and publish it as a probability.** Even with E6's
  outcome set, `risk_scores` is a coverage-weighted index, not an event-rate model.
  Retro-fitting a Brier to it and clearing `calibrated_uncertainty` would be precisely the
  quiet claim-upgrade this project exists to prevent. The flag stays `false`.
- **Rename `probability` to something weaker.** No. The basis document is explicit that the
  number is empirical co-occurrence with a stated conditioning; the problem is missing
  context (D6), not the word. The guard script already polices the words that would be
  upgrades.
- **Add a "confidence" that accounts for the archive's reporting coverage.** Tempting and
  unmeasurable from inside the platform — GDACS publishes no coverage denominator. The
  honest route is to name it in `not_included` (E2), not to invent a score.
- **Use the ensemble spread as the sensitivity band.** `sensitivity_width` is derived from
  input coverage; replacing it with ensemble COV would be a genuine improvement *only* after
  E4 and E9 establish that the spread is informative. Doing it first would be the invented
  spread the `analytics.js:44-50` comment documents having already been removed once.
- **Interpolate the DEM beyond z12 for flood work.** `terrain.js:29-31` caps at z13 with the
  right reasoning and `elevationAt` defaults to z12. Raising it for "nicer contours" would
  be confidence theatre — the same defect the p10/p90 rename was correcting.
- **Add hysteresis/cooldown to `evaluateAlertRules`.** The fixed-window suppression at
  `alerts.js:105` bounds the record count (one event per rule per bucket), so the
  unbounded-growth concern does not hold. Hysteresis would still help operationally — a
  separate-clear threshold so a metric oscillating around `>=` does not reopen on the next
  bucket — but it is an operational feature, not an honesty defect, and it belongs with
  alert-fatigue work rather than this audit.
- **Report `mean_interval_width` alongside `brier_score` in a future calibration report.**
  Once a real Brier exists, the two will sit in one object and the sensitivity-band mean
  will be read as an uncertainty measure. Keep them in separate objects or rename before
  shipping.