import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REPLY_VERBS,
  USSD_IVR_VERB_KEYS,
  ackInstructions,
  detectReplyChannel,
  parseChannelVerb,
  parseRapidProReply,
  withAckInstructions,
} from '../src/rapidpro.js'

/**
 * SMS/USSD/voice-IVR parity for the reply channel.
 *
 * A responder on a feature phone may answer the same alert through three
 * different carrier surfaces, and the acknowledgement SLA does not care which
 * one carried the answer. Most of these tests are refusals, in the spirit of
 * the SMS grammar: a text message that merely mentions asterisks must never
 * be swallowed by the USSD menu, an unmapped key press is recorded rather
 * than invented, and the SMS path — the one that already works — must not
 * change by a single character.
 */

const T0 = '2026-10-01T08:00:00.000Z'
const alert = { id: 'alert_1', severity: 'high', rule_name: 'River gauge' }

describe('channel detection', () => {
  it('defaults to sms for a plain text reply', () => {
    assert.equal(detectReplyChannel({ text: 'ACK no_access' }), 'sms')
    assert.equal(detectReplyChannel({}), 'sms')
  })

  it('detects ivr from a DTMF or digits field', () => {
    assert.equal(detectReplyChannel({ dtmf: '1' }), 'ivr')
    assert.equal(detectReplyChannel({ digits: '3' }), 'ivr')
    assert.equal(detectReplyChannel({ input: { digits: '2' } }), 'ivr')
  })

  it('detects ivr from a voice-named channel', () => {
    assert.equal(detectReplyChannel({ channel: { name: 'voice' } }), 'ivr')
    assert.equal(detectReplyChannel({ channel: { type: 'ivr' } }), 'ivr')
  })

  it('detects ussd from an input.ussd field or a ussd-named channel', () => {
    assert.equal(detectReplyChannel({ input: { ussd: '*1*2#' } }), 'ussd')
    assert.equal(detectReplyChannel({ channel: { name: 'USSD' } }), 'ussd')
    assert.equal(detectReplyChannel({ channel: { type: 'ussd' } }), 'ussd')
  })

  it('lets sms win ties: asterisks in prose are not a USSD session', () => {
    // "see you *soon*" is an ordinary SMS. Feeding it through the digit menu
    // would strip it to nothing and lose a real message.
    assert.equal(detectReplyChannel({ text: 'see you *soon*' }), 'sms')
    // Even a fully USSD-shaped string is SMS without a channel/ussd hint:
    // shape alone must never override the default.
    assert.equal(detectReplyChannel({ text: '*1#' }), 'sms')
  })
})

describe('channel verb parsing', () => {
  it('takes the last digit of an accumulated USSD session', () => {
    // USSD input accumulates: *1*2# is a session that passed 1 and then 2, so
    // the final digit — 2, ESCALATE per the digit map — is the choice that
    // actually answered the alert.
    const parsed = parseChannelVerb({ input: { ussd: '*1*2#' } })
    assert.equal(parsed.verb, 'ESCALATE')
    assert.equal(parsed.recognised, true)
    assert.equal(parsed.channel, 'ussd')
  })

  it('maps the digits to the same closed verb set', () => {
    assert.equal(parseChannelVerb({ dtmf: '1' }).verb, 'ACK')
    assert.equal(parseChannelVerb({ dtmf: '2' }).verb, 'ESCALATE')
    assert.equal(parseChannelVerb({ dtmf: '3' }).verb, 'RESOLVED')
    assert.equal(parseChannelVerb({ input: { ussd: '4' } }).verb, 'NAK')
  })

  it('records an unmapped digit rather than inventing a verb', () => {
    // Digit 5 was the unmapped example while the map had four entries. It is now
    // the fifth verb (DONE), so the unmapped example moves to 6 — which is the
    // point of the test, not a detail: a digit the platform does not define must
    // be recorded verbatim as raw input rather than resolved to some nearby verb.
    const parsed = parseChannelVerb({ dtmf: '6' })
    assert.equal(parsed.verb, null)
    assert.equal(parsed.recognised, false)
    assert.equal(parsed.reason_code, null)
    assert.equal(parsed.reason_raw, '6')
    assert.equal(parsed.channel, 'ivr')
  })

  it('accepts digit 5 as DONE, since the fifth verb exists', () => {
    // The other half of the test above: digit 5 is now defined, and it must
    // resolve. Without this, moving the unmapped example to 6 would pass even if
    // DONE were unreachable from a keypad.
    const parsed = parseChannelVerb({ dtmf: '5' })
    assert.equal(parsed.verb, 'DONE')
    assert.equal(parsed.recognised, true)
    assert.equal(parsed.channel, 'ivr')
  })

  it('carries the channel on every non-sms path', () => {
    assert.equal(parseChannelVerb({ input: { ussd: '*1#' } }).channel, 'ussd')
    assert.equal(parseChannelVerb({ dtmf: '9' }).channel, 'ivr')
  })

  it('returns null for sms payloads so the caller falls through to the text grammar', () => {
    assert.equal(parseChannelVerb({ text: 'ACK no_access' }), null)
    assert.equal(parseChannelVerb({ text: '*1#' }), null)
  })
})

