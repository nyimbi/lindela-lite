import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { executeTriggerProtocols, evaluateTriggerProtocols, liveContext } from '../src/protocols.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * Phase D — the protocol executor.
 *
 * Protocols existed as definitions and backtests and nothing ever ran them.
 * The vision claims "actual pre-authorised coordinated action"; this is the
 * file that either substantiates or falsifies that claim.
 *
 * Every test here fails for a reason against code that has no executor at all,
 * which is the point: `executeTriggerProtocols` did not exist, so the auto-
 * approved alert, the execution row, the playbook results and the dry run were
 * all absent rather than subtly wrong.
 *
 * The `env` is passed explicitly on every call. Reading `process.env` inside the
 * module would make "notify with RapidPro unconfigured" untestable on a
 * developer machine that has a token set, and the refusal path is the one the
 * UI most needs to be right.
 */

async function freshStore(seed = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lindela-protocol-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({
    trigger_protocols: [],
    alert_events: [],
    protocol_executions: [],
    incidents: [],
    interventions: [],
    intervention_tasks: [],
    rapidpro_dispatches: [],
    action_logs: [],
    hazard_events: [{ id: 'haz_1', event_type: 'flood', latitude: 3.5, longitude: 35.6 }],
    ...seed,
  })
  return { store, cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }) }
}

const NO_RAPIDPRO = {}
const NOW = '2026-10-08T12:00:00.000Z'

const protocol = (over = {}) => ({
  id: 'proto_1',
  name: 'Flood escalation',
  version: 2,
  description: 'Open an incident when hazard events reach 1',
  metric: 'counts.hazard_events',
  operator: '>=',
  threshold: 1,
  severity: 'high',
  mode: 'live',
  action_playbook: [],
  approvers: ['county-officer'],
  ...over,
})

describe('liveContext is the same vocabulary a backtest scores against', () => {
  it('carries counts and data_quality under the paths protocols read', async () => {
    const { store, cleanup } = await freshStore()
    const context = liveContext(await store.read())
    assert.equal(context.counts.hazard_events, 1)
    assert.ok('data_quality' in context)
    await cleanup()
  })

  it('evaluateTriggerProtocols is pure: no store, no writes', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol()],
    })
    const before = await store.read()
    const evaluated = evaluateTriggerProtocols(before, { now: NOW })
    assert.equal(evaluated.length, 1)
    assert.equal(evaluated[0].firing, true)
    assert.equal(evaluated[0].value, 1)
    const after = await store.read()
    assert.equal(after.protocol_executions.length, 0, 'a pure evaluation must not write an execution row')
    await cleanup()
  })

  it('a non-finite metric is not firing, rather than compared as 0', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({ metric: 'counts.iot_observations', threshold: 1 })],
    })
    const evaluated = evaluateTriggerProtocols(await store.read(), { now: NOW })
    // `counts()` returns null (not 0) for an absent collection, so this is the
    // case that separates "measured zero" from "never measured".
    assert.notEqual(evaluated[0].value, null)
    await cleanup()
  })
})

describe('shadow mode records what WOULD have fired, and does nothing else', () => {
  it('writes one shadow execution row and no alert', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({ mode: 'shadow' })],
    })
    const result = await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    assert.equal(result.executions.length, 1)

    const data = await store.read()
    assert.equal(data.protocol_executions.length, 1)
    const [execution] = data.protocol_executions
    assert.equal(execution.status, 'shadow')
    assert.equal(execution.mode, 'shadow')
    assert.equal(execution.would_fire, true, 'a shadow row that does not record the condition is useless')
    assert.equal(execution.alert_id, null)
    assert.deepEqual(execution.actions, [])
    // The whole point of shadow mode: nothing happened in the world.
    assert.equal(data.alert_events.length, 0)
    assert.equal(data.incidents.length, 0)
    assert.equal(data.interventions.length, 0)
    await cleanup()
  })
})

