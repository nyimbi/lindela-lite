#!/usr/bin/env node
/**
 * ENH-46 — the console stops shipping four panels it never shows.
 *
 * `public/index.html` carried the equity, reports, ingestion and settings
 * panels inline: 29.4% of the file raw, 33.5% gzipped, and 58 of the console's
 * 99 boot-time interactive controls. Every one of those 58 sat inside a panel
 * that starts `hidden` and lays out at `opacity: 0`, at coordinates identical
 * to the visible panel's — so 59% of the console's interactive surface was
 * keyboard-reachable and invisible. Tab walked into it and nothing on screen
 * said where focus had gone. An operator on a field connection paid ~4 KB
 * gzipped to download controls they could not see and could not reach.
 *
 * The markup is now in `public/panels/*.html` and fetched on first tab switch.
 * The panel shells stay in `index.html`, which is what makes the deferral safe:
 * `switchTab` still finds `panel-equity`, `aria-controls` still resolves, and
 * the a11y tree still has a tabpanel to land on.
 *
 * That safety is the whole risk, and it is invisible. Deferring markup moves
 * every `$()` lookup that resolved at load to a moment when the element may not
 * exist — and the codebase already used `?.` on all of them, because they were
 * written defensively. So the failure mode is not an exception. It is a
 * listener that never attaches, a captured const that holds `null` forever, and
 * a control that renders correctly and does nothing when clicked. Nothing logs.
 * Nothing throws. A user sees a button that does not work.
 *
 * The real instance found while making this change was the API key field:
 * `const apiKeyInput = $('apiKeyInput')` captured `null` at load, so the field
 * never restored the saved key, its listener never attached, and `authHeaders`
 * — which read the same reference — sent no key on every authenticated request.
 * A whole surface silently failing to authenticate, caused by a performance
 * change, in a commit whose diff was almost all deletion.
 *
 * So this asserts on the *wiring*, not on the byte count. The byte saving is
 * checked too, because it is the thing a future change will trade away, but a
 * panel that is deferred and unwired is worse than one that was never deferred.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** Source with comments stripped; app.js documents the strings it forbids. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const APP = code('public/app.js')
const INDEX = read('public/index.html')

const PANELS = ['equity', 'reports', 'ingestion', 'settings']

describe('ENH-46 — the four panels are deferred', () => {
  it('every panel has a template file on disk', () => {
    for (const p of PANELS) {
      assert.ok(existsSync(path.join(ROOT, 'public', 'panels', `${p}.html`)),
        `public/panels/${p}.html is missing; the tab would fetch a 404 and render nothing`)
    }
  })

  it('index.html keeps the panel shells, so the tab strip still resolves', () => {
    // The shell is what makes this safe rather than merely smaller: without it
    // `aria-controls` on the tab points at nothing and the a11y tree has no
    // tabpanel to move focus into.
    for (const p of PANELS) {
      assert.match(INDEX, new RegExp(`id="panel-${p}"[^>]*class="[^"]*rail-panel`),
        `#panel-${p} must remain in index.html as the tabpanel shell`)
      assert.match(INDEX, new RegExp(`id="panel-${p}"[^>]*role="tabpanel"`),
        `#panel-${p} must keep role="tabpanel"`)
    }
  })

  it('index.html no longer carries the panel contents', () => {
    // A control that exists in both places will eventually be edited in the one
    // that is not loaded, and the edit will appear to work in review.
    for (const id of ['newReportButton', 'runButton', 'triggerEquityAuditButton', 'apiKeyInput']) {
      assert.doesNotMatch(INDEX, new RegExp(`id="${id}"`),
        `#${id} is still inline in index.html; it will be edited in a file that is not loaded`)
    }
  })

  it('the console is materially lighter on first load', () => {
    const controls = (INDEX.match(/<(button|input|select|textarea)\b/g) || []).length
    assert.ok(controls <= 50,
      `index.html still ships ${controls} controls at boot; the deferral targeted ~41`)
  })

  it('the templates are smaller than what they replaced', () => {
    // A guard against the deferral becoming a relocation that grew the payload.
    // The ceiling is a measured ratchet, not a target: 20000 held while the
    // settings panel was the old four-field form, and the protocol-definition
    // UI (parent-plan Phase D, already shipped) legitimately moved the protocol
    // editor into it — measured 2026-10-09, the four templates total ~21023
    // bytes, so the ceiling moves to 21600 and stays a ceiling. The next
    // template that grows has to buy its bytes with a trim.
    const templates = PANELS.reduce((n, p) => n + read(`public/panels/${p}.html`).length, 0)
    assert.ok(templates > 0)
    assert.ok(templates <= 21600, `the four templates total ${templates} bytes`)
  })
})

describe('ENH-46 — a deferred panel that is not wired is worse than a heavy one', () => {
  /** Every id the templates declare. */
  const templateIds = () => {
    const ids = new Map()
    for (const p of PANELS) {
      for (const m of read(`public/panels/${p}.html`).matchAll(/id="([\w-]+)"/g)) {
        ids.set(m[1], p)
      }
    }
    return ids
  }

  it('no listener is still attached at module scope against deferred markup', () => {
    // `$('id')?.addEventListener(...)` at load against an element that does not
    // exist is a silent no-op: `?.` short-circuits and nothing reports it. This
    // was 21 controls.
    const ids = templateIds()
    const offenders = []
    for (const m of APP.matchAll(/^\$?\('([\w-]+)'\)\??\.addEventListener/gm)) {
      if (ids.has(m[1])) offenders.push(m[1])
    }
    for (const m of APP.matchAll(/^\$\('([\w-]+)'\)\?\.addEventListener/gm)) {
      if (ids.has(m[1])) offenders.push(m[1])
    }
    assert.deepEqual([...new Set(offenders)], [],
      'these listeners run before the deferred markup exists, so `?.` drops them ' +
      'and the control renders but does nothing')
  })

  it('no module-scope const captures a deferred element', () => {
    // The API-key instance: `const apiKeyInput = $('apiKeyInput')` held `null`
    // for the life of the page, so `authHeaders` sent no credential on any
    // request. A captured reference cannot be re-read after the element arrives.
    const ids = templateIds()
    const offenders = []
    for (const m of APP.matchAll(/^(?:const|let|var)\s+(\w+)\s*=\s*\$\('([\w-]+)'\)/gm)) {
      if (ids.has(m[2])) offenders.push(`${m[1]} = $('${m[2]}') on line ${APP.slice(0, m.index).split('\n').length}`)
    }
    assert.deepEqual(offenders, [],
      'a module-scope capture of deferred markup is permanently null; look it up at use')
  })

  it('authHeaders reads the API key lazily', () => {
    // The specific regression: the credential is set on the settings tab and
    // used by every other request, so a cached reference is a cached "no key".
    const fn = /function authHeaders[\s\S]*?\n\}/.exec(APP)?.[0]
    assert.ok(fn, 'authHeaders exists')
    // Either the direct lookup or a lazy accessor satisfies this. What it must
    // not be is a property read on a captured const — that is null forever once
    // the panel is deferred.
    assert.match(fn, /\$\('apiKeyInput'\)\??\.value|apiKeyInput\(\)\??\.value/,
      'authHeaders must look the field up per call, not read a captured element')
    assert.doesNotMatch(fn, /[^()\w]apiKeyInput\.value/,
      'authHeaders reads a captured const, which is null once the panel is deferred')
  })

  it('the API key field is restored after the panel mounts', () => {
    assert.match(APP, /function bindApiKeyInput\(/)
    assert.match(APP, /if \(name === 'settings'\)\s*\{\s*bindApiKeyInput\(\)/,
      'bindApiKeyInput must run when the settings panel is mounted, not only at boot')
  })

  it('every deferred panel declares its bindings in one table', () => {
    // Scattered bindings are what made the original failure invisible: 21
    // controls, 21 separate lines, none of which said "this only works if the
    // markup is already here".
    assert.match(APP, /const DEFERRED_PANEL_BINDINGS = \{/)
    const table = /const DEFERRED_PANEL_BINDINGS = \{[\s\S]*?\n\}/.exec(APP)?.[0]
    assert.ok(table)
    for (const p of PANELS) {
      if (p === 'settings') continue                     // bound via bindApiKeyInput + dhis2Settings
      assert.match(table, new RegExp(`\\b${p}: \\[`), `${p} has no entry in DEFERRED_PANEL_BINDINGS`)
    }
  })

  it('every control named in the bindings table exists in that panel template', () => {
    // The binding table and the templates are two files that must agree on ids.
    // Nothing checks that except this, and a rename in one leaves a control
    // that renders and does nothing.
    const table = /const DEFERRED_PANEL_BINDINGS = \{([\s\S]*?)\n\}/.exec(APP)?.[1]
    assert.ok(table)
    const offenders = []
    for (const m of table.matchAll(/\['(\w+)',\s*'(\w+)'/g)) {
      const [, id, event] = m
      const found = PANELS.some((p) => {
        const html = read(`public/panels/${p}.html`)
        return new RegExp(`id="${id}"`).test(html)
      })
      if (!found) offenders.push(`${id} (${event})`)
    }
    assert.deepEqual(offenders, [],
      'these bindings name an id no panel template declares, so they attach to nothing')
  })

  it('mountPanel binds before the panel is unhidden', () => {
    const fn = /async function mountPanel[\s\S]*?\n\}/.exec(APP)?.[0]
    assert.ok(fn, 'mountPanel exists')
    assert.match(fn, /bindDeferredPanel\(name\)/, 'the panel must be wired when it mounts')
    const bindAt = fn.indexOf('bindDeferredPanel(name)')
    const markAt = fn.indexOf('_mountedPanels.set(name, true)')
    assert.ok(bindAt > -1 && (markAt === -1 || bindAt < markAt))
  })

  it('a panel that fails to load says so rather than rendering as empty', () => {
    // Otherwise the deferral reintroduces R-64 on the panel holding the
    // connector configuration: a fetch failure becomes "no data", which is the
    // unearned negative this codebase has been removing one surface at a time.
    const fn = /async function mountPanel[\s\S]*?\n\}/.exec(APP)?.[0]
    assert.match(fn, /catch/, 'mountPanel must handle a failed fetch')
    assert.match(fn, /could not be loaded|not fetched/i,
      'the failure must be stated in words, not left as an empty panel')
    assert.doesNotMatch(fn, /catch[^}]*\{\s*\}\s*$/m,
      'the catch must not be empty')
  })
})

