/**
 * ENH-52 — anticipatory action: a forecast crossing a declared threshold fires a
 * pre-agreed action inside a funding window, with the trigger, the crossing and
 * the action all recorded.
 *
 * ── What this is a sibling of, and what it is not ───────────────────────────
 *
 * `src/parametric.js` models the same shape one level down: a rule whose
 * `trigger_threshold` is compared against a resolved metric, and which pays out
 * when it is met. That module is the *payout* vocabulary — a disbursement, a
 * chain, a contract address, an approval gate. This one is the *action*
 * vocabulary, and it is deliberately written in the sibling's own words:
 * `trigger_metric`, `trigger_operator`, `trigger_threshold`, `name`,
 * `metadata`. A reader who knows a parametric rule reads a trigger declaration
 * without a second lookup, and the two cannot drift into two names for one idea.
 *
 * What is added is the funding window and the model grounding, and those are the
 * two things a parametric payout does not carry.
 *
 * ── Why the window is the interesting constraint ────────────────────────────
 *
 * A threshold crossing is a fact about the world. Firing is a decision about
 * money. The window is what separates them: a trigger declared for the October
 * funding round that crosses in September has crossed, and it has no authority
 * to spend in September. So the crossing is recorded whenever it happens — the
 * observation is an audit fact — and `fired` is true only when the crossing
 * falls inside the window the trigger was declared with. A trigger engine that
 * ignores the window is a trigger engine that spends outside its authority, and
 * it fails in the direction nobody notices: the payout looks like a trigger
 * working.
 *
 * ── Why grounding is checked before the threshold ───────────────────────────
 *
 * ENH-50's registry is the declaration of what each model refuses with and the
 * floors that produce a refusal. A trigger declared against `flood_probability`
 * for a region with forty months of record is firing on a forecast the model
 * itself refuses to make — a number nobody computed. Checking the floors first
 * means the refusal that reaches the operator is the *model's* refusal, with its
 * own sentence, rather than a threshold comparison against an absent value. The
 * order matters because the harm is not "we compared wrongly"; it is "we spent
 * money on a refusal", and that is a different fact to record.
 *
 * ── The refusals ────────────────────────────────────────────────────────────
 *
 * Each of the six codes in `TRIGGER_REFUSALS` is a way this could do harm, and
 * each is a named state rather than a `false`. `false` and `null` are not the
 * same answer here for the same reason they are not in `evaluateTrigger`: "the
 * forecast did not cross" is a decision, and "we could not evaluate the
 * forecast" is a defect. A payout workflow that cannot tell them apart funds the
 * defect.
 *
 *   unknown_model              the trigger names a model the registry does not
 *                              carry, so there is no basis to check and no
 *                              number to fire on
 *   model_refuses_for_region   the model refuses this forecast — its floors are
 *                              missed, or it returned a refusal — so the number
 *                              the trigger would fire on was never computed
 *   threshold_not_evaluable    the forecast carries no numeric value for the
 *                              metric, so there is no condition to evaluate
 *   window_not_evaluable       the window bounds or the crossing time cannot be
 *                              read, so the crossing cannot be placed inside its
 *                              authority; refusing is the fail-safe direction
 *   outside_funding_window_before  the crossing precedes the window's open
 *   outside_funding_window_after   the crossing falls after the window's close
 *   already_fired              this exact crossing has already fired this
 *                              trigger; a trigger that fires twice funds twice
 *
 * ── Recording ───────────────────────────────────────────────────────────────
 *
 * A fired verdict carries the trigger, the crossing (its value, its threshold,
 * its time) and the action, which is what "all recorded" means. The three ways
 * this repository records things are composed rather than re-implemented:
 * `actionEvent` shapes the payload `emit` in `src/outbox.js` dispatches — and
 * because the payload carries no clock, the outbox's own
 * `stableId('outbox', [event, payload])` derives the *same id* for the same
 * crossing, so the wire dedupes on the same key the engine does; `actionLogEntry`
 * shapes the entry `chainEntry` in `src/audit-chain.js` stamps, so the record of
 * the action is tamper-evident with the rest of the log. The crossing id is the
 * one identity both halves agree on.
 */