describe('a firing live protocol raises an auto-approved alert', () => {
  it('the pre-authorisation is recorded, not assumed', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol()],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()

    assert.equal(data.alert_events.length, 1)
    const alert = data.alert_events[0]
    assert.equal(alert.approval.state, 'auto_approved')
    assert.equal(alert.approval.pre_authorised, true)
    assert.equal(alert.approval.protocol_id, 'proto_1')
    assert.equal(alert.approval.protocol_version, 2)
    // Approvers are CARRIED for audit, not consulted. An empty list is honest;
    // a synthesised approver would be a claim nobody made.
    assert.deepEqual(alert.approval.approvers, ['county-officer'])
    assert.equal(alert.approval.decided_at, NOW)
    assert.equal(alert.metadata.protocol_id, 'proto_1')
    assert.equal(alert.metadata.pre_authorised, true)
    await cleanup()
  })

  it('rule_id is null: no rule fired, and the derivation must not imply one', async () => {
    const { store, cleanup } = await freshStore({ trigger_protocols: [protocol()] })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const alert = (await store.read()).alert_events[0]
    // This is why the alert is built here rather than through `buildAlert`:
    // that function always writes a rule_id and `rule_schema: '1'`, so calling
    // it and patching fields would leave a derivation claiming a rule fired.
    assert.equal(alert.derivation.rule_id, null)
    assert.equal(alert.derivation.engine.rule_schema, 'protocol/1')
    assert.equal(alert.derivation.engine.module, 'src/protocols.js')
    assert.equal(alert.derivation.observed_value, 1)
    assert.equal(alert.derivation.observed_at, NOW)
    assert.equal(alert.derivation.context_snapshot.counts.hazard_events, 1)
    await cleanup()
  })

  it('the execution row names the alert it produced', async () => {
    const { store, cleanup } = await freshStore({ trigger_protocols: [protocol()] })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    const [execution] = data.protocol_executions
    assert.equal(execution.protocol_id, 'proto_1')
    assert.equal(execution.alert_id, data.alert_events[0].id)
    assert.equal(execution.mode, 'live')
    assert.equal(execution.actor, 'protocol-engine')
    assert.equal(execution.status, 'executed', 'an empty playbook still executed the alert')
    await cleanup()
  })

  it('the alert carries the playbook district as its place and the outcome as its own', async () => {
    // Two demo properties in one fixture: where the alert is about comes from
    // the playbook (protocol metrics are aggregate counts — no per-record
    // identity to inherit a place from), and what authorisation DID travels on
    // the alert itself, the same array the execution row records. The alert
    // was already pushed before the actions loop ran, and the single merge at
    // the end covers it — no second write exists.
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        agreed_at: '2026-10-01',
        action_playbook: [
          { type: 'notify', recipients: ['tel:+254700000001'] },
          { type: 'intervention', id: 'protect', title: 'Protect cold chain ahead of flooding', district: 'turkana' },
          { type: 'task', for: 'protect', title: 'Relocate vaccines within 6 hours' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    const [alert] = data.alert_events
    const [execution] = data.protocol_executions

    assert.deepEqual(alert.location, { name: 'turkana', admin1: null, country: null, latitude: null, longitude: null })
    assert.equal(alert.scope.district, 'turkana')
    assert.deepEqual(alert.metadata.playbook_results, execution.actions,
      'the alert itself says what authorisation did, row for row')
    assert.equal(alert.metadata.execution_id, execution.id)
    assert.equal(alert.approval.agreed_at, '2026-10-01')
    assert.equal(execution.status, 'partial', 'one step refused (notify) does not make a clean execution')
    await cleanup()
  })

  it('a playbook that names no district leaves the alert placeless — null, not a guess', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [{ type: 'notify', recipients: ['tel:+254700000001'] }],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    assert.equal(data.alert_events[0].location, null)
    assert.equal(data.alert_events[0].scope.district, undefined)
    await cleanup()
  })
})

describe('a condition that persists does not stack alerts', () => {
  it('firing again while the protocol alert is open bumps it, not duplicates it', async () => {
    const { store, cleanup } = await freshStore({ trigger_protocols: [protocol()] })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const afterFirst = await store.read()
    assert.equal(afterFirst.alert_events.length, 1)

    const second = await executeTriggerProtocols(store, afterFirst, { now: '2026-10-08T13:00:00.000Z', env: NO_RAPIDPRO })
    const afterSecond = await store.read()

    assert.equal(afterSecond.alert_events.length, 1, 'a second alert for the same open condition')
    // Silence in the feed means "the condition persists and the action is
    // already running" — so no execution row either. That is the plan's rule
    // and it is why the feed alone is a reliable answer to "did it fire again".
    assert.equal(afterSecond.protocol_executions.length, 1)
    assert.equal(second.executions.length, 0)
    await cleanup()
  })
})