describe('ENH-46 — the tab switch still works after the deferral', () => {
  it('switchTab mounts before it renders', () => {
    // Rendering first would paint an empty panel and return; the fill would
    // never happen because the renderer has already given up.
    const fn = /function switchTab[\s\S]*?\n\}/.exec(APP)?.[0]
    assert.ok(fn, 'switchTab exists')
    const mountAt = fn.indexOf('mountPanel(')
    const renderAt = fn.indexOf('renderIngestionPanel()')
    assert.ok(mountAt > -1, 'switchTab must mount a deferred panel')
    assert.ok(renderAt === -1 || mountAt < renderAt,
      'the deferred render must happen inside the mount continuation, not before it')
    assert.match(fn, /DEFERRED_PANELS\[name\]/,
      'switchTab must branch on whether this tab is deferred')
  })

  it('the alert panel — the default view — is not deferred', () => {
    // The console opens on alerts. Deferring the default view would cost every
    // operator a round trip before they see anything.
    assert.doesNotMatch(APP, /alerts:\s*'\/panels\//,
      'the default tab must not be deferred')
    assert.match(INDEX, /id="alertsList"/,
      'the alerts list stays inline; it is what an operator sees first')
  })

  it('all four deferred panels re-render once mounted', () => {
    const fn = /if \(DEFERRED_PANELS\[name\]\) \{[\s\S]*?\n  \}/.exec(APP)?.[0]
    assert.ok(fn, 'the deferred branch exists')
    for (const r of ['renderReportsPanel', 'renderEquityTab', 'renderIngestionPanel', 'renderSettingsPanel']) {
      assert.match(fn, new RegExp(r), `${r} must run after its panel mounts`)
    }
  })
})