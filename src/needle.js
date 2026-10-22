/**
 * Needle — the small on-device model, asked to *propose* the slots a question
 * carries, never to answer it.
 *
 * Cactus Needle 3 is a 121M-parameter model compressed to 2.125 bits per weight
 * ("a single 8-29 MB file"), Apache-2.0, whose three jobs are tool calls,
 * grammar-constrained structured extraction, and embedding. It runs on-device,
 * in WASI, in the browser and behind a C API — and **there is no Node binding**,
 * which is the fact that shapes this whole module: it talks to a `cactus-needle`
 * sidecar over HTTP, the same way `src/narrator.js` talks to Ollama. The model
 * card is archived at `docs/research/needle3/sources/needle3-model-card.md`.
 *
 * ## What this is for, and what it must never become
 *
 * `src/nl-query.js` parses a question against a declared vocabulary and refuses
 * when it cannot ground a term. Its stated rule: "there is no model here to
 * interpret a question it was not built for." This module widens the *recall* of
 * that parse without touching the rule, because the disposal stays deterministic:
 *
 *   - Needle is asked for one tool call, `parse_question`, whose argument grammar
 *     is built from the declared vocabulary — subjects, predicates, windows, the
 *     district list. Grammar-constrained decoding means it cannot emit a value
 *     outside the enum, which is the model card's own "constraints in the
 *     grammar."
 *   - Every slot it returns is then **validated against the same vocabulary**
 *     here, by code. A subject not in `SUBJECTS` is dropped. A window not in
 *     `WINDOWS` is dropped. A region that does not resolve to a known district is
 *     dropped. This is belt-and-braces on purpose: the grammar is the model's
 *     promise and this is the code's, and the code does not take the model's.
 *   - A proposal below `NEEDLE_CONFIDENCE_FLOOR` is refused, not used. The card's
 *     confidence head exists to route on "act, confirm or refuse"; a number that
 *     does not change the outcome is a decoration.
 *   - A proposal that carries **no** score is refused too. Absence is not a
 *     high score: the card's routing needs the number, and a sidecar that omits
 *     it has not said the model is confident.
 *   - A call that **names a different tool** is refused, not reinterpreted.
 *     The model chose something this adapter did not offer, and its arguments
 *     are not a proposal about this question.
 *
 * Each of the last three was a fail-open found by probing the adapter rather
 * than by reading it: the omitted confidence skipped the threshold, and the
 * `|| calls[0]` fallback applied a call named `get_weather`. The card's own
 * "empty list rather than a guess" is the principle; these were the places the
 * adapter guessed on the model's behalf.
 *
 * So a question Needle misreads produces a *worse* parse than no model at all,
 * and never a fabricated subject — the deterministic parser still refuses.
 *
 * ## Off by default
 *
 * `LINDELA_LITE_NEEDLE=1` to enable, matching `LINDELA_LITE_NARRATOR=1` and
 * `LINDELA_LITE_TRUST_PROXY=1`. A sidecar that happens to be running is not a
 * model this deployment asked for. Off, every function here is a refusal and the
 * caller's deterministic path is exactly what it was.
 *
 * ## Refusals are data
 *
 * Nothing here throws for a transport, HTTP, JSON or model problem. Each is a
 * refusal carrying its own code, so a caller branches on `status` rather than
 * surviving an exception — the narrator's contract, kept identical.
 */

// R-77: from the leaf module, not from `./nl-query.js`. `nl-query.js` imports
// this module dynamically at `parseQueryWithModel`, so reading the vocabulary
// from there closed the fifth cycle in `src/` — the one a static-only import
// graph cannot see.
import { SUBJECTS, PREDICATES, WINDOWS } from './nl-vocabulary.js'
import { KNOWN_DISTRICTS, resolveDistrict } from './districts.js'

/**
 * The model basis, in the same voice as `NARRATOR_BASIS` and `MODEL_BASIS`: what
 * wrote the proposal, what it may do, what it must never do, how it fails.
 */
