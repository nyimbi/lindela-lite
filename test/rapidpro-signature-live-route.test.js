import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * Signature verification against the real route.
 *
 * A unit test of verifyRapidProWebhook() passes whether or not the route can
 * ever supply the bytes it needs to verify. It cannot: the body stream is
 * consumed once, and verification used to run before anything read it. So the
 * HMAC path was green in tests and dead in production — every signed request
 * failed closed.
 *
 * These go through the actual HTTP server.
 */

const SECRET = 'rapidpro-shared-secret-0123456789'
const ENV_KEYS = ['RAPIDPRO_WEBHOOK_SECRET', 'LINDELA_LITE_TOKENS', 'LINDELA_LITE_API_KEY', 'LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED']
const saved = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex')
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-rp-live-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const server = createServer({ store })
  const listener = server.listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function fieldReportBody() {
  return JSON.stringify({
    contact: { name: 'CHW Amina', phone: '+254700111222' },
    message: 'Flood water has reached the bridge at Lokichar.',
    location: { latitude: 3.1, longitude: 35.6, district: 'Turkana' },
    reported_at: '2026-10-02T08:00:00.000Z',
  })
}

describe('RapidPro webhook signature on the live route', () => {
  it('accepts an HMAC-signed request', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    const body = fieldReportBody()
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rapidpro-signature': sign(body) },
        body,
      })
      assert.equal(res.status, 201, `signed request rejected: ${res.status} ${await res.text()}`)
    })
  })

  it('accepts the sha256= prefixed form', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    const body = fieldReportBody()
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rapidpro-signature': `sha256=${sign(body)}` },
        body,
      })
      assert.equal(res.status, 201)
    })
  })

  it('rejects a signature computed over different bytes', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    await withServer(async (base, store) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Signed the original body, sent a tampered one.
          'x-rapidpro-signature': sign(fieldReportBody()),
        },
        body: JSON.stringify({ message: 'tampered', reported_at: '2026-10-02T08:00:00.000Z' }),
      })
      assert.equal(res.status, 401)
      assert.equal((await store.read()).rapidpro_inbound_messages.length, 0, 'a tampered request was stored')
    })
  })

  it('rejects a request with no signature at all', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    await withServer(async (base, store) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: fieldReportBody(),
      })
      assert.equal(res.status, 401)
      assert.equal((await store.read()).rapidpro_inbound_messages.length, 0)
    })
  })

  it('still accepts the shared-secret header form', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rapidpro-secret': SECRET },
        body: fieldReportBody(),
      })
      assert.equal(res.status, 201)
    })
  })

  it('does not let an invalid signature fall back to a valid shared secret', async () => {
    process.env.RAPIDPRO_WEBHOOK_SECRET = SECRET
    await withServer(async (base, store) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidpro-secret': SECRET,
          'x-rapidpro-signature': 'deadbeef'.repeat(8),
        },
        body: fieldReportBody(),
      })
      assert.equal(res.status, 401, 'a present-but-wrong signature must not fall through to the secret check')
      assert.equal((await store.read()).rapidpro_inbound_messages.length, 0)
    })
  })

  it('refuses the route outright when no secret is configured', async () => {
    delete process.env.RAPIDPRO_WEBHOOK_SECRET
    await withServer(async (base, store) => {
      const res = await fetch(`${base}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: fieldReportBody(),
      })
      assert.equal(res.status, 503, 'an unconfigured secret must not read as "no check needed"')
      assert.equal((await store.read()).rapidpro_inbound_messages.length, 0)
    })
  })
})