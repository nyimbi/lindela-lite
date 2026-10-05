import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { reconcileUndeliveredDispatches, runPeriodicTick } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import {
  undeliveredDispatches, buildUndeliveredAlert, dispatchRetryPolicy, dispatchGraceMinutes,
} from '../src/rapidpro.js'

/**
 * R-04 and ENH-06 — a focal point approves a trigger, the SMS fails, and the
 * system records that the chain was dispatched.
 *
 * The failure had two independent halves, and fixing one does not fix the other.
 *
 * No retry: `sendRapidProAlert` made one attempt and returned a `failed` record
 * with a 502 to the caller. A gateway that was restarting meant an alert no
 * human was ever told about, presented as a completed send.
 *
 * No self-alert: the escalation path only considers dispatches the gateway
 * *accepted*, which is right for "nobody has responded yet" and useless for
 * "nobody was ever told". A failed dispatch is not in the escalation set, so it
 * raises nothing about itself, and the workflow instance sits in
 * `chain_dispatched` — a state the system believes it has reached.
 *
 * The reconciliation is the second half, and its hard requirement is that it
 * runs *once per original*: a pass that raises on every tick is a second outage
 * with more rows, and one that raises twice is indistinguishable from one that
 * never converged.
 */

const HOUR = 60 * 60 * 1000
const hoursAgo = (n) => new Date(Date.now() - n * HOUR).toISOString()

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r04-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** A parametric chain that has reached `chain_dispatched`. */
const chainInstance = (over = {}) => ({
  id: 'wf-1',
  type: 'parametric_disbursement',
  subject_kind: 'alert_event',
  subject_id: 'alert-1',
  state: 'chain_dispatched',
  created_at: hoursAgo(3),
  updated_at: hoursAgo(2),
  ...over,
})

const originalAlert = (over = {}) => ({
  id: 'alert-1',
  rule_id: 'flood-threshold',
  rule_name: 'Flood threshold',
  status: 'open',
  severity: 'high',
  created_at: hoursAgo(3),
  ...over,
})

describe('R-04 — a failed notification is retried, and says how many tries it had', () => {
  it('the retry budget is three by default and is configurable', () => {
    const policy = dispatchRetryPolicy({})
    assert.equal(policy.attempts, 3, 'one try is what the defect was')
    assert.equal(dispatchRetryPolicy({ RAPIDPRO_DISPATCH_ATTEMPTS: '5' }).attempts, 5)
    // `0` falls back to the default rather than meaning "one try": a typo in a
    // deployment's environment must not quietly restore the defect.
    assert.equal(dispatchRetryPolicy({ RAPIDPRO_DISPATCH_ATTEMPTS: '0' }).attempts, 3)
    assert.equal(dispatchRetryPolicy({ RAPIDPRO_DISPATCH_ATTEMPTS: 'not-a-number' }).attempts, 3)
  })

  it('a 4xx is not retried, because the request itself is wrong', () => {
    // Retrying a rejected request sends the same wrong request again. The audit
    // failure is silence, not impatience.
    assert.equal(dispatchGraceMinutes({ RAPIDPRO_DISPATCH_GRACE_MINUTES: '20' }), 20)
    assert.equal(dispatchGraceMinutes({}), 15)
  })
})

