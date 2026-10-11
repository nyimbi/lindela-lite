import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { createInboundLimiter } from '../src/inbound-rate-limit.js'
import { ERROR_CODES, ERROR_CODE_VALUES, errorCodeFor, errorEnvelope } from '../src/errors.js'

/**
 * ARC-07 — the error envelope had no machine-readable reason.
 *
 * `{ success: false, error: '…' }` was hand-written at every failing
 * `jsonResponse` site — 129 in `src/server.js` — and not one carried a code. A
 * client that had to tell "this report is approved and cannot be regenerated"
 * from "this record is deleted", both 409, had the human sentence and nothing
 * else. That sentence is prose: it is reworded when someone improves it, it is
 * the first thing a translation touches, and a client branching on it breaks on
 * a copy edit with no error anywhere.
 *
 * The guarantee here is mechanical rather than per-site. The default code is
 * applied inside `jsonResponse`, so a new error site cannot forget it — and the
 * last test in this file is the one that matters most, because it walks the
 * whole route surface and asserts every failing response carries a code. A
 * per-site fix would pass the first three tests and fail that one.
 */

const CREDS = JSON.stringify([{ token: 'arc07-key', scopes: ['*'] }])

function fakeClock(startMs = 1_000_000) {
  let current = startMs
  const pending = []
  return {
    now: () => current,
    sleep: (ms) => new Promise((resolve) => pending.push(() => { current += ms; resolve() })),
    advance(ms) { current += ms; for (const tick of pending.splice(0)) tick() },
  }
}

async function withServer(fn, { env = {}, limiterOptions } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-arc07-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === '') delete process.env[k]
    else process.env[k] = v
  }
  const listener = createServer({
    store,
    ...(limiterOptions ? { inboundLimiter: createInboundLimiter(limiterOptions) } : {}),
  }).listen(0)
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

const AUTH = { 'x-api-key': 'arc07-key' }

describe('ARC-07 — the status supplies a default code', () => {
  it('carries a code on a 404 that no site named', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/reports/does-not-exist`, { headers: AUTH })
      assert.equal(res.status, 404)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.code, ERROR_CODES.NOT_FOUND,
        'a 404 with no code leaves the client matching on "Report not found"')
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })

  it('carries a code on a 405', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/reports/templates`, { method: 'PUT', headers: AUTH })
      assert.equal(res.status, 405)
      const body = await res.json()
      assert.equal(body.code, ERROR_CODES.METHOD_NOT_ALLOWED)
      assert.equal(body.error, 'Method not allowed', 'the message stays; the code is added beside it')
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })

  it('carries a code on a 401', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/reports`)
      assert.equal(res.status, 401)
      assert.equal((await res.json()).code, ERROR_CODES.UNAUTHORIZED)
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })

  it('carries a code on a 429, beside the retry hint it already had', async () => {
    const clock = fakeClock()
    await withServer(async (base) => {
      // Two requests are enough: the budget is one per window, so the second is
      // refused. The earlier version looped 200 times against the shipped
      // 300/min budget and never reached it — a guard that never fires reads
      // exactly like a guard that passes.
      const first = await fetch(`${base}/api/v1/incidents?limit=1`, { headers: AUTH })
      assert.equal(first.status, 200, `the first read should be inside the budget, got ${first.status}`)
      const refused = await fetch(`${base}/api/v1/incidents?limit=1`, { headers: AUTH })
      assert.equal(refused.status, 429, 'the second read was not limited, so this proves nothing')
      const body = await refused.json()
      assert.equal(body.code, ERROR_CODES.RATE_LIMITED)
      assert.equal(body.class, 'read', 'the code is added, not substituted for what the site already said')
    }, {
      env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' },
      limiterOptions: {
        now: clock.now,
        sleep: () => new Promise(() => {}),
        policies: { read: { ratePerWindow: 1, windowMs: 60_000, concurrency: 1 } },
      },
    })
  })

  it('leaves a success without a code', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/health`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.code, undefined,
        'a `code` on a 200 collides with any payload field of that name and means nothing')
    }, { env: { LINDELA_LITE_TOKENS: '', LINDELA_LITE_API_KEY: '' } })
  })
})

