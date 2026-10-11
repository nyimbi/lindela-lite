/**
 * ENH-71 — intent-driven progressive disclosure.
 *
 * What is asserted is the returned sets and the reasons on them, never the text
 * of the module: a guard that greps for a string passes while the defect sits
 * elsewhere in the file, which is the failure this suite's baseline rule exists
 * to stop. The one file read as text is `public/index.html`, and only to
 * enumerate the controls it declares — the integration contract this model is
 * derived from, and the thing that must not drift from the registry.
 *
 * The load-bearing test is `reachability`. A disclosure model whose failure mode
 * is "the control is unreachable for everyone" is a bug wearing the feature's
 * clothes, so the property is checked over the whole (role × intent) matrix
 * rather than argued for in a comment.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { importFrontEnd } from './browser-env.mjs'

const {
  CONTROLS, GROUPS, ROLES, INTENTS, ROLE_KEYS, INTENT_KEYS,
  decideSurface, reachability,
} = await importFrontEnd('shared/intent.js')

/**
 * The interactive controls `public/index.html` actually declares, by id.
 *
 * The same element kinds HX-05 counted — `button`, `select`, `input`, `a[href]`
 * — plus `details`, whose `<summary>` is the toggle for the legend, the coverage
 * panel and the open-instances list. Hidden inputs and id-less anchors are not
 * controls. Comments are stripped first so an id quoted in one is not read as a
 * control.
 */
function controlsDeclaredInMarkup() {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
  const ids = new Set()
  for (const [, tag, attrs] of html.matchAll(/<(button|select|input|textarea|details|a)\b([^>]*)>/gi)) {
    if (tag.toLowerCase() === 'input' && /type\s*=\s*"hidden"/i.test(attrs)) continue
    if (tag.toLowerCase() === 'a' && !/\bhref\b/.test(attrs)) continue
    const id = attrs.match(/\bid="([^"]+)"/)
    if (id) ids.add(id[1])
  }
  return ids
}

