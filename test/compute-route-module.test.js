import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleComputeRoute, matchComputeRoute } from '../src/routes/compute.js'
import { FLOOD_DEPTH_BANDS } from '../public/shared/flood-bands.js'

/**
 * ENH-60 — the compute family as a module, asserted where it now lives.
 *
 * Four routes that run a model over the request's own arguments. They are one
 * family because the failure mode is the same: the *input* is the thing most
 * likely to be wrong, and a wrong input does not throw — it returns a confident
 * answer to a question nobody asked. So the assertions are mostly about
 * refusals, and about the band travelling with the number rather than beside it.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const call = (route, {
  data = {}, search = '', body, method, store, evaluateAndPersistAlerts,
} = {}) => {
  const res = fakeResponse()
  const raw = body === undefined ? '' : JSON.stringify(body)
  return handleComputeRoute(route, {
    store: store || { merge: async () => {} },
    data, res,
    req: {
      method: method || (route.kind === 'flood-depth' || route.kind === 'alerts-evaluate' ? 'GET' : 'POST'),
      __auth: { subject: 'tester', partner_org: null },
      __rawBody: raw,
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw) },
    },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
    evaluateAndPersistAlerts: evaluateAndPersistAlerts || (async () => ({ raised: [], updated: [] })),
  }).then((handled) => ({ handled, res }))
}

describe('ENH-60 — matchComputeRoute narrows only the routes whose wrong verb is a 404', () => {
  it('matches the two POST-only routes on POST alone', () => {
    assert.deepEqual(matchComputeRoute('/api/v1/routing/plan', 'POST'), { kind: 'routing-plan' })
    assert.deepEqual(matchComputeRoute('/api/v1/analytics/bias-correct', 'POST'), { kind: 'bias-correct' })
    assert.equal(matchComputeRoute('/api/v1/routing/plan', 'GET'), null)
    assert.equal(matchComputeRoute('/api/v1/analytics/bias-correct', 'GET'), null)
  })

  it('matches the three decision routes on POST alone', () => {
    // ENH-52, ENH-53, ENH-55. Each takes its whole question in the body, so a
    // GET is genuinely "no such route" rather than a route reached with the
    // wrong verb — the distinction the two verb-agnostic routes above exist to
    // preserve.
    assert.deepEqual(matchComputeRoute('/api/v1/anticipatory/evaluate', 'POST'), { kind: 'anticipatory-evaluate' })
    assert.deepEqual(matchComputeRoute('/api/v1/prepositioning/plan', 'POST'), { kind: 'prepositioning-plan' })
    assert.deepEqual(matchComputeRoute('/api/v1/scenario-comparisons', 'POST'), { kind: 'scenario-compare' })
    for (const pathname of ['/api/v1/anticipatory/evaluate', '/api/v1/prepositioning/plan', '/api/v1/scenario-comparisons']) {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(matchComputeRoute(pathname, method), null, `${method} ${pathname} matched a POST-only route`)
      }
    }
  })

  it('matches the two verb-agnostic routes on any method, so a wrong verb can be a 405', () => {
    // A matcher that narrowed these to GET/POST would turn a documented 405
    // into a 404 — a different statement about a different thing.
    for (const method of ['GET', 'POST', 'DELETE', 'PUT']) {
      assert.deepEqual(matchComputeRoute('/api/v1/flood-depth', method), { kind: 'flood-depth' })
      assert.deepEqual(matchComputeRoute('/api/v1/alerts/evaluate', method), { kind: 'alerts-evaluate' })
    }
  })

  it('matches nothing it does not serve', () => {
    for (const pathname of ['/api/v1/flood-depth/extra', '/api/v1/routing', '/api/v1/compute', '/api/v1/anticipatory', '/api/v1/prepositioning']) {
      assert.equal(matchComputeRoute(pathname, 'POST'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — routing/plan refuses the wrong argument shape by name', () => {
  it('refuses a missing origin and a missing destination separately', async () => {
    const noFrom = await call({ kind: 'routing-plan' }, { body: { to: 'road-b' } })
    assert.equal(noFrom.res.status, 400)
    assert.match(noFrom.res.json().error, /from is required/)

    const noTo = await call({ kind: 'routing-plan' }, { body: { from: 'road-a' } })
    assert.equal(noTo.res.status, 400)
    assert.match(noTo.res.json().error, /to is required/)
  })

  it('refuses a lat/lon object as an endpoint rather than reporting a severed network', async () => {
    // The mistake this guards: a caller passing coordinates gets "Unknown
    // origin or destination road", which reads like a broken router rather
    // than a wrong argument.
    const { res } = await call({ kind: 'routing-plan' }, {
      body: { from: { lat: 3.1, lon: 35.6 }, to: 'road-b' },
    })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /road asset ids/)
  })

  it('answers an unreachable destination with a caveat rather than a 500', async () => {
    // A network that cannot reach the site is still a *plan*: the route answers
    // 200 and says so per leg. The 400 is reserved for the argument being
    // wrong, not for the world being wrong — a distinction the caller can act
    // on, because one is fixed by resending and the other is not.
    const { res } = await call({ kind: 'routing-plan' }, { body: { from: 'road-a', to: 'road-b' } })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.data.fully_deliverable, false)
    assert.ok(body.data.caveat, 'an undeliverable plan carried no caveat')
    assert.equal(body.data.legs[0].feasible, false)
  })
})

describe('ENH-60 — flood-depth refuses a typo rather than answering 0 m', () => {
  it('refuses a request with neither a point nor a box', async () => {
    const { res } = await call({ kind: 'flood-depth' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /lat and lon/)
  })

  it('does not read a blank lat as zero', async () => {
    // Number('') is 0 and Number(null) is 0; a blank parameter must not become
    // a valid-looking coordinate at the Gulf of Guinea.
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=&lon=&level_m=520' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /lat and lon/)
  })

  it('refuses a level that is not a number rather than treating it as no levels', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=abc' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /level_m must be a number/)
  })

  it('refuses an implausible water surface elevation by range', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=99999' })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /out of range/)
  })

  it('bands every published depth and carries the cut points beside it', async () => {
    const { res } = await call({ kind: 'flood-depth' }, { search: '?lat=3.1&lon=35.6&level_m=520' })
    // Terrain may or may not cover this point in a test environment; either way
    // the answer is a 200 with a shape, never a throw.
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.success, true)
    const data = body.data
    if (Array.isArray(data.profile)) {
      for (const point of data.profile) {
        assert.ok('depth_band' in point, 'a depth was published without its band')
      }
    }
    assert.ok(Array.isArray(data.flood_bands) && data.flood_bands.length === FLOOD_DEPTH_BANDS.length,
      'the payload did not carry the band table it banded with')
    assert.equal(data.flood_bands.at(-1).max_m, null,
      'the top band must be unbounded, so a huge depth maps to it rather than falling off the table')
  })
})

describe('ENH-60 — analytics/bias-correct names a correction that did not happen', () => {
  it('answers an empty request with an empty set rather than throwing', async () => {
    const { res } = await call({ kind: 'bias-correct' }, { body: {} })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data, [])
  })

  it('refuses to name a station for a correction that did not happen', async () => {
    // One observation with no station to correct against: the value must stay
    // null and the source must stay null, with the reason stated.
    const { res } = await call({ kind: 'bias-correct' }, {
      body: {
        observations: [{ country: 'KE', precipitation_mm: 12 }],
        stations: [],
      },
    })
    assert.equal(res.status, 200)
    const [row] = res.json().data
    assert.ok(row, 'the observation was dropped rather than corrected-or-refused')
    assert.equal(row.bias_correction_source, null,
      'a station was named for a correction that did not happen')
    assert.ok(row.bias_correction_refusal, 'a refusal was not stated')
  })
})

describe('ENH-60 — alerts/evaluate refuses a wrong verb with a 405, not a 404', () => {
  it('answers a GET with 405', async () => {
    const { res } = await call({ kind: 'alerts-evaluate' }, { method: 'GET' })
    assert.equal(res.status, 405)
  })

  it('runs the engine on POST and reports what it evaluated', async () => {
    let called = false
    const { res } = await call({ kind: 'alerts-evaluate' }, {
      method: 'POST',
      data: { alert_rules: [{ id: 'r1' }, { id: 'r2' }] },
      body: { actor: 'tester' },
      evaluateAndPersistAlerts: async () => { called = true; return { raised: [{ id: 'e1' }], updated: [] } },
    })
    assert.ok(called, 'the engine was never called')
    assert.equal(res.status, 201)
    assert.equal(res.json().evaluated, 2)
    assert.equal(res.json().created, 1)
  })

  it('separates a rule that could not be tested from one that did not fire', async () => {
    // D11's second half, at the surface. `evaluated` counts every active rule,
    // and a rule whose metric resolved to nothing was never compared against
    // its threshold — so reporting it inside that total says five rules were
    // checked when five were skipped. The engine has returned `unresolvable`
    // since `5dca0be`; the route dropped it, and this asserts it does not.
    const dead = { rule_id: 'r2', rule_name: 'Typo rule', metric: 'counts.hazard_eventz', resolved: 'undefined' }
    const { res } = await call({ kind: 'alerts-evaluate' }, {
      method: 'POST',
      data: { alert_rules: [{ id: 'r1' }, { id: 'r2' }] },
      body: {},
      evaluateAndPersistAlerts: async () => ({ raised: [], updated: [], unresolvable: [dead] }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.json().evaluated, 2)
    assert.equal(res.json().unevaluable, 1, 'the count of rules that were never tested must be its own field')
    assert.deepEqual(res.json().unresolvable, [dead], 'the path is what the operator has to fix, so it travels with the count')
  })

  it('an engine that returns no `unresolvable` is not reported as having dead rules', async () => {
    // The default is the empty list, not `undefined`: a caller that surfaces
    // `unresolvable.length` must not throw on an engine written before the field
    // existed, and a missing field must not read as "some rules are dead".
    const { res } = await call({ kind: 'alerts-evaluate' }, {
      method: 'POST',
      data: { alert_rules: [{ id: 'r1' }] },
      body: {},
      evaluateAndPersistAlerts: async () => ({ raised: [], updated: [] }),
    })
    assert.equal(res.json().unevaluable, 0)
    assert.deepEqual(res.json().unresolvable, [])
  })
})

describe('ENH-52 — anticipatory/evaluate fires inside the window, and only then', () => {
  const trigger = (over = {}) => ({
    name: 'Turkana flood trigger',
    model_id: 'flood_depth',
    trigger_metric: 'depth_m',
    trigger_operator: '>=',
    trigger_threshold: 0.5,
    region: 'Turkana',
    funding_window: { opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-10-31T00:00:00Z' },
    action: { type: 'pre_position_stock', currency: 'USD' },
    ...over,
  })

  // `flood_depth`'s only floor is `terrain_comparables: 3`, and an absent count
  // is a missed floor rather than a met one — so a forecast that grounds has to
  // supply it. This is the shape a caller sends, not a convenience.
  const grounded = { region: 'Turkana', metrics: { depth_m: 1.2 }, grounding: { terrain_comparables: 5 }, observed_at: '2026-10-10T00:00:00Z' }

  it('refuses a missing trigger set with a 400 naming the field', async () => {
    // An absent set and an empty one are the same defect — a question nobody
    // asked — and `[]` would answer `fired: 0`, which reads like a deployment
    // whose triggers did not cross.
    const { res } = await call({ kind: 'anticipatory-evaluate' }, { method: 'POST', body: {} })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /triggers is required/)
  })

  it('refuses a trigger that could not be declared, by field, before evaluating any of them', async () => {
    // `normalizeAnticipatoryTrigger` throws a 400, and the dispatcher's error
    // path is what turns it into a response — so at this level the assertion is
    // on the throw, which is the same statement one layer in. What matters is
    // that it happens *before* any trigger is evaluated: a declaration that
    // could never fire must not appear in the results as one that did not cross.
    await assert.rejects(
      () => call({ kind: 'anticipatory-evaluate' }, {
        method: 'POST',
        body: { triggers: [trigger({ model_id: 'no_such_model' })], forecast: grounded },
      }),
      (error) => {
        assert.equal(error.statusCode, 400, 'a bad declaration must be a 400, not a 500')
        assert.match(error.message, /model_id must be a registered model/)
        return true
      },
    )
  })

  it('fires a crossing inside the window and records one action log per firing', async () => {
    const merges = []
    const { res } = await call({ kind: 'anticipatory-evaluate' }, {
      method: 'POST',
      body: { triggers: [trigger()], forecast: grounded },
      store: { merge: async (p) => { merges.push(p) }, withLock: async (fn) => fn({ read: async () => ({ events_outbox: [] }), merge: async () => {} }) },
    })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.data.fired_count, 1)
    assert.equal(body.data.evaluated_count, 1)
    assert.equal(body.data.refused_count, 0)
    assert.equal(body.data.verdicts[0].fired, true)
    // The record of the action, not just the verdict: a firing that wrote
    // nothing is an action nobody can be answered on.
    assert.equal(merges.length, 1)
    assert.equal(merges[0].action_logs.length, 1)
    assert.equal(merges[0].action_logs[0].action, 'fire')
  })

  it('records a crossing outside the funding window without firing it', async () => {
    // The distinction the module exists for: the crossing is an audit fact and
    // the firing is a decision about money. A trigger engine that ignores the
    // window spends outside its authority.
    const { res } = await call({ kind: 'anticipatory-evaluate' }, {
      method: 'POST',
      body: { triggers: [trigger()], forecast: { ...grounded, observed_at: '2026-09-10T00:00:00Z' } },
    })
    const verdict = res.json().data.verdicts[0]
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'outside_funding_window_before')
    assert.ok(verdict.crossing, 'the crossing must be recorded even when it did not fire')
    assert.equal(res.json().data.fired_count, 0)
  })

  it('reports the model refusal rather than a threshold comparison against an absent value', async () => {
    // Grounding is checked before the threshold on purpose: the sentence the
    // operator reads is the model's own, not "we compared against nothing".
    const { res } = await call({ kind: 'anticipatory-evaluate' }, {
      method: 'POST',
      body: { triggers: [trigger()], forecast: { ...grounded, grounding: { terrain_comparables: 1 } } },
    })
    const verdict = res.json().data.verdicts[0]
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'model_refuses_for_region')
    assert.equal(res.json().data.refused_count, 1)
  })

  it('is idempotent: feeding the fired crossings back in does not fire twice', async () => {
    // A trigger that fires twice funds twice, and the crossing id is what makes
    // the second pass recognise the first.
    const first = await call({ kind: 'anticipatory-evaluate' }, {
      method: 'POST',
      body: { triggers: [trigger()], forecast: grounded },
    })
    const firedCrossings = first.res.json().data.fired_crossings
    assert.equal(firedCrossings.length, 1)
    const second = await call({ kind: 'anticipatory-evaluate' }, {
      method: 'POST',
      body: { triggers: [trigger()], forecast: grounded, fired_crossings: firedCrossings },
    })
    const verdict = second.res.json().data.verdicts[0]
    assert.equal(verdict.fired, false)
    assert.equal(verdict.refusal, 'already_fired')
    assert.deepEqual(second.res.json().data.fired_crossings, firedCrossings, 'the id set must not grow on a repeat')
  })
})

describe('ENH-53 — prepositioning/plan answers a refusal with a reason, never a 4xx', () => {
  const site = (code, lat, lon) => ({ code, latitude: lat, longitude: lon })

  it('refuses an unusable budget rather than allocating nothing quietly', async () => {
    const { res } = await call({ kind: 'prepositioning-plan' }, {
      method: 'POST',
      body: { demand_sites: [site('d1', 3.1, 35.6)], staging_sites: [site('s1', 3.2, 35.7)] },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.refusal, 'unusable_budget')
    assert.ok(res.json().data.reason.length > 0)
  })

  it('refuses a demand site with no coordinate rather than treating it as unreachable-at-zero-cost', async () => {
    const { res } = await call({ kind: 'prepositioning-plan' }, {
      method: 'POST',
      body: {
        budget: 1000,
        demand_sites: [{ code: 'd1' }],
        staging_sites: [site('s1', 3.2, 35.7)],
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.refusal, 'unlocated_demand_site')
  })

  it('refuses when no scored road lies near a demand site', async () => {
    // An unrecorded road is not a clear one: with an empty store there is no
    // road to measure a transport cost from, and a plan staged behind one
    // nobody scored is a plan over an unknown route.
    const { res } = await call({ kind: 'prepositioning-plan' }, {
      method: 'POST',
      data: {},
      body: { budget: 1000, demand_sites: [site('d1', 3.1, 35.6)], staging_sites: [site('s1', 3.2, 35.7)] },
    })
    assert.equal(res.status, 200)
    assert.ok(['no_staging_sites', 'unroutable_demand'].includes(res.json().data.refusal), `unexpected refusal ${res.json().data.refusal}`)
  })

  it('plans over a scored road network and reports the improvement over the naive allocation', async () => {
    // The load-bearing case: a demand site within ROAD_LINK_RADIUS_KM of an open
    // road plans, and the plan beats proportional-to-mean or says by how much.
    const data = {
      service_assets: [{
        id: 'road-1', service_type: 'road', road_class: 'paved', access_level: 'open',
        latitude: 3.1, longitude: 35.6, passability: 'passable',
      }],
      hazard_events: [],
    }
    const { res } = await call({ kind: 'prepositioning-plan' }, {
      method: 'POST',
      data,
      body: {
        budget: 1000,
        demand_sites: [{ code: 'd1', latitude: 3.1, longitude: 35.6, demandDistribution: [{ probability: 0.5, units: 400 }, { probability: 0.5, units: 600 }] }],
        staging_sites: [site('s1', 3.12, 35.62)],
        seed: 7,
      },
    })
    assert.equal(res.status, 200)
    const plan = res.json().data
    assert.equal(plan.refusal, null, `refused: ${plan.refusal} — ${plan.reason}`)
    assert.ok(plan.allocation.s1 > 0, 'the plan allocated nothing to the only staging site')
    assert.ok(Number.isFinite(plan.expected_unmet))
    assert.ok(Number.isFinite(plan.naive_expected_unmet))
    assert.equal(plan.scenarios.source, 'sampled')
  })
})

describe('ENH-55 — scenario-comparisons refuses an unresolved order rather than resolving it', () => {
  const scenario = (name, estimate, interval, over = {}) => ({
    name,
    region: 'Turkana',
    window: { start: '2026-01-01', end: '2026-06-30' },
    estimate,
    interval,
    ...over,
  })

  it('refuses fewer than two scenarios with a reason', async () => {
    const { res } = await call({ kind: 'scenario-compare' }, { method: 'POST', body: { scenarios: [scenario('a', 10, { low: 8, high: 12 })] } })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.refusal, 'too_few_scenarios')
  })

  it('refuses two scenarios with the same name rather than collapsing them', async () => {
    const { res } = await call({ kind: 'scenario-compare' }, {
      method: 'POST',
      body: { scenarios: [scenario('same', 10, { low: 8, high: 12 }), scenario('same', 20, { low: 18, high: 22 })] },
    })
    assert.equal(res.json().data.refusal, 'duplicate_scenario_name')
  })

  it('ranks two scenarios whose intervals are disjoint', async () => {
    const { res } = await call({ kind: 'scenario-compare' }, {
      method: 'POST',
      body: { scenarios: [scenario('flood-only', 10, { low: 8, high: 12 }), scenario('compound', 30, { low: 28, high: 32 })] },
    })
    const body = res.json().data
    assert.equal(body.refusal, null)
    assert.equal(body.decision.supported, true)
    assert.equal(body.decision.better, 'flood-only', 'lower is better by default, and flood-only has the lower estimate')
  })

  it('reports an overlapping pair as an unresolved order, not resolved by the means', async () => {
    // The assertion the module exists for: a difference of two point estimates
    // whose intervals overlap is not a ranking, and reporting the lower mean as
    // the better intervention is the defect.
    const { res } = await call({ kind: 'scenario-compare' }, {
      method: 'POST',
      body: { scenarios: [scenario('a', 10, { low: 5, high: 15 }), scenario('b', 12, { low: 7, high: 17 })] },
    })
    const body = res.json().data
    assert.equal(body.decision.supported, false)
    assert.equal(body.decision.better, null)
    assert.ok(body.decision.not_supported.length > 0, 'an unresolved order must say so')
  })
})
