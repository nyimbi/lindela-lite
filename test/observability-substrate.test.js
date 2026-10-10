#!/usr/bin/env node
/**
 * The observability substrate: a request you can follow, a health check that
 * can tell "not yet" from "never", and three values that were computed for
 * nobody.
 *
 * ENH-64/OBS-03  no correlation id joined a response to its log lines. A 500
 *                handed the client an `incident_id` that appeared on no log
 *                line at all, because it was minted inside the error branch.
 * OBS-04         `/health` reported `starting`/200 forever for a process whose
 *                periodic driver never completed a cycle, and Dockerfile polls
 *                exactly that endpoint.
 * OBS-05         `metricsOverflow()`, `uptimeStats()` and `piiSaltStatus()` had
 *                no production caller.
 * OBS-06         four `console.error` sites bypassed the logger, so they
 *                produced unstructured lines no log pipeline could parse.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer, sanitizeRequestId } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { currentRequestId, logger, metrics, metricsOverflow, resetMetrics, runWithRequestId, uptimeStats } from '../src/observability.js'
import { piiSaltStatus } from '../src/pii.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function withServer(fn, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-obs-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const listener = createServer({ store, ...options }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base, store)
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Capture every line the logger writes while `fn` runs. */
async function captureLogs(fn) {
  const lines = []
  const original = console.error
  console.error = (line) => { lines.push(line) }
  try {
    const value = await fn()
    return { value, lines }
  } finally {
    console.error = original
  }
}

const parseLogs = (lines) => lines.map((line) => {
  try { return JSON.parse(line) } catch { return { unparsed: line } }
})

describe('ENH-64 a request carries one id from the response to every log line', () => {
  it('mints an id and returns it on the response', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`)
      const header = res.headers.get('x-request-id')
      assert.ok(header, 'no x-request-id header on the response')
      assert.match(header, /^[0-9a-f-]{36}$/)
    })
  })

  it('keeps a caller-supplied id, because the join is the whole point', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'upstream-abc.123' } })
      assert.equal(res.headers.get('x-request-id'), 'upstream-abc.123')
    })
  })

  it('replaces a malformed id rather than echoing it', async () => {
    // Sent over a raw socket: `fetch` and `http.request` both refuse to emit an
    // invalid header value, so a test that goes through either can never reach
    // the code under test. A newline in a response header is a
    // response-splitting primitive, and in a log line a log-injection one.
    await withServer(async (base) => {
      const { port } = new URL(base)
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), 'localhost', () => {
          socket.write('GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nx-request-id: bad id\r\nConnection: close\r\n\r\n')
        })
        let data = ''
        socket.on('data', (chunk) => { data += chunk })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      const header = /^x-request-id: (.*)$/im.exec(raw)
      assert.ok(header, `no x-request-id in the raw response: ${raw.slice(0, 200)}`)
      assert.notEqual(header[1].trim(), 'bad id')
      assert.match(header[1].trim(), /^[0-9a-f-]{36}$/)
    })
  })

  it('writes the same request_id on every line the request produces', async () => {
    await withServer(async (base) => {
      const { lines } = await captureLogs(async () => {
        await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'correlate-me' } })
      })
      const entries = parseLogs(lines).filter((entry) => entry.request_id)
      assert.ok(entries.length >= 1, `no log line carried a request_id: ${lines.join(' | ')}`)
      for (const entry of entries) assert.equal(entry.request_id, 'correlate-me')
    })
  })

  it('hands the client the same incident_id the log line carries', async () => {
    // The bug: `incident_id` was minted inside the 500 branch, so it appeared
    // on no log line. "Here is the id we showed you, find the request" had no
    // answer.
    //
    // A store whose read throws is the deterministic 500: every route reaches
    // it, and none of them can turn a broken store into a 4xx.
    const listener = createServer({
      store: { mode: 'failing', read: async () => { throw new Error('store exploded') }, write: async () => {} },
    }).listen(0)
    const base = `http://localhost:${listener.address().port}`
    try {
      const { value, lines } = await captureLogs(() => fetch(`${base}/api/v1/hazards`, { headers: { 'x-request-id': 'correlated-1' } }))
      const res = value
      assert.equal(res.status, 500)
      const body = await res.json()
      const failure = parseLogs(lines).find((entry) => entry.event === 'request_failed')
      assert.ok(failure, `no request_failed line: ${lines.join(' | ')}`)
      assert.equal(body.incident_id, 'correlated-1')
      assert.equal(failure.incident_id, body.incident_id)
      assert.equal(failure.request_id, body.incident_id)
    } finally {
      listener.close()
    }
  })

  it('omits request_id entirely outside a request', () => {
    // A startup line has no request to correlate with; `request_id: null` would
    // read as "this request had no id".
    assert.equal(currentRequestId(), null)
  })

  it('scopes the id to the async work underneath it', async () => {
    const seen = await runWithRequestId('scoped-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return currentRequestId()
    })
    assert.equal(seen, 'scoped-1')
    assert.equal(currentRequestId(), null, 'the scope leaked past its own call')
  })
})

