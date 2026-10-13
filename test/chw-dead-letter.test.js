import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { HELD, describeState } from '../public/shared/states.js'

/**
 * R-60. A report the queue gave up on was invisible, and a worker who files the
 * same observation twice because the first one vanished is worse off than one
 * who is told it is stuck.
 *
 * `queue-core.js` has had the whole mechanism for a while: `MAX_QUEUE_ATTEMPTS`,
 * `markRetry` setting `failed`, `claimBatch` skipping a failed record, and
 * `pendingCount()` filtering them out. `runtime.js` exposes `list({failed:true})`,
 * `retry(id)` and `discard(id)`. Every one of those was tested and **none of them
 * had a caller** — `refreshQueueStatus()` asked only `pendingCount()`, and
 * `pendingCount()` excludes dead letters by definition, so a phone holding two
 * reports the server has refused eight times each rendered exactly like a phone
 * holding nothing at all.
 *
 * The tests here are of two kinds and both are needed. The first drives the copy
 * — a dead letter is not "queued", and saying so is the whole feature. The
 * second reads `app.js` and asserts the surface actually calls the three methods,
 * because the failure being fixed is a missing call site and a test that only
 * exercises the copy would pass against the old file.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

describe('HELD — a record the queue has given up on', () => {
  it('is its own state, not queued and not an error', () => {
    assert.equal(HELD, 'held')
    assert.notEqual(HELD, 'queued')
    assert.notEqual(HELD, 'error')
  })

  it('says the server refused it, and does not call that "not sent yet"', () => {
    const copy = describeState(HELD, { heldCount: 2 })
    assert.match(copy.body, /refused/i,
      'a dead letter was attempted and rejected; "will be sent when the connection returns" is false for it')
    assert.doesNotMatch(copy.title, /not sent yet/i)
  })

  it('says the report is still on the phone, because it is', () => {
    const copy = describeState(HELD, { heldCount: 1 })
    assert.match(copy.body, /this device|this phone/i)
  })

  it('agrees with the count, because this is read aloud', () => {
    const one = describeState(HELD, { heldCount: 1 })
    const many = describeState(HELD, { heldCount: 3 })
    assert.match(one.title, /\b1\b/)
    assert.match(many.title, /\b3\b/)
    assert.doesNotMatch(one.title, /\b3\b/)
    assert.doesNotMatch(one.body, /\b3\b/)
    // Both bodies are the same sentence, so the plural is distinguished by the
    // title and by the pronoun agreement, not by a second numeral.
    assert.match(many.body, /they|these/i, 'the plural body agrees with the plural subject')
    assert.match(one.body, /it\b/i, 'the singular body agrees with the singular subject')
  })

  it('does not offer a retry button in the copy — the surface renders one per record', () => {
    // A single retry-all affordance would re-send every dead letter at once, and
    // the reason they are dead is usually per-record (a 4xx the server will
    // refuse identically). The way forward is a control on each row.
    const copy = describeState(HELD, { heldCount: 2 })
    assert.equal(copy.retryable, false)
  })

  it('reads as a sentence with no count at all rather than as a blank', () => {
    const copy = describeState(HELD, {})
    assert.ok(copy.title.length > 0)
    assert.ok(copy.body.length > 0)
  })
})

describe('R-60 — the CHW surface asks for what the queue is holding', () => {
  /**
   * The source with its comments removed.
   *
   * The first version of these assertions matched the doc comment above
   * `refreshQueueStatus`, which explains the defect by quoting the call —
   * `list({failed:true})`, `retry(id)` — so reverting the actual call still
   * passed 11/11 and the canary said the gate was blind. It was: a check that
   * a comment can satisfy is a check on the comment. Prose about a call site is
   * not a call site.
   */
  const code = read('public/chw/app.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('lists the failed records, not only the pending count', () => {
    assert.match(code, /\.list\?*\.\(\s*\{\s*failed:\s*true\s*\}\s*\)/,
      'nothing in the product calls list({failed:true}), so a dead letter has no surface')
  })

  it('offers a way to retry one', () => {
    // The property is "the surface calls it with a record id", not one spelling
    // of the call. The file's idiom is optional-call against a `window` global
    // that may not exist yet, so `retry?.(id)` is the correct form here.
    assert.match(code, /\.retry\?*\.\(\s*id\s*\)/, 'retry(id) has no caller')
  })

  it('offers a way to discard one', () => {
    assert.match(code, /\.discard\?*\.\(\s*id\s*\)/, 'discard(id) has no caller')
  })

  it('names the record by what it is, not by its URL', () => {
    // `enqueue(path, options, { what })` stores the noun precisely so the list
    // can say "incident report" rather than "POST /api/v1/chw/report".
    assert.match(code, /record\?*\.what|\.what\b/,
      'the list must use the stored noun; a path is not a name a health worker recognises')
  })

  it('keeps the pending state reachable — a dead letter must not replace it', () => {
    assert.match(code, /pendingCount/, 'the queued count still has to render when there are no failures')
  })
})
