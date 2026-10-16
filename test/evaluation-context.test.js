#!/usr/bin/env node
/**
 * R-95 — every metric path the operator-facing picker offers resolves.
 *
 * A metric path is a dotted lookup into the evaluation context
 * (`src/alerts.js:604` `resolveMetric`), and a path that names nothing yields
 * `undefined`. `Number.isFinite(undefined)` is false, `evaluateConditionSet`
 * records `term_unresolvable`, and the rule or protocol does not fire — which is
 * byte-identical to a threshold that was not met. The failure has no diagnostic
 * anywhere, so the only place it can be caught is a test that resolves the
 * picker's own vocabulary.
 *
 * Two defects were found by doing exactly that, and this file is why they cannot
 * come back:
 *
 *   1. `counts.disease_observations` was offered by `protoMetricList` since the
 *      form was written and was absent from `counts()`. An operator who picked
 *      it built a protocol that could never fire.
 *   2. `operations` existed in only two of the four evaluation contexts. The
 *      alert-rule metric field ships `value="operations.counts.open_incidents"`
 *      as its *default*, so a shadow run answered "would not fire" for a rule
 *      the scheduler fired.
 *
 * The picker is read from `public/panels/settings.html` rather than restated
 * here. A hand-typed copy of the vocabulary beside a hand-typed copy of the
 * context is the defect class this register is full of, and a test carrying the
 * third copy would certify the drift instead of catching it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { resolveMetric, evaluateConditionSet, evaluateInShadowMode } from '../src/alerts.js'
import { buildEvaluationContext, counts, operationalSummary } from '../src/operations.js'
import { liveContext } from '../src/protocols.js'
import { JsonStore } from '../src/store.js'
import { ROOT } from './browser-env.mjs'

const SETTINGS = path.join(ROOT, 'public', 'panels', 'settings.html')

/**
 * Every metric path the settings surface offers an operator.
 *
 * Read from the HTML, so adding an option to the form without adding the key it
 * names fails here rather than in production. Both spellings are collected: the
 * `protoMetricList` datalist (a suggestion list the operator picks from) and the
 * alert-rule field's own `value` (the default a form submits untouched).
 */
function offeredMetricPaths() {
  const html = readFileSync(SETTINGS, 'utf8')
  const list = html.match(/<datalist id="protoMetricList">([\s\S]*?)<\/datalist>/)
  assert.ok(list, 'protoMetricList is gone from settings.html — read the new picker here')
  const options = [...list[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])

  const input = html.match(/id="alertMetricInput"[^>]*value="([^"]+)"/)
  assert.ok(input, 'alertMetricInput lost its default value — read the new field here')

  return { options, default: input[1] }
}

let dir
let data

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-context-'))
  // A fresh store, read rather than hand-built: `counts()` dereferences
  // collections unconditionally (`data.source_runs.length`), so a partial
  // fixture throws inside the function under test and reports as a context bug
  // rather than as the fixture's own gap. The schema knows the full key list.
  data = await new JsonStore(path.join(dir, 'store.json')).read()
})

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe('R-95 — the metric picker offers paths that resolve', () => {
  it('the picker was found and offers something', () => {
    // Every gate below is satisfied by an empty vocabulary, which is how a
    // "nothing to report" check reports clean forever.
    const { options, default: dflt } = offeredMetricPaths()
    assert.ok(options.length >= 8, `expected the metric picker; found ${options.length} options`)
    assert.match(dflt, /\./, 'the alert metric default must be a dotted path')
  })

  it('every datalist option resolves to a finite value', () => {
    const context = buildEvaluationContext(data)
    const dead = offeredMetricPaths().options
      .filter((p) => !Number.isFinite(resolveMetric(context, p)))
      .map((p) => `${p} → ${String(resolveMetric(context, p))}`)
    assert.deepEqual(dead, [],
      'these metric paths are offered to operators and name nothing in the evaluation ' +
      'context, so a rule built on one can never fire and reports no reason why. ' +
      'Add the key to counts() in src/operations.js.')
  })

  it("the alert field's shipped default resolves", () => {
    // Separate from the loop above because it is a different promise: the
    // datalist suggests, this one is what a form submits when nobody edits it.
    const context = buildEvaluationContext(data)
    const dflt = offeredMetricPaths().default
    assert.ok(Number.isFinite(resolveMetric(context, dflt)),
      `the alert-rule metric field ships ${dflt} as its default and it resolves to ` +
      `${String(resolveMetric(context, dflt))}`)
  })
})

