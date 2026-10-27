import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleDistrictRoute, matchDistrictRoute } from '../src/routes/districts.js'

/**
 * ENH-60 — the district-and-equity family as a module, asserted where it now
 * lives.
 *
 * Five routes that answer "what does the platform know about a place" at three
 * scales. The property that makes them one family, and the thing a move is most
 * likely to lose, is that every figure which looks more complete than it is
 * travels with the qualification beside it:
 *
 *   - `equity/by-district` publishes `dispatch_precision_pct` *and* the
 *     determined sample it was computed from;
 *   - `equity/breaches` gates on `minSample`, so a district is not named a
 *     breach on a one-record sample;
 *   - `equity/scan` reports `created` beside `ids`, because the creation is
 *     idempotent and a second scan creating nothing is an answer.
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

const call = (route, { data = {}, search = '', store = { merge: async () => {} } } = {}) => {
  const res = fakeResponse()
  return handleDistrictRoute(route, {
    store, data, res,
    req: { method: 'GET', __auth: { subject: 'tester', partner_org: null } },
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res }))
}

// One alert with a recorded outcome, and one dispatch for it. `determined` is
// what `dispatch_precision_pct` is computed from, so a district needs both to
// produce a number at all.
const alert = (district, over = {}) => ({
  id: `${district}-a1`, district, scope: { district }, status: 'acknowledged',
  severity: 'high', false_alert: false, ...over,
})
const dispatch = (alertId) => ({ id: `d-${alertId}`, alert_event_id: alertId, status: 'delivered' })

describe('ENH-60 — matchDistrictRoute is method-aware and anchors the detail path', () => {
  it('matches the four reads on GET', () => {
    assert.deepEqual(matchDistrictRoute('/api/v1/districts'), { kind: 'districts' })
    assert.deepEqual(matchDistrictRoute('/api/v1/districts/turkana'), { kind: 'district', id: 'turkana' })
    assert.deepEqual(matchDistrictRoute('/api/v1/equity/by-district'), { kind: 'equity-by-district' })
    assert.deepEqual(matchDistrictRoute('/api/v1/equity/breaches'), { kind: 'equity-breaches' })
  })

  it('matches the audit scan on POST only', () => {
    assert.deepEqual(matchDistrictRoute('/api/v1/equity/scan', 'POST'), { kind: 'equity-scan' })
    // A blanket GET guard would have closed the scan; a blanket `method !==
    // 'GET'` guard would have closed the other four. The family is not uniform.
    assert.equal(matchDistrictRoute('/api/v1/equity/scan', 'GET'), null,
      'the scan matched a GET, so a read verb reaches a mutation')
    assert.equal(matchDistrictRoute('/api/v1/districts', 'POST'), null)
  })

  it('does not resolve a two-segment tail to a district id', () => {
    // Unanchored, `/districts/co/ke` would resolve to the district `co` and a
    // caller would get a real page for a path that is not a route.
    for (const pathname of ['/api/v1/districts/co/ke', '/api/v1/district', '/api/v1/districts/']) {
      assert.equal(matchDistrictRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-60 — the equity figures travel with the sample behind them', () => {
  it('reports the determined sample beside the precision it was computed from', async () => {
    const data = { alert_events: [alert('Turkana')], rapidpro_dispatches: [dispatch('Turkana-a1')] }
    const { res } = await call({ kind: 'equity-by-district' }, { data })
    const row = res.json().data.find((d) => d.district === 'Turkana')
    assert.ok(row, 'the district the alert belongs to is missing from the equity table')
    assert.ok('dispatch_precision_pct' in row, 'the precision is missing')
    assert.equal(row.determined_dispatched, 1,
      'the determined sample does not travel, so a precision from one record reads as a measured one')
  })

  it('names the breakdowns the schema cannot produce rather than reporting them empty', async () => {
    const data = { alert_events: [alert('Turkana')], rapidpro_dispatches: [dispatch('Turkana-a1')] }
    const { res } = await call({ kind: 'equity-by-district' }, { data })
    const row = res.json().data.find((d) => d.district === 'Turkana')
    assert.ok(Array.isArray(row.data_gaps) && row.data_gaps.length > 0,
      'a district with no gender or age field reports empty breakdowns with no statement that the schema has no such field')
  })

  it('does not name a breach on a sample below minSample', async () => {
    // One determined dispatch at 100% precision is not a breach; the gate is the
    // sample, not the rate.
    const data = { alert_events: [alert('Turkana')], rapidpro_dispatches: [dispatch('Turkana-a1')] }
    const { res } = await call({ kind: 'equity-breaches' }, { data })
    assert.deepEqual(res.json().data, [],
      'a district with a one-record sample was named a breach')
  })

  it('treats an absent threshold as absent, not as zero', async () => {
    // `Number(null)` is 0, so an absent threshold read as 0 would report *no*
    // district — the module's own default of 80 is what an absent parameter
    // must fall back to, and the two answers differ in opposite directions.
    const alerts = Array.from({ length: 6 }, (_, i) => alert('Turkana', { id: `Turkana-a${i}`, false_alert: i < 5 }))
    const data = { alert_events: alerts, rapidpro_dispatches: alerts.map((a) => dispatch(a.id)) }
    const absent = await call({ kind: 'equity-breaches' }, { data })
    const zero = await call({ kind: 'equity-breaches' }, { data, search: '?threshold=0' })
    assert.equal(absent.res.json().data.length, 1,
      'an absent threshold did not fall back to the module default, so a real breach went unreported')
    assert.equal(zero.res.json().data.length, 0,
      'a threshold of zero was not honoured, so the parameter was read as absent')
  })
  it('refuses a threshold it cannot read rather than reporting no breaches', async () => {
    // `?threshold=abc` became `NaN`, and `precision < NaN` is false for every
    // district, so the scan answered `[]` — the parameter an operator narrows to
    // find more problems widened the silence instead. A threshold is a
    // percentage, so a value outside 0–100 is clamped rather than refused.
    const alerts = Array.from({ length: 6 }, (_, i) => alert('Turkana', { id: `Turkana-a${i}`, false_alert: i < 5 }))
    const data = { alert_events: alerts, rapidpro_dispatches: alerts.map((a) => dispatch(a.id)) }
    await assert.rejects(
      () => call({ kind: 'equity-breaches' }, { data, search: '?threshold=abc' }),
      (error) => error.statusCode === 400 && /threshold must be a number/.test(error.message),
      'an unreadable threshold was accepted, so every district compared false against NaN',
    )
    const clamped = await call({ kind: 'equity-breaches' }, { data, search: '?threshold=-5' })
    assert.deepEqual(clamped.res.json().data, [],
      'a threshold below zero is every district breaching; it was not clamped')
  })
})

describe('ENH-60 — the scan reports what it created, and creating nothing is an answer', () => {
  it('creates a workflow per breach and reports the count with the ids', async () => {
    let merged = null
    const store = { merge: async (partial) => { merged = partial; return partial } }
    // Six determined dispatches, five of them false, so precision is 1/6 ≈ 17%
    // and the sample clears `minSample` of 5.
    const alerts = Array.from({ length: 6 }, (_, i) => alert('Turkana', {
      id: `Turkana-a${i}`, false_alert: i < 5,
    }))
    const dispatches = alerts.map((a) => dispatch(a.id))
    const { res } = await call({ kind: 'equity-scan' }, {
      data: { alert_events: alerts, rapidpro_dispatches: dispatches }, store,
    })
    const body = res.json()
    assert.equal(res.status, 201)
    assert.equal(body.created, 1, 'the breach did not become an audit workflow')
    assert.equal(body.ids.length, 1)
    assert.equal(merged.workflow_instances.length, 1)
  })

  it('creates nothing on a second scan over the same data, and says so', async () => {
    const alerts = Array.from({ length: 6 }, (_, i) => alert('Turkana', { id: `Turkana-a${i}`, false_alert: i < 5 }))
    const dispatches = alerts.map((a) => dispatch(a.id))
    const open = {
      id: 'w1', type: 'equity_audit_action', state: 'threshold_breached', district: 'Turkana',
    }
    let merged = null
    const store = { merge: async (partial) => { merged = partial; return partial } }
    const { res } = await call({ kind: 'equity-scan' }, {
      data: { alert_events: alerts, rapidpro_dispatches: dispatches, workflow_instances: [open] }, store,
    })
    const body = res.json()
    assert.equal(body.created, 0,
      'a second scan over an already-open audit created a duplicate')
    assert.equal(merged, null, 'nothing was created and the store was still written')
  })
})

describe('ENH-60 — the district reads answer a missing district as a 404, not an empty page', () => {
  it('serves the published registry', async () => {
    const { res } = await call({ kind: 'districts' })
    const body = res.json()
    assert.ok(Array.isArray(body.data) && body.data.length > 0)
    assert.ok(body.data.every((d) => d.slug && d.name), 'a registry row is missing its slug or name')
  })

  it('404s an unknown district rather than returning a page of zeros', async () => {
    const { res } = await call({ kind: 'district', id: 'atlantis' })
    assert.equal(res.status, 404)
    assert.match(res.json().error, /not found/i)
  })

  it('serves a known district', async () => {
    const { res } = await call({ kind: 'district', id: 'turkana' })
    assert.equal(res.status, 200)
    assert.equal(res.json().data.district.slug, 'turkana')
  })
})

describe('HX-06 — the list carries every card field, counted over the district and not a sample', () => {
  // The list page used to fetch one full overview per card and read four
  // numbers and a hazard line out of it: 2,652 KB measured through the live
  // ingress for five districts, ~2.3 MB of it the 30-row `alert_events` sample
  // each overview embeds. `view=summary` is the replacement, and the property
  // worth pinning is the one that was wrong before it: `open_alert_count` is a
  // count over the district, so a district with more than SAMPLE_LIMIT (30)
  // alerts must not report a count that stops at the sample.
  const alertsFor = (slug, n, openCount) => Array.from({ length: n }, (_, i) => ({
    id: `${slug}-a${i}`,
    status: i < openCount ? 'open' : 'resolved',
    scope: { district: slug },
    occurred_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  }))

  it('counts open alerts over the whole district, past the 30-row sample', async () => {
    // 45 alerts, 41 open. The overview embeds the 30 most recent, so a count
    // read off that sample would report at most 30 and here would say 30.
    const { res } = await call({ kind: 'districts' }, {
      search: '?view=summary',
      data: { alert_events: alertsFor('turkana', 45, 41) },
    })
    const turkana = res.json().data.find((d) => d.slug === 'turkana')
    assert.equal(turkana.counts.open_alert_count, 41,
      'open_alert_count stopped at the sample window rather than counting the district')
  })

  it('agrees with the overview on every field a card draws', async () => {
    const data = {
      alert_events: alertsFor('turkana', 45, 41),
      hazard_events: [{ id: 'h1', severity: 'high', event_type: 'flood', scope: { district: 'turkana' }, occurred_at: '2026-03-01T00:00:00.000Z' }],
      service_assets: [{ id: 's1', lat: 3.1, lon: 35.6 }],
    }
    const list = await call({ kind: 'districts' }, { search: '?view=summary', data })
    const card = list.res.json().data.find((d) => d.slug === 'turkana')
    const overview = await call({ kind: 'district', id: 'turkana' }, { data })
    const o = overview.res.json().data
    assert.equal(card.counts.service_assets, o.counts.service_assets, 'assets disagree between card and overview')
    assert.equal(card.counts.incidents, o.counts.incidents, 'incidents disagree between card and overview')
    assert.equal(card.counts.active_hazard_count, o.counts.hazard_events, 'hazards disagree between card and overview')
    assert.equal(card.latest_hazard.hazard.event_type, o.active_hazards[0].event_type, 'the newest hazard disagrees')
    assert.equal(card.latest_hazard.at, o.active_hazards[0].occurred_at, 'the newest hazard timestamp disagrees')
  })

  it('serves identity alone when no view is asked for', async () => {
    // The default must not grow: a caller reading `/districts` for the registry
    // gets the registry, and the summary is opt-in.
    const { res } = await call({ kind: 'districts' })
    assert.equal(res.json().data.every((d) => d.counts === undefined), true,
      'the bare list grew card fields, so every existing consumer pays for them')
  })

  it('reports a district with no timestamped hazard as having none, not as an error', async () => {
    const { res } = await call({ kind: 'districts' }, {
      search: '?view=summary',
      data: { hazard_events: [{ id: 'h1', severity: 'low', scope: { district: 'turkana' } }] },
    })
    const turkana = res.json().data.find((d) => d.slug === 'turkana')
    assert.equal(turkana.counts.active_hazard_count, 1, 'an untimestamped hazard is still an active hazard')
    assert.equal(turkana.latest_hazard, null, 'a hazard with no parseable time was reported as the newest one')
  })
})
