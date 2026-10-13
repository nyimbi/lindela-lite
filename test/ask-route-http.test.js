import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * ENH-68 — `POST /api/v1/ask` over HTTP, through the real dispatcher.
 *
 * `test/ask-route-module.test.js` calls `handleAskRoute` directly and asserts the
 * exact body it builds. That covers the handler; it does not cover the path a
 * request actually takes. Between the socket and the handler sit the scope table,
 * the dispatcher's family ordering, the store read that produces `data`, and the
 * `jsonResponse` the route destructures from its context — and every one of those
 * is a place the route can be registered correctly and still answer nothing.
 *
 * The gap was named when the route shipped and left open: `check-route-methods`
 * drives POST to a 400 (an empty body has no question) and `check-route-envelopes`
 * drives GET only, so no automated check had ever seen this route return 200 with
 * a body. A `jsonResponse` rename or a context-key change would have broken the
 * console silently while every existing test stayed green.
 *
 * So this boots a real server, seeds a store, and reads the answer off the wire.
 */

const NOW = new Date().toISOString()
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()

/** One district over the threshold, the shape `nl-query` resolves against. */
const RISK_SCORES = [
  { id: 'r1', type: 'flood_risk', region_name: 'Turkana', country: 'KE', score: 82, risk_level: 'critical', confidence: 85, generated_at: day(1) },
  { id: 'r2', type: 'flood_risk', region_name: 'Mandera', country: 'KE', score: 41, risk_level: 'medium', confidence: 90, generated_at: day(1) },
]

/**
 * A real listener with a seeded store, and a token holding `*`.
 *
 * The route is scoped `admin:analytics` in the write table, so a token without
 * the scope is a 403 before the handler runs — which is itself worth asserting,
 * because "the route is reachable" is only true for a caller that holds the
 * scope. Auth is configured via `LINDELA_LITE_TOKENS` for the duration.
 */
async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-ask-http-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  await store.merge({ risk_scores: RISK_SCORES })
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  const previous = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = JSON.stringify([{ token: 'ask-test', scopes: ['*'] }])
  try {
    return await fn(base)
  } finally {
    if (previous === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = previous
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const ask = (base, body, headers = {}) => fetch(`${base}/api/v1/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'ask-test', ...headers },
  body: JSON.stringify(body),
})

describe('POST /api/v1/ask over HTTP (ENH-68)', () => {
  it('answers a grounded question with 200 and a sentence naming the district', async () => {
    await withServer(async (base) => {
      const res = await ask(base, { question: 'Which districts crossed the flood threshold?' })
      assert.equal(res.status, 200, 'the route is served and the caller holds the scope')
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.answer.status, 'answered')
      assert.match(body.answer.text, /Turkana/)
      // The audit count travels with the answer, so a reader can tell the
      // sentence was checked rather than merely generated.
      assert.ok(body.answer.numbers_checked >= 1, 'no figures were audited')
    })
  })

  it('returns a refusal as a 200 carrying the reason, not a 4xx', async () => {
    // The property the console depends on: a question outside the vocabulary is
    // answered by naming the term. A 4xx here renders as an error in the panel
    // for a correct refusal.
    await withServer(async (base) => {
      const res = await ask(base, { question: 'What is the sentiment of the field reports?' })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.answer.status, 'refused')
      assert.equal(body.answer.code, 'unknown_subject')
      assert.ok(body.answer.reason, 'a refusal without a reason is not actionable')
    })
  })

  it('answers a missing question with 400 and a code', async () => {
    await withServer(async (base) => {
      const res = await ask(base, {})
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.code, 'bad_request')
    })
  })

  it('refuses a caller that does not hold the write scope', async () => {
    // `admin:analytics` is the gate. A token with an unrelated scope must not
    // reach the handler — the route is reachable, not open.
    await withServer(async (base) => {
      const previous = process.env.LINDELA_LITE_TOKENS
      process.env.LINDELA_LITE_TOKENS = JSON.stringify([{ token: 'narrow', scopes: ['read:reports'] }])
      try {
        const res = await fetch(`${base}/api/v1/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'narrow' },
          body: JSON.stringify({ question: 'Which districts crossed the flood threshold?' }),
        })
        assert.equal(res.status, 403, 'a read-scoped token reached an admin:analytics route')
      } finally {
        process.env.LINDELA_LITE_TOKENS = previous
      }
    })
  })

  it('does not answer the same query over GET', async () => {
    // A GET has no body to carry the question. Falling through to the
    // dispatcher's 404 is correct; answering from the URL would be a surface the
    // contract does not declare.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/ask?question=Which+districts+crossed%3F`, {
        headers: { 'x-api-key': 'ask-test' },
      })
      assert.equal(res.status, 404)
    })
  })
})
