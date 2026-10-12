#!/usr/bin/env node
/**
 * ENH-60 — `enforceAuthGate`.
 *
 * The last block ENH-60 names as entangled in the dispatcher: the preamble
 * every API request passes through before any route is matched. It is the one
 * module under `src/routes/` that exports no `match*Route`, because there is
 * nothing to match — it runs at a fixed point, above the store read and above
 * every family matcher, and it returns a verdict rather than a boolean because
 * the dispatcher has three things to do with the answer and a boolean would
 * lose the identity.
 *
 * The live behaviour is covered end to end by `test/auth-bootstrap.test.js`,
 * `test/auth-deny-by-default.test.js`, `test/auth-public-reads.test.js` and
 * `test/rapidpro-webhook-auth.test.js`. What no live-server test can express is
 * the *shape* of the verdict — that "handled" and "continue with this identity"
 * are distinct outcomes, and that the identity the gate resolved is the one it
 * returns rather than one it mutates into a parameter. That is this file.
 */

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { enforceAuthGate } from '../src/routes/auth-gate.js'

const WEBHOOK_SECRET = 'gate-module-test-secret'
const sign = (body, secret = WEBHOOK_SECRET) => createHmac('sha256', secret).update(body).digest('hex')

let savedTokens
let savedWebhookSecret
before(() => {
  savedTokens = process.env.LINDELA_LITE_TOKENS
  savedWebhookSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
  process.env.LINDELA_LITE_TOKENS = JSON.stringify([{ token: 'good', scopes: ['read:*'] }])
  process.env.RAPIDPRO_WEBHOOK_SECRET = WEBHOOK_SECRET
})
after(() => {
  if (savedTokens === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = savedTokens
  if (savedWebhookSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
  else process.env.RAPIDPRO_WEBHOOK_SECRET = savedWebhookSecret
})

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status },
    end(text) { this.body = text ? JSON.parse(text) : null },
  }
}

const jsonResponse = (res, status, body) => { res.statusCode = status; res.body = body }

/** A request double. `readRawBody` reads the async iterator, so a body is bytes. */
function fakeRequest({ method = 'GET', body = '', headers = {} } = {}) {
  const chunks = body ? [Buffer.from(body)] : []
  return {
    method,
    headers,
    rawBody: undefined,
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }
    },
  }
}

const gate = (req, pathname, { auth = null } = {}) => {
  const res = fakeResponse()
  return enforceAuthGate(req, res, new URL(`http://x${pathname}`), { auth, jsonResponse })
    .then((verdict) => ({ verdict, res }))
}

describe('ENH-60 — the gate resolves an identity or stops the request', () => {
  it('a valid token continues, carrying the identity it resolved', async () => {
    const { verdict } = await gate(
      fakeRequest({ headers: { authorization: 'Bearer good' } }),
      '/api/v1/incidents',
    )
    assert.equal(verdict.outcome, 'continue')
    // The subject is a fingerprint of the token, not the token — `authenticate`
    // hashes it so no audit log carries eight characters of the secret. So the
    // assertion is that the gate returns *that* identity, and the control below
    // is that it is not the presented string.
    const fingerprint = `token_${createHash('sha256').update('good').digest('hex').slice(0, 12)}`
    assert.equal(verdict.auth?.subject, fingerprint,
      'the gate must return the identity it resolved, not merely permit the request')
    assert.notEqual(verdict.auth?.subject, 'good',
      'the gate echoed the presented token back as the subject')
  })

  it('no token stops the request with a 401', async () => {
    const { verdict, res } = await gate(fakeRequest(), '/api/v1/incidents')
    assert.equal(verdict.outcome, 'handled')
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.success, false)
  })

  it('a token without the route’s scope stops with a 403, not a 500', async () => {
    // `requireScope` throws; the gate turns the throw into a response. A gate
    // that let it propagate would make an authorisation failure look like a
    // server fault, and the caller could not tell a refusal from an outage.
    const { verdict, res } = await gate(
      fakeRequest({ method: 'POST', headers: { authorization: 'Bearer good' } }),
      '/api/v1/incidents',
    )
    assert.equal(verdict.outcome, 'handled')
    assert.equal(res.statusCode, 403, `expected a refusal, got ${res.statusCode}`)
  })
})

