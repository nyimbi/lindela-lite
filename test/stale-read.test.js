import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { staleReadNote } from '../public/shared/states.js'
import { markReadProvenance, readProvenance } from '../public/shared/runtime.js'

/**
 * A dead server is not the same as an answer.
 *
 * The service worker caches API GETs so the console works offline. With the
 * server gone it therefore *answers* — with yesterday's records — and every
 * surface downstream sees a successful response. `distinguishFailure` cannot
 * help: a successful response is a successful response.
 *
 * What that cost, found by the dead-server gate: the partner portal displayed
 * "Authentication is not configured", a claim about the server's configuration,
 * while the server was dead and the worker was answering from its bucket. A
 * partner would re-key a token that was never the problem, and a focal point
 * would approve pre-agreed finance against a stale queue presented as current.
 *
 * The fix is three small things, and the tests are on each:
 *
 *   1. `apiFetch` reads the worker's staleness marker on the **success** path.
 *      It was read on the error path — which is backwards, because the error was
 *      already visible as a throw, and the cached success was not.
 *   2. The marker rides on the payload as a non-enumerable property, so nothing
 *      that spreads, serialises or deep-compares a payload changes shape.
 *   3. `staleReadNote` turns it into words, built from the ERROR vocabulary so a
 *      surface is not offered a second failure phrasing to keep in step.
 */

const live = () => markReadProvenance({ data: [{ id: 'a' }] }, { servedFromCache: false })
const cached = (storedAt = '2024-03-05T10:00:00.000Z') =>
  markReadProvenance({ data: [{ id: 'a' }] }, { servedFromCache: true, storedAt })

describe('a cached read is distinguishable from a live one', () => {
  it('a live read says nothing about staleness', () => {
    assert.equal(staleReadNote(live()), null,
      'the common case must cost nothing: a caller writes `note ?? \'\'`')
    assert.equal(readProvenance(live()).live, true)
  })

  it('a cached read is marked, with when it was stored', () => {
    const provenance = readProvenance(cached())
    assert.equal(provenance.servedFromCache, true)
    assert.equal(provenance.live, false)
    assert.equal(provenance.storedAt, '2024-03-05T10:00:00.000Z')
  })

  it('the marker does not change the payload\'s shape', () => {
    // These payloads are spread, serialised and deep-compared all over the front
    // end. An enumerable marker would appear in a rendered record and in every
    // equality assertion downstream.
    const payload = cached()
    assert.deepEqual(Object.keys(payload), ['data'])
    assert.equal(JSON.stringify(payload), '{"data":[{"id":"a"}]}')
    assert.deepEqual({ ...payload }, { data: [{ id: 'a' }] })
  })

  it('a frozen payload is not a failed read', () => {
    const frozen = Object.freeze({ data: [] })
    assert.equal(markReadProvenance(frozen, { servedFromCache: true }), frozen)
  })

  it('a primitive payload is returned unchanged', () => {
    assert.equal(markReadProvenance(null, { servedFromCache: true }), null)
    assert.equal(staleReadNote(undefined), null)
  })
})

describe('the note says the two things a reader needs', () => {
  const note = staleReadNote(cached(), { subject: 'The pending approvals' })

  it('names the fact: the server was not reached', () => {
    assert.match(note.title + note.body, /could not be reached|has not answered|Showing the last known state/,
      'a banner reading "data may be stale" without saying the server was not reached ' +
      'leaves the reader to guess whether the data or the connection is the problem')
  })

  it('stops the conclusion the reader would otherwise draw', () => {
    assert.match(note.body, /out of date|not current|do not read this as current/i,
      'yesterday\'s approvals rendered as today\'s is a decision made on stale numbers, ' +
      'and the note has to be the thing that prevents it')
  })

  it('offers the way out', () => {
    assert.equal(note.retryable, true)
    assert.ok(note.action, 'a warning with no retry is a complaint')
  })

  it('is a warning, not an error', () => {
    // Treating a cached answer as an error would blank eleven panels because one
    // endpoint was answered from cache — the opposite of what this is for.
    assert.equal(note.tone, 'warning')
  })

  it('accepts a translation and falls back to English', () => {
    const translated = staleReadNote(cached(), { t: (key) => `sw:${key}` })
    assert.match(translated.title, /^sw:/)
    assert.match(translated.body, /^sw:/)
    const english = staleReadNote(cached(), { t: (key) => key })
    assert.equal(english.title, 'state.served_from_cache_title',
      'a catalogue that has not caught up must produce English, not a key')
  })
})

describe('the surfaces that act on cached data say so', () => {
  const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8')

  for (const [surface, file] of [
    ['portal', 'portal/app.js'],
    ['focal-point', 'focal-point/app.js'],
    ['chw', 'chw/app.js'],
  ]) {
    it(`${surface} renders the staleness note rather than only the data`, () => {
      const src = read(file)
      assert.match(src, /staleReadNote\(/,
        `${surface} renders records the service worker answered from cache, with nothing ` +
        'on screen saying the server was not reached — which is the claim it cannot support')
      assert.match(src, /retry-btn/,
        `${surface} shows a staleness notice with no way to re-read`)
    })
  }

  it('the portal withdraws its configuration claim on a cached read', () => {
    const src = read('portal/app.js')
    assert.match(src, /renderIdentityFailure\(null, \{ stale \}\)/,
      'the portal said "Authentication is not configured" while the server was dead; ' +
      'a cached identity answer has to take the same path as a failed one')
  })
})
