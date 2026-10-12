#!/usr/bin/env node
/**
 * ENH-60 — `matchAuthInfoRoute` / `handleAuthInfoRoute`.
 *
 * The family exists because `GET /api/v1/auth-info` was answered from **two
 * places** in the dispatcher: on the 401 path (so a console with no key can
 * learn it needs one) and on the authenticated path (where identity is known).
 * Two copies of one response is the shape VER-18 recorded — a path served twice
 * has exactly one tested implementation — and here the two copies agreed only
 * by coincidence: the 401-path copy hardcoded `auth_configured: true`, which
 * happens to be what `isAuthConfigured()` returns inside the branch guarding it.
 *
 * So the assertions below are about the *one* handler both call sites now use,
 * and the two tests that matter are the two branches: `auth` null is the
 * anonymous answer, `auth` set is the identified one. The live behaviour is
 * covered by `test/auth-bootstrap.test.js` (18 cases through a real server);
 * this file is the module's own contract, which `check-module-coverage`
 * requires and which no live-server test can express — that the handler is
 * *reachable* at both call sites is a structural fact about the dispatcher.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { matchAuthInfoRoute, handleAuthInfoRoute } from '../src/routes/auth-info.js'

// `handleAuthInfoRoute` reads `auth_configured` from the deployment
// (`isAuthConfigured()` consults the environment), so the fixture has to
// establish one. The authenticated branch is only reachable when auth is
// configured — that is the branch that calls `authenticate()` — so a test that
// left the environment bare would be asserting the 401 path's precondition.
let savedTokens
before(() => {
  savedTokens = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = JSON.stringify([{ token: 't', scopes: ['*'] }])
})
after(() => {
  if (savedTokens === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = savedTokens
})

/** A response double that records what was written. */
function fakeResponse() {
  const res = {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status },
    end(text) { this.body = text ? JSON.parse(text) : null },
  }
  return res
}

/** The `jsonResponse` the dispatcher passes: sets the status and ends the body. */
const jsonResponse = (res, status, body) => {
  res.statusCode = status
  res.body = body
}

const call = (auth, { pathname = '/api/v1/auth-info', method = 'GET' } = {}) => {
  const route = matchAuthInfoRoute(pathname, method)
  const res = fakeResponse()
  const handled = route ? handleAuthInfoRoute(route, { auth, res, jsonResponse }) : false
  return { route, res, handled }
}

describe('ENH-60 — matchAuthInfoRoute serves one path and one verb', () => {
  it('matches GET on the route', () => {
    assert.deepEqual(matchAuthInfoRoute('/api/v1/auth-info', 'GET'), { kind: 'auth-info' })
  })

  it('does not match the path on a write verb', () => {
    // The route is a read. A POST to it must fall through to the surface's own
    // 404 rather than being answered here.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(matchAuthInfoRoute('/api/v1/auth-info', method), null, `${method} matched`)
    }
  })

  it('does not match a near-miss path', () => {
    // `/api/v1/auth-info/scopes` is a real, *separate* route that requires a
    // token — `test/auth-bootstrap.test.js` asserts it 401s anonymously. A
    // prefix match here would leak the anonymous answer onto it.
    for (const path of ['/api/v1/auth-info/scopes', '/api/v1/auth-information', '/api/v1/auth-info/']) {
      assert.equal(matchAuthInfoRoute(path, 'GET'), null, `${path} matched`)
    }
  })
})

describe('ENH-60 — one handler answers both branches', () => {
  it('the anonymous answer is nulls and the flag, and reports auth is on', () => {
    // This is the 401-path branch: `auth` is null because `authenticate()`
    // returned nothing. It must still answer 200, because the whole reason the
    // route exists is to be reachable by a client that has no key.
    const { res, handled } = call(null)
    assert.equal(handled, true)
    assert.equal(res.statusCode, 200, 'the anonymous branch must not be a 401')
    assert.equal(res.body.data.subject, null, 'no token, no subject')
    assert.deepEqual(res.body.data.scopes, [])
    assert.equal(res.body.data.partner_org, null)
    assert.equal(res.body.data.auth_configured, true,
      'the one fact the caller came for: this deployment requires a token')
  })

  it('the identified answer is the caller’s own identity', () => {
    const { res } = call({ subject: 'token_abc', scopes: ['*'], partner_org: 'orgA' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.subject, 'token_abc')
    assert.deepEqual(res.body.data.scopes, ['*'])
    assert.equal(res.body.data.partner_org, 'orgA')
    assert.equal(res.body.data.auth_configured, true)
  })

  it('a token with no partner org reports null, not a stringified undefined', () => {
    // `auth.partner_org` is absent for an unscoped token, and `|| null` is what
    // keeps the JSON a null rather than `undefined` — which `JSON.stringify`
    // drops from the object entirely, so the key would vanish and a client
    // reading `data.partner_org` would get `undefined` from a present-looking
    // shape. This is the falsy-zero-adjacent failure: absence must be stated.
    const { res } = call({ subject: 'token_abc', scopes: ['read:*'] })
    assert.equal(res.body.data.partner_org, null)
    assert.ok('partner_org' in res.body.data, 'the key must be present, not dropped')
  })

  it('reports whether anonymous reads are open, so the banner can tell the two apart', () => {
    // `anonymous_reads` is the console's signal for "browse freely; a token only
    // unlocks writes" versus "paste a token to see anything". It is a boolean in
    // the payload, and the handler reads it from the deployment rather than
    // taking it as an argument — so this asserts the key is present and boolean,
    // which is the contract the banner depends on.
    const { res } = call(null)
    assert.equal(typeof res.body.data.anonymous_reads, 'boolean')
  })

  it('does not answer a route it did not match', () => {
    // The guard the dispatcher relies on: `handled === false` lets a non-match
    // fall through rather than being swallowed.
    const { handled } = call(null, { pathname: '/api/v1/incidents' })
    assert.equal(handled, false)
  })
})
