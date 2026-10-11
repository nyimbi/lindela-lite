import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  TRIGGER_OPERATORS,
  TRIGGER_REFUSALS,
  actionEvent,
  actionLogEntry,
  crossingId,
  evaluateAnticipatoryTrigger,
  evaluateTriggerSet,
  normalizeAnticipatoryTrigger,
} from '../src/anticipatory-action.js'
import { CHAINED_FIELDS, chainEntries, verifyChain } from '../src/audit-chain.js'
import { MODEL_IDS } from '../src/model-registry.js'
import { MAX_RULE_NAME } from '../src/parametric.js'

/**
 * ENH-52 — the anticipatory-action trigger engine.
 *
 * The tests are written against the two claims the entry makes and the five
 * ways the requirement says this could do harm.
 *
 *  1. A crossing fires an action, and the trigger, the crossing and the action
 *     are all in the verdict — that is what "all recorded" means.
 *  2. The funding window is the authority. A crossing outside it has crossed and
 *     does not fire, and the verdict says which side of the window it fell on.
 *
 * The refusals are each a state, not a `false`: an unknown model, a model that
 * refuses the region, an unevaluable threshold, an unplaceable window, and a
 * double-fire. `false` and `null` are not the same answer here for the same
 * reason they are not in `evaluateTrigger`.
 *
 * Every number is hand-derivable: the window is October 2026, the model is
 * `flood_probability` whose floors are 60 months, 5 flood-label months and 0.9
 * coverage, and the thresholds are chosen so a reader can check the comparison
 * without running anything.
 */

const WINDOW = { opens_at: '2026-10-01T00:00:00.000Z', closes_at: '2026-10-31T23:59:59.000Z' }

/** A grounded forecast for flood_probability — every floor met with room to spare. */
const GROUNDED = { months: 96, events: 12, coverage: 1 }

const trigger = (over = {}) => normalizeAnticipatoryTrigger({
  name: 'Turkana flood anticipatory action',
  model_id: 'flood_probability',
  trigger_metric: 'rainfall_anomaly',
  trigger_operator: '>=',
  trigger_threshold: 0.8,
  funding_window: WINDOW,
  action: {
    type: 'pre_position_stock',
    description: 'Stage 400 hygiene kits in Lodwar',
    amount_local_currency: 1_800_000,
    currency: 'KES',
    recipient_group_id: 'grp_turkana',
  },
  region: 'Turkana',
  ...over,
})

/** A forecast that crosses the default trigger's threshold, inside the window. */
const crossingForecast = (over = {}) => ({
  metrics: { rainfall_anomaly: 1.4 },
  observed_at: '2026-10-12T00:00:00.000Z',
  region: 'Turkana',
  grounding: GROUNDED,
  ...over,
})

describe('a crossing fires the declared action, and all three are recorded', () => {
  it('fires when the forecast crosses inside the window', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast())
    assert.equal(verdict.fired, true)
    assert.equal(verdict.refusal, null)
    // The trigger.
    assert.equal(verdict.trigger_name, 'Turkana flood anticipatory action')
    assert.equal(verdict.model_id, 'flood_probability')
    // The crossing: the value, the threshold, the time.
    assert.equal(verdict.crossing.value, 1.4)
    assert.equal(verdict.crossing.threshold, 0.8)
    assert.equal(verdict.crossing.observed_at, '2026-10-12T00:00:00.000Z')
    // The action.
    assert.equal(verdict.action.type, 'pre_position_stock')
    assert.equal(verdict.action.amount_local_currency, 1_800_000)
  })

  it('does not fire when the forecast does not cross, and records the observation', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ metrics: { rainfall_anomaly: 0.3 } }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, null, 'not crossing is the answer "no", not a refusal')
    assert.equal(verdict.observed.met, false)
    assert.equal(verdict.observed.value, 0.3)
    assert.equal(verdict.crossing, null)
  })

  it('reads only the metric the trigger names, never a top-level value', () => {
    // The trigger names rainfall_anomaly; a `value` of 9 must not stand in for it.
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ metrics: {}, value: 9 }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'threshold_not_evaluable')
  })

  it('honours the comparison direction', () => {
    const below = trigger({ trigger_operator: '<=' })
    assert.equal(evaluateAnticipatoryTrigger(below, crossingForecast({ metrics: { rainfall_anomaly: 0.4 } })).fired, true)
    assert.equal(evaluateAnticipatoryTrigger(below, crossingForecast({ metrics: { rainfall_anomaly: 1.4 } })).fired, false)
    // The operator vocabulary is the sibling's, not a parallel list.
    assert.deepEqual(TRIGGER_OPERATORS, ['>', '>=', '<', '<=', '==', '!='])
  })
})

