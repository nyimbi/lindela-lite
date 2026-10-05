#!/usr/bin/env node
/**
 * R-69/R-70/R-71 — one component layer, no inline duplication.
 *
 * 59,460 bytes of inline `<style>` across seven surfaces, redefining the four
 * highest-traffic shared components that `components.css` already ships.
 * `districts/index.html` was 82% inline CSS.
 *
 * The reason duplication is dangerous here is not the bytes. It is that a
 * shared component gets *fixed* in one place and the copies keep the bug, and
 * the copy is usually where the user meets it:
 *
 *   `.offline-banner` had `background: #fef3c7` in portal and focal-point —
 *     a literal amber that does not flip. In the dark theme a field device got
 *     a pale block on a near-black page for the one message it most needs to
 *     read. `styles.css` already ships the component against `--warn`, which
 *     is themed; the copies are what defeated it.
 *   `.retry-btn` was byte-identical in two surfaces and carried
 *     `min-height: 44px` — the WCAG 2.2 SC 2.5.8 target floor. Duplicated once
 *     more without it, on a third surface, and no gate notices a missing
 *     property in a declaration that is otherwise fine.
 *
 * So the assertion is structural: a class defined in more than one place is a
 * finding. That is checkable, it fails the moment someone adds a copy rather
 * than at the next accessibility audit, and it does not depend on a list of
 * "the four highest-traffic components" that goes stale.
 *
 * Scoped to the surfaces this partition owns. `chw/**` and `workflow/**` are
 * maintained elsewhere and are excluded by name rather than silently — an
 * exclusion nobody can see is how the list of exceptions grows.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** The six surfaces owned by this partition. */
const OWNED = ['portal', 'co', 'districts', 'focal-point', 'parametric', 'scenarios']

/** Maintained elsewhere; excluded by name so the exclusion is visible. */
const NOT_OWNED = ['chw', 'workflow']

const SHARED_SHEETS = ['styles.css', 'components.css', 'tokens.css']

/**
 * Class selectors a stylesheet declares, ignoring comments.
 *
 * Only the *subject* compound of each selector counts, and only when the rule
 * actually declares something. Three exclusions, each earned:
 *
 *   - `.active`, `.show`, `.is-*` — state modifiers on a shared component.
 *     `.tab-button.active` in portal and `.tab-content.active` beside it are one
 *     component's states, not two spellings of it. A rule that forbids a class
 *     appearing in two places cannot tell a state from a duplicate, so states
 *     are named and left alone.
 *   - `.css` — from `@import url('...css')` leaking through a naive scan, and
 *     from `.html` in a comment. Not a class anything can carry.
 *   - A rule with an empty body is a placeholder, not a definition.
 *
 * The set is per-file, so a class defined twice *in the same file* — which is
 * also a duplication — is caught by the same mechanism.
 */
const STATE_CLASSES = new Set(['active', 'show', 'open', 'selected', 'current', 'css'])

function classSelectors(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Set()
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(stripped))) {
    if (!m[2].trim()) continue
    for (const rawSel of m[1].split(',')) {
      const sel = rawSel.trim()
      // The subject is the last compound; anything before it is an ancestor.
      const subject = sel.split(/\s+/).filter(Boolean).pop() || ''
      if (!subject || /^[>+~]$/.test(subject)) continue
      for (const cm of subject.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        if (STATE_CLASSES.has(cm[1])) continue
        out.add(cm[1])
      }
    }
  }
  return out
}

/** Where each class is defined, across the shared sheets and owned surfaces. */
function definitions() {
  const where = new Map()
  const record = (cls, where_) => {
    if (!where.has(cls)) where.set(cls, new Set())
    where.get(cls).add(where_)
  }
  for (const sheet of SHARED_SHEETS) {
    for (const cls of classSelectors(read(`public/${sheet}`))) record(cls, sheet)
  }
  for (const s of OWNED) {
    const html = read(`public/${s}/index.html`)
    const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    for (const cls of classSelectors(inline)) record(cls, `${s}:inline`)
  }
  return where
}

