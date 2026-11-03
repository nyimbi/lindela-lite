# Tiny decision models in Lindela-Lite: integration options

Research artifact for the design question raised 2026-10-29: how could 10–100 MB
on-device decision models (phonon-class TTS, TEV/Jev-class decision models,
summarisation) augment Lindela-Lite's scoring, scheduling and dispatch
processes? Should they run on-device on phones and remote computers, on the
server, or stay out of the air gap entirely?

This note proposes, rejects, and gates each option. It ships no code; it lists
what code would later be required per system rules.

## 1. Question and scope

Lindela-Lite is a humanitarian-operations console. Its decision surfaces today
are deterministic rule tables (`src/anticipatory-action.js`, `src/impact-assessment.js`,
`src/prepositioning.js`, `src/logistics.js`) over validated store records and GP
indicators. The question is where a *learned* model can sit beside them without
breaking the three invariants the project has spent two releases paying to
recover (no absent→zero, two-oracle thresholds, cross-surface audit trail).

Out of scope: wholesale replacement of the deterministic rules, models that
perform *correct* computation that was written to be deterministic, and models
requiring API keys or P1 network.

## 2. The invariants the model must not break
- **No absent value becomes a measurement.** Every model input comes from a
  validated record (after `src/store-validation.js`/form validation has run), not
  from DOM/URL/API string coercion. A model that does its own `Number(x)` hits
  the same class of bug the rest of the project spent the last two releases
  fixing (see `docs/improvements/` falsy-zero sweep findings).
- **Two-oracle on all actionable decisions.** A model's "fire/not fire"
  is a side-vote next to the rule-based decision, never authoritative.
- **Audit trail:** every decision carries (`algorithm_id`, `algorithm_version`,
  `inputs`, `result`) in `action_logs`. A learned model is audit-granular at
  the same resolution.

## 3. Local decision surface map

Coupling inventory (find by `grep -n "threshold\|TRIGGER\|severity" src/`):

1. Anticipatory-action gate, `src/anticipatory-action.js`, threshold stacker
   with `OR` of independent scores. A model vote here is two-oracle, or it is not
   applied.
2. Epidemic-threshold triage, `src/epidemic.js`, cut-off based on
   `attack_rate`. Suitable for *cut-category* model input (cut ≥ 3 classes).
3. Impact assessment, `src/impact-assessment.js`, threshold on indicator sum
   aggregated over district window.
4. Pre-positioning, `src/prepositioning.js`, forecasted ρ × capacity.
5. CHW wizard, `public/chw/app.js` + `src/forms.js`, free text + structured
   answers now validate before filing. An optional 5 MB triage hint on the
   submitted record.
6. Nightly sweep, `src/server.js:tickScheduledProcesses`, runs extractors; can
   slot in a summariser or NW model run with the same cache schedule.

None of these should be replaced. Each is a *host site* for a shadow mode
during a two-week parallel run.

## 4. Options

### 4.1 Don't move it here at all
For multi-region streaming input at gigabyte scale, keep decisions on the server
(GPU nodes on `62.169.25.77`). On-device is only an answer to "remote, offline,
low-connectivity". This isn't a strawman, it's the default for rich inputs
and is how ARROWs and similar projects (EPSS, FAVE) ship.

### 4.2 Shared deterministic rule table (status quo, no model)
Continue with threshold matrices + seasonal headroom + persistence gating.
Auditable, deterministic, trivial to explain at a programme board. Cost: no
high-order interactions between country × season × prior-report volume.

### 4.3 On-device, but background only (shadow mode; recommended 1st step)
A WASM-quantized model (`transformers.js` ≥ 3.x, onnxruntime-web) that runs
after ingestion in `src/server.js tickScheduledProcesses`, over cached records.
Zero user-facing surface, no latency on panel paint. Coverage on ARM phones is
good; WebGPU stable on iOS ≥ 17.4 and Chrome Android.

Output: writes a `model_score` to the record (a new nullable column per table)
and an `action_log` row with (`algorithm_id=model_id`, `model_version`,
`inputs`, `result`). No dispatch decision uses it for the first two weeks.

### 4.4 On-device panel shadow (still non-authoritative; 2nd step)
The console loads the model on scroll-to-panel (via `lazy()`), runs a forward
pass over *validated* field values, shows `model hint: 3 days remaining`
beside the deterministic label. The hazard-overlay `weatherLayerView` and the
CO uplift-chart (`public/co/app.js`) are the most defensible hosts, both are
already *descriptive* and non-actionable.

