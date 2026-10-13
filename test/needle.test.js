import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'

import {
  NEEDLE_BASIS, NEEDLE_CONFIDENCE_FLOOR, NEEDLE_TOOL_NAME,
  buildNeedleRequest, needleStatus, needleToolSchema, proposeSlots, readNeedleProposal,
} from '../src/needle.js'
import { SUBJECTS, WINDOWS, PREDICATES, parseQuery, parseQueryWithModel } from '../src/nl-query.js'

/**
 * Needle — the on-device model asked to propose slots, never to answer.
 *
 * The rule this module either keeps or breaks: **the model proposes, the
 * vocabulary disposes.** Needle may suggest a subject, a region, a window, a
 * predicate set and a threshold; every one of them is re-validated against
 * `nl-query.js`'s declared vocabulary by code before use, and a proposal that
 * does not survive leaves the deterministic refusal exactly as it was. So the
 * tests below are mostly about what the model *cannot* do: invent a subject,
 * smuggle in a value outside the enum, or have a low-confidence guess applied.
 *
 * No mocks: the transport tests run the REAL `fetch` against a real
 * sidecar-shaped HTTP server on an ephemeral port, the pattern
 * `test/report-narrator.test.js` set for Ollama.
 */

describe('the vocabulary is the only source of a subject', () => {
  it('generates the tool schema from the declared vocabulary, not a copy', () => {
    const schema = needleToolSchema()
    assert.equal(schema.name, NEEDLE_TOOL_NAME)
    assert.deepEqual(
      schema.parameters.properties.subject.enum,
      Object.keys(SUBJECTS),
      'the enum is the vocabulary keys, so adding a subject widens the grammar with no edit here',
    )
    assert.deepEqual(schema.parameters.properties.window.enum, WINDOWS.map((w) => w.key))
    assert.deepEqual(schema.parameters.properties.predicates.items.enum, Object.keys(PREDICATES))
  })

  it('is off until an operator switches it on', () => {
    assert.equal(needleStatus({}).enabled, false)
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE: '1' }).enabled, true)
    // Any other value is off, including the string that reads like truth.
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE: 'true' }).enabled, false)
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE: '0' }).enabled, false)
  })

  it('takes the endpoint and the floor from an injected override', () => {
    const status = needleStatus({}, { enabled: true, baseUrl: 'http://127.0.0.1:9999', confidenceFloor: 0.8 })
    assert.equal(status.base_url, 'http://127.0.0.1:9999')
    assert.equal(status.confidence_floor, 0.8)
    // A floor outside [0,1] is not a floor; the default is kept rather than a
    // nonsense comparison made.
    assert.equal(needleStatus({}, { confidenceFloor: 7 }).confidence_floor, NEEDLE_CONFIDENCE_FLOOR)
  })
})

describe('every proposed slot is validated before it is used', () => {
  const reply = (args, extra = {}) => ({ function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: args }], confidence: 0.9, ...extra })

  it('accepts a proposal whose every slot is in the vocabulary', () => {
    const out = readNeedleProposal(reply({ subject: 'flood_risk', region: 'turkana', window: 'last_week', predicates: ['above_threshold'], threshold: 70 }))
    assert.equal(out.status, 'proposed')
    assert.equal(out.subject, 'flood_risk')
    assert.equal(out.region, 'turkana')
    assert.equal(out.window, 'last_week')
    assert.deepEqual(out.predicates, ['above_threshold'])
    assert.equal(out.threshold, 70)
    assert.equal(out.slots_validated, 5)
  })

  it('refuses a subject the vocabulary does not carry', () => {
    // The load-bearing case. A model that proposes `earthquake_risk` — a real
    // hazard, not in this vocabulary — must not create a subject; it must leave
    // the refusal.
    const out = readNeedleProposal(reply({ subject: 'earthquake_risk' }))
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'unknown_subject')
    assert.match(out.reason, /earthquake_risk/)
  })

  it('drops a predicate, region or window outside the enum rather than trusting the grammar', () => {
    const out = readNeedleProposal(reply({
      subject: 'flood_risk',
      region: 'atlantis',
      window: 'last_century',
      predicates: ['above_threshold', 'summon_helicopter'],
    }))
    assert.equal(out.status, 'proposed')
    assert.equal(out.region, null, 'an unknown region is dropped, not carried')
    assert.equal(out.window, undefined, 'an unknown window is dropped, not carried')
    assert.deepEqual(out.predicates, ['above_threshold'], 'the invented predicate is dropped')
    assert.equal(out.slots_validated, 2, 'and the count reflects what actually survived')
  })

  it('refuses a low-confidence call whole rather than applying part of it', () => {
    const out = readNeedleProposal(reply({ subject: 'flood_risk', region: 'turkana' }, { confidence: 0.2 }))
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'low_confidence')
    assert.equal(out.confidence, 0.2)
  })

  it('treats an empty function_calls list as the model\'s documented refusal', () => {
    // The card: "an off-topic request returns an empty list rather than a guess."
    // That is not a transport failure and must not read as one.
    const out = readNeedleProposal({ function_calls: [], confidence: 0.4, reasoning: 'no tool applies' })
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'no_function_call')
  })

  it('accepts arguments as a JSON string, the OpenAI tool-call shape', () => {
    const out = readNeedleProposal({ function_calls: [{ function: { name: NEEDLE_TOOL_NAME, arguments: JSON.stringify({ subject: 'flood_risk' }) } }], confidence: 0.9 })
    assert.equal(out.status, 'proposed')
    assert.equal(out.subject, 'flood_risk')
  })

  it('refuses malformed arguments rather than throwing', () => {
    const out = readNeedleProposal({ function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: '{not json' }] })
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'malformed_arguments')
  })

  it('names what it is, in the same voice as the other model bases', () => {
    for (const key of ['basis', 'serves', 'not', 'refusals', 'checked']) {
      assert.ok(NEEDLE_BASIS[key], `the basis states ${key}`)
    }
    assert.match(NEEDLE_BASIS.not, /never a replacement for the parser/)
  })
})

