#!/usr/bin/env node
/**
 * VUL-04: a documented role that the gate does not honour.
 *
 * `requireScope` compares the required scope to the token's scopes by string
 * equality, with `family:*` as the only widening. A `role:` scope is therefore
 * satisfiable only by naming it exactly, and no entry in either table names one
 * — so every route the documentation promises to `role:chw` or `role:operator`
 * answers 403 to a token holding exactly that role.
 *
 * The audit found the shape of it in one place: `handleParametricRoute` computes
 * `isAdmin` and `isOperator` and never reads either again, so the route reads as
 * though it gates on role while gating on `admin:parametric`. Four routes
 * across two files carry the same contradiction, which makes it a vocabulary
 * problem rather than a stray line: `hasRole` exists, is tested, and is called
 * by nothing in `src/`.
 *
 * Which side is wrong is a decision, not a bug to guess at. Two of the four
 * promises are in the codebase's own API document and the role vocabulary is
 * already implemented and tested in `auth.js`; the tables simply never used it.
 * So the roles are made real, and the tests below drive the routes — a unit test
 * of `hasRole` would have passed throughout the defect.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { READ_SCOPES, WRITE_SCOPES, requireScope, scopeForRoute } from '../src/auth.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const TOKENS = JSON.stringify([
  // Exactly what `docs/api.md` says a CHW token holds, and nothing more.
  { token: 'tok-chw', scopes: ['role:chw'] },
  // What `docs/api.md` says the simulate route takes.
  { token: 'tok-operator', scopes: ['role:operator'] },
  // The *other* audience the document names for the CHW surface: an operator
  // filing from the console, holding the data scope and not the role. This
  // token exists because the first canary of the fix — honouring only the first
  // alternative in a disjunction — passed every behavioural test without it.
  // The alternatives were written `role:chw|write:incidents`, so a test set that
  // only ever held the first proved nothing about the second.
  { token: 'tok-incidents', scopes: ['write:incidents'] },
  // The platform-wide token, which must keep working.
  { token: 'tok-star', scopes: ['*'] },
  // The second alternative on the simulate route. Every deployment that has an
  // operator today holds this, not the role.
  { token: 'tok-admin', scopes: ['admin:*'] },
  // A token with none of the above, so the widening is not a blanket allow.
  { token: 'tok-reader', scopes: ['read:hazards'] },
])

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-role-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const previous = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  try {
    return await fn(base, store)
  } finally {
    if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = previous
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const post = (base, pathname, token, body = {}) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('a documented role reaches the route it is documented for', () => {
  it('lets role:chw file a symptom report', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/v1/chw/report', 'tok-chw', { description: 'fever in three children', category: 'health' })
      assert.notEqual(res.status, 403, 'the role the API document names was refused by the gate')
      assert.ok(res.status < 400, `role:chw got ${res.status} filing a report`)
    })
  })

  it('lets role:chw reply to an alert', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/v1/chw/reply', 'tok-chw', { alert_event_id: 'ae_1', message: 'on our way' })
      assert.notEqual(res.status, 403, 'the role the API document names was refused by the gate')
    })
  })

  it('lets role:chw leave community feedback', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/v1/community-feedback', 'tok-chw', { alert_event_id: 'ae_1', source: 'chw', message: 'the road is cut' })
      assert.notEqual(res.status, 403, 'the role the API document names was refused by the gate')
    })
  })

  it('lets role:operator simulate a disbursement', async () => {
    await withServer(async (base, store) => {
      await store.merge({
        parametric_rules: [{
          id: 'pr_1',
          name: 'Dry spell payout',
          trigger: { type: 'rainfall', threshold_mm: 100 },
          payout: { amount: 1000, currency: 'KES' },
        }],
      })
      const res = await post(base, '/api/v1/parametric-rules/pr_1/simulate', 'tok-operator', { trigger_value: 40 })
      assert.notEqual(res.status, 403, 'the role the API document names was refused by the gate')
      assert.equal(res.status, 201, `role:operator got ${res.status} simulating a disbursement`)
    })
  })

  it('still refuses a token holding neither the role nor the scope', async () => {
    // The widening must be a widening. A gate that admitted every token because
    // it learned to read `role:` would be a worse defect than the one it fixed.
    await withServer(async (base) => {
      const res = await post(base, '/api/v1/chw/report', 'tok-reader', { description: 'x', category: 'health' })
      assert.equal(res.status, 403, 'a token with neither the role nor the scope reached a CHW route')
    })
  })

  it('still admits the platform token', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/v1/chw/report', 'tok-star', { description: 'x', category: 'health' })
      assert.ok(res.status < 400, `the * token got ${res.status}`)
    })
  })

  it('admits the second audience a disjunction names, not only the first', async () => {
    // `role:chw|write:incidents` has two ways in and the document names both.
    // Testing only the first is how a disjunction that silently honours one
    // alternative would ship: the CHW token passes, the operator is refused,
    // and every assertion is green.
    await withServer(async (base) => {
      for (const [pathname, body] of [
        ['/api/v1/chw/report', { description: 'flooded road', category: 'health' }],
        ['/api/v1/chw/reply', { alert_event_id: 'ae_1', message: 'on our way' }],
        ['/api/v1/community-feedback', { alert_event_id: 'ae_1', source: 'operator', message: 'road cut' }],
      ]) {
        const res = await post(base, pathname, 'tok-incidents', body)
        assert.notEqual(res.status, 403, `${pathname} refused the write:incidents audience the document names`)
      }
    })
  })

  it('admits an admin to the simulate action by the alternative it names', async () => {
    // `role:operator|admin:*` — the second alternative is the one an existing
    // deployment holds, and it is not the first. A disjunction read left-to-right
    // that stopped at the first miss would break every operator already in
    // production.
    await withServer(async (base, store) => {
      await store.merge({
        parametric_rules: [{
          id: 'pr_2',
          name: 'Dry spell payout',
          trigger: { type: 'rainfall', threshold_mm: 100 },
          payout: { amount: 1000, currency: 'KES' },
        }],
      })
      const res = await post(base, '/api/v1/parametric-rules/pr_2/simulate', 'tok-admin', { trigger_value: 40 })
      assert.equal(res.status, 201, `an admin token got ${res.status} on a route that names admin:*`)
    })
  })
})

describe('a role scope widens to its role, not to everything', () => {
  it('lets an admin scope satisfy a role requirement', () => {
    // An administrator is an operator. `hasRole` has always said so; the gate
    // did not, which is the same contradiction one layer down.
    requireScope({ scopes: ['admin:*'] }, 'role:operator')
  })

  it('lets * satisfy a role requirement', () => {
    requireScope({ scopes: ['*'] }, 'role:chw')
  })

  it('does not let one role satisfy another', () => {
    // The bug this guards is a widening implemented as `startsWith('role:')`,
    // which would hand every role every role's routes.
    assert.throws(() => requireScope({ scopes: ['role:chw'] }, 'role:operator'), (err) => err.statusCode === 403)
    assert.throws(() => requireScope({ scopes: ['role:operator'] }, 'role:chw'), (err) => err.statusCode === 403)
  })

  it('does not let a role satisfy a data scope', () => {
    // A CHW is not an administrator of the alerts table. `role:chw` must not
    // widen into `admin:alerts` or `write:reports`.
    assert.throws(() => requireScope({ scopes: ['role:chw'] }, 'admin:alerts'), (err) => err.statusCode === 403)
    assert.throws(() => requireScope({ scopes: ['role:chw'] }, 'write:reports'), (err) => err.statusCode === 403)
  })

  it('does not let a data scope satisfy a role', () => {
    // `write:incidents` is documented as an alternative to `role:chw` on one
    // route, and that route says so by naming both — not by the gate inferring
    // that any writer is a health worker.
    assert.throws(() => requireScope({ scopes: ['write:incidents'] }, 'role:chw'), (err) => err.statusCode === 403)
  })
})

describe('the table names the roles the documentation promises', () => {
  const alternatives = (scope) => scope.split('|')

  it('routes the CHW surface at role:chw', () => {
    for (const pathname of ['/api/v1/chw/report', '/api/v1/chw/reply']) {
      assert.ok(
        alternatives(scopeForRoute('POST', pathname)).includes('role:chw'),
        `${pathname} is not gated on the documented role: ${scopeForRoute('POST', pathname)}`,
      )
    }
  })

  it('routes the simulate action at role:operator', () => {
    assert.ok(alternatives(scopeForRoute('POST', '/api/v1/parametric-rules/pr_1/simulate')).includes('role:operator'))
  })

  it('leaves the rest of the parametric rules table alone', () => {
    // The simulate action is the one the document names a role for. Creating,
    // editing and deleting a rule moves money and stays `admin:parametric`;
    // widening the whole prefix would have been the easier edit and the wrong
    // one.
    assert.equal(scopeForRoute('POST', '/api/v1/parametric-rules'), 'admin:parametric')
    assert.equal(scopeForRoute('PATCH', '/api/v1/parametric-rules/pr_1'), 'admin:parametric')
    assert.equal(scopeForRoute('DELETE', '/api/v1/parametric-rules/pr_1'), 'admin:parametric')
    // And the more specific row does not leak upward: a read of the collection
    // is still the collection's read scope, not the simulate action's.
    assert.equal(scopeForRoute('GET', '/api/v1/parametric-rules/pr_1'), 'read:parametric')
  })

  it('keeps every documented scope reachable by an exact match', () => {
    // The invariant the whole fix rests on: a scope the table names must be
    // satisfiable by a token that holds exactly that scope — every alternative
    // in a disjunction, not just the first. `admin:*` was the only one that ever
    // was before this.
    for (const [, scope] of [...READ_SCOPES, ...WRITE_SCOPES]) {
      for (const alternative of alternatives(scope)) {
        requireScope({ scopes: [alternative] }, alternative)
        requireScope({ scopes: [alternative] }, scope)
      }
    }
  })
})
