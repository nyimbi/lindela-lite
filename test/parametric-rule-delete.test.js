import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * `DELETE /api/v1/parametric-rules/:id` had no test at all.
 *
 * It is the only route in the product that hard-deletes a record, and the thing
 * it deletes defines what gets paid, to whom, and on what condition. The route
 * was verified by hand — three rules removed from a demo store — and a hand
 * check does not run again.
 *
 * Two properties are load-bearing and neither is "the route works":
 *
 *   - **The removed rule survives in the action log.** A hard delete leaves no
 *     row behind, so the log entry *is* the archive. An audit chain that
 *     recorded only "a rule was deleted" would be unable to answer what had
 *     been in force, which is the only question anyone reads it for.
 *   - **One collection changes.** R-25 fixed four routes that called
 *     `store.write()` to edit a single record — a full-table DELETE and
 *     reinsert on PostgreSQL. `test/parametric-edit-scope.test.js` guards the
 *     four *edit* routes; this one was not in that list because it landed after.
 */

/** A rule complete enough to be real, with the fields the simulator reads. */
const rule = (over = {}) => ({
  id: 'pr-test',
  name: 'Turkana Flood Pre-financing',
  trigger_metric: 'flood_risk',
  trigger_operator: '>=',
  trigger_threshold: 70,
  disbursement_amount_local_currency: 500000,
  chain: 'testnet',
  contract_address: '0xtest',
  ...over,
})

async function withServer(fn, { rules = [rule()] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-param-delete-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({ parametric_rules: rules })
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  try {
    return await fn({ base, store, call })
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('a parametric rule can be deleted, and the deletion is on the record', () => {
  it('removes the rule from the collection', async () => {
    await withServer(async ({ call, store }) => {
      const { status, body } = await call('DELETE', '/api/v1/parametric-rules/pr-test')
      assert.equal(status, 200)
      assert.equal(body.success, true)
      assert.equal(body.data.id, 'pr-test')
      assert.equal(body.data.deleted, true)

      const after = await store.read()
      assert.deepEqual(after.parametric_rules, [])
    })
  })

  it('archives the whole removed rule, not a summary of it', async () => {
    // The point of a hard delete is that nothing survives in the collection, so
    // the log entry is the only record of what the rule said. Every field that
    // decided a payment has to be in it.
    await withServer(async ({ call, store }) => {
      const original = rule()
      await call('DELETE', '/api/v1/parametric-rules/pr-test')

      const { action_logs: logs = [] } = await store.read()
      const entry = logs.find((l) => l.collection === 'parametric_rules' && l.action === 'deleted')
      assert.ok(entry, 'the deletion was not written to the action log')
      assert.equal(entry.record_id, 'pr-test')

      const archived = entry.metadata?.removed_rule
      assert.ok(archived, 'the log entry records that a rule went, but not what it was')
      for (const field of ['name', 'trigger_metric', 'trigger_threshold', 'disbursement_amount_local_currency', 'contract_address']) {
        assert.deepEqual(archived[field], original[field], `${field} is missing from the archived rule`)
      }
    })
  })

  it('names the token that did it', async () => {
    await withServer(async ({ call, store }) => {
      const before = (await store.read()).action_logs?.length ?? 0
      await call('DELETE', '/api/v1/parametric-rules/pr-test')
      const { action_logs: logs = [] } = await store.read()
      assert.equal(logs.length, before + 1, 'exactly one log entry, not zero and not two')
    })
  })

  it('leaves the other rules alone', async () => {
    await withServer(async ({ call, store }) => {
      await store.merge({ parametric_rules: [rule({ id: 'pr-keep', name: 'Mandera Conflict Displacement Support' })] })
      await call('DELETE', '/api/v1/parametric-rules/pr-test')
      const after = await store.read()
      assert.deepEqual(after.parametric_rules.map((r) => r.id), ['pr-keep'])
    })
  })

  it('a deleted rule is no longer offered to the simulator', async () => {
    // The route's own comment gives the reason it deletes rather than archives:
    // an archived rule would stay in the picker as something still selectable.
    await withServer(async ({ call, store }) => {
      await store.merge({ parametric_rules: [rule({ id: 'pr-keep' })] })
      await call('DELETE', '/api/v1/parametric-rules/pr-test')
      const listed = (await store.read()).parametric_rules
      assert.ok(!listed.some((r) => r.id === 'pr-test'), 'the deleted rule is still selectable')
    })
  })

  it('deleting a rule that is not there is a 404, not a silent success', async () => {
    // A DELETE that answers 200 for an id it did not find would tell an operator
    // a rule is gone when nothing was changed.
    await withServer(async ({ call }) => {
      const { status, body } = await call('DELETE', '/api/v1/parametric-rules/pr-does-not-exist')
      assert.equal(status, 404)
      assert.equal(body.success, false)
    })
  })

  it('a second delete of the same id is also a 404', async () => {
    await withServer(async ({ call }) => {
      assert.equal((await call('DELETE', '/api/v1/parametric-rules/pr-test')).status, 200)
      const second = await call('DELETE', '/api/v1/parametric-rules/pr-test')
      assert.equal(second.status, 404)
      assert.equal(second.body.success, false)
    })
  })

  it('the log entry survives the delete being the last thing that happened', async () => {
    // The route does two writes — replaceCollection, then merge the log. If the
    // order were reversed the log would be wiped by the replace, and the archive
    // would vanish with the rule it exists to preserve.
    await withServer(async ({ call, store }) => {
      await call('DELETE', '/api/v1/parametric-rules/pr-test')
      const after = await store.read()
      assert.deepEqual(after.parametric_rules, [], 'the rule should be gone')
      const logs = (after.action_logs || []).filter((l) => l.action === 'deleted')
      assert.equal(logs.length, 1, 'the archive did not survive the write that removed the rule')
      assert.equal(logs[0].metadata?.removed_rule?.name, 'Turkana Flood Pre-financing')
    })
  })
})
