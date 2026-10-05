import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { describe, it } from 'node:test'
import { JsonStore } from '../src/store.js'
import { emit, dispatchPending } from '../src/outbox.js'

/**
 * R-21 and R-22 — the outbox delivered twice, and announced things that never
 * happened.
 *
 * R-21: `dispatchPending` read the pending set, delivered to every matched
 * webhook, then merged the outcomes. Two concurrent calls read the same rows and
 * both delivered them. For a disbursement or an incident that is the worst kind
 * of duplicate: idempotent on the wire, twice in the world.
 *
 * R-22: `emit` and the caller's own writes were two merges, emit first. A
 * failure of the second left an outbox event announcing a transition that never
 * happened, and subscribers act on events — that is the failure this store's
 * whole outbox pattern exists to make impossible, reintroduced by the order of
 * two lines.
 *
 * The test below drives two real dispatches against a real HTTP listener, so
 * "delivered twice" is counted by the receiver rather than inferred.
 */

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-outbox-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  try {
    return await fn(store)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** A webhook receiver that records what it was sent, in order. */
async function receiver() {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

describe('R-21 — one dispatch at a time, so nothing is delivered twice', () => {
  it('two concurrent dispatches deliver the event once', async () => {
    const hook = await receiver()
    try {
      await withStore(async (store) => {
        await emit(store, 'incident.created', { id: 'inc-1' })
        const webhooks = [{ id: 'wh-1', url: hook.url, status: 'active', events: ['incident.created'] }]

        await Promise.all([
          dispatchPending(store, { webhooks, checkUrl: async () => {} }),
          dispatchPending(store, { webhooks, checkUrl: async () => {} }),
        ])

        assert.equal(hook.received.length, 1,
          `the subscriber was told ${hook.received.length} times about one transition; ` +
          'for a disbursement that is money sent twice')
      })
    } finally {
      await hook.close()
    }
  })

  it('the second caller sees the first one\'s result, not a stale pending set', async () => {
    const hook = await receiver()
    try {
      await withStore(async (store) => {
        await emit(store, 'incident.created', { id: 'inc-2' })
        const webhooks = [{ id: 'wh-1', url: hook.url, status: 'active', events: ['incident.created'] }]
        const [first, second] = await Promise.all([
          dispatchPending(store, { webhooks, checkUrl: async () => {} }),
          dispatchPending(store, { webhooks, checkUrl: async () => {} }),
        ])
        assert.equal(first.dispatched + second.dispatched, 1,
          'one of them should have found nothing pending — a lock that lets both report a delivery is not a lock')
      })
    } finally {
      await hook.close()
    }
  })

  it('a failure inside the lock does not poison the next dispatch', async () => {
    await withStore(async (store) => {
      await emit(store, 'incident.created', { id: 'inc-3' })
      // checkUrl throws: the SSRF guard refusing a URL. That rejection must not
      // leave the lock held, or the outbox is dead for the life of the process.
      const webhooks = [{ id: 'wh-1', url: 'http://169.254.169.254/latest', status: 'active', events: ['incident.created'] }]
      await dispatchPending(store, { webhooks })
      const second = await dispatchPending(store, {
        webhooks: [{ id: 'wh-2', url: 'http://127.0.0.1:1/hook', status: 'active', events: ['incident.created'] }],
        checkUrl: async () => {},
      })
      assert.ok(second, 'a second dispatch must still run')
    })
  })
})

describe('R-22 — an event and the thing it announces land together', () => {
  it('the event and the record are written in one merge', async () => {
    await withStore(async (store) => {
      const record = { id: 'wf-r22', type: 'parametric_disbursement', subject_kind: 'alert_event', subject_id: 'a-1', state: 'chain_dispatched' }
      const event = await emit(store, 'workflow.transitioned', { workflow_id: record.id }, { workflow_instances: [record] })
      const data = await store.read()
      assert.ok(data.workflow_instances.some((w) => w.id === record.id))
      assert.ok(data.events_outbox.some((e) => e.id === event.id),
        'the event announcing the transition must exist')
    })
  })

  it('a merge that only half-lands is impossible for the pair', async () => {
    // The property, stated as what a reader can rely on: after this call there
    // is no state in which the event exists and the record does not.
    await withStore(async (store) => {
      const record = { id: 'wf-r22b', type: 'parametric_disbursement', subject_kind: 'alert_event', subject_id: 'a-2', state: 'closed' }
      await emit(store, 'workflow.transitioned', { workflow_id: record.id }, { workflow_instances: [record] })
      const data = await store.read()
      const hasEvent = data.events_outbox.some((e) => e.payload?.workflow_id === record.id)
      const hasRecord = data.workflow_instances.some((w) => w.id === record.id)
      assert.equal(hasEvent, hasRecord,
        'one landed without the other, which is the defect this signature exists to remove')
    })
  })

  it('a caller that passes nothing still works', async () => {
    await withStore(async (store) => {
      const event = await emit(store, 'report.created', { id: 'rep-1' })
      const data = await store.read()
      assert.ok(data.events_outbox.some((e) => e.id === event.id))
    })
  })
})