import { OPERATORS, compare } from './alerts.js'
import { numericOrNull } from './analytics/numeric.js'
import { actorFor } from './audit-chain.js'
import { MODEL_IDS, floorsMissed, modelCard, refusalSentence } from './model-registry.js'
import { MAX_RULE_NAME } from './parametric.js'
import { nowIso, stableId } from './utils.js'

/**
 * The comparison directions, re-exported from the vocabulary `parametric.js` and
 * `alerts.js` already share.
 *
 * Not a parallel list. A trigger and a parametric rule compare the same way, and
 * two enumerations of the same six strings is the defect this repository's own
 * notes call out — the list that agrees today and drifts tomorrow.
 */
export const TRIGGER_OPERATORS = OPERATORS

/**
 * Every refusal this engine can return, in the order they are checked.
 *
 * Exported and frozen so a surface iterates it rather than re-typing the codes,
 * and so a test can assert that no evaluation path returns a code that is not
 * on this list — a refusal the engine can produce and the list omits is a state
 * no surface can explain.
 */
export const TRIGGER_REFUSALS = Object.freeze([
  'unknown_model',
  'model_refuses_for_region',
  'threshold_not_evaluable',
  'window_not_evaluable',
  'outside_funding_window_before',
  'outside_funding_window_after',
  'already_fired',
])

/**
 * ISO 4217 alphabetic codes are three uppercase letters.
 *
 * The same check `normalizeParametricRule` makes, restated because that module
 * does not export its regex. It is a format check on one field, not a number two
 * modules must agree on, so a second copy here is a smaller risk than a trigger
 * carrying `currency: 'shillings'` into a disbursement.
 */
const ISO_4217 = /^[A-Z]{3}$/

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/**
 * A trigger declaration, validated and normalised.
 *
 * Refuses at declaration anything that could not be evaluated at firing time.
 * The parametric normaliser's reasoning applies unchanged — a record persisted in
 * a form the trigger cannot be read back from is how a payout becomes a request —
 * and the funding window and the action are added to it. A trigger with no
 * window has no authority to spend; a trigger with no action fires nothing; a
 * window that closes before it opens funds nothing. All three are refused here
 * rather than discovered on the decision path.
 *
 * `model_id` must be a registered model. The registry's `modelCard` refuses an
 * unknown id rather than returning `undefined`, and this uses that refusal
 * directly: a trigger declared against a model that does not exist is a trigger
 * whose basis cannot be checked, which is the whole of what grounding means.
 */
export function normalizeAnticipatoryTrigger(input, existing = null) {
  const now = nowIso()
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('an anticipatory-action trigger must be a JSON object')
  }

  const modelId = input.model_id ?? existing?.model_id
  if (!modelId) {
    throw badRequest('model_id is required: a trigger that names no model fires on a number nobody computed')
  }
  const { card, reason } = modelCard(modelId)
  if (!card) {
    throw badRequest(`model_id must be a registered model (${MODEL_IDS.join(', ')}): ${reason}`)
  }

  const operator = input.trigger_operator ?? existing?.trigger_operator ?? '>='
  if (!OPERATORS.includes(operator)) {
    throw badRequest(`trigger_operator must be one of ${OPERATORS.join(', ')}`)
  }

  // A missing threshold and a threshold of `"abc"` are the same defect — a
  // condition nobody can evaluate — and `numericOrNull` answers both without
  // `Number(null)` turning an absent threshold into a confident zero.
  const threshold = numericOrNull(input.trigger_threshold ?? existing?.trigger_threshold)
  if (threshold === null) {
    throw badRequest('trigger_threshold is required and must be numeric: a trigger with no threshold is a condition nobody can evaluate')
  }

  const action = normalizeAction(input.action ?? existing?.action)
  const fundingWindow = normalizeFundingWindow(input.funding_window ?? existing?.funding_window)

  return {
    id: input.id || existing?.id || stableId('anticipatory_trigger', [
      input.name,
      modelId,
      operator,
      threshold,
      fundingWindow.opens_at,
    ]),
    name: triggerName(input.name, existing),
    model_id: modelId,
    trigger_metric: input.trigger_metric ?? existing?.trigger_metric ?? null,
    trigger_operator: operator,
    trigger_threshold: threshold,
    funding_window: fundingWindow,
    action,
    region: input.region ?? existing?.region ?? null,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: now,
    metadata: input.metadata || existing?.metadata || {},
  }
}

