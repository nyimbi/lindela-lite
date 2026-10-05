/**
 * R-83 — `pct()` guessed the scale from magnitude, and guessed wrong twice.
 *
 * `Math.abs(n) <= 1 ? n * 100 : n` cannot distinguish a fraction from a
 * percentage, because a percentage has no floor above 1. Measured against the
 * old expression:
 *
 *   0.005 →   0.5%   correct (it was a fraction)
 *   0.5   →  50.0%   correct (it was a fraction)
 *   1     → 100.0%   wrong — a 1% rate rendered as certainty
 *   1.5   →   1.5%   wrong — a 150% rate rendered as 1.5%
 *   2     →   2.0%   correct
 *
 * The pair 1 → 100.0 and 1.5 → 1.5 makes the function non-monotone: raise the
 * true rate and the rendered rate *falls*. In an early-warning product the
 * first error manufactures confidence the system does not have and the second
 * hides a rising rate behind a falling number.
 *
 * These tests are behavioural and fail against the old implementation: the
 * scale is now stated by the caller, so `pct(1, { scale: 'fraction' })` and
 * `pct(1, { scale: 'percent' })` are two different questions with two different
 * answers, and neither is inferred.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { num, pct } from '../public/shared/fmt.js'

describe('R-83 — pct() declares its scale instead of inferring it', () => {
  it('renders a 1% rate as 1%, not as 100%', () => {
    assert.equal(pct(1, { scale: 'percent' }), '1.0%')
    assert.equal(pct(1, { scale: 'fraction' }), '100.0%')
  })

  it('is monotone across the old inflection point', () => {
    // 0.5%, 1%, 1.5%, 2% and 100% are increasing. The old expression turned
    // the first four into 50%, 100%, 1.5% and 2% — a fall from 100% to 1.5%.
    const rendered = [0.5, 1, 1.5, 2, 100].map((n) => parseFloat(pct(n, { scale: 'percent' })))
    for (let i = 1; i < rendered.length; i += 1) {
      assert.ok(rendered[i] > rendered[i - 1],
        `a higher true rate must render higher: ${rendered.join(' → ')}`)
    }
  })

  it('renders a fraction only when told it is one', () => {
    assert.equal(pct(0.005, { scale: 'fraction' }), '0.5%')
    assert.equal(pct(0.005, { scale: 'percent' }), '0.0%')
    assert.equal(pct(0.42, { scale: 'fraction' }), '42.0%')
    assert.equal(pct(42, { scale: 'percent' }), '42.0%')
  })

  it('defaults to percent, so a call site that already passed 0-100 is unchanged', () => {
    assert.equal(pct(42), pct(42, { scale: 'percent' }))
    assert.equal(pct(100), '100.0%')
    assert.equal(pct(0), '0.0%')
  })

  it('rejects a scale it does not know rather than falling back to a guess', () => {
    // A typo in the scale is the same class of defect as the heuristic it
    // replaced: a silently wrong number. `scale: 'Fraction'` throwing is the
    // intended outcome — the render is wrong in a way nobody would notice.
    assert.throws(() => pct(1, { scale: 'Fraction' }), /scale must be/)
  })

  it('still dashes an absent value rather than rendering it as 0%', () => {
    assert.equal(pct(null), '—')
    assert.equal(pct(undefined), '—')
    assert.equal(pct(''), '—')
    assert.equal(pct(NaN), '—')
  })

  it('leaves num() alone — it never scaled', () => {
    assert.equal(num(1), '1.0')
    assert.equal(num(0), '0.0')
    assert.equal(num(null), '—')
  })
})
