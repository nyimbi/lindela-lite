import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

/**
 * R-14 — the container ran as root, shipped more than it needed to, and served
 * its own documentation to anyone who could reach the port.
 *
 * Three parts, and the middle one is the reason the other two matter: an
 * attacker who has code execution inside the container is a root user in it,
 * and a root user in a container that ships the deployment's architecture is a
 * briefing pack.
 *
 * The docs gate is the behavioural half and is asserted over HTTP. The image
 * halves are asserted against the build inputs, because a Dockerfile is only
 * ever exercised by building it, and a build is not in the test suite — so the
 * next person to add a `COPY` learns from a failing test rather than from a
 * finding.
 */

async function withServer(fn, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-r14-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const listener = createServer({ store }).listen(0)
  const base = `http://localhost:${listener.address().port}`
  try {
    return await fn(base)
  } finally {
    listener.close()
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key]
    }
    Object.assign(process.env, saved)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('R-14 — the deployment documentation is not public', () => {
  it('GET /docs needs a token when auth is configured', async () => {
    const apiKey = 'r14-canary-key-0123456789'
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/docs`)
      assert.equal(anonymous.status, 401,
        'the docs are served from the image to anyone who can reach the port: an ' +
        'unauthenticated map of the deployment\'s store, ports and schedule structure')

      const authed = await fetch(`${base}/docs`, { headers: { 'x-api-key': apiKey } })
      assert.equal(authed.status, 200,
        'a valid token must still reach the docs — the gate is a control, not a removal')
    }, { LINDELA_LITE_API_KEY: apiKey, LINDELA_LITE_TOKENS: '' })
  })

  it('the gate holds for a file under /docs, not only the index', async () => {
    // A prefix check on the index and a check on each file are two controls, and
    // the second is the one an attacker uses: they know a filename.
    const apiKey = 'r14-canary-key-0123456789'
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/docs/platform.md`)
      assert.equal(anonymous.status, 401, 'the gate must cover every path under /docs')
      const authed = await fetch(`${base}/docs/platform.md`, { headers: { 'x-api-key': apiKey } })
      assert.equal(authed.status, 200)
    }, { LINDELA_LITE_API_KEY: apiKey, LINDELA_LITE_TOKENS: '' })
  })

  it('unauthenticated local mode still reads the docs', async () => {
    // "No tokens configured" is a deliberate mode — a laptop run, a fixture — so
    // a gate that made it a 401 everywhere would break local development to
    // secure a deployment that has opted into nothing.
    await withServer(async (base) => {
      const res = await fetch(`${base}/docs`)
      assert.equal(res.status, 200)
    }, { LINDELA_LITE_API_KEY: '', LINDELA_LITE_TOKENS: '' })
  })
})

describe('R-14 — the image runs as a user, and ships what it needs', () => {
  const dockerfile = readFileSync(path.join(import.meta.dirname, '..', 'Dockerfile'), 'utf8')
  const dockerignore = readFileSync(path.join(import.meta.dirname, '..', '.dockerignore'), 'utf8')

  it('the runtime user is not root', () => {
    assert.match(dockerfile, /^USER\s+(?!root)\S+/m,
      'the container runs as root, so code execution inside it is root inside it')
    // `USER` before the final CMD is what matters; a USER line in a build stage
    // that nothing inherits would satisfy the regex and change nothing.
    const userLine = dockerfile.search(/^USER\s+/m)
    const cmdLine = dockerfile.search(/^CMD\s+/m)
    assert.ok(userLine > 0 && userLine < cmdLine,
      'the USER directive must be in the final stage, ahead of CMD')
  })

  it('the one writable path the app needs is prepared for that user', () => {
    // A non-root user with no writable directory cannot start: the JSON store
    // writes to data/ and the calibration artefacts beside it. Making the image
    // read-only and preparing one directory is the whole of the change.
    assert.match(dockerfile, /mkdir -p \/app\/data/,
      'the app writes to /app/data; without it prepared, USER lindela cannot boot')
    assert.match(dockerfile, /chown .*\/app\/data/,
      'and it has to belong to the user that runs the app')
  })

  it('local state directories are not copied into the image', () => {
    for (const entry of ['.omc', '.claude', '.git', 'node_modules', 'data', '.env']) {
      assert.ok(dockerignore.split('\n').includes(entry),
        `.dockerignore does not list ${entry}, so the build context sends it to the daemon`)
    }
    assert.ok(!/^COPY\s+\.omc/m.test(dockerfile),
      'an explicit COPY of a local state directory defeats the ignore list')
  })
})
