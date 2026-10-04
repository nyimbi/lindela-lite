import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.join(import.meta.dirname, '..')

/**
 * A `model_limit` is written for a person: it is spliced into the middle of a
 * paragraph on the scenario workbench, between the claim that a number is not a
 * probability and the number of samples it was averaged over. A field name from
 * the data model appearing in that position does not inform anybody — it reads
 * as a debug artefact left in production copy, and it undercuts a paragraph
 * whose entire purpose is to establish trust in a number.
 *
 * The sentence it used to carry was `…and carries calibrated_uncertainty:
 * false.` The claim is worth making. The way it was made was not.
 *
 * This sweeps the source rather than asserting one string, because the same
 * kind of prose is authored in more than one place and one of them being fixed
 * is not a reason to leave the next. The other two `model_limit` sites in src/
 * are variables rather than literals, so they are named in the assertions below
 * rather than swept.
 */
function modelLimitsIn(file) {
  const source = fs.readFileSync(file, 'utf8')
  const found = []
  // A single-quoted, double-quoted or backticked string literal, terminated by
  // its own quote. The quote has to be part of the match rather than part of a
  // negated class, because `[^\1]` means "not backslash or 1", not "not this
  // quote" — and a scan that quietly captures the rest of the file passes every
  // assertion written against it.
  const pattern = /model_limit:\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  for (const m of source.matchAll(pattern)) found.push({ file, text: m[2] })
  return found
}

describe('CE-06 — no machine identifiers in user-facing prose', () => {
  const authored = [
    ...modelLimitsIn(path.join(ROOT, 'src/scenarios.js')),
    ...modelLimitsIn(path.join(ROOT, 'src/analytics.js')),
    ...modelLimitsIn(path.join(ROOT, 'src/calibration.js')),
  ]

  it('finds the disclaimers this test is about', () => {
    // A sweep that matched nothing would pass every assertion below it, which
    // is the same shape of failure as a reconciliation script that measures
    // nothing. Refuse rather than report success.
    assert.ok(authored.length >= 1, `expected model_limit prose in src/, found ${authored.length}`)
  })

  for (const { file, text } of authored) {
    it(`${path.relative(ROOT, file)}: "${text.slice(0, 48)}…" carries no field name`, () => {
      // snake_case is the data model's own convention; a person-facing sentence
      // has no use for it.
      assert.doesNotMatch(text, /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, `machine identifier in prose: ${text}`)
      // Nor a JSON fragment, which is the same mistake one syntax layer over.
      assert.doesNotMatch(text, /[{}]|\bnull\b|\btrue\b|\bfalse\b/, `serialised value in prose: ${text}`)
    })
  }

  it('still makes the calibration claim, in words', () => {
    // The fix was not to delete the caveat. An uncalibrated score that says
    // nothing about being uncalibrated is worse than one that names the field.
    const source = fs.readFileSync(path.join(ROOT, 'src/scenarios.js'), 'utf8')
    assert.match(source, /model_limit:['\s\S]{0,400}?not been calibrated for uncertainty/i)
  })

  it('leaves the field itself in the payload, where a consumer needs it', () => {
    // The machine handle is not wrong. It is right in the wrong place.
    const source = fs.readFileSync(path.join(ROOT, 'src/analytics.js'), 'utf8')
    assert.match(source, /calibrated_uncertainty/)
  })
})