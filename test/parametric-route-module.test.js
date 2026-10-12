import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import {
  handleParametricRoute, matchParametricRoute, resolveFocalPointApproval,
} from '../src/routes/parametric.js'
import { emptyStore } from '../src/schema.js'

/**
 * ARC-01 — the parametric family as a module, asserted where it now lives.
 *
 * These four routes over three paths are one module because they are the money
 * path: the rule says what gets paid, to whom and on what condition, the
 * simulation decides one, and the disbursement is the record of it having
 * happened. Anyone asking "why did this payout happen" reads all four together.
 *
 * The properties asserted here are the ones that were bugs once:
 *
 *   - **a one-rule edit does not rewrite the store.** R-25: these routes used
 *     `store.write()` — a full-snapshot write that silently reverts a concurrent
 *     write to another collection — to change one rule.
 *   - **a deletion is archived, not summarised.** The action log carries the
 *     whole removed rule, because the rule defined the payout condition.
 *   - **an approval is verified, not asserted.** A workflow instance that is
 *     named but not confirmed is a 409, not a silently accepted flag.
 *   - **the trigger is evaluated against the platform's own state**, so a payout
 *     is decided by the data rather than asserted by the caller.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
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

const makeReq = (method, body, auth = { subject: 'operator-1' }) => ({
  method,
  headers: {},
  __auth: auth,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

/**
 * A store that records *how* it was written. `replaceCollection` and `write` are
 * both recorded, so a test can assert which one the route chose — the whole
 * point of the R-25 property.
 */
function recordingStore(initial = {}) {
  const state = { ...emptyStore(), ...initial }
  const calls = { replaceCollection: [], write: [], merge: [] }
  return {
    state,
    calls,
    async read() { return state },
    async replaceCollection(collection, records) {
      calls.replaceCollection.push(collection)
      state[collection] = records
      return records
    },
    async write(next) { calls.write.push(next); return next },
    async merge(partial) {
      calls.merge.push(partial)
      for (const [collection, records] of Object.entries(partial)) {
        state[collection] = [...(state[collection] || []), ...records]
      }
      return partial
    },
  }
}

const call = (route, { data = {}, method = 'GET', body, store } = {}) => {
  // The dispatcher passes the store's own state as `data` — `counts(data)` walks
  // every collection, so a partial object is not a state the route ever sees.
  const backing = store || recordingStore(data)
  const res = fakeResponse()
  return handleParametricRoute(route, {
    store: backing, data: backing.state, res, jsonResponse, req: makeReq(method, body),
  }).then((handled) => ({ handled, res, store: backing }))
}

const rule = (over = {}) => ({
  id: 'r1',
  name: 'Flood trigger',
  chain: 'ethereum-sepolia',
  contract_address: null,
  trigger_metric: 'counts.hazard_events',
  trigger_operator: '>=',
  trigger_threshold: 1,
  disbursement_amount_local_currency: 5000,
  currency: 'USD',
  recipient_group_id: 'group-1',
  requires_focal_point_approval: false,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  metadata: {},
  ...over,
})

