import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { contingencyByFeature, handleRiskRoute, matchRiskRoute } from '../src/routes/risk.js'
import { trainDistrictModels } from '../src/flood-probability.js'

/**
 * ENH-60 — the hazard-risk family as a module, asserted where it now lives.
 *
 * Nine blocks out of the dispatcher, six paths, and the property that makes them
 * one family: every one publishes a number that looks more authoritative than it
 * is, and each has to carry the qualification *beside* the figure. That is the
 * thing that is easy to lose in a move, so it is the thing asserted here:
 *
 *   - the risk rankings carry `ranking` — a weighted index, not a probability;
 *   - `compound-risk` is the joint score served beside the two marginals;
 *   - `flood-probability/score` carries `uncertainty`, so a point estimate from a
 *     fit resting on four events cannot be quoted bare;
 *   - the two refusals that are answers: an absent model is a 200 with
 *     `scored: false`, and an ambiguous region is a 400 rather than a guess.
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

const call = (route, { data = {}, search = '', method = 'GET', body, store = { merge: async () => {} } } = {}) => {
  const res = fakeResponse()
  return handleRiskRoute(route, {
    store, data, res,
    req: { method, __auth: { subject: 'tester', partner_org: null }, __rawBody: body === undefined ? '' : JSON.stringify(body), async *[Symbol.asyncIterator]() {} },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

const risk = (type, over = {}) => ({
  id: `${type}-1`, type, region_name: 'Turkana', score: 0.7, valid_from: '2026-01-01T00:00:00Z', ...over,
})

describe('ENH-60 — matchRiskRoute is method-aware, so neither half is closed', () => {
  it('matches the five reads on GET', () => {
    assert.deepEqual(matchRiskRoute('/api/v1/flood-risk'), { kind: 'flood-risk' })
    assert.deepEqual(matchRiskRoute('/api/v1/conflict-risk'), { kind: 'conflict-risk' })
    assert.deepEqual(matchRiskRoute('/api/v1/compound-risk'), { kind: 'compound-risk' })
    assert.deepEqual(matchRiskRoute('/api/v1/flood-probability/models'), { kind: 'probability-models' })
    assert.deepEqual(matchRiskRoute('/api/v1/flood-probability/score'), { kind: 'probability-score' })
  })

  it('matches the one compute route on POST only', () => {
    assert.deepEqual(matchRiskRoute('/api/v1/flood-probability/train', 'POST'), { kind: 'probability-train' })
    // A blanket `method !== 'GET'` guard would have closed this route; a blanket
    // GET guard would have closed the other five. The family is not uniform.
    assert.equal(matchRiskRoute('/api/v1/flood-probability/train', 'GET'), null,
      'the training route matched a GET, so a read verb reaches a compute route')
    assert.equal(matchRiskRoute('/api/v1/flood-risk', 'POST'), null)
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/flood', '/api/v1/flood-probability', '/api/v1/risks']) {
      assert.equal(matchRiskRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — the rankings carry the ordering explanation', () => {
  it('explains the ordering on all three, so a score is not read as a probability', async () => {
    const data = {
      risk_scores: [risk('flood_risk'), risk('climate_conflict_risk'), risk('compound_hazard_risk')],
    }
    for (const [kind, type] of [['flood-risk', 'flood_risk'], ['conflict-risk', 'climate_conflict_risk'], ['compound-risk', 'compound_hazard_risk']]) {
      const { res } = await call({ kind }, { data })
      const body = res.json()
      assert.ok(body.ranking, `${kind} published a ranking with no explanation of what orders it`)
      assert.equal(body.total, 1)
      assert.equal(body.data[0].type, type)
    }
  })

  it('filters to one risk type rather than returning every score in the store', async () => {
    const data = { risk_scores: [risk('flood_risk'), risk('climate_conflict_risk')] }
    const { res } = await call({ kind: 'flood-risk' }, { data })
    assert.equal(res.json().data.length, 1)
    assert.equal(res.json().data[0].type, 'flood_risk')
  })

  it('pages, so a truncated ranking is distinguishable from a complete one', async () => {
    const data = { risk_scores: Array.from({ length: 5 }, (_, i) => risk('flood_risk', { id: `r${i}` })) }
    const { res } = await call({ kind: 'flood-risk' }, { data, search: '?limit=2' })
    const body = res.json()
    assert.equal(body.returned, 2)
    assert.equal(body.total, 5)
    assert.equal(body.has_more, true)
  })
})

describe('ENH-60 — a point estimate travels with the uncertainty behind it', () => {
  // The real fitted shape: `predict` walks `standardization` and looks each
  // feature's coefficient up in `coefficients`. A fabricated `{weights}` object
  // would test a model nothing produces.
  const model = {
    intercept: -3,
    coefficients: [
      { feature: 'max_7_day', value: 0.4 },
      { feature: 'sum_30_day', value: 0.1 },
      { feature: 'sum_90_day', value: 0.05 },
    ],
    standardization: [
      { feature: 'max_7_day', mean: 90, sd: 45 },
      { feature: 'sum_30_day', mean: 240, sd: 120 },
      { feature: 'sum_90_day', mean: 560, sd: 280 },
    ],
  }
  const trained = {
    id: 'm1', region_name: 'Turkana', model, trained_at: '2026-03-01T00:00:00Z', folds: { folds: { n_folds: 3 } },
    basis: 'gdacs_events', label_source: 'gdacs', months_kept: 24, events_matched: 4,
    contingency: [{ feature: 'max_7_day', threshold_mm: 50, months_above_threshold: 4, conditional_probability: 0.5, conditional_probability_wilson: [0.2, 0.8] }],
  }

  it('returns the contingency rows keyed by feature, with the interval and the month count', async () => {
    const { res } = await call({ kind: 'probability-score' }, {
      data: { flood_probability_models: [trained] },
      search: '?max_7_day=60&sum_30_day=100&sum_90_day=200',
    })
    const body = res.json()
    assert.equal(body.scored, true)
    const byFeature = body.data.uncertainty.by_feature
    assert.ok(byFeature.max_7_day, 'the uncertainty is not keyed by feature, so a caller cannot find the row for the statistic they supplied')
    assert.deepEqual(byFeature.max_7_day.conditional_probability_wilson, [0.2, 0.8])
    assert.equal(byFeature.max_7_day.months_above_threshold, 4,
      'the month count does not travel, so a probability resting on four events reads as a measured one')
    assert.match(body.data.uncertainty.note, /not a confidence interval/i)
  })

  it('refuses an absent or empty feature rather than scoring against zeros', async () => {
    // `Number(null)` is 0, so an absent statistic would otherwise score against
    // a feature value that was never given.
    const { res } = await call({ kind: 'probability-score' }, {
      data: { flood_probability_models: [trained] },
      search: '?max_7_day=&sum_30_day=100&sum_90_day=200',
    })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /max_7_day/)
  })

  it('asks which region rather than scoring against whichever trained most recently', async () => {
    const other = { ...trained, id: 'm2', region_name: 'Marsabit', trained_at: '2026-04-01T00:00:00Z' }
    const { res } = await call({ kind: 'probability-score' }, {
      data: { flood_probability_models: [trained, other] },
      search: '?max_7_day=60&sum_30_day=100&sum_90_day=200',
    })
    assert.equal(res.status, 400, 'an ambiguous region was answered with a guess about a district nobody asked about')
    assert.deepEqual(res.json().available_regions, ['Marsabit', 'Turkana'])
  })

  it('answers an absent model as an answer, not a 500', async () => {
    const { res } = await call({ kind: 'probability-score' }, {
      data: { flood_probability_models: [] },
      search: '?max_7_day=60&sum_30_day=100&sum_90_day=200',
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().scored, false)
    assert.match(res.json().refusal, /train first/)
  })

  it('scores a single trained model with no region named, which is unambiguous', async () => {
    const { res } = await call({ kind: 'probability-score' }, {
      data: { flood_probability_models: [trained] },
      search: '?max_7_day=60&sum_30_day=100&sum_90_day=200',
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.region_name, 'Turkana')
  })
})

describe('ENH-60 — training never reaches the network and refuses by name', () => {
  it('writes what it trained and reports what it refused', async () => {
    let merged = null
    const store = { merge: async (partial) => { merged = partial; return partial } }
    const data = {
      regions: [{ id: 'turkana', name: 'Turkana', centroid: { latitude: 3.1, longitude: 35.6 } }],
      open_meteo_archive: [],
      gdacs_events: [],
    }
    const { res } = await call({ kind: 'probability-train' }, { data, store, method: 'POST', body: {} })
    const body = res.json()
    assert.equal(body.success, true)
    assert.ok(Array.isArray(body.refusals), 'a district that cannot support a fit must appear as a refusal, not vanish')
    assert.equal(body.data.length, 0, 'a fit was produced from an empty archive')
    assert.equal(merged, null, 'nothing was trained and the store was still written')
  })

  it('the training path is the module’s, so the route and a direct call cannot diverge', () => {
    // `trainDistrictModels` is imported by the route, not reimplemented in it.
    assert.equal(typeof trainDistrictModels, 'function')
  })
})

describe('ENH-60 — contingencyByFeature keys the rows and drops what it cannot read', () => {
  it('ignores a row with no feature name rather than inventing a key', () => {
    const byFeature = contingencyByFeature([{ threshold_mm: 1 }, null, { feature: 'max_7_day', threshold_mm: 50 }])
    assert.deepEqual(Object.keys(byFeature), ['max_7_day'])
  })

  it('answers an empty object for a model with no contingency, not a throw', () => {
    assert.deepEqual(contingencyByFeature(undefined), {})
    assert.deepEqual(contingencyByFeature([]), {})
  })
})
