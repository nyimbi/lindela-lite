import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ROLE_DEFAULTS, VIEW_STATE_VERSION,
  encodeView, decodeView, resolveView, shareUrl, isCustom,
} from '../public/shared/view-state.js'

describe('view state', () => {
  it('writes nothing that matches the role default', () => {
    const q = encodeView({ tab: 'alerts', window: '7d', layer: 'risk' }, { role: 'operator' })
    const params = new URLSearchParams(q)
    assert.equal(params.get('tab'), null, 'the default tab is not written')
    assert.equal(params.get('window'), null)
    assert.equal(params.get('v'), VIEW_STATE_VERSION)
  })

  it('writes a field that differs from the default', () => {
    const q = encodeView({ tab: 'alerts', window: '30d', severity: 'high' }, { role: 'operator' })
    const params = new URLSearchParams(q)
    assert.equal(params.get('window'), '30d')
    assert.equal(params.get('severity'), 'high')
  })

  it('encodes the same view to the same link every time', () => {
    // A share link that differs run to run copies something the sender did not
    // see. Map transforms are floats, so this is where it actually bites.
    const view = { tab: 'alerts', map: { x: 0.1 + 0.2, y: -12.34567, scale: 1.00004 } }
    assert.equal(encodeView(view), encodeView(view))
    assert.match(new URLSearchParams(encodeView(view)).get('map'), /^0\.3,-12\.346,1$/)
  })

  it('omits an identity map transform and keeps a panned one', () => {
    assert.equal(new URLSearchParams(encodeView({ map: { x: 0, y: 0, scale: 1 } })).get('map'), null)
    assert.ok(new URLSearchParams(encodeView({ map: { x: 40, y: 0, scale: 2 } })).get('map'))
  })

  it('round-trips a view', () => {
    const view = { tab: 'equity', severity: 'critical', selected: 'alert_event_9dea', map: { x: 12, y: -4, scale: 2.5 } }
    const back = decodeView(encodeView(view, { role: 'operator' }))
    assert.equal(back.tab, 'equity')
    assert.equal(back.severity, 'critical')
    assert.equal(back.selected, 'alert_event_9dea')
    assert.deepEqual(back.map, { x: 12, y: -4, scale: 2.5 })
  })

  it('recovers a full view from a link and the receiver\'s role', () => {
    // A field equal to the role default is deliberately not written, so a bare
    // decode cannot restore it. What the receiver actually gets is the link
    // layered over their own role defaults — and it must equal the sender's.
    const sent = { tab: 'kpi', window: '30d', severity: 'high' }
    const link = encodeView(sent, { role: 'co' })
    assert.equal(new URLSearchParams(link).get('window'), null, 'the default is not written')
    assert.deepEqual(resolveView({ search: link, role: 'co' }), { ...ROLE_DEFAULTS.co, tab: 'kpi', severity: 'high' })
  })

  it('distinguishes an absent value from an empty one', () => {
    // `?severity=` is not the same claim as no severity at all.
    assert.equal(decodeView('severity=').severity, undefined)
    assert.equal(decodeView('severity=high').severity, 'high')
  })

  it('drops fields it does not know rather than guessing', () => {
    const back = decodeView(`v=${VIEW_STATE_VERSION}&tab=alerts&invented=1&alsoFake`)
    assert.equal(back.tab, 'alerts')
    assert.equal(back.invented, undefined)
    assert.equal(back.alsoFake, undefined)
  })

  it('still decodes the known fields from a newer link', () => {
    // A link from a future build should open the part this build understands,
    // not render blank or misinterpret a changed field's meaning.
    const back = decodeView('v=v9&tab=equity&severity=high&futureThing=x')
    assert.equal(back.tab, 'equity')
    assert.equal(back.severity, 'high')
    assert.equal(back.futureThing, undefined)
    assert.equal(back._fromVersion, 'v9')
  })

  it('applies the role default and lets a link narrow it', () => {
    const resolved = resolveView({ search: '?window=30d', role: 'analyst' })
    assert.equal(resolved.tab, 'equity', 'the role default survives')
    assert.equal(resolved.window, '30d', 'the link overrides it')
  })

  it('gives every role a default', () => {
    for (const role of Object.keys(ROLE_DEFAULTS)) {
      const resolved = resolveView({ role })
      assert.ok(resolved.tab, `${role} has a default tab`)
      assert.ok(resolved.window, `${role} has a default window`)
    }
  })

  it('falls back to the operator default for an unknown role', () => {
    assert.deepEqual(
      resolveView({ role: 'nobody' }),
      resolveView({ role: 'operator' }),
    )
  })

  it('survives a search string with no leading ?', () => {
    assert.equal(decodeView('tab=alerts').tab, 'alerts')
    assert.equal(decodeView('?tab=alerts').tab, 'alerts')
    assert.deepEqual(decodeView(''), {})
  })

  it('builds a shareable URL', () => {
    const url = shareUrl({ window: '30d' }, { role: 'operator', origin: 'https://x.test', pathname: '/cop' })
    assert.match(url, /^https:\/\/x\.test\/cop\?v=/)
    assert.match(url, /window=30d/)
  })

  it('knows when a view is worth sharing', () => {
    assert.equal(isCustom({ tab: 'alerts', window: '7d' }, { role: 'operator' }), false)
    assert.equal(isCustom({ tab: 'equity' }, { role: 'operator' }), true)
  })

  it('notices a filter that has no role default', () => {
    // severity, source and selected are not in any role's defaults. Comparing
    // only the defaults' keys skipped every one of them, so a filtered console
    // never offered to share the filter.
    assert.equal(isCustom({ severity: 'high' }, { role: 'operator' }), true)
    assert.equal(isCustom({ severity: '' }, { role: 'operator' }), false)
    assert.equal(isCustom({ selected: 'alert_1' }, { role: 'operator' }), true)
  })

  it('notices a panned map but not an untouched one', () => {
    assert.equal(isCustom({ map: { x: 0, y: 0, scale: 1 } }, { role: 'operator' }), false)
    assert.equal(isCustom({ map: { x: 40, y: 0, scale: 1 } }, { role: 'operator' }), true)
  })
})