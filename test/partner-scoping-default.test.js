import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { currentRequestAuth, filterRecords, runWithRequestContext } from '../src/utils.js'

/**
 * Partner scoping must be the default, not an argument somebody remembers.
 *
 * `docs/improvements/defects.md` recorded SEC-06 as **fixed** on the strength
 * of `filterRecords` scoping by `context.auth?.partner_org`. The filter existed;
 * the scoping was an *opt-in third argument*, and three route handlers did not
 * pass one:
 *
 *   - `handleOperationalRoute` — every operational collection, list form
 *   - `handleAlertRoute` — alert_events, alert_rules
 *   - `GET /api/v1/export.geojson` — no context argument at all
 *
 * and the by-id branch returned `data[route.collection].find(...)` with no
 * scoping expression of any kind, so there was nothing there to bypass. With
 * `partnerOrg` null the filter at `utils.js` returned the collection whole.
 *
 * So a token carrying only `read:incidents` read every organisation's field
 * reports — including the CHW's own free text, which in this product is where
 * names and affected households are written. `docs/improvements/system-audit/01-remediation.md`
 * R-06 verified this by hand.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

/**
 * Source with comments stripped.
 *
 * The comment explaining this fix quotes the line it removed —
 * `// This was \`data[route.collection].find(...)\`` — so a substring assertion
 * over raw source matches the explanation, and a test for "this no longer
 * happens" passes forever on the comment.
 */
const code = (p = 'src/server.js') => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const query = new URLSearchParams('')
const records = [
  { id: 'fr-a', partner_org: 'orgA', summary: 'org A outbreak' },
  { id: 'fr-b', partner_org: 'orgB', summary: 'org B outbreak' },
  { id: 'fr-c', summary: 'untagged' },
]

describe('partner scoping applies by default', () => {
  it('scopes from the request when no context is passed', () => {
    const auth = { partner_org: 'orgA', subject: 'token_aaa' }
    const inside = runWithRequestContext(auth, () =>
      filterRecords(records, query, {}).map((r) => r.id))
    assert.deepEqual(inside, ['fr-a'],
      'a partner-scoped request must not be able to read another organisation')
  })

  it('scopes from the request inside a read-modify filter chain', () => {
    const auth = { partner_org: 'orgB', subject: 'token_bbb' }
    const inside = runWithRequestContext(auth, () =>
      filterRecords(records, query, {}, { unlimited: true }).map((r) => r.id))
    assert.deepEqual(inside, ['fr-b'])
  })

  it('an explicit context still wins', () => {
    // A caller that knows better may override; the change is the default, not
    // the removal of the override.
    const inside = runWithRequestContext({ partner_org: 'orgA' }, () =>
      filterRecords(records, query, { auth: { partner_org: 'orgB' } }).map((r) => r.id))
    assert.deepEqual(inside, ['fr-b'])
  })

  it('an unconfigured deployment still sees everything', () => {
    const inside = runWithRequestContext(null, () =>
      filterRecords(records, query, {}).map((r) => r.id))
    assert.deepEqual(inside, ['fr-a', 'fr-b', 'fr-c'],
      'no partners configured means no partner predicate — not an empty result')
  })

  it('outside a request there is no identity', () => {
    assert.equal(currentRequestAuth(), null)
  })

  it('is not scoped on the identity of a caller that leaked between requests', () => {
    // The context is per-async-chain. A value left in the first caller's chain
    // must not scope an unrelated one.
    const first = runWithRequestContext({ partner_org: 'orgA' }, () =>
      filterRecords(records, query, {}).map((r) => r.id))
    const second = runWithRequestContext({ partner_org: 'orgB' }, () =>
      filterRecords(records, query, {}).map((r) => r.id))
    assert.deepEqual(first, ['fr-a'])
    assert.deepEqual(second, ['fr-b'])
  })
})

describe('the scoping is wired to the request, not to the call site', () => {

  it('enters the caller identity before dispatch, not per handler', () => {
    assert.match(code(), /runWithRequestContext\(\s*auth,\s*\(\)\s*=>\s*handleApiRequestInContext/,
      'the identity must be published for the whole dispatch, or a new handler '
      + 'can again reach filterRecords with no context and get the whole store')
  })

  it('the by-id branch goes through the same predicate as the list form', () => {
    const source = code()
    // It was the worst of the three: `.find()` over the raw collection with no
    // scoping expression, so a leaked id from any listing read one record
    // directly. There was nothing to bypass because nothing was there.
    // Anchored inside `handleOperationalRoute`: the file has several by-id
    // branches and the first one globally belongs to report_templates, which is
    // platform configuration rather than one partner's data.
    const fnStart = source.indexOf('async function handleOperationalRoute')
    assert.ok(fnStart > 0, 'handleOperationalRoute must exist')
    // The GET branch only. A write path legitimately looks the record up raw
    // to mutate it — whether a caller may mutate a given record is a separate
    // question from whether it may read one.
    const getStart = source.indexOf("if (req.method === 'GET' && route.id)", fnStart)
    const postStart = source.indexOf("if (req.method === 'POST' && !route.id)", fnStart)
    assert.ok(getStart > fnStart && postStart > getStart, 'both branches must exist')
    const branch = source.slice(getStart, postStart)
    assert.match(branch, /filterRecords\(/,
      'a by-id read must carry the same partner predicate as the list form')
    assert.ok(
      !/data\[route\.collection\]\.find\(/.test(branch),
      'a raw `.find()` over the collection bypasses every predicate by construction',
    )
  })

  it('no call site is required to pass a context for scoping to apply', () => {
    const source = code()
    // The two handlers the audit named still pass none, and that is now correct
    // rather than a bug: `filterRecords` reads the request's identity by
    // default. Asserting they pass one would re-implement the opt-in design
    // this change exists to remove, and would fail the moment a legitimate
    // uncontexted caller appeared.
    const uncontexted = source.match(
      /collectionPage\([^)]*url\.searchParams, \{ data, collection: route\.collection \}\)/g,
    ) || []
    assert.ok(uncontexted.length > 0,
      'if this ever returns to zero, the assertion below is no longer measuring '
      + 'anything and the default may have been removed')
    assert.match(
      code('src/utils.js'),
      /const auth = context\.auth \?\? currentRequestAuth\(\)/,
      'the default must resolve the caller, not fall back to no scoping',
    )
  })
})