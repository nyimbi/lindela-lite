/**
 * OBS-01 — `logger.error(fields, message)` is not the signature.
 *
 * `logger` is `(event, fields)`: `logEvent` does `{ ts, level, event, ...fields }`.
 * Called the other way round, the *fields object* became the event name and the
 * message string was spread as the fields — and spreading a string yields
 * `{"0":"o","1":"u","2":"t",...}`, one key per character. The log line was
 * valid JSON, carried no `event`, named no failure, and lost every field it was
 * supposed to carry. Eight call sites had it, including the 500-handler and all
 * three outbox-emit failures.
 *
 * The signature cannot be type-checked here (no TypeScript), so this reads the
 * source. It is deliberately structural: an object literal as the first
 * argument is the defect, whatever the object contains.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { logger } from '../src/observability.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const METHODS = 'error|warn|info|debug'

/**
 * Source files that call the logger.
 *
 * Scoped to JavaScript, and that scoping is load-bearing: the audit artifacts
 * in `docs/` quote the defect verbatim — `logger.error({ err })` appears in
 * prose in four files — and an unscoped scan reported those quotations as four
 * live defects. The jurisdiction of this check is code, not the corpus that
 * describes it.
 */
function sourceFiles() {
  const out = execFileSync('rg', [
    '-l',
    '--glob', 'src/**/*.js',
    '--glob', 'public/**/*.js',
    '--glob', 'scripts/**/*.mjs',
    `logger\\.(${METHODS})\\(`,
    'src', 'public', 'scripts',
  ], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

/**
 * Call sites whose first argument is an object literal rather than a string.
 *
 * A regex over the raw text, not a parse: the defect is a shape that appears
 * verbatim in the source, and a parse would have to model the whole module to
 * answer a question about one argument.
 */
function invertedCalls(source) {
  const pattern = new RegExp(`logger\\.(${METHODS})\\(\\s*\\{`, 'g')
  const found = []
  for (const match of source.matchAll(pattern)) {
    found.push(source.slice(match.index, match.index + 80).split('\n')[0])
  }
  return found
}

describe('OBS-01 — the logger is called (event, fields), never (fields, message)', () => {
  it('finds no call site that passes an object literal as the event', () => {
    const offenders = []
    for (const file of sourceFiles()) {
      for (const call of invertedCalls(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
        offenders.push(`${file}: ${call}`)
      }
    }
    assert.deepEqual(offenders, [],
      'logger.<level> takes the event name first; an object literal there becomes the event and its message is spread as fields')
  })

  it('the scanner sees a call it is supposed to see, and misses one it is not', () => {
    // Canary. A scanner that matches nothing passes forever, and this one is
    // the only thing standing between the codebase and eight more of these.
    assert.equal(invertedCalls("logger.error({ err: e }, 'boom')").length, 1)
    assert.equal(invertedCalls('logger.error(\n  { err: e },\n  "boom",\n)').length, 1)
    assert.equal(invertedCalls("logger.error('boom', { err: e })").length, 0)
    assert.equal(invertedCalls("logger.info('http_request', { route })").length, 0)
  })

  it('actually scans the files it claims to, so an empty scan is a failure not a pass', () => {
    // The other half of the canary: `sourceFiles()` returning `[]` would make
    // the assertion above vacuous.
    const files = sourceFiles()
    assert.ok(files.length >= 6, `expected to scan the source tree, scanned ${files.length} files`)
    assert.ok(files.includes('src/server.js'), 'src/server.js calls the logger and must be scanned')
    assert.ok(files.includes('src/outbox.js'), 'src/outbox.js calls the logger and must be scanned')
  })

  it('the logger envelope wins over a field of the same name', () => {
    // The second half of OBS-01. Renaming the call sites' `event:` fields to
    // `outbox_event:` fixes the instances; spreading `fields` last is what made
    // the collision possible at all, and a new call site could reintroduce it.
    // The envelope keys belong to the logger.
    const original = process.stderr.write
    const lines = []
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
    try {
      logger.error('the_real_event', { event: 'a_payload_value', level: 'nonsense', ts: 'not-a-timestamp' })
    } finally {
      process.stderr.write = original
    }
    const line = JSON.parse(lines[0])
    assert.equal(line.event, 'the_real_event', 'the event name must survive a field named `event`')
    assert.equal(line.level, 'error', 'the level must survive a field named `level`')
    assert.notEqual(line.ts, 'not-a-timestamp', 'the timestamp must survive a field named `ts`')
  })
})
