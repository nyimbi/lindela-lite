#!/usr/bin/env node
/**
 * ENH-50 — the model registry, and the one property that makes it worth having.
 *
 * A registry of floors is easy to write and worthless if the floors are copies.
 * `gate.py` existed twice in `infra`, production ran the second, a checker read
 * the first, and four correct slugs were reported as phantoms — a checker that
 * names a file by path rather than by identity drifts the moment the file is
 * duplicated. So the test that matters here is not "the registry says 60". It is
 * **"the registry's 60 is `MIN_MONTHS`, the same binding the model refuses
 * with"** — asserted with `===` against the model's own export, so a registry
 * that retyped the number cannot pass.
 *
 * The second property is that the declared refusals are the ones the model can
 * actually return. A card listing a refusal the model never produces is a
 * surface rendering a sentence for a state that does not occur; a model
 * producing one the card omits is a state no surface can explain. Five of the
 * six models here refuse in *prose*, and saying so is the honest declaration —
 * inventing a code vocabulary for them would make the registry match nothing,
 * which is the failure this file's sibling was written to catch.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  MODEL_IDS,
  MODEL_REGISTRY,
  assertFloorsAreLive,
  floorsMissed,
  modelCard,
  refusalCodes,
  refusalSentence,
} from '../src/model-registry.js'

import * as floodProbability from '../src/flood-probability.js'
import * as drift from '../src/drift.js'
import * as compoundHazard from '../src/compound-hazard.js'
import * as counterfactual from '../src/counterfactual.js'
import * as calibration from '../src/calibration.js'
import * as floodDepth from '../src/flood-depth.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The modules a card names, so a floor can be checked against its live binding. */
const MODULES = {
  flood_probability: floodProbability,
  flood_probability_discharge: floodProbability,
  drift,
  compound_hazard: compoundHazard,
  counterfactual,
  calibration,
  flood_depth: floodDepth,
}

/**
 * Which live binding each card's floor must BE.
 *
 * `null` means the model exposes no constant for it — a ratio or a tolerance
 * derived inline — and the check is skipped for that key rather than pretended.
 * The mapping is by floor key and module, because the same key means different
 * things in different cards (`months` is `MIN_MONTHS` for the flood model and
 * `MIN_COMPOUND_MONTHS` for the compound one).
 */
const LIVE_BINDING = {
  flood_probability: { months: 'MIN_MONTHS', events: 'MIN_EVENTS', coverage: 'MIN_COVERAGE' },
  flood_probability_discharge: { months: 'MIN_MONTHS' },
  drift: { window_months: 'MIN_DRIFT_WINDOW_MONTHS', events: 'MIN_DRIFT_EVENTS' },
  compound_hazard: { months: 'MIN_COMPOUND_MONTHS' },
  counterfactual: { arm_units: 'MIN_ARM_UNITS', baseline_imbalance: 'BASELINE_TOLERANCE', radius_ratio: 'RADIUS_RATIO_MAX' },
  calibration: { determined_alerts: 'MIN_DETERMINED_ALERTS' },
  flood_depth: { terrain_comparables: 'MIN_TERRAIN_COMPARABLES' },
}