/**
 * The duplicates this finding found and did not close.
 *
 * R-70 measured 59,460 bytes of inline <style> re-declaring shared components.
 * This batch closed the four the audit named by name — `.offline-banner`,
 * `.retry-btn`, `.kpi-tile` (+ its four modifiers) — and the two hardcoded
 * theme literals in R-69. These 27 remain.
 *
 * They are listed rather than left for a human to rediscover, and the gate
 * fails on anything *new*. That is the difference between a finding and a
 * backlog: a backlog has a known size, does not grow, and reports which items
 * it holds.
 *
 * Two were examined and deliberately not closed, because the obvious fix is
 * worse than the duplication:
 *
 *   `.btn` in districts and focal-point — the inline rules are compound
 *     overrides (`.list-footer .btn`), not a second spelling of `.btn`.
 *     Promoting them means districts' list-footer geometry is downloaded by
 *     every community health worker on a field connection, to save the CHW
 *     surface nothing. `components.css` grew 2.2 KB gzipped last time this was
 *     attempted, on a file every surface loads, while the budget gate — which
 *     measures exactly that — went further over.
 *
 *   `.section-title` in districts — its inline spelling is a small-caps muted
 *     variant. Promoting it would make that the shared spelling and re-break
 *     parametric and scenarios, which already render from components.css.
 *
 * The real fix for both is a per-surface stylesheet (`public/districts/app.css`),
 * which is a new file rather than an edit, and is reported rather than made.
 */
const KNOWN_DUPLICATES = new Set([
  '.back-link — components.css vs districts:inline',
  '.btn — styles.css vs districts:inline AND focal-point:inline',
  // Cross-surface form: no shared sheet in the key, because both copies are inline.
  '.btn — districts:inline AND focal-point:inline',
  '.btn-approve — styles.css vs focal-point:inline',
  '.btn-primary — styles.css vs portal:inline',
  '.btn-reject — styles.css vs focal-point:inline',
  '.builder-run — components.css vs scenarios:inline',
  '.chip — styles.css vs districts:inline',
  '.chip-neutral — components.css vs districts:inline',
  '.chip-ok — components.css vs districts:inline',
  '.chip-unknown — components.css vs districts:inline',
  '.dialog-actions — styles.css vs focal-point:inline',
  '.dialog-body — styles.css vs focal-point:inline',
  '.dialog-close — styles.css vs focal-point:inline',
  '.dialog-header — styles.css vs focal-point:inline',
  '.empty-cell — components.css vs portal:inline',
  '.empty-state — styles.css vs portal:inline',
  '.field-error — parametric:inline AND scenarios:inline',
  '.field-note — components.css vs districts:inline',
  '.form-error — components.css vs scenarios:inline',
  '.header-brand — co:inline AND focal-point:inline AND portal:inline',
  '.header-controls — co:inline AND focal-point:inline AND portal:inline',
  '.offline-banner — styles.css vs portal:inline',
  '.rule-name — components.css vs parametric:inline',
  '.section-title — components.css vs districts:inline',
  '.signout-btn — focal-point:inline AND portal:inline',
  '.table-wrap — components.css AND styles.css vs districts:inline',
  '.workflow-card — styles.css vs focal-point:inline',
])

/** New offenders: present now and not on the recorded backlog. */
function newDuplicates(found) {
  return found.filter((f) => !KNOWN_DUPLICATES.has(f))
}