describe('ENH-60 — the four decisions, each asserted where it is made', () => {
  it('an unauthenticated caller reaches /auth-info and nothing else', async () => {
    // The route exists *because* the key was missing. Gating it meant a fresh
    // console got the same 401 as every other route and could not tell "this
    // deployment requires a token" from "this deployment is broken".
    const { verdict, res } = await gate(fakeRequest(), '/api/v1/auth-info')
    assert.equal(verdict.outcome, 'handled')
    assert.equal(res.statusCode, 200, 'auth-info must be reachable without a token')
    assert.equal(res.body.data.auth_configured, true)

    // The control: the same caller on any other route is refused, so the
    // assertion above is about this route and not about a gate that stopped
    // gating.
    const other = await gate(fakeRequest(), '/api/v1/incidents')
    assert.equal(other.res.statusCode, 401)
  })

  it('a public read continues without a token', async () => {
    // `isPublicRequest` is a read widening only. `/api/v1/health` is on the
    // public list, and the gate must let it through with no identity.
    const { verdict } = await gate(fakeRequest(), '/api/v1/health')
    assert.equal(verdict.outcome, 'continue')
    assert.equal(verdict.auth, null, 'a public read resolves no identity')
  })

  it('a write to a publicly listed path still authenticates', async () => {
    // The old guard rejected only non-GET methods, so a mutation to a public
    // path was served to anyone. The gate reads `isPublicRequest`, which is
    // method-aware — this asserts the gate uses it rather than a path list.
    const { verdict, res } = await gate(fakeRequest({ method: 'POST' }), '/api/v1/health')
    assert.equal(verdict.outcome, 'handled')
    assert.equal(res.statusCode, 401, 'a POST to a public read path must authenticate')
  })

  it('a signed webhook is verified against its buffered bytes, and a bad one is refused', async () => {
    // The body must be buffered *before* verification: a signature covers the
    // exact bytes sent, and the stream cannot be read twice. A gate that
    // verified first would fail every HMAC-signed request closed against the
    // real route while passing in any test that hands the handler a body.
    const body = '{"a":1}'
    const good = await gate(
      fakeRequest({ method: 'POST', body, headers: { 'x-rapidpro-signature': sign(body) } }),
      '/api/v1/rapidpro/field-report',
    )
    assert.equal(good.verdict.outcome, 'continue',
      'a correctly signed webhook was refused, so the gate did not verify the buffered bytes')

    const tampered = await gate(
      fakeRequest({ method: 'POST', body: '{"a":2}', headers: { 'x-rapidpro-signature': sign(body) } }),
      '/api/v1/rapidpro/field-report',
    )
    assert.equal(tampered.verdict.outcome, 'handled')
    assert.equal(tampered.res.statusCode, 401)
    assert.equal(tampered.res.body.code, 'invalid_signature')
  })

  it('buffers the body so a later handler can read the same bytes', async () => {
    // The gate writes `req.rawBody` before it decides. Whatever it decides, the
    // bytes are on the request — which is what lets the route read a body the
    // signature check already consumed. `readRawBody` returns a utf8 string, and
    // the webhook route parses it, so a Buffer here would be a different value
    // than the one the signature covered.
    const req = fakeRequest({ method: 'POST', body: '{"a":1}', headers: { 'x-rapidpro-signature': 'nope' } })
    await gate(req, '/api/v1/rapidpro/field-report')
    assert.equal(req.rawBody, '{"a":1}')
    // The canary for the assertion above: an unsigned request never enters the
    // buffering branch, so `rawBody` staying undefined there is what shows the
    // value came from this branch and not from the double's initial state.
    const untouched = fakeRequest({ method: 'POST', body: '{"a":1}' })
    await gate(untouched, '/api/v1/health')
    assert.equal(untouched.rawBody, undefined)
  })
})

describe('ENH-60 — the gate is inert when the deployment configures no auth', () => {
  it('continues every request untouched', async () => {
    const prior = process.env.LINDELA_LITE_TOKENS
    delete process.env.LINDELA_LITE_TOKENS
    try {
      // The identity the dispatcher already held is passed straight through —
      // an auth-free deployment must not have its requests silently
      // re-authenticated into null.
      const { verdict } = await gate(fakeRequest(), '/api/v1/incidents', { auth: { subject: 'pre' } })
      assert.equal(verdict.outcome, 'continue')
      assert.equal(verdict.auth?.subject, 'pre')
    } finally {
      if (prior !== undefined) process.env.LINDELA_LITE_TOKENS = prior
    }
  })
})