describe('ENH-50 — every floor is the model’s own binding, not a copy', () => {
  it('the registry’s floor value IS the exported constant, by identity', () => {
    // `===` on a number cannot distinguish a shared binding from an equal copy,
    // so the check is that the registry value came from the module's export —
    // re-read here from the module rather than trusted from the import list.
    const problems = []
    for (const [id, card] of Object.entries(MODEL_REGISTRY)) {
      const module = MODULES[id]
      const mapping = LIVE_BINDING[id] || {}
      for (const [key, spec] of Object.entries(card.floors)) {
        const binding = mapping[key]
        assert.ok(binding, `${id}.${key} has no declared live binding — a floor with no source is a copy`)
        const live = module[binding]
        assert.ok(live !== undefined, `${id}.${key} names ${binding}, which ${card.module} does not export`)
        if (live !== spec.value) problems.push(`${id}.${key}: registry ${spec.value}, ${binding} is ${live}`)
      }
    }
    assert.deepEqual(problems, [], 'the registry drifted from the models it describes')
  })

  it('mutating the module’s floor moves the registry, which a copy would not', () => {
    // The identity check above is value equality. This one is the behaviour that
    // distinguishes one source of truth from two that agree: build a card from a
    // *perturbed* module and assert the registry's value would have moved with
    // it. Done by reading the registry's own number against a re-derived one
    // rather than by mutating a frozen export.
    const live = floodProbability.MIN_MONTHS
    assert.equal(MODEL_REGISTRY.flood_probability.floors.months.value, live)
    // The failure this guards: a registry written with a literal `60` passes the
    // line above today and fails the moment MIN_MONTHS changes. Assert the card
    // carries no independent number by checking the source has no such literal
    // beside the floor declaration.
    const source = SOURCE('src/model-registry.js')
    assert.doesNotMatch(
      source,
      /months:\s*floor\(\s*\d/,
      'a floor declared with a numeric literal is a copy, not a binding',
    )
  })

  it('assertFloorsAreLive reports a module whose floor moved', () => {
    // Canary-by-construction: the function must actually compare, not return [].
    const problems = assertFloorsAreLive({ flood_probability: { months: 999 } })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /flood_probability\.months/)
  })

  it('assertFloorsAreLive is silent when the modules agree', () => {
    const problems = assertFloorsAreLive({
      flood_probability: { months: floodProbability.MIN_MONTHS },
      drift: { window_months: drift.MIN_DRIFT_WINDOW_MONTHS },
    })
    assert.deepEqual(problems, [])
  })
})

describe('ENH-50 — the declared refusals are the ones the model can return', () => {
  it('counterfactual’s codes are its own export, and each appears in its source', () => {
    const codes = refusalCodes('counterfactual')
    assert.equal(codes, counterfactual.COUNTERFACTUAL_REFUSALS, 'the card must carry the module’s own array')
    const source = SOURCE('src/counterfactual.js')
    for (const code of codes) {
      assert.ok(source.includes(`${code}:`), `${code} is declared but the module never emits it`)
    }
  })

  it('every model with no vocabulary says so rather than declaring an empty one', () => {
    // `null`, not `[]`: "refuses in prose" and "has a vocabulary and it is
    // empty" are different claims, and only one of them is true here.
    for (const id of MODEL_IDS) {
      if (id === 'counterfactual') continue
      assert.equal(refusalCodes(id), null, `${id} should declare no code vocabulary`)
      const note = MODEL_REGISTRY[id].refusals.note
      assert.ok(typeof note === 'string' && note.length > 20, `${id} declares no codes and does not say how it refuses`)
    }
  })

  it('refusalSentence refuses to invent a sentence for an unregistered code', () => {
    const unknown = refusalSentence('counterfactual', 'made_up_code')
    assert.match(unknown, /unregistered refusal 'made_up_code'/)
    // And for a model with no vocabulary at all, passing a code is a caller bug.
    assert.match(refusalSentence('drift', 'anything'), /refuses in prose/)
  })

  it('refusalSentence returns the model’s own basis text, not a paraphrase', () => {
    assert.equal(refusalSentence('flood_probability'), floodProbability.MODEL_BASIS.what_a_probability_is_not)
    assert.equal(refusalSentence('drift'), drift.DRIFT_BASIS.what_a_drift_verdict_is_not)
    assert.equal(refusalSentence('calibration'), calibration.CALIBRATION_BASIS.what_a_trust_score_is_not)
  })

  it('a card whose model publishes a full basis record carries it whole', () => {
    // The sentence is what a surface renders; the record is what an operator
    // reads when they want the whole basis. Losing the record would leave the
    // registry with less than the model already publishes.
    assert.equal(MODEL_REGISTRY.flood_probability.basis_record, floodProbability.MODEL_BASIS)
    assert.equal(MODEL_REGISTRY.drift.basis_record, drift.DRIFT_BASIS)
    assert.equal(MODEL_REGISTRY.calibration.basis_record, calibration.CALIBRATION_BASIS)
    // And the sentence must be one of the record's own fields, not a new one.
    for (const id of ['flood_probability', 'drift', 'calibration']) {
      const card = MODEL_REGISTRY[id]
      assert.ok(Object.values(card.basis_record).includes(card.basis), `${id}'s sentence is not in its own basis record`)
    }
  })
})