describe('ENH-64 sanitizeRequestId refuses what must not reach a header', () => {
  it('accepts the shape a gateway sends', () => {
    assert.equal(sanitizeRequestId('abc-123_DEF.456:789'), 'abc-123_DEF.456:789')
  })

  it('refuses newlines, spaces, empty and non-strings', () => {
    assert.equal(sanitizeRequestId('a\nb'), null)
    assert.equal(sanitizeRequestId('a b'), null)
    assert.equal(sanitizeRequestId(''), null)
    assert.equal(sanitizeRequestId('   '), null)
    assert.equal(sanitizeRequestId(undefined), null)
    assert.equal(sanitizeRequestId(['a']), null)
  })

  it('refuses one long enough to be a payload', () => {
    assert.equal(sanitizeRequestId('a'.repeat(129)), null)
    assert.equal(sanitizeRequestId('a'.repeat(128)), 'a'.repeat(128))
  })
})

describe('OBS-04 health distinguishes a pipeline that has not started from one that stopped', () => {
  it('is starting, and 200, inside the grace period', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`)
      const body = await res.json()
      assert.equal(res.status, 200)
      assert.equal(body.status, 'starting')
      assert.equal(body.pipeline.never_started, false)
    })
  })

  it('is never_started, and 503, once two intervals have passed with no heartbeat', async () => {
    // The server is told it began three hours ago. Two 900s intervals is 1800s.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`)
      const body = await res.json()
      assert.equal(body.pipeline.never_started, true, 'a server past its grace with no heartbeat must say so')
      assert.equal(res.status, 503)
      assert.equal(body.status, 'degraded')
      assert.match(body.pipeline.note, /No heartbeat has been recorded in \d+s of uptime/)
    }, { startedAt: Date.now() - 3 * 60 * 60 * 1000 })
  })

  it('reports its own uptime, not the process uptime', async () => {
    // The server is told it began three hours ago; the process began seconds
    // ago. Reporting process uptime here would leave every instance sharing one
    // clock and the grace period untestable.
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/health`)).json()
      assert.ok(
        body.pipeline.process_uptime_seconds >= 3 * 60 * 60,
        `uptime ${body.pipeline.process_uptime_seconds}s looks like process uptime, not the injected server start`,
      )
    }, { startedAt: Date.now() - 3 * 60 * 60 * 1000 })
  })
})

describe('OBS-05 the values that had no reader are on the endpoint an operator polls', () => {
  it('surfaces metric overflow, uptime and the pii salt state', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/ready`)).json()
      assert.equal(typeof body.metrics.droppedKeys, 'number')
      assert.equal(typeof body.metrics.bucketedValues, 'number')
      assert.equal(typeof body.metrics.evictedSeries, 'number')
      assert.equal(typeof body.uptime.uptime_seconds, 'number')
      assert.match(body.uptime.started_at, /^\d{4}-\d{2}-\d{2}T/)
      assert.ok(['configured', 'generated'].includes(body.pii.source))
      assert.equal(typeof body.pii.digestBits, 'number')
      // Never the salt itself.
      assert.equal(body.pii.salt, undefined)
    })
  })

  it('reports a nonzero overflow once a bound has actually refused something', async () => {
    resetMetrics()
    // An unknown label key on an allowlisted metric is dropped and counted.
    metrics.counter('http_requests_total', { method: 'GET', route: '/x', status: '200', bogus: 'y' })
    assert.equal(metricsOverflow().droppedKeys, 1)
    resetMetrics()
  })

  it('reports the process uptime as a number of seconds', () => {
    const stats = uptimeStats()
    assert.ok(Number.isInteger(stats.uptime_seconds))
    assert.ok(stats.uptime_seconds >= 0)
  })

  it('describes the salt without echoing it', () => {
    const status = piiSaltStatus()
    assert.ok(['configured', 'generated'].includes(status.source))
    assert.equal(status.saltId.length, 8)
  })
})