export const NEEDLE_BASIS = Object.freeze({
  basis: 'Cactus Needle 3 — 121M parameters at 2.125 bits per weight (8-29 MB), Apache-2.0, Laddered Simple Attention Network, run as a local sidecar and asked for one grammar-constrained tool call',
  serves: 'candidate slot values for a natural-language question — subject, region, window, predicates, threshold — which the deterministic parser in src/nl-query.js then validates against its own declared vocabulary',
  not: 'never a source of answers, figures or actions, and never a replacement for the parser: a slot it proposes that the vocabulary does not carry is discarded, and a question it misreads still refuses exactly as the parser refuses with no model present',
  refusals: 'needle not configured · sidecar unreachable · HTTP error · malformed JSON · empty function_calls · a call naming another tool · no confidence score · confidence below the floor · no slot survives validation',
  checked: 'every proposed slot is re-validated against SUBJECTS, PREDICATES, WINDOWS and the district list before use; the count of slots that survived ships with the proposal (slots_validated)',
})

export const NEEDLE_BASE_URL_DEFAULT = 'http://127.0.0.1:8080'
export const NEEDLE_TOOL_NAME = 'parse_question'

/**
 * Below this, a proposal is refused rather than used.
 *
 * 0.5 is a guess and is named as one: the card documents that the confidence
 * head is calibrated and meant for routing, and publishes the routing guide
 * behind a link this repository has not archived, so the threshold is a
 * conservative default an operator can move rather than a measured value
 * presented as one. The refusal names the score, so a deployment that finds it
 * too strict can see by how much.
 */
export const NEEDLE_CONFIDENCE_FLOOR = 0.5

/**
 * Needle's configuration. Off until an operator switches it on.
 *
 * `override` names the endpoint explicitly rather than through env, which is
 * what a test needs to reach a per-test sidecar on an ephemeral port. It is
 * *not* a `createServer` option — the docstring here used to say it was, and
 * `createServer` reads no `needle` key, so that sentence described a wiring
 * that did not exist. The served path (`POST /api/v1/ask`) configures the
 * adapter through `process.env`, which `answerQueryWithModel` reads when the
 * caller names no `env`.
 */
export function needleStatus(env = process.env, override = null) {
  const source = override || {}
  const enabled = source.enabled ?? String(env.LINDELA_LITE_NEEDLE || '') === '1'
  const timeoutMs = Number(source.timeoutMs ?? env.LINDELA_LITE_NEEDLE_TIMEOUT_MS ?? 5000)
  const floor = Number(source.confidenceFloor ?? env.LINDELA_LITE_NEEDLE_CONFIDENCE ?? NEEDLE_CONFIDENCE_FLOOR)
  return {
    enabled,
    base_url: String(source.baseUrl || env.NEEDLE_BASE_URL || '') || NEEDLE_BASE_URL_DEFAULT,
    timeout_ms: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    confidence_floor: Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : NEEDLE_CONFIDENCE_FLOOR,
  }
}

/** A refusal, as data. Never thrown: a question that cannot be grounded is an answer. */
function refuse(code, reason, extra = {}) {
  return { status: 'refused', code, reason, ...extra }
}

/**
 * The tool schema handed to Needle, generated from the declared vocabulary.
 *
 * Generated rather than written down, because a second copy of the vocabulary is
 * a second copy that drifts — and the drift would be silent, since a grammar
 * missing a subject still decodes to a valid-looking call. The enum is the
 * vocabulary's own keys, so adding a subject to `nl-query.js` widens the grammar
 * with no edit here.
 */
export function needleToolSchema() {
  return {
    name: NEEDLE_TOOL_NAME,
    description: 'Extract the structured query a natural-language question about hazard, alert or field data carries. Use only the enumerated values. If the question names no subject from the enum, return an empty function_calls list.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', enum: Object.keys(SUBJECTS), description: 'The single subject the question is about.' },
        region: { type: 'string', enum: KNOWN_DISTRICTS.map((d) => d.slug), description: 'The one district the question names, or omit.' },
        window: { type: 'string', enum: WINDOWS.map((w) => w.key), description: 'The time window the question names, or omit for the default.' },
        predicates: { type: 'array', items: { type: 'string', enum: Object.keys(PREDICATES) }, description: 'The conditions the question applies.' },
        threshold: { type: 'number', description: 'An explicit numeric threshold the question states, e.g. "above 70".' },
      },
      required: ['subject'],
    },
  }
}

/**
 * The request body for the sidecar's completion endpoint.
 *
 * The shape is the card's: a turn returns one JSON object with `function_calls`,
 * `reasoning` and `confidence`. `max_new_tokens` is reserved explicitly because
 * the card warns that it competes with the prefix for context, and a slot-fill
 * needs a handful of tokens rather than a paragraph.
 */
