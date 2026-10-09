import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { NARRATOR_BASIS, narrateReport, narratorStatus, buildNarrativeRequest } from '../src/narrator.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

// The narrator reads its configuration at call time from the environment (the
// same per-request read the auth helpers do), so the integration tests set the
// env against the real server and restore it in `after` — the pattern the auth
// tests set.

/**
 * The report narrator — the smallest Qwen model writing one paragraph.
 *
 * The rule this module either keeps or breaks: **a generated sentence must not
 * generate a fact.** The narrator sees the report's own computed figures and
 * nothing else, restates them in plain English, and is refused — by code, not
 * by hope — when it invents a number, claims more than the agreed length, or
 * writes nothing. Every refused case is a REFUSAL the report records, not an
 * exception a caller must survive; and a narrator that is not configured is a
 * report with its computed sections and no commentary, which is a fine report.
 */

const REPORT = {
  id: 'report_test_1',
  template_id: 'tmpl-1',
  report_type: 'situation_report',
  status: 'ready',
  title: 'SITREP - KE - 2026-10-09',
  scope: { country: 'KE' },
  section_ids: [],
  sections: [
    {
      id: 'executive_summary',
      title: 'Executive summary',
      type: 'deterministic_summary',
      content: {
        summary: 'SITREP - KE - 2026-10-09 covers 14 events, 3 high/critical risks, 4 open incidents, 6 active interventions, and 40 field reports.',
        metrics: {
          events: 14,
          high_or_critical_risks: 3,
          open_incidents: 4,
          active_interventions: 6,
          field_reports: 40,
        },
        items: [],
        source_refs: [],
        markdown: 'SITREP - KE - 2026-10-09 covers 14 events, 3 high/critical risks, 4 open incidents, 6 active interventions, and 40 field reports.',
      },
      source_refs: [],
      generated_at: '2026-10-09T07:00:00.000Z',
      warnings: [],
    },
    {
      id: 'incident_summary',
      title: 'Incident summary',
      type: 'deterministic_summary',
      content: {
        summary: '4 incidents open of 9 total; 2 in monitoring status.',
        metrics: { total: 9, open: 4, monitoring: 2 },
        items: [{ title: 'Flood cut the Mandera road', severity: 'high' }],
        source_refs: [],
        markdown: '4 incidents open of 9 total; 2 in monitoring status.',
      },
      source_refs: [],
      generated_at: '2026-10-09T07:00:00.000Z',
      warnings: [],
    },
  ],
  source_refs: [],
  warnings: [],
  narrative: {},
  generated_at: '2026-10-09T07:00:00.000Z',
  approved_at: null,
  distributed_at: null,
  owner: 'ops',
  created_at: '2026-10-09T07:00:00.000Z',
  updated_at: '2026-10-09T07:00:00.000Z',
  metadata: {},
}

/** A transport standing in for Ollama, with the words the little model says. */
const olisha = (text) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ model: 'qwen3:0.6b', response: text }),
})

const ENV_ON = { LINDELA_LITE_NARRATOR: '1', OLLAMA_BASE_URL: 'http://ollama-test:11434' }
const ENV_OFF = {}

describe('narratorStatus is config, not opinion', () => {
  it('is off until an operator switches it on', () => {
    assert.equal(narratorStatus(ENV_OFF).enabled, false)
    assert.equal(narratorStatus(ENV_ON).enabled, true)
    const status = narratorStatus(ENV_ON)
    assert.equal(status.model, 'qwen3:0.6b', 'the default is the smallest Qwen, named')
    assert.equal(narratorStatus({ ...ENV_ON, LINDELA_LITE_NARRATOR_MODEL: 'qwen2.5:0.5b' }).model, 'qwen2.5:0.5b')
  })

  it('carries a model basis a reader can hold the model to', () => {
    assert.match(NARRATOR_BASIS.basis, /Qwen/)
    assert.match(NARRATOR_BASIS.not, /figures/i, 'the basis says what the text is not — a source of figures')
  })
})

