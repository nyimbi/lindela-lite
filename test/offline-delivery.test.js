import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A report filed with no connectivity must be durable, sent exactly once, and
 * the worker must be told the truth about all three.
 *
 * Four defects, all verified before the fix and all reachable from one tap:
 *
 *  1. The service worker could not install. `public/sw.js` carries eleven
 *     top-level `export` statements and was registered as a classic script, so
 *     every browser refused it — reproduced: `ServiceWorker script evaluation
 *     failed`, `getRegistrations()` → 0. Offline had never worked.
 *  2. Queueing was gated on `navigator.onLine === false`, a link-layer flag. A
 *     captive portal or an uplink that answers TCP but not HTTP reports
 *     `onLine === true`, the request threw, nothing was written, and the worker
 *     was told the report "will wait on this phone".
 *  3. Two drains read the same IndexedDB store with no claim and no idempotency
 *     key — the worker's `replayQueue()` and the page's `flush()`. Latent only
 *     because of (1); fixing (1) alone would have activated it.
 *  4. A record the server permanently rejects was retried on every tick for the
 *     life of the install, was never surfaced, and could not be discarded.
 *
 * `runtime.js` and `sw.js` are browser modules, so these assert against their
 * source and drive the pure logic directly. That is the right trade for the
 * guards; the behavioural evidence is `scripts/check-chw-queue-state.mjs`, which
 * drives the real wizard offline in a browser.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

/**
 * Source with comments stripped.
 *
 * Several of these fixes are explained *in* a comment that names the pattern
 * they removed — `// This was \`if (navigator.onLine) ...\``. A substring
 * assertion over raw source therefore matches the explanation of the fix, and a
 * test for "this no longer happens" passes forever on a comment.
 */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/** The body of one function, bounded by the next marker. */
const between = (p, from, to) => {
  const src = code(p)
  const start = src.indexOf(from)
  assert.ok(start >= 0, `${from} must exist in ${p}`)
  const end = src.indexOf(to, start + from.length)
  assert.ok(end > start, `${to} must follow ${from} in ${p}`)
  return src.slice(start, end)
}

describe('the service worker can install', () => {
  it('is registered as a module worker', () => {
    const runtime = read('public/shared/runtime.js')
    assert.match(
      runtime,
      /register\('\/sw\.js',\s*\{\s*type:\s*'module'\s*\}\)/,
      'a file with top-level exports cannot be evaluated as a classic worker — '
      + 'every browser refuses it and offline silently never happens',
    )
  })

  it('reports a registration failure instead of swallowing it', () => {
    const runtime = read('public/shared/runtime.js')
    assert.ok(
      !/register\('\/sw\.js'\)\.catch\(\(\) => null\)/.test(runtime),
      '`.catch(() => null)` makes a registration failure indistinguishable from '
      + '"this browser has no service workers", which is how an offline app with '
      + 'no offline survived three hardening passes and 45 assertions',
    )
    assert.match(runtime, /__lindelaSW/,
      'the registration outcome must be reachable, so an operator can explain why '
      + 'a device is not holding reports for signal')
  })
})

describe('a report is queued because the request failed, not because the browser says the link is down', () => {
  it('does not read navigator.onLine in submitOrQueue', () => {
    const runtime = read('public/shared/runtime.js')
    const fn = between('public/shared/runtime.js',
      'export async function submitOrQueue', 'async function queueTheReport')
    // `between` runs on comment-stripped source, so the markers have to be code.
    const q = between('public/shared/runtime.js',
      'async function queueTheReport', 'export async function initI18n')

    // `onLine === false` may skip the *attempt* — a request that cannot leave
    // should not spend eight seconds finding out. What it must never do is decide
    // whether anything is *saved*, because it is a link-layer flag: a captive
    // portal, or an uplink that completes TCP and answers no HTTP, both report
    // `true`, and gating the save on that told a health worker her report would
    // wait when nothing had been written.
    assert.match(
      fn,
      /navigator\.onLine === false/,
      'a known-dead link should not spend the timeout discovering it',
    )
    assert.ok(
      !/navigator\.onLine[^\n]*(\?|if|return|else)/.test(fn.replace(/\/\/[^\n]*/g, '')),
      'no branch may decide the outcome from navigator.onLine',
    )
    // Both the known-dead-link path and the thrown-request path reach the same
    // queueing helper, so there is one place that decides a report is durable.
    assert.equal(
      (q.match(/window\.lindelaQueue\.enqueue/g) || []).length, 1,
      'one place turns an unsent report into a stored record',
    )
    assert.match(q, /throw new Error\(/,
      'and the absence of a queue is fatal rather than silent — a report that '
      + 'was not saved must not be reported as one that was')
  })

  it('uses one offline queue, not two', () => {
    const sw = code('public/sw.js')
    assert.ok(
      !/async function replayQueue/.test(sw),
      'the worker drain read the same store as the page with no claim and no '
      + 'idempotency key: both could hold a record, both POST it, both delete it — '
      + 'two field reports for one observation',
    )
  })

  it('sends an idempotency key equal to the queue record id', () => {
    const runtime = read('public/shared/runtime.js')
    const fn = runtime.slice(runtime.indexOf('async enqueue('), runtime.indexOf('/** What is waiting'))
    assert.match(fn, /randomUUID/, 'the key must be minted before the write, not after')
    assert.match(fn, /'idempotency-key': id/,
      'two drains racing the same record must produce one server-side record, and '
      + 'the server already honours this header')
  })

  it('bounds retries and surfaces what gave up', () => {
    // The rules live in /shared/queue-core.js now, because the service worker
    // drains the same records and the two cannot be allowed to disagree about
    // what a 400 means. Asserted there, and asserted here too — one number, two
    // callers.
    const core = code('public/shared/queue-core.js')
    assert.match(core, /export const MAX_QUEUE_ATTEMPTS = \d+/,
      'a record the server permanently rejects must stop being retried forever')
    assert.match(core, /failed: true/,
      'a record that gives up must be marked, not silently retried')
    assert.match(core, /400[\s\S]{0,80}499|>= 400[\s\S]{0,80}< 500/,
      'and a 4xx is the class that will never succeed — retried forever, it is ' +
      'the one rejection that keeps a queue full of records it can never send')
    const runtime = code('public/shared/runtime.js')
    assert.match(runtime, /MAX_QUEUE_ATTEMPTS = CORE_MAX_QUEUE_ATTEMPTS/,
      "the page's export is the core's number, not a second one")
    assert.match(runtime, /async list\(/, 'the worker needs to see what is stuck')
    assert.match(runtime, /async discard\(/, 'and needs a way to get rid of it')
  })
})

describe('the copy matches what the code did', () => {
  it('does not promise a save that did not happen', () => {
    const chw = read('public/chw/app.js')
    const failure = chw.slice(chw.indexOf('function reportSendFailure'), chw.indexOf('\n}', chw.indexOf('function reportSendFailure')))
    assert.ok(
      !/will wait on this phone/.test(failure),
      'this catch fires only when there was no queue to write to — private '
      + 'browsing, storage exhausted, a blocked upgrade — so promising the report '
      + 'will wait is false in exactly the case the sentence is shown',
    )
    assert.match(failure, /NOT saved|not saved/i)
  })

  it('routes all three submissions through submitOrQueue', () => {
    const chw = code('public/chw/app.js')
    const calls = chw.match(/submitOrQueue\(/g) || []
    assert.equal(calls.length, 3, 'exactly the three submissions: symptom, incident, reply')
    assert.ok(
      !/if \(!navigator\.onLine\) \{/.test(chw),
      'no submission may branch on the link-layer flag any more',
    )
  })
})