export function buildNeedleRequest(question, { tool = needleToolSchema() } = {}) {
  return {
    messages: [
      { role: 'system', content: 'You extract a structured query from a question. Emit exactly one call to parse_question, or none if no enumerated subject applies.' },
      { role: 'user', content: String(question ?? '') },
    ],
    tools: [tool],
    max_new_tokens: 128,
  }
}

/**
 * Validate one proposed slot value against the declared vocabulary.
 *
 * Returns the accepted value or `undefined`. Deliberately total and silent: a
 * rejected slot is not an error, it is a slot the model proposed and the
 * vocabulary does not carry, which is the ordinary case for a question the
 * deterministic parser was going to refuse anyway.
 */
function acceptSubject(value) {
  const key = String(value ?? '')
  return Object.hasOwn(SUBJECTS, key) ? key : undefined
}

function acceptRegion(value) {
  if (value === undefined || value === null || value === '') return undefined
  const district = resolveDistrict(String(value))
  return district ? district.slug : undefined
}

function acceptWindow(value) {
  const key = String(value ?? '')
  return WINDOWS.some((w) => w.key === key) ? key : undefined
}

function acceptPredicates(value) {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v)).filter((key) => Object.hasOwn(PREDICATES, key))
}

function acceptThreshold(value) {
  // `Number(null)` is 0 and `Number('')` is 0, so the two spellings of "the
  // model proposed no threshold" became a threshold of *zero* — which every
  // record crosses. A proposal carrying `above_threshold` and an explicit
  // `null` therefore answered "at or above 0" and matched the whole collection,
  // where the same proposal omitting the field falls back to the declared
  // default. Two spellings of one absence, two different questions, and the one
  // the sidecar actually sends is the one that widens the answer. Absence is now
  // absence; a genuine `0` stays a threshold, because "above zero" is a question
  // someone can mean.
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * Turn Needle's raw reply into a validated slot proposal, or a refusal.
 *
 * Separated from the transport so it can be tested against recorded reply
 * shapes without a socket, while the route test drives the real transport
 * against a real sidecar-shaped server — no mocks, the narrator's split.
 */
export function readNeedleProposal(reply, { confidenceFloor = NEEDLE_CONFIDENCE_FLOOR } = {}) {
  if (!reply || typeof reply !== 'object') return refuse('malformed_reply', 'the sidecar returned no JSON object')
  // `Number(null)` is 0 and `Number(undefined)` is NaN, so a sidecar that sends
  // no confidence must be told apart from one that sends a genuine zero — the
  // first is a proposal that cannot be routed, the second is the model refusing
  // its own guess. Normalising the absent spellings to NaN here is what lets the
  // single `no_confidence` branch below cover all of them.
  const absent = reply.confidence === undefined || reply.confidence === null || reply.confidence === ''
  const confidence = absent ? Number.NaN : Number(reply.confidence)
  const calls = Array.isArray(reply.function_calls) ? reply.function_calls : []
  if (!calls.length) {
    return refuse('no_function_call', 'the model returned no function call, which for an off-topic question is its documented answer rather than a failure', { confidence: Number.isFinite(confidence) ? confidence : null })
  }
  // Three shapes reach here and only two of them are ours. The card's Python
  // API returns a call with no `name` at all (the turn is the call), and an
  // OpenAI-shaped sidecar nests it under `function`. A call that *names* a
  // different tool is a third thing: the model chose something else, and
  // reading its arguments as ours would be the adapter inventing a proposal the
  // model did not make. The old `|| calls[0]` did exactly that, and it also
  // swallowed a turn whose `function_calls` held only unrelated tools.
  const named = (c) => String(c?.name ?? c?.function?.name ?? '')
  const call = calls.find((c) => named(c) === NEEDLE_TOOL_NAME)
    ?? calls.find((c) => named(c) === '')
  if (!call) {
    const offered = calls.map(named).filter(Boolean).join(', ')
    return refuse('unexpected_tool', `the model called ${offered || 'no named tool'}, which is not ${NEEDLE_TOOL_NAME}`, { confidence })
  }
  const raw = call?.arguments ?? call?.function?.arguments ?? call?.parameters
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { return refuse('malformed_arguments', 'the function call\'s arguments were not valid JSON') }
  }
  if (!args || typeof args !== 'object') return refuse('malformed_arguments', 'the function call carried no arguments object')

  // The confidence check is after the call is found and before any slot is used:
  // a low-confidence call is refused whole, not partially applied, because half
  // a parse is the failure mode this module exists to avoid.
  //
  // An absent score is its own refusal, not a pass. `Number(undefined)` is NaN
  // and `Number(null)` is 0, so the two spellings of "the sidecar sent no
  // confidence" used to reach opposite verdicts: the omitted one skipped this
  // check entirely and the call was applied, while the null one was refused as
  // `low_confidence` with a reason naming a score the model never sent. The
  // omitted spelling is the one a sidecar written against the card's *Python*
  // turn shape produces, so the fail-open direction was the likely one. The
  // card's confidence head exists to route on act/confirm/refuse; a proposal
  // that arrives without it cannot be routed and is not used.
  if (!Number.isFinite(confidence)) {
    return refuse('no_confidence', 'the sidecar returned no confidence score, so the proposal cannot be routed on act, confirm or refuse')
  }
  if (confidence < confidenceFloor) {
    return refuse('low_confidence', `the model's confidence ${confidence} is below the floor ${confidenceFloor}; its own routing guide reserves this band for confirm-or-refuse`, { confidence })
  }

  const subject = acceptSubject(args.subject)
  if (!subject) {
    return refuse('unknown_subject', `the model proposed subject '${String(args.subject ?? '')}', which the declared vocabulary does not carry`, { confidence: Number.isFinite(confidence) ? confidence : null })
  }

  const slots = {
    subject,
    region: acceptRegion(args.region) ?? null,
    window: acceptWindow(args.window),
    predicates: acceptPredicates(args.predicates),
    threshold: acceptThreshold(args.threshold) ?? null,
  }
  // The count a reader can check the validation actually ran: a proposal whose
  // every slot survived reports 5, one the model padded with unknown predicates
  // reports fewer, and a caller can see the difference.
  const slotsValidated = 1
    + (slots.region ? 1 : 0)
    + (slots.window ? 1 : 0)
    + (slots.predicates.length ? 1 : 0)
    + (slots.threshold !== null ? 1 : 0)

  return {
    status: 'proposed',
    ...slots,
    // Always finite here: a non-finite score refused above, so a `proposed`
    // result carries the number the threshold was applied to.
    confidence,
    reasoning: String(reply.reasoning ?? ''),
    slots_validated: slotsValidated,
  }
}

