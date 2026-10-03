import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseTokens, scopeToPartnerOrg } from '../src/auth.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * Multi-tenancy was a no-op that displayed itself as working.
 *
 * `scopeToPartnerOrg` keyed on `auth.partner_org`, a field `authenticate()`
 * never set — so it always returned every record. It had no call sites in
 * `src/` at all. Meanwhile the partner portal sent `?partner_org=<org>` on
 * every request, the server read nothing, and the header rendered the
 * organisation from localStorage. A partner could have believed they were
 * looking at their own data while receiving the whole store.
 *
 * Three separate layers were missing: the claim could not be expressed, the
 * claim could not be enforced, and the claim could not be checked.
 */

const TOKENS = JSON.stringify([
  { token: 'tok-a', scopes: ['read:*'], partner_org: 'orgA' },
  { token: 'tok-b', scopes: ['read:*'], partner_org: 'orgB' },
  { token: 'tok-plain', scopes: ['read:*'] },
])

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-tenant-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const previous = { tokens: process.env.LINDELA_LITE_TOKENS }
  process.env.LINDELA_LITE_TOKENS = TOKENS
  try {
    return await fn(base, store)
  } finally {
    if (previous.tokens === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = previous.tokens
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const get = (base, path, token) => fetch(`${base}${path}`, {
  headers: { authorization: `Bearer ${token}` },
})

describe('a partner claim can be expressed', () => {
  it('carries partner_org from the token definition through authenticate', () => {
    const tokens = parseTokens({ LINDELA_LITE_TOKENS: TOKENS })
    assert.equal(tokens[0].partner_org, 'orgA')
    assert.equal(tokens[2].partner_org, null, 'a token with no claim has none, rather than an empty string that matches nothing')
  })

  it('refuses a partner_org that is not a string', () => {
    assert.throws(
      () => parseTokens({ LINDELA_LITE_TOKENS: JSON.stringify([{ token: 't', scopes: [], partner_org: 7 }]) }),
      (err) => err.statusCode === 500 || /partner_org/.test(err.message),
    )
  })

  it('scopes by the token, not by the caller', () => {
    const records = [
      { id: 'r1', partner_org: 'orgA' },
      { id: 'r2', partner_org: 'orgB' },
      { id: 'r3' },
    ]
    assert.deepEqual(scopeToPartnerOrg(records, { partner_org: 'orgA' }).map((r) => r.id), ['r1'])
    assert.deepEqual(scopeToPartnerOrg(records, { partner_org: 'orgB' }).map((r) => r.id), ['r2'])
    // A token with no claim is a platform token, and sees the platform.
    assert.equal(scopeToPartnerOrg(records, {}).length, 3)
  })

  it('shows a partner nothing when no record is tagged', () => {
    // The truthful answer for a deployment with no per-partner tagging. The
    // alternative — passing untagged records through — is the leak.
    assert.deepEqual(scopeToPartnerOrg([{ id: 'r1' }, { id: 'r2' }], { partner_org: 'orgA' }), [])
  })
})

describe('a partner claim is enforced', () => {
  const assets = [
    { id: 'a1', name: 'Clinic A', partner_org: 'orgA', service_type: 'health', population_served: 100 },
    { id: 'a2', name: 'Clinic B', partner_org: 'orgB', service_type: 'health', population_served: 200 },
    { id: 'a3', name: 'Clinic C', service_type: 'health', population_served: 300 },
  ]

  it('returns only the caller\'s own records', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      assert.deepEqual(body.data.map((r) => r.id), ['a1'])
    })
  })

  it('gives a different partner a different answer from the same store', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const a = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      const b = await (await get(base, '/api/v1/service-assets', 'tok-b')).json()
      assert.deepEqual(a.data.map((r) => r.id), ['a1'])
      assert.deepEqual(b.data.map((r) => r.id), ['a2'])
    })
  })

  it('hides untagged records rather than showing them to everyone', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-a')).json()
      assert.ok(!body.data.some((r) => r.id === 'a3'),
        'a record with no partner_org is not this partner\'s')
    })
  })

  it('leaves an unscoped token with the whole platform', async () => {
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets', 'tok-plain')).json()
      assert.equal(body.data.length, 3)
    })
  })

  it('scopes the widest read in the API', async () => {
    // GET /api/v1/export.csv is the route SEC-01 found serving field reports
    // and RapidPro message bodies unauthenticated. It also passed no context
    // at all, so it had no tenant scoping either: an export that ignored the
    // token would undo everything the list routes now do.
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const res = await get(base, '/api/v1/export.csv', 'tok-a')
      assert.equal(res.status, 200)
      const text = await res.text()
      assert.match(text, /Clinic A/)
      assert.ok(!text.includes('Clinic B'), "orgB's clinic appeared in orgA's export")
      assert.ok(!text.includes('Clinic C'))
    })
  })

  it('refuses a partner_org on the export route too', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/export.csv?partner_org=orgB', 'tok-a')
      assert.equal(res.status, 403)
    })
  })

  it('applies the scope after the filters, not instead of them', async () => {
    // A filter that matched nothing must still return nothing: scoping by
    // partner is a restriction on top of the query, not a substitute.
    await withServer(async (base, store) => {
      await store.merge({ service_assets: assets })
      const body = await (await get(base, '/api/v1/service-assets?service_type=water', 'tok-a')).json()
      assert.deepEqual(body.data, [])
    })
  })
})

describe('a partner claim can be checked', () => {
  it('refuses a partner_org the token does not speak for', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgB', 'tok-a')
      assert.equal(res.status, 403)
      assert.match((await res.json()).error, /does not match this token/)
    })
  })

  it('refuses a partner_org from a token that has no claim', async () => {
    // The portal sent this on every request. Before, the server read nothing
    // and every partner received the whole store while the interface showed
    // the filter as applied.
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgA', 'tok-plain')
      assert.equal(res.status, 403)
      assert.match((await res.json()).error, /not scoped to a partner organisation/)
    })
  })

  it('accepts the token\'s own partner_org', async () => {
    await withServer(async (base) => {
      const res = await get(base, '/api/v1/service-assets?partner_org=orgA', 'tok-a')
      assert.equal(res.status, 200)
    })
  })

  it('reports who the caller is', async () => {
    await withServer(async (base) => {
      const { data } = await (await get(base, '/api/v1/auth-info', 'tok-b')).json()
      assert.equal(data.partner_org, 'orgB')
      assert.match(data.subject, /^token_[0-9a-f]{12}$/)
      assert.deepEqual(data.scopes, ['read:*'])
      assert.equal(data.auth_configured, true)
    })
  })

  it('reports no organisation for a platform token rather than inventing one', async () => {
    await withServer(async (base) => {
      const { data } = await (await get(base, '/api/v1/auth-info', 'tok-plain')).json()
      assert.equal(data.partner_org, null)
    })
  })
})