describe('reply parsing across channels', () => {
  it('parses a USSD session answer and keeps the raw input on the record', () => {
    const parsed = parseRapidProReply({ channel: { name: 'USSD' }, input: { ussd: '*1#' } }, {}, { now: T0 })
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.channel, 'ussd')
    // The raw session input stays on text; the mapped verb is not substituted
    // for what the responder actually sent.
    assert.equal(parsed.text, '*1#')
    assert.equal(parsed.recognised, true)
  })

  it('parses an IVR key press', () => {
    const parsed = parseRapidProReply({ id: 'v1', dtmf: '2' }, {}, { now: T0 })
    assert.equal(parsed.verb, 'ESCALATE')
    assert.equal(parsed.channel, 'ivr')
    assert.equal(parsed.text, '2')
  })

  it('leaves SMS behavior unchanged, with channel reported as sms', () => {
    const parsed = parseRapidProReply({ id: 's1', from: '+254709999999', text: 'ACK no_access' }, {}, { now: T0 })
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.reason_code, 'no_access')
    assert.equal(parsed.channel, 'sms')
    assert.equal(parsed.text, 'ACK no_access')
  })
})

describe('acknowledgement instructions by channel', () => {
  const ESCALATION = ' We escalate if we hear nothing for 30 min.'

  it('keeps the SMS suffix byte-identical', () => {
    // Derived from the pre-change implementation: with a reply_code supplied,
    // no (code …) fragment is generated, so the string is fully deterministic.
    const expected = ` Reply ${REPLY_VERBS.join('/')} <reason>.${ESCALATION}`
    assert.equal(ackInstructions(alert, { reply_code: 'R1' }, {}), expected)
  })

  it('promises the digit menu, not a free-text reason, on ussd', () => {
    const text = ackInstructions(alert, { reply_code: 'R1', channel: 'ussd' }, {})
    assert.ok(text.includes('Press 1=ACK, 2=ESCALATE, 3=RESOLVED, 4=NAK, 5=DONE.'))
    assert.ok(!text.includes('<reason>'), 'a USSD menu cannot answer with a reason code')
    assert.ok(text.includes(ESCALATION), 'the escalation SLA applies on every channel')
  })

  it('promises the digit menu, not a free-text reason, on ivr', () => {
    const text = ackInstructions(alert, { reply_code: 'R1', channel: 'ivr' }, {})
    assert.ok(text.includes('Press 1=ACK, 2=ESCALATE, 3=RESOLVED, 4=NAK, 5=DONE.'))
    assert.ok(!text.includes('<reason>'))
    assert.ok(text.includes(ESCALATION))
  })

  it('prints the menu from the digit map, so the two cannot drift apart', () => {
    // The menu used to be a typed literal and the map a separate object. A menu
    // that advertises four verbs while the parser accepts a fifth is not a menu
    // that trains anyone — it trains people to press a key that does nothing.
    // Building the string from USSD_IVR_VERB_KEYS makes that impossible rather
    // than merely tested.
    const text = ackInstructions(alert, { channel: 'ussd' }, {})
    for (const [key, verb] of Object.entries(USSD_IVR_VERB_KEYS)) {
      assert.ok(text.includes(`${key}=${verb}`), `menu omits digit ${key} (${verb})`)
    }
  })

  it('still fits the 480-character budget with the USSD suffix', () => {
    const long = 'Flooding. '.repeat(200)
    const text = withAckInstructions(long, alert, { channel: 'ussd' }, {})
    assert.ok(text.length <= 480, `got ${text.length}`)
    assert.match(text, /Press 1=ACK, 2=ESCALATE, 3=RESOLVED, 4=NAK, 5=DONE\./)
  })
})

describe('digit map order', () => {
  it('lists the verbs in the same order as REPLY_VERBS', () => {
    // The outbound menu prints digits in REPLY_VERBS order; if the map ever
    // drifts from that order, every deployed menu lies about its keys. Five
    // entries now — the fifth verb is DONE, which is why the keys are asserted
    // against the map rather than typed.
    assert.deepEqual(Object.keys(USSD_IVR_VERB_KEYS), ['1', '2', '3', '4', '5'])
    assert.deepEqual(Object.values(USSD_IVR_VERB_KEYS), [...REPLY_VERBS])
  })
})