/**
 * The window, normalised to two ISO instants, with the close after the open.
 *
 * Both ends are inclusive. A crossing at the instant the window opens is inside
 * its authority, and one at the instant it closes is still inside it — a window
 * is stated to the millisecond, so a caller who means one of the ends exclusive
 * shifts the bound by a millisecond rather than relying on a convention nobody
 * wrote down. A window that closes at or before it opens is refused: it funds
 * nothing, and storing it as if it were a window is how an operator concludes
 * the trigger is armed when it can never fire.
 */
function normalizeFundingWindow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('funding_window is required: a trigger with no funding window has no authority to spend')
  }
  const openMs = Date.parse(input.opens_at)
  const closeMs = Date.parse(input.closes_at)
  if (!Number.isFinite(openMs)) {
    throw badRequest('funding_window.opens_at must be an ISO 8601 timestamp')
  }
  if (!Number.isFinite(closeMs)) {
    throw badRequest('funding_window.closes_at must be an ISO 8601 timestamp')
  }
  if (closeMs <= openMs) {
    throw badRequest('funding_window.closes_at must be after opens_at: a window that closes before it opens funds nothing')
  }
  return Object.freeze({
    opens_at: new Date(openMs).toISOString(),
    closes_at: new Date(closeMs).toISOString(),
  })
}

/**
 * The action a trigger fires.
 *
 * `type` is what happens — `pre_position_stock`, `cash_transfer`,
 * `evacuation_notice` — and is a free string because the set of pre-agreed
 * actions is the programme's, not this module's. The money fields mirror the
 * parametric disbursement's: a negative amount is refused for the same reason it
 * is there (this records money released, not recovered), and `0` is allowed
 * because an action can legitimately release nothing.
 */
function normalizeAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('action is required: a trigger that fires nothing is a notification, not an anticipatory action')
  }
  const type = String(input.type || '').trim()
  if (!type) throw badRequest('action.type is required')

  const amount = numericOrNull(input.amount_local_currency)
  if (amount !== null && amount < 0) {
    throw badRequest('action.amount_local_currency cannot be negative: this field records money released, not recovered')
  }

  const currency = String(input.currency || 'USD').trim().toUpperCase()
  if (!ISO_4217.test(currency)) {
    throw badRequest(`action.currency must be a three-letter ISO 4217 code, got "${input.currency}"`)
  }

  return Object.freeze({
    type,
    description: String(input.description || ''),
    amount_local_currency: amount,
    currency,
    recipient_group_id: input.recipient_group_id ?? null,
  })
}

/** The name ceiling `parametric.js` sets, so a trigger and a rule read alike. */
function triggerName(value, existing) {
  const name = String(value || existing?.name || 'Unnamed trigger')
  if (name.length > MAX_RULE_NAME) {
    throw badRequest(`name must be at most ${MAX_RULE_NAME} characters, got ${name.length}`)
  }
  return name
}

/**
 * The identity of one crossing.
 *
 * Derived from the trigger and the crossing's own content — the operator, the
 * threshold, the observed value and the time — with no clock of its own. That is
 * what makes re-evaluation idempotent: the same forecast crossing the same
 * threshold produces the same id, so the engine recognises the second evaluation
 * as the same event and the outbox derives the same delivery id from it. A
 * timestamp mixed in here would make every evaluation a fresh crossing, which is
 * precisely the double-fire this id exists to prevent.
 */
export function crossingId(trigger, crossing) {
  return stableId('crossing', [
    trigger?.id ?? null,
    crossing?.operator ?? null,
    crossing?.threshold ?? null,
    crossing?.value ?? null,
    crossing?.observed_at ?? null,
  ])
}

