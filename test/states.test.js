import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EMPTY,
  ERROR,
  LOADING,
  OK,
  QUEUED,
  createLoadSequence,
  describeActionFailure,
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
describe('LOADING — the state a request is in, not a result', () => {
  it('is one of the four screens, and is distinct from empty', () => {
    // Not empty. The defect CE-07 records is a request that is visibly in
    // flight rendering as though there were nothing to show, or — worse —
    // sitting on a status line for the rest of the session.
    assert.notEqual(LOADING, EMPTY)
    assert.notEqual(LOADING, OK)
    assert.notEqual(LOADING, ERROR)
  })

  it('names what is being checked', () => {
    const copy = describeState(LOADING, { noun: 'the approval queue' })
    assert.match(copy.title, /Loading/)
    assert.match(copy.body, /the approval queue/)
  })

  it('promises a terminal state, because a spinner that can outlive its request is the defect', () => {
    // The sentence has to say what happens next. A working state that says
    // nothing about its own end is one nobody can tell from a hung request.
    const copy = describeState(LOADING, { noun: 'the latest alert' })
    assert.match(copy.body, /replaced once the server answers/)
    assert.match(copy.body, /if it cannot/)
  })

  it('reads as a sentence with no detail at all, rather than as a key or a blank', () => {
    // No noun supplied: the surface said nothing about what it was fetching,
    // and the fallback must still be a sentence a person can read.
    const copy = describeState(LOADING)
    assert.match(copy.body, /Checking .+\./)
    assert.doesNotMatch(copy.body, /undefined|null|\{\w+\}/)
  })

  it('is never retryable — there is nothing to retry yet', () => {
    assert.equal(describeState(LOADING, { noun: 'x' }).retryable, false)
    assert.equal(describeState(LOADING, { noun: 'x' }).action, null)
  })
})

describe('createLoadSequence — a status line that cannot be stranded', () => {
  it('reports pending until the load that is running settles', () => {
    const seq = createLoadSequence()
    assert.equal(seq.pending, false, 'nothing has been started, so nothing is pending')
    const token = seq.start()
    assert.equal(seq.pending, true)
    seq.settle(token)
    assert.equal(seq.pending, false, 'a settled load is not pending, on the success path or the failure path')
  })

  it('refuses to settle a load that a newer one has superseded', () => {
    // Changing the quarter twice, or clicking a retry while the first retry is
    // still running: the loser must not write last. This is the failure that
    // strands a status line at "Loading…" and paints the wrong period.
    const seq = createLoadSequence()
    const first = seq.start()
    const second = seq.start()
    assert.equal(seq.isCurrent(first), false)
    assert.equal(seq.isCurrent(second), true)
    assert.equal(seq.settle(first), null, 'a superseded load writes nothing')
    assert.equal(seq.settle(second), second)
  })

  it('does not let a superseded load leave the surface pending-free', () => {
    // The newer load is still running, so the surface is still working. A
    // `settle` that ignored the token would mark the surface done while the
    // only request that matters has not answered.
    const seq = createLoadSequence()
    const first = seq.start()
    seq.start()
    assert.equal(seq.settle(first), null)
    assert.equal(seq.pending, true)
  })

  it('hands out a fresh token every time', () => {
    const seq = createLoadSequence()
    assert.notEqual(seq.start(), seq.start())
    const third = seq.start()
    assert.equal(seq.token, third)
  })
})

describe('describeActionFailure — one sentence for something that did not happen', () => {
  it('names the action in the title and the next step in the body', () => {
    const copy = describeActionFailure({
      action: 'record the decision',
      nextStep: 'Nothing was approved or rejected. Try again.',
    })
    assert.equal(copy.title, 'Could not record the decision')
    assert.equal(copy.body, 'Nothing was approved or rejected. Try again.')
    assert.equal(copy.tone, 'critical')
  })

  it('has no parameter through which a machine string can be interpolated', () => {
    // CE-04 and CE-06 are the same defect seen from two ends: `error.message`
    // spliced into a sentence. "Failed to fetch" and "HTTP 502" are names for
    // events in software, not for anything happening to the reader's work. The
    // signature is the guard — `reason` is not an accepted key, so no call site
    // can reach for it.
    // Passing a `reason` is not an error — it is silently not used, which is
    // the point: an untranslated extra property cannot reach the sentence.
    const accepted = describeActionFailure({ reason: 'Failed to fetch' }).body
    assert.doesNotMatch(accepted, /Failed to fetch/)
    assert.doesNotMatch(accepted, /\breason\b/)
  })

  it('defaults to the two facts a reader needs before pressing the button again', () => {
    const copy = describeActionFailure({ action: 'save the report' })
    assert.match(copy.body, /Nothing was changed/)
    assert.match(copy.body, /Try again/)
    assert.equal(copy.retryable, false)
    assert.equal(copy.action, null)
  })
})
