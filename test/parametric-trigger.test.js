import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { evaluateTrigger, normalizeParametricRule, simulateDisbursement } from '../src/parametric.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * A parametric insurance payout is decided by the trigger, not by the request.
 *
 * The rule stored `trigger_metric` and `trigger_threshold` and nothing ever
 * read them. `simulateDisbursement` copied `disbursement_amount_local_currency`
 * unconditionally, so any POST to `/simulate` produced a full payout — the
 * defining property of parametric cover, that it pays out on an observed event
 * rather than on an adjuster's judgement, was unimplemented. The approval gate
 * was `Boolean(body.focal_point_approved)`, a field the same request set, and
 * none of the three parametric write paths wrote an action log.
 */

const rule = (over = {}) => normalizeParametricRule({
  name: 'Turkana flood cover',
  chain: 'celo-alfajores',
  trigger_metric: 'counts.hazard_events',
  trigger_operator: '>=',
  trigger_threshold: 2,
  disbursement_amount_local_currency: 40000,
  currency: 'KES',
  requires_focal_point_approval: true,
  ...over,
})

const hot = (hazardEvents) => ({ counts: { hazard_events: hazardEvents } })

describe('the parametric trigger is read, not stored', () => {
  it('pays when the observed value crosses the threshold', () => {
    const result = simulateDisbursement(rule(), { focal_point_approved: true, context: hot(5) })
    assert.equal(result.trigger.met, true)
    assert.equal(result.trigger.value, 5)
    assert.equal(result.amount, 40000)
    assert.ok(result.tx_hash.startsWith('sim_'))
    assert.equal(result.status, 'simulated')
  })

  it('does not pay when it does not', () => {
    const result = simulateDisbursement(rule(), { focal_point_approved: true, context: hot(1) })
    assert.equal(result.trigger.met, false)
    assert.equal(result.amount, null, 'no amount is owed, and zero would read as a measured payout of nothing')
    assert.equal(result.tx_hash, null)
    assert.equal(result.status, 'trigger_not_met')
  })

  it('does not pay at the boundary the operator wrote', () => {
    // threshold: 2 with operator >=. A value of exactly 2 satisfies it.
    assert.equal(evaluateTrigger(rule(), hot(2)).met, true)
    assert.equal(evaluateTrigger(rule({ trigger_operator: '>' }), hot(2)).met, false)
    assert.equal(evaluateTrigger(rule({ trigger_operator: '<' }), hot(1)).met, true)
  })

  it('does not pay when the trigger cannot be evaluated', () => {
    // The metric is absent from the context. Reporting this as a non-trigger
    // would be defensible; reporting it as a trigger that fired is not, and
    // silently paying is worse than both.
    const result = simulateDisbursement(rule(), { focal_point_approved: true, context: {} })
    assert.equal(result.trigger.met, null)
    assert.match(result.trigger.note, /could not be evaluated/)
    assert.equal(result.amount, null)
    assert.equal(result.status, 'trigger_not_evaluated')
  })

  it('does not pay a rule that defines no trigger at all', () => {
    // This is the old behaviour, and it is the defect: a rule with no condition
    // is a payment on request wearing a parametric label.
    const bare = normalizeParametricRule({ name: 'No trigger', chain: 'ethereum-sepolia' })
    const result = simulateDisbursement(bare, { focal_point_approved: true, context: {} })
    assert.equal(result.trigger.defined, false)
    assert.equal(result.amount, null)
    assert.equal(result.tx_hash, null)
    assert.match(result.trigger.note, /a request rather than a parametric payment/)
  })

  it('accepts an operator-quoted observation and records where it came from', () => {
    const quoted = simulateDisbursement(rule(), {
      focal_point_approved: true, context: {}, triggerValue: 9,
    })
    assert.equal(quoted.trigger.source, 'supplied')
    assert.equal(quoted.amount, 40000)

    const fromStore = simulateDisbursement(rule(), { focal_point_approved: true, context: hot(9) })
    assert.equal(fromStore.trigger.source, 'context')
  })

  it('refuses a quoted observation that is not a number', () => {
    const result = simulateDisbursement(rule(), {
      focal_point_approved: true, context: {}, triggerValue: 'high',
    })
    assert.equal(result.trigger.met, null)
    assert.match(result.trigger.note, /not a number/)
    assert.equal(result.amount, null)
  })

  it('treats a quoted blank as absent rather than as zero', () => {
    // Number('') is 0, and 0 >= 2 is false, so this particular threshold hides
    // the bug -- but a rule with a negative threshold would have paid on an
    // empty field.
    const result = simulateDisbursement(rule({ trigger_threshold: -5 }), {
      focal_point_approved: true, context: {}, triggerValue: '',
    })
    assert.equal(result.trigger.met, null, 'an empty field is not an observation')
    assert.equal(result.amount, null)
  })

  it('rejects an unknown operator rather than never firing silently', () => {
    assert.throws(
      () => normalizeParametricRule({ name: 'x', chain: 'ethereum-sepolia', trigger_operator: '=~' }),
      (err) => err.statusCode === 400 && /trigger_operator/.test(err.message),
    )
  })

  it('still blocks on sanctions whatever the trigger says', () => {
    assert.throws(
      () => simulateDisbursement(rule(), {
        focal_point_approved: true,
        context: hot(9),
        sanctions: { screened: true, matches: [{ name: 'x' }], blocked: true },
      }),
      (err) => err.statusCode === 409,
    )
  })
})