/**
 * Whether a forecast fires a trigger.
 *
 * Returns a verdict rather than a boolean, and the verdict is the record: it
 * carries the trigger that was evaluated, the crossing when one happened (the
 * value, the threshold, the time), and the action when one is fired. A caller
 * that records this object has recorded all three.
 *
 * @param {object} trigger a declaration from `normalizeAnticipatoryTrigger`
 * @param {object} forecast `{ value, observed_at, region, grounding,
 *   model_refusal }` — `grounding` carries the model's floor counts, `value` is
 *   the forecast quantity (or `metrics[trigger_metric]` when a metric is named)
 * @param {object} [options]
 * @param {Array<string>|Set<string>} [options.firedCrossings] crossing ids that
 *   have already fired. Passing the crossings a previous evaluation returned is
 *   what makes a re-evaluation idempotent; omitting them is a caller that has
 *   decided each evaluation is a fresh event.
 * @param {string} [options.at] the crossing time, overriding the forecast's own
 */
export function evaluateAnticipatoryTrigger(trigger, forecast = {}, options = {}) {
  if (!trigger || typeof trigger !== 'object') {
    throw new TypeError('evaluateAnticipatoryTrigger requires a trigger')
  }
  const { firedCrossings = [], at = null } = options
  const fired = firedCrossings instanceof Set ? firedCrossings : new Set(firedCrossings || [])
  const region = forecast?.region ?? trigger.region ?? null
  const observedAt = at || forecast?.observed_at || forecast?.forecast_at || nowIso()

  // The model, first. A trigger naming a model the registry does not carry has
  // no basis to check and no number to fire on, and `modelCard` refuses an
  // unknown id rather than handing back a blank card.
  const { card, reason: unknownReason } = modelCard(trigger.model_id)
  if (!card) {
    return notFired(trigger, region, {
      refusal: 'unknown_model',
      reason: unknownReason,
    })
  }

  // Grounding, before the threshold. A trigger that fires on a refusal spends
  // money on a number nobody computed, and the refusal that reaches the operator
  // is the model's own.
  const grounding = groundingFor(trigger, forecast)
  if (!grounding.grounded) {
    return notFired(trigger, region, {
      refusal: 'model_refuses_for_region',
      reason: grounding.reason,
      refusal_sentence: grounding.sentence,
      floors_missed: grounding.missed,
    })
  }

  const observed = resolveForecastValue(trigger, forecast)
  const value = numericOrNull(observed)
  const threshold = numericOrNull(trigger.trigger_threshold)
  if (value === null || threshold === null) {
    return notFired(trigger, region, {
      refusal: 'threshold_not_evaluable',
      reason: threshold === null
        ? 'the trigger carries no numeric threshold, so there is no condition to evaluate'
        : `the forecast's ${trigger.trigger_metric ? `metric "${trigger.trigger_metric}"` : 'value'} is ${JSON.stringify(observed)}, which is not a number -- an unevaluated trigger is not a triggered one`,
    })
  }

  const operator = trigger.trigger_operator || '>='
  const met = compare(value, operator, threshold)
  const observation = { value, threshold, operator, observed_at: observedAt, met }

  // Not crossing is not a refusal. It is the answer "no", with the observation
  // recorded so the surface can say by how much.
  if (!met) return { ...notFired(trigger, region, { reason: null }), observed: observation }

  const crossing = {
    id: crossingId(trigger, observation),
    value,
    threshold,
    operator,
    observed_at: observedAt,
  }

  // The crossing happened; whether it fires is the window's business. The
  // window is placed before idempotency because a crossing outside the window
  // never fired, so "already fired" would be a false claim about it.
  const placement = placeInWindow(trigger, observedAt)
  if (placement.refusal) {
    return { ...notFired(trigger, region, placement), observed: observation, crossing }
  }

  if (fired.has(crossing.id)) {
    return {
      ...notFired(trigger, region, {
        refusal: 'already_fired',
        reason: `crossing ${crossing.id} has already fired trigger "${trigger.name}"; a trigger that fires twice funds twice`,
      }),
      observed: observation,
      crossing,
    }
  }

  return {
    ...notFired(trigger, region, {}),
    fired: true,
    observed: observation,
    crossing,
    action: trigger.action ?? null,
  }
}