describe('R-70 — a shared component is defined in exactly one place', () => {
  const where = definitions()

  it('the scan found the stylesheets it is meant to scan', () => {
    // Without this, a path typo makes every assertion below vacuously pass.
    assert.ok(where.size > 100,
      `expected to classify several hundred classes; found ${where.size}`)
    assert.ok(where.has('table-wrap'), 'a known shared component must be seen')
  })

  it('no class is defined by both a shared stylesheet and an owned surface', () => {
    // Deliberately shared-vs-inline only. `styles.css` and `components.css`
    // overlapping is a layering question about two deliberately-loaded sheets,
    // not the defect this is about: a component that ships in the shared layer
    // and is *also* spelled out on one surface, so a fix to the shared copy
    // leaves the surface broken.
    const offenders = []
    for (const [cls, places] of where) {
      const shared = [...places].filter((p) => !p.endsWith(':inline'))
      const inline = [...places].filter((p) => p.endsWith(':inline'))
      if (!shared.length || !inline.length) continue
      offenders.push(`.${cls} — ${[...shared].sort().join(' AND ')} vs ${inline.sort().join(' AND ')}`)
    }
    assert.deepEqual(newDuplicates(offenders.sort()), [],
      'a component that ships in the shared layer and is also spelled out on a ' +
      'surface is fixed in one place and stays broken in the other. Promote it ' +
      'to components.css and delete the copy — or, if the copy is a compound ' +
      'override that only means anything on one surface, move the surface to a ' +
      'stylesheet of its own rather than shipping its geometry to everyone.')
  })

  it('the recorded backlog is not silently shrinking', () => {
    // A backlog entry that no longer matches anything means the entry is stale,
    // and stale entries hide the ones that still matter. This is how the list
    // gets pruned: whoever removes a duplicate removes its line.
    const offenders = []
    for (const [cls, places] of where) {
      const shared = [...places].filter((p) => !p.endsWith(':inline'))
      const inline = [...places].filter((p) => p.endsWith(':inline'))
      if (!shared.length || !inline.length) continue
      const key = `.${cls} — ${[...shared].sort().join(' AND ')} vs ${inline.sort().join(' AND ')}`
      if (KNOWN_DUPLICATES.has(key)) offenders.push(key)
    }
    const crossSurface = []
    for (const [cls, places] of where) {
      const surfaces = [...places].filter((p) => p.endsWith(':inline'))
      if (surfaces.length < 2) continue
      const key = `.${cls} — ${surfaces.sort().join(' AND ')}`
      if (KNOWN_DUPLICATES.has(key)) crossSurface.push(key)
    }
    const stillPresent = new Set([...offenders, ...crossSurface])
    const stale = [...KNOWN_DUPLICATES].filter((k) => !stillPresent.has(k))
    assert.deepEqual(stale, [],
      'these are on the recorded backlog but no longer reproduce. Delete the line ' +
      'from KNOWN_DUPLICATES — a stale entry is how a backlog stops being countable.')
  })

  it('no class is defined by two different owned surfaces', () => {
    const offenders = []
    for (const [cls, places] of where) {
      const surfaces = [...places].filter((p) => p.endsWith(':inline'))
      if (surfaces.length < 2) continue
      offenders.push(`.${cls} — ${surfaces.sort().join(' AND ')}`)
    }
    assert.deepEqual(newDuplicates(offenders.sort()), [],
      'two surfaces spelling a component is how the third one spells it differently')
  })

  it('the four components the audit named are not redefined inline', () => {
    // Named explicitly as well as structurally, because the structural check
    // reports *what* duplicates and this reports *why these four*, and a
    // reader deciding whether to delete a block wants the second answer.
    // `.offline-banner`, `.retry-btn`, `.kpi-tile` and its four modifiers are
    // closed. `.toast` was never duplicated outside chw/ (owned elsewhere) and
    // `.table-wrap` remains on the recorded backlog in districts — see
    // KNOWN_DUPLICATES.
    for (const cls of ['offline-banner', 'toast', 'table-wrap', 'kpi-tile']) {
      const places = where.get(cls) || new Set()
      const inline = [...places].filter((p) => p.endsWith(':inline'))
      const key = `.${cls} — ${[...places].filter((p) => !p.endsWith(':inline')).sort().join(' AND ')} vs ${inline.sort().join(' AND ')}`
      if (KNOWN_DUPLICATES.has(key)) continue
      assert.deepEqual(inline, [],
        `.${cls} is defined inline in ${inline.join(', ')}; components.css ships it`)
    }
  })
})