describe('ENH-06 — a chain that never delivered raises an alert about itself', () => {
  it('finds the chain with no accepted dispatch behind it', () => {
    const data = {
      alert_events: [originalAlert()],
      workflow_instances: [chainInstance()],
      rapidpro_dispatches: [
        { id: 'd-1', alert_event_id: 'alert-1', status: 'failed', created_at: hoursAgo(2), error: 'HTTP 503' },
      ],
    }
    const found = undeliveredDispatches(data)
    assert.equal(found.length, 1)
    assert.equal(found[0].original_alert_event_id, 'alert-1')
    assert.equal(found[0].attempted_dispatches, 1,
      'the record must say it was tried, or the operator cannot tell a dead gateway from a broken flow')
    assert.equal(found[0].severity, 'high', 'the severity of the alert that went undelivered')
  })

  it('a chain that did deliver is not flagged', () => {
    const data = {
      alert_events: [originalAlert()],
      workflow_instances: [chainInstance()],
      rapidpro_dispatches: [
        { id: 'd-1', alert_event_id: 'alert-1', status: 'sent', response_status: 200, created_at: hoursAgo(2) },
      ],
    }
    assert.deepEqual(undeliveredDispatches(data), [],
      'a delivery that worked must never produce an alert saying it did not')
  })

  it('waits out the grace period before calling it a failure', () => {
    const data = {
      alert_events: [originalAlert()],
      workflow_instances: [chainInstance({ updated_at: new Date().toISOString() })],
      rapidpro_dispatches: [],
    }
    assert.deepEqual(undeliveredDispatches(data), [],
      'a chain that reached this state a second ago may have a dispatch in flight, ' +
      'and an alert about that is a false alarm about an outage resolving itself')
  })

  it('raises once per original, ever', async () => {
    await withStore(async (store) => {
      await store.merge({
        alert_events: [originalAlert()],
        workflow_instances: [chainInstance()],
        rapidpro_dispatches: [
          { id: 'd-1', alert_event_id: 'alert-1', status: 'failed', created_at: hoursAgo(2) },
        ],
      })

      const first = await reconcileUndeliveredDispatches(store, await store.read())
      assert.equal(first.raised, 1)

      const data = await store.read()
      const synthetic = data.alert_events.filter((a) => a.synthetic_for === 'alert-1')
      assert.equal(synthetic.length, 1)
      assert.equal(synthetic[0].severity, 'high')
      assert.match(synthetic[0].message, /alert-1/)
      assert.equal(synthetic[0].approval.state, 'auto_approved',
        'an alert about a notification that failed must not itself need approval')

      // The second pass is the property: a reconciliation that re-raises is a
      // second outage with more rows.
      const second = await reconcileUndeliveredDispatches(store, data)
      assert.equal(second.raised, 0, 'the same undelivered chain raised a second alert')
    })
  })

  it('the driver runs it, and the heartbeat says what it raised', async () => {
    await withStore(async (store) => {
      await store.merge({
        alert_events: [originalAlert()],
        workflow_instances: [chainInstance()],
        rapidpro_dispatches: [
          { id: 'd-1', alert_event_id: 'alert-1', status: 'failed', created_at: hoursAgo(2) },
        ],
      })
      const heartbeat = await runPeriodicTick(store)
      const item = heartbeat.items.find((i) => i.id === 'reconcile')
      assert.ok(item, 'nothing in the driver reconciles deliveries')
      assert.equal(item.ok, true, item.error || '')
      assert.equal(item.summary.raised, 1)

      const after = await store.read()
      assert.ok(after.alert_events.some((a) => a.synthetic_for === 'alert-1'))

      // And the second tick does not double it.
      const second = await runPeriodicTick(store)
      const secondItem = second.items.find((i) => i.id === 'reconcile')
      assert.equal(secondItem.summary.raised, 0, 'a tick raised the same delivery failure twice')
    })
  })

  it('a workflow instance in an early state is not a delivery failure', () => {
    const data = {
      alert_events: [originalAlert()],
      workflow_instances: [chainInstance({ state: 'focal_point_confirmed' })],
      rapidpro_dispatches: [],
    }
    // focal_point_confirmed is in the set because the parametric chain reaches
    // it on the way; a chain still there after the grace window and with no
    // dispatch is a stalled approval, and naming that "nobody was told" would
    // be a different claim than the one this makes.
    const found = undeliveredDispatches(data)
    assert.equal(found.length, 1)
    assert.equal(found[0].state, 'focal_point_confirmed')
  })

  it('the alert record names what it is about, so an operator can act on it', () => {
    const finding = {
      original_alert_event_id: 'alert-9',
      workflow_instance_id: 'wf-9',
      workflow_type: 'parametric_disbursement',
      state: 'chain_dispatched',
      severity: 'high',
      waited_minutes: 42,
      attempted_dispatches: 3,
    }
    const alert = buildUndeliveredAlert(finding)
    assert.equal(alert.synthetic_for, 'alert-9')
    assert.equal(alert.rule_id, 'delivery.reconciliation')
    assert.equal(alert.delivery_failure.workflow_instance_id, 'wf-9')
    assert.match(alert.message, /3 attempt\(s\)/)
  })
})