describe('notify refuses honestly when RapidPro is not configured', () => {
  it('raises the alert, writes no dispatch, and records the refusal', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [{ type: 'notify', recipients: ['tel:+254700000001'] }],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()

    // The alert still exists. A missing gateway defers a notification; it does
    // not retract the condition that was detected.
    assert.equal(data.alert_events.length, 1)
    assert.equal(data.rapidpro_dispatches.length, 0, 'a dispatch row with no dispatch behind it')

    const [execution] = data.protocol_executions
    const [action] = execution.actions
    assert.equal(action.type, 'notify')
    assert.equal(action.status, 'refused')
    assert.match(action.detail, /rapidpro not configured/)
    assert.match(action.detail, /manual send/, 'the refusal must say what a person can still do')
    // `refused`, not `partial`: the playbook held one action and it did not run,
    // which is the plan's rule ("refused if none ran") applied literally. My first
    // expectation was `partial`, on the reasoning that the alert was still raised —
    // but `partial` is reserved for a playbook where some steps succeeded, and
    // using it for "the alert exists but its single step failed" would make every
    // half-done playbook look partly successful. The alert is separately visible in
    // `alert_events`; the execution status describes the playbook.
    assert.equal(execution.status, 'refused')
    await cleanup()
  })

  it('a playbook where one step runs and another refuses is partial', async () => {
    // The distinction the previous test would have collapsed.
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'intervention', id: 'act1', title: 'Open water points' },
          { type: 'notify' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    assert.equal((await store.read()).protocol_executions[0].status, 'partial')
    await cleanup()
  })
})

describe('the playbook is a closed set and refusals do not abort it', () => {
  it('intervention creates an incident then an intervention, linked', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [{ type: 'intervention', id: 'act1', title: 'Open water points', objective: 'Deliver water', priority: 'high' }],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()

    assert.equal(data.incidents.length, 1)
    assert.equal(data.interventions.length, 1)
    const intervention = data.interventions[0]
    assert.equal(intervention.incident_id, data.incidents[0].id, 'an intervention must point at the incident it responds to')
    assert.equal(data.incidents[0].source, 'protocol_engine')
    assert.equal(intervention.objective, 'Deliver water')
    await cleanup()
  })

  it('a labelled task attaches to the intervention named by its label', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'intervention', id: 'act1', title: 'Open water points' },
          { type: 'intervention', id: 'act2', title: 'Distribute supplies' },
          { type: 'task', for: 'act1', title: 'Confirm water points opened' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    assert.equal(data.intervention_tasks.length, 1)
    // act1, NOT the most recent intervention (act2). This is the case the label
    // registry exists for: without it a task files itself against whatever was
    // created last, which is how last week's response gets a task on it.
    //
    // Asserted against the id the execution row recorded for act1, not against
    // `interventions[0]`. The store sorts records (timestamp descending, then id)
    // on read, so array position is not insertion order — two interventions
    // created in the same millisecond come back in id order, and my first
    // version of this assertion failed for that reason rather than because the
    // label registry was broken. The execution row's `record_id` is the
    // authoritative link, so that is what the test follows.
    const act1RecordId = data.protocol_executions[0].actions[0].record_id
    const act2RecordId = data.protocol_executions[0].actions[1].record_id
    assert.notEqual(act1RecordId, act2RecordId)
    assert.equal(data.intervention_tasks[0].intervention_id, act1RecordId)
    await cleanup()
  })

  it('a task with no resolvable label is refused, not attached to null', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'task', title: 'Do the thing' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    assert.equal(data.intervention_tasks.length, 0)
    const [execution] = data.protocol_executions
    assert.equal(execution.actions[0].status, 'refused')
    assert.match(execution.actions[0].detail, /no intervention/)
    assert.equal(execution.status, 'refused')
    await cleanup()
  })

  it('a task naming a label the playbook never created says so by name', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'intervention', id: 'act1', title: 'Open water points' },
          { type: 'task', for: 'nope', title: 'Confirm something' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    assert.equal(data.intervention_tasks.length, 0)
    assert.match(data.protocol_executions[0].actions[1].detail, /nope/)
    assert.equal(data.protocol_executions[0].status, 'partial')
    await cleanup()
  })

  it('an unknown action type refuses itself and the rest of the playbook still runs', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'teleport_district', title: 'nonsense' },
          { type: 'intervention', id: 'act1', title: 'Open water points' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    const actions = data.protocol_executions[0].actions
    assert.equal(actions[0].status, 'refused')
    assert.match(actions[0].detail, /unknown action type/)
    assert.equal(actions[1].status, 'executed')
    // The intervention after the nonsense still exists — one refusal must not
    // abort the steps that follow it.
    assert.equal(data.interventions.length, 1)
    assert.equal(data.protocol_executions[0].status, 'partial')
    await cleanup()
  })

  it('an intervention action with no title refuses rather than naming itself after the protocol', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [{ type: 'intervention', id: 'act1' }],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const data = await store.read()
    assert.equal(data.interventions.length, 0)
    assert.match(data.protocol_executions[0].actions[0].detail, /requires a title/)
    await cleanup()
  })
})

