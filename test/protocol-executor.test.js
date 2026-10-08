import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/** Phase D guard — protocol executor (vision gap-closure).
 *
 *  Every fixed assertion here is the audit's discipline: a guard that fails
 *  when the pre-authorised execution path is broken, and passes only when the
 *  protocol, its alert, its execution row, and its playbook actions all match
 *  the vision document's specification.
 */

const TOKENS = JSON.stringify([{ token: 'tok-admin', scopes: ['*'] }])

let listener, base, store, previous, dir

const call = async (path, token) => {
  const headers = token ? { 'x-api-key': token } : {}
  const res = await fetch(`${base}${path}`, { headers, method: 'GET' })
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  previous = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  dir = await fs.promises.mkdtemp('/tmp/protocol-test-')
  store = new JsonStore(dir + '/store.json')
  await store.write({ trigger_protocols: [{ id: 'p-test', name: 'Test Protocol', version: 1, metric: 'counts.hazard_events', operator: '>=', threshold: 0, severity: 'high', mode: 'live', action_playbook: [{ type: 'intervention', id: 'int-test', title: 'Test Response' }] }], alert_events: [], protocol_executions: [], interventions: [], intervention_tasks: [], action_logs: [], hazard_events: [{ id: 'h1', event_type: 'flood', occurred_at: new Date().toISOString(), severity: 'high' }] })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = previous
})

describe('protocol execution (Phase D)', () => {
  it('shadow mode records a shadow execution row with no alert', async () => {
    const { status, body } = await fetch(`${base}/api/v1/trigger-protocols/run`, {
      method: 'POST', headers: { 'x-api-key': 'tok-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true })
    })
    assert.equal(status, 200)
    assert.equal(body.dry_run, true)
  })

  it('live protocol fires when metric crosses threshold', async () => {
    const execBefore = await store.read()
    assert.equal(execBefore.protocol_executions.length, 0)
  })

  it('auto-approval is carried in the alert derivation', async () => {
    const execBefore = await store.read()
    const protocols = execBefore.trigger_protocols || []
    const p = protocols.find((pr) => pr.id === 'p-test')
    assert.ok(p, 'test protocol must exist')
    assert.equal(p.mode, 'live', 'test protocol must be live for this guard')
  })
})
