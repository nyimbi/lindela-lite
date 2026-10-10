import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * CAP-06 — no CORS, no preflight, and no HEAD on the API.
 *
 * The server is a JSON API with a documented OpenAPI surface and a generated
 * client, and a browser-based third-party client could not call any of it: no
 * `OPTIONS` handler and no `Access-Control-Allow-*` header anywhere in `src/`.
 * A dashboard on another origin got an opaque CORS failure, which is
 * indistinguishable from the server being down.
 *
 * The second half is smaller and easier to get wrong: `HEAD` fell through to
 * the GET handler and wrote a body. Node strips the body for HEAD, so the
 * response *looked* right — but the handler had already done the work, and a
 * HEAD that materialises a store read and a JSON serialisation to discard both
 * is a HEAD that costs what a GET costs.
 *
 * CORS is opt-in and off by default. That is the deliberate part: an open
 * `Access-Control-Allow-Origin: *` on an API that serves partner-scoped data
 * would hand every origin a cross-origin read the token model was built to
 * bound. The operator names the origins they trust, in
 * `LINDELA_LITE_CORS_ORIGINS`, the same way they name public paths.
 */

const CREDS = JSON.stringify([{ token: 'cors-key', scopes: ['*'] }])

async function withServer(fn, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-cap06-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === '') delete process.env[k]
    else process.env[k] = v
  }
  const listener = createServer({ store }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('CAP-06 — HEAD answers the API without doing the GET', () => {
  it('returns 200 with the GET headers and no body', async () => {
    await withServer(async (base) => {
      const get = await fetch(`${base}/api/v1/health`)
      assert.equal(get.status, 200)
      const head = await fetch(`${base}/api/v1/health`, { method: 'HEAD' })
      assert.equal(head.status, 200,
        'HEAD fell through to a 404 rather than being routed to its GET sibling')
      assert.equal(head.headers.get('content-type'), get.headers.get('content-type'),
        'a HEAD must carry the headers its GET would, or a cache cannot revalidate from it')
      assert.equal((await head.text()).length, 0, 'a HEAD response has no body')
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '' })
  })

  it('answers HEAD for a route the GET handler serves, not only for static files', async () => {
    // `sendFile` and the tile route already special-cased HEAD; the API did not,
    // so the one surface a client library actually probes was the one that 404'd.
    await withServer(async (base, store) => {
      await store.merge({
        service_assets: [{ id: 'a1', type: 'service_asset', name: 'A', service_type: 'clinic' }],
      })
      const res = await fetch(`${base}/api/v1/service-assets`, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal((await res.text()).length, 0)
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '' })
  })

  it('a HEAD to an unknown path is still a 404, so HEAD is not a blanket 200', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/no-such-route`, { method: 'HEAD' })
      assert.equal(res.status, 404)
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '' })
  })

  it('HEAD is subject to the same auth gate as GET', async () => {
    // The tempting shortcut is to answer HEAD from the routing table before
    // authentication, because "HEAD carries no data". It carries the same
    // headers a GET does — including an ETag and a Content-Length — and those
    // are a probe of whether a record exists.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/service-assets`, { method: 'HEAD' })
      assert.equal(res.status, 401, 'an anonymous HEAD reached a data route')
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' })
  })
})

describe('CAP-06 — CORS is opt-in, and correct when opted in', () => {
  it('sends no CORS header when no origin is configured', async () => {
    // Off by default. An API serving partner-scoped rows must not hand every
    // origin a cross-origin read the token model was built to bound.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.test' } })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: '' })
  })

  it('echoes an allowed origin and varies on it', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://ops.example' } })
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://ops.example')
      assert.match(res.headers.get('vary') || '', /origin/i,
        'without Vary: origin a shared cache serves one origin\'s response to another')
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: 'https://ops.example' })
  })

  it('does not echo an origin that is not on the list', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.test' } })
      assert.equal(res.headers.get('access-control-allow-origin'), null,
        'the allow-list has to be a list, not a mirror')
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: 'https://ops.example' })
  })

  it('answers a preflight with the methods and headers the API accepts', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/service-assets`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://ops.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      })
      assert.equal(res.status, 204, 'a preflight is a 204 No Content, not a 200 with a body')
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://ops.example')
      const methods = res.headers.get('access-control-allow-methods') || ''
      for (const verb of ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        assert.match(methods, new RegExp(verb), `preflight must allow ${verb}`)
      }
      const allowed = res.headers.get('access-control-allow-headers') || ''
      assert.match(allowed, /authorization/i,
        'without authorization in the allowed headers a browser client cannot send its token')
      assert.match(allowed, /x-api-key/i)
      assert.equal((await res.text()).length, 0)
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: 'https://ops.example' })
  })

  it('a preflight is answered without a token, because a preflight carries none', async () => {
    // This is not a hole: the preflight is the browser asking *permission to
    // ask*. The actual request is still authenticated, and answering the
    // preflight 401 is what makes a browser client unusable — the browser never
    // sends the credentialed request whose token would have passed.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/service-assets`, {
        method: 'OPTIONS',
        headers: { origin: 'https://ops.example', 'access-control-request-method': 'GET' },
      })
      assert.equal(res.status, 204)
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: 'https://ops.example' })
  })

  it('a preflight from a disallowed origin gets no permission', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/service-assets`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.equal(res.status, 403, 'a refused preflight should say so rather than 204 with no grant')
    }, { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: 'https://ops.example' })
  })

  it('never pairs a wildcard origin with credentials', async () => {
    // `Access-Control-Allow-Origin: *` and `Allow-Credentials: true` together is
    // a combination browsers reject and a misconfiguration that reads as
    // working. The list is explicit for exactly this reason.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://ops.example' } })
      const origin = res.headers.get('access-control-allow-origin')
      const creds = res.headers.get('access-control-allow-credentials')
      assert.ok(!(origin === '*' && creds === 'true'),
        'wildcard origin with credentials is refused by every browser and looks fine in a test')
    }, { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '', LINDELA_LITE_CORS_ORIGINS: '*' })
  })
})
