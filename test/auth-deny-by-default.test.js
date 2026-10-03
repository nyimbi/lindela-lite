import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { parseTokens, scopeForRoute, authenticate, isPublicPath } from '../src/auth.js'

/**
 * Authentication is deny-by-default.
 *
 * The defect these guard: `if (!auth && req.method !== 'GET')`. GETs were
 * never rejected, so a deployment with API keys correctly configured served
 * `GET /api/v1/export.csv` — field reports and RapidPro message bodies — to
 * anyone who could reach the port. The configuration looked secured, which is
 * what made it serious rather than merely wrong.
 */

const ENV_KEYS = ['LINDELA_LITE_TOKENS', 'LINDELA_LITE_API_KEY', 'LINDELA_LITE_PUBLIC_PATHS']
const saved = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]

function setAuth(tokens) {
  for (const key of ENV_KEYS) delete process.env[key]
  if (tokens) process.env.LINDELA_LITE_TOKENS = JSON.stringify(tokens)
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const READ_TOKEN = 'read-token-aaaaaaaaaaaa'
const FULL_TOKEN = 'admin-token-bbbbbbbbbbbb'

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-auth-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge({
    field_reports: [{ id: 'fr-1', occurred_at: '2026-10-01T00:00:00.000Z', reporter_phone: '+254700000000' }],
    hazard_events: [{ id: 'hz-1', event_type: 'flood', severity: 'high' }],
  })
  const server = createServer({ store })
  const listener = server.listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('authentication is deny-by-default', () => {
  it('rejects an unauthenticated GET, including the export', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      for (const route of ['/api/v1/flood-risk', '/api/v1/export.csv', '/api/v1/districts']) {
        const res = await fetch(`${base}${route}`)
        assert.equal(res.status, 401, `${route} served an unauthenticated GET`)
      }
    })
  })

  it('does not leak the export body to an unauthenticated caller', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/export.csv`)
      assert.equal(res.status, 401)
      const text = await res.text()
      assert.equal(text.includes('+254700000000'), false, 'the reporter phone number reached an unauthenticated caller')
      assert.equal(text.includes('fr-1'), false)
    })
  })

  it('gates /metrics, which used to be served before the auth gate', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      for (const route of ['/metrics', '/api/v1/metrics']) {
        const res = await fetch(`${base}${route}`)
        assert.equal(res.status, 401, `${route} is unauthenticated despite sitting in the API namespace`)
        assert.equal((await res.text()).includes('http_requests_total'), false)
      }
      const authed = await fetch(`${base}/api/v1/metrics`, { headers: { authorization: `Bearer ${READ_TOKEN}` } })
      assert.equal(authed.status, 200)
    })
  })

  it('leaves the health check public so probes keep working', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`)
      assert.equal(res.status, 200)
    })
  })

  it('serves authenticated GETs to a token with the right scope', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/flood-risk`, { headers: { authorization: `Bearer ${READ_TOKEN}` } })
      assert.equal(res.status, 200)
    })
  })

  it('accepts x-api-key as well as a bearer token', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/flood-risk`, { headers: { 'x-api-key': READ_TOKEN } })
      assert.equal(res.status, 200)
    })
  })

  it('opens only the paths an operator names explicitly', async () => {
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    process.env.LINDELA_LITE_PUBLIC_PATHS = '/api/v1/flood-risk'
    await withServer(async (base) => {
      const opened = await fetch(`${base}/api/v1/flood-risk`)
      assert.equal(opened.status, 200, 'an explicitly public path should be reachable')
      const stillClosed = await fetch(`${base}/api/v1/export.csv`)
      assert.equal(stillClosed.status, 401, 'naming one path must not open the rest')
    })
  })
})

describe('a read token cannot mutate anything', () => {
  it('refuses a POST to a route nobody mapped', async () => {
    // scopeForRoute used to fall through to 'read:hazards' for any route not
    // in its five special cases, so a token issued for reading hazards could
    // write to anything — including routes added after the token was issued.
    setAuth([{ token: READ_TOKEN, scopes: ['read:hazards'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/incidents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${READ_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'unauthorised write' }),
      })
      assert.equal(res.status, 403)
    })
  })

  it('maps an unmapped mutation to a scope no scoped token holds', () => {
    assert.equal(scopeForRoute('POST', '/api/v1/something-added-next-year'), 'admin:*')
    assert.equal(scopeForRoute('DELETE', '/api/v1/something-added-next-year'), 'admin:*')
    assert.equal(scopeForRoute('PATCH', '/api/v1/something-added-next-year'), 'admin:*')
  })

  it('maps the known mutation families to their own scopes', () => {
    assert.equal(scopeForRoute('POST', '/api/v1/incidents'), 'write:incidents')
    assert.equal(scopeForRoute('POST', '/api/v1/field-reports'), 'write:incidents')
    assert.equal(scopeForRoute('POST', '/api/v1/alert-rules'), 'admin:alerts')
    assert.equal(scopeForRoute('POST', '/api/v1/ingest/run'), 'admin:schedules')
    assert.equal(scopeForRoute('GET', '/api/v1/export.csv'), 'read:export')
  })

  it('honours a resource wildcard and a full admin token', async () => {
    setAuth([
      { token: READ_TOKEN, scopes: ['read:hazards'] },
      { token: FULL_TOKEN, scopes: ['*'] },
    ])
    await withServer(async (base) => {
      const refused = await fetch(`${base}/api/v1/incidents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${READ_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'nope' }),
      })
      assert.equal(refused.status, 403)

      const allowed = await fetch(`${base}/api/v1/incidents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${FULL_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Flood cut the Mandera road', severity: 'high', country: 'KE' }),
      })
      assert.equal(allowed.status, 201)
    })
  })
})

