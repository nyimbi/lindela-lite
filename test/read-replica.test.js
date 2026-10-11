import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { JsonStore } from '../src/store.js'
import { readReplicaStore, replicaConfigured, READ_METHODS } from '../src/read-replica.js'
import { resetMetrics } from '../src/observability.js'

/**
 * ENH-67 — one object, reads on the replica and writes on the primary.
 *
 * The primary and the replica here are two real `JsonStore`s over two files,
 * seeded with *different* records on purpose: a test that seeded them the same
 * could not tell which one answered a read, and the routing is the only thing
 * this module does. A store double is used only where the point is a *failure*
 * — a replica that throws — which is a shape a real store cannot be asked to
 * produce on demand.
 */

const hazard = (id, extra = {}) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  observed_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})

async function tempStore(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-replica-${name}-`))
  return {
    store: new JsonStore(path.join(dir, 'store.json')),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

describe('ENH-67 — a read reaches the replica, a write reaches the primary', () => {
  it('routes read() to the replica and merge() to the primary', async () => {
    resetMetrics()
    const primary = await tempStore('primary')
    const replica = await tempStore('replica')
    try {
      // Two stores, two contents. The read below can only return the replica's
      // row if it truly reached the replica.
      await primary.store.merge({ hazard_events: [hazard('on-primary')] })
      await replica.store.merge({ hazard_events: [hazard('on-replica')] })

      const store = readReplicaStore(primary.store, { replica: replica.store })

      const read = await store.read({ collections: ['hazard_events'] })
      assert.deepEqual(read.hazard_events.map((r) => r.id), ['on-replica'],
        'the read did not reach the replica')

      // The write must land on the primary and leave the replica alone. If it
      // reached the replica the record would be on the wrong store with no
      // error, which is the silent divergence this wrapper exists to prevent.
      await store.merge({ hazard_events: [hazard('written')] })

      const onPrimary = await primary.store.read({ collections: ['hazard_events'] })
      const onReplica = await replica.store.read({ collections: ['hazard_events'] })
      assert.deepEqual(onPrimary.hazard_events.map((r) => r.id).sort(), ['on-primary', 'written'])
      assert.deepEqual(onReplica.hazard_events.map((r) => r.id), ['on-replica'],
        'the write reached the replica')
    } finally {
      await primary.cleanup()
      await replica.cleanup()
    }
  })

  it('routes iterateRecords() to the replica and every other method to the primary', async () => {
    resetMetrics()
    const primary = await tempStore('iter-primary')
    const replica = await tempStore('iter-replica')
    try {
      await primary.store.merge({ hazard_events: [hazard('p1')] })
      await replica.store.merge({ hazard_events: [hazard('r1'), hazard('r2')] })
      const store = readReplicaStore(primary.store, { replica: replica.store })

      const streamed = []
      for await (const record of store.iterateRecords({ collections: ['hazard_events'] })) {
        streamed.push(record.body.id)
      }
      assert.deepEqual(streamed.sort(), ['r1', 'r2'], 'the walk did not reach the replica')

      // The routing rule, read off the object rather than assumed: the two read
      // methods are the ones this module classifies, and `replaceAnalytics` — a
      // write — is on the primary. If `READ_METHODS` grew a write, this would
      // catch the read that started writing to the replica.
      assert.deepEqual([...READ_METHODS].sort(), ['iterateRecords', 'read'])
      assert.equal(typeof store.replaceAnalytics, 'function', 'a write method is missing from the wrapper')

      await store.replaceCollection('hazard_events', [hazard('replaced')])
      const onReplica = await replica.store.read({ collections: ['hazard_events'] })
      assert.deepEqual(onReplica.hazard_events.map((r) => r.id).sort(), ['r1', 'r2'],
        'replaceCollection reached the replica')
    } finally {
      await primary.cleanup()
      await replica.cleanup()
    }
  })

  it('with no replica configured, returns the primary itself with no behaviour change', async () => {
    resetMetrics()
    const primary = await tempStore('noreplica')
    try {
      await primary.store.merge({ hazard_events: [hazard('only')] })

      // Not a wrapper that happens to forward — the identical object, so a
      // deployment without a replica has no indirection in its path at all.
      assert.equal(readReplicaStore(primary.store), primary.store)
      assert.equal(readReplicaStore(primary.store, { replica: null }), primary.store)
      assert.equal(replicaConfigured(primary.store), false)

      const store = readReplicaStore(primary.store)
      const read = await store.read({ collections: ['hazard_events'] })
      assert.deepEqual(read.hazard_events.map((r) => r.id), ['only'])
      await store.merge({ hazard_events: [hazard('second')] })
      const after = await primary.store.read({ collections: ['hazard_events'] })
      assert.deepEqual(after.hazard_events.map((r) => r.id).sort(), ['only', 'second'])
    } finally {
      await primary.cleanup()
    }
  })

  it('reports which mode it is in rather than leaving a caller to infer it', async () => {
    resetMetrics()
    const primary = await tempStore('mode-primary')
    const replica = await tempStore('mode-replica')
    try {
      const store = readReplicaStore(primary.store, { replica: replica.store })
      assert.equal(replicaConfigured(store), true)
      assert.equal(store.replicaState().configured, true)
      assert.equal(store.replicaState().on_failure, 'fallback')
      assert.equal(store.replica, replica.store)
    } finally {
      await primary.cleanup()
      await replica.cleanup()
    }
  })
})

describe('ENH-67 — a replica that cannot answer is absorbed, or refused, by explicit choice', () => {
  it('falls back to the primary by default, counts the fallback, and serves the read', async () => {
    resetMetrics()
    const primary = await tempStore('fallback')
    try {
      await primary.store.merge({ hazard_events: [hazard('from-primary')] })
      const replica = { read: async () => { throw new Error('replica is down') } }
      const store = readReplicaStore(primary.store, { replica })

      const read = await store.read({ collections: ['hazard_events'] })
      assert.deepEqual(read.hazard_events.map((r) => r.id), ['from-primary'],
        'a replica failure must not fail a read that the primary can answer')
      assert.equal(store.replicaState().fallbacks, 1)
      assert.equal(store.replicaState().last_fallback.method, 'read')
    } finally {
      await primary.cleanup()
    }
  })

  it("with onReplicaFailure: 'fail', refuses the read and never touches the primary", async () => {
    resetMetrics()
    const primary = await tempStore('fail')
    try {
      await primary.store.merge({ hazard_events: [hazard('from-primary')] })
      let primaryReads = 0
      const countingPrimary = {
        read: async (...args) => { primaryReads += 1; return primary.store.read(...args) },
      }
      const replica = { read: async () => { throw new Error('replica is down') } }
      const store = readReplicaStore(countingPrimary, { replica, onReplicaFailure: 'fail' })

      await assert.rejects(
        () => store.read({ collections: ['hazard_events'] }),
        (error) => {
          assert.equal(error.name, 'ReadReplicaUnavailable')
          assert.equal(error.statusCode, 503)
          assert.equal(error.expose, true)
          assert.match(error.message, /refuses rather than falling back/)
          return true
        },
      )
      assert.equal(primaryReads, 0, 'the refusal must protect the primary, not silently read from it')
    } finally {
      await primary.cleanup()
    }
  })

  it('rejects an unknown onReplicaFailure rather than defaulting it', async () => {
    const primary = await tempStore('bad-option')
    try {
      assert.throws(
        () => readReplicaStore(primary.store, { replica: {}, onReplicaFailure: 'fallbackk' }),
        /onReplicaFailure must be 'fallback' or 'fail'/,
      )
    } finally {
      await primary.cleanup()
    }
  })

  it('a replica with no read() falls back to the primary for that method', async () => {
    resetMetrics()
    const primary = await tempStore('partial')
    try {
      await primary.store.merge({ hazard_events: [hazard('p')] })
      // A replica driver that has not implemented reads. Serving from the
      // primary is the safe direction; the alternative is a read that fails
      // because the *replica* is incomplete.
      const store = readReplicaStore(primary.store, { replica: {} })
      const read = await store.read({ collections: ['hazard_events'] })
      assert.deepEqual(read.hazard_events.map((r) => r.id), ['p'])
    } finally {
      await primary.cleanup()
    }
  })
})
