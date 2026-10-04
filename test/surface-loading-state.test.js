import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * Source with comments removed.
 *
 * These files explain at length why each line exists, and several of those
 * explanations quote the string the assertion forbids — the chw markup carries
 * a comment about the "Loading alert..." it no longer contains. A scan that
 * reads comments tests the prose, not the program.
 */
const code = (p) => read(p)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * CE-07 — every surface says it is working, and says it has stopped.
 *
 * The audit measured six surfaces whose status line never left its initial
 * state, and recorded that the two that did resolve went from empty to their
 * final text with no intermediate "working" at all. Both halves are the same
 * defect: a reader on a slow link cannot tell a screen that is loading from a
 * screen that is broken.
 *
 * This asserts the contract in source rather than in a browser, because the
 * browser version cannot distinguish "took four seconds" from "never started"
 * and "finished" from "hung" without timing a network it does not control. The
 * runtime behaviour is covered by `states.test.js` (the vocabulary and the
 * ordering guard) and by `scripts/check-dead-server-states.mjs` (a real dead
 * socket over CDP).
 */
const SURFACES = [
  {
    dir: 'chw',
    status: '#alertText',
    // Written by the request that is running, not left behind in the markup.
    notInHtml: [/Loading alert/i],
  },
  {
    dir: 'portal',
    status: '#load-status',
    notInHtml: [],
  },
  {
    dir: 'focal-point',
    status: '#statusText',
    notInHtml: [],
  },
  {
    dir: 'co',
    status: '#load-status',
    notInHtml: [],
  },
]

describe('CE-07 — a status line that starts, and stops', () => {
  for (const { dir, status, notInHtml } of SURFACES) {
    describe(`/${dir}/`, () => {
      const html = code(`public/${dir}/index.html`)
      const app = code(`public/${dir}/app.js`)

      it('declares a status region in the markup, with the id the app drives', () => {
        // Declared rather than created: a node created by the render it
        // announces is a node a live region cannot have been observing.
        assert.ok(html.includes(`id="${status.slice(1)}"`),
          `${dir}: ${status} is missing from index.html`)
      })

      it('ships the region in the working state, not blank', () => {
        // The module that replaces it does not arrive until every script has
        // been fetched. On a field connection that is seconds during which the
        // region says nothing at all.
        const tag = html.match(new RegExp(`<[^>]*id="${status.slice(1)}"[^>]*>`))?.[0] || ''
        assert.match(tag, /role="status"|aria-live=/,
          `${dir}: ${status} is not a live region, so a screen reader is never told`)
        // Non-empty, and a claim the markup can actually support. A surface
        // whose request has not been made may say it is idle; it may not say it
        // is working.
        const initial = html.match(new RegExp(`id="${status.slice(1)}"[^>]*>([^<]*)<`))?.[1] ?? ''
        assert.ok(initial.trim().length > 0,
          `${dir}: ${status} starts blank; a gap with no words in it describes nothing`)
        assert.match(initial.trim(), /Loading|loaded|awaiting|pending/i,
          `${dir}: ${status} opens with text that is neither work nor its absence`)
      })

      for (const pattern of notInHtml) {
        it(`never asserts work in flight from static markup (${pattern})`, () => {
          // A word that means "working", sitting in the HTML, is a claim about
          // a request nobody has made — and it stays on screen whenever nothing
          // drives it. A spinner that outlives its request is the same defect.
          assert.doesNotMatch(html, pattern,
            `${dir}: the markup claims a request is in flight before any has been made`)
        })
      }

      it('writes the working state and settles it', () => {
        // Both halves. A surface that starts working and never settles has
        // traded an empty state for a permanent one.
        assert.ok(/loadSequence\.start\(\)|alertLoads\.start\(\)|setLoadState\(LOADING|state: 'working'/.test(app),
          `${dir}: nothing starts a load or announces one`)
        assert.ok(/settle\(token\)|setLoadState\(failed\.length \? ERROR : OK\)/.test(app),
          `${dir}: no load is ever settled`)
      })

      it('guards against a superseded response painting last', () => {
        // Without this the *slower earlier* load wins, which is both the wrong
        // data and the reason a status line can be stranded: the loser returns
        // early and the winner's state was overwritten.
        assert.match(app, /isCurrent\(token\)/,
          `${dir}: a superseded load can paint over the one the reader is waiting for`)
      })
    })
  }
})

describe('CE-04 — one shape for a failure the reader did not cause', () => {
  for (const dir of ['chw', 'portal', 'focal-point', 'co']) {
    it(`/${dir}/ never splices an exception message into a sentence`, () => {
      const app = code(`public/${dir}/app.js`)
      // `error.message` is "Failed to fetch", "NetworkError when attempting to
      // fetch resource", "HTTP 502" — names for events in software, not for
      // anything happening to the reader's work. This is the same defect CE-06
      // records on the scenario workbench, seen from the write path.
      const offenders = [...app.matchAll(/\$\{[^}]*\berror\.message\b[^}]*\}|`Error: /g)]
      assert.deepEqual(offenders.map((m) => m[0]), [],
        `${dir}: machine text interpolated into user-facing prose`)
    })
  }

  it('routes write failures through the shared template', () => {
    // Reads and writes fail differently, so they get different sentences — but
    // each class gets exactly one, and both live in the same vocabulary.
    const states = read('public/shared/states.js')
    assert.match(states, /export function describeActionFailure/)
    const chw = code('public/chw/app.js')
    const fp = code('public/focal-point/app.js')
    assert.equal([...chw.matchAll(/describeActionFailure\(/g)].length, 1,
      'one construction site: a second call site is a second sentence shape')
    assert.equal([...fp.matchAll(/describeActionFailure\(/g)].length, 1,
      'one construction site: a second call site is a second sentence shape')
  })
})