# Research: Cactus Needle 3, and where it belongs in Lindela Lite

**Date: 2026-10-13.** Question: the user asked how the Cactus Needle 3 model
could be used here, then asked for it integrated deeply. This records what the
model is, the two places it genuinely fits, the one it does not, and what was
built.

## What it is (from the archived model card)

| Property | Value | Source |
|---|---|---|
| Parameters | 121M in the shipped 20-layer model; every depth from 2 to 20 is deployable, the fine-tuned 4-layer subnetwork "starts at 29M" | card §intro |
| Quantisation | CQ2, "2.125 bits per weight" | card §intro |
| File size | "a single 8-29 MB file" across the ladder | card §intro |
| License | Apache-2.0 | card frontmatter |
| Architecture | "Laddered Simple Attention Network": Monarch Hadamard MLP in place of the FFN, GQA attention with causal conv taps, engram n-gram memory read by gather, multi-lane hyper-connections | card §intro |
| Package | `pip install cactus-needle`, import `needle` | card §Get started |
| Runtimes | Python, WASI component, browser, C API, CLI runner; one engine per platform loads `needle3.cact` | card §intro, §devices guide |
| Output | one JSON object per turn: `function_calls`, `reasoning`, calibrated `confidence` | card §Get started |
| Tasks | tool calls, structured extraction (grammar-constrained), text embedding (`needle_embed`) | card §intro, §guides |
| Refusal | "an off-topic request returns an empty list rather than a guess" | card §Get started |

**There is no Node.js or npm binding.** The runtimes are Python, WASI, browser
and C. This is the fact that decides the whole integration: a Node service cannot
`import needle`, so any use here is either a sidecar process over HTTP or a WASM
component, never an in-process dependency.

## Where it fits

### 1. Slot-filling for `src/nl-query.js` — the real fit

`nl-query.js` is a deterministic parser over a declared vocabulary
(`SUBJECTS`, `PREDICATES`, `WINDOWS`, the district list). It refuses when a
question carries no subject it knows. Its stated design rule is that it "reads a
declared vocabulary and nothing else; there is no model here to interpret a
question it was not built for."

Needle fills exactly that gap without violating the rule, because the *disposal*
stays deterministic: Needle proposes `{subject, region, window, predicates,
threshold}` as a tool call whose argument grammar is generated from the declared
vocabulary, and `parseQuery` still validates every slot against the vocabulary
and still refuses an unknown one. Needle widens the *recall* of the parse; it does
not get to invent a subject. The grammar-constrained decoding is what makes this
safe — the card's own extraction guide: "constraints in the grammar."

### 2. Offline narration — the secondary fit

`src/narrator.js` needs a reachable Ollama server (`127.0.0.1:11434` by default)
running `qwen3:0.6b`. An 8-29 MB WASM model could narrate on a disconnected
tablet with no server at all. The existing fact-audit (`allowedNumbers`) applies
unchanged — the audit is on the *output*, and it does not care what wrote it.

### 3. Embedding — speculative, not built

`needle_embed` could route a question to a collection. But the vocabulary is
seven subjects and the mapping is already a lookup, so this solves a problem the
platform does not have. Recorded and rejected.

## Where it does not fit

- **Not in the request path.** A 121M model, even at 8-29 MB, is not something to
  put in front of every request. Opt-in, off by default, like the narrator.
- **Not as an npm dependency.** There is no npm binding, and the repo's posture is
  zero runtime dependencies beyond `pg`. A sidecar is the honest shape.
- **Not as a replacement for the deterministic parser.** The parser's refusals are
  the feature. Needle feeds it candidates; it does not replace it.

## What was built

`src/needle.js` — an adapter, modelled on `src/narrator.js`:

- **Off by default.** `LINDELA_LITE_NEEDLE=1` to enable, matching the narrator's
  `LINDELA_LITE_NARRATOR=1` and `LINDELA_LITE_TRUST_PROXY=1` opt-in pattern.
- **Sidecar over HTTP.** It talks to a `cactus-needle` server process, because
  that is the only binding that exists. The endpoint is configurable.
- **Refusals are data, never thrown.** Unreachable sidecar, HTTP error, malformed
  JSON, empty `function_calls`, a missing confidence score, and a low one are
  each a refusal with its own code — the narrator's contract.
- **Every slot is validated against the declared vocabulary before it is used.**
  This is the load-bearing property: Needle proposes, `nl-query` disposes. A slot
  naming a subject not in `SUBJECTS` is dropped, and if that leaves no subject the
  parse refuses exactly as it does today.
- **Confidence is a threshold, not a decoration.** Below
  `NEEDLE_CONFIDENCE_FLOOR` the proposal is refused rather than used, which is
  the card's own "routing on act, confirm or refuse."

`src/nl-query.js` gains `parseQueryWithModel`, which tries Needle for a question
the deterministic parse refused with `unknown_subject`, and falls back to the
deterministic refusal when Needle is off, unreachable, or unconfident. The
deterministic path is unchanged and remains the default.

## What this is not

It is not a claim that Needle is *enabled*. It is off unless
`LINDELA_LITE_NEEDLE=1` and a `cactus-needle` sidecar answers on
`NEEDLE_BASE_URL`; with it off, unreachable or unconfident, the deterministic
refusal is returned byte-identical and the route behaves as though the adapter
did not exist. That is the property that makes it safe to ship the caller.

**Wired 2026-10-13.** `nl-query.js` is no longer reachable from nothing:
`POST /api/v1/ask` (`src/routes/ask.js`) serves it, calling
`answerQueryWithModel` so a Needle-proposed subject runs the same grounding audit
as a deterministically parsed one. The console reaches the route through
`public/workflow/ask.js`. The route that would expose it was the separate item
this section used to name, and it is now built.

## Sources

| File | What it is | Retrieved |
|---|---|---|
| `sources/needle3-model-card.md` | The HuggingFace model card for `Cactus-Compute/needle3`, the source of every figure in the table above | 2026-10-13 from `https://huggingface.co/Cactus-Compute/needle3/raw/main/README.md` |