/**
 * Evaluate a declared trigger set against one forecast, in declaration order.
 *
 * Pure over its inputs and its caller's state: it returns the crossing ids that
 * have now fired, and feeding that array back in is what makes a second pass
 * over the same forecast idempotent. Nothing is mutated in place — the returned
 * set is a new array — so a caller holding the previous one can compare the two
 * and see exactly what this pass added.
 *
 * Two triggers in the set that share a crossing id (the same trigger declared
 * twice) fire once: the second sees the id the first added.
 */
export function evaluateTriggerSet(triggers = [], forecast = {}, options = {}) {
  const { firedCrossings = [], at = null } = options
  const seen = new Set(firedCrossings || [])
  const verdicts = []
  for (const trigger of triggers || []) {
    const verdict = evaluateAnticipatoryTrigger(trigger, forecast, { firedCrossings: seen, at })
    if (verdict.fired) seen.add(verdict.crossing.id)
    verdicts.push(verdict)
  }
  return { verdicts, firedCrossings: [...seen] }
}

/**
 * The outbox event a fired verdict dispatches.
 *
 * `emit(store, event, payload)` in `src/outbox.js` derives the row id from
 * `(event, payload)`, so a payload with a clock in it would give every dispatch
 * a fresh id and the wire would deliver the same action twice. This payload
 * carries only the trigger, the region, the crossing and the action — all of
 * them deterministic for a given crossing — so the engine's idempotency and the
 * outbox's are the same key, not two keys that agree by luck.
 *
 * Returns null for a verdict that did not fire: there is nothing to dispatch.
 */
export function actionEvent(verdict) {
  if (!verdict?.fired) return null
  return {
    event: 'anticipatory_action.fired',
    payload: {
      trigger_id: verdict.trigger_id,
      trigger_name: verdict.trigger_name,
      model_id: verdict.model_id,
      region: verdict.region,
      crossing: verdict.crossing,
      action: verdict.action,
    },
  }
}

/**
 * The action-log entry a fired verdict is recorded as.
 *
 * Shaped for `chainEntry` in `src/audit-chain.js`, whose `CHAINED_FIELDS` are
 * `seq, collection, record_id, action, actor, subject, summary, created_at,
 * metadata` — every field here is one of those, so the entry chains without a
 * translation step and the record of the action is as tamper-evident as the rest
 * of the log. `actorFor` resolves the actor the same way every other write path
 * does, so a body-supplied name is recorded as unattributed rather than
 * upgraded.
 *
 * Returns null for a verdict that did not fire. An entry for an action that was
 * not taken is a log line describing nothing.
 */
export function actionLogEntry(verdict, actor = null) {
  if (!verdict?.fired) return null
  const { actor: resolved, unattributed } = actorFor(actor)
  const crossing = verdict.crossing
  return {
    id: stableId('anticipatory_action', [crossing.id]),
    collection: 'anticipatory_actions',
    record_id: crossing.id,
    action: 'fire',
    actor: resolved,
    subject: verdict.action?.recipient_group_id ?? null,
    created_at: verdict.evaluated_at,
    summary: `${verdict.trigger_name} fired ${verdict.action?.type} on ${verdict.model_id} ${crossing.operator} ${crossing.threshold} (observed ${crossing.value} at ${crossing.observed_at})`,
    metadata: {
      trigger_id: verdict.trigger_id,
      model_id: verdict.model_id,
      region: verdict.region,
      crossing,
      action: verdict.action,
      funding_window: verdict.funding_window,
      unattributed,
    },
  }
}

/**
 * The empty verdict every return path starts from.
 *
 * Every field is present on every path, so a surface reads `verdict.refusal`
 * without first checking whether the key exists — an absent key and a null one
 * render the same and mean different things, which is this repository's
 * signature defect in its smallest form.
 */
function notFired(trigger, region, fields) {
  return {
    trigger_id: trigger.id ?? null,
    trigger_name: trigger.name ?? null,
    model_id: trigger.model_id ?? null,
    region: region ?? null,
    evaluated_at: nowIso(),
    fired: false,
    refusal: null,
    reason: null,
    refusal_sentence: null,
    floors_missed: [],
    observed: null,
    crossing: null,
    action: null,
    funding_window: trigger.funding_window ?? null,
    ...fields,
  }
}

