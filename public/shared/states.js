/**
 * The vocabulary every surface uses to say what it actually knows.
 *
 * The defect this exists to kill: with the server unreachable, six of eight
 * surfaces rendered their empty state. "No pending workflows." is not a
 * cosmetic error — it is an assertion about the world that the client never
 * verified, and an operator who reads it stops looking. The empty state is the
 * most dangerous string in the product precisely because it is reassuring.
 *
 * So the rule is one line and every surface obeys it: **an error is never an
 * empty state.** Failure wins over emptiness, always, before anything else is
 * considered. There is no ordering in which "the request failed" and "there is
 * nothing to report" both lead to a blank list.
 *
 * Pure functions, no DOM, no dependencies: a surface that has a fetch loop and
 * a different DOM from every other surface can still agree on the words, and
 * the console can adopt the vocabulary without adopting the renderer.
 */

/** The four things a screen can honestly be. There is no fifth. */
export const OK = 'ok'
export const EMPTY = 'empty'
export const ERROR = 'error'
/**
 * Work in flight. Not a failure and not a result.
 *
 * The reason it is in this module rather than in each surface's markup is that
 * a loading state written once per surface is a loading state that outlives its
 * request on whichever surface nobody tested. The body below says out loud that
 * it will be replaced, because a status line that goes quiet and stays quiet is
 * indistinguishable from one that is still working.
 */
export const LOADING = 'loading'
/**
 * Not an error and not an empty list: work exists, is held locally, and has not
 * been sent. On a CHW's phone this is the normal case, not a fault. Rendering
 * it as either of the other two states is a lie in opposite directions — one
 * says "you have done nothing", the other says "something went wrong".
 */
export const QUEUED = 'queued'

/**
 * Decide which state a render is allowed to claim.
 *
 * `ok` is whether the request completed. `error` is the failure, if any.
 * `isEmpty` is the caller's reading of the returned rows.
 *
 * Error beats empty, and `ok: false` is itself an error even when the caller
 * has no exception object in hand — a fetch that was abandoned, aborted or
 * never made is not a fetch that returned zero rows. Treating it as empty is
 * how the original bug was written.
 *
 * @param {{ ok?: boolean, error?: unknown, isEmpty?: boolean }} input
 * @returns {'ok' | 'empty' | 'error'}
 */
export function distinguishFailure({ ok = false, error = null, isEmpty = false } = {}) {
  if (error) return ERROR
  if (!ok) return ERROR
  return isEmpty ? EMPTY : OK
}

/**
 * Wording for a state. Subjects are passed in because a portal partner and a
 * focal point are owed different sentences about the same failure, and hard
 * coding one noun would make at least one of them wrong.
 *
 * `subject` is a plural noun phrase — "The pending approvals", "Alerts". The
 * bodies below take plural agreement, and a caller passing "The approval queue"
 * gets "The approval queue have not been checked", which a screen reader
 * announces verbatim. Singular agreement is the caller's to word, not the
 * vocabulary's to guess.
 *
 * `holdsWork` is opt-in and means "this device is storing things that have not
 * been sent". Only a surface with an offline queue may claim that; on a desk in
 * an office it is not merely false but confusing, because it sends the reader
 * looking for a queue that does not exist.
 *
 * Every ERROR body says the same two things in the same order: nothing has
 * been checked, and this is not an empty list. The second clause is the whole
 * point — it denies the inference the reader would otherwise make.
 *
 * @param {'ok'|'empty'|'error'|'queued'|'loading'} state
 * @param {{ subject?: string, noun?: string, queuedCount?: number, what?: string,
 *           holdsWork?: boolean }} [detail]
 * @returns {{ title: string, body: string, tone: 'neutral'|'warning'|'critical',
 *             retryable: boolean, action: string|null }}
 */
