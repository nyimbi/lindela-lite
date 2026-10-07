import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * A locked-out console said nothing.
 *
 * `GET /api/v1/auth-info` was mapped to `read:self` like every other route, so
 * on a deployment with tokens configured it answered `401` to a client with no
 * token. That route's whole reason for existing is to report `auth_configured`,
 * so the console could never learn it needed a key: it asked, got the same 401
 * as `/incidents` and `/alert-events`, and had nothing to distinguish "this
 * deployment requires a token" from "this deployment is broken".
 *
 * The console then rendered every panel empty and stayed quiet — no 401 branch
 * anywhere in `public/app.js` — and the API key field lives in the *deferred*
 * settings panel, so there was no visible prompt either. The result read
 * exactly like a deployment with no data.
 */

const TOKENS = JSON.stringify([
  { token: 'tok-admin', scopes: ['*'] },
  { token: 'tok-reader', scopes: ['read:*'] },
])

let listener
let base
let store
let dir
let previous

const call = async (path, token) => {
  const headers = token ? { 'x-api-key': token } : {}
  const res = await fetch(`${base}${path}`, { headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  previous = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  // A real temp directory. `JsonStore` takes a file path and has no in-memory
  // mode, so a literal ':memory:' here creates a file of that name in the
  // repository root — which it did, twice, across two test files.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-auth-bootstrap-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({ incidents: [{ id: 'i1', title: 'one' }], field_reports: [] })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = previous
})

describe('a client with no token can learn that it needs one', () => {
  it('auth-info answers without a token, and says auth is configured', async () => {
    const { status, body } = await call('/api/v1/auth-info')
    assert.equal(status, 200, 'the route that reports auth_configured is itself gated')
    assert.equal(body.success, true)
    assert.equal(body.data.auth_configured, true,
      'this is the one fact the caller came for')
  })

  it('and withholds identity from a caller that presented nothing', async () => {
    const { body } = await call('/api/v1/auth-info')
    assert.equal(body.data.subject, null, 'no token, no subject')
    assert.deepEqual(body.data.scopes, [])
    assert.equal(body.data.partner_org, null)
  })

  it('still reports the real identity to a caller that did present a token', async () => {
    const { status, body } = await call('/api/v1/auth-info', 'tok-admin')
    assert.equal(status, 200)
    assert.match(body.data.subject, /^token_/)
    assert.deepEqual(body.data.scopes, ['*'])
  })

  it('a partner-scoped caller sees its own organisation and no other', async () => {
    process.env.LINDELA_LITE_TOKENS = JSON.stringify([
      { token: 'tok-a', scopes: ['read:*'], partner_org: 'orgA' },
    ])
    const { body } = await call('/api/v1/auth-info', 'tok-a')
    assert.equal(body.data.partner_org, 'orgA')
    process.env.LINDELA_LITE_TOKENS = TOKENS
  })

  it('a wrong token gets no identity, exactly like no token', async () => {
    // An earlier draft of this test asserted a 401 here. It should not: the
    // exemption sits after `authenticate()`, which already collapses "wrong
    // token" and "no token" into no identity. Answering 200-with-nulls for a
    // bad token is the consistent behaviour, and it avoids an oracle that lets
    // a caller distinguish a bad credential from an absent one — a distinction
    // worth nothing, since a 401 already reveals that auth is enabled.
    const wrong = await call('/api/v1/auth-info', 'not-a-real-token')
    assert.equal(wrong.status, 200)
    assert.equal(wrong.body.data.subject, null, 'a bad token must not resolve to an identity')
    assert.deepEqual(wrong.body.data.scopes, [])
    assert.equal(wrong.body.data.partner_org, null)

    // And it grants nothing: the rest of the API still refuses it.
    const other = await call('/api/v1/incidents', 'not-a-real-token')
    assert.equal(other.status, 401, 'a bad token must not authenticate anything')
  })

  it('loosens nothing else', async () => {
    // The whole reason this is safe is that it is one route. If any of these
    // answer 200 for an anonymous caller, the exemption has spread.
    for (const path of [
      '/api/v1/incidents',
      '/api/v1/field-reports',
      '/api/v1/trigger-protocols',
      '/api/v1/alert-events',
      '/api/v1/export.csv',
      '/api/v1/auth-info/scopes',
    ]) {
      const { status } = await call(path)
      assert.equal(status, 401, `${path} answered ${status} to an anonymous caller`)
    }
  })

  it('reports auth_configured false when the deployment has no auth', async () => {
    delete process.env.LINDELA_LITE_TOKENS
    try {
      const { status, body } = await call('/api/v1/auth-info')
      assert.equal(status, 200)
      assert.equal(body.data.auth_configured, false,
        'an unauthenticated deployment must say so rather than leave it ambiguous')
    } finally {
      process.env.LINDELA_LITE_TOKENS = TOKENS
    }
  })
})

describe('the console says something when it is locked out', () => {
  const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

  it('asks auth-info at boot rather than inferring from another 401', () => {
    assert.match(APP, /refreshAuthState\(\)/,
      'the boot sequence should establish whether a key is needed')
    assert.match(APP, /apiFetch\('\/api\/v1\/auth-info'/)
  })

  it('the banner visibility is not decided by the network alone', () => {
    // The defect in one line: `offlineBanner.hidden = online` shows the banner
    // only when the network is down, so a reachable server that rejects the
    // browser rendered an empty console with no message at all. Anchored to end
    // of line, so the fixed form is not what this rejects.
    assert.doesNotMatch(APP, /^\s*offlineBanner\.hidden = online\s*$/m,
      'banner visibility must not depend on navigator.onLine alone')
    assert.match(APP, /offlineBanner\.hidden = online && !needsKey/)
  })

  it('there is a distinct message, so it is not read as "queued for sync"', () => {
    assert.match(INDEX, /id="authBannerText"/,
      'the locked-out case needs its own words')
    assert.match(INDEX, /requires an API token/)
    // The two messages are mutually exclusive through one shared guard, so the
    // offline wording can never appear next to the locked-out wording. Pinned on
    // the guard rather than the full expression, so renaming the local does not
    // read as a regression.
    assert.match(APP, /const locked = needsKey && online/,
      'one guard should decide which of the two messages shows')
    assert.match(APP, /offlineText\.hidden = locked\b/,
      'the offline message must hide when we are locked out, not offline')
    assert.match(APP, /authText\.hidden = !locked\b/,
      'the locked-out message must hide when we are not locked out')
  })
})
