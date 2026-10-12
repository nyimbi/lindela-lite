#!/usr/bin/env node
/**
 * A route family is shadowed when the dispatcher still carries its path.
 *
 * ENH-60 has been moving route families out of `handleApiRequestInContext` for
 * months, and the extraction has a failure mode nothing checked: a family's
 * matcher can name a path that an **inline literal above it in the dispatcher**
 * also serves. The dispatcher runs first and returns, so the family's handler is
 * never reached — and every test of the family as a module still passes, because
 * the module is correct. What is wrong is that nothing calls it.
 *
 * That is not hypothetical. `GET /api/v1/service-assets` was served by an inline
 * block at `src/server.js:1626` while `matchOperationalRoute` had served the same
 * path since the family was extracted. The inline copy hard-filtered
 * `!isDeleted(item)` and ignored `?include_deleted=true`; the family's branch
 * honours it. So the flag worked on all six sibling collections and silently did
 * nothing on the seventh, and `test/operational-route-module.test.js` — which
 * asserts the contract on the family — stayed green throughout.
 *
 * Two checks, because the bug has two halves:
 *
 *   - **behavioural** — the flag does what the family's contract says it does,
 *     over a live server, which is the only place a shadow is visible;
 *   - **structural** — no family matcher's path is also an inline literal in the
 *     dispatcher, except the ones named below with a reason. A static check
 *     because the next shadow is a path nobody thought to write a request test
 *     for, and the collision is visible in the source before it is visible in
 *     any response.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Inline literals in the dispatcher that collide with a family matcher, and are
 * allowed to.
 *
 * An allowlist rather than a filter, so a new collision fails this test and the
 * author has to say why it is not a shadow. The bar: the inline block must not
 * be a route — it must be a precondition that falls through to the family.
 */
const ALLOWED_COLLISIONS = {
  '/api/v1/rapidpro/field-report':
    'an auth precondition, not a route: it buffers the body and verifies the HMAC, then falls through to the family. Deleting it would break signature verification rather than unshadow anything.',
}

/**
 * The dispatcher's own line range, by brace matching from its declaration.
 *
 * Read from the source rather than hardcoded, because a hardcoded range is the
 * rot the register catalogues: ARC-08's evidence cited `src/server.js:4344` in a
 * 2,366-line file. A range that moves silently would make this check pass over
 * an empty set.
 */
function dispatcherBody(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /function handleApiRequestInContext\(/.test(line))
  assert.ok(start >= 0, 'handleApiRequestInContext is gone; this check no longer knows where the dispatcher is')
  let depth = 0
  let end = -1
  for (let n = start; n < lines.length; n += 1) {
    for (const ch of lines[n]) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (n > start && depth === 0) { end = n; break }
  }
  assert.ok(end > start, 'the dispatcher body never closed; the brace match is wrong')
  return { text: lines.slice(start, end + 1).join('\n'), start: start + 1, end: end + 1 }
}