/**
 * What to say about a payload the service worker answered from its cache.
 *
 * The case this exists for: the server is dead, the service worker's API bucket
 * has yesterday's records, and the surface renders them as current. Everything
 * downstream then reasons about a stale read as a live one — the partner portal
 * answered "Authentication is not configured", a claim about the server's
 * configuration, while the server was gone. A cached read is a real answer to a
 * different question, and the question has to be named.
 *
 * Returns `null` for a live read, so a caller can write
 * `staleNote(payload) ?? ''` and pay nothing for the common case.
 */
export function staleReadNote(payload, { storedAt = null, subject = 'These records', t } = {}) {
  const provenance = payload?.__provenance
  if (!provenance?.servedFromCache) return null
  const when = storedAt || provenance.storedAt
  const rendered = when ? new Date(when).toLocaleString() : null
  // Built from the ERROR vocabulary rather than a parallel sentence set. The
  // first clause is the same fact — the server has not answered — and the second
  // is the one that matters here: what is on screen *is* a list, and it may not
  // be current. A surface that renders stale data without saying so is the same
  // defect as one rendering nothing: a reader draws the wrong conclusion.
  //
  // `t` is accepted so a translated surface reads the same shape; the English is
  // the fallback for a key a catalogue has not caught up with.
  const body = t
    ? t('state.served_from_cache', { when: rendered || 'an earlier time' })
    : `The server could not be reached, so this is what it last said${rendered ? ` (${rendered})` : ''}. It may be out of date — do not read this as current.`
  return {
    title: t ? t('state.served_from_cache_title') : 'Showing the last known state',
    body,
    tone: 'warning',
    // Deliberately not `critical`: the payload is usable, it is just not current.
    // Treating a cached answer as an error would blank eleven panels because one
    // endpoint was answered from cache.
    retryable: true,
    action: 'Try again',
  }
}

export function describeState(state, { subject = 'These records', noun, queuedCount = 0, what = 'they', holdsWork = false } = {}) {
  switch (state) {
    case LOADING:
      return {
        title: 'Loading…',
        // The second clause is the load-bearing one. A working state that says
        // nothing about its own end is a status line that can sit at "Loading…"
        // for the rest of the session, and a reader who has learned that the
        // line lies learns to ignore it.
        body: `Checking ${noun || subject}. This is replaced once the server answers — and if it cannot.`,
        tone: 'neutral',
        retryable: false,
        action: null,
      }

    case ERROR:
      return {
        title: 'Could not reach the server',
        // "X have not been checked" first: it is the fact. "Not an empty
        // list" second, because it is the conclusion the reader has to be
        // stopped from drawing. Neither clause is optional.
        body: `${subject} have not been checked. The request did not get an answer, so this is not an empty list.${holdsWork ? ' Anything saved on this device is still waiting to send.' : ''}`,
        tone: 'critical',
        retryable: true,
        action: 'Try again',
      }

    case EMPTY:
      return {
        title: 'Nothing here',
        // The empty state earns trust only by being distinguishable from the
        // error state, so it says outright that the server did answer.
        // `subject` is spliced mid-sentence here and clause-initially in ERROR, so
    // callers pass a bare noun phrase ("alerts", "the pending approvals") that
    // reads correctly in both positions. Two spellings per noun is cheaper than
    // the wrong sentence.
    body: `The server answered, and there is nothing in ${noun || subject}. Nothing is waiting to be checked.`,
        tone: 'neutral',
        retryable: false,
        action: null,
      }

    case QUEUED: {
      const count = Number.isFinite(queuedCount) ? queuedCount : 0
      const one = count === 1
      return {
        title: one ? 'Not sent yet' : `${count} not sent yet`,
        // The way forward for this state is not a retry button — retrying a
        // device with no link achieves nothing. It is the sentence about when.
        //
        // Every verb comes from `count`, never from `what`: `what` is a
        // caller-supplied pronoun and callers do not all pass the same one, so
        // "One item ... They is sent" is a live failure mode here. The singular
        // branch drops `what` entirely rather than risk it.
        body: count === 0
          ? `${what} will be sent as soon as the connection returns.`
          : one
            ? `One item is stored on this device and has not reached the server. It will be sent automatically when the connection returns. Nothing has been lost.`
            : `${count} items are stored on this device and have not reached the server. ${what} are sent automatically when the connection returns. Nothing has been lost.`,
        tone: 'warning',
        retryable: false,
        action: null,
      }
    }

    case OK:
    default:
      return { title: '', body: '', tone: 'neutral', retryable: false, action: null }
  }
}