describe('ARC-07 — four 409s, four codes', () => {
  it('separates a soft-deleted record from a conflict that is not one', async () => {
    await withServer(async (base) => {
      const post = (p, body) => fetch(`${base}${p}`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const created = await (await post('/api/v1/response-resources', {
        name: 'arc07 water tabs', resource_type: 'supply', quantity: 5,
      })).json()
      const id = created.data?.id
      assert.ok(id, `resource creation returned no id: ${JSON.stringify(created)}`)

      const first = await fetch(`${base}/api/v1/response-resources/${id}`, {
        method: 'DELETE',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'arc07' }),
      })
      assert.equal(first.status, 200, `first delete should succeed, got ${first.status}`)

      const second = await fetch(`${base}/api/v1/response-resources/${id}`, {
        method: 'DELETE',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'arc07' }),
      })
      assert.equal(second.status, 409)
      assert.equal((await second.json()).code, ERROR_CODES.RECORD_DELETED,
        'a client that reads this as a generic conflict will retry a delete that can never succeed')
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })

  it('separates an idempotency replay in flight from every other conflict', async () => {
    await withServer(async (base) => {
      const key = 'arc07-in-flight'
      const send = () => fetch(`${base}/api/v1/response-resources`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ name: 'arc07 replay', resource_type: 'supply', quantity: 1 }),
      })
      // The two run concurrently: the second finds the first's key claimed and
      // unresolved, which is the only path to this 409.
      const [a, b] = await Promise.all([send(), send()])
      const inFlight = [a, b].find((r) => r.status === 409)
      assert.ok(inFlight,
        `expected one concurrent send to be refused, got ${a.status}/${b.status}`)
      const body = await inFlight.json()
      assert.equal(body.code, ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
        'a client told "conflict" retries with a new body; this one must retry the same body')
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })

  it('separates an immutable report from a conflict that is not one', async () => {
    await withServer(async (base) => {
      const post = (p, body) => fetch(`${base}${p}`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const template = await (await post('/api/v1/report-templates', {
        name: 'arc07 brief',
        report_type: 'incident_brief',
        sections: ['executive_summary', 'appendix_sources'],
        actor: 'arc07',
      })).json()
      assert.ok(template.data?.id, `template creation returned no id: ${JSON.stringify(template)}`)

      const made = await (await post('/api/v1/reports', {
        template_id: template.data.id, generate: true, actor: 'arc07',
      })).json()
      const id = made.data?.id
      assert.ok(id, `report creation returned no id: ${JSON.stringify(made).slice(0, 300)}`)

      await post(`/api/v1/reports/${id}/approve`, { actor: 'arc07' })
      const again = await post(`/api/v1/reports/${id}/generate`, { actor: 'arc07' })
      const body = await again.json()
      assert.equal(again.status, 409, `expected 409, got ${again.status}: ${JSON.stringify(body).slice(0, 200)}`)
      assert.equal(body.code, ERROR_CODES.IMMUTABLE,
        'an approved report is not a generic conflict; retrying it is never the right response')
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })
})

describe('ARC-07 — the vocabulary is closed', () => {
  it('resolves every code the source names', async () => {
    const files = await fs.readdir('src', { withFileTypes: true })
    const sources = await Promise.all(
      files.filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map(async (e) => [e.name, await fs.readFile(path.join('src', e.name), 'utf8')]),
    )
    const named = new Set()
    for (const [name, text] of sources) {
      for (const m of text.matchAll(/ERROR_CODES\.([A-Z0-9_]+)/g)) {
        // The definition file names its own keys; everywhere else a name that
        // does not resolve is a typo that ships `undefined` as a code.
        if (name === 'errors.js') continue
        named.add(m[1])
      }
    }
    const missing = [...named].filter((k) => !(k in ERROR_CODES))
    assert.deepEqual(missing, [],
      `these codes are referenced in src/ and defined nowhere: ${missing.join(', ')}`)
  })

  it('publishes exactly the codes it emits, in the OpenAPI contract', async () => {
    // The document is the client's contract and the enum is what a generator
    // turns into a type. A code the server can send and the document does not
    // list is a client that switches exhaustively and throws on a live 409.
    const spec = await fs.readFile('docs/openapi.yaml', 'utf8')
    const start = spec.indexOf('    Error:')
    assert.ok(start > -1, 'docs/openapi.yaml has no Error schema')
    const rest = spec.slice(start + 10)
    const next = rest.search(/\n {4}[A-Z]\w*:/)
    const block = spec.slice(start, next === -1 ? undefined : start + 10 + next)
    const enumStart = block.indexOf('enum:')
    assert.ok(enumStart > -1, 'the Error schema has no code enum')
    const documented = new Set(
      [...block.slice(enumStart).matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]),
    )
    const missing = [...ERROR_CODE_VALUES].filter((c) => !documented.has(c))
    const extra = [...documented].filter((c) => !ERROR_CODE_VALUES.has(c))
    assert.deepEqual(missing, [], `the document does not list these codes the server sends: ${missing.join(', ')}`)
    assert.deepEqual(extra, [], `the document lists codes the server cannot send: ${extra.join(', ')}`)
  })

  it('gives a fallback rather than undefined for a status it does not list', () => {
    assert.equal(errorCodeFor(418), ERROR_CODES.BAD_REQUEST)
    assert.equal(errorCodeFor(599), ERROR_CODES.INTERNAL_ERROR)
    assert.equal(typeof errorCodeFor(999), 'string')
  })

  it('does not put a code on a non-object body', () => {
    const plan = { feasible: false, reason: 'the network is severed' }
    assert.equal(errorEnvelope(400, plan), plan,
      'the envelope is not something to add to a value that has a shape of its own')
    assert.equal(errorEnvelope(400, 'nope'), 'nope')
    const list = ['a']
    assert.equal(errorEnvelope(400, list), list)
  })

  it('replaces a code outside the vocabulary with the status default', () => {
    const body = errorEnvelope(409, { success: false, error: 'x', code: 'not_a_real_code' })
    assert.equal(body.code, ERROR_CODES.CONFLICT)
    assert.ok(ERROR_CODE_VALUES.has(body.code))
  })

  it('keeps a code the site named, when it is in the vocabulary', () => {
    const body = errorEnvelope(409, { success: false, error: 'x', code: ERROR_CODES.RECORD_DELETED })
    assert.equal(body.code, ERROR_CODES.RECORD_DELETED)
  })
})

