#!/usr/bin/env node
/**
 * ENH-57 — the briefing route, and the two things about it that are dangerous.
 *
 * `src/briefing.js` was complete and tested and reached by nothing: it built the
 * requests and audited the text, and no route ever asked it to. This file covers
 * the route, and it is written around the two failures a route can introduce
 * that the module cannot see.
 *
 *   1. **A request field must not become a narrator option.** `narrateReport`
 *      takes `env` and `http` as injectable transports — correct for a test,
 *      and an exfiltration path from a route: a body carrying
 *      `env: { OLLAMA_BASE_URL: 'http://attacker' }` would point the model call
 *      at a host the caller chose and post the report's own sections to it. The
 *      handler spreads nothing from the body into those options, and the test
 *      asserts the model call goes where the *server's* environment says.
 *   2. **An unknown audience must be a 400, not a 500.** `narrateBriefings`
 *      indexes `BRIEFING_AUDIENCES[audience]` and throws a TypeError for a name
 *      it does not hold. That is a misspelled field answered as a server fault,
 *      which is the silent-typo failure the registry's own header warns about,
 *      one layer out.
 *
 * The refusal shape is asserted too, because it is a decision rather than an
 * accident: `no_permitted_facts` is a 200 carrying a refusal. It is a statement
 * about what an audience is entitled to see, not about whether the request was
 * well formed, and a 4xx would make it read as the second.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { BRIEFING_AUDIENCE_IDS } from '../src/briefing.js'
import { handleReportingRoute, matchReportingRoute } from '../src/routes/reporting.js'
import { emptyStore } from '../src/schema.js'
import { runWithRequestContext } from '../src/utils.js'

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

const AUTH = { subject: 'operator', partner_org: null }

const makeReq = (method, body) => ({
  method,
  headers: {},
  __auth: AUTH,
  __rawBody: body === undefined ? '' : JSON.stringify(body),
  async *[Symbol.asyncIterator]() {},
})

function recordingStore(initial = {}) {
  const state = { ...emptyStore(), ...initial }
  const merges = []
  const locked = {
    async read() { return state },
    async merge(partial) {
      merges.push(partial)
      for (const [collection, records] of Object.entries(partial)) {
        const byId = new Map((state[collection] || []).map((r) => [r.id, r]))
        for (const record of records) byId.set(record.id, record)
        state[collection] = [...byId.values()]
      }
      return partial
    },
  }
  return {
    state,
    merges,
    async read() { return state },
    async merge(partial) { return locked.merge(partial) },
    async withLock(fn) { return fn(locked) },
  }
}

const call = (route, { method = 'POST', body, store = recordingStore() } = {}) => {
  const res = fakeResponse()
  const req = makeReq(method, body)
  return runWithRequestContext(AUTH, () => handleReportingRoute(route, {
    store, data: store.state, res, jsonResponse, req,
    url: new URL('http://127.0.0.1/x'),
  })).then((handled) => ({ handled, res, store }))
}

/**
 * A report whose sections each carry a figure appearing nowhere else, so a
 * figure's presence in the narrator's prompt names which sections survived the
 * narrowing. `scope` carries `partner_org` because the partner audience is
 * scoped to it and the narrowing reads that key.
 */
const report = (over = {}) => ({
  id: 'r1', template_id: 't1', report_type: 'situation_report', status: 'draft',
  title: 'Situation Report', scope: { district: 'Karonga', region: 'Northern', country: 'MW', partner_org: 'org-1' },
  section_ids: ['executive_summary', 'risk_summary'],
  sections: [
    { id: 'executive_summary', title: 'Executive summary', type: 'deterministic_summary', content: { summary: 'The report covers 11 events.', items: [] }, source_refs: [], generated_at: '2026-01-01T00:00:00Z', warnings: [] },
    { id: 'risk_summary', title: 'Risk summary', type: 'deterministic_summary', content: { summary: '77 risks concern the lake shore.', items: [] }, source_refs: [], generated_at: '2026-01-01T00:00:00Z', warnings: [] },
  ],
  source_refs: [], warnings: [], narrative: {}, distribution_defaults: [],
  generated_at: '2026-01-01T00:00:00Z', approved_at: null, distributed_at: null, owner: 'ops',
  partner_org: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {},
  ...over,
})

/** A narrator transport that records where it was asked to go and answers once. */
function recordingNarrator(answer = 'The report covers 11 events.') {
  const calls = []
  const http = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() { return { response: answer, model: 'qwen-test' } },
      async text() { return answer },
    }
  }
  return { calls, http }
}

const ENV_ON = { LINDELA_LITE_NARRATOR: '1', OLLAMA_BASE_URL: 'http://127.0.0.1:11434', LINDELA_LITE_NARRATOR_MODEL: 'qwen-test' }

describe('ENH-57 — matchReportingRoute knows the briefings action', () => {
  it('matches the action and only on the reports collection', () => {
    assert.deepEqual(matchReportingRoute('/api/v1/reports/r1/briefings'),
      { kind: 'reports', id: 'r1', action: 'briefings' })
  })

  it('does not match a near miss', () => {
    // `/api/v1/reports/briefings` is deliberately absent from this list: it is a
    // two-segment `/reports/<id>` and the by-id lookup owns it, which is right —
    // a report whose id happened to be `briefings` would be a report.
    for (const pathname of ['/api/v1/reports/r1/briefing', '/api/v1/report-briefings', '/api/v1/reports/r1/briefings/x']) {
      assert.equal(matchReportingRoute(pathname), null, `${pathname} matched a route it should not`)
    }
  })
})

