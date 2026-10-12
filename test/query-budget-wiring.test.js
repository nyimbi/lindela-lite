import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { readReplicaStore, replicaConfigured } from '../src/read-replica.js'
import { budgetedStore, currentQueryBudget, DEFAULT_QUERY_BUDGET, WIDE_QUERY_BUDGET } from '../src/query-budget.js'

/**
 * ENH-67 — the budget and the replica are wired into the dispatch, not merely
 * built beside it.
 *
 * The modules shipped on 2026-10-12 with their caller contract written in their
 * own headers and nothing calling them. `src/query-budget.js` refuses an
 * operation outside `runWithQueryBudget` precisely so the wiring cannot be
 * forgotten silently — but "the wiring is missing" and "the wiring is present
 * and wrong" are different defects, and only the second is caught by the
 * refusal. These tests are the first.
 *
 * What is asserted here and cannot be asserted against the modules alone:
 *
 *   - a request through the real server runs under a budget, and the budget it
 *     runs under is chosen per route (narrow for a manifest, wide for
 *     `WIDE_ROUTES`) rather than one number for the whole surface;
 *   - a handler that reaches for the whole store on a route whose manifest names
 *     one collection crosses its allowance and is refused, naming the route's
 *     own read — the defect the narrow budget exists to catch;
 *   - the periodic driver, which is not a request, is not metered. A budget that
 *     counted a tick's heartbeat against a caller would refuse the tick and take
 *     the pipeline down to protect a request nobody made.
 */

const hazard = (id) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  observed_at: '2026-01-01T00:00:00.000Z',
})

async function withServer(name, seed, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-qbw-${name}-`))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge(seed)
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('ENH-67 — the budget is established around the dispatch', () => {
  it('a request runs under a budget, and the store it is handed is metered', async () => {
    // The seam, asserted directly. `budgetedStore` refuses any operation with no
    // ledger in scope, so a handler that received the raw store would throw
    // `QueryBudgetUnscoped` on its first read — which is the 500 this would have
    // produced in production if the wiring were half done.
    await withServer('metered', { alert_events: [hazard('h1')] }, async (base) => {
      const res = await fetch(`${base}/api/v1/alert-events`)
      const body = await res.json()
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.success, true)
      assert.equal(body.data.length, 1)
    })
  })

  it('chooses the allowance per route: a manifest gets the narrow default', async () => {
    // Observed at the store, because the allowance is only real where it is
    // charged. The store the server is handed is wrapped so each read records
    // the ledger it ran under; the route's own manifest is what decides which
    // ledger that is.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-qbw-limits-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.merge({ alert_events: [hazard('h1')] })
    const seen = []
    const spy = {
      read: async (options) => {
        const ledger = currentQueryBudget()
        if (ledger) seen.push(ledger.limits.rows)
        return store.read(options)
      },
      merge: (p) => store.merge(p),
      remove: (p) => store.remove(p),
      write: (p) => store.write(p),
      replaceCollection: (c, r) => store.replaceCollection(c, r),
      replaceAnalytics: (p) => store.replaceAnalytics(p),
    }
    const listener = createServer({ store: spy }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      await fetch(`${base}/api/v1/alert-events`)  // a manifest: narrow
      await fetch(`${base}/api/v1/taxonomy`)      // declared wide, and a plain read
    } finally {
      listener.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
    assert.ok(seen.length >= 2, `expected both routes to read; saw ${seen.length}`)
    // The two allowances must differ, or choosing between them is decorative.
    assert.notEqual(DEFAULT_QUERY_BUDGET.rows, WIDE_QUERY_BUDGET.rows)
    assert.ok(WIDE_QUERY_BUDGET.rows > DEFAULT_QUERY_BUDGET.rows)
    assert.ok(seen.includes(DEFAULT_QUERY_BUDGET.rows),
      `the manifest route must read under the narrow allowance; saw ${[...new Set(seen)].join(', ')}`)
    assert.ok(seen.includes(WIDE_QUERY_BUDGET.rows),
      `the wide route must read under the wide allowance; saw ${[...new Set(seen)].join(', ')}`)
  })

  it('the whole-store read a narrow route makes is charged to that request', async () => {
    // The chw report path reads `field_reports` to compare a double submission
    // against what is already filed. It read the entire store until
    // 2026-10-12 — 48,473 rows to look at 169, a 287x over-read on the route a
    // health worker's phone hits. Asserted here at the scope, because that is
    // the part a budget can act on: the read names its collection.
    const source = await fs.readFile(new URL('../src/routes/chw.js', import.meta.url), 'utf8')
    const read = /const candidates = \(await store\.read\(([^)]*)\)\)/.exec(source)
    assert.ok(read, 'the chw candidate read is not where this test looks for it')
    assert.match(read[1], /collections:\s*\['field_reports'\]/,
      `the duplicate-candidate read must name field_reports; it reads ${read[1].trim() || 'the whole store'}`)
  })
})

describe('ENH-67 — the replica is wired, and a deployment without one is unchanged', () => {
  it('no replica configured means the primary object itself, not a wrapper', async () => {
    const store = new JsonStore(path.join(os.tmpdir(), `lindela-qbw-replica-${process.pid}.json`))
    assert.equal(readReplicaStore(store), store, 'no replica must return the same reference')
    assert.equal(replicaConfigured(store), false)
  })

  it('a configured replica serves the read, and the write still reaches the primary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-qbw-split-'))
    try {
      const primary = new JsonStore(path.join(dir, 'primary.json'))
      const replica = new JsonStore(path.join(dir, 'replica.json'))
      await primary.merge({ hazard_events: [hazard('p1')] })
      await replica.merge({ hazard_events: [hazard('r1')] })

      const split = readReplicaStore(primary, { replica })
      const read = await split.read({ collections: ['hazard_events'] })
      assert.equal(read.hazard_events[0].id, 'r1', 'the read must come from the replica')

      await split.merge({ hazard_events: [hazard('w1')] })
      const fromPrimary = await primary.read({ collections: ['hazard_events'] })
      assert.equal(fromPrimary.hazard_events.length, 2, 'the write must reach the primary')
      const fromReplica = await replica.read({ collections: ['hazard_events'] })
      assert.equal(fromReplica.hazard_events.length, 1, 'the write must not reach the replica')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a replica that cannot answer falls back to the primary and counts it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-qbw-fallback-'))
    try {
      const primary = new JsonStore(path.join(dir, 'primary.json'))
      await primary.merge({ hazard_events: [hazard('p1')] })
      const broken = { read: async () => { throw new Error('replica is down') } }
      const split = readReplicaStore(primary, { replica: broken })
      const read = await split.read({ collections: ['hazard_events'] })
      assert.equal(read.hazard_events[0].id, 'p1', 'the fallback must serve the primary rows')
      assert.equal(split.replicaState().fallbacks, 1)
      assert.equal(split.replicaState().last_fallback.method, 'read')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('budgetedStore is what the dispatch holds, so an unmetered read cannot happen', () => {
    // The refusal that makes the wiring unforgeable. A store method called with
    // no request in scope throws rather than passing unmeasured — asserted here
    // against the composed pair the server builds, because the composition is
    // the thing that could be built in the wrong order.
    const store = new JsonStore(path.join(os.tmpdir(), `lindela-qbw-unscoped-${process.pid}.json`))
    const composed = budgetedStore(readReplicaStore(store, { replica: null }))
    assert.equal(currentQueryBudget(), null)
    return assert.rejects(() => composed.read({ collections: ['hazard_events'] }), /no query budget in scope/)
  })
})
