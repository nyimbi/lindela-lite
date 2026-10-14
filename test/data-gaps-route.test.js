/**
 * ENH-54 — the route, asserted where it lives.
 *
 * `src/value-of-information.js` prices one gap at a time and had no production
 * caller. The missing half was the part that knows *where the gaps come from*,
 * and it is `src/data-gaps.js`: the two refusal lists this platform already
 * publishes — the drift verdicts that came back `not_measurable` and the feeds
 * that are not arriving — joined into one list ordered by what closing each
 * would buy.
 *
 * Five things, each of which is a way for the endpoint to look healthy while
 * saying nothing:
 *
 *   1. The matcher is method-aware, like the rest of the family. A GET-only
 *      read answered `DELETE` with a 200 before VER-14 was swept.
 *   2. A store where nothing has ever run is *twenty gaps*, not zero. This is
 *      the assertion the endpoint most needs: `ranked: 0` from an empty store
 *      and `ranked: 0` from a fully-populated one are opposite facts, and a
 *      route that reports only the ranked rows renders them identically.
 *   3. A healthy store reports nothing. The complement of (2), and the reason
 *      (2) is not just "count the sources": the same twenty ids produce twenty
 *      gaps or none depending on the runs.
 *   4. A gap whose threshold cannot be grounded is *refused with a reason* and
 *      named in `unpriceable`, never ranked at zero. A zero EVPI and an
 *      uncomputable one are opposite claims.
 *   5. The ranking is a procurement order, and it moves in the right direction
 *      on both operands: a gap further from measurement, and one whose decision
 *      costs more per unit, each rank higher.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { driftReport } from '../src/drift.js'
import { handleDerivedRoute, matchDerivedRoute } from '../src/routes/derived.js'
import { SOURCE_IDS } from '../src/schema.js'

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.json = () => JSON.parse(res.chunks.join(''))
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const call = ({ data = {}, method = 'GET' } = {}) => {
  const res = fakeResponse()
  return handleDerivedRoute({ kind: 'data-gaps' }, {
    data,
    res,
    req: { method, __auth: { subject: 'tester', partner_org: null } },
    url: new URL('http://127.0.0.1/api/v1/data-gaps'),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

const NOW = Date.parse('2026-10-14T00:00:00Z')

/** One successful run per source, an hour old — a store with nothing wrong. */
const healthyRuns = () => SOURCE_IDS.map((source, i) => ({
  id: `run-${i}`, source, status: 'success', records_processed: 10,
  completed_at: new Date(NOW - 3600000).toISOString(),
}))

/** `count` monthly samples carrying the three drift features, or none of them. */
const window = (count, offset = 0) => Array.from({ length: count }, (_, i) => ({
  month: `20${String(10 + Math.floor(i / 12)).slice(-2)}-${String((i % 12) + 1).padStart(2, '0')}`,
  features: { max_7_day: 50 + offset + (i % 7), sum_30_day: 200 + offset * 2, sum_90_day: 500 + offset * 3 },
  label: false,
}))

/**
 * Three regions refused by `driftReport` for short windows, at different
 * distances from the 24-month floor. Turkana has no evidence at all, Bor
 * nearly reaches it — so the two must not rank the same.
 */
const threeRefused = () => driftReport({
  regions: [
    { region: 'Turkana', referenceSamples: window(0), currentSamples: window(0) },
    { region: 'Aweil', referenceSamples: window(3), currentSamples: window(3) },
    { region: 'Bor', referenceSamples: window(10), currentSamples: window(10) },
  ],
}).records