describe('ENH-57 — the route writes one briefing per audience', () => {
  it('refuses a report that was never generated', async () => {
    const store = recordingStore({ reports: [report({ sections: [] })] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, { body: {}, store })
    assert.equal(res.status, 400)
    assert.match(res.json().error, /nothing computed to brief/)
  })

  it('answers 404 for a report that is not there', async () => {
    const store = recordingStore({ reports: [] })
    const { res } = await call({ kind: 'reports', id: 'nope', action: 'briefings' }, { body: {}, store })
    assert.equal(res.status, 404)
  })

  it('turns an unknown audience into a 400 naming the known ones', async () => {
    // The class this guards: `narrateBriefings` would index the registry with a
    // name it does not hold and throw a TypeError, so a misspelled field would
    // be answered as a server fault.
    const store = recordingStore({ reports: [report()] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, {
      body: { audiences: ['district_officer', 'district_offcier'] }, store,
    })
    assert.equal(res.status, 400, 'a misspelled audience was not a 400')
    assert.equal(res.json().code, 'unknown_audience')
    assert.deepEqual(res.json().known_audiences, [...BRIEFING_AUDIENCE_IDS])
  })

  it('records the briefings on the report and logs one action', async () => {
    const store = recordingStore({ reports: [report()] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, {
      body: { audiences: ['district_officer'] }, store,
    })
    assert.equal(res.status, 200)
    const body = res.json()
    assert.equal(body.briefings.length, 1)
    assert.equal(body.briefings[0].audience, 'district_officer')
    assert.equal(body.narrated + body.refused, 1, 'the counts do not partition the set')
    const stored = store.state.reports.find((r) => r.id === 'r1')
    assert.ok(stored.briefings, 'the briefings were not recorded on the report')
    assert.equal(stored.briefings.audiences[0].audience, 'district_officer')
    assert.equal(store.state.action_logs.filter((l) => l.action === 'briefed').length, 1)
  })

  it('defaults to every declared audience', async () => {
    const store = recordingStore({ reports: [report()] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, { body: {}, store })
    assert.deepEqual(res.json().briefings.map((b) => b.audience), [...BRIEFING_AUDIENCE_IDS])
  })
})

describe('ENH-57 — a refusal is a 200, and it says what it is a refusal of', () => {
  it('returns no_permitted_facts rather than a paragraph about nothing', async () => {
    // A report whose only sections are ones no audience in the registry may
    // see. `briefing.js` refuses rather than writing short, because an empty
    // paragraph reads as "nothing to report" — a claim about the situation when
    // the truth is a claim about entitlement.
    const store = recordingStore({ reports: [report({ sections: [{ id: 'appendix_sources', title: 'Sources', type: 'text', content: { summary: 'x', items: [] }, source_refs: [], generated_at: '2026-01-01T00:00:00Z', warnings: [] }] })] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, { body: {}, store })
    assert.equal(res.status, 200, 'a refusal was answered as a client error')
    const body = res.json()
    assert.equal(body.narrated, 0)
    assert.equal(body.refused, body.briefings.length)
    assert.ok(body.briefings.every((b) => b.status === 'refused' && b.reason), 'a refusal arrived with no reason')
  })
})

describe('ENH-57 — the body cannot reach the narrator transport', () => {
  it('does not let a request field become a narrator option', async () => {
    // The route spreads nothing from the body into `narrateBriefings`' options.
    // `narrateReport` accepts `env` and `http`, so a body carrying `env` would
    // otherwise choose the host the report's own sections are posted to.
    //
    // Asserted by outcome rather than by reading the handler: the narrator is
    // not configured in this process, so a run that reached a transport would
    // have to have been handed one. Both audiences refuse, and nothing was
    // posted anywhere.
    const store = recordingStore({ reports: [report()] })
    const { res } = await call({ kind: 'reports', id: 'r1', action: 'briefings' }, {
      body: {
        audiences: ['district_officer'],
        env: { ...ENV_ON, OLLAMA_BASE_URL: 'http://attacker.invalid' },
        http: 'not-a-function',
        now: '1999-01-01T00:00:00Z',
      },
      store,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().narrated, 0, 'a body-supplied env reached the narrator')
    assert.match(res.json().briefings[0].reason, /not configured/)
    assert.equal(res.json().briefings[0].generated_at === '1999-01-01T00:00:00Z', false,
      'a body-supplied `now` reached the narrator')
  })

  it('sends the model call to the server\'s base URL, not the body\'s', async () => {
    // The positive half of the same property, with the transport injectable.
    // `handleReportingRoute` takes no transport, so this drives the module the
    // route calls with the same option set the handler builds, and asserts the
    // URL the environment named is the one used.
    const { calls, http } = recordingNarrator()
    const { narrateBriefings } = await import('../src/briefing.js')
    const out = await narrateBriefings(report(), { audiences: ['district_officer'], env: ENV_ON, http, now: '2026-01-01T00:00:00Z' })
    assert.equal(out.narrated, 1, `the briefing did not narrate: ${out.briefings[0]?.reason}`)
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:11434\//)
  })
})
