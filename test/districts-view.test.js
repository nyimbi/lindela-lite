import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DISTRICTS_VIEW_VERSION, DISTRICTS_VIEW_DEFAULTS,
  encodeDistrictsView, decodeDistrictsView, resolveDistrictsView,
  districtsShareUrl, isDistrictsViewCustom,
} from '../public/shared/districts-view.js'

describe('districts view state', () => {
  it('writes only the version for an untouched view', () => {
    const params = new URLSearchParams(encodeDistrictsView({ ...DISTRICTS_VIEW_DEFAULTS }))
    assert.equal(params.get('query'), null, 'the default query is not written')
    assert.equal(params.get('attentionOnly'), null, 'the default toggle is not written')
    assert.equal(params.get('v'), DISTRICTS_VIEW_VERSION)
  })

  it('writes a filter that differs from the default', () => {
    const params = new URLSearchParams(encodeDistrictsView({ query: 'baringo', attentionOnly: true }))
    assert.equal(params.get('query'), 'baringo')
    assert.equal(params.get('attentionOnly'), '1')
  })

  it('encodes the same view to the same link every time', () => {
    // A link that varies run to run copies something the sender did not see.
    const view = { query: 'rift  valley', attentionOnly: true, selected: 'baringo' }
    assert.equal(encodeDistrictsView(view), encodeDistrictsView(view))
    assert.equal(districtsShareUrl(view, { origin: 'http://x' }), districtsShareUrl(view, { origin: 'http://x' }))
  })

  it('carries the district in the fragment, once', () => {
    // The surface routes by hash. A `selected` query parameter as well would be
    // two spellings of one value that can disagree.
    const url = districtsShareUrl({ query: 'x', attentionOnly: true, selected: 'baringo' }, { origin: 'http://x' })
    assert.equal(url, 'http://x/districts/?v=v1&query=x&attentionOnly=1#/baringo')
    assert.equal(new URLSearchParams(url.split('?')[1].split('#')[0]).has('selected'), false)
  })

  it('percent-encodes a district slug that needs it', () => {
    const url = districtsShareUrl({ selected: 'nairobi/ west' }, { origin: 'http://x' })
    assert.ok(url.endsWith('#/nairobi%2F%20west'), url)
    assert.equal(resolveDistrictsView({ hash: '#/nairobi%2F%20west' }).selected, 'nairobi/ west')
  })

  it('round-trips a view', () => {
    const view = { query: 'turkana', attentionOnly: true, selected: 'turkana' }
    const back = resolveDistrictsView({
      search: `?${encodeDistrictsView(view)}`,
      hash: `#/${encodeURIComponent(view.selected)}`,
    })
    assert.equal(back.query, 'turkana')
    assert.equal(back.attentionOnly, true)
    assert.equal(back.selected, 'turkana')
  })

  it('restores the defaults from a link that names nothing', () => {
    assert.deepEqual(resolveDistrictsView({ search: '', hash: '' }), { ...DISTRICTS_VIEW_DEFAULTS })
  })

  it('honours a district card href, which is the link that already worked', () => {
    // Cards link with `/districts#/baringo` and no query. Opening one must land
    // on that district, or the extension would have broken the only link the
    // surface produced.
    assert.equal(resolveDistrictsView({ search: '', hash: '#/baringo' }).selected, 'baringo')
  })

  it('lets the hash outrank a stale selected parameter', () => {
    const search = `?v=${DISTRICTS_VIEW_VERSION}&selected=bor`
    assert.equal(resolveDistrictsView({ search, hash: '#/turkana' }).selected, 'turkana')
  })

  it('reads attentionOnly=0 as off, not on', () => {
    // The one filter a link can get wrong silently. `0` is the encoding of
    // false, not a truthy string.
    assert.equal(decodeDistrictsView('?attentionOnly=0').attentionOnly, undefined)
    assert.equal(decodeDistrictsView('?attentionOnly=1').attentionOnly, true)
    assert.equal(decodeDistrictsView('?attentionOnly=true').attentionOnly, undefined)
  })

  it('reads an empty query as absent, not as a filter that matches everything', () => {
    assert.equal(decodeDistrictsView('?query=').query, undefined)
  })

  it('reports a link from another version instead of guessing at it', () => {
    const back = decodeDistrictsView('?v=v9&query=baringo&attentionOnly=1')
    assert.equal(back.query, 'baringo', 'the known fields still decode')
    assert.equal(back._fromVersion, 'v9')
  })

  it('drops fields it does not know rather than interpreting them', () => {
    const back = decodeDistrictsView('?v=v1&query=x&layer=risk&map=1,2,3')
    assert.deepEqual(back, { query: 'x' })
  })

  it('offers to share only a view that differs from the default', () => {
    assert.equal(isDistrictsViewCustom({ ...DISTRICTS_VIEW_DEFAULTS }), false)
    assert.equal(isDistrictsViewCustom({ query: '', attentionOnly: false, selected: '' }), false)
    assert.equal(isDistrictsViewCustom({ query: 'x' }), true)
    assert.equal(isDistrictsViewCustom({ attentionOnly: true }), true)
    assert.equal(isDistrictsViewCustom({ selected: 'baringo' }), true)
  })
})