/**
 * Whether the model's own floors admit this forecast.
 *
 * Two ways a model refuses, and both are refusals:
 *
 *  - it said so. `forecast.model_refusal` is the model's own refusal — the
 *    `{ score: null, reason }` shape `compound-hazard.js` returns, or a coded
 *    refusal from a model with a vocabulary. `refusalSentence` turns it into the
 *    sentence a surface renders.
 *  - its floors are missed. `floorsMissed` answers from the counts, which is
 *    what lets a caller distinguish the cases without parsing prose. An
 *    *unsupplied* count is a missed floor, not a met one: the registry says so
 *    ("not supplied, so the floor is unverified rather than met"), and a trigger
 *    that treats an unverified floor as met is the same failure as one that
 *    treats an unevaluated threshold as crossed.
 */
function groundingFor(trigger, forecast) {
  const id = trigger.model_id
  const declared = forecast?.model_refusal ?? null
  const where = forecast?.region ? ` for ${forecast.region}` : ''

  if (declared) {
    const code = typeof declared === 'object' ? (declared.code ?? null) : null
    const sentence = refusalSentence(id, code)
    const stated = typeof declared === 'object' ? (declared.reason || sentence) : String(declared)
    return {
      grounded: false,
      missed: [],
      sentence,
      reason: `${id} refused this forecast${where}: ${stated}. A trigger that fires on a refusal spends money on a number nobody computed`,
    }
  }

  const counts = forecast?.grounding ?? forecast?.observed_floors ?? null
  const missed = floorsMissed(id, counts || {})
  if (!missed.length) return { grounded: true, missed: [], sentence: null, reason: null }

  const first = missed[0]
  return {
    grounded: false,
    missed,
    sentence: refusalSentence(id),
    reason: counts
      ? `${id} refuses this forecast${where}: ${first.floor} is ${first.observed} against a floor of ${first.required} (${first.reason})`
      : `${id}'s floors were not supplied with the forecast, so they are unverified rather than met. A trigger that fires on an ungrounded forecast spends money on a number nobody computed`,
  }
}

/**
 * The forecast quantity the trigger compares.
 *
 * A trigger that names a metric reads *only* that metric: a missing key is not
 * evaluated, not silently the top-level `value`. The fallback would be the
 * silent-key-list defect in one line — a declaration naming `rainfall_anomaly`
 * would fire on whatever `value` happened to hold, and nothing would say so.
 * A trigger with no metric reads `forecast.value`.
 */
function resolveForecastValue(trigger, forecast) {
  const metric = trigger.trigger_metric ?? null
  if (!metric) return forecast?.value
  return forecast?.metrics?.[metric]
}

/**
 * Where a crossing falls against the trigger's funding window.
 *
 * Returns an empty object when the crossing is inside the window (the caller
 * then goes on to check idempotency), or `{ refusal, reason }` when it is not.
 * The two unreadable cases are checked first and both refuse: a comparison
 * against `NaN` is false in both directions, so a window or a crossing time that
 * cannot be parsed would otherwise fall straight through to the fire branch —
 * a fail-open on the one constraint that keeps the engine inside its authority.
 */
function placeInWindow(trigger, observedAt) {
  const window = trigger?.funding_window
  const openMs = Date.parse(window?.opens_at)
  const closeMs = Date.parse(window?.closes_at)
  const atMs = Date.parse(observedAt)

  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
    return {
      refusal: 'window_not_evaluable',
      reason: 'the trigger carries no readable funding window, so the crossing cannot be placed inside its authority; an unplaceable crossing does not fire',
    }
  }
  if (!Number.isFinite(atMs)) {
    return {
      refusal: 'window_not_evaluable',
      reason: `the crossing time ${JSON.stringify(observedAt)} is not a timestamp, so it cannot be placed inside the funding window`,
    }
  }
  if (atMs < openMs) {
    return {
      refusal: 'outside_funding_window_before',
      reason: `the crossing at ${observedAt} precedes the funding window's open at ${window.opens_at}; a trigger that fires before its window spends before its authority`,
    }
  }
  if (atMs > closeMs) {
    return {
      refusal: 'outside_funding_window_after',
      reason: `the crossing at ${observedAt} falls after the funding window's close at ${window.closes_at}; a trigger that fires after its window spends outside its authority`,
    }
  }
  return {}
}