describe('the model is consulted only where the vocabulary fails', () => {
  it('does not call Needle when the deterministic parse succeeds', async () => {
    let called = false
    const http = async () => { called = true; throw new Error('should not be called') }
    const parsed = await parseQueryWithModel('Which districts crossed the flood threshold?', { needle: { enabled: true }, http })
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.proposed_by, undefined, 'a deterministic parse is not marked as model-assisted')
    assert.equal(called, false, 'the model is not consulted for a question the vocabulary grounds')
  })

  it('returns the deterministic refusal unchanged when Needle is off', async () => {
    const question = 'What is the sentiment of the field reports?'
    const deterministic = parseQuery(question)
    assert.equal(deterministic.code, 'unknown_subject')
    const withModel = await parseQueryWithModel(question, { needle: { enabled: false } })
    assert.equal(withModel.status, 'refused')
    assert.equal(withModel.code, 'unknown_subject')
    assert.equal(withModel.reason, deterministic.reason, 'the refusal is byte-identical to the no-model one')
  })

  it('proposes a parse for a question the vocabulary could not ground', async () => {
    // "which areas" names no subject phrase; Needle maps it to flood_risk. The
    // region is validated against the district list, so the answer is grounded.
    const http = async () => ({
      ok: true,
      json: async () => ({ function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: { subject: 'flood_risk', region: 'turkana', predicates: ['above_threshold'] } }], confidence: 0.88 }),
    })
    const parsed = await parseQueryWithModel('which areas are in trouble', { needle: { enabled: true }, http })
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.subject, 'flood_risk')
    assert.equal(parsed.subject_label, SUBJECTS.flood_risk.label, 'the label is read off the vocabulary, not the model')
    assert.equal(parsed.region.slug, 'turkana')
    assert.equal(parsed.proposed_by, 'needle')
    assert.equal(parsed.needle.confidence, 0.88)
  })

  it('keeps the deterministic refusal when the model proposes an unknown subject', async () => {
    // The question must genuinely fail the deterministic parse, or this tests
    // nothing: "what is the volcano risk" parses, because "risk" is a
    // `flood_risk` phrase. "what about the volcano situation" names no subject
    // phrase and refuses — that is the input this case is about.
    const http = async () => ({ ok: true, json: async () => ({ function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: { subject: 'volcano_risk' } }], confidence: 0.95 }) })
    const parsed = await parseQueryWithModel('what about the volcano situation', { needle: { enabled: true }, http })
    assert.equal(parsed.status, 'refused')
    assert.equal(parsed.code, 'unknown_subject')
    assert.equal(parsed.needle.code, 'unknown_subject', 'and the refusal records why the model did not help')
  })
})

describe('the sidecar is reached over the real transport', () => {
  let server
  let port
  let lastRequest

  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        lastRequest = { url: req.url, method: req.method, body: JSON.parse(body || '{}') }
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            choices: [{ message: { function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: { subject: 'flood_risk', region: 'turkana' } }], confidence: 0.91 } }],
          }))
          return
        }
        if (req.url === '/broken') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{not json')
          return
        }
        res.writeHead(500)
        res.end('nope')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  after(() => { server.close() })

  it('posts the tool schema and reads the proposal back', async () => {
    const out = await proposeSlots('which areas are in trouble', { needle: { enabled: true, baseUrl: `http://127.0.0.1:${port}` } })
    assert.equal(out.status, 'proposed')
    assert.equal(out.subject, 'flood_risk')
    assert.equal(out.confidence, 0.91)
    // The request really carried the vocabulary-derived grammar.
    assert.equal(lastRequest.url, '/v1/chat/completions')
    assert.equal(lastRequest.body.tools[0].name, NEEDLE_TOOL_NAME)
    assert.deepEqual(lastRequest.body.tools[0].parameters.properties.subject.enum, Object.keys(SUBJECTS))
  })

  it('refuses, as data, when the sidecar answers an error', async () => {
    const out = await proposeSlots('anything', { needle: { enabled: true, baseUrl: `http://127.0.0.1:${port}/nope` } })
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'http_error')
  })

  it('refuses, as data, when the sidecar is unreachable', async () => {
    // Port 1 is reserved and nothing listens; the fetch rejects and the refusal
    // carries the transport's own message rather than throwing.
    const out = await proposeSlots('anything', { needle: { enabled: true, baseUrl: 'http://127.0.0.1:1' } })
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'unreachable')
  })

  it('builds a request that reserves room for the reply', () => {
    // The card warns max_new_tokens competes with the prefix for context, so a
    // slot-fill reserves a handful of tokens rather than a paragraph's worth.
    const request = buildNeedleRequest('which areas are in trouble')
    assert.ok(request.max_new_tokens > 0 && request.max_new_tokens <= 256)
    assert.equal(request.tools.length, 1)
    assert.equal(request.messages.at(-1).content, 'which areas are in trouble')
  })
})