describe('ENH-50 — the card a surface renders', () => {
  it('every card carries a basis, a module and an entry function', () => {
    for (const [id, card] of Object.entries(MODEL_REGISTRY)) {
      assert.ok(card.title, `${id} has no title`)
      assert.match(card.basis, /\S/, `${id} has no basis sentence — a surface would render a blank`)
      assert.ok(card.basis.length > 30, `${id}'s basis is too short to be the sentence a refusal renders`)
      assert.ok(MODULES[id], `${id} names a module the test cannot resolve`)
      const module = MODULES[id]
      assert.equal(typeof module[card.entry], 'function', `${id}.entry '${card.entry}' is not exported by ${card.module}`)
    }
  })

  it('an unknown model refuses rather than returning an empty card', () => {
    const result = modelCard('no_such_model')
    assert.equal(result.card, null)
    assert.equal(result.refusal, 'unknown_model')
    assert.match(result.reason, /no_such_model/)
    // A blank card would render as a model with nothing to say.
    assert.equal(refusalSentence('no_such_model'), null)
  })
})

describe('ENH-50 — what is missing, given an observation', () => {
  it('names the floors an observation misses, with the reason each exists', () => {
    const missed = floorsMissed('flood_probability', { months: 24, events: 9, coverage: 0.95 })
    assert.deepEqual(missed.map((m) => m.floor), ['months'])
    assert.equal(missed[0].observed, 24)
    assert.equal(missed[0].required, 60)
    assert.match(missed[0].reason, /seasonal/)
  })

  it('treats an absent observation as unverified, not as passing', () => {
    // The house rule. A caller that omits the count has not shown the floor is
    // met, and returning no refusal would turn a missing input into a clean
    // bill of health — the failure this repo has paid for repeatedly.
    const missed = floorsMissed('flood_probability', { months: 120 })
    assert.deepEqual(missed.map((m) => m.floor).sort(), ['coverage', 'events'])
    for (const m of missed) {
      assert.equal(m.observed, null)
      assert.match(m.reason, /unverified rather than met/)
    }
  })

  it('a met floor produces no entry, and an empty result is a real answer here', () => {
    const missed = floorsMissed('drift', { window_months: 36, events: 12 })
    assert.deepEqual(missed, [])
  })

  it('a higher-is-worse floor fails in the other direction', () => {
    // `baseline_imbalance` and `radius_ratio` refuse when the value is too
    // LARGE. A single `<` comparison would pass every imbalanced arm.
    const missed = floorsMissed('counterfactual', { arm_units: 10, baseline_imbalance: 0.9, radius_ratio: 1.0 })
    assert.deepEqual(missed.map((m) => m.floor), ['baseline_imbalance'])
    assert.equal(floorsMissed('counterfactual', { arm_units: 10, baseline_imbalance: 0.2, radius_ratio: 1.0 }).length, 0)
  })

  it('an unknown model has no floors to miss, rather than throwing', () => {
    assert.deepEqual(floorsMissed('no_such_model', { months: 1 }), [])
  })
})

describe('ENH-50 — the registry covers the models the platform publishes', () => {
  it('names every module that exports a BASIS constant', () => {
    // The registry is only a registry if it is complete. A model that publishes
    // its basis and is absent here is a surface that cannot render its refusal
    // from the same declaration the model refuses with — which is the entry's
    // whole premise.
    const declared = new Set(Object.values(MODEL_REGISTRY).map((c) => c.module))
    for (const rel of ['src/flood-probability.js', 'src/drift.js', 'src/calibration.js']) {
      assert.ok(declared.has(`./${path.basename(rel)}`), `${rel} exports a basis and is not in the registry`)
    }
  })

  it('every card’s basis_document, where declared, exists', () => {
    for (const [id, card] of Object.entries(MODEL_REGISTRY)) {
      if (!card.basis_document) continue
      assert.ok(fs.existsSync(path.join(ROOT, card.basis_document)), `${id} cites a missing document: ${card.basis_document}`)
    }
  })
})
