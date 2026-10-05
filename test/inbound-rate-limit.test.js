import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { createInboundLimiter, inboundClassFor, clientKeyFor, INBOUND_POLICIES } from '../src/inbound-rate-limit.js'

/**
 * R-09 — nothing counted what came in.
 *
 * `src/rate-limit.js` limits *outbound* connector calls and had exactly one
 * importer. There was no 429 anywhere in the server, no notion of a caller, and
 * nothing that made an expensive request cost anything to make. So one upload
 * can saturate the store, `/ingest/run` can be started repeatedly against ~46
 * countries and two real third-party services, and a token guess costs the same
 * as a legitimate call.
 *
 * The budget numbers are the interesting part of this file. A limiter that
 * refuses a field worker draining a week of queued reports has replaced one
 * outage with another, so the tests below assert that the *legitimate* shapes
 * pass: a console polling, a health worker draining, and a health probe.
 */

/** A controllable clock, so the tests do not spend wall-clock proving a rate. */
function fakeClock(startMs = 1_000_000) {
  let current = startMs
  const pending = []
  return {
    now: () => current,
    sleep: (ms) => new Promise((resolve) => pending.push(() => { current += ms; resolve() })),
    advance(ms) { current += ms; for (const tick of pending.splice(0)) tick() },
  }
}

