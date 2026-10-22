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

- **No LLMs, no black-box scoring, no unsupervised anything** in the scoring
  path. Nothing that produces a number, a score, a classification or an action
  is a model. Zero runtime dependencies beyond `pg`.
- **Two model surfaces exist, both opt-in and both outside the scoring path**:
  the report narrator (§5) and the query slot-filler (§6). Neither may write a
  fact, and each refuses rather than guesses. They are described here rather
  than omitted, because "no LLMs" is a claim about the pipeline and a reader who
  finds a model in the tree should not have to decide whether the document lied.
- **Models don't act.** A fitted or threshold signal produces action only
  through **pre-authorised trigger protocols** — condition sets
  (`AND`/`OR`/`XOR`/`NOT`, fail-closed on unresolvable terms) that humans
  signed with `approvers` and an `agreed_at` date, whose playbooks execute
  (`src/protocols.js`). The model proposes; the authorisation structure is
  what discharges.
- Anything with insufficient sample stays **null, worded honestly** — the
  failure this repo is built against is a confident number with no denominator.

## 5. The report narrator — generated text, audited like a figure

`src/narrator.js` is the one place a language model writes product text (§6 is
the other model surface, and it writes none — it proposes slots): a
**commentary paragraph** attached to a generated report via
`POST /api/v1/reports/:id/narrate`, written by the smallest Qwen served
locally — Ollama, default `qwen3:0.6b` (0.6B parameters), temperature 0,
explicitly opt-in via `LINDELA_LITE_NARRATOR=1`.

- **A generated sentence must not generate a fact.** The model sees only the
  figures the report's own deterministic sections computed. Code audits its
  output before publication: every digit figure must be among those facts.
- **Invention is a refusal, not cleanup.** An unlisted figure ("1500
  households"), an empty reply, an over-length reply, a transport failure and
  an HTTP error are each refused with the reason recorded on the report
  (`report.narrative`), where an approver reads it. Nothing is truncated into
  a partial claim, and an unconfigured narrator answers the route with a
  recorded refusal rather than an error.
- **The text is marked.** The section carries `type: 'model_narrative'`; the
  reports panel labels it "AI narration ({model})"; the count of figures the
  model restated ships with the text (`numbers_checked`) so the audit is a
  fact, not an assurance.

## 6. The query slot-filler — a model that proposes, a vocabulary that disposes

`src/nl-query.js` parses a natural-language question against a **declared
vocabulary** — seven subjects, a predicate set, a window set, the district list
— and refuses a question it cannot ground. Its design rule is that there is no
model in it. `src/needle.js` adds one to the *recall* of that parse without
changing the rule, using [Cactus Needle
3](https://huggingface.co/Cactus-Compute/needle3) (121M parameters at 2.125 bits
per weight, 8-29 MB, Apache-2.0), opt-in via `LINDELA_LITE_NEEDLE=1`.

- **The model proposes slots; the vocabulary disposes.** Needle returns one
  grammar-constrained tool call carrying `{subject, region, window, predicates,
  threshold}`. The argument grammar is *generated from* the vocabulary, so the
  enums cannot drift from it — and every returned slot is then re-validated
  against that same vocabulary by code, because the grammar is the model's
  promise and this is the platform's, and the platform does not take the
  model's. A proposed subject not in `SUBJECTS` is refused, and the question
  refuses exactly as it does with no model present.
- **A low-confidence proposal is refused whole, not partly applied.** Half a
  parse is the failure mode this module exists to avoid. Below
  `NEEDLE_CONFIDENCE_FLOOR` the call is refused and the score is named. A
  proposal carrying **no** score is refused as `no_confidence`: the card's
  routing needs the number, and a sidecar that omits the field has not said the
  model is confident. Both spellings of absence — omitted and `null` — reach
  that one refusal; a genuine `0` stays `low_confidence`, because a model
  scoring its own guess zero is refusing rather than silent.
- **A slot the model omits takes the parser's own default, not a hole.** A
  proposal naming no window gets `DEFAULT_WINDOW` stamped `assumed: true` —
  the same fallback `findWindow` uses. The model path is only reached when the
  deterministic parse *refused*, and a refusal carries no window, so inheriting
  one from it left `window: undefined` and the render threw; a question Needle
  widened answered 500 where this contract promises 200.
- **Refusals are data, never thrown.** Off, unreachable, HTTP error, malformed
  JSON, empty `function_calls`, a call naming another tool, no confidence, low
  confidence, unknown subject — each is a refusal with its own code, the
  narrator's contract.
- **Its production surface is one route.** `POST /api/v1/ask`
  (`src/routes/ask.js`) serves `answerQueryWithModel`, so a Needle-proposed
  subject runs the same grounding audit as a deterministically parsed one, and
  the console reaches it through `public/workflow/ask.js`. A refusal is a **200
  carrying the reason**, not a 4xx: a question the layer cannot ground is a fact
  about the data, and the console renders that reason rather than an error. The
  route answers with the deterministic refusal byte-identical when Needle is
  off, unreachable or unconfident, so a deployment with no sidecar behaves
  exactly as though the adapter did not exist.

**One line**: *statistically grounded models (transparent contingency counts +
a regularised fit) score flood risk; every score is recomputable and
drift-monitored; and the platform converts model signals into action only
through pre-authorised, human-signed protocols with a full audit chain.*