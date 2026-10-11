#!/usr/bin/env node
/**
 * ENH-70 — the map reports the gaps in itself.
 *
 * The gap accounting was always computed. It went into the record count's
 * `title` and `aria-label` and nowhere else, so a map drawn from 40 of 67
 * records looked exactly like a map drawn from 67 to anyone reading the map —
 * a tooltip needs a hover, which a touch device does not have, and an operator
 * scanning a clean map has no reason to go looking for one. The entry's own
 * words: "An operator reading a clean map should see the gaps in it."
 *
 * The decision is `mapCoverage`, which is pure, DOM-free and exported for the
 * same reason `evaluateMapFilters` is: what the test drives is the accounting,
 * and the element is only where it lands. Asserting on the panel's HTML would
 * prove only that `textContent` was assigned.
 *
 * Two numbers this file exists to keep apart, because conflating them is the
 * bug the module's shape is chosen to prevent:
 *   `unplaced`  — a record the map HOLDS and could not draw
 *   `filtered`  — a record the map never held, because a filter excluded it
 * Adding them would report "not on the map" for a record that is not the map's
 * to show. That is a wrong number in the direction of alarm, which is worse
 * than a missing one.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'

import { importFrontEnd } from './browser-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let app
before(async () => { app = await importFrontEnd('app.js') })

describe('ENH-70 — the map coverage accounting', () => {
  it('closes: placed + unplaced is every record the map holds', () => {
    const coverage = app.mapCoverage({ total: 67, placed: 40, tooLarge: 10, outsideFrame: 17 })
    assert.equal(coverage.placed, 40)
    assert.equal(coverage.unplaced, 27)
    assert.equal(coverage.placed + coverage.unplaced, coverage.total)
    assert.equal(coverage.complete, false)
  })

  it('keeps the filter’s exclusions out of the map’s own gap count', () => {
    // The record was never the map's to draw. Counting it as unplaced reports a
    // claim about the map that is not true of the filter.
    const coverage = app.mapCoverage({
      total: 50, placed: 50, tooLarge: 0, outsideFrame: 0,
      undetermined: { severity: 9, source: 0 },
    })
    assert.equal(coverage.unplaced, 0, 'a filter exclusion is not an unplaced record')
    assert.equal(coverage.filtered, 9)
    // But it is still something to declare: the panel is not hidden.
    assert.equal(coverage.complete, false)
  })

  it('names each reason separately, because each has a different fix', () => {
    const coverage = app.mapCoverage({ total: 20, placed: 5, tooLarge: 3, outsideFrame: 2 })
    assert.deepEqual(coverage.reasons.map((r) => r.kind), ['outside_frame', 'too_large'])
    assert.equal(coverage.reasons.find((r) => r.kind === 'too_large').count, 3)
    assert.equal(coverage.reasons.find((r) => r.kind === 'outside_frame').count, 2)
  })

  it('carries the undetermined reason by field, not as one lump', () => {
    const coverage = app.mapCoverage({
      total: 10, placed: 6, undetermined: { severity: 3, source: 1 },
    })
    const undetermined = coverage.reasons.filter((r) => r.kind === 'undetermined')
    assert.deepEqual(undetermined.map((r) => r.field).sort(), ['severity', 'source'])
  })

  it('is complete — and so unannotated — only when nothing is missing', () => {
    const coverage = app.mapCoverage({ total: 12, placed: 12 })
    assert.equal(coverage.complete, true)
    assert.deepEqual(coverage.reasons, [])
    assert.equal(coverage.unplaced, 0)
    assert.equal(coverage.filtered, 0)
  })

  it('does not treat a zero as an absent reason', () => {
    // The house rule, and the bug class this repo has paid for twice: a zero
    // count is a count, and a reason that did not happen is not a reason. A
    // `reasons` carrying `{kind: 'too_large', count: 0}` would render "0
    // reported areas too large to place" — a strip the operator learns to skip.
    const coverage = app.mapCoverage({ total: 8, placed: 8, tooLarge: 0, outsideFrame: 0, undetermined: { severity: 0 } })
    assert.deepEqual(coverage.reasons, [])
    assert.equal(coverage.complete, true)
  })

  it('handles the degenerate empty map without dividing by anything', () => {
    const coverage = app.mapCoverage({})
    assert.equal(coverage.total, 0)
    assert.equal(coverage.placed, 0)
    assert.equal(coverage.unplaced, 0)
    assert.equal(coverage.complete, true)
  })
})

describe('ENH-70 — the panel the accounting lands in', () => {
  it('the markup declares the element the renderer writes to', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
    for (const id of ['mapCoverageOverlay', 'mapCoverageSummary', 'mapCoverageRows']) {
      assert.ok(html.includes(`id="${id}"`), `${id} is not in the console markup`)
    }
    // Hidden by default: a map that is showing everything should not carry a
    // permanent "nothing missing" strip.
    assert.match(html, /id="mapCoverageOverlay"[^>]*\shidden/)
  })

  it('every key the renderer asks for is in the base catalogue', () => {
    // `t()` resolves a missing key to the key name, so a key absent from
    // en.json is a key name rendered in the panel — and the console offers nine
    // locales, so it is a key name in nine languages.
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'i18n', 'en.json'), 'utf8'))
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
    const asked = new Set()
    for (const [, key] of src.matchAll(/\bt\(\s*'(map\.[a-z0-9_.]+)'/g)) asked.add(key)
    // The three the renderer builds by name rather than by literal.
    asked.add('map.field_severity')
    asked.add('map.field_source')
    asked.add('map.coverage_summary')
    asked.add('map.filtered_note')
    const missing = [...asked].filter((k) => !(k in en))
    assert.deepEqual(missing, [], `the coverage panel renders raw key names: ${missing.join(', ')}`)
  })

  it('a catalogue key that carries a placeholder has a renderer that fills it', () => {
    // A `{n}` left unfilled renders literally, which is the same failure as a
    // raw key with a different spelling. Every `{placeholder}` in a map.* key
    // must appear in a `t()` call with that variable.
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'i18n', 'en.json'), 'utf8'))
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
    const problems = []
    for (const [key, value] of Object.entries(en)) {
      if (!key.startsWith('map.')) continue
      for (const [, name] of String(value).matchAll(/\{([a-z_]+)\}/g)) {
        // The renderer must name the variable somewhere in a t() call for this
        // key, or in the generic filler above it.
        if (!new RegExp(`\\b${name}:`).test(src)) problems.push(`${key} wants {${name}} and nothing supplies it`)
      }
    }
    assert.deepEqual(problems, [])
  })
})
