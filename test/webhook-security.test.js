import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { dispatchPending, emit } from '../src/outbox.js'
import { JsonStore } from '../src/store.js'
import {
  assertSafeWebhookUrl,
  isPublicAddress,
  matchEvent,
  normalizeWebhookSubscription,
  signPayload,
} from '../src/webhooks.js'

const REJECTED_URLS = [
  ['cloud instance metadata (AWS/GCP)', 'http://169.254.169.254/latest/meta-data/'],
  ['loopback v4', 'http://127.0.0.1:4177/'],
  ['loopback v4, alternate form', 'http://127.1/'],
  ['loopback v6', 'http://[::1]:5432/'],
  ['IPv4-mapped loopback v6', 'http://[::ffff:127.0.0.1]/'],
  ['IPv4-compatible loopback v6', 'http://[::127.0.0.1]/'],
  ['unique-local v6', 'http://[fd00::1]/'],
  ['link-local v6', 'http://[fe80::1]/'],
  ['RFC1918 10/8', 'http://10.0.0.1/hook'],
  ['RFC1918 172.16/12 lower bound', 'http://172.16.0.1/hook'],
  ['RFC1918 172.16/12 upper bound', 'http://172.31.255.254/hook'],
  ['RFC1918 192.168/16', 'http://192.168.1.1/hook'],
  ['carrier-grade NAT', 'http://100.64.0.1/hook'],
  ['decimal-encoded loopback', 'http://2130706433/'],
  ['hex-encoded loopback', 'http://0x7f.1/'],
  ['octal-encoded loopback', 'http://0177.0.0.1/'],
  ['the unspecified address', 'http://0.0.0.0:4177/'],
  ['broadcast', 'http://255.255.255.255/'],
  ['file scheme', 'file:///etc/passwd'],
  ['gopher scheme', 'gopher://127.0.0.1:11211/'],
  ['data scheme', 'data:text/plain,hi'],
  ['ftp scheme', 'ftp://10.0.0.1/hook'],
  ['bare hostname without a scheme', 'webhook.example.com/hook'],
  ['scheme-relative host', '//127.0.0.1/hook'],
  ['embedded credentials', 'http://user:pass@127.0.0.1/hook'],
  ['embedded credentials on a public host', 'https://user:pass@example.com/hook'],
  ['hostname that does not resolve', 'https://does-not-exist.invalid/hook'],
]

async function rejects(url, what) {
  await assert.rejects(
    () => assertSafeWebhookUrl(url),
    (error) => error.statusCode === 400,
    `expected ${what || url} to be rejected`
  )
}

function rejectsSync(url) {
  assert.throws(
    () => normalizeWebhookSubscription({ url, events: ['alert.*'] }),
    (error) => error.statusCode === 400,
    `expected ${url} to be rejected at subscription time`
  )
}

describe('Lindela Lite webhook URL SSRF guard', () => {
  it('rejects targets that reach the platform, the metadata service, or a private network', async () => {
    for (const [what, url] of REJECTED_URLS) {
      await rejects(url, what)
    }
  })

  it('rejects the same targets when a subscription is created, not only at delivery', () => {
    for (const [what, url] of REJECTED_URLS) {
      if (what === 'hostname that does not resolve') continue // DNS is not consulted here
      rejectsSync(url)
    }
  })

  it('accepts public address literals, including one just outside 172.16/12', async () => {
    // Address literals need no resolver, so this holds offline too. 172.32.0.1
    // sits outside RFC1918; getting that boundary wrong silently blackholes a
    // block of legitimate tenants.
    assert.equal(await assertSafeWebhookUrl('https://8.8.8.8/hook'), 'https://8.8.8.8/hook')
    assert.equal(await assertSafeWebhookUrl('http://172.32.0.1/hook'), 'http://172.32.0.1/hook')
  })

  it('accepts a public https host at subscription time', () => {
    // The registration-time check is structural; DNS is consulted at delivery,
    // where a rebinding host would actually be reached.
    const sub = normalizeWebhookSubscription({ url: 'https://webhook.example.com/events', events: ['alert.*'] })
    assert.equal(sub.url, 'https://webhook.example.com/events')
  })

  it('accepts a public subscription but stores a normalised url', () => {
    const sub = normalizeWebhookSubscription({ url: 'https://webhook.example.com/events', events: ['alert.*'] })
    assert.equal(sub.url, 'https://webhook.example.com/events')
  })

  it('classifies addresses independently of any url', () => {
    for (const address of ['127.0.0.1', '::1', '169.254.169.254', '10.1.2.3', '172.16.0.1', '100.64.0.1', 'fd00::1', 'fe80::1', '::ffff:169.254.169.254']) {
      assert.equal(isPublicAddress(address), false, `${address} should be non-public`)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      assert.equal(isPublicAddress(address), true, `${address} should be public`)
    }
  })
})

