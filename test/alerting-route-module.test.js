import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleAlertingRoute, matchAlertingRoute } from '../src/routes/alerting.js'

/**
 * ARC-01 — the alerting family, extracted.
 *
 * Three matchers moved as one because they are one lifecycle: a rule raises an
 * event, a protocol pre-authorises what happens to it, an execution records that
 * it fired. Splitting them would put the same `findVisible` call, the same
 * `action_logs` write and the same `include_deleted` question in three modules
 * and let them drift.
 *
 * The property the handler exists to hold is that a *view* — `triage`,
 * `outcome-reasons`, `outcome-tally`, `decision-latency`,
 * `protocol-executions/summary` — is computed and has no `data[...]` key, so a
 * generic collection branch reaching one would read `undefined` and 500. Two
 * things prevent that: every branch tests `route.kind` explicitly, and the views
 * are answered first. Removing either alone changes nothing (canaried); removing
 * both fails `answers every view with a 200 on an empty store`. The assertions
 * below hold the property without pretending to know which belt is doing the
 * work.
 *
 * The verb behaviour is asserted against a probe taken *before* the move: the
 * trigger cluster answers 400 for a malformed POST (not 405) and 405 for a
 * PATCH with no id, and the alert cluster answers 405 for a POST it does not
 * serve. Those are the codes the inline handlers produced; a refactor that
 * changed them would be changing the API.
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

const store = (snapshot = {}) => {
  const merges = []
  return {
    merges,
    merge: async (patch) => { merges.push(patch) },
    read: async () => snapshot,
  }
}

const call = (route, { data = {}, search = '', method = 'GET', body = null, snapshot = {} } = {}) => {
  const res = fakeResponse()
  const s = store(snapshot)
  const req = {
    method,
    __auth: { subject: 'tester', partner_org: null },
    async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)) },
  }
  return handleAlertingRoute(route, {
    data, res, req, store: s,
    url: new URL(`http://127.0.0.1/x${search}`),
    jsonResponse,
  }).then((handled) => ({ handled, res, store: s }))
}

const events = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, title: 'Flood', severity: 'high', status: 'open' }))

describe('ARC-01 — matchAlertingRoute finds every route the cluster serves', () => {
  it('matches the alert routes', () => {
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-events/e1.cap'), { kind: 'cap', id: 'e1' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-events/e1/approve'), { kind: 'alert-event-action', id: 'e1', action: 'approve' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-events/e1/outcome'), { kind: 'alert-outcome', id: 'e1' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-events/triage'), { kind: 'triage' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-outcomes/reasons'), { kind: 'outcome-reasons' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-outcomes/tally'), { kind: 'outcome-tally' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-outcomes/decision-latency'), { kind: 'decision-latency' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-outcomes'), { kind: 'alert-outcomes' })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-rules'), { kind: 'alert-collection', collection: 'alert_rules', id: null })
    assert.deepEqual(matchAlertingRoute('/api/v1/alert-events/e1'), { kind: 'alert-collection', collection: 'alert_events', id: 'e1' })
  })

  it('matches the trigger routes', () => {
    assert.deepEqual(matchAlertingRoute('/api/v1/trigger-protocols'), { kind: 'trigger-collection', id: null })
    assert.deepEqual(matchAlertingRoute('/api/v1/trigger-protocols/p1'), { kind: 'trigger-collection', id: 'p1' })
    assert.deepEqual(matchAlertingRoute('/api/v1/trigger-protocols/p1/backtest'), { kind: 'trigger-action', id: 'p1', action: 'backtest' })
    assert.deepEqual(matchAlertingRoute('/api/v1/trigger-protocols/p1/shadow-run'), { kind: 'trigger-action', id: 'p1', action: 'shadow-run' })
    assert.deepEqual(matchAlertingRoute('/api/v1/trigger-protocols/run'), { kind: 'trigger-run' })
    assert.deepEqual(matchAlertingRoute('/api/v1/protocol-executions'), { kind: 'protocol-executions' })
    assert.deepEqual(matchAlertingRoute('/api/v1/protocol-executions/summary'), { kind: 'protocol-executions-summary' })
  })

  it('keeps `/run` off the record id, so the run route is not swallowed', () => {
    // The generic `/trigger-protocols/:id` pattern would take `run` as an id and
    // the record handler would then 405 a route that exists one matcher later.
    assert.equal(matchAlertingRoute('/api/v1/trigger-protocols/run').kind, 'trigger-run')
  })

  it('does not match a near miss', () => {
    for (const pathname of [
      '/api/v1/alerts', '/api/v1/alert', '/api/v1/alert-outcome', '/api/v1/trigger-protocol',
      '/api/v1/protocol-execution', '/api/v1/protocol-executions/summary/x', '', '/',
    ]) {
      assert.equal(matchAlertingRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })

  it('decodes a percent-encoded id', () => {
    assert.equal(matchAlertingRoute('/api/v1/alert-events/a%20b').id, 'a b')
    assert.equal(matchAlertingRoute('/api/v1/trigger-protocols/p%2Fq').id, 'p/q')
  })
})

describe('ARC-01 — a view is answered before the collection branch reads undefined', () => {
  // The ordering property. Every one of these has no `data[...]` key, so reaching
  // the generic branch would 500 rather than 404 — which is why they come first.
  const VIEWS = [
    ['triage', {}],
    ['outcome-reasons', {}],
    ['outcome-tally', {}],
    ['decision-latency', {}],
  ]

  it('answers every view with a 200 on an empty store', async () => {
    for (const [kind] of VIEWS) {
      const { res } = await call({ kind }, { data: {} })
      assert.equal(res.status, 200, `${kind} did not answer 200 on an empty store`)
    }
  })

  it('answers the protocol-executions summary on an empty store', async () => {
    const { res } = await call({ kind: 'protocol-executions-summary' }, { data: {} })
    const body = res.json()
    assert.equal(res.status, 200)
    assert.equal(body.total, 0)
    assert.equal(body.last_24h, 0)
    assert.deepEqual(body.by_status, {})
    assert.deepEqual(body.latest_per_protocol, {})
  })

  it('ranks triage by the triage module, not by recency', async () => {
    const { res } = await call({ kind: 'triage' }, { data: { alert_events: events(3), hazard_events: [], service_assets: [] } })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.json().data.ranked), 'triage did not answer a ranked list')
    assert.equal(res.json().data.total, 3, 'triage did not count every open alert')
  })

  it('answers the outcome tally over the alerts and the determinations filed against them', async () => {
    const { res } = await call({ kind: 'outcome-tally' }, { data: { alert_events: events(4), alert_outcomes: [] } })
    assert.equal(res.status, 200)
    assert.ok(res.json().data, 'no tally was computed')
  })

  it('serves the closed set of reasons rather than a client-side copy', async () => {
    const { res } = await call({ kind: 'outcome-reasons' }, { data: {} })
    assert.equal(res.status, 200)
    assert.ok(res.json().data, 'the reasons list did not travel')
  })
})

describe('ARC-01 — the CAP feed is XML, and 404s a record it does not hold', () => {
  it('answers application/xml for an alert that exists', async () => {
    const data = { alert_events: [{ id: 'e1', title: 'Flood', severity: 'high', status: 'open' }] }
    const { res } = await call({ kind: 'cap', id: 'e1' }, { data })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/xml/)
    assert.match(res.text(), /<alert/)
  })

  it('answers 404 for an alert that is not there, as JSON not XML', async () => {
    const { res } = await call({ kind: 'cap', id: 'nope' }, { data: { alert_events: [] } })
    assert.equal(res.status, 404)
    assert.equal(res.json().error, 'Alert event not found')
  })
})

describe('ARC-01 — a determination supersedes rather than overwrites', () => {
  it('projects the outcome onto the alert and keeps the outcome as the record', async () => {
    // The property. Overwriting the alert would erase the sequence a false-alert
    // rate is computed from; the projection keeps one field readable for every
    // existing consumer while `alert_outcomes` stays the record.
    const data = {
      alert_events: [{ id: 'e1', title: 'Flood', severity: 'high', status: 'open' }],
      alert_outcomes: [],
    }
    const { res, store: s } = await call({ kind: 'alert-outcome', id: 'e1' }, {
      data, method: 'POST', body: { determination: 'justified', reason: 'hazard_occurred_as_warned', determined_by: 'ops' },
    })
    assert.equal(res.status, 201)
    assert.equal(s.merges.length, 1)
    assert.equal(s.merges[0].alert_outcomes.length, 1, 'the outcome was not stored as the record')
    assert.equal(s.merges[0].alert_events.length, 1, 'the alert was not projected')
  })

  it('records the prior determination as superseded, not lost', async () => {
    const data = {
      alert_events: [{ id: 'e1', title: 'Flood', severity: 'high', status: 'open' }],
      alert_outcomes: [{ id: 'o1', alert_event_id: 'e1', determination: 'false' }],
    }
    const { res } = await call({ kind: 'alert-outcome', id: 'e1' }, {
      data, method: 'POST', body: { determination: 'justified', reason: 'hazard_occurred_as_warned', determined_by: 'ops' },
    })
    assert.equal(res.status, 201)
    assert.equal(res.json().data.supersedes, 'o1', 'the prior determination was not named as superseded')
  })

  it('answers 404 for a determination against an alert that is not there', async () => {
    const { res, store: s } = await call({ kind: 'alert-outcome', id: 'nope' }, {
      data: { alert_events: [], alert_outcomes: [] }, method: 'POST', body: { determination: 'justified' },
    })
    assert.equal(res.status, 404)
    assert.equal(s.merges.length, 0)
  })
})

describe('ARC-01 — the verbs the cluster answered before the move, it answers after', () => {
  it('answers 405 for a POST the alert cluster does not serve', async () => {
    for (const route of [{ kind: 'alert-collection', collection: 'alert_events', id: null }, { kind: 'alert-outcomes' }]) {
      const { res } = await call(route, { data: {}, method: 'POST', body: {} })
      assert.equal(res.status, 405, `${route.kind} answered ${res.status} for a POST`)
    }
  })

  it('answers 405 for a PATCH with no id on the trigger collection', async () => {
    const { res } = await call({ kind: 'trigger-collection', id: null }, { data: {}, method: 'PATCH', body: {} })
    assert.equal(res.status, 405)
  })

  it('answers 404 for a PATCH to a trigger protocol that is not there, not 405', async () => {
    // The verb is served; the record is not. A 405 here would tell the caller
    // their method was wrong when their id was.
    const { res } = await call({ kind: 'trigger-collection', id: 'nope' }, { data: { trigger_protocols: [] }, method: 'PATCH', body: {} })
    assert.equal(res.status, 404)
  })

  it('answers 404 for a backtest of a protocol that is not there', async () => {
    const { res } = await call({ kind: 'trigger-action', id: 'nope', action: 'backtest' }, { data: { trigger_protocols: [] }, method: 'POST' })
    assert.equal(res.status, 404)
  })
})

describe('ARC-01 — a run scoped to an unknown id refuses rather than running nothing', () => {
  it('answers 404 for a protocol_id the store does not hold', async () => {
    // Silently scoping to an empty set would report success and hide the typo.
    const { res } = await call({ kind: 'trigger-run' }, {
      data: {}, method: 'POST', body: { protocol_id: 'nope' }, snapshot: { trigger_protocols: [] },
    })
    assert.equal(res.status, 404)
    assert.match(res.json().error, /No trigger protocol/)
  })

  it('runs the whole set when no id is named', async () => {
    const { res } = await call({ kind: 'trigger-run' }, {
      data: {}, method: 'POST', body: { dry_run: true }, snapshot: { trigger_protocols: [] },
    })
    assert.equal(res.status, 200, 'a dry run did not answer 200')
    assert.equal(res.json().dry_run, true)
  })
})

describe('ARC-01 — the module answers, or declines, without inventing a response', () => {
  it('returns false for a kind it does not own', async () => {
    const { handled, res } = await call({ kind: 'not-an-alerting-route' }, {})
    assert.equal(handled, false)
    assert.equal(res.status, null, 'an unowned kind wrote a response')
  })

  it('answers an absent collection as an empty one', async () => {
    const { handled, res } = await call({ kind: 'trigger-collection', id: null }, { data: {} })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data, [])
  })
})

describe('HX-06 — the alert list answers with a rail row, and the detail route does not', () => {
  // The unit test for `alertRailRow` proves the projection; it cannot prove the
  // route calls it. This drives the handler, because a projection that exists
  // and is never applied is the "written and never read" defect one layer out.
  const fat = () => [{
    id: 'a1', status: 'open', severity: 'high', rule_name: 'Hazard pressure watch',
    created_at: '2026-10-16T00:00:00.000Z',
    derivation: {
      rule_version: 4, input_record_ids: ['h1'],
      context_snapshot: { counts: { hazard_events: 4 } },
    },
  }]

  it('the list drops the counter snapshot and keeps the rail fields', async () => {
    const { res } = await call(
      { kind: 'alert-collection', collection: 'alert_events', id: null },
      { data: { alert_events: fat() }, search: '?limit=200' },
    )
    assert.equal(res.status, 200)
    const row = res.json().data[0]
    assert.equal(row.derivation.context_snapshot, undefined,
      'the list route is still shipping the counter snapshot — 36.6 KB of a 38.3 KB row')
    assert.deepEqual(row.derivation.input_record_ids, ['h1'])
    assert.equal(row.severity, 'high')
    assert.equal(row.rule_name, 'Hazard pressure watch')
  })

  it('the detail route still carries the whole record', async () => {
    // The projection is only honest because the snapshot is reachable somewhere.
    // If this ever stops being true the list has not been slimmed, it has been
    // censored.
    const { res } = await call(
      { kind: 'alert-collection', collection: 'alert_events', id: 'a1' },
      { data: { alert_events: fat() } },
    )
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data.derivation.context_snapshot, { counts: { hazard_events: 4 } },
      'the detail route no longer carries the snapshot, so the list is the only place it was ever readable')
  })

  it('the alert-rules collection is untouched', async () => {
    // The projection is named for one collection. A rule has no derivation and
    // must not be routed through the row projection by accident.
    const rule = { id: 'r1', name: 'Hazard pressure', metric: 'counts.hazard_events', threshold: 3 }
    const { res } = await call(
      { kind: 'alert-collection', collection: 'alert_rules', id: null },
      { data: { alert_rules: [rule] } },
    )
    assert.equal(res.status, 200)
    assert.deepEqual(res.json().data[0], rule)
  })
})
