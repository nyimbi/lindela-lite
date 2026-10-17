import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALERT_ORDER, INFO_ORDER, VOCABULARIES, capPermalink, renderCapFeed, validateCapProfile } from '../src/cap-profile.js'
import { renderCapXml } from '../src/cap.js'

/**
 * ENH-36 — the CAP 1.2 profile, and the feed permalink.
 *
 * A validator is a gate, and a gate that has never been watched failing is not
 * evidence. So the load-bearing tests here are the ones that feed it documents
 * *known to be wrong* and assert it says so — an out-of-order element, a missing
 * required element, a value outside the vocabulary, an unclosed polygon, a
 * ceiling without an altitude. If the scanner silently returns no elements for
 * every input, those tests fail and the "valid document" test below would pass
 * for the wrong reason.
 *
 * The valid-document half is checked against the real renderer, so the two
 * cannot drift: a change to `cap.js` that emits an element out of order fails
 * here rather than in a national system's parser.
 */

const alert = (over = {}) => ({
  id: 'alert_x',
  rule_name: 'Flood Watch',
  metric: 'rainfall_mm_7d',
  value: 210,
  threshold: 180,
  operator: '>=',
  message: 'Flood Watch: rainfall_mm_7d >= 180 (actual 210)',
  severity: 'high',
  status: 'open',
  scope: { district: 'Bor' },
  ...over,
})

describe('ENH-36 — the renderer produces a document that passes the profile', () => {
  it('accepts what renderCapXml emits, for every status', () => {
    for (const status of ['open', 'acknowledged', 'resolved']) {
      const verdict = validateCapProfile(renderCapXml(alert({ status })))
      assert.deepEqual(verdict.errors, [], `a ${status} alert failed the profile:\n  ${verdict.errors.join('\n  ')}`)
      assert.equal(verdict.valid, true)
    }
  })

  it('accepts an alert with no district, which emits no circle', () => {
    const verdict = validateCapProfile(renderCapXml(alert({ scope: { district: 'Nowhere' } })))
    assert.deepEqual(verdict.errors, [])
    assert.equal(verdict.summary.area_blocks, 1)
  })

  it('reports the block counts it read, so a pass is backed by a number', () => {
    const verdict = validateCapProfile(renderCapXml(alert()))
    assert.equal(verdict.summary.info_blocks, 1)
    assert.equal(verdict.summary.area_blocks, 1)
    assert.ok(verdict.summary.elements > 15, 'the scanner read implausibly few elements')
  })
})

