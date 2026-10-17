import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { renderCapXml } from '../src/cap.js'
import { validateCapProfile } from '../src/cap-profile.js'
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

describe('CAP status is the approval gate', () => {
  // Item 7 of roadmap-extension.md: "SMS is approval-gated; the CAP handler
  // still has no gate". The renderer hardcoded `<status>Actual</status>` for
  // every alert, and CAP 1.2 defines Actual as "actionable by all targeted
  // recipients" against Draft's "not actionable in its current form". So an
  // alert a human had not approved published to a national relay with this
  // platform asserting it was cleared for action — while the SMS path answered
  // the same alert `409 Alert not approved` (src/routes/rapidpro.js:145). Two
  // ways out of the building, one gate.
  it('publishes an unapproved alert as Draft, not Actual', () => {
    assert.equal(tag(renderCapXml(alert({ approval: { state: 'proposed' } })), 'status'), 'Draft')
    assert.equal(tag(renderCapXml(alert({ approval: { state: 'rejected' } })), 'status'), 'Draft')
  })

  it('publishes an approved or auto-approved alert as Actual', () => {
    assert.equal(tag(renderCapXml(alert({ approval: { state: 'approved' } })), 'status'), 'Actual')
    assert.equal(tag(renderCapXml(alert({ approval: { state: 'auto_approved' } })), 'status'), 'Actual')
  })

  it('treats a record with no approval field as Draft', () => {
    // The same default the dispatch gate and `approveAlertEvent` take: absent
    // means proposed. A record predating the field is not silently cleared.
    assert.equal(tag(renderCapXml(alert()), 'status'), 'Draft')
    assert.equal(tag(renderCapXml(alert({ approval: {} })), 'status'), 'Draft')
    assert.equal(tag(renderCapXml(alert({ approval: null })), 'status'), 'Draft')
  })

  it('agrees with the dispatch gate on every state it can hold', () => {
    // The predicate must be the dispatch path's, not a second rule. If the two
    // ever disagree, one of them is wrong and this says which.
    const dispatchAllows = (state) => state === 'approved' || state === 'auto_approved'
    for (const state of ['proposed', 'approved', 'auto_approved', 'rejected']) {
      const capAllows = tag(renderCapXml(alert({ approval: { state } })), 'status') === 'Actual'
      assert.equal(capAllows, dispatchAllows(state),
        `CAP and the dispatch gate disagree on approval state '${state}'`)
    }
  })

  it('a Draft document still passes the CAP 1.2 profile', () => {
    // The gate must not make the document unreadable: Draft is a real CAP 1.2
    // status value, so a conforming consumer parses it and knows not to act.
    const verdict = validateCapProfile(renderCapXml(alert({ approval: { state: 'proposed' } })))
    assert.equal(verdict.valid, true, verdict.errors.join('; '))
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
    //
    // The record here is approved, because `<status>` is now the approval gate:
    // a cancellation is a true statement about an approved alert, so it stays
    // `Actual`. The separate assertion below covers the unapproved case, where
    // `Draft` is the honest value regardless of msgType.
    const xml = renderCapXml(alert({ status: 'resolved', approval: { state: 'approved' } }))
    assert.match(xml, /<identifier>alert_x<\/identifier>/,
      'the cancellation must carry the identifier of the alert it retires')
    assert.equal(tag(xml, 'status'), 'Actual',
      'an approved cancellation is a true statement, so it stays Actual')
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

  it('mints a permalink that points at the document it just served', async () => {
    // ENH-36. The Link header is the discovery step a feed consumer needs, and
    // a header naming a URL that does not resolve is worse than no header: it
    // is a citation the reader trusts.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-link-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const { port } = listener.address()

    try {
      await store.merge({ alert_events: [alert({ id: 'alert_open' })] })
      const response = await fetch(`http://localhost:${port}/api/v1/alert-events/alert_open.cap`)
      const link = response.headers.get('link') || ''
      assert.match(link, /rel="self"/, 'the served document named no self permalink')
      const self = /<([^>]+)>;\s*rel="self"/.exec(link)?.[1]
      assert.ok(self, `no self link was parseable from: ${link}`)

      // Follow it. A permalink that 404s is a permalink in name only.
      const followed = await fetch(new URL(self, `http://localhost:${port}`))
      assert.equal(followed.status, 200, `the permalink ${self} did not resolve`)
      // Not byte-equality: `<sent>` is stamped at render, so two renders of one
      // alert differ by milliseconds. What has to hold is that the permalink
      // names the same alert, which is the identifier.
      assert.equal(tag(await followed.text(), 'identifier'), 'alert_open')
    } finally {
      listener.close()
    }
  })
})

describe('the CAP feed is the set a subscriber polls', () => {
  it('lists the visible alerts, each with a permalink that resolves', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-feed-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const { port } = listener.address()

    try {
      await store.merge({
        alert_events: [
          alert({ id: 'alert_open' }),
          alert({ id: 'alert_gone', deleted_at: '2026-10-01T00:00:00.000Z' }),
        ],
      })

      const response = await fetch(`http://localhost:${port}/api/v1/alert-events/cap-feed`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') || '', /atom\+xml/)
      const feed = await response.text()

      assert.match(feed, /<id>alert_open<\/id>/, 'the live alert is not in the feed')
      assert.ok(!/alert_gone/.test(feed), 'a deleted alert was published in the feed')

      // The handler passes a base URL, so the href is absolute — which is right
      // for a feed a partner polls from elsewhere. Resolve it against the
      // listener rather than assuming either shape.
      const href = /<link rel="alternate"[^>]*href="([^"]+\.cap)"/.exec(feed)?.[1]
      assert.ok(href, `no entry carried a CAP permalink:\n${feed}`)
      const resolved = new URL(href, `http://localhost:${port}`)
      assert.equal(resolved.pathname, '/api/v1/alert-events/alert_open.cap')
      assert.equal((await fetch(resolved)).status, 200,
        `the feed advertised ${href}, which does not resolve`)
    } finally {
      listener.close()
    }
  })

  it('marks an unapproved entry so a poller does not read it as a live warning', async () => {
    // The feed is the other way out of the building, and it is where a poller
    // decides what to act on. The entry carries the state in its title rather
    // than being dropped, because a consumer that dedupes on `<id>` would
    // otherwise keep the last version it saw and never learn the alert was
    // never approved.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-lite-cap-draft-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const server = createServer({ store })
    const listener = server.listen(0)
    const { port } = listener.address()

    try {
      await store.merge({
        alert_events: [
          alert({ id: 'alert_draft', approval: { state: 'proposed' } }),
          alert({ id: 'alert_live', approval: { state: 'approved' } }),
        ],
      })

      const feed = await (await fetch(`http://localhost:${port}/api/v1/alert-events/cap-feed`)).text()
      const titleFor = (id) => {
        const entry = new RegExp(`<id>${id}</id>[\\s\\S]*?</entry>`).exec(feed)?.[0] || ''
        return (/<title>([\s\S]*?)<\/title>/.exec(entry) || [])[1] || ''
      }

      assert.match(titleFor('alert_draft'), /DRAFT/, 'an unapproved alert read as a live warning in the feed')
      assert.doesNotMatch(titleFor('alert_live'), /DRAFT/, 'an approved alert was marked as a draft')
      assert.match(feed, /<id>alert_draft<\/id>/, 'the draft was dropped, so a deduping poller keeps its stale copy')

      // And the document it links to agrees, so the two paths cannot drift.
      const doc = await (await fetch(`http://localhost:${port}/api/v1/alert-events/alert_draft.cap`)).text()
      assert.match(doc, /<status>Draft<\/status>/, 'the linked document does not agree with the feed')
    } finally {
      listener.close()
    }
  })
})