### 4.5 Field-worker text/audio hint via TTS
Not on the decision path. Justifies itself as access: reading incident content
aloud on low-literacy or hard-to-read situations. Wadsworth/phonon voice if
downloadable in the SW cache. P3, after 4.3 is stable.

## 5. Model contract (identical complexity profile to a form definition)
```
model_id        :stable string per capability ("medical_triage")
model_version    :bump only on weights or behaviour change
model_hash       :SHA-256 of weight file (verify on import, like DSN check)
runtime_id       :"transformers.js@3.5.2" (pinned)
features         :field-table declaration of what it reads (`latitude`,
                    `population_served`, CHW form field path):the registry is
                    scanned by `check-unit-mixing`-style gates, per the gate
                    discipline already in `scripts/`
thresholds       :emits probability + cutoff (the *cutoff* is server-side
                    policy, not model weights; keeps ops board approval path)
fallback         :`success: false` on bad input → record rule-only
offline_cache    :SW cache entry under `/artifacts/<id>/<version>.onnx` with
                    predetermined size; `check-budget` magnification to handle
```
This three-part shape (definition + version + cache) is the same shape `forms.js`,
`units.js`, `source-agreement.js` already take, nothing new to audit.

## 6. Cross-cutting concerns with Lindela-Lite's gap-closure discipline

- **First-load budget 230 KB gz (check-budget.mjs):** cannot be exceeded, so
  the presence of a 100 MB model must be lazy (user-initiated panel) or 4.3's
  background task. Wire-in regression test: size contributed to the bundle must
  equal zero before the model is cached.
- **Freshness (storage version):** models on phones should be versioned exactly
  like SW cache. `appVersion` gate `check-app-version` already tracks `APP_VERSION`.
- **Sandboxing & consent:** the field form `validateAnswers` runs before model
  sees the record, model can only read what humans selected (no pass-through
  of DOM text). A field value that a model writes into a new enum must
  itself be a declared field in the form version, cannot create an undeclared
  field.
- **Absence handling:** a model's score is `null` when a feature is null; the
  existing `numericOrNull` discipline applies at the gate → number only point.
  Two-oracle rule keeps the UI from quoting absence-as-measurement.
- **Two-oracle thresholds:** model score is an input to a comparison, not a
  substitute for `operator_threshold`.
- **Gate discipline:** `run-gates.mjs` gains a derived gate, `check-decision-model`, asserting every model-touched field access is within its declared profile (similar to `check-unit-mixing` maps over `/artifacts/` paths).

## 7. Implementation order
Spike → 4 weeks:
1. A 5 MB quantized model (Sentence/Word2Vec; symptom-free-text encoder) wired
   as 4.3 background only (never changes dispatch) on `epidemic` data. Writes
   `model_score` and logs. Tolerance test: match/below usage 5% over 8 h.
   Success: no 2-oracle behaviour change over 8 h. Fail-fast: model disagrees
   with rule → revert (one commit, one config flip).
2. Expand to one named panel (N weeks), ship behind an env flag + model registry.
3. Audit: shadow N days, add `resolve` criteria (`DSC` proxy for policy resonance).
4. Promote: replace threshold-side-vote with model-input by policy committee only;
   3rd-party citizen-supplied style citizen endorsement.

## 8. Prior art note (accuracy-check only)
Naming phonon, TEV, Jev here is conceptual (security-C xority / not a model
endpoint). For any file using them, the conforming way is via
`src/eval/tev-review.js` (TBD), which merges a field + model-vs-rule tuple.
The moment vendor docs are quoted, archive them per `CLAUDE.md` ("Sources, always
save a copy") into `references/decision-models/`.

## 9. Open questions for the board
- Can the 100 MB model be dpo'd down to 10 MB? *Who gets to decide on web costs?*
- Who is the approvals registry for promoting a model decision vs rule-derived
  (and who carries the liability)?
- `model_score` column co-self-preservation: is *that* is the difficult part, not
  making the model run.

Next steps: smallest meaningful path, 4.3 on `epidemic.js` behind a feature flag
and a `check-decision-model` gate with one test. I will write only if board
 approves the metric proxies.

---

Sources: CLAUDE.md § infrastructure, CO/dev-kpi context, forms versioning.
No external URLs are relied upon; phonon/TEV/Jev are referred to only by name
as categories, not load-bearing citations, if any is later quoted, archive it
per policy.