/**
 * Fold a settled load into a render state.
 *
 * `results` is the same `{ [key]: { ok, error, isEmpty } }` shape a caller
 * already has from `Promise.all` over independent collections. The rule is
 * uniform across all of them: if any one failed, the whole view is an error.
 * Showing three good tables beside a dead fourth is a decision each surface
 * would otherwise have to make separately, and three surfaces making it
 * separately is how they came to disagree.
 *
 * @param {Record<string, {ok?: boolean, error?: unknown, isEmpty?: boolean}>} results
 * @param {{ queuedCount?: number }} [detail]
 */
export function distinguishCollection(results, detail = {}) {
  const entries = Object.entries(results || {})
  // No collections at all means nothing was checked. `every` over an empty array
  // is vacuously true, which would route this to the empty state and reinstate
  // the exact bug the module exists to prevent.
  if (!entries.length) return { state: ERROR, ...describeState(ERROR, detail), failed: [] }
  const failures = entries.filter(([, r]) => distinguishFailure(r) === ERROR)
  if (failures.length) {
    return {
      state: ERROR,
      ...describeState(ERROR, detail),
      failed: failures.map(([key]) => key),
    }
  }
  const empty = entries.every(([, r]) => distinguishFailure(r) === EMPTY)
  const state = empty ? EMPTY : OK
  return { state, ...describeState(state, detail), failed: [] }
}

/**
 * The sentence for something the reader tried to do that did not happen.
 *
 * `describeState` covers *loads*. A write failure is a different event with a
 * different obligation: the reader is owed both that it failed and that nothing
 * changed, because the instinct after a failed save is to press the button
 * again, and the instinct before pressing it is to wonder what was half-done.
 *
 * There is no `reason` parameter, and that omission is the point. The obvious
 * thing to pass is `error.message`, and that is what every surface used to do —
 * which put "Failed to fetch", "NetworkError when attempting to fetch resource"
 * and "HTTP 502" inside sentences written for people. The machine text belongs
 * in the console, where it is actionable; `nextStep` is where the words go.
 *
 * @param {{ action: string, nextStep?: string }} detail
 * @returns {{ title: string, body: string, tone: 'critical', retryable: false,
 *             action: string|null }}
 */
export function describeActionFailure({ action, nextStep = 'Nothing was changed. Try again.' } = {}) {
  return {
    title: `Could not ${action}`,
    body: nextStep,
    tone: 'critical',
    retryable: false,
    action: null,
  }
}

/**
 * A running tally of loads, so a slow earlier one cannot overwrite a fast later
 * one and strand the surface at "Loading…".
 *
 * Period change on the quarterly dashboard and the retry button on every
 * failure state both start a load while another may still be in flight. Without
 * an ordering check the *older* response is the one that lands last, and a
 * surface that has moved on renders the words and figures of the period the
 * reader just left. `start` returns a token; a load may only write to the
 * screen if `isCurrent(token)` still holds when it settles.
 *
 * `pending` is the other half of the honesty rule: a caller that starts a load
 * and throws away its token has left the surface loading forever, and the only
 * way a test can catch that is to ask.
 *
 * @returns {{ start: () => number, isCurrent: (t: number) => boolean,
 *             settle: (t: number) => number|null, pending: boolean }}
 */
export function createLoadSequence() {
  let issued = 0
  let settled = 0
  return {
    start() {
      issued += 1
      // A new load supersedes any load still running: the previous one can no
      // longer be settled, so it cannot claim the surface at the end.
      return issued
    },
    isCurrent(token) {
      return token === issued
    },
    /** Settle a load, or return `null` if a newer one has taken over. */
    settle(token) {
      if (token !== issued) return null
      settled = token
      return token
    },
    get pending() {
      return issued !== settled
    },
    get token() {
      return issued
    },
  }
}