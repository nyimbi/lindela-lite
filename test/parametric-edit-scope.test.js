import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * R-25 — `store.write()` is a whole-store replacement, and four routes used it
 * to change one record.
 *
 * On PostgreSQL that is `DELETE FROM lite_records` followed by a reinsert of
 * everything, for a one-rule edit: `O(N + B)` where the work is `O(1)`. It is
 * also the wrong contract — "this is the whole new world" applied to "this one
 * collection changed" is a claim that stops being true the moment a
 * concurrent write lands.
 *
 * The store already had `replaceCollection`, which says what happened. The four
 * call sites now use it, and the assertion below is deliberately *not* "the
 * route still works" — those routes have their own tests, and a test that
 * passes both before and after the change guards nothing. This one fails if the
 * call comes back.
 */

/**
 * The route surface, read from every file that can hold a route body.
 *
 * This was `src/server.js` alone until ARC-01/ENH-60 extracted the route
 * families into `src/routes/*.js`. The assertion did not change — the code it
 * is about moved, and a guard that keeps reading the old file checks nothing
 * while still passing its sibling test, which is the exact failure mode this
 * describe block was written to prevent. Read the directory, not a path.
 */
const ROUTE_SOURCES = [
  'src/server.js',
  ...readdirSync(new URL('../src/routes/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/routes/${f}`),
].map((rel) => ({
  rel,
  text: readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'),
}))

const SERVER = ROUTE_SOURCES.map((s) => s.text).join('\n')

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r25-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('R-25 — a one-record edit does not rewrite the store', () => {
  it('no route replaces the whole store to change a collection', () => {
    // Reported per file, because the surface is several files now and a bare
    // line number would name a line in whichever file happened to be joined.
    // Comment lines are skipped: a call site is the claim, and the modules that
    // explain this fix in prose would otherwise fail the guard that made them
    // explainable.
    const isComment = (text) => /^(\/\/|\/\*|\*)/.test(text)
    const offenders = ROUTE_SOURCES.flatMap(({ rel, text }) =>
      text.split('\n')
        .map((line, i) => ({ where: `${rel}:${i + 1}`, text: line.trim() }))
        .filter((entry) => !isComment(entry.text) && /store\.write\(/.test(entry.text)))
    assert.deepEqual(offenders, [],
      'store.write() is a full-table DELETE plus reinsert on PostgreSQL. These lines ' +
      'use it for a single-collection change: ' +
      offenders.map((o) => `${o.where}: ${o.text}`).join(' | '))
  })

  it('the four parametric routes use the collection-scoped call', () => {
    for (const collection of ['parametric_rules', 'parametric_disbursements']) {
      assert.ok(SERVER.includes(`store.replaceCollection('${collection}'`),
        `the ${collection} routes should replace that collection and nothing else`)
    }
  })

  it('the edit still works, and the action log still lands', async () => {
    // The failure mode of fixing this wrongly is dropping the audit trail: the
    // money path writes an action log on every rule change, and a merge that
    // only replaced the collection would lose it.
    await withServer(async (base, store) => {
      const created = await fetch(`${base}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Flood payout',
          chain: 'polygon-mumbai',
          trigger_metric: 'precip_mm',
          trigger_threshold: 50,
        }),
      })
      const createdBody = await created.text()
      assert.equal(created.status, 201, createdBody)
      const rule = JSON.parse(createdBody).data

      const patched = await fetch(`${base}/api/v1/parametric-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger_threshold: 80 }),
      })
      const patchedBody = await patched.text()
      assert.equal(patched.status, 200, patchedBody)

      const data = await store.read()
      const updated = data.parametric_rules.find((r) => r.id === rule.id)
      assert.equal(updated.trigger_threshold, 80, 'the edit did not land')
      assert.ok(data.action_logs.some((l) => l.collection === 'parametric_rules' && l.record_id === rule.id),
        'the action log is missing: the collection replace swallowed the audit trail')
    })
  })

  it('a concurrent write to another collection is not clobbered', async () => {
    // The semantics half. `write({...data, parametric_rules: rules})` sends the
    // whole snapshot, so a record written to another collection between the read
    // and the write is silently reverted — and the caller cannot tell, because
    // the response is a success.
    await withServer(async (base, store) => {
      await store.merge({
        incidents: [{ id: 'keep-me', type: 'incident', title: 'A concurrent incident', severity: 'low', status: 'open' }],
      })

      const created = await fetch(`${base}/api/v1/parametric-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Drought payout',
          chain: 'celo-alfajores',
          trigger_metric: 'precip_mm',
          trigger_threshold: 30,
        }),
      })
      assert.equal(created.status, 201)
      const rule = (await created.json()).data

      const data = await store.read()
      await store.replaceCollection('parametric_rules', [...(data.parametric_rules || []), rule])
      await store.merge({ action_logs: [] })

      const after = await store.read()
      assert.ok(after.incidents.some((i) => i.id === 'keep-me'),
        'a collection-scoped replace deleted a record from another collection')
    })
  })
})