describe('the funding window is the authority', () => {
  it('does not fire a crossing that precedes the window, and says so', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: '2026-09-30T23:59:59.000Z' }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'outside_funding_window_before')
    // The crossing is still recorded: it happened, it just had no authority.
    assert.equal(verdict.crossing.value, 1.4)
    assert.equal(verdict.action, null)
  })

  it('does not fire a crossing after the window, and says so', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: '2026-11-01T00:00:00.000Z' }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'outside_funding_window_after')
    assert.equal(verdict.crossing.value, 1.4)
  })

  it('treats both window ends as inclusive', () => {
    assert.equal(evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: WINDOW.opens_at })).fired, true)
    assert.equal(evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: WINDOW.closes_at })).fired, true)
  })

  it('refuses rather than firing when the window cannot be read', () => {
    // A window the normaliser would reject, injected directly. `NaN` compares
    // false in both directions, so an unreadable window would fall through to
    // the fire branch if it were not checked first.
    const broken = { ...trigger(), funding_window: { opens_at: 'not-a-date', closes_at: '2026-10-31T00:00:00.000Z' } }
    const verdict = evaluateAnticipatoryTrigger(broken, crossingForecast())
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'window_not_evaluable')
  })

  it('refuses when the crossing time cannot be read', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: 'sometime' }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'window_not_evaluable')
  })
})

describe('grounding: a trigger cannot fire on a model that refuses for the region', () => {
  it('refuses when the model declares a refusal for the forecast', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({
      model_refusal: { score: null, reason: 'only 40 month(s) of record; 60 are needed' },
    }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'model_refuses_for_region')
    // The sentence that reaches the operator is the model's own, from the registry.
    assert.ok(verdict.refusal_sentence, 'a surface renders the registry sentence, not a paraphrase')
    assert.match(verdict.reason, /number nobody computed/)
  })

  it('refuses when a floor is missed, and names it', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({
      grounding: { months: 40, events: 12, coverage: 1 },
    }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'model_refuses_for_region')
    assert.equal(verdict.floors_missed.length, 1)
    assert.equal(verdict.floors_missed[0].floor, 'months')
    assert.equal(verdict.floors_missed[0].required, 60)
  })

  it('refuses when the floors are not supplied at all: unverified is not met', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast({ grounding: undefined }))
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'model_refuses_for_region')
    assert.equal(verdict.floors_missed[0].reason, 'not supplied, so the floor is unverified rather than met')
  })

  it('refuses a trigger naming a model the registry does not carry', () => {
    const rogue = { ...trigger(), model_id: 'crystal_ball' }
    const verdict = evaluateAnticipatoryTrigger(rogue, crossingForecast())
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'unknown_model')
    assert.match(verdict.reason, /not a registered model/)
  })

  it('refuses at declaration, before any forecast, a model that is not registered', () => {
    assert.throws(() => trigger({ model_id: 'crystal_ball' }), /model_id must be a registered model/)
    // And every registered id is accepted, so the check is not a short list.
    for (const id of MODEL_IDS) {
      assert.equal(normalizeAnticipatoryTrigger({ model_id: id, trigger_threshold: 1, funding_window: WINDOW, action: { type: 'x' } }).model_id, id)
    }
  })
})

describe('idempotency: a trigger that fires twice funds twice', () => {
  it('re-evaluating the same crossing refuses as already fired', () => {
    const t = trigger()
    const forecast = crossingForecast()
    const first = evaluateAnticipatoryTrigger(t, forecast)
    assert.equal(first.fired, true)

    // The caller hands back the crossings the first pass returned — no store.
    const second = evaluateAnticipatoryTrigger(t, forecast, { firedCrossings: [first.crossing.id] })
    assert.equal(second.fired, false)
    assert.equal(second.refusal, 'already_fired')
    assert.equal(second.crossing.id, first.crossing.id, 'the same crossing has the same id')
  })

  it('a different crossing of the same trigger still fires', () => {
    const t = trigger()
    const first = evaluateAnticipatoryTrigger(t, crossingForecast())
    const moved = crossingForecast({ metrics: { rainfall_anomaly: 2.1 } })
    const second = evaluateAnticipatoryTrigger(t, moved, { firedCrossings: [first.crossing.id] })
    assert.equal(second.fired, true)
    assert.notEqual(second.crossing.id, first.crossing.id)
  })

  it('the crossing id carries no clock of its own', () => {
    const t = trigger()
    const a = crossingId(t, { operator: '>=', threshold: 0.8, value: 1.4, observed_at: '2026-10-12T00:00:00.000Z' })
    const b = crossingId(t, { operator: '>=', threshold: 0.8, value: 1.4, observed_at: '2026-10-12T00:00:00.000Z' })
    assert.equal(a, b)
  })

  it('a set with the same trigger twice fires once', () => {
    const t = trigger()
    const { verdicts, firedCrossings } = evaluateTriggerSet([t, { ...t }], crossingForecast())
    assert.equal(verdicts[0].fired, true)
    assert.equal(verdicts[1].refusal, 'already_fired')
    assert.equal(firedCrossings.length, 1)
  })

  it('the outbox payload is clock-free, so the wire dedupes on the same crossing', () => {
    const t = trigger()
    const first = evaluateAnticipatoryTrigger(t, crossingForecast())
    // Same crossing, evaluated at a later wall-clock instant.
    const second = evaluateAnticipatoryTrigger(t, crossingForecast())
    const a = actionEvent(first)
    const b = actionEvent(second)
    assert.deepEqual(a.payload, b.payload, 'nothing in the payload varies between two evaluations of one crossing')
    assert.equal(a.event, 'anticipatory_action.fired')
    assert.equal(actionEvent({ fired: false }), null)
  })
})

