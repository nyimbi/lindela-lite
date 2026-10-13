import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { handleAskRoute, matchAskRoute } from '../src/routes/ask.js'

/**
 * ENH-68 — the served surface, asserted where it now lives.
 *
 * The module (`src/nl-query.js`) has its own tests. What is asserted here is the
 * contract the *route* adds, and there are two properties worth holding:
 *
 *   - **a refusal is a 200.** A question the layer cannot ground is an answer
 *     about the data — "no dispatch records, so absence cannot be told from a
 *     gap" is a fact, not a fault. A 4xx here would make the console render "no
 *     route" for a correct refusal, so the route is tested for the status it
 *     must NOT return as much as for the one it must.
 *   - **the grounding audit runs on the model path too.** The handler cannot
 *     tell a deterministic parse from a model-proposed one, and this drives the
 *     audit through an injected parse to prove it rather than asserting it.
 */

function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('end'); return res }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

const jsonResponse = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const makeReq = (method, body) => ({
  method,
  headers: {},
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

const NOW = '2026-10-12T06:00:00Z'
const day = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()

/** The same shape `test/nl-query.test.js` uses: one district over the threshold. */
const fixture = () => ({
  risk_scores: [
    { id: 'r1', type: 'flood_risk', region_name: 'Turkana', country: 'KE', score: 82, risk_level: 'critical', confidence: 85, generated_at: day(1) },
    { id: 'r2', type: 'flood_risk', region_name: 'Mandera', country: 'KE', score: 41, risk_level: 'medium', confidence: 90, generated_at: day(1) },
  ],
})

const call = (route, { data = {}, body } = {}) => {
  const res = fakeResponse()
  return handleAskRoute(route, {
    data, res, jsonResponse, req: makeReq('POST', body),
  }).then((handled) => ({ handled, res }))
}

describe('POST /api/v1/ask (ENH-68)', () => {
  it('matches the path on POST and nothing else', () => {
    assert.deepEqual(matchAskRoute('/api/v1/ask', 'POST'), { kind: 'ask' })
    // A GET has no body to carry the question, so it must fall through to the
    // dispatcher's 404 rather than answering the same query from the URL.
    assert.equal(matchAskRoute('/api/v1/ask', 'GET'), null)
    assert.equal(matchAskRoute('/api/v1/ask/extra', 'POST'), null)
    assert.equal(matchAskRoute('/api/v1/asks', 'POST'), null)
  })

  it('answers a grounded question with 200 and the sentence', async () => {
    const { handled, res } = await call({ kind: 'ask' }, {
      data: fixture(),
      body: { question: 'Which districts crossed the flood threshold?' },
    })
    assert.equal(handled, true)
    assert.equal(res.status, 200)
    const { success, answer } = res.json()
    assert.equal(success, true)
    assert.equal(answer.status, 'answered')
    assert.match(answer.text, /Turkana/)
  })

  it('refuses a request with no question as a 400 with a code', async () => {
    const { res } = await call({ kind: 'ask' }, { body: {} })
    assert.equal(res.status, 400)
    const body = res.json()
    assert.equal(body.success, false)
    assert.equal(body.code, 'bad_request')
  })

  it('returns an ungroundable question as a 200 refusal, not a 4xx', async () => {
    // The property the route exists to hold. A question outside the declared
    // vocabulary is answered by naming the term, not by failing the request.
    const { res } = await call({ kind: 'ask' }, {
      data: fixture(),
      body: { question: 'What is the sentiment of the field reports?' },
    })
    assert.equal(res.status, 200)
    const { success, answer } = res.json()
    assert.equal(success, true)
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'unknown_subject')
    assert.ok(answer.reason)
  })

  it('audits a model-proposed parse against the facts, and refuses an invented figure', async () => {
    // `options.parse` is the seam: inject a parse, inject a render that writes a
    // figure the facts do not contain, and the audit must catch it. This is what
    // makes the model path safe — the handler runs the same tail either way.
    const { answerQueryWithModel } = await import('../src/nl-query.js')
    const answer = await answerQueryWithModel('anything', fixture(), {
      now: NOW,
      parse: async (question) => ({
        status: 'parsed', question, subject: 'flood_risk', subject_label: 'flood risk',
        region: null, window: { key: 'all', label: 'all time', days: null, assumed: false },
        predicates: [], threshold: null, now: NOW, proposed_by: 'needle',
      }),
      render: () => 'Exactly 999 districts matched.',
    })
    assert.equal(answer.status, 'refused')
    assert.equal(answer.code, 'invented_figure')
    assert.match(answer.reason, /999/)
  })
})