describe('the focal point approval says where it came from', () => {
  it('records a self-asserted approval as self-asserted', () => {
    const result = simulateDisbursement(rule(), { focal_point_approved: true, context: hot(5), actor: 'operator' })
    assert.equal(result.focal_point_approval.approved, true)
    assert.equal(result.focal_point_approval.verified, false)
    assert.equal(result.focal_point_approval.source, 'request_body')
    assert.match(result.focal_point_approval.note, /self-asserted/)
  })

  it('records a workflow-backed approval as verified, with the instance', () => {
    const result = simulateDisbursement(rule(), {
      focal_point_approved: true,
      context: hot(5),
      actor: 'operator',
      approval: { source: 'workflow', workflow_instance_id: 'w-1', approved_by: 'focal_point_1' },
    })
    assert.equal(result.focal_point_approval.verified, true)
    assert.equal(result.focal_point_approval.workflow_instance_id, 'w-1')
    assert.equal(result.focal_point_approval.approved_by, 'focal_point_1')
  })

  it('says so when the rule does not require approval', () => {
    const open = rule({ requires_focal_point_approval: false })
    const result = simulateDisbursement(open, { context: hot(5) })
    assert.equal(result.focal_point_approval.required, false)
    assert.equal(result.focal_point_approval.approved, false)
    assert.match(result.focal_point_approval.note, /no approval was presented/)
  })

  it('still refuses without any approval', () => {
    assert.throws(
      () => simulateDisbursement(rule(), { focal_point_approved: false, context: hot(9) }),
      (err) => err.statusCode === 409 && /Focal point approval/.test(err.message),
    )
  })
})