describe('intent-driven progressive disclosure (ENH-71)', () => {
  it('is derived from the console controls, not an invented set', () => {
    // Both directions, because each is a different bug. A control in the markup
    // and not in the registry is one this model can never show — a capability it
    // silently cannot reach. A control in the registry and not in the markup is
    // one it claims to manage and does not have.
    const declared = controlsDeclaredInMarkup()
    const registry = new Set(Object.keys(CONTROLS))
    const missing = [...declared].filter((id) => !registry.has(id))
    const invented = [...registry].filter((id) => !declared.has(id))
    assert.deepEqual(missing, [], `controls in index.html the registry cannot show: ${missing.join(', ')}`)
    assert.deepEqual(invented, [], `registry names controls index.html does not declare: ${invented.join(', ')}`)
  })

  it('declares every control fully and every intent against real controls', () => {
    const groups = new Set(GROUPS)
    for (const [id, rule] of Object.entries(CONTROLS)) {
      assert.ok(groups.has(rule.group), `${id} is in group "${rule.group}", which is not declared`)
      assert.equal(typeof rule.onlyRoute, 'boolean', `${id} does not say whether it is the only route`)
      assert.ok(rule.hiddenBecause, `${id} does not say what is lost when it is hidden`)
    }
    for (const [key, intent] of Object.entries(INTENTS)) {
      for (const g of intent.show) assert.ok(groups.has(g), `intent ${key} shows unknown group ${g}`)
      for (const id of [...intent.also, ...intent.except]) {
        assert.ok(CONTROLS[id], `intent ${key} names control ${id}, which is not declared`)
      }
      assert.ok(intent.why, `intent ${key} does not say why those controls`)
    }
    for (const [role, rule] of Object.entries(ROLES)) {
      assert.ok(INTENT_KEYS.includes(rule.defaultIntent), `role ${role} defaults to an undeclared intent`)
      for (const id of rule.extras) assert.ok(CONTROLS[id], `role ${role} names extra control ${id}, which is not declared`)
    }
  })

  it('shows a non-empty set for every declared (role, intent) pair', () => {
    for (const role of ROLE_KEYS) {
      for (const intent of INTENT_KEYS) {
        const { shown, mode } = decideSurface(role, intent)
        assert.equal(mode, 'intent', `${role}/${intent} did not resolve`)
        assert.ok(shown.length > 0, `${role}/${intent} shows nothing`)
      }
    }
  })

  it('partitions the controls: shown and hidden are disjoint and exhaustive', () => {
    for (const role of ROLE_KEYS) {
      for (const intent of INTENT_KEYS) {
        const { shown, hidden } = decideSurface(role, intent)
        const hiddenIds = hidden.map((h) => h.control)
        const union = new Set([...shown, ...hiddenIds])
        assert.equal(union.size, Object.keys(CONTROLS).length, `${role}/${intent} does not cover every control`)
        for (const id of shown) assert.ok(!hiddenIds.includes(id), `${id} is both shown and hidden for ${role}/${intent}`)
      }
    }
  })

  it('hides nothing from every role: the reachability property', () => {
    // The property the whole module stands on. `manage` is the total intent and
    // is not role-gated, so it holds by construction — but a construction is a
    // claim, and this is the check. A non-empty result names the control and the
    // audience it was stranded from.
    const report = reachability()
    assert.deepEqual(report.unreachable, [], 'some control is reachable by no intent for some role')
    // Singled out because an only-route control stranded for a role is a whole
    // capability lost, not a preference: the map's list view, the tabs, the
    // palette search.
    assert.deepEqual(report.onlyRouteUnreachable, [], 'an only-route control is stranded for some role')
    assert.equal(report.controls, Object.keys(CONTROLS).length)
  })

  it('every control in the markup appears in at least one shown set', () => {
    // The reachability property stated over the real markup rather than the
    // registry, so it cannot be satisfied by a registry that has quietly drifted
    // from the console.
    const shownAnywhere = new Set()
    for (const role of ROLE_KEYS) {
      for (const intent of INTENT_KEYS) {
        for (const id of decideSurface(role, intent).shown) shownAnywhere.add(id)
      }
    }
    const stranded = [...controlsDeclaredInMarkup()].filter((id) => !shownAnywhere.has(id))
    assert.deepEqual(stranded, [], `controls no intent ever shows: ${stranded.join(', ')}`)
  })

  it('shows everything, and says why, for an unknown role', () => {
    const decision = decideSurface('region-coordinator', 'triage')
    assert.equal(decision.mode, 'fallback')
    assert.equal(decision.known.role, false)
    assert.equal(decision.shown.length, Object.keys(CONTROLS).length)
    assert.deepEqual(decision.hidden, [])
    assert.match(decision.header, /Unrecognised role/)
    assert.match(decision.header, /showing every control/)
  })

  it('shows everything, and says why, for an unknown intent', () => {
    const decision = decideSurface('operator', 'reconcile-supply')
    assert.equal(decision.mode, 'fallback')
    assert.equal(decision.known.intent, false)
    assert.equal(decision.shown.length, Object.keys(CONTROLS).length)
    assert.deepEqual(decision.hidden, [])
    assert.match(decision.header, /Unrecognised intent/)
    assert.match(decision.header, /showing every control/)
  })

  it('gives every hidden control a reason, and the only-route ones a way back', () => {
    const { hidden } = decideSurface('operator', 'triage')
    assert.ok(hidden.length > 0, 'triage hid nothing, so this asserts nothing')
    for (const entry of hidden) {
      assert.ok(entry.reason, `${entry.control} is hidden with no reason`)
      assert.match(entry.reason, /Hidden for/)
      if (entry.onlyRoute) {
        // A hidden only-route control with no route back is the dead end the
        // reason exists to prevent.
        assert.match(entry.reason, /only route/)
        assert.match(entry.reason, /Show everything/)
      }
    }
    // And the total intent shows one of them, so the way back is real.
    assert.ok(decideSurface('operator', 'manage').shown.includes('tab-settings'))
  })

  it('composes with the rail view rather than replacing it', () => {
    // The console's view state is `{ tab }`; the intent model names tabs as
    // controls. The two must agree about the rail's tabs, or a disclosed tab is
    // one the view cannot select. Every tab id the view can hold is a control.
    for (const tab of ['alerts', 'reports', 'equity', 'ingestion', 'settings']) {
      assert.ok(CONTROLS[`tab-${tab}`], `the view can select the ${tab} tab, which is not a control`)
    }
  })
})