describe('the prompt carries the facts and forbids invention', () => {
  it('the digest is built from the report\u2019s own computed sections', () => {
    const built = buildNarrativeRequest(REPORT)
    assert.match(built.prompt, /14 events/)
    assert.match(built.prompt, /4 incidents open/)
    assert.match(built.prompt, /SITREP - KE - 2026-10-09/)
  })

  it('the allowed numbers are exactly the digest\u2019s numbers', () => {
    const built = buildNarrativeRequest(REPORT)
    assert.ok(built.allowedNumbers.has('14'))
    assert.ok(built.allowedNumbers.has('9'))
    assert.ok(built.allowedNumbers.has('2026'))
    assert.ok(built.allowedNumbers.has('120') === false, 'prompt boilerplate must not leak into the allowed set')
  })
})

describe('narrateReport', () => {
  it('writes the paragraph, checks every figure, and says what wrote it', async () => {
    const out = await narrateReport(REPORT, {
      env: ENV_ON,
      http: olisha('Four incidents remain open, with two more in monitoring. Field teams logged 40 reports this week.'),
    })
    assert.equal(out.status, 'narrated')
    assert.equal(out.model, 'qwen3:0.6b')
    assert.match(out.text, /Four incidents remain open/)
    assert.equal(out.numbers_checked, 1, 'one digit figure (40) restated; word-numbers are not figures')
  })

  it('an unconfigured narrator is a refusal, not an outage', async () => {
    const out = await narrateReport(REPORT, { env: ENV_OFF, http: olisha('unused') })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /not configured/)
  })

  it('a transport failure is a refusal carrying the reason', async () => {
    const out = await narrateReport(REPORT, { env: ENV_ON, http: async () => { throw new Error('connect ECONNREFUSED') } })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /ECONNREFUSED|could not be reached/)
  })

  it('an HTTP 503 from the model server is a refusal, not a crash', async () => {
    const out = await narrateReport(REPORT, {
      env: ENV_ON,
      http: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /503/)
  })

  it('an empty model reply is refused: nothing is a fine commentary, invented text is not', async () => {
    const out = await narrateReport(REPORT, { env: ENV_ON, http: olisha('   ') })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /empty/)
  })

  it('a thinking-channel reply names the fix, not just the emptiness', async () => {
    // A thinking-capable Qwen with thinking still on burns the budget on the
    // reasoning channel. The refusal must say how to serve the model, because
    // "empty reply" reads as a broken model when the model is fine.
    const out = await narrateReport(REPORT, {
      env: ENV_ON,
      http: async () => ({ ok: true, status: 200, json: async () => ({ model: 'qwen3.5:0.8b', response: '', thinking: 'The facts state 14 events...' }) }),
    })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /thinking channel/)
    assert.match(out.reason, /think/)
  })

  it('an invented figure is refused, naming the figure', async () => {
    const out = await narrateReport(REPORT, {
      env: ENV_ON,
      http: olisha('Four incidents remain open and 1500 households are affected this week.'),
    })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /1500/, 'the reader must see exactly which figure the model made up')
  })

  it('a runaway model is refused on length, not truncated into a lie', async () => {
    const out = await narrateReport(REPORT, {
      env: ENV_ON,
      http: olisha('Incidents open. ' + 'Context remains fluid. '.repeat(400)),
    })
    assert.equal(out.status, 'refused')
    assert.match(out.reason, /length/)
  })
})

// ---------------------------------------------------------------------------
// The real route, against a real Ollama-shaped server on localhost.
// No mocks: the transport is real HTTP; only the MODEL is local fiction.
// ---------------------------------------------------------------------------