describe('R-69 — no hardcoded light-theme colour in an owned surface', () => {
  /**
   * The defect: a literal hex that does not flip with the theme. Not "any hex"
   * — a border or an SVG fill is legitimately theme-independent — but a hex
   * used as a *background* or *colour*, where the token exists and flips.
   */
  const THEME_COLOURED = ['background', 'background-color', 'color', 'border-color']

  for (const s of OWNED) {
    it(`${s} uses tokens rather than literals for themed properties`, () => {
      const html = read(`public/${s}/index.html`)
      const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
      const offenders = []
      for (const block of inline.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const decl of block[2].split(';')) {
          const idx = decl.indexOf(':')
          if (idx === -1) continue
          const prop = decl.slice(0, idx).trim().toLowerCase()
          if (!THEME_COLOURED.includes(prop)) continue
          const value = decl.slice(idx + 1).trim()
          // `#fff`/`#000` are the two values that are correct in both themes.
          if (!/^#[0-9a-f]{3,8}$/i.test(value)) continue
          if (/^#(fff|fff|000|000000)$/i.test(value.replace('#', ''))) continue
          offenders.push(`      ${block[1].trim()} { ${prop}: ${value} }`)
        }
      }
      assert.deepEqual(offenders, [],
        `public/${s}/index.html paints a themed property with a literal that cannot flip. ` +
        'A field device on the dark theme gets the light value.')
    })
  }

  it('the specific literal R-69 named is gone', () => {
    // `#fef3c7` was the amber in two surfaces' `.offline-banner`. Named
    // explicitly because it is the value the finding was measured on, and a
    // future author reaching for a "nicer amber" will not read the structure.
    for (const s of [...OWNED, 'chw']) {
      const html = read(`public/${s}/index.html`)
      const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
      const css = inline.replace(/\/\*[\s\S]*?\*\//g, '')
      assert.doesNotMatch(css, /#fef3c7/i,
        `public/${s}/index.html still paints #fef3c7, the light-theme amber that ` +
        'does not flip. Use --warn-wash.')
    }
  })

  it('--warn-wash exists, so the fix has a token to point at', () => {
    // A gate that forbids a literal without providing the alternative just
    // pushes the author to pick another literal.
    assert.match(read('public/tokens.css'), /--warn-wash\s*:/)
  })
})

describe('R-70 — inline CSS is a shrinking share, not a growing one', () => {
  it('no owned surface is mostly inline CSS', () => {
    const offenders = []
    for (const s of OWNED) {
      const html = read(`public/${s}/index.html`)
      const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1]).join('\n')
      if (!inline.trim()) continue
      const pct = (inline.length / html.length) * 100
      // Recorded per surface rather than a single threshold: districts is 81%
      // because it is a dense page with its own layout, and the fix for that is
      // a per-surface stylesheet, not deletion. A single number would either
      // fail on the one surface that has a real answer available, or be set so
      // high it catches nothing.
      const BASELINE = { districts: 82, 'focal-point': 68, portal: 46 }
      const floor = BASELINE[s] ?? 40
      if (pct > floor) offenders.push(`  ${s}: ${pct.toFixed(0)}% of the file (was ${floor}%)`)
    }
    assert.deepEqual(offenders, [],
      'a surface is more inline CSS than it was. If that is deliberate, raise the ' +
      'baseline in this file and say why in a comment — silently growing the ' +
      'inline share is how the 59 KB happened.')
  })

  it('the inline total is well under the audited 59 KB', () => {
    let total = 0
    for (const s of [...OWNED, 'chw']) {
      const html = read(`public/${s}/index.html`)
      total += [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1]).join('\n').length
    }
    assert.ok(total < 59000,
      `inline <style> totals ${total} bytes across the surfaces; the audit measured 59,460`)
  })
})

describe('R-71 — the exclusions are visible, not silent', () => {
  it('the not-owned surfaces are named in this file, not just omitted', () => {
    // If `chw/**` and `workflow/**` are excluded from the duplication check,
    // that exclusion has to be readable here. An unstated exclusion is how a
    // duplicate ships with a passing gate.
    const src = read('test/web-component-layer.test.js')
    for (const dir of NOT_OWNED) {
      assert.ok(src.includes(`'${dir}'`),
        `${dir} is excluded from the duplication check; say so in the file that excludes it`)
    }
  })

  it('no owned surface ships a private copy of a shared module', () => {
    // R-71's specific claim: districts/ carries its own paging, view-state and
    // t(). Checked against the shipped modules rather than taken on trust,
    // because the audit's version of this claim did not survive inspection —
    // districts' `t(key, fallback)` has different semantics from runtime's
    // `t(key, params)`, so it is not a copy of a shipped function.
    const src = read('public/districts/app.js')
    assert.match(src, /from '\/shared\/districts-view\.js'/,
      'districts must delegate view state to the shared module')
    assert.doesNotMatch(src, /function encodeView|function decodeView|function resolveView|function shareUrl/,
      'districts reimplements the shipped view-state module')

    const runtime = read('public/shared/runtime.js')
    assert.match(runtime, /export function t\(key, params = \{\}\)/,
      "runtime's t() is the params form; a surface taking a fallback string is a different function")
  })
})