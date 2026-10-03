import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { sendRapidProAlert, verifyRapidProWebhook } from '../src/rapidpro.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const SECRET = 'rapidpro-webhook-secret'
const PAYLOAD = JSON.stringify({ id: 'inbound-1', from: '+254700000001', content: 'REPORT incident_abc123 1,2' })
const SIGNED_PAYLOAD = JSON.stringify({ id: 'inbound-2', from: '+254700000002', content: 'REPORT incident_def456 needs: water 3,4' })

function sign(body, secret = SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Stands in for src/server.js's field-report route: guard first, then parse.
 * The raw body is buffered onto req.rawBody before the guard runs, which is
 * what the HMAC path needs in order to recompute a digest over the exact bytes
 * that arrived.
 */
function startWebhookServer() {
  const state = { env: {} }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    req.rawBody = Buffer.concat(chunks).toString('utf8')

    let verified
    try {
      verified = verifyRapidProWebhook(req, url, state.env)
    } catch (error) {
      json(res, error.statusCode || 500, { success: false, error: error.message })
      return
    }
    if (!verified) {
      json(res, 401, { success: false, error: 'Invalid RapidPro webhook secret' })
      return
    }
    json(res, 201, { success: true, data: { id: JSON.parse(req.rawBody || '{}').id || null } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const sockets = new Set()
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
          for (const socket of sockets) socket.destroy()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

describe('rapidpro field-report webhook auth', () => {
  let webhook

  before(async () => {
    webhook = await startWebhookServer()
  })

  after(async () => {
    await webhook.close()
  })

  async function post(path, body, headers = {}) {
    const response = await fetch(`${webhook.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
    return { status: response.status, body: await response.json() }
  }

  it('rejects an unconfigured secret instead of trusting every caller', async () => {
    webhook.state.env = {}
    const res = await post('/api/v1/rapidpro/field-report', PAYLOAD, { 'x-rapidpro-secret': 'anything' })
    assert.equal(res.status, 503)
    assert.match(res.body.error, /RAPIDPRO_WEBHOOK_SECRET is not configured/)
    assert.match(res.body.error, /LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED=1/)
  })

  it('accepts unsigned webhooks only when the opt-in is written down', async () => {
    webhook.state.env = { LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED: '1' }
    const res = await post('/api/v1/rapidpro/field-report', PAYLOAD)
    assert.equal(res.status, 201)
    assert.equal(res.body.data.id, 'inbound-1')
  })

  it('ignores an opt-in that is merely truthy', async () => {
    webhook.state.env = { LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED: 'true' }
    const res = await post('/api/v1/rapidpro/field-report', PAYLOAD)
    assert.equal(res.status, 503)
  })

  it('accepts a body signed with the configured secret', async () => {
    webhook.state.env = { RAPIDPRO_WEBHOOK_SECRET: SECRET }
    const res = await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, { 'x-rapidpro-signature': sign(SIGNED_PAYLOAD) })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.id, 'inbound-2')
  })

  it('rejects a signature made with the wrong secret', async () => {
    webhook.state.env = { RAPIDPRO_WEBHOOK_SECRET: SECRET }
    const res = await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, {
      'x-rapidpro-signature': sign(SIGNED_PAYLOAD, 'not-the-secret'),
    })
    assert.equal(res.status, 401)
  })

  it('rejects a tampered body, which is what the signature is for', async () => {
    webhook.state.env = { RAPIDPRO_WEBHOOK_SECRET: SECRET }
    const tampered = SIGNED_PAYLOAD.replace('needs: water', 'needs: nothing')
    assert.notEqual(tampered, SIGNED_PAYLOAD)
    const res = await post('/api/v1/rapidpro/field-report', tampered, { 'x-rapidpro-signature': sign(SIGNED_PAYLOAD) })
    assert.equal(res.status, 401)
  })

  it('rejects a missing or malformed signature header', async () => {
    webhook.state.env = { RAPIDPRO_WEBHOOK_SECRET: SECRET }
    assert.equal((await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD)).status, 401)
    assert.equal((await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, { 'x-rapidpro-signature': '' })).status, 401)
    assert.equal((await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, { 'x-rapidpro-signature': 'not-hex' })).status, 401)
    // Right length, wrong alphabet, and a digest of the right length for a
    // different algorithm all have to fail the same way.
    assert.equal((await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, { 'x-rapidpro-signature': 'z'.repeat(64) })).status, 401)
    assert.equal((await post('/api/v1/rapidpro/field-report', SIGNED_PAYLOAD, { 'x-rapidpro-signature': sign(SIGNED_PAYLOAD).slice(0, 32) })).status, 401)
  })

  it('still accepts the shared secret headers RapidPro sends', async () => {
    webhook.state.env = { RAPIDPRO_WEBHOOK_SECRET: SECRET }
    assert.equal((await post('/api/v1/rapidpro/field-report', PAYLOAD, { 'x-rapidpro-secret': SECRET })).status, 201)
    assert.equal((await post('/api/v1/rapidpro/field-report', PAYLOAD, { 'x-lindela-rapidpro-secret': SECRET })).status, 201)
    assert.equal((await post('/api/v1/rapidpro/field-report', PAYLOAD, { authorization: `Bearer ${SECRET}` })).status, 201)
    assert.equal((await post(`/api/v1/rapidpro/field-report?secret=${SECRET}`, PAYLOAD)).status, 201)
    assert.equal((await post(`/api/v1/rapidpro/field-report?secret=wrong`, PAYLOAD)).status, 401)
  })
})

describe('the real field-report route', () => {
  it('refuses to record a field report when no secret is configured', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-rapidpro-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const baseUrl = `http://127.0.0.1:${listener.address().port}`
    const previousSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
    const previousOptOut = process.env.LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED
    delete process.env.RAPIDPRO_WEBHOOK_SECRET
    delete process.env.LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED

    try {
      const res = await fetch(`${baseUrl}/api/v1/rapidpro/field-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'unsigned-1', from: '+254700000009', content: 'REPORT incident_0001 1,1' }),
      })
      // 503, not 200 and not 401: this is a deployment that is not configured,
      // which is a different problem from a caller that failed to authenticate.
      assert.equal(res.status, 503)
      const data = await (await store.read()).field_reports
      assert.deepEqual(data, [])
    } finally {
      if (previousSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
      else process.env.RAPIDPRO_WEBHOOK_SECRET = previousSecret
      if (previousOptOut === undefined) delete process.env.LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED
      else process.env.LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED = previousOptOut
      await new Promise((resolve) => listener.close(resolve))
    }
  })
})

describe('rapidpro outbound dispatch', () => {
  let stalling
  let sockets

  before(async () => {
    sockets = new Set()
    stalling = http.createServer(() => {})
    stalling.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => stalling.close(resolve))
  })

  it('gives up on a stalled RapidPro instead of hanging the caller', async () => {
    const env = {
      RAPIDPRO_API_TOKEN: 'rapidpro-token',
      RAPIDPRO_BASE_URL: `http://127.0.0.1:${stalling.address().port}`,
      RAPIDPRO_REQUEST_TIMEOUT_MS: '250',
    }
    const startedAt = Date.now()
    const dispatch = await sendRapidProAlert(
      { id: 'alert-1', rule_name: 'Flood watch', message: 'river rising', metric: 'flood.risk', operator: '>', threshold: 0.5 },
      { groups: ['flood-watch'] },
      env,
    )
    const elapsed = Date.now() - startedAt
    assert.equal(dispatch.status, 'failed')
    assert.match(dispatch.error, /timed out after 250ms/)
    assert.ok(elapsed < 5000, `dispatch should give up quickly, took ${elapsed}ms`)
    assert.equal(dispatch.sent_at, null)
  })
})
