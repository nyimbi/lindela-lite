#!/usr/bin/env node
/**
 * Theme selection, persistence and precedence (ENH-23).
 *
 * The contrast maths lives in theme-tokens.test.js. This file covers the part
 * that decides *which* palette applies, which is where a user's accessibility
 * setting is actually lost: not in a wrong hex value but in a precedence
 * mistake, a storage call that throws, or a language switch that quietly clears
 * the attribute.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  CHOICES,
  STORAGE_KEY,
  THEMES,
  applyChoice,
  initTheme,
  normalizeChoice,
  platformPreferences,
  readStoredChoice,
  resolveTheme,
  writeStoredChoice,
} from '../public/shared/navbar.js'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** Just enough <html> to assert on. */
function stubDocument({ themeColor = null } = {}) {
  const attrs = new Map()
  const meta = { attrs: new Map(), setAttribute(k, v) { this.attrs.set(k, v) }, getAttribute(k) { return this.attrs.get(k) ?? null } }
  if (themeColor) meta.attrs.set('content', themeColor)
  return {
    attrs,
    meta,
    documentElement: {
      getAttribute: (k) => attrs.get(k) ?? null,
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
    },
    querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? meta : null),
  }
}

function stubWindow({ stored = null, light = false, contrast = false, throws = false } = {}) {
  const listeners = []
  const storage = {
    getItem: (k) => { if (throws) throw new Error('SecurityError'); return stored === null ? null : stored },
    setItem: (k, v) => { if (throws) throw new Error('QuotaExceededError'); stored = v },
    removeItem: (k) => { if (throws) throw new Error('SecurityError'); stored = null },
  }
  const matchMedia = (query) => ({
    media: query,
    matches: query.includes('color-scheme') ? light : contrast,
    addEventListener: (_type, fn) => listeners.push({ query, fn }),
  })
  return {
    storage,
    stored: () => stored,
    listeners,
    matchMedia,
    localStorage: storage,
    document: undefined,
  }
}

