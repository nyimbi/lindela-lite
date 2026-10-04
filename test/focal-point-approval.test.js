import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A focal point approves a disbursement from a card that stated the wrong
 * threshold, in a queue that reordered itself, behind a modal that named none
 * of it, under a header that printed `focal-point (en)`.
 *
 * CW-02, CW-13 and CW-07 come from the cognitive walkthrough; HX-12 from the
 * heuristic evaluation. All four were reproduced over CDP against the running
 * product before the fix and re-verified after; the browser runs are the
 * behavioural evidence, and what follows guards the properties they rest on.
 *
 * The module is browser-only — it mounts a navbar and queries the document at
 * import time — so these assertions read its source rather than executing it.
 * That is the same trade `chw-offline-feedback.test.js` makes, and it is the
 * same defence: every property guarded here is about the *shape* of the code
 * (which comparison is made, which fields are rendered, which key is posted),
 * not about a value that a fixture could stand in for.
 */

const root = path.join(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const app = read('public/focal-point/app.js')
const html = read('public/focal-point/index.html')

/** The body of a top-level declaration, up to the next one at column 0. */
const block = (source, name) => {
  const start = source.indexOf(name)
  assert.notEqual(start, -1, `expected ${name} in the source`)
  const rest = source.slice(start + name.length)
  const next = rest.search(/\n(?=(?:async )?function |const |let |await |window\.|decisionDialog|dialog)/)
  return name + (next === -1 ? rest : rest.slice(0, next))
}

describe('CW-02 — the card is judged against the protocol that governs it', () => {
  it('compares with the operator, not with a hardcoded >=', () => {
    const card = block(app, 'async function renderPending')

    assert.ok(!/Number\(value\)\s*>=\s*Number\(threshold\)/.test(app),
      'the reading must be compared with the operator the protocol states; a ' +
      'hardcoded >= reports a drought of 3.4 against a threshold of 5 as "not met"')
    assert.ok(/const met = verdict === true/.test(card),
      'the verdict must come from the operator-aware comparison')
    assert.ok(card.includes("verdict === null ? 'condition could not be evaluated'"),
      'a reading that cannot be evaluated must say so, not render a verdict')
  })

  it('prints the operator on the card and in the protocol list', () => {
    assert.ok(/against \$\{escapeHtml\(op \?/.test(app),
      'the card must state the direction it is comparing in')
    assert.ok(/metricLabel\(p\.metric\)\)\} \$\{escapeHtml\(opText\(p\.operator\)\)\}/.test(app),
      'the protocol list printed a hardcoded ≥ next to every threshold, so ' +
      '"Aweil Drought Early-Warning Trigger — Rainfall (mm) >= 5" described a ' +
      'protocol the API states as <= 5')
  })

  it('takes the threshold from the governing protocol, and only when it governs', () => {
    const gov = block(app, 'function governingProtocol')

    assert.ok(gov.includes('p.metric === alert.metric'),
      'a protocol on another metric cannot govern this trigger')
    assert.ok(gov.includes('directionOf(p.operator) === directionOf(alert.operator)'),
      'a protocol on the opposite direction cannot govern: that is how a flood ' +
      'reading ends up evaluated against a drought threshold')
    assert.ok(/scope\(p\)\.includes\(d\)/.test(gov),
      'a protocol scoped to another district must never govern this card')
    assert.ok(gov.includes("p.mode !== 'shadow'"),
      'a shadow protocol is a draft and governs nothing')
    assert.ok(app.includes('No live pre-authorised protocol governs this trigger'),
      'where no protocol governs, the card must say so rather than borrowing a number')
  })

  it('keeps 0, which is a drought reading and not a missing one', () => {
    assert.ok(/function numberOrNull\(v\)/.test(app) && /if \(v === null \|\| v === undefined \|\| v === ''\)/.test(app),
      'a threshold of 0 is a real threshold; a truthiness test drops it')
  })
})

describe('CW-13 — the queue does not reorder, and the card names its district', () => {
  it('sorts by raised-at, then district', () => {
    const sort = block(app, 'function sortQueue')
    const render = block(app, 'async function renderPending')

    assert.ok(render.includes('sortQueue('),
      'the queue must be sorted rather than rendered in API order, which ' +
      'changed with the store: "the Turkana one is second" stopped being true')
    assert.ok(sort.includes('created_at'), 'raised-at is the primary key')
    assert.ok(sort.includes('a.district.localeCompare(b.district)'),
      'district breaks ties, so two triggers raised together still have an order')
  })

  it('names the district in the card header, not only by position', () => {
    assert.ok(html.includes('.card-district'), 'the header needs a place for the district')
    assert.ok(/<span class="card-district">/.test(app),
      'the card header must carry the district itself')
    assert.ok(!app.includes("escapeHtml(w.district || '—')"),
      'the district may not be a detail row only — position is not an identifier')
  })
})

describe('CW-07 — the confirmation names what it approves, and who approved it', () => {
  it('puts district, rule, reading and amount in the modal', () => {
    assert.ok(html.includes('id="decisionSummary"'),
      'the modal needs a body; it had a title, a Reason select and nothing else')
    assert.ok(/aria-describedby="decisionSummary/.test(html),
      'the summary is what the dialog is described by, so a screen reader reads it too')

    const sentence = block(app, 'function decisionSentence')
    for (const field of ['entry.district', 'entry.ruleName', 'entry.value', 'entry.threshold', 'state.identity']) {
      assert.ok(sentence.includes(field), `the confirmation sentence must name ${field}`)
    }
    assert.ok(app.includes('Amount released:'),
      'the amount released must be stated — or declared unrecorded')
    assert.ok(app.includes('not recorded on this trigger'),
      'no workflow carries a disbursement amount; saying so is the honest ' +
      'reading, and printing a figure would be inventing one')
  })

  it('threads a real actor into the transition', () => {
    assert.ok(/actor: state\.identity/.test(app),
      'the transition must carry an actor; the server already records one when sent')
    assert.ok(/\.\.\.\(state\.identity \? \{ actor: state\.identity \} : \{\}\)/.test(app),
      'and must send nothing when the operator has not named themselves — an ' +
      'empty name is absence, and posting "" claims an actor who is not there')
    assert.ok(html.includes('id="fpName"'), 'the operator has to be able to give a name')
    assert.ok(!/\$\{state\.identity\} \(\$\{state\.locale\}\)/.test(app),
      'the header printed `focal-point (en)`: a machine handle read as a person')
  })

  it('does not log "anonymous" as though it were a name', () => {
    const audit = block(app, 'async function renderAuditTrail')
    assert.ok(audit.includes("'no actor recorded'"),
      '"anonymous" is the absence of an actor, not one somebody claims')
    assert.ok(audit.includes('actor_source'), 'the log must say how the actor was established')
    assert.ok(audit.includes('d.district'), 'a decision must say where it was made')
  })

  it('shows the outcome where a sighted focal point can read it', () => {
    assert.ok(!/<p class="visually-hidden" id="decisionOutcome"/.test(html),
      'the confirmation was confined to a visually-hidden region: a sighted ' +
      'focal point got silence after releasing finance')
    assert.ok(/id="decisionOutcome"/.test(html) && /role="status"/.test(html))
  })
})

describe('HX-12 — the header states the role once, and does not wrap', () => {
  it('drops the duplicate role statement', () => {
    assert.ok(!html.includes('class="header-role"'),
      'the shared navbar already carries "Focal Point" as the active nav item; ' +
      'the H1 repeated the product identity a third time')
  })

  it('will not break the sign-out button across lines', () => {
    assert.ok(/\.signout-btn \{ white-space: nowrap; \}/.test(html),
      '"Sign out" broke to "Sign"/"out" inside a 64x50 box')
  })

  it('has an accessible name for the name field', () => {
    assert.ok(/<label class="identity-label" for="fpName">/.test(html),
      'the field must be labelled, not placeholder-only')
  })
})