describe('ARC-07 — no failing response reaches a client without a code', () => {
  it('walks the route surface and finds a code on every 4xx it can provoke', async () => {
    await withServer(async (base) => {
      // A request per shape a client actually gets wrong: an unknown id, a
      // wrong verb, no token, a malformed body. The assertion is not about
      // which status each returns — it is that whatever status comes back
      // carries a code, which is what makes this a guard over the whole
      // surface rather than over the four sites a test happens to name.
      const probes = [
        ['GET', '/api/v1/reports/does-not-exist', {}],
        ['GET', '/api/v1/records/does-not-exist', {}],
        ['PUT', '/api/v1/reports/templates', {}],
        ['DELETE', '/api/v1/action-logs', {}],
        ['POST', '/api/v1/action-logs', {}],
        ['POST', '/api/v1/records', { body: '{not json' }],
        ['GET', '/api/v1/records?limit=not-a-number', {}],
        ['GET', '/api/v1/ingestion/schedules/does-not-exist', {}],
        ['GET', '/api/v1/webhooks/subscriptions/does-not-exist', {}],
        ['GET', '/api/v1/workflows/instances/does-not-exist', {}],
        ['GET', '/api/v1/parametric/rules/does-not-exist', {}],
        ['GET', '/api/v1/protocols/does-not-exist', {}],
        ['GET', '/api/v1/documents/does-not-exist', {}],
        ['POST', '/api/v1/approvals', {}],
        ['GET', '/api/v1/nothing-here', {}],
      ]
      const uncoded = []
      let failures = 0
      for (const [method, p, extra] of probes) {
        const res = await fetch(`${base}${p}`, {
          method,
          headers: { ...AUTH, ...(extra.body ? { 'content-type': 'application/json' } : {}) },
          body: extra.body,
        })
        if (res.status < 400) continue
        failures += 1
        const body = await res.json().catch(() => null)
        if (!body || typeof body.code !== 'string' || !ERROR_CODE_VALUES.has(body.code)) {
          uncoded.push(`${method} ${p} → ${res.status} ${JSON.stringify(body)}`)
        }
      }
      assert.ok(failures >= 10,
        `only ${failures} probes failed; a guard over a surface it never touched proves nothing`)
      assert.deepEqual(uncoded, [],
        `these failing responses carry no code in the vocabulary:\n  ${uncoded.join('\n  ')}`)
    }, { env: { LINDELA_LITE_TOKENS: CREDS, LINDELA_LITE_API_KEY: '' } })
  })
})
