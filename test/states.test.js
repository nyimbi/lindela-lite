import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY,
  ERROR,
  OK,
  QUEUED,
  describeState,
  distinguishCollection,
  distinguishFailure,
} from '../public/shared/states.js'

describe('distinguishFailure', () => {
  it('returns ok when the request succeeded and returned rows', () => {
    assert.equal(distinguishFailure({ ok: true, isEmpty: false }), OK)
  })

  it('returns empty only when the request succeeded and returned nothing', () => {
    assert.equal(distinguishFailure({ ok: true, isEmpty: true }), EMPTY)
  })

  it('lets an error beat an empty reading', () => {
    // The bug in one expression. A caller that has both a failure and a zero
    // length array in hand — which is what a `catch`-and-return-[] loader
    // produces — must land on error, or the empty state is rendered for a
    // request that never got an answer.
    assert.equal(distinguishFailure({ ok: false, error: new Error('boom'), isEmpty: true }), ERROR)
    assert.equal(distinguishFailure({ ok: true, error: new Error('boom'), isEmpty: true }), ERROR)
    assert.equal(distinguishFailure({ ok: true, error: new Error('boom'), isEmpty: false }), ERROR)
  })

  it('treats a request that never completed as an error with no exception', () => {
    assert.equal(distinguishFailure({ ok: false, error: null, isEmpty: true }), ERROR)
    assert.equal(distinguishFailure({}), ERROR)
  })

  it('never returns empty for any input that is not a confirmed success', () => {
    const cases = [
      { ok: false, isEmpty: true },
      { ok: false, isEmpty: false },
      { ok: true, error: 'x', isEmpty: true },
      { ok: undefined, isEmpty: true },
    ]
    for (const input of cases) {
      assert.notEqual(distinguishFailure(input), EMPTY, `leaked empty state for ${JSON.stringify(input)}`)
    }
  })
})

describe('error copy', () => {
  it('denies the empty-list inference in the body, not just the tone', () => {
    const { body } = describeState(ERROR)
    assert.match(body, /have not been checked/)
    assert.match(body, /not an empty list/)
  })

  it('offers a retry', () => {
    const copy = describeState(ERROR)
    assert.equal(copy.retryable, true)
    assert.ok(copy.action)
  })

  it('claims nothing about local storage on a surface with no queue', () => {
    // "Anything saved on this device" is false on a desk in an office, and
    // confusing as well: it sends the reader hunting for a queue that is not
    // there. Only a surface that really holds unsent work may say it.
    assert.doesNotMatch(describeState(ERROR, { subject: 'Your partner records' }).body, /this device/)
    assert.match(
      describeState(ERROR, { subject: 'Your records', holdsWork: true }).body,
      /saved on this device is still waiting to send/,
    )
  })

  it('agrees with a plural subject, because a screen reader reads it verbatim', () => {
    for (const subject of ['The pending approvals', 'Alerts', 'The listed protocols']) {
      const body = describeState(ERROR, { subject }).body
      assert.match(body, new RegExp(`^${subject} have not been checked`))
      assert.doesNotMatch(body, /\bhas not been checked\b/)
    }
  })

  it('says the empty state was confirmed by the server', () => {
    const copy = describeState(EMPTY)
    assert.match(copy.body, /server answered/)
    assert.equal(copy.retryable, false)
  })
})

describe('the offline queue is neither a failure nor an empty list', () => {
  it('is its own state', () => {
    assert.equal(distinguishFailure({ ok: false, error: new Error('offline'), isEmpty: true }), ERROR)
    // Queued is chosen deliberately, not derived: it is the honest reading of a
    // device that holds work it has not yet sent. It is not OK (not checked),
    // not EMPTY (not nothing to do), and not ERROR (nothing went wrong).
    assert.notEqual(QUEUED, OK)
    assert.notEqual(QUEUED, EMPTY)
    assert.notEqual(QUEUED, ERROR)
  })

  it('says what is waiting and when it goes', () => {
    const copy = describeState(QUEUED, { queuedCount: 3, what: 'They' })
    assert.match(copy.body, /3 items are stored on this device/)
    assert.match(copy.body, /when the connection returns/)
    assert.match(copy.body, /Nothing has been lost/)
  })

  it('agrees with the count, because this is read aloud on most filings', () => {
    const one = describeState(QUEUED, { queuedCount: 1 }).body
    assert.match(one, /One item is stored on this device and has not reached/)
    assert.doesNotMatch(one, /\bhave not reached/)
    assert.doesNotMatch(one, /\bThey is\b/)
    const many = describeState(QUEUED, { queuedCount: 4, what: 'They' }).body
    assert.match(many, /4 items are stored on this device and have not reached/)
    assert.match(many, /They are sent/)
  })

  it('does not offer a retry button, which would achieve nothing offline', () => {
    assert.equal(describeState(QUEUED, { queuedCount: 1 }).retryable, false)
  })
})

describe('distinguishCollection', () => {
  it('is an error when any single collection failed', () => {
    const result = distinguishCollection({
      risk: { ok: true, isEmpty: false },
      hazards: { ok: false, error: new Error('down'), isEmpty: true },
    })
    assert.equal(result.state, ERROR)
    assert.deepEqual(result.failed, ['hazards'])
    assert.equal(result.retryable, true)
  })

  it('is empty only when every collection confirmed empty', () => {
    assert.equal(distinguishCollection({
      risk: { ok: true, isEmpty: true },
      hazards: { ok: true, isEmpty: true },
    }).state, EMPTY)
  })

  it('is ok when at least one collection returned rows', () => {
    assert.equal(distinguishCollection({
      risk: { ok: true, isEmpty: false },
      hazards: { ok: true, isEmpty: true },
    }).state, OK)
  })

  it('treats an empty result set as a failure rather than an empty screen', () => {
    // A caller that never loaded anything has checked nothing. Rendering the
    // empty state there is the original defect in miniature.
    assert.equal(distinguishCollection({}).state, ERROR)
  })
})