import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'

import {
  NEEDLE_BASIS, NEEDLE_CONFIDENCE_FLOOR, NEEDLE_TOOL_NAME,
  buildNeedleRequest, needleStatus, needleToolSchema, proposeSlots, readNeedleProposal,
} from '../src/needle.js'
import { DEFAULT_WINDOW, SUBJECTS, WINDOWS, PREDICATES, answerQueryWithModel, parseQuery, parseQueryWithModel } from '../src/nl-query.js'

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

  it('reads a blank confidence floor as unset, not as a floor of zero', () => {
    // `Number('')` is 0, and 0 is a legal floor, so it passed the range check and
    // switched the gate off: every proposal the sidecar returned was accepted,
    // however unsure the model said it was. `LINDELA_LITE_NEEDLE_CONFIDENCE=` is
    // what a shell writes for an unset variable, so this is the common spelling
    // of "not configured" rather than an exotic one.
    for (const blank of ['', '  ', '\t']) {
      assert.equal(needleStatus({ LINDELA_LITE_NEEDLE_CONFIDENCE: blank }).confidence_floor, NEEDLE_CONFIDENCE_FLOOR,
        `${JSON.stringify(blank)} is an unset variable, not a floor`)
    }
    assert.equal(needleStatus({}).confidence_floor, NEEDLE_CONFIDENCE_FLOOR)
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE_CONFIDENCE: 'abc' }).confidence_floor, NEEDLE_CONFIDENCE_FLOOR)
    // The control that keeps the fix from over-reaching: a stated zero is a real
    // floor — "accept anything the model proposes" is a policy someone can mean.
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE_CONFIDENCE: '0' }).confidence_floor, 0)
    assert.equal(needleStatus({ LINDELA_LITE_NEEDLE_CONFIDENCE: '0.9' }).confidence_floor, 0.9)
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

  it('refuses a proposal that carries no confidence score, in every spelling of "absent"', () => {
    // The fail-open this closes: `Number(undefined)` is NaN, so the old
    // `Number.isFinite(confidence) && confidence < floor` guard skipped the
    // threshold entirely for a reply that omitted the field — while the same
    // reply spelling it `null` became `Number(null) === 0` and was refused as
    // low-confidence. Two spellings of one absence, opposite verdicts, and the
    // omitted one is what a sidecar written against the card's Python turn
    // shape produces. Each is now the same refusal.
    const args = { subject: 'flood_risk' }
    const omitted = { function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: args }] }
    for (const [label, payload] of [
      ['omitted', omitted],
      ['null', { ...omitted, confidence: null }],
      ['empty string', { ...omitted, confidence: '' }],
      ['not a number', { ...omitted, confidence: 'high' }],
    ]) {
      const out = readNeedleProposal(payload)
      assert.equal(out.status, 'refused', `${label}: an unroutable proposal must not be applied`)
      assert.equal(out.code, 'no_confidence', `${label}: expected no_confidence`)
    }
  })

  it('refuses a call that names a different tool, rather than reading it as ours', () => {
    // The card's contract is one call per action with the name the app
    // registered. A turn naming `get_weather` is the model choosing something
    // this adapter did not offer, and its arguments are not a proposal about
    // this question. The old `|| calls[0]` fallback applied it anyway, which is
    // the adapter inventing a call the model did not make.
    const out = readNeedleProposal(reply({ subject: 'flood_risk' }, {
      function_calls: [{ name: 'get_weather', arguments: { subject: 'flood_risk' } }],
    }))
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'unexpected_tool')
  })

  it('accepts a call with no name, which is the card\'s own turn shape', () => {
    // The control for the test above: the Python API returns the turn as the
    // call with no `name` key at all, so an unnamed call must still be read.
    // Without this, refusing every non-matching name would refuse the shape the
    // model card documents.
    const out = readNeedleProposal({
      function_calls: [{ arguments: { subject: 'flood_risk' } }],
      confidence: 0.9,
    })
    assert.equal(out.status, 'proposed')
    assert.equal(out.subject, 'flood_risk')
  })

  it('still tells a genuine zero from an absent score', () => {
    // The control for the test above: a model that scores its own guess 0 is
    // refusing, not silent, and the two must not collapse into one code.
    const out = readNeedleProposal(reply({ subject: 'flood_risk' }, { confidence: 0 }))
    assert.equal(out.status, 'refused')
    assert.equal(out.code, 'low_confidence')
    assert.equal(out.confidence, 0)
  })

  it('tells an absent threshold from a proposed zero, which every record crosses', () => {
    // The same absence-versus-zero bug as the confidence one, one slot over.
    // `Number(null)` and `Number('')` are both 0, so a sidecar sending
    // `threshold: null` alongside `above_threshold` produced a threshold of
    // zero: `runQuery` filters `score >= 0`, which every record with a score
    // crosses, and the answer reads "at or above 0" over the whole collection.
    // The omitted spelling falls back to the declared default instead, so the
    // two spellings of one absence answered two different questions — and the
    // one a sidecar sends is the one that widens the answer.
    for (const [label, value] of [['null', null], ['empty string', '']]) {
      const out = readNeedleProposal(reply({ subject: 'flood_risk', predicates: ['above_threshold'], threshold: value }))
      assert.equal(out.status, 'proposed')
      assert.equal(out.threshold, null, `${label}: an absent threshold must not become 0`)
      assert.equal(out.slots_validated, 2, `${label}: and it must not count as a validated slot`)
    }
    // The control: an explicit zero is a question someone can mean, and it stays.
    const zero = readNeedleProposal(reply({ subject: 'flood_risk', predicates: ['above_threshold'], threshold: 0 }))
    assert.equal(zero.threshold, 0)
    assert.equal(zero.slots_validated, 3)
  })

  it('refuses a threshold outside the declared type rather than coercing it', () => {
    // `Number()` accepts more than a threshold can be: `true` is 1, `false` is
    // 0, `[]` is 0. The grammar declares `type: 'number'` and would not emit
    // those — but the grammar is the model's promise and this module does not
    // take it. A boolean here used to become a threshold of 1 or 0, i.e. a
    // filter the model never proposed.
    for (const value of [true, false, [], {}]) {
      const out = readNeedleProposal(reply({ subject: 'flood_risk', predicates: ['above_threshold'], threshold: value }))
      assert.equal(out.threshold, null, `${JSON.stringify(value)} is not a threshold`)
      assert.equal(out.slots_validated, 2)
    }
    // A numeric string is what an OpenAI-shaped sidecar sends, and stays read.
    assert.equal(readNeedleProposal(reply({ subject: 'flood_risk', threshold: '70' })).threshold, 70)
  })

  it('counts a repeated predicate once, so slots_validated is not the model\'s padding', () => {
    // `runQuery` branches on `.includes`, so a duplicate changes nothing about
    // the answer — it only inflates the count a reader checks the validation
    // with.
    const out = readNeedleProposal(reply({ subject: 'flood_risk', predicates: ['above_threshold', 'above_threshold'] }))
    assert.deepEqual(out.predicates, ['above_threshold'])
    assert.equal(out.slots_validated, 2)
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

  it('falls back to the declared default window when the model proposes none', async () => {
    // The model path is only reached when `parseQuery` REFUSED, and a refusal
    // carries no `window`. Inheriting `parsed.window` therefore produced
    // `window: undefined`, and the first `query.window.days` in `runQuery`
    // threw a TypeError out of the route — a 500 where the module's contract
    // promises a 200. A proposal that names no window must take the same
    // declared default `findWindow` uses, stamped assumed.
    const http = async () => ({
      ok: true,
      json: async () => ({ function_calls: [{ name: NEEDLE_TOOL_NAME, arguments: { subject: 'hazards' } }], confidence: 0.9 }),
    })
    const parsed = await parseQueryWithModel('what has been going on lately', { needle: { enabled: true }, http })
    assert.equal(parsed.status, 'parsed')
    assert.ok(parsed.window, 'a parsed query always carries a window')
    assert.equal(parsed.window.key, DEFAULT_WINDOW)
    assert.equal(parsed.window.assumed, true, 'and it is marked as assumed, not as something the question said')

    // And the whole answer path runs: `hazards` is windowed, so this is the
    // shape that used to throw.
    const answer = await answerQueryWithModel('what has been going on lately', {
      hazard_events: [{ id: 'h1', event_type: 'flood', severity: 'high', region_name: 'Turkana', started_at: '2026-10-20T00:00:00Z' }],
    }, { needle: { enabled: true }, http, now: '2026-10-22T00:00:00Z' })
    assert.equal(answer.status, 'answered')
    assert.match(answer.text, /hazard events/)
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