describe('R-95 — one context shape, so a shadow run agrees with the live run', () => {
  it('the two contexts carry the same top-level namespaces', () => {
    const live = buildEvaluationContext(data)
    const shadow = liveContext(data)
    assert.deepEqual(Object.keys(shadow).sort(), Object.keys(live).sort(),
      'a context missing a namespace makes every path under it unresolvable, and a ' +
      'shadow run that disagrees with the live run is worse than no shadow run')
  })

  it('a protocol over an operations. metric fires the same way in both', () => {
    // The behavioural form of the assertion above. `operations.counts.open_incidents`
    // is the form's own default, so this is not a hypothetical path: it is the
    // one an operator gets by touching nothing.
    const protocol = {
      name: 'Open incidents above zero',
      metric: 'operations.counts.open_incidents',
      operator: '>',
      threshold: -1,
    }
    const live = evaluateInShadowMode(protocol, buildEvaluationContext(data))
    const shadow = evaluateInShadowMode(protocol, liveContext(data))
    assert.equal(live.evaluable, true, 'the live context must resolve the form default')
    assert.equal(shadow.evaluable, true, 'the shadow context must resolve the form default')
    assert.equal(shadow.would_fire, live.would_fire,
      'the shadow run and the live run must agree on the same protocol against the same data')
  })

  it('a missing namespace is reported as unresolvable, not as a missed threshold', () => {
    // The control for the two tests above. This asserts the *mechanism* they
    // depend on: if an unresolvable term were ever read as `false` rather than
    // as `evaluable: false`, the two tests above would pass while the operator
    // still got a silent no-fire. Pinning the mechanism keeps them honest.
    const evaluation = evaluateConditionSet(
      { combinator: 'and', negate: false, terms: [{ metric: 'nope.missing', operator: '>', threshold: 0 }] },
      buildEvaluationContext(data),
    )
    assert.equal(evaluation.evaluable, false)
    assert.equal(evaluation.firing, false)
  })

  it('the backtest context is the same shape over a point-in-time snapshot', () => {
    // `pointInTimeContext` in src/alerts.js is deliberately a different *data*
    // view — it filters to what the run could have seen — not a different
    // *shape*. The distinction is what the four hand-built copies lost.
    const snapshot = { ...data, hazard_events: [] }
    const context = buildEvaluationContext(data, { pointInTime: snapshot })
    assert.equal(resolveMetric(context, 'counts.hazard_events'), 0,
      'the snapshot must be the data the counts are taken over')
    assert.deepEqual(Object.keys(context).sort(), Object.keys(buildEvaluationContext(data)).sort())
  })

  it('counts() and the context agree on how many keys the picker could name', () => {
    // A guard on the guard: if `counts()` ever loses its `?.length ?? null`
    // discipline and starts returning `undefined` for absent collections, the
    // finite-value assertions above would still pass on a populated fixture
    // while every empty deployment saw dead paths. Assert the shape, not a
    // number, so this does not rot when a collection is added.
    const c = counts(data)
    const undefined_ = Object.entries(c).filter(([, v]) => v === undefined).map(([k]) => k)
    assert.deepEqual(undefined_, [],
      'counts() must return null for an absent collection, never undefined — ' +
      'null is a value a rule can compare against and undefined is not')
    assert.ok(Object.keys(operationalSummary(data).counts).includes('open_incidents'),
      'the operations namespace must keep the key the form ships as its default')
  })
})
