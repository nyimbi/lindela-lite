# How Lindela Lite uses AI and ML

What this codebase does with AI/ML is narrower — and more disciplined — than
the word "AI" suggests. The discipline is the point: this platform issues
numbers that decide where responders and money go, so every fitted thing
carries its sample, its refusal conditions, and its honest failure modes.

## 1. The one genuinely fitted model — flood probability

File: `src/flood-probability.js` (trained via `POST /api/v1/flood-probability/train`,
scope `admin:analytics`).

**Empirical rainfall→flood probability**, trained per district from two keyless
archives:

- **Rainfall**: ERA5 reanalysis daily precipitation via the Open-Meteo archive
  (1981 onward).
- **Labels**: GDACS historical flood events (1985 onward), matched within
  150 km of the district's reference point.

Three features per month — `max_7_day` (intensity), `sum_30_day`
(saturated-catchment proxy), `sum_90_day` (antecedent wetness) — and **every
probability publishes in two forms, both required**:

1. **Contingency counts**: `P = flood months / all months above threshold`,
   raw counts + Wilson interval. Zero coefficients; a reader checks the
   arithmetic by hand.
2. **L2-regularised logistic fit** with coefficients and leave-one-year-out
   skill scores.

Hard refusals are part of the model: fewer than 60 months of data, fewer than
5 events, or all-one-class data and the functions return **no probability at
all** rather than a number with no footing. A GloFAS-discharge variant exists
with the same structure — its 95th-percentile discharge label is fixed by
definition, deliberately not a fitted parameter.

Every scored record carries this caveat: the probability is
*reporting-conditioned* — P(a flood enters the GDACS archive), not P(water
reaches a given ground elevation). No gauge validation exists at the pilot
basins' cells, and the model basis says so (`MODEL_BASIS` in
`src/flood-probability.js`, also `docs/flood-probability-model-basis.md`).

## 2. Statistical composites where ML would be fabrication

- **Risk scores** (`flood_risk`, `climate_conflict_risk`): transparent
  weighted/capped formulas in `src/analytics.js` — e.g.
  `min(35, rainfall) + min(25, 12 × severity weight per event) + …`. They are
  recomputable in the browser: `public/shared/viz-explain.js` re-derives every
  score on the drill-down, and `checkRuleDrift` fails a build when the
  transcription drifts from the source.
- **Bias correction**: quantile mapping (empirical-CDF matching) of gridded
  CHIRPS/ERA5 onto station records — `biasCorrectClimate` in
  `src/analytics/downscaling.js`.
- **Ensemble spread/skill** for forecast uncertainty (`src/analytics/ensemble.js`),
  feeding the sensitivity bands rendered on the drill-down.
- **Coverage-weighted confidence**: presence-of-input scoring, honestly
  labelled "not a sample size, and not a probability."

## 3. MLOps governance around every fitted number

- **Calibration** (`src/calibration.js`): false-alert rates with sample
  floors, per-region **trust scores** — a region's trust score falls when its
  models misfire on thin evidence.
- **Drift monitoring** (`src/drift.js`): PSI watch/drift thresholds (0.10 /
  0.25) over 24-month input windows, plus outcome-divergence detection,
  surfaced at `/api/v1/model-drift`.
- **Backtesting with base rates** (`backtestTriggerProtocol` in
  `src/alerts.js`): precision/recall *relative to the event base rate* — "no
  better than firing always" is a possible, printed verdict. Point-in-time
  contexts prevent future leakage into a backtest's own evaluation.
- **Explainability as a product surface**: the console's Details dialog
  answers "where did this number come from" — terms, observed values,
  self-checks — and renders "not checkable from this record alone" instead of
  inventing a decomposition.

## 4. Where the boundary is drawn

- **No LLMs, no black-box scoring, no unsupervised anything** anywhere in the
  pipeline. Zero runtime dependencies beyond `pg`.
- **Models don't act.** A fitted or threshold signal produces action only
  through **pre-authorised trigger protocols** — condition sets
  (`AND`/`OR`/`XOR`/`NOT`, fail-closed on unresolvable terms) that humans
  signed with `approvers` and an `agreed_at` date, whose playbooks execute
  (`src/protocols.js`). The model proposes; the authorisation structure is
  what discharges.
- Anything with insufficient sample stays **null, worded honestly** — the
  failure this repo is built against is a confident number with no denominator.

**One line**: *statistically grounded models (transparent contingency counts +
a regularised fit) score flood risk; every score is recomputable and
drift-monitored; and the platform converts model signals into action only
through pre-authorised, human-signed protocols with a full audit chain.*