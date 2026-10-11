import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findVisible } from '../src/visibility.js'
import { runWithRequestContext } from '../src/utils.js'

/**
 * VUL-03 — the one way a by-id route resolves a record.
 *
 * Thirty-one by-id branches across nine handlers used a bare
 * `records.find((item) => item.id === id)`, so the listing was scoped to the
 * caller's partner organisation and the by-id form was not. `GET /api/v1/reports`
 * returned one organisation's reports; `GET /api/v1/reports/<another
 * organisation's id>` returned theirs.
 *
 * The predicate is one function so it cannot be forgotten at a call site, which
 * means this file is the only place it is asserted on its own terms. Two
 * properties, and the second is the one a "fix" gets wrong:
 *
 *   - the predicate applies to a by-id read exactly as it applies to the
 *     listing — same function, same answer;
 *   - "not there" and "not yours" are the *same* answer. A 403 on another
 *     organisation's id confirms the id exists, which turns a scoped listing
 *     into an id oracle: a caller can enumerate ids and learn which ones are
 *     real by the status code alone.
 */

const as = (auth, fn) => runWithRequestContext(auth, fn)

const mine = { id: 'r1', partner_org: 'org-a', title: 'Mine' }
const theirs = { id: 'r2', partner_org: 'org-b', title: 'Theirs' }
const unscoped = { id: 'r3', title: 'No organisation' }
const records = [mine, theirs, unscoped]

describe('VUL-03 — findVisible carries the partner predicate', () => {
  it('returns the caller organisation’s record', async () => {
    const found = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible(records, 'r1'))
    assert.equal(found, mine)
  })

  it('answers null — not a distinguishable refusal — for another organisation’s record', async () => {
    // The id-oracle property. An error here, or a different shape, would let a
    // caller walk the id space and read the status code as an existence check.
    const found = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible(records, 'r2'))
    assert.equal(found, null, 'another organisation’s record was visible to a scoped caller')
  })

  it('does not scope a caller that is not scoped', async () => {
    // An unscoped token sees the whole store, which is the deployment with no
    // partners configured. Scoping it would break the operator console.
    const found = await as({ subject: 'op', partner_org: null }, () => findVisible(records, 'r2'))
    assert.equal(found, theirs)
  })

  it('reads the organisation from the request context, not from a parameter', async () => {
    // There is no parameter to pass and therefore none to forget or to get
    // wrong. The same call under two contexts gives two answers, which is the
    // proof that the context is what decides.
    const underA = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible(records, 'r2'))
    const underB = await as({ subject: 'b', partner_org: 'org-b' }, () => findVisible(records, 'r2'))
    assert.equal(underA, null)
    assert.equal(underB, theirs)
  })
})

describe('VUL-03 — findVisible honours include_deleted only when asked', () => {
  const gone = { id: 'r4', partner_org: 'org-a', deleted_at: '2026-01-01T00:00:00.000Z' }
  const withDeleted = [...records, gone]

  it('hides a soft-deleted record by default', async () => {
    const found = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible(withDeleted, 'r4'))
    assert.equal(found, null, 'a soft-deleted record was served to a caller that did not ask for it')
  })

  it('returns it when the caller asks', async () => {
    // The write branches ask. A PATCH has to see the deleted row to answer 409
    // rather than 404 — "it exists and you may not change it" is a different
    // answer from "it is not there".
    const found = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible(withDeleted, 'r4', { includeDeleted: true }))
    assert.equal(found, gone)
  })

  it('still applies the partner predicate to a deleted record', async () => {
    // `includeDeleted` relaxes one condition, not both. A deleted row belonging
    // to another organisation stays invisible — otherwise the flag is a way to
    // read across the organisation boundary by asking nicely.
    const foreignGone = { id: 'r5', partner_org: 'org-b', deleted_at: '2026-01-01T00:00:00.000Z' }
    const found = await as({ subject: 'a', partner_org: 'org-a' }, () => findVisible([...withDeleted, foreignGone], 'r5', { includeDeleted: true }))
    assert.equal(found, null)
  })
})

describe('VUL-03 — findVisible declines the inputs that are not a lookup', () => {
  it('returns null for a falsy id rather than the first record', async () => {
    // `records.find((item) => item.id === undefined)` is null, but a future
    // rewrite to `filter(...)` plus `[0]` on an unfiltered list would hand back
    // the first row. The guard is stated rather than left to the predicate.
    for (const id of [null, undefined, '']) {
      const found = await as({ subject: 'a', partner_org: null }, () => findVisible(records, id))
      assert.equal(found, null, `id ${JSON.stringify(id)} resolved to a record`)
    }
  })

  it('returns null for an absent collection instead of throwing', async () => {
    for (const collection of [undefined, null, []]) {
      const found = await as({ subject: 'a', partner_org: null }, () => findVisible(collection, 'r1'))
      assert.equal(found, null)
    }
  })

  it('returns null for an id no record carries', async () => {
    const found = await as({ subject: 'a', partner_org: null }, () => findVisible(records, 'nope'))
    assert.equal(found, null)
  })
})
