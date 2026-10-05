#!/usr/bin/env node
/**
 * R-61/R-62/R-63 — the locale layer, and the three ways it lied.
 *
 * Three defects, all in the same subsystem, all producing the same visible
 * symptom: a reader in a language the product claims to support sees the
 * product's internal identifiers instead of words.
 *
 *   R-61  `navbar.js` set the correct English fallback via `i18nText` and then
 *         added `data-i18n`. The next sweep wrote `catalog[key] || key` over it
 *         — the key. Correct code, undone by the line after it. Measured in a
 *         Somali session: 48 of 56 elements on /portal/, 17 of 78 on /chw/,
 *         16 of 23 on /focal-point/.
 *   R-62  `initI18n` loaded only the chosen locale, so English was never the
 *         base layer at boot — only in `set()`, which runs only on a locale
 *         change. Coverage: 49% (sw), 23% (so), 12% (ar/din/km/nk).
 *   R-63  `applyLocaleToDocument` was called from the console and from `set()`,
 *         never at boot on a non-console surface. Arabic was offered on five
 *         surfaces and rendered as `lang="en" dir="ltr"` — a right-to-left
 *         language laid out left-to-right, which is worse than not offering it,
 *         because it looks finished.
 *
 * The test asserts on source rather than in a browser because the defects are
 * *about* source structure: whether an attribute is present next to a helper
 * call, and whether a boot sequence calls the applier. A rendered-DOM
 * assertion would need a live catalogue fetch per locale per surface, and
 * would pass for the wrong reason whenever the fetch failed.
 *
 * It fails closed on the one thing that matters: the list of surfaces is
 * explicit, and a surface added later without a locale boot call is a failing
 * assertion rather than a silently unchecked one.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

/** Source with comments and template literals stripped. See the header. */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const CATALOG = JSON.parse(read('public/i18n/en.json'))

/** Every surface. One missed here is a surface nobody checked. */
const SURFACES = [
  { dir: 'portal', module: 'public/portal/app.js' },
  { dir: 'co', module: 'public/co/app.js' },
  { dir: 'focal-point', module: 'public/focal-point/app.js' },
  { dir: 'districts', module: 'public/districts/app.js' },
  { dir: 'parametric', module: 'public/parametric/app.js' },
  { dir: 'scenarios', module: 'public/scenarios/app.js' },
]

/* ================================================================== R-61 */