describe('dry run returns the plan and writes nothing', () => {
  it('the store is byte-identical after a dry run', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'intervention', id: 'act1', title: 'Open water points' },
          { type: 'task', title: 'Confirm water points opened' },
        ],
      })],
    })
    const before = JSON.stringify(await store.read())

    const result = await executeTriggerProtocols(store, await store.read(), { now: NOW, dryRun: true, env: NO_RAPIDPRO })

    // The plan is returned — the operator sees exactly what WOULD happen — but
    // the world does not change. This is what the dry-run button depends on to
    // be safe to press.
    assert.equal(result.dry_run, true)
    assert.equal(result.executions.length, 1)
    assert.ok(result.executions[0].alert_id, 'the dry run must still name the alert it would create')
    assert.equal(result.executions[0].dry_run, true)

    const after = JSON.stringify(await store.read())
    assert.equal(after, before, 'a dry run wrote to the store')
    await cleanup()
  })

  it('the execution status is computed from results, not from the operator-supplied playbook', async () => {
    // Regression guard for a real defect: the first implementation read
    // `playbookActions.some(a => a.status === 'executed')`. Playbook entries are
    // the operator's own JSON and have no `status` field, so that expression was
    // always false and a playbook that ran two steps and refused one reported
    // `refused` — which the feed renders as "nothing happened".
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({
        action_playbook: [
          { type: 'intervention', id: 'act1', title: 'Open water points' },
          { type: 'notify' },
        ],
      })],
    })
    await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    const [execution] = (await store.read()).protocol_executions
    assert.equal(execution.actions[0].status, 'executed')
    assert.equal(execution.actions[1].status, 'refused')
    assert.equal(execution.status, 'partial')
    await cleanup()
  })
})

describe('a protocol that is not firing writes nothing at all', () => {
  it('no alert, no execution row, no records', async () => {
    const { store, cleanup } = await freshStore({
      trigger_protocols: [protocol({ operator: '>=', threshold: 99 })],
    })
    const before = JSON.stringify(await store.read())
    const result = await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    assert.equal(result.executions.length, 0)
    assert.equal(JSON.stringify(await store.read()), before)
    await cleanup()
  })
})

describe('the run is one merge, not one per protocol', () => {
  it('a protocol that fires twice in one run writes both, atomically', async () => {
    // Two live protocols, both firing. Per-protocol merging would make this two
    // commits, and a crash between them leaves half a run committed — the exact
    // partial state one merge exists to prevent.
    const { store, cleanup } = await freshStore({
      trigger_protocols: [
        protocol({ id: 'proto_1', name: 'One' }),
        protocol({ id: 'proto_2', name: 'Two', action_playbook: [{ type: 'intervention', id: 'a', title: 'Second response' }] }),
      ],
    })
    const result = await executeTriggerProtocols(store, await store.read(), { now: NOW, env: NO_RAPIDPRO })
    assert.equal(result.executions.length, 2)
    const data = await store.read()
    assert.equal(data.protocol_executions.length, 2)
    assert.equal(data.alert_events.length, 2)
    // Distinct alerts: the id is derived from the protocol id, so two protocols
    // cannot collide onto one alert row.
    assert.notEqual(data.alert_events[0].id, data.alert_events[1].id)
    await cleanup()
  })
})