describe('the parametric money path over HTTP', () => {
  async function withServer(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-pf-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      return await fn({ base, store })
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  const post = (base, url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  async function createRule(base) {
    const res = await post(base, '/api/v1/parametric-rules', {
      name: 'Turkana cover',
      chain: 'celo-alfajores',
      trigger_metric: 'counts.hazard_events',
      trigger_operator: '>=',
      trigger_threshold: 1,
      disbursement_amount_local_currency: 75000,
    })
    return (await res.json()).data
  }

  it('decides the payout from the store, not from the request', async () => {
    await withServer(async ({ base }) => {
      const created = await createRule(base)
      const res = await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, { actor: 'op' })
      const body = await res.json()

      assert.equal(res.status, 201)
      assert.equal(body.data.status, 'trigger_not_met',
        'the store holds no hazard events, so nothing is owed')
      assert.equal(body.data.amount, null)
      assert.equal(body.data.tx_hash, null)
      assert.equal(body.data.trigger.met, false)
      assert.equal(body.data.trigger.value, 0)
    })
  })

  it('pays once the store shows the event', async () => {
    await withServer(async ({ base, store }) => {
      const created = await createRule(base)
      await store.merge({ hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'high' }] })
      const body = await (await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, { actor: 'op' })).json()
      assert.equal(body.data.status, 'simulated')
      assert.equal(body.data.amount, 75000)
      assert.equal(body.data.trigger.source, 'context')
    })
  })

  it('rejects a workflow instance that has not been confirmed', async () => {
    await withServer(async ({ base, store }) => {
      const created = await createRule(base)
      await store.merge({
        workflow_instances: [{
          id: 'w-1',
          type: 'parametric_disbursement',
          state: 'threshold_breached',
          actor: 'system',
          history: [],
        }],
      })
      const res = await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, {
        focal_point_approved: true,
        workflow_instance_id: 'w-1',
      })
      assert.equal(res.status, 409)
      assert.match((await res.json()).error, /focal point confirmation is required/)
    })
  })

  it('accepts one that has, and marks the approval verified', async () => {
    await withServer(async ({ base, store }) => {
      const created = await createRule(base)
      await store.merge({
        hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'high' }],
        workflow_instances: [{
          id: 'w-1',
          type: 'parametric_disbursement',
          state: 'focal_point_confirmed',
          actor: 'focal_point_1',
          history: [],
        }],
      })
      const body = await (await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, {
        focal_point_approved: true,
        workflow_instance_id: 'w-1',
      })).json()
      assert.equal(body.data.focal_point_approval.verified, true)
      assert.equal(body.data.focal_point_approval.approved_by, 'focal_point_1')
      assert.equal(body.data.status, 'simulated')
    })
  })

  it('refuses an approval from the wrong kind of workflow', async () => {
    await withServer(async ({ base, store }) => {
      const created = await createRule(base)
      await store.merge({
        workflow_instances: [{ id: 'w-2', type: 'anticipatory_alert', state: 'approved', actor: 'fp', history: [] }],
      })
      const res = await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, {
        focal_point_approved: true,
        workflow_instance_id: 'w-2',
      })
      assert.equal(res.status, 409)
      assert.match((await res.json()).error, /cannot approve a disbursement/)
    })
  })

  it('refuses an approval from an instance that does not exist', async () => {
    await withServer(async ({ base }) => {
      const created = await createRule(base)
      const res = await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, {
        focal_point_approved: true,
        workflow_instance_id: 'nope',
      })
      assert.equal(res.status, 409)
      assert.match((await res.json()).error, /not found/)
    })
  })

  it('leaves an audit trail on every write to the money path', async () => {
    await withServer(async ({ base }) => {
      const res = await post(base, '/api/v1/parametric-rules', { name: 'Audited', chain: 'ethereum-sepolia', actor: 'treasurer' })
      const { data: created, action_log: created_log } = await res.json()
      assert.ok(created_log, 'creating a rule writes no record of who created it')

      const patch = await fetch(`${base}/api/v1/parametric-rules/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disbursement_amount_local_currency: 1, actor: 'treasurer' }),
      })
      assert.ok((await patch.json()).action_log, 'editing a rule writes no record of who edited it')

      const sim = await post(base, `/api/v1/parametric-rules/${created.id}/simulate`, { actor: 'treasurer' })
      await sim.json()

      const logs = await (await fetch(`${base}/api/v1/action-logs?collection=parametric_rules`)).json()
      const parametricLogs = (logs.data || []).filter((l) => l.collection.startsWith('parametric_'))
      assert.deepEqual(
        parametricLogs.map((l) => `${l.collection}:${l.action}`).sort(),
        ['parametric_disbursements:simulated', 'parametric_rules:created', 'parametric_rules:updated'],
      )
    })
  })
})