describe('misconfiguration fails closed', () => {
  it('refuses to serve when the token config is not valid JSON', async () => {
    // parseTokens returned [] on a parse error, and an empty token list
    // disabled the whole auth block. A stray comma turned authentication off
    // in production and nothing said so.
    setAuth(null)
    process.env.LINDELA_LITE_TOKENS = '[{"token": "abc",}]'
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/flood-risk`)
      assert.equal(res.status, 500, 'a broken token config must not fall open to unauthenticated reads')
    })
  })

  it('refuses to serve when the token config is not an array', async () => {
    setAuth(null)
    process.env.LINDELA_LITE_TOKENS = '{"token": "abc"}'
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/v1/export.csv`)).status, 500)
    })
  })

  it('refuses to serve an empty token array', async () => {
    setAuth([])
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/v1/flood-risk`)).status, 500)
    })
  })

  it('throws rather than returning an empty list', () => {
    assert.throws(() => parseTokens({ LINDELA_LITE_TOKENS: 'not json' }), /not valid JSON/)
    assert.throws(() => parseTokens({ LINDELA_LITE_TOKENS: '{}' }), /must be a JSON array/)
    assert.throws(() => parseTokens({ LINDELA_LITE_TOKENS: '[{"scopes":["*"]}]' }), /no non-empty "token"/)
  })

  it('treats no configuration at all as the deliberate unauthenticated mode', () => {
    assert.deepEqual(parseTokens({}), [])
    assert.equal(isPublicPath('/api/v1/health', {}), true)
    assert.equal(isPublicPath('/api/v1/export.csv', {}), false)
  })
})

describe('internal errors are not returned to clients', () => {
  it('returns a correlation id instead of the underlying message', async () => {
    setAuth([{ token: FULL_TOKEN, scopes: ['*'] }])
    // A store that fails the way `pg` fails: the message carries the
    // connection string and the failing statement.
    const leaky = {
      mode: 'custom',
      async read() {
        throw new Error('connect ECONNREFUSED 10.0.0.7:5432 — password authentication failed for user "lindela"')
      },
      async merge() { throw new Error('unreachable') },
      async write() { throw new Error('unreachable') },
    }
    const server = createServer({ store: leaky })
    const listener = server.listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const res = await fetch(`${base}/api/v1/flood-risk`, { headers: { authorization: `Bearer ${FULL_TOKEN}` } })
      assert.equal(res.status, 500)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.error, 'Internal server error')
      assert.ok(body.incident_id, 'the client needs something it can quote in a bug report')
      const serialised = JSON.stringify(body)
      assert.equal(serialised.includes('ECONNREFUSED'), false, 'the database error reached the client')
      assert.equal(serialised.includes('10.0.0.7'), false, 'the internal host address reached the client')
      assert.equal(serialised.includes('lindela'), false, 'the database user name reached the client')
    } finally {
      listener.close()
    }
  })

  it('keeps the message on a deliberate client error', async () => {
    // A 4xx with an explicit statusCode is written for the caller — a blanket
    // "never leak a message" rule would turn every validation failure into an
    // opaque 500 and make the API impossible to integrate against.
    setAuth([{ token: FULL_TOKEN, scopes: ['*'] }])
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ingest/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${FULL_TOKEN}`, 'content-type': 'application/json' },
        body: '{ this is not json',
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.ok(body.error && body.error.length > 0, 'a validation error must still say what was wrong')
    })
  })
})

describe('tokens are not exposed through audit metadata', () => {
  it('never puts token material in the subject', () => {
    const token = 'super-secret-token-value'
    const auth = authenticate({ headers: { authorization: `Bearer ${token}` } }, {
      LINDELA_LITE_TOKENS: JSON.stringify([{ token, scopes: ['*'] }]),
    })
    assert.ok(auth)
    assert.equal(auth.subject.includes(token.slice(0, 8)), false, 'the subject leaked the first 8 characters of the secret')
    assert.ok(auth.subject.startsWith('token_'))
    // Stable, so two requests with one token still correlate in the logs.
    const again = authenticate({ headers: { 'x-api-key': token } }, {
      LINDELA_LITE_TOKENS: JSON.stringify([{ token, scopes: ['*'] }]),
    })
    assert.equal(again.subject, auth.subject)
  })

  it('rejects a token that shares a prefix with a valid one', () => {
    const env = { LINDELA_LITE_TOKENS: JSON.stringify([{ token: 'abcd1234efgh', scopes: ['*'] }]) }
    assert.equal(authenticate({ headers: { authorization: 'Bearer abcd1234' } }, env), null)
    assert.equal(authenticate({ headers: { authorization: 'Bearer abcd1234efghX' } }, env), null)
    assert.ok(authenticate({ headers: { authorization: 'Bearer abcd1234efgh' } }, env))
  })
})