describe('the action is recorded in a chainable entry', () => {
  it('shapes an action-log entry the audit chain can stamp', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast())
    const entry = actionLogEntry(verdict, { auth: { subject: 'sha256:abc' } })
    // Every field the chain commits to that the entry itself supplies is
    // present, so no translation step. `seq` is excluded because `chainEntry`
    // stamps it — the entry is the record before chaining.
    for (const field of CHAINED_FIELDS.filter((f) => f !== 'seq')) {
      assert.ok(field in entry, `action-log entry is missing chained field ${field}`)
    }
    assert.equal(entry.action, 'fire')
    assert.equal(entry.subject, 'grp_turkana')
    assert.equal(entry.metadata.crossing.value, 1.4)
  })

  it('chains and verifies, and a re-chain is detectable', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast())
    const entry = actionLogEntry(verdict, 'field-officer')
    const { entries, head } = chainEntries([entry])
    assert.equal(verifyChain(entries, { expectedHead: head.hash }).verified, true)

    // Tamper the summary and the head no longer matches.
    const tampered = [{ ...entries[0], summary: 'nothing happened' }]
    const result = verifyChain(tampered, { expectedHead: head.hash })
    assert.equal(result.verified, false)
    assert.equal(result.anchored, true)
  })

  it('records an unattributed actor as unattributed rather than trusting the name', () => {
    const verdict = evaluateAnticipatoryTrigger(trigger(), crossingForecast())
    assert.equal(actionLogEntry(verdict, 'field-officer').metadata.unattributed, true)
    assert.equal(actionLogEntry({ fired: false }), null)
  })
})

describe('the declaration refuses what could not be evaluated later', () => {
  it('refuses a non-numeric threshold at declaration', () => {
    assert.throws(() => trigger({ trigger_threshold: 'abc' }), /threshold is required and must be numeric/)
    assert.throws(() => trigger({ trigger_threshold: null }), /threshold is required and must be numeric/)
  })

  it('refuses a window that closes before it opens', () => {
    assert.throws(() => trigger({ funding_window: { opens_at: '2026-10-31T00:00:00.000Z', closes_at: '2026-10-01T00:00:00.000Z' } }), /closes_at must be after opens_at/)
    assert.throws(() => trigger({ funding_window: undefined }), /funding_window is required/)
  })

  it('refuses an action with no type, a negative amount, or a bad currency', () => {
    assert.throws(() => trigger({ action: { description: 'no type' } }), /action.type is required/)
    assert.throws(() => trigger({ action: { type: 'cash', amount_local_currency: -1 } }), /cannot be negative/)
    assert.throws(() => trigger({ action: { type: 'cash', currency: 'shillings' } }), /ISO 4217/)
  })

  it('keeps the name ceiling the parametric rule uses', () => {
    assert.throws(() => trigger({ name: 'x'.repeat(MAX_RULE_NAME + 1) }), /at most 120 characters/)
  })

  it('every refusal the engine can return is declared in TRIGGER_REFUSALS', () => {
    // One case per code, so a new branch that invents a code fails here.
    const produced = [
      evaluateAnticipatoryTrigger({ ...trigger(), model_id: 'nope' }, crossingForecast()).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast({ model_refusal: { reason: 'no' } })).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast({ metrics: {} })).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: 'x' })).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: '2026-09-01T00:00:00.000Z' })).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast({ observed_at: '2026-12-01T00:00:00.000Z' })).refusal,
      evaluateAnticipatoryTrigger(trigger(), crossingForecast(), { firedCrossings: [crossingId(trigger(), { operator: '>=', threshold: 0.8, value: 1.4, observed_at: '2026-10-12T00:00:00.000Z' })] }).refusal,
    ]
    assert.deepEqual([...new Set(produced)].sort(), [...TRIGGER_REFUSALS].sort())
  })
})