describe('R-61 — the navbar does not register a key it then overwrites', () => {
  const navbar = read('public/shared/navbar.js')

  it('no surface link carries data-i18n', () => {
    // `i18nText(s.key, s.label)` writes the correct English fallback.
    // `setAttribute('data-i18n', s.key)` registers the raw key for the next
    // sweep, and `applyI18n` writes `catalog[key] || key` — so the label
    // becomes the literal string `nav.ops`. The two lines together are a bug
    // that reads, line by line, as correct code.
    //
    // Both call sites existed: the desktop list and the mobile drawer, which is
    // why the measurement differed per surface — only one of the two had been
    // found and fixed each time.
    const offenders = []
    const lines = navbar.split('\n')
    lines.forEach((line, i) => {
      if (!/setAttribute\(\s*['"]data-i18n['"]/.test(line)) return
      // `data-i18n-title` is a different attribute and is not affected.
      offenders.push(`navbar.js:${i + 1}: ${line.trim()}`)
    })
    assert.deepEqual(offenders, [],
      'an element whose text was set from a fallback must not also register the key; ' +
      'the sweep overwrites the fallback with the key')
  })

  it('the surface labels still resolve to real English words', () => {
    // Deleting the attribute must not delete the fallback with it. If someone
    // "cleans up" the SURFACES labels later, a nav reading "nav.ops" returns.
    const block = /const SURFACES = \[([\s\S]*?)\n\]/.exec(navbar)
    assert.ok(block, 'the SURFACES table is present')
    const entries = [...block[1].matchAll(/key:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
    assert.ok(entries.length >= 8, `expected the eight surfaces, found ${entries.length}`)
    for (const [, key, label] of entries) {
      assert.ok(CATALOG[key] !== undefined,
        `${label} falls back to "${label}" because en.json has no "${key}" — ` +
        'the fallback and the catalogue have drifted apart')
      assert.notEqual(key, label, `${key}: the fallback must be a word, not the key`)
    }
  })
})

/* ================================================================== R-62 */

describe('R-62 — English is the base layer at boot, not only after a locale change', () => {
  it('co/ layers its locale over English rather than replacing it', () => {
    // `co/` ships a private copy of the loader. The copy fetched only the
    // requested locale, so `t(key, fallback)` fell through to the raw key for
    // every string the locale omitted — and `so` is 23% covered, so that was
    // most of the page. This is the cost of having a private copy: the bug
    // that `set()` already fixed lived on in the copy.
    const src = code('public/co/app.js')
    assert.match(src, /fetch\(\s*['"]\/i18n\/en\.json['"]\s*\)/,
      'co must read en.json as the base layer before overlaying the chosen locale')
    assert.match(src, /if \(locale !== ['"]en['"]\)/,
      'the chosen locale overlays the base rather than replacing it')
  })

  it('every offered locale is checked for the keys its surfaces actually use', () => {
    // The offer floor in `check-i18n-offers.mjs` is justified in prose by
    // "English is the base layer and an untranslated key falls back to it".
    // That is only true if `initI18n` loads English — and it did not. So the
    // floor was defending a fallback that did not exist at boot, which is why
    // `initI18n` is the change that has to land in `shared/runtime.js` (not
    // owned here). This assertion pins the *evidence* for that report: the
    // number of keys a partially-covered locale would have dropped.
    const offered = ['sw', 'so', 'ar', 'fr', 'pt', 'din', 'km', 'nk', 'am']
    const report = offered.map((loc) => {
      let cat
      try { cat = JSON.parse(read(`public/i18n/${loc}.json`)) } catch { return null }
      const defined = Object.keys(cat).length
      const covered = Object.keys(CATALOG).filter((k) => cat[k] !== undefined).length
      return { loc, defined, covered, pct: Math.round((covered / Object.keys(CATALOG).length) * 100) }
    }).filter(Boolean)
    // At least one shipped locale is materially incomplete against en.json.
    // If every locale were 100% covered the base-layer defect would be
    // invisible and this whole file would be asserting nothing.
    const worst = Math.min(...report.map((r) => r.pct))
    assert.ok(worst < 100,
      `every locale covers 100% of en.json (${report.map((r) => `${r.loc}:${r.pct}%`).join(', ')}); ` +
      'if that is now true, the base-layer fix is verifiable end-to-end and this ' +
      'assertion should be replaced with a coverage requirement')
  })
})

/* ================================================================== R-63 */

describe('R-63 — lang and dir are correct at boot on every surface', () => {
  for (const { dir, module } of SURFACES) {
    it(`${dir} applies its locale to the document at boot`, () => {
      const src = code(module)
      assert.match(src, /applyLocaleToDocument/,
        `${dir} never calls applyLocaleToDocument, so a reader on an Arabic ` +
        'phone gets lang="en" dir="ltr" — an RTL language laid out LTR, which ' +
        'is worse than not offering it because it looks finished')
    })

    it(`${dir} imports applyLocaleToDocument from the shared module`, () => {
      // A private `locale === 'ar' ? 'rtl' : 'ltr'` is the thing R-63 exists to
      // prevent: it puts the RTL list in a second place, and adding a locale
      // then silently misses it.
      const src = code(module)
      assert.match(src, /import\s*\{[^}]*applyLocaleToDocument[^}]*\}\s*from\s*['"]\/shared\/fmt\.js['"]/,
        `${dir} must import applyLocaleToDocument from /shared/fmt.js`)
      // Strip import lines first: the shared import legitimately names
      // `applyLocaleToDocument`, and a regex over the whole file flags the
      // import that is the *fix* as though it were the defect.
      const body = src.replace(/^import[^\n]*\n/gm, '')
      assert.doesNotMatch(body, /\?\s*['"]rtl['"]\s*:\s*['"]ltr['"]/,
        `${dir} hardcodes the RTL decision; the locale table in fmt.js is the one place`)
      assert.doesNotMatch(body, /documentElement\.dir\s*=/,
        `${dir} writes dir directly instead of through applyLocaleToDocument`)
    })
  }

  it('the console is not double-applying lang/dir in two places', () => {
    // The console called it in two places already — once in the locale loader
    // and once inside `applyI18n`, so every sweep re-set it. Harmless, but it
    // is the reason the console was the one surface with correct `dir` and the
    // other seven were not: it got there by accident rather than by contract.
    const src = code('public/app.js')
    const calls = (src.match(/applyLocaleToDocument\(/g) || []).length
    assert.ok(calls <= 3,
      `applyLocaleToDocument is called ${calls} times in app.js; the locale ` +
      'table is the single source of truth and the document write belongs in one place')
  })

  it('every surface declares lang and dir in its markup as a starting default', () => {
    // Not the fix — the fix is the boot call — but a surface with no `lang` at
    // all is wrong before any script runs, and the boot call can only correct
    // what it finds.
    for (const dir of [...SURFACES.map((s) => s.dir), 'chw']) {
      const html = read(`public/${dir}/index.html`)
      assert.match(html, /<html[^>]*\blang="/, `public/${dir}/index.html has no lang on <html>`)
      assert.match(html, /<html[^>]*\bdir="/, `public/${dir}/index.html has no dir on <html>`)
    }
  })
})

/* ============================================== shared module boundaries */

describe('the locale table stays in one place', () => {
  it('fmt.js is the only module that maps a locale to a direction', () => {
    // Enumerated rather than globbed so a second implementation in a file that
    // does not exist yet fails the assertion when it is added, rather than
    // being noticed a year later.
    const CANDIDATES = [
      'public/app.js',
      'public/shared/navbar.js',
      'public/shared/fmt.js',
      ...SURFACES.map((s) => s.module),
    ]
    const offenders = []
    for (const rel of CANDIDATES) {
      const src = code(rel)
      src.split('\n').forEach((line, i) => {
        // `isRtl()` is the shared helper; a local `locale === 'ar'` is not.
        if (!/\bar\b/.test(line)) return
        if (/isRtl|applyLocaleToDocument|import|export/.test(line)) return
        if (/['"]rtl['"]/.test(line) || /['"]ltr['"]/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    assert.deepEqual(offenders, [],
      'the RTL locale list belongs in fmt.js; a second copy is a locale added ' +
      'to one place and forgotten in the other')
  })
})