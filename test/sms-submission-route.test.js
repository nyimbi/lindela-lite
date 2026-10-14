import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'
import { parseRapidProReply } from '../src/rapidpro.js'

/**
 * ENH-43 — the SMS door, end to end.
 *
 * `test/sms-grammar.test.js` proves the parser. This proves the *door*: that a
 * message a health worker types reaches `field_reports` as a record the platform
 * can aggregate, that a message it cannot read is refused with a sentence rather
 * than dropped, and that neither path writes a phone number in cleartext.
 *
 * The module existed, was tested, and had no production caller. A grammar with
 * no route is a capability the platform's own README claims and no CHW can
 * reach — which is the shape the register's "built, tested, called by nothing"
 * section exists to raise, and the reason these tests are about the route rather
 * than about the parser.
 */

const TOKENS = JSON.stringify([{ token: 'tok-admin', scopes: ['*'] }])
const WEBHOOK_SECRET = 'rapidpro-test-secret'
const PHONE = '+254700000001'
const URN = `tel:${PHONE}`

let listener, base, store, dir, previousTokens, previousSecret

const post = async (path_, body, token = 'tok-admin') =>
  fetch(`${base}${path_}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidpro-secret': WEBHOOK_SECRET,
      ...(token ? { 'x-api-key': token } : {}),
    },
    body: JSON.stringify(body),
  })

const get = async (path_, token = 'tok-admin') =>
  fetch(`${base}${path_}`, { headers: token ? { 'x-api-key': token } : {} })

before(async () => {
  previousTokens = process.env.LINDELA_LITE_TOKENS
  process.env.LINDELA_LITE_TOKENS = TOKENS
  previousSecret = process.env.RAPIDPRO_WEBHOOK_SECRET
  process.env.RAPIDPRO_WEBHOOK_SECRET = WEBHOOK_SECRET
  delete process.env.RAPIDPRO_API_TOKEN
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lindela-sms-submission-'))
  store = new JsonStore(path.join(dir, 'store.json'))
  await store.write({
    field_reports: [],
    rapidpro_inbound_messages: [],
    action_logs: [],
    form_definitions: [],
    incidents: [],
  })
  listener = createServer({ store }).listen(0)
  base = `http://localhost:${listener.address().port}`
})

after(async () => {
  listener?.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
  if (previousTokens === undefined) delete process.env.LINDELA_LITE_TOKENS
  else process.env.LINDELA_LITE_TOKENS = previousTokens
  if (previousSecret === undefined) delete process.env.RAPIDPRO_WEBHOOK_SECRET
  else process.env.RAPIDPRO_WEBHOOK_SECRET = previousSecret
})

/** A reply webhook body from one sender, carrying a text message. */
const sms = (text, from = URN) => ({ id: `msg-${text.slice(0, 12)}`, from, text, channel: 'sms' })

describe('a submission reaches field_reports', () => {
  it('files a report from the answers in the message', async () => {
    const res = await post('/api/v1/rapidpro/reply', sms('SUBMIT Turkana who=child symptom=fever duration=2 days'))
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.kind, 'submission')
    assert.equal(body.filed, true)
    assert.ok(body.field_report_id, 'a filed submission must name the record it wrote')

    const report = (await store.read({ collections: ['field_reports'] })).field_reports
      .find((r) => r.id === body.field_report_id)
    assert.ok(report, 'the report is not in the collection the response names')
    // The record is a real report, not a stored string: the answers the form
    // declares, under the version the deployment serves (CAP-01).
    assert.equal(report.form_id, 'chw_symptom_report')
    assert.equal(report.form_version, 1)
    assert.equal(report.answers.symptom, 'fever')
    assert.equal(report.answers.who, 'child')
    assert.equal(report.answers.duration_value, 2)
    assert.equal(report.answers.duration_unit, 'days')
    assert.equal(report.source, 'rapidpro_sms')
    assert.equal(report.district, 'turkana')
  })

  it('carries a category every aggregation can group on', async () => {
    const res = await post('/api/v1/rapidpro/reply', sms('SUBMIT Turkana who=self symptom=diarrhea duration=3 days'))
    assert.equal(res.status, 201)
    const { field_report_id } = await res.json()
    const report = (await store.read({ collections: ['field_reports'] })).field_reports
      .find((r) => r.id === field_report_id)
    // Resolved through the taxonomy, not stored as the free text the form
    // collects: `diarrhea` is a known spelling of `diarrhoea`, and a category
    // that is whatever the form said is a categorical field that stopped being
    // one (CAP-05).
    assert.equal(report.category, 'diarrhoea')
  })

  it('stamps the quality verdict it can compute and says what it cannot', async () => {
    const res = await post('/api/v1/rapidpro/reply', sms('SUBMIT Turkana who=child symptom=cough duration=1 days'))
    const { field_report_id } = await res.json()
    const report = (await store.read({ collections: ['field_reports'] })).field_reports
      .find((r) => r.id === field_report_id)
    assert.ok(report.quality, 'a report with no quality verdict is a report nobody can weigh')
    // An SMS carries no fix and no device stamp, so those axes are unmeasured —
    // and `unassessable` is the honest reading of an axis with nothing behind
    // it. A defaulted "good" here would be the falsy-zero conflation the
    // quality module exists to avoid.
    assert.equal(report.latitude, null)
    assert.equal(report.location_source, 'none')
  })
})

