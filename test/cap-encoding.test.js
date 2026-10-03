import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { renderCapXml } from '../src/cap.js'
import { ALERT_EVENT_STATUSES } from '../src/schema.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

const MSG_TYPES = ['Alert', 'Update', 'Cancel', 'Ack', 'Error']
const CAP_SCOPES = ['Public', 'Restricted', 'Private']

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

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return match ? match[1] : null
}

describe('CAP msgType follows the platform status vocabulary', () => {
  // ALERT-01. cap.js keyed the Cancel branch on 'rejected'/'cancelled' — words
  // the platform cannot store, because ALERT_EVENT_STATUSES is open /
  // acknowledged / resolved. Every status the store can hold fell through to
  // `Alert`, including the resolved ones. A resolved alert kept publishing as a
  // live alert to national systems, and the branch that was supposed to retire
  // it was dead code.
  it('renders every status in ALERT_EVENT_STATUSES with a real CAP msgType', () => {
    for (const status of ALERT_EVENT_STATUSES) {
      const xml = renderCapXml(alert({ status }))
      const msgType = tag(xml, 'msgType')
      assert.ok(MSG_TYPES.includes(msgType),
        `status ${status} rendered an invalid msgType: ${msgType}`)
    }
  })

  it('keeps live statuses as Alert and retires a resolved alert with Cancel', () => {
    assert.equal(tag(renderCapXml(alert({ status: 'open' })), 'msgType'), 'Alert')
    assert.equal(tag(renderCapXml(alert({ status: 'acknowledged' })), 'msgType'), 'Alert')
    assert.equal(tag(renderCapXml(alert({ status: 'resolved' })), 'msgType'), 'Cancel')
  })

  it('publishes an alert with no status at all as a live Alert', () => {
    // A record predating the status field is still live: absent is not retired.
    assert.equal(tag(renderCapXml(alert({ status: undefined })), 'msgType'), 'Alert')
    assert.equal(tag(renderCapXml(alert({ status: null })), 'msgType'), 'Alert')
  })

  it('refuses to publish a status outside the vocabulary as a live alert', () => {
    // The failure mode to pin: an unrecognised status must never be silently
    // treated as "not terminal, therefore still live". 'rejected' and
    // 'cancelled' are exactly the words the old code keyed on, so they are the
    // regression this guards.
    for (const bogus of ['rejected', 'cancelled', 'Resolved', 'OPEN', '', 0, false]) {
      assert.throws(() => renderCapXml(alert({ status: bogus })),
        /status/i,
        `status ${JSON.stringify(bogus)} must not render as a live alert`)
    }
  })

  it('does not let a falsy status fall through a truthiness guard', () => {
    // `if (event.status)` would treat '' and 0 as "no status" and publish them.
    assert.throws(() => renderCapXml(alert({ status: '' })))
    assert.throws(() => renderCapXml(alert({ status: 0 })))
  })
})

describe('a resolved alert is rendered as a cancellation, not as the warning again', () => {
  it('says the alert is cancelled in the headline', () => {
    const xml = renderCapXml(alert({ status: 'resolved' }))
    const headline = tag(xml, 'headline')
    assert.match(headline, /cancel/i,
      'a Cancel whose headline reads like the original warning is indistinguishable to a human reader')
    assert.match(headline, /Flood Watch/,
      'the cancelled alert must still name which alert was retired')
  })

  it('states in the description that the alert is no longer in effect', () => {
    const xml = renderCapXml(alert({ status: 'resolved' }))
    assert.match(tag(xml, 'description'), /no longer in effect/i)
  })

  it('leaves a live alert reading as a warning', () => {
    const headline = tag(renderCapXml(alert({ status: 'open' })), 'headline')
    assert.doesNotMatch(headline, /cancel/i)
  })

  it('does not suppress the cancellation message entirely', () => {
    // CAP Cancel exists to retire a prior Alert by identifier. Dropping the
    // message would leave the downstream system holding the original live
    // alert forever, which is the exact harm ALERT-01 describes.
    const xml = renderCapXml(alert({ status: 'resolved' }))
    assert.match(xml, /<identifier>alert_x<\/identifier>/,
      'the cancellation must carry the identifier of the alert it retires')
    assert.equal(tag(xml, 'status'), 'Actual',
      'the cancellation itself is a true statement, so it stays Actual')
  })

  it('reports an undetermined outcome only on a retired alert', () => {
    const resolved = renderCapXml(alert({ status: 'resolved', false_alert: null }))
    assert.match(tag(resolved, 'description'), /Reviewed outcome: not determined/)
    assert.doesNotMatch(tag(renderCapXml(alert({ status: 'open', false_alert: null })), 'description'),
      /Reviewed outcome: not determined/)
  })
})