describe('ARC-01 — matchParametricRoute', () => {
  it('matches the four route kinds over three paths', () => {
    assert.deepEqual(matchParametricRoute('/api/v1/parametric-rules'), { kind: 'rules-list' })
    assert.deepEqual(matchParametricRoute('/api/v1/parametric-rules/r1'), { kind: 'rule-detail', id: 'r1' })
    assert.deepEqual(matchParametricRoute('/api/v1/parametric-rules/r1/simulate'), { kind: 'simulate', id: 'r1' })
    assert.deepEqual(matchParametricRoute('/api/v1/parametric-disbursements'), { kind: 'disbursements-list' })
  })

  it('does not match a near miss', () => {
    for (const pathname of ['/api/v1/parametric-rule', '/api/v1/parametric-rules/r1/x', '/api/v1/parametric-rules/']) {
      assert.equal(matchParametricRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ARC-01 — a one-rule edit replaces the collection, not the store', () => {
  it('edits a rule with replaceCollection and never a whole-store write', async () => {
    const data = { parametric_rules: [rule()] }
    const { res, store } = await call({ kind: 'rule-detail', id: 'r1' }, {
      data, method: 'PATCH', body: { status: 'paused' },
    })
    assert.equal(res.status, 200)
    assert.equal(store.state.parametric_rules[0].status, 'paused')
    assert.deepEqual(store.calls.replaceCollection, ['parametric_rules'],
      'the edit did not go through replaceCollection')
    assert.equal(store.calls.write.length, 0,
      'a one-rule edit rewrote the whole store (R-25)')
  })

  it('logs the edit as its own merge rather than a reason to rewrite the world', async () => {
    const data = { parametric_rules: [rule()] }
    const { store } = await call({ kind: 'rule-detail', id: 'r1' }, {
      data, method: 'PATCH', body: { status: 'paused' },
    })
    assert.equal(store.state.action_logs.length, 1)
    assert.equal(store.state.action_logs[0].action, 'updated')
  })
})

describe('ARC-01 — a deletion is archived, not summarised', () => {
  it('carries the whole removed rule in the action log', async () => {
    const data = { parametric_rules: [rule({ id: 'r1', name: 'Fodder subsidy' })] }
    const { res, store } = await call({ kind: 'rule-detail', id: 'r1' }, { data, method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(store.state.parametric_rules.length, 0, 'the rule was not removed')
    const log = store.state.action_logs.at(-1)
    assert.equal(log.action, 'deleted')
    assert.equal(log.metadata.removed_rule.id, 'r1',
      'the delete left only "a rule was deleted" behind — the audit chain is broken at the point it mattered')
    assert.equal(log.metadata.removed_rule.name, 'Fodder subsidy')
    assert.equal(log.metadata.removed_rule.trigger_threshold, 1)
    assert.deepEqual(store.calls.replaceCollection, ['parametric_rules'])
  })

  it('answers 404 for a rule that is not there', async () => {
    const { res } = await call({ kind: 'rule-detail', id: 'missing' }, { data: { parametric_rules: [] }, method: 'DELETE' })
    assert.equal(res.status, 404)
  })
})

describe('ARC-01 — an approval is verified, not asserted', () => {
  it('accepts a confirmed parametric_disbursement instance as a real approval', () => {
    const data = {
      workflow_instances: [
        { id: 'w1', type: 'parametric_disbursement', state: 'focal_point_confirmed', actor: 'focal-point-1' },
      ],
    }
    const approval = resolveFocalPointApproval(data, rule({ requires_focal_point_approval: true }), { workflow_instance_id: 'w1' })
    assert.equal(approval.approved, true)
    assert.equal(approval.source, 'workflow', 'a verified approval was not marked as verified')
    assert.equal(approval.approved_by, 'focal-point-1')
  })

  it('refuses a named instance that has not been confirmed', () => {
    const data = {
      workflow_instances: [{ id: 'w1', type: 'parametric_disbursement', state: 'focal_point_review' }],
    }
    assert.throws(
      () => resolveFocalPointApproval(data, rule({ requires_focal_point_approval: true }), { workflow_instance_id: 'w1' }),
      (err) => err.statusCode === 409,
      'an unconfirmed instance was accepted as an approval',
    )
  })

  it('refuses an instance of the wrong type', () => {
    const data = { workflow_instances: [{ id: 'w1', type: 'anticipatory_alert', state: 'closed' }] }
    assert.throws(
      () => resolveFocalPointApproval(data, rule({ requires_focal_point_approval: true }), { workflow_instance_id: 'w1' }),
      (err) => err.statusCode === 409,
    )
  })

  it('refuses an instance that does not exist', () => {
    assert.throws(
      () => resolveFocalPointApproval({ workflow_instances: [] }, rule(), { workflow_instance_id: 'ghost' }),
      (err) => err.statusCode === 409,
    )
  })

  it('records a request-body flag as self-asserted, not as verified', () => {
    const approval = resolveFocalPointApproval({ workflow_instances: [] }, rule({ requires_focal_point_approval: true }), { focal_point_approved: true })
    assert.equal(approval.approved, true)
    assert.equal(approval.source, 'request_body', 'a self-asserted flag was upgraded to a verification')
    assert.notEqual(approval.source, 'workflow')
  })
})

describe('ARC-01 — the trigger is evaluated against the platform’s own state', () => {
  it('pays when the platform state satisfies the trigger', async () => {
    const data = { parametric_rules: [rule()], hazard_events: [{ id: 'h1', event_type: 'flood' }] }
    const { res, store } = await call({ kind: 'simulate', id: 'r1' }, { data, method: 'POST', body: {} })
    assert.equal(res.status, 201)
    const result = res.json().data
    assert.equal(result.status, 'simulated', 'a satisfied trigger did not pay')
    assert.equal(result.amount, 5000)
    assert.ok(result.tx_hash, 'a payable disbursement minted no transaction')
    assert.equal(result.trigger.source, 'context', 'the trigger was not decided from platform state')
    assert.deepEqual(store.calls.replaceCollection, ['parametric_disbursements'])
  })

  it('pays nothing when the platform state does not satisfy the trigger', async () => {
    // No hazard events: `counts.hazard_events` is 0, below the threshold of 1.
    const data = { parametric_rules: [rule()], hazard_events: [] }
    const { res } = await call({ kind: 'simulate', id: 'r1' }, { data, method: 'POST', body: {} })
    assert.equal(res.status, 201)
    const result = res.json().data
    assert.equal(result.status, 'trigger_not_met', 'an unmet trigger paid')
    assert.equal(result.amount, null, 'an unmet trigger paid an amount')
    assert.equal(result.tx_hash, null, 'an unmet trigger minted a transaction hash for nothing')
  })

  it('lets an explicit trigger_value override the platform state', async () => {
    const data = { parametric_rules: [rule()], hazard_events: [] }
    const { res } = await call({ kind: 'simulate', id: 'r1' }, {
      data, method: 'POST', body: { trigger_value: 5 },
    })
    const result = res.json().data
    assert.equal(result.trigger.source, 'supplied', 'an explicit trigger value did not override the context')
    assert.equal(result.amount, 5000)
  })

  it('answers 405 for a verb the simulate route does not serve', async () => {
    const { handled, res } = await call({ kind: 'simulate', id: 'r1' }, { data: { parametric_rules: [rule()] }, method: 'GET' })
    assert.equal(handled, true)
    assert.equal(res.status, 405)
  })
})