describe('a submission that cannot be filed is refused, not dropped', () => {
  it('answers 200 with a sentence for a district the registry does not know', async () => {
    const res = await post('/api/v1/rapidpro/reply', sms('SUBMIT Atlantis who=child symptom=fever duration=2 days'))
    // Not a 4xx: the message arrived, and a health worker reading a 400 on a
    // feature phone will send it again rather than read the reason.
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.filed, false)
    assert.equal(body.field_report_id, null)
    assert.equal(body.refusal.code, 'unknown_district')
    // A sentence, not an internal code — the reader is holding a phone.
    assert.match(body.refusal.message, /district/i)
  })

  it('records the refused message so the gap is visible', async () => {
    const text = 'SUBMIT Atlantis who=self symptom=rash duration=1 days'
    await post('/api/v1/rapidpro/reply', sms(text))
    const inbound = (await store.read({ collections: ['rapidpro_inbound_messages'] })).rapidpro_inbound_messages
    const recorded = inbound.find((m) => m.text === text)
    // An inbound message the platform received is information. Dropping it makes
    // a CHW's failed report indistinguishable from a message that never arrived,
    // which is the same rule the orphan branch applies to a wrong number.
    assert.ok(recorded, 'a refused submission was dropped instead of recorded')
    assert.equal(recorded.submission_refusal.code, 'unknown_district')
    assert.equal(recorded.field_report_id, undefined)
  })

  it('does not write a field report for a refused submission', async () => {
    const before_ = (await store.read({ collections: ['field_reports'] })).field_reports.length
    await post('/api/v1/rapidpro/reply', sms('SUBMIT Nowhere who=self symptom=fever duration=1 days'))
    const after_ = (await store.read({ collections: ['field_reports'] })).field_reports.length
    assert.equal(after_, before_, 'a refusal wrote a report')
  })
})

describe('the SMS door does not store identity in cleartext', () => {
  it('masks the sender on the record it writes', async () => {
    const res = await post('/api/v1/rapidpro/reply', sms('SUBMIT Turkana who=child symptom=fever duration=2 days'))
    const { field_report_id } = await res.json()
    const report = (await store.read({ collections: ['field_reports'] })).field_reports
      .find((r) => r.id === field_report_id)
    // `reported_by` is the sender's number on this path, and it was the field
    // `redactPii` had no case for. The last four digits survive on purpose: they
    // are what let an operator recognise a reporter who has called before.
    assert.equal(report.reported_by, 'xxxx0001')
    assert.ok(!JSON.stringify(report).includes(PHONE), `the number survived in ${JSON.stringify(report)}`)
  })

  it('masks it on the inbound record and inside the echoed payload', async () => {
    const text = 'SUBMIT Turkana who=child symptom=rash duration=1 days'
    await post('/api/v1/rapidpro/reply', { ...sms(text), contact: { name: 'Amina Wanjiru', urn: URN } })
    const inbound = (await store.read({ collections: ['rapidpro_inbound_messages'] })).rapidpro_inbound_messages
    const recorded = inbound.find((m) => m.text === text)
    assert.equal(recorded.from, 'xxxx0001')
    // The nested echo is the field a shallow redactor cannot reach, and it was
    // storing `contact.name` in cleartext on both webhook doors.
    assert.ok(!JSON.stringify(recorded).includes(PHONE), 'the sender survived in the inbound record')
    assert.ok(!JSON.stringify(recorded).includes('Amina'), 'the contact name survived in the echoed payload')
  })

  it('is visible through the read surface an operator uses', async () => {
    const res = await get('/api/v1/rapidpro/inbound')
    assert.equal(res.status, 200)
    const { data } = await res.json()
    assert.ok(!JSON.stringify(data).includes(PHONE), 'the number is readable through the inbound listing')
  })
})

describe('the reply grammar is not disturbed', () => {
  it('still reads a reply verb as a reply', async () => {
    const parsed = parseRapidProReply({ id: 's1', from: URN, text: 'ACK' }, { rapidpro_dispatches: [] })
    assert.equal(parsed.verb, 'ACK')
    assert.equal(parsed.submission, null)
    assert.equal(parsed.submission_refusal, null)
  })

  it('leaves free text a reply, not a refusal', async () => {
    const parsed = parseRapidProReply({ id: 's1', from: URN, text: 'the river is high at Baringo' }, { rapidpro_dispatches: [] })
    // Not a submission and not a refused one: a message the grammar does not
    // claim falls through to the reply path exactly as it did before ENH-43.
    assert.equal(parsed.submission, null)
    assert.equal(parsed.submission_refusal, null)
    assert.equal(parsed.recognised, false)
  })

  it('does not read a SUBMIT sent over USSD as a submission', async () => {
    // A USSD/IVR payload is answered by the digit map; the text is the session
    // input, not a message, and a submission grammar reading it would file a
    // report from a keystroke.
    const parsed = parseRapidProReply({ id: 's1', from: URN, text: 'SUBMIT Turkana who=child', input: { ussd: '1' } }, { rapidpro_dispatches: [] })
    assert.equal(parsed.channel, 'ussd')
    assert.equal(parsed.submission, null)
  })
})