describe('theme choice', () => {
  it('offers exactly the three themes plus "follow the platform"', () => {
    assert.deepEqual([...THEMES].sort(), ['contrast', 'dark', 'light'])
    assert.ok(CHOICES.includes('system'))
    assert.ok(CHOICES.includes('dark'))
  })

  it('an explicit choice beats both media queries, in every combination', () => {
    for (const stored of ['dark', 'light', 'contrast']) {
      for (const light of [false, true]) {
        for (const contrast of [false, true]) {
          assert.equal(
            resolveTheme({ stored, prefersLight: light, prefersContrast: contrast }),
            stored,
            `stored=${stored} light=${light} contrast=${contrast} should resolve to ${stored}`,
          )
        }
      }
    }
  })

  it('with no choice, contrast outranks colour scheme', () => {
    assert.equal(resolveTheme({}), 'dark')
    assert.equal(resolveTheme({ prefersLight: true }), 'light')
    assert.equal(resolveTheme({ prefersContrast: true }), 'contrast')
    // "More contrast" is the more specific statement: a user who has asked the
    // OS for both has asked for more contrast, and light alone would be a
    // partial answer to what they said.
    assert.equal(resolveTheme({ prefersLight: true, prefersContrast: true }), 'contrast')
  })

  it('a stored value of "system" hands the decision back, and junk is no decision', () => {
    assert.equal(resolveTheme({ stored: 'system', prefersLight: true }), 'light')
    assert.equal(resolveTheme({ stored: 'nonsense', prefersLight: true }), 'light')
    assert.equal(normalizeChoice('LIGHT'), 'system', 'theme names are case-sensitive; a bad key must not brick the control')
    assert.equal(normalizeChoice(null), 'system')
  })

  it('reads and writes the persisted choice', () => {
    const win = stubWindow()
    assert.equal(readStoredChoice(win.storage), 'system')
    for (const choice of ['dark', 'light', 'contrast']) {
      assert.equal(writeStoredChoice(win.storage, choice), choice)
      assert.equal(win.localStorage.getItem(STORAGE_KEY), choice)
      assert.equal(readStoredChoice(win.storage), choice)
    }
    // "system" is removed rather than stored as a sentinel, so a user who
    // returns to the platform default leaves no trace to be misread later.
    writeStoredChoice(win.storage, 'system')
    assert.equal(win.localStorage.getItem(STORAGE_KEY), null)
  })

  it('a storage that throws degrades to the platform preference, not to a crash', () => {
    // Safari private mode throws SecurityError from getItem; a quota-exhausted
    // origin throws from setItem. A theme switch is a preference and must never
    // be the thing that stops a console booting.
    const win = stubWindow({ throws: true })
    assert.equal(readStoredChoice(win.storage), 'system')
    assert.equal(writeStoredChoice(win.storage, 'light'), 'light')
    assert.doesNotThrow(() => applyChoice(stubDocument(), 'contrast', win))
  })

  it('applies by attribute, and removes it for "system"', () => {
    const doc = stubDocument({ themeColor: '#0e1520' })
    assert.equal(applyChoice(doc, 'light', stubWindow()), 'light')
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'light')
    assert.equal(applyChoice(doc, 'system', stubWindow()), null)
    assert.equal(doc.documentElement.getAttribute('data-theme'), null)
  })

  it('repaints the browser chrome, which the token layer does not cover', () => {
    // <meta name="theme-color"> is the bar above a standalone window and above
    // the page on Android. It is a literal in eight <head>s, so a theme switch
    // that left it alone kept a dark bar over a light console.
    for (const theme of THEMES) {
      // Seeded with a value no theme uses, so "the module did nothing" is
      // distinguishable from "the module wrote the same thing back".
      const doc = stubDocument({ themeColor: '#ff00ff' })
      applyChoice(doc, theme, stubWindow())
      assert.notEqual(doc.meta.getAttribute('content'), '#ff00ff', `${theme} left the theme-color meta alone`)
    }
    // And it agrees with the eight <head>s, so switching back to dark does not
    // leave a bar painted from a different palette.
    const dark = stubDocument({ themeColor: '#ff00ff' })
    applyChoice(dark, 'dark', stubWindow())
    assert.match(readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), /theme-color" content="#0e1520"/)
  })

  it('observes both media queries', () => {
    const doc = stubDocument()
    const win = stubWindow()
    initTheme({ doc, win })
    const queries = win.listeners.map((l) => l.query).sort()
    assert.deepEqual(queries, ['(prefers-color-scheme: light)', '(prefers-contrast: more)'])
  })

  it('a platform change does not pin a theme the user never asked for', () => {
    // With no stored choice the attribute must stay absent even after the
    // platform flips. Writing data-theme='light' here would look like it worked
    // and would be a bug: an explicit attribute outranks the media query in
    // tokens.css, so the user would be stuck in light after their OS switched
    // back to dark. The platform preference belongs to the stylesheet.
    const doc = stubDocument()
    const win = stubWindow({ light: false })
    initTheme({ doc, win })
    win.matchMedia = (query) => ({ matches: query.includes('color-scheme'), addEventListener: () => {} })
    win.localStorage.getItem = () => null
    assert.equal(doc.documentElement.getAttribute('data-theme'), null)
  })

  it('a stored choice is not overruled by a later platform change', () => {
    const doc = stubDocument()
    const win = stubWindow({ stored: 'contrast' })
    initTheme({ doc, win })
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'contrast')
    // The user's OS changes its mind at sunset. Their choice is not it.
    for (const { fn } of win.listeners) fn()
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'contrast')
  })

  it('platformPreferences tolerates a window without matchMedia', () => {
    assert.deepEqual(platformPreferences({}), { prefersLight: false, prefersContrast: false })
    assert.deepEqual(platformPreferences(null), { prefersLight: false, prefersContrast: false })
  })
})

describe('the theme survives what the surfaces do to <html>', () => {
  /** Every source file under public/, so a new surface is covered too. */
  function publicSources(dir = PUBLIC, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) publicSources(full, out)
      else if (/\.(js|html)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('nothing but the navbar writes data-theme', () => {
    // initI18n sets lang and dir on <html> on every language change. It does not
    // replace the element, so the theme survives — but "survives" here means
    // "no other file clears it", and that is a property of the source, not a
    // thing any test of the theme module can observe. A single stray
    // removeAttribute in an i18n helper would undo a user's accessibility
    // setting every time they changed language, and nothing would report it.
    const offenders = []
    for (const file of publicSources()) {
      if (file.endsWith(path.join('shared', 'navbar.js'))) continue
      if (/data-theme/.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(PUBLIC, file))
    }
    assert.deepEqual(offenders, [], `these files reference data-theme: ${offenders.join(', ')}`)
  })

  it('the control is mounted in the bar and in the dialog a 320px user has', () => {
    const navbar = readFileSync(path.join(PUBLIC, 'shared', 'navbar.js'), 'utf8')
    assert.match(navbar, /mountThemeControl\(end\)/)
    assert.match(navbar, /mountThemeControl\(dialog\)/)
  })

  it('the surface HTML declares a theme-color the module can update', () => {
    // Not a strict requirement — applyChoice no-ops without one — but the
    // assertion exists because eight <head>s declaring the same literal is
    // eight places to update when a theme is added, and the module silently
    // does less when one is missing.
    const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    assert.match(html, /<meta name="theme-color"/)
  })
})