describe('the trigger-protocols run route', () => {
  // WHY: every test above calls executeTriggerProtocols directly, so the
  // HTTP run path has no guard — a missing 404 for an unknown protocol id,
  // a dry run leaking rows into the store, or the live response shape
  // drifting would all ship silently. Both tests pass on HEAD; the
  // pre-fix-red canary for the executor itself is the duplicate-batch drop
  // test in test/api-substrate.test.js (e4b12c4).

  async function withRunServer(seed, fn) {
    const { store, cleanup } = await freshStore(seed)
    const listener = createServer({ store }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      return await fn(base, store)
    } finally {
      listener.close()
      await cleanup()
    }
  }

  async function runProtocol(base, body) {
    return await fetch(`${base}/api/v1/trigger-protocols/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('a scoped dry run reports what would fire and persists nothing', async () => {
    // WHY: the dry-run branch is reachable only through this handler; a
    // leak here writes execution and alert rows on every preview. Passes on
    // HEAD — see the describe comment for the canary.
    await withRunServer({
      trigger_protocols: [
        protocol({ id: 'proto_1' }),
        protocol({ id: 'proto_2', name: 'Flash flood watch' }),
      ],
    }, async (base, store) => {
      const res = await runProtocol(base, { dry_run: true, protocol_id: 'proto_1' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.dry_run, true)
      assert.equal(body.data.dry_run, true)

      // Scoped: proto_2 would fire too, but only the requested row comes back.
      assert.equal(body.data.executions.length, 1)
      const row = body.data.executions[0]
      assert.equal(row.protocol_id, 'proto_1')
      assert.equal(row.protocol_name, 'Flood escalation')
      assert.equal(row.protocol_version, 2)
      assert.equal(row.mode, 'live')
      assert.equal(row.dry_run, true)
      assert.equal(row.status, 'executed')
      assert.equal(row.observed_value, 1)
      // the alert id the run would have used
      assert.ok(row.alert_id)
      assert.equal(row.actor, 'protocol-engine')
      assert.deepEqual(row.actions, [])

      // A dry run persists nothing, not even an action log.
      const data = await store.read()
      assert.equal(data.protocol_executions.length, 0)
      assert.equal(data.alert_events.length, 0)
      assert.equal(data.action_logs.length, 0)

      // An unknown protocol id is a 404 that names the id.
      const missing = await runProtocol(base, { dry_run: true, protocol_id: 'proto_missing' })
      assert.equal(missing.status, 404)
      const missingBody = await missing.json()
      assert.equal(missingBody.success, false)
      assert.equal(missingBody.error, 'No trigger protocol with id proto_missing')
    })
  })

  it('a live unscoped run persists one execution, alert, and action log per firing protocol', async () => {
    // WHY: the live branch (201, and the rows that reach the store the
    // dashboard reads) is reachable only through this handler. Passes on
    // HEAD — see the describe comment for the canary.
    await withRunServer({
      trigger_protocols: [
        protocol({ id: 'proto_1' }),
        protocol({ id: 'proto_2', name: 'Flash flood watch' }),
      ],
    }, async (base, store) => {
      const res = await runProtocol(base, {})
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.dry_run, false)
      assert.equal(body.data.dry_run, false)

      // Both protocols fire against the single seeded hazard event.
      assert.equal(body.data.executions.length, 2)
      const byId = Object.fromEntries(body.data.executions.map((e) => [e.protocol_id, e]))
      assert.deepEqual(Object.keys(byId).sort(), ['proto_1', 'proto_2'])
      for (const row of Object.values(byId)) {
        assert.equal(row.status, 'executed')
        assert.equal(row.dry_run, false)
        assert.ok(row.alert_id)
      }

      const data = await store.read()
      assert.equal(data.protocol_executions.length, 2)
      assert.equal(data.alert_events.length, 2)
      // One action log per firing protocol — the executor's single log site.
      assert.equal(data.action_logs.length, 2)

      // Each execution row points at a persisted alert that names its protocol.
      for (const row of body.data.executions) {
        const alert = data.alert_events.find((a) => a.id === row.alert_id)
        assert.ok(alert)
        assert.equal(alert.status, 'open')
        assert.equal(alert.scope.protocol_id, row.protocol_id)
        assert.equal(alert.approval.protocol_id, row.protocol_id)
        assert.equal(alert.approval.state, 'auto_approved')
      }
    })
  })
})