/** The body of one `match*Route` function, by brace matching from its `{`. */
function matcherBody(source, declIndex) {
  let depth = 0
  const open = source.indexOf('{', declIndex)
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/**
 * Every path a family matcher can serve, by the three spellings they use.
 *
 * All three are read because reading fewer is how a checker reports a family as
 * serving nothing and passes — the failure the register calls "a checker for
 * 'every X' that enumerates one of the two ways to write X".
 */
function familyPaths() {
  const out = new Map()
  const dir = path.join(ROOT, 'src', 'routes')
  const add = (p, name) => {
    if (!out.has(p)) out.set(p, new Set())
    out.get(p).add(name)
  }
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    const decl = /^(?:export\s+)?function (match[A-Za-z]+Route)\(/m.exec(source)
    if (!decl) continue
    const body = matcherBody(source, decl.index)
    // `pathname === '/api/v1/x'`
    for (const m of body.matchAll(/pathname\s*===\s*'([^']+)'/g)) add(m[1], name)
    // `pathname.match(/^\/api\/v1\/x(?:\/([^/]+))?$/)` — the literal prefix.
    for (const m of body.matchAll(/\.match\((\/\^.*?\/[a-z]*)\)/g)) {
      const literal = m[1].replace(/\\\//g, '/').replace(/^\//, '').replace(/\/[a-z]*$/, '')
      const base = literal.split(/[\\^$*+?()[\]{}|]/)[0].replace(/\/$/, '')
      if (base.startsWith('/api/')) add(base, name)
    }
    // `const routes = { incidents: 'incidents', … }` — the operational spelling.
    for (const map of body.matchAll(/const routes = \{([^}]*)\}/g)) {
      for (const key of map[1].matchAll(/'?([A-Za-z][\w-]*)'?\s*:/g)) add(`/api/v1/${key[1]}`, name)
    }
  }
  return out
}

describe('a family route is not shadowed by an inline dispatcher block', () => {
  let baseUrl
  let listener
  let savedTokens

  before(async () => {
    // A token, because `include_deleted` is a read widening and an unauthenticated
    // deployment would answer the same either way — the probe would measure
    // nothing. JSON, because a malformed value disables authentication rather
    // than weakening it (src/auth.js).
    savedTokens = process.env.LINDELA_LITE_TOKENS
    process.env.LINDELA_LITE_TOKENS = JSON.stringify([{ token: 'shadow-probe', scopes: ['*'] }])
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lindela-shadow-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    await store.write({
      service_assets: [
        { id: 'sa-live', name: 'Clinic A', service_type: 'clinic' },
        { id: 'sa-gone', name: 'Clinic B', service_type: 'clinic', deleted_at: '2026-01-01T00:00:00.000Z' },
      ],
      incidents: [
        { id: 'in-live', title: 'live', incident_type: 'flood' },
        { id: 'in-gone', title: 'gone', incident_type: 'flood', deleted_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
    const server = createServer({ store })
    listener = server.listen(0)
    baseUrl = `http://127.0.0.1:${listener.address().port}`
  })

  after(async () => {
    if (savedTokens === undefined) delete process.env.LINDELA_LITE_TOKENS
    else process.env.LINDELA_LITE_TOKENS = savedTokens
    await new Promise((resolve) => listener.close(resolve))
  })

  const list = async (p) => {
    const res = await fetch(`${baseUrl}${p}`, { headers: { 'x-api-key': 'shadow-probe' } })
    assert.equal(res.status, 200, `${p} answered ${res.status}`)
    const body = await res.json()
    return body.data.map((record) => record.id).sort()
  }

  it('honours include_deleted on service-assets, as it does on every sibling', async () => {
    // The bug, in one assertion. The inline copy hard-filtered, so the second
    // call returned one row where the family returns two.
    assert.deepEqual(await list('/api/v1/service-assets'), ['sa-live'],
      'the default listing did not hide the soft-deleted asset')
    assert.deepEqual(await list('/api/v1/service-assets?include_deleted=true'), ['sa-gone', 'sa-live'],
      'include_deleted=true did not widen the service-assets listing — an inline block is shadowing the family that honours it')
  })

  it('answers the sibling collection the same way, so the two are one contract', async () => {
    // The control. Without it, the assertion above could pass because the flag
    // is broken everywhere rather than because this route is correct.
    assert.deepEqual(await list('/api/v1/incidents'), ['in-live'])
    assert.deepEqual(await list('/api/v1/incidents?include_deleted=true'), ['in-gone', 'in-live'])
  })

  it('carries no inline dispatcher literal for a path a family matcher serves', () => {
    const { text, start, end } = dispatcherBody(fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8'))
    const inline = new Map()
    for (const m of text.matchAll(/url\.pathname\s*===\s*'([^']+)'/g)) {
      const line = start + text.slice(0, m.index).split('\n').length - 1
      if (!inline.has(m[1])) inline.set(m[1], line)
    }

    // The canary-in-reverse: a scan that parses nothing passes every assertion
    // below it, because an empty `inline` produces no shadows. This was a size
    // floor while three literals existed; ENH-60 moved two of them —
    // `demo/seed` and `maintenance/apply-retention` — into
    // `src/routes/maintenance.js`, and a floor of 1 is the number a *broken*
    // regex also returns whenever any single literal survives it. So the floor
    // is gone and the one literal that must be there is named instead.
    //
    // `/api/v1/rapidpro/field-report` is an auth precondition inside the
    // `isAuthConfigured()` block, not a route — it reads a pathname to decide
    // whether the caller may proceed, and it belongs inline. When it too is
    // gone, replace this with an assertion about `families`, not with `>= 0`.
    assert.ok(inline.has('/api/v1/rapidpro/field-report'),
      `the scan did not find the one literal that remains in src/server.js:${start}..${end} — it parsed ${inline.size}, so the regex is not reading the dispatcher`)

    const families = familyPaths()
    assert.ok(families.size >= 40, `parsed ${families.size} family paths, which is not the route surface`)

    const shadows = [...inline.keys()].filter((p) => families.has(p) && !(p in ALLOWED_COLLISIONS)).sort()
    assert.deepEqual(shadows, [], shadows.map((p) => [
      `${p} is served inline at src/server.js:${inline.get(p)} and also by ${[...families.get(p)].join(', ')}.`,
      'The dispatcher runs first and returns, so the family never handles it — and the family is the tested one.',
    ].join(' ')).join('\n'))
  })
})
