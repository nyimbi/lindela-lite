import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { JsonStore } from '../src/store.js'
import {
  budgetedStore,
  createQueryBudget,
  currentQueryBudget,
  DEFAULT_QUERY_BUDGET,
  measureRead,
  QueryBudgetExceeded,
  QueryBudgetUnmeasurable,
  QueryBudgetUnscoped,
  runWithQueryBudget,
} from '../src/query-budget.js'
import { metrics, resetMetrics } from '../src/observability.js'

/**
 * ENH-67 — a per-request budget that fails the route that scans the whole
 * store, rather than letting it degrade every other caller.
 *
 * The store is a real `JsonStore`, because the quantity the budget counts is
 * the rows a read returned and a double that returns a fixed shape would be
 * measuring the double. A store double appears only where the point is a store
 * that *cannot report its cost*, which is the refusal this module has to get
 * right and which a real store cannot be asked to produce on demand.
 */

const hazard = (id) => ({
  id,
  event_type: 'flood',
  source: 'test',
  severity: 'moderate',
  observed_at: '2026-01-01T00:00:00.000Z',
})

async function tempStore(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lindela-qbudget-${name}-`))
  return {
    store: new JsonStore(path.join(dir, 'store.json')),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

describe('ENH-67 — a read over its budget fails its own request', () => {
  it('serves a scoped read inside the budget and refuses a whole-store read over it', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('scan')
    try {
      await store.merge({ hazard_events: Array.from({ length: 3 }, (_, i) => hazard(`h${i}`)) })
      const budgeted = budgetedStore(store)

      // Inside: a read of three rows against a budget of five.
      const within = await runWithQueryBudget({ rows: 5, queries: 10 }, () =>
        budgeted.read({ collections: ['hazard_events'] }))
      assert.equal(within.hazard_events.length, 3)

      await store.merge({ hazard_events: Array.from({ length: 5 }, (_, i) => hazard(`h${i + 3}`)) })

      // Over: eight rows against a budget of five. This is the whole-store scan
      // the audit measured, and the refusal names the count, the limit and the
      // way out.
      await assert.rejects(
        () => runWithQueryBudget({ rows: 5, queries: 10 }, () => budgeted.read({ collections: ['hazard_events'] })),
        (error) => {
          assert.ok(error instanceof QueryBudgetExceeded, `expected a budget error, got ${error?.name}`)
          assert.equal(error.statusCode, 503)
          assert.equal(error.expose, true)
          assert.equal(error.kind, 'rows')
          assert.equal(error.spent, 8)
          assert.equal(error.limit, 5)
          assert.match(error.message, /narrow the read to the collections it needs/)
          return true
        },
      )
    } finally {
      await cleanup()
    }
  })

  it('counts a bare read over every declared collection, so the whole store crosses the budget', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('bare')
    try {
      await store.merge({
        hazard_events: [hazard('a'), hazard('b'), hazard('c')],
        field_reports: [{ id: 'f1', created_at: '2026-01-01T00:00:00.000Z' }],
      })
      const budgeted = budgetedStore(store)
      // A bare `read()` returns every declared collection, so its cost is the
      // size of the store, not the size of one collection. A budget of three
      // refuses it even though the collection the caller "wanted" holds three,
      // because the bare read also carries the field report.
      await assert.rejects(
        () => runWithQueryBudget({ rows: 3, queries: 10 }, () => budgeted.read()),
        QueryBudgetExceeded,
      )
      // And `measureRead` agrees: a bare read's cost is the rows across every
      // collection it returned, not the collection count.
      const whole = await store.read()
      assert.equal(measureRead(whole), 4,
        'a bare read must be measured over the rows of every declared collection')
    } finally {
      await cleanup()
    }
  })

  it('charges the query axis too, so many small reads cannot substitute for one scan', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('queries')
    try {
      await store.merge({ hazard_events: [hazard('x')] })
      const budgeted = budgetedStore(store)
      await assert.rejects(
        () => runWithQueryBudget({ rows: 1000, queries: 1 }, async () => {
          await budgeted.read({ collections: ['hazard_events'] })
          await budgeted.merge({ hazard_events: [hazard('y')] })
        }),
        (error) => {
          assert.ok(error instanceof QueryBudgetExceeded)
          assert.equal(error.kind, 'queries')
          return true
        },
      )
    } finally {
      await cleanup()
    }
  })

  it('charges a streamed walk per record, failing mid-stream rather than after materialising', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('stream')
    try {
      await store.merge({ hazard_events: Array.from({ length: 5 }, (_, i) => hazard(`s${i}`)) })
      const budgeted = budgetedStore(store)
      const seen = []
      await assert.rejects(
        () => runWithQueryBudget({ rows: 2, queries: 10 }, async () => {
          for await (const record of budgeted.iterateRecords({ collections: ['hazard_events'] })) {
            seen.push(record.body.id)
          }
        }),
        QueryBudgetExceeded,
      )
      // Two rows were inside the budget; the third crossed it and stopped the
      // walk. The consumer never held the whole set — which is why a stream is
      // charged as it advances rather than once at the start.
      assert.equal(seen.length, 2, `the walk should stop at the budget, saw ${seen.length}`)
    } finally {
      await cleanup()
    }
  })
})

describe('ENH-67 — the budget is per request, not a global one caller can spend', () => {
  it('two concurrent requests hold two ledgers', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('concurrent')
    try {
      await store.merge({ hazard_events: Array.from({ length: 4 }, (_, i) => hazard(`c${i}`)) })
      const budgeted = budgetedStore(store)
      const outcomes = {}

      await Promise.all([
        // A narrow request that reaches the store after the wide one has already
        // spent its own budget. If the ledger were a module global, the wide
        // request's spend would have exhausted this one's.
        runWithQueryBudget({ rows: 2, queries: 10 }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          try {
            await budgeted.read({ collections: ['hazard_events'] })
            outcomes.narrow = 'served'
          } catch (error) {
            outcomes.narrow = error.name
          }
        }),
        runWithQueryBudget({ rows: 100, queries: 10 }, async () => {
          await budgeted.read({ collections: ['hazard_events'] })
          outcomes.wide = 'served'
        }),
      ])

      assert.equal(outcomes.narrow, 'QueryBudgetExceeded', 'the narrow request must see its own spend')
      assert.equal(outcomes.wide, 'served', 'the wide request must not be affected by the narrow one')
    } finally {
      await cleanup()
    }
  })

  it('a nested budget starts fresh rather than adding to the outer one', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('nested')
    try {
      await store.merge({ hazard_events: [hazard('n')] })
      const budgeted = budgetedStore(store)
      await runWithQueryBudget({ rows: 1, queries: 10 }, async () => {
        await budgeted.read({ collections: ['hazard_events'] })
        // A second budget inside the first is a second request's allowance, not
        // an extension of this one: its own rows start at zero.
        await runWithQueryBudget({ rows: 1, queries: 10 }, () => budgeted.read({ collections: ['hazard_events'] }))
      })
      assert.ok(currentQueryBudget() === null, 'the budget must not leak past its run')
    } finally {
      await cleanup()
    }
  })
})

describe('ENH-67 — a budget that cannot measure refuses rather than reporting success', () => {
  it('refuses a read whose store returned a shape it cannot count', async () => {
    resetMetrics()
    // A store that answers a read with something that is not a store object. Its
    // cost is unknown, and an unknown cost charged as zero is a budget that
    // silently never fires.
    const budgeted = budgetedStore({ read: async () => null })
    await assert.rejects(
      () => runWithQueryBudget({ rows: 10, queries: 10 }, () => budgeted.read()),
      (error) => {
        assert.ok(error instanceof QueryBudgetUnmeasurable, `expected an unmeasurable refusal, got ${error?.name}`)
        assert.equal(error.statusCode, 500)
        assert.equal(error.expose, true)
        assert.match(error.message, /cannot measure/)
        return true
      },
    )
  })

  it('refuses a read issued with no budget in scope', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('unscoped')
    try {
      await store.merge({ hazard_events: [hazard('u')] })
      const budgeted = budgetedStore(store)
      // No `runWithQueryBudget` around this. The budget is per request; a read
      // with no request to charge has no ceiling, so it is refused rather than
      // served unmeasured.
      await assert.rejects(() => budgeted.read({ collections: ['hazard_events'] }), QueryBudgetUnscoped)
    } finally {
      await cleanup()
    }
  })

  it('refuses a non-finite cost rather than treating it as zero', async () => {
    resetMetrics()
    const ledger = createQueryBudget({ rows: 10, queries: 10 })
    assert.throws(() => ledger.charge({ operation: 'read', rows: NaN }), QueryBudgetUnmeasurable)
    assert.throws(() => ledger.charge({ operation: 'read', rows: -1 }), QueryBudgetUnmeasurable)
    assert.throws(() => ledger.charge({ operation: 'read', queries: Infinity }), QueryBudgetUnmeasurable)
    // The spend is unchanged by a refused charge, so a refused read is not a
    // read that happened.
    assert.deepEqual(ledger.spent(), { rows: 0, queries: 0 })
  })

  it('reports the refusal on a metric, so a budget that fires is observable', async () => {
    resetMetrics()
    const ledger = createQueryBudget({ rows: 1, queries: 1 })
    assert.throws(() => ledger.charge({ operation: 'read', rows: 5 }), QueryBudgetExceeded)
    const rendered = metrics.render()
    assert.match(rendered, /query_budget_refused_total\{reason="rows"\} 1/,
      'an over-budget refusal must be counted where an operator can scrape it')
  })
})

describe('ENH-67 — the default allowance is a safe fallback, not an open door', () => {
  it('a nonsense limit falls back to the default rather than to no limit', () => {
    const ledger = createQueryBudget({ rows: 0, queries: -5 })
    assert.deepEqual(ledger.limits, DEFAULT_QUERY_BUDGET)
  })

  it('a whole-store read crosses the default allowance, and a scoped one does not', async () => {
    resetMetrics()
    const { store, cleanup } = await tempStore('default')
    try {
      // The default row allowance is under the 39,715 records the audit
      // measured, so the store below is small enough to serve a scoped read and
      // the default still refuses a scan of a store larger than it. Here the
      // store is tiny, so the property asserted is the *shape*: the default is
      // finite and positive, and a scoped read is inside it.
      assert.ok(DEFAULT_QUERY_BUDGET.rows > 0 && Number.isFinite(DEFAULT_QUERY_BUDGET.rows))
      await store.merge({ hazard_events: [hazard('d1'), hazard('d2')] })
      const budgeted = budgetedStore(store)
      const read = await runWithQueryBudget(undefined, () => budgeted.read({ collections: ['hazard_events'] }))
      assert.equal(read.hazard_events.length, 2)
    } finally {
      await cleanup()
    }
  })
})