describe('the data-gaps route is a read', () => {
  it('matches GET and only GET', () => {
    assert.deepEqual(matchDerivedRoute('/api/v1/data-gaps', 'GET'), { kind: 'data-gaps' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchDerivedRoute('/api/v1/data-gaps', method), null, `${method} matched a read route`)
    }
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/data-gap', '/api/v1/data-gaps/', '/api/v1/data-gapss', '']) {
      assert.equal(matchDerivedRoute(pathname, 'GET'), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('an empty store is twenty gaps, not a clean bill of health', () => {
  it('reports one gap per source when nothing has ever run', async () => {
    const { handled, res } = await call({ data: { source_runs: [], model_drift: [] } })
    assert.equal(handled, true)
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.success, true)
    // The whole point. A store with no runs has a gap for every source, and a
    // payload that showed only the ranked rows would look identical to one from
    // a store where everything is arriving.
    assert.equal(body.gaps_considered, SOURCE_IDS.length, 'every source is a gap when none has run')
    assert.equal(body.ranked, SOURCE_IDS.length)
    assert.equal(body.by_kind.freshness, SOURCE_IDS.length)
    assert.equal(body.by_kind.drift, 0)
    assert.equal(body.refused_count, 0, 'a never-run source has a grounded cadence threshold')
  })

  it('reports nothing when every source is arriving', async () => {
    // The complement, and the reason the test above is not just a source count:
    // the same twenty ids produce twenty gaps or none depending on the runs.
    const { res } = await call({ data: { source_runs: healthyRuns(), model_drift: [] } })
    const body = res.json()
    assert.equal(body.gaps_considered, 0)
    assert.equal(body.ranked, 0)
    assert.equal(body.total_evpi, 0)
    assert.deepEqual(body.gaps, [])
  })

  it('answers 200 with a well-formed payload on a store the caller forgot to fill', async () => {
    // `store.read()` always supplies these keys, but a caller reaching this
    // module directly may not. A 500 here would be a client bug reported as a
    // server fault.
    const { handled, res } = await call({ data: {} })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json().gaps))
  })
})

describe('the drift refusals are priced, and the ranking is a procurement order', () => {
  it('turns each refused region into a ranked gap carrying its refusal', async () => {
    const { res } = await call({ data: { source_runs: healthyRuns(), model_drift: threeRefused() } })
    const body = res.json()
    assert.equal(body.by_kind.drift, 3, 'three refused regions, three gaps')
    assert.equal(body.by_kind.freshness, 0, 'every feed is arriving, so no freshness gap')
    for (const gap of body.gaps) {
      assert.equal(gap.kind, 'drift')
      assert.equal(gap.signal, 'input_shift')
      assert.ok(gap.reason && gap.reason.length > 0, `${gap.id} must carry the refusal that produced it`)
      assert.ok(gap.evpi > 0, `${gap.id} is a real gap and must price above zero`)
    }
  })

  it('ranks the region with no evidence above the one nearly at the floor', async () => {
    const { res } = await call({ data: { source_runs: healthyRuns(), model_drift: threeRefused() } })
    const byId = Object.fromEntries(res.json().gaps.map((g) => [g.id, g]))
    assert.ok(
      byId['drift:Turkana'].evpi > byId['drift:Bor'].evpi,
      'a region with no evidence must outrank one that nearly reaches the measurement floor',
    )
    // ...and the mechanism is the shortfall, not a coincidence of the ordering.
    assert.equal(byId['drift:Turkana'].evidence_shortfall, 1)
    assert.ok(byId['drift:Bor'].evidence_shortfall < 1)
  })

  it('ranks a gap whose decision costs more above the same gap without the weight', async () => {
    // Same store, same geometry, one region weighted. The ranking is the
    // caller's to steer, and this is the assertion that says the weight reaches
    // the sort rather than being carried in the payload unread.
    const data = { source_runs: healthyRuns(), model_drift: threeRefused() }
    const { res: flat } = await call({ data })
    const weighted = await import('../src/data-gaps.js').then(({ dataGaps }) => dataGaps(data, {
      lossByRegion: { Aweil: 1000 },
    }))
    const before = flat.json().gaps.findIndex((g) => g.id === 'drift:Aweil')
    const after = weighted.gaps.findIndex((g) => g.id === 'drift:Aweil')
    assert.equal(after, 0, 'a region worth a thousand times more per unit of error ranks first')
    assert.ok(before > 0, 'and it did not rank first without the weight, so the test is not vacuous')
  })
})

describe('an unpriceable gap is refused, never ranked at zero', () => {
  it('names it in unpriceable and in refused, with a reason in both', async () => {
    // A `not_measurable` record with neither signal refused: no `thresholdKey`,
    // so there is no action to price it against. Not reachable through
    // `detectDrift`, but the shape is returned rather than assumed.
    const { res } = await call({
      data: { source_runs: healthyRuns(), model_drift: [{ region_name: 'Nowhere', verdict: 'not_measurable' }] },
    })
    const body = res.json()
    assert.equal(body.ranked, 0, 'the gap is not priced')
    assert.equal(body.refused_count, 1)
    assert.equal(body.unpriceable.length, 1)
    assert.equal(body.unpriceable[0].id, 'drift:Nowhere')
    assert.ok(body.unpriceable[0].reason.length > 0, 'the refusal must say why, not just that')
    assert.ok(body.refused[0].reason.length > 0)
    // And the two refusal lists are different facts: `unpriceable` is the gap
    // builder declining to name a threshold, `refused` is the ranker declining
    // to price the one it was handed. A payload with only the second would lose
    // the fact that the *record* was incomplete.
    assert.notEqual(body.unpriceable[0].reason, body.refused[0].reason)
  })

  it('keeps the refusals beside the ranking rather than in place of it', async () => {
    const { res } = await call({
      data: {
        source_runs: healthyRuns(),
        model_drift: [...threeRefused(), { region_name: 'Nowhere', verdict: 'not_measurable' }],
      },
    })
    const body = res.json()
    assert.equal(body.ranked, 3)
    assert.equal(body.refused_count, 1)
    assert.ok(body.gaps.every((g) => g.id !== 'drift:Nowhere'), 'a refused gap must not appear in the ranking')
  })
})

describe('the payload says what the ranking is and is not', () => {
  it('carries the basis, the limit, and the source of every threshold', async () => {
    const { res } = await call({ data: { source_runs: healthyRuns(), model_drift: threeRefused() } })
    const body = res.json()
    assert.ok(body.measure.includes('expected value of perfect information'))
    assert.ok(body.limit.includes('not a forecast'), 'the payload must say the ranking is a procurement order')
    assert.ok(body.limit.includes('refused rather than ranked at zero'))
    assert.deepEqual(Object.keys(body.basis.thresholds).sort(), ['divergence', 'freshness', 'input_shift'])
    for (const source of Object.values(body.basis.thresholds)) {
      assert.ok(source && source.length > 0, 'a threshold with no source is an invented boundary')
    }
    assert.equal(body.basis.sources_considered, SOURCE_IDS.length)
  })

  it('is deterministic: the same store ranks the same way twice', async () => {
    const data = { source_runs: healthyRuns(), model_drift: threeRefused() }
    const first = (await call({ data })).res.json()
    const second = (await call({ data })).res.json()
    assert.deepEqual(first.gaps.map((g) => g.id), second.gaps.map((g) => g.id))
  })
})