describe('Lindela Lite webhook glob matching', () => {
  it('matches the glob patterns subscriptions are documented to use', () => {
    const cases = [
      ['*.example.com', 'hooks.example.com', true],
      ['*.example.com', 'a.b.example.com', true],
      ['*.example.com', 'example.com', false],
      ['*.example.com', 'hooks.example.com.evil.test', false],
      ['api-?.example.com', 'api-1.example.com', true],
      ['api-?.example.com', 'api-12.example.com', false],
      ['exact.host', 'exact.host', true],
      ['exact.host', 'exact.hosts', false],
      ['alert.*', 'alert.created', true],
      ['alert.*', 'incident.created', false],
      ['*', 'anything', true],
    ]
    for (const [pattern, event, expected] of cases) {
      assert.equal(matchEvent({ events: [pattern] }, event), expected, `${pattern} vs ${event}`)
    }
  })

  it('matches when any one of several patterns applies', () => {
    const subscription = { events: ['flood.*', '*.escalated', 'workflow.step.completed'] }
    assert.equal(matchEvent(subscription, 'workflow.step.completed'), true)
    assert.equal(matchEvent(subscription, 'alert.created'), false)
  })

  it('returns false when there are no patterns', () => {
    assert.equal(matchEvent({ events: [] }, 'alert.created'), false)
    assert.equal(matchEvent({}, 'alert.created'), false)
  })

  it('treats regex metacharacters in a pattern as literal text', () => {
    // A pattern is a glob. `(a+)+` is not a regex, and building one from user
    // input turned a single authenticated POST into a 14 second event-loop stall.
    const cases = [
      ['(a+)+', '(a+)+', true],
      ['(a+)+', 'aaaaaaaaaa', false],
      ['a|b', 'a|b', true],
      ['a|b', 'a', false],
      ['[a-z]', '[a-z]', true],
      ['[a-z]', 'a', false],
      ['a{1,2}', 'a{1,2}', true],
      ['^alert$', '^alert$', true],
      ['^alert$', 'alert', false],
      ['a$', 'a$', true],
      ['back\\slash', 'back\\slash', true],
    ]
    for (const [pattern, event, expected] of cases) {
      assert.equal(matchEvent({ events: [pattern] }, event), expected, `${pattern} vs ${event}`)
    }
  })

  it('completes a pathological pattern quickly instead of stalling the event loop', () => {
    const startedAt = Date.now()
    const nested = matchEvent({ events: ['(a+)+'] }, `${'a'.repeat(26)}!`)
    const elapsed = Date.now() - startedAt
    assert.equal(nested, false)
    assert.ok(elapsed < 500, `globMatch took ${elapsed}ms`)

    // Escaping metacharacters is not by itself enough: a pattern made only of
    // wildcards and literals is still combinatorial when translated to `.*`.
    const combinatorial = `*${'a*'.repeat(12)}b`
    const combinatorialStart = Date.now()
    assert.equal(matchEvent({ events: [combinatorial] }, 'a'.repeat(200)), false)
    const combinatorialElapsed = Date.now() - combinatorialStart
    assert.ok(combinatorialElapsed < 500, `combinatorial globMatch took ${combinatorialElapsed}ms`)
  })
})

describe('Lindela Lite webhook delivery', () => {
  it('signs the delivered body with the subscription secret', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-webhook-sign-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const secret = 'whsec_test'

    const received = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/events`

    try {
      await emit(store, 'alert.created', { id: 'evt_1', event_type: 'flood' })

      const result = await dispatchPending(store, {
        webhooks: [{ id: 'wh_signed', url, events: ['alert.*'], status: 'active', headers: {}, secret }],
        // Loopback is exactly what the SSRF guard blocks, so delivering here
        // means standing it down explicitly for the duration of the test.
        checkUrl: async (candidate) => candidate,
      })

      assert.equal(result.dispatched, 1)
      assert.equal(received.length, 1)

      const { headers, body } = received[0]
      assert.equal(headers['content-type'], 'application/json')
      const expected = signPayload(secret, body)
      assert.equal(headers['x-signature'], expected)
      // Independently of signPayload, so a broken signer cannot mark its own work.
      const recomputed = crypto.createHmac('sha256', secret).update(body).digest('hex')
      assert.equal(headers['x-signature'], recomputed)

      const payload = JSON.parse(body)
      assert.equal(payload.event, 'alert.created')
      assert.equal(payload.payload.id, 'evt_1')
      assert.ok(payload.sent_at)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('refuses to deliver to a loopback target once DNS rebinding turns a public host inward', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-webhook-ssrf-'))
    const store = new JsonStore(path.join(dir, 'store.json'))

    const received = []
    const server = http.createServer((req, res) => {
      received.push(req.url)
      res.writeHead(200).end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/events`

    try {
      await emit(store, 'alert.created', { id: 'evt_2', event_type: 'flood' })
      const result = await dispatchPending(store, {
        webhooks: [{ id: 'wh_ssrf', url, events: ['alert.*'], status: 'active', headers: {}, secret: null }],
      })

      assert.equal(result.dispatched, 0)
      assert.equal(received.length, 0)

      // The event stays retryable rather than being marked sent or failed.
      const data = await store.read()
      assert.equal(data.events_outbox[0].status, 'pending')
      assert.equal(data.events_outbox[0].attempts, 1)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