/**
 * Ask the sidecar for a proposal, then validate it.
 *
 * `http` is the transport (undici's fetch by default); an injected transport
 * exists so a unit test can shape replies without a socket, while the test below
 * runs the REAL transport against a real sidecar-shaped server — no mocks.
 *
 * Never throws for model/transport problems: a refusal is data, returned. A
 * disabled Needle is the first refusal and costs nothing.
 */
export async function proposeSlots(question, {
  env = process.env, needle = null, http: transport = fetch,
} = {}) {
  const config = needleStatus(env, needle)
  if (!config.enabled) {
    return refuse('not_configured', 'Needle is off; set LINDELA_LITE_NEEDLE=1 and run a cactus-needle sidecar to enable it')
  }
  const url = `${config.base_url.replace(/\/+$/, '')}/v1/chat/completions`
  let response
  try {
    response = await transport(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildNeedleRequest(question)),
      signal: AbortSignal.timeout(config.timeout_ms),
    })
  } catch (error) {
    return refuse('unreachable', `the Needle sidecar at ${config.base_url} could not be reached: ${error?.message || error}`)
  }
  if (!response?.ok) {
    return refuse('http_error', `the Needle sidecar answered ${response?.status ?? 'no status'}`)
  }
  let reply
  try {
    reply = await response.json()
  } catch (error) {
    return refuse('malformed_reply', `the sidecar's reply was not valid JSON: ${error?.message || error}`)
  }
  // An OpenAI-shaped sidecar wraps the turn in `choices[0].message`; the card's
  // Python API returns the turn directly. Accept both rather than forcing one
  // shape on a process this repository does not own.
  const turn = reply?.choices?.[0]?.message ?? reply
  const normalised = turn?.function_calls ? turn : { ...turn, function_calls: turn?.tool_calls }
  return readNeedleProposal(normalised, { confidenceFloor: config.confidence_floor })
}