describe('ENH-36 — the validator refuses what a consumer would refuse', () => {
  const good = () => renderCapXml(alert())

  it('rejects an element in the wrong order', () => {
    // `msgType` before `status` is a document a conforming parser rejects, and
    // it is the shape a renderer drifts into when someone reorders the template.
    //
    // The swap is derived rather than written out: the earlier form was a literal
    // `.replace('<status>Actual</status>\n  <msgType>Alert</msgType>', …)`, which
    // stopped matching the moment `<status>` became approval-dependent — the
    // replace was a no-op, `broken` equalled `good`, and this canary went on
    // passing while planting nothing. Assert the patch landed before trusting
    // the verdict.
    const good = renderCapXml(alert({ approval: { state: 'approved' } }))
    const broken = good.replace(
      /(<status>[^<]+<\/status>)\n(\s*)(<msgType>[^<]+<\/msgType>)/,
      (_m, statusEl, indent, msgTypeEl) => `${msgTypeEl}\n${indent}${statusEl}`
    )
    assert.notEqual(broken, good, 'the wrong-order patch did not apply — this canary is planting nothing')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /appears after/.test(e)), `no ordering error was reported: ${verdict.errors}`)
  })

  it('rejects a missing required element', () => {
    const broken = good().replace('  <sender>lindela-lite@example.org</sender>\n', '')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /missing the required <sender>/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a value outside the vocabulary', () => {
    const broken = good().replace('<severity>Severe</severity>', '<severity>VeryBad</severity>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /<severity> is 'VeryBad'/.test(e)), verdict.errors.join('; '))
  })

  it('rejects an empty enumerated element', () => {
    const broken = good().replace('<urgency>Expected</urgency>', '<urgency></urgency>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /<urgency> is empty/.test(e)), verdict.errors.join('; '))
  })

  it('accepts a deprecated certainty with a warning rather than an error', () => {
    // The spec deprecates `Very Likely` and says to treat it as `Likely`. A
    // consumer reads it, so refusing it would fail a feed that works.
    const deprecated = good().replace('<certainty>Likely</certainty>', '<certainty>Very Likely</certainty>')
    const verdict = validateCapProfile(deprecated)
    assert.equal(verdict.valid, true, verdict.errors.join('; '))
    assert.ok(verdict.warnings.some((w) => /deprecates/.test(w)), 'the deprecation was not reported')
  })

  it('rejects an unknown element', () => {
    const broken = good().replace('<event>', '<hazardType>Flood</hazardType><event>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /not a CAP 1.2 element/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a missing namespace', () => {
    const broken = good().replace(' xmlns="urn:oasis:names:tc:emergency:cap:1.2"', '')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /namespace/.test(e)), verdict.errors.join('; '))
  })

  it('rejects an unclosed element rather than reporting the document clean', () => {
    // The mutation removes a closing tag, so the *next* close tag meets an
    // element that is still open. A scanner that lets a close tag match any
    // element on its stack reports this document well-formed.
    const broken = good().replace('</description>', '')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(
      verdict.errors.some((e) => /missing its closing tag/.test(e)),
      `the unclosed element was not reported: ${verdict.errors.join('; ')}`,
    )
  })

  it('rejects an element left open at the end of the document', () => {
    const broken = good().replace('</alert>', '')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /never closed/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a circle at Null Island as a warning, because it is valid CAP', () => {
    // The renderer's worst historical defect was `<circle>0,0 50</circle>` — a
    // 50 km circle in the Gulf of Guinea for an alert about Bor. It is *valid*
    // CAP, so the profile cannot call it an error; it warns, and `cap.js`'s
    // district resolution is what prevents it.
    const broken = good().replace(/<circle>[^<]*<\/circle>/, '<circle>0,0 50</circle>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, true, 'Null Island is valid CAP and must not be an error')
    assert.ok(verdict.warnings.some((w) => /Null Island/.test(w)), 'the Null Island circle was not flagged')
  })

  it('rejects a circle with an unparseable geometry', () => {
    const broken = good().replace(/<circle>[^<]*<\/circle>/, '<circle>not a circle</circle>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /not 'lat,lon radius'/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a polygon with fewer than four pairs, and an unclosed one', () => {
    const short = good().replace('<circle>', '<polygon>1,2 3,4</polygon><circle>')
    assert.equal(validateCapProfile(short).valid, false)
    const open = good().replace('<circle>', '<polygon>1,2 3,4 5,6 7,8</polygon><circle>')
    const verdict = validateCapProfile(open)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /not closed/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a ceiling without an altitude, per area block', () => {
    const broken = good().replace('<areaDesc>', '<ceiling>100</ceiling><areaDesc>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /<ceiling> without <altitude>/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a repeated single-valued element inside one info block', () => {
    const broken = good().replace('<event>', '<event>Flood</event><event>Flood</event><event>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /allows it once per block/.test(e)), verdict.errors.join('; '))
  })

  it('rejects a <sent> that is not a date-time', () => {
    const broken = good().replace(/<sent>[^<]*<\/sent>/, '<sent>yesterday</sent>')
    const verdict = validateCapProfile(broken)
    assert.equal(verdict.valid, false)
    assert.ok(verdict.errors.some((e) => /not a date-time/.test(e)), verdict.errors.join('; '))
  })

  it('rejects an empty document rather than passing it', () => {
    for (const empty of ['', '   ', null, undefined, 42]) {
      const verdict = validateCapProfile(empty)
      assert.equal(verdict.valid, false, `${JSON.stringify(empty)} passed the profile`)
    }
  })

  it('rejects a document with no alert element', () => {
    assert.equal(validateCapProfile('<feed><title>x</title></feed>').valid, false)
  })
})

describe('ENH-36 — the profile vocabulary matches the standard', () => {
  it('lists every enumerated value CAP 1.2 defines', () => {
    // Transcribed from the specification's data dictionaries. A missing value
    // makes the validator reject a conforming document, which is the failure
    // direction that breaks a working feed.
    assert.deepEqual(VOCABULARIES.status, ['Actual', 'Exercise', 'System', 'Test', 'Draft'])
    assert.deepEqual(VOCABULARIES.msgType, ['Alert', 'Update', 'Cancel', 'Ack', 'Error'])
    assert.deepEqual(VOCABULARIES.scope, ['Public', 'Restricted', 'Private'])
    assert.deepEqual(VOCABULARIES.urgency, ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'])
    assert.deepEqual(VOCABULARIES.severity, ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'])
    assert.deepEqual(VOCABULARIES.certainty, ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'])
    assert.equal(VOCABULARIES.category.length, 12)
  })

  it('orders the elements as the specification orders them', () => {
    assert.deepEqual(ALERT_ORDER.slice(0, 6), ['identifier', 'sender', 'sent', 'status', 'msgType', 'source'])
    assert.deepEqual(INFO_ORDER.slice(0, 7), ['language', 'category', 'event', 'responseType', 'urgency', 'severity', 'certainty'])
  })
})

describe('ENH-36 — the feed permalink is stable and derived from the id alone', () => {
  it('mints the same URL for the same alert every time', () => {
    assert.equal(capPermalink({ id: 'alert_x' }), capPermalink({ id: 'alert_x' }))
    assert.equal(capPermalink({ id: 'alert_x' }), '/api/v1/alert-events/alert_x.cap')
  })

  it('percent-encodes an id that would otherwise name a different route', () => {
    assert.equal(capPermalink({ id: 'a/b' }), '/api/v1/alert-events/a%2Fb.cap')
  })

  it('refuses to mint a permalink for an alert with no id', () => {
    // A permalink minted from a random source is not a permalink.
    assert.throws(() => capPermalink({}), /needs an alert id/)
    assert.throws(() => capPermalink(null), /needs an alert id/)
  })

  it('prefixes a base URL without doubling the slash', () => {
    assert.equal(capPermalink({ id: 'a' }, { baseUrl: 'https://x.example/' }), 'https://x.example/api/v1/alert-events/a.cap')
  })
})

describe('ENH-36 — the Atom feed over the alerts', () => {
  const rows = [
    { id: 'a1', message: 'Flood Watch', updated_at: '2026-10-10T09:00:00.000Z' },
    { id: 'a2', message: 'Heat', updated_at: '2026-10-11T09:00:00.000Z' },
  ]

  it('gives every entry its own permalink', () => {
    const feed = renderCapFeed(rows)
    assert.match(feed, /href="\/api\/v1\/alert-events\/a1\.cap"/)
    assert.match(feed, /href="\/api\/v1\/alert-events\/a2\.cap"/)
  })

  it('dedupes on the alert id, not on anything minted here', () => {
    const feed = renderCapFeed(rows)
    assert.match(feed, /<id>a1<\/id>/)
    assert.match(feed, /<id>a2<\/id>/)
  })

  it('dates the feed from the newest alert', () => {
    assert.match(renderCapFeed(rows), /<updated>2026-10-11T09:00:00\.000Z<\/updated>/)
  })

  it('omits the feed timestamp for an empty feed rather than stamping it now', () => {
    // An empty feed claiming to have just changed makes every poller re-read it
    // forever, and a timestamp on nothing is a fabricated value.
    const feed = renderCapFeed([])
    assert.ok(!/<updated>/.test(feed), 'an empty feed carried an update timestamp')
    assert.match(feed, /<feed /)
  })

  it('skips a record with no id rather than emitting a dangling entry', () => {
    const feed = renderCapFeed([...rows, { message: 'no id' }])
    assert.equal((feed.match(/<entry>/g) || []).length, 2)
  })

  it('escapes an alert message that contains markup', () => {
    const feed = renderCapFeed([{ id: 'a1', message: '<script>x</script> & more' }])
    assert.ok(!/<script>/.test(feed), 'the message was not escaped')
    assert.match(feed, /&lt;script&gt;/)
  })
})