describe('CAP scope is derived or declared, never an unexamined literal', () => {
  // ALERT-07. `<scope>Public</scope>` was a hardcoded literal at cap.js:42 with
  // a `scopeOverride` option no caller could reach. Public is not decorative in
  // CAP 1.2: it tells a national system the message is for unrestricted
  // dissemination. Restricted and Private mean controlled.
  it('reaches the override when one is supplied', () => {
    for (const scope of CAP_SCOPES) {
      assert.equal(tag(renderCapXml(alert(), { scope }), 'scope'), scope)
    }
  })

  it('defaults to Public and says so in the payload', () => {
    const xml = renderCapXml(alert())
    assert.equal(tag(xml, 'scope'), 'Public')
    assert.match(tag(xml, 'restriction'), /public monitoring data/i,
      'the dissemination basis must be asserted, not implied by a hardcoded literal')
  })

  it('restates a restrictive scope as a restriction too', () => {
    const xml = renderCapXml(alert(), { scope: 'Restricted' })
    assert.equal(tag(xml, 'scope'), 'Restricted')
    assert.match(tag(xml, 'restriction'), /[Rr]estricted/)
  })

  it('refuses a scope outside the CAP vocabulary', () => {
    for (const scope of ['Secret', 'public', '', 0, false]) {
      assert.throws(() => renderCapXml(alert(), { scope }),
        /scope/i,
        `scope ${JSON.stringify(scope)} must not reach a national system`)
    }
  })

  it('reads an absent or null scope as no opinion, not as a value to reject', () => {
    // Absence and corruption are different: null means the caller supplied no
    // scope, exactly like omitting the option. `''` and `0` are values, and a
    // value that is not a CAP scope is a bug worth surfacing rather than
    // silently collapsing to Public.
    assert.equal(tag(renderCapXml(alert(), { scope: null }), 'scope'), 'Public')
    assert.equal(tag(renderCapXml(alert(), {}), 'scope'), 'Public')
  })

  it('does not treat the alert district as a dissemination scope', () => {
    // `alertEvent.scope` is `{ district: 'Bor' }` — a geographic extent. The
    // option and that field share a name and nothing else.
    assert.equal(tag(renderCapXml(alert()), 'scope'), 'Public')
  })

  it('emits restriction after scope and before info, per the CAP 1.2 sequence', () => {
    const xml = renderCapXml(alert())
    const at = (needle) => xml.indexOf(needle)
    assert.ok(at('<scope>') < at('<restriction>'), 'restriction must follow scope')
    assert.ok(at('<restriction>') < at('<info>'), 'info must follow restriction')
  })
})

describe('the CAP route serves the encoded message', () => {
  it('serves a resolved alert as a Cancel over HTTP', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-encoding-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const { port } = listener.address()

    try {
      await store.merge({
        alert_events: [
          alert({ id: 'alert_open' }),
          alert({ id: 'alert_resolved', status: 'resolved' }),
        ],
      })

      const live = await (await fetch(`http://localhost:${port}/api/v1/alert-events/alert_open.cap`)).text()
      assert.equal(tag(live, 'msgType'), 'Alert')

      const retired = await (await fetch(`http://localhost:${port}/api/v1/alert-events/alert_resolved.cap`)).text()
      assert.equal(tag(retired, 'msgType'), 'Cancel',
        'the endpoint must reach the same rendering path and agree with it')
    } finally {
      listener.close()
    }
  })
})