async function withServer(fn, { limiterOptions, env = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r09-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const listener = createServer({
    store,
    inboundLimiter: createInboundLimiter(limiterOptions || { now: Date.now, sleep: () => new Promise(() => {}) }),
  }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('R-09 — a request over budget gets 429 and an honest Retry-After', () => {
  it('refuses the request after the budget and says when to come back', async () => {
    const clock = fakeClock()
    await withServer(async (base) => {
      const call = () => fetch(`${base}/api/v1/incidents?limit=1`)
      let refused = null
      for (let i = 0; i < INBOUND_POLICIES.read.ratePerWindow + 2; i += 1) {
        const res = await call()
        if (res.status === 429) { refused = res; break }
        assert.equal(res.status, 200, `request ${i} should have been inside the read budget`)
      }
      assert.ok(refused, 'the read budget was never reached, so nothing was limited')
      const retryAfter = Number(refused.headers.get('retry-after'))
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0,
        `Retry-After is "${refused.headers.get('retry-after')}"; a 429 without one ` +
        'tells the caller to guess, and a client that guesses is a client that floods')
      const body = await refused.json()
      assert.equal(body.success, false)
      assert.equal(body.class, 'read')
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('a health probe is never the thing that gets refused', async () => {
    // A load balancer polling /health through a spent budget is an outage
    // reported as a slow response, and the retry logic that would normally mask
    // it takes the instance out of rotation.
    const clock = fakeClock()
    await withServer(async (base) => {
      for (let i = 0; i < INBOUND_POLICIES.read.ratePerWindow + 5; i += 1) {
        await fetch(`${base}/api/v1/incidents?limit=1`)
      }
      for (const path of ['/api/v1/health', '/api/v1/ready']) {
        const res = await fetch(`${base}${path}`)
        assert.notEqual(res.status, 429, `${path} was rate limited`)
      }
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('a field worker draining a queued week of reports is inside the write budget', async () => {
    // The failure this has to avoid: ENH-02's exactly-once queue drains in a
    // burst when signal returns, on a phone that was offline for days. A write
    // budget of 6/minute would reject that worker and re-queue their reports.
    const clock = fakeClock()
    await withServer(async (base) => {
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`${base}/api/v1/incidents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: `drain-${i}`,
            type: 'incident',
            title: `Queued report ${i}`,
            description: 'filed offline, delivered on reconnect',
            severity: 'low',
            status: 'open',
          }),
        })
        assert.notEqual(res.status, 429,
          `report ${i} of a 20-report drain was refused; the queue exists to deliver exactly this`)
      }
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('repeated ingestion runs from one caller are refused, not queued', async () => {
    // Asserted on the budget rather than on an instantaneous race: whether a
    // second request is refused for the concurrency slot or for the token
    // depends on how fast the first finished, which is exactly the kind of
    // timing assertion that passes in one run and fails in another. The budget
    // is six a minute; eight in a row cannot all be admitted.
    await withServer(async (base) => {
      const statuses = []
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`${base}/api/v1/ingest/run-due`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        statuses.push(res.status)
      }
      const refused = statuses.filter((s) => s === 429)
      assert.ok(refused.length > 0,
        `eight ingestion runs were all admitted (${statuses.join(',')}); each is ~92 upstream requests ` +
        'against a provider that will rate-limit us long before we rate-limit ourselves')
      assert.equal(statuses[0] === 429, false, 'the first call should be inside the budget')
    }, { limiterOptions: { now: Date.now, sleep: () => new Promise(() => {}) } })
  })
})

describe('R-09 — the budget follows the shape of the request', () => {
  it('walking every surface is not a flood', async () => {
    // The browser gate's own shape, which is also an operator's: open the
    // console, the CHW app and the donor dashboard, click through the rail tabs,
    // and do it again after a deploy. Every one of those is a document and a few
    // assets, and none of them reads the store.
    const clock = fakeClock()
    await withServer(async (base) => {
      const statuses = []
      for (let round = 0; round < 4; round += 1) {
        for (const surface of ['/', '/chw/', '/portal/', '/co/', '/districts/', '/focal-point/', '/parametric/', '/scenarios/']) {
          statuses.push((await fetch(`${base}${surface}`)).status)
        }
      }
      assert.deepEqual(statuses.filter((s) => s === 429), [],
        'a supervisor opening every screen was refused, which is the shape of use the ' +
        'budget was supposed to allow')
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('a page load of thirty assets is not a flood', async () => {
    // Found by the browser gate, not by reasoning: seven surfaces × ~25 assets
    // is ~175 GETs in a couple of minutes from one address, which is over any
    // sane per-minute read budget. Every surface after the first came up partly
    // unstyled — a limiter that refuses pages is not protecting the store, it is
    // breaking the product.
    const clock = fakeClock()
    await withServer(async (base) => {
      const assets = [
        '/shared/runtime.js', '/shared/fmt.js', '/shared/navbar.js', '/shared/states.js',
        '/icon.svg', '/favicon.ico', '/i18n/en.json', '/workflow/panel.css',
        '/panels/equity.html', '/panels/outcome.html',
      ]
      const statuses = []
      for (let round = 0; round < 8; round += 1) {
        for (const asset of assets) {
          const res = await fetch(`${base}${asset}`)
          statuses.push(res.status)
        }
      }
      const refused = statuses.filter((s) => s === 429)
      assert.equal(refused.length, 0,
        `${refused.length} of ${statuses.length} asset requests were refused; a browser ` +
        'cannot cache its way out of this on a cold load, and the store is not what the ' +
        'budget was protecting')
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('four consoles polling at once fit inside the read budget', async () => {
    // The gate found this twice, and the number moved for a measured reason
    // rather than a comfortable one: a read was 110 ms when the budget was set
    // and is 14 ms now that `read()` takes a collection manifest. Four consoles
    // at 12 endpoints per 30 s is a supervisor, not a flood, and a supervisor
    // who gets 429s stops using the console.
    const clock = fakeClock()
    await withServer(async (base) => {
      for (let tick = 0; tick < 4; tick += 1) {
        for (let endpoint = 0; endpoint < 12; endpoint += 1) {
          const res = await fetch(`${base}/api/v1/incidents?limit=1&e=${endpoint}&t=${tick}`)
          assert.notEqual(res.status, 429,
            `endpoint ${endpoint} of tick ${tick} was refused; the console polls twelve ` +
            'every thirty seconds and four of them is a supervisor')
        }
      }
      // And the loop is still refused: 300 a minute is a budget, not a blanket.
      let refused = 0
      for (let i = 0; i < INBOUND_POLICIES.read.ratePerWindow + 20; i += 1) {
        if ((await fetch(`${base}/api/v1/incidents?limit=1`)).status === 429) refused += 1
      }
      assert.ok(refused > 0, 'the read budget no longer refuses anything at all')
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('the API keeps its budget even when the assets are free', async () => {
    // The point of the exemption is the assets, not the API. A caller that polls
    // the API in a loop is still a caller in a loop.
    const clock = fakeClock()
    await withServer(async (base) => {
      let refused = 0
      for (let i = 0; i < INBOUND_POLICIES.read.ratePerWindow + 10; i += 1) {
        const res = await fetch(`${base}/api/v1/incidents?limit=1`)
        if (res.status === 429) refused += 1
      }
      assert.ok(refused > 0, 'the API read budget no longer refuses anything')
    }, { limiterOptions: { now: clock.now, sleep: clock.sleep } })
  })

  it('classifies by method and by enumerated path, not by prefix', () => {
    assert.equal(inboundClassFor('GET', '/api/v1/incidents'), 'read')
    assert.equal(inboundClassFor('POST', '/api/v1/incidents'), 'write')
    assert.equal(inboundClassFor('POST', '/api/v1/ingest/run'), 'heavy')
    assert.equal(inboundClassFor('POST', '/api/v1/ingest/run-due'), 'heavy')
    // The reason the heavy paths are a list and not a prefix: a prefix rule puts
    // /ingest/sources — a cheap read — on the one-per-minute budget, and the
    // console starts seeing 429s on a page load.
    assert.equal(inboundClassFor('GET', '/api/v1/ingest/sources'), 'read')
    assert.equal(inboundClassFor('GET', '/api/v1/health'), null)
    assert.equal(inboundClassFor('GET', '/metrics'), null)
    // A document and an asset are both a file read from disk, so neither is a
    // read of the data. Found by the browser gate the second time: it walks seven
    // surfaces plus their assets, and the surface documents alone went over the
    // per-minute budget.
    assert.equal(inboundClassFor('GET', '/shared/runtime.js'), null)
    assert.equal(inboundClassFor('GET', '/icon.svg'), null)
    assert.equal(inboundClassFor('GET', '/panels/outcome.html'), null)
    assert.equal(inboundClassFor('GET', '/chw/'), null)
    assert.equal(inboundClassFor('GET', '/'), null)
    // And the exception that proves the rule is about the store rather than the
    // path: the spatial catalogues look static and are not — both read the store
    // and render collections.
    assert.equal(inboundClassFor('GET', '/stac/catalog.json'), 'read')
    assert.equal(inboundClassFor('GET', '/ogc/collections/service-assets/items'), 'read')
    assert.equal(inboundClassFor('POST', '/api/v1/incidents'), 'write')
    assert.equal(inboundClassFor('POST', '/shared/upload-target.js'), 'write',
      'a write is a write whatever it fetches — a POST that downloads a file still ' +
      'spends the caller\'s budget against us')
  })

  it('a spoofed forwarding header is ignored unless a proxy is trusted', () => {
    const spoofed = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '10.0.0.1' } }
    assert.equal(clientKeyFor(spoofed, { trustProxy: false }).key, 'addr:10.0.0.1',
      'an untrusted header must not choose the bucket, or a caller picks its own budget')
  })

  it('a trusted proxy contributes the hop it observed, not the one a client wrote', () => {
    // "1.2.3.4, 5.6.7.8" is a client prepending its own entry. A proxy that
    // appends what it saw puts its observation last, so the last hop is the one
    // the client cannot forge — which means a spoof can widen a caller's own
    // budget and never narrow someone else's.
    const chained = { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } }
    assert.equal(clientKeyFor(chained, { trustProxy: true }).key, 'xf:203.0.113.9')
  })

  it('the client map is bounded, because an unbounded map is a leak with a 429 in front of it', () => {
    const limiter = createInboundLimiter({ maxClients: 10, now: Date.now, sleep: () => new Promise(() => {}) })
    for (let i = 0; i < 50; i += 1) {
      limiter.charge(
        { method: 'GET', headers: { 'x-forwarded-for': `10.0.0.${i}` }, socket: {} },
        new URL('http://x/api/v1/incidents'),
      )
    }
    assert.ok(limiter.clients() <= 10, `the registry holds ${limiter.clients()} clients; a client-supplied key space is an exhaustion vector`)
  })

  it('a released slot is available again', async () => {
    const clock = fakeClock()
    // Rate tokens and concurrency slots are different budgets, and the test is
    // about the slot: ten tokens in the window, one at a time, so the only thing
    // that can block the second request is the request still being in flight.
    const limiter = createInboundLimiter({ policies: { read: { ratePerWindow: 10, windowMs: 60_000, concurrency: 1 } }, now: clock.now, sleep: clock.sleep })
    const url = new URL('http://x/api/v1/incidents')
    const req = { method: 'GET', headers: {}, socket: { remoteAddress: '10.0.0.9' } }
    const first = limiter.charge(req, url)
    assert.equal(first.allowed, true)
    const second = limiter.charge(req, url)
    assert.equal(second.allowed, false, 'the slot is held while the request is in flight')
    first.release()
    const third = limiter.charge(req, url)
    assert.equal(third.allowed, true, 'releasing the slot is what returns the budget')
  })
})