describe('POST /api/v1/reports/:id/narrate', () => {
  let listener
  let base
  let dir
  let upstream
  let upListener
  let upstreamLastBody
  let savedEnv

  const ENV_KEYS = ['LINDELA_LITE_NARRATOR', 'OLLAMA_BASE_URL']

  before(async () => {
    // A real Ollama-shaped server: /api/generate speaks the generate contract.
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        upstreamLastBody = JSON.parse(body || '{}')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamLastBody.model, response: 'Four incidents remain open, with 2 in monitoring. Field teams logged 40 reports.' }))
      })
    })
    upListener = upstream.listen(0)
    // The narrator reads OLLAMA_BASE_URL per request, so the env carries the
    // ephemeral port and the feature switch is on for the whole describe.
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    process.env.LINDELA_LITE_NARRATOR = '1'
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${upListener.address().port}`
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-narrator-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.write({
      reports: [REPORT],
      report_templates: [{ id: 'tmpl-1', name: 'SITREP', report_type: 'situation_report', sections: ['executive_summary', 'incident_summary'], status: 'active', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    })
    listener = createServer({ store }).listen(0)
    base = `http://localhost:${listener.address().port}`
  })

  after(async () => {
    listener?.close()
    upListener?.close()
    for (const [key, value] of Object.entries(savedEnv || {})) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('narrates through the real transport and merges one model-commentary section', async () => {
    const res = await fetch(`${base}/api/v1/reports/${REPORT.id}/narrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'demo' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.data.narrative.status, 'narrated')
    assert.equal(body.data.narrative.model, 'qwen3:0.6b')
    const section = body.data.sections.find((s) => s.type === 'model_narrative')
    assert.ok(section, 'the narrative rides as a section the console can render')
    assert.equal(section.id, 'model_commentary')
    assert.match(section.content.summary, /Four incidents remain open/)
    assert.equal(upstreamLastBody.model, 'qwen3:0.6b', 'the request named the smallest Qwen')
    assert.equal(upstreamLastBody.options?.temperature, 0, 'deterministic generation, not a mood')
  })

  it('the route is refused while auth stays on and no token is presented', async () => {
    // Deny-by-default holds for the narrator route like every mutation: a
    // token must be presented and its scope must cover write:reports (via the
    // /api/v1/reports prefix the scope table already maps).
    const { createServer: freshServer } = await import('../src/server.js')
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-narrator-auth-'))
    try {
      const store2 = new JsonStore(path.join(dir2, 'store.json'))
      await store2.write({ reports: [REPORT] })
      const previous = process.env.LINDELA_LITE_API_KEY
      process.env.LINDELA_LITE_API_KEY = 'key-narrator-test'
      const listener2 = freshServer({ store: store2 }).listen(0)
      try {
        const res = await fetch(`http://localhost:${listener2.address().port}/api/v1/reports/${REPORT.id}/narrate`, { method: 'POST' })
        assert.equal(res.status, 401)
      } finally {
        listener2.close()
        if (previous === undefined) delete process.env.LINDELA_LITE_API_KEY
        else process.env.LINDELA_LITE_API_KEY = previous
      }
    } finally {
      await fs.rm(dir2, { recursive: true, force: true })
    }
  })

  it('narrating a report with no generated sections is a 400 with the reason', async () => {
    const { createServer: freshServer } = await import('../src/server.js')
    const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-narrator-empty-'))
    try {
      const store3 = new JsonStore(path.join(dir3, 'store.json'))
      await store3.write({ reports: [{ ...REPORT, sections: [] }] })
      const listener3 = freshServer({ store: store3 }).listen(0)
      try {
        const res = await fetch(`http://localhost:${listener3.address().port}/api/v1/reports/${REPORT.id}/narrate`, { method: 'POST' })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.match(body.error, /nothing computed to narrate|Generate the report first/)
      } finally {
        listener3.close()
      }
    } finally {
      await fs.rm(dir3, { recursive: true, force: true })
    }
  })

  it('narrator off: the route answers, the refusal is recorded, the sections are untouched', async () => {
    const { createServer: freshServer } = await import('../src/server.js')
    const dir4 = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-narrator-off-'))
    try {
      const store4 = new JsonStore(path.join(dir4, 'store.json'))
      await store4.write({ reports: [REPORT] })
      const previous = process.env.LINDELA_LITE_NARRATOR
      delete process.env.LINDELA_LITE_NARRATOR
      const listener4 = freshServer({ store: store4 }).listen(0)
      try {
        const res = await fetch(`http://localhost:${listener4.address().port}/api/v1/reports/${REPORT.id}/narrate`, { method: 'POST' })
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.data.narrative.status, 'refused')
        assert.match(body.data.narrative.reason, /not configured/)
        assert.equal((body.data.sections || []).filter((s) => s.type === 'model_narrative').length, 0)
      } finally {
        listener4.close()
        if (previous === undefined) delete process.env.LINDELA_LITE_NARRATOR
        else process.env.LINDELA_LITE_NARRATOR = previous
      }
    } finally {
      await fs.rm(dir4, { recursive: true, force: true })
    }
  })
})