describe('OBS-07 the KPI cache drops what has expired before evicting what has not', () => {
  const empty = {
    field_reports: [], alert_events: [], hazard_events: [],
    interventions: [], workflow_instances: [], report_templates: [], rapidpro_dispatches: [],
  }
  const dataFor = (n) => ({
    ...empty,
    field_reports: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, created_at: '2026-08-01T00:00:00.000Z' })),
  })

  it('serves a live entry from the cache rather than recomputing', async () => {
    const { computeQuarterlyKpi } = await import('../src/kpi.js')
    const data = dataFor(3)
    const first = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    const second = computeQuarterlyKpi(data, { quarter: 'Q3', year: 2026 })
    assert.equal(first, second, 'the same call was recomputed, so nothing is cached at all')
  })

  it('does not let dead entries accumulate in the cache', async () => {
    // 40 distinct keys against a 32-slot cache. Without the sweep the map sits
    // at the cap holding entries that expired hours ago; with it, the size
    // tracks live entries. The clock is injected so the test does not have to
    // wait out a five-minute TTL.
    const { computeQuarterlyKpi, kpiCacheStats } = await import('../src/kpi.js')
    const now = Date.now()
    for (let i = 0; i < 40; i += 1) {
      computeQuarterlyKpi(dataFor(i + 1), { quarter: 'Q3', year: 2026, now: now - 10 * 60 * 1000 })
    }
    const expired = kpiCacheStats()
    assert.ok(expired.size > 0, 'nothing was cached, so this test proves nothing')
    assert.ok(expired.live <= expired.max, `the cache holds ${expired.live} live entries, over its own cap of ${expired.max}`)

    // One call at the current time sweeps every dead entry.
    computeQuarterlyKpi(dataFor(99), { quarter: 'Q3', year: 2026, now })
    const swept = kpiCacheStats()
    assert.equal(swept.expired, 0, `${swept.expired} expired entries survived a sweep`)
    assert.equal(swept.size, 1, `the sweep left ${swept.size} entries behind`)
  })
})

describe('OBS-06 the server logs through the logger, not around it', () => {
  it('has no console.error left in src/server.js', () => {
    // Four sites — the periodic item failure, the heartbeat write, the outbox
    // emit and the driver start — wrote bare strings. They reached stderr, so
    // nothing was lost, and they carried no `event`, no `level` and no `ts`, so
    // a structured-log pipeline could not read them.
    const source = fsSync.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8')
    const hits = source.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /console\.error\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
    assert.deepEqual(hits.map((h) => `${h.n}: ${h.line.trim()}`), [])
  })

  it('writes a structured line, which is what the logger is for', async () => {
    const { lines } = await captureLogs(() => {
      logger.error('test_event', { detail: 'value' })
      return null
    })
    const [entry] = parseLogs(lines)
    assert.equal(entry.event, 'test_event')
    assert.equal(entry.level, 'error')
    assert.equal(entry.detail, 'value')
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/)
  })
})
