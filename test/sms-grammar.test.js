import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SUBMIT_REFUSALS,
  SUBMIT_VERB,
  USSD_ANSWERABLE_TYPES,
  USSD_MENU_MAX,
  menuFor,
  parseSmsSubmission,
  startUssdSession,
  ussdAdvance,
} from '../src/sms-grammar.js'
import { REPLY_VERBS, parseReplyVerb } from '../src/rapidpro.js'
import { CHW_SYMPTOM_FORM, validateAnswers } from '../src/forms.js'

/**
 * ENH-43: SMS/USSD submission fallback.
 *
 * The field report path was a web wizard and a Kobo pull, and both need a
 * smartphone or a partner with a laptop. This is the grammar that reaches a
 * feature phone. Most of these tests are refusals, in the spirit of the reply
 * grammar beside it: a parser that guessed a district it could not ground would
 * put a report in the wrong place and say nothing, and a USSD menu that skipped
 * a question on an out-of-range key would file a report missing the answer the
 * question was for.
 */

const T0 = '2026-10-12T08:00:00.000Z'

// A form the deployment might serve, so a version other than the built-in can be
// filed against and the record's named version asserted.
const FORM_V2 = {
  id: CHW_SYMPTOM_FORM.id,
  version: 2,
  title: 'Symptom report',
  fields: CHW_SYMPTOM_FORM.fields,
}

describe('the verb set is extended, not paralleled', () => {
  it('SUBMIT is disjoint from every reply verb', () => {
    assert.equal(REPLY_VERBS.includes(SUBMIT_VERB), false)
  })

  it('a reply verb is not read as a submission', () => {
    for (const verb of REPLY_VERBS) {
      const parsed = parseSmsSubmission(`${verb} no_access`)
      assert.equal(parsed.recognised, false, `${verb} must not be a submission`)
      // And the reply grammar still reads it, unchanged.
      assert.equal(parseReplyVerb(`${verb} no_access`).verb, verb)
    }
  })

  it('a message that is not a submission falls through with no refusal', () => {
    const parsed = parseSmsSubmission('the river is high at Baringo')
    assert.equal(parsed.recognised, false)
    assert.equal(parsed.refusal, null)
    assert.equal(parsed.submission, null)
  })

  it('REPORT is a synonym that records as SUBMIT', () => {
    const parsed = parseSmsSubmission('REPORT Turkana who=child symptom=fever duration=2 days', { observedAt: T0 })
    assert.equal(parsed.recognised, true)
    assert.equal(parsed.verb, SUBMIT_VERB)
    assert.ok(parsed.submission)
  })
})

describe('a grounded submission validates against a real form version', () => {
  it('files a field report shaped like the Kobo intake', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2 days', { from: 'tel:+254700000001', observedAt: T0 })
    assert.equal(parsed.refusal, null)
    const record = parsed.submission
    for (const key of ['id', 'external_id', 'form_id', 'submitted_at', 'district', 'body', 'source', 'reporter_urn_hash']) {
      assert.ok(key in record, `the record must carry ${key}`)
    }
    assert.equal(record.source, 'sms')
    assert.equal(record.district, 'turkana')
    assert.equal(record.reporter_urn_hash, null)
    // The raw submission is the body, as the Kobo connector writes it.
    const body = JSON.parse(record.body)
    assert.deepEqual(body.answers, record.answers)
  })

  it('carries the exact form version it was answered against', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2 days', {
      forms: [FORM_V2], observedAt: T0,
    })
    assert.equal(parsed.submission.form_id, CHW_SYMPTOM_FORM.id)
    assert.equal(parsed.submission.form_version, 2)
  })

  it('refuses a version the deployment does not serve rather than filing the newest', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2 days', {
      forms: [FORM_V2], formId: CHW_SYMPTOM_FORM.id, formVersion: 9, observedAt: T0,
    })
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.no_form)
  })

  it('the answers it accepts are exactly what validateAnswers accepts', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2 days', { observedAt: T0 })
    const { problems } = validateAnswers(CHW_SYMPTOM_FORM, parsed.submission.answers)
    assert.deepEqual(problems, [])
  })
})

describe('the grammar is forgiving of real handsets', () => {
  const cases = [
    'submit turkana who=child symptom=fever duration=2 days',
    'Submit Turkana; who=child; symptom=fever; duration=2 days',
    'SUBMIT Turkana | who=child | symptom=fever | duration=2d',
    '  SUBMIT   Turkana   who = child   symptom = fever   duration = 2 days  ',
    'SUBMIT, Turkana, who=child, symptom=fever, duration=2 days',
  ]
  for (const text of cases) {
    it(`reads: ${JSON.stringify(text)}`, () => {
      const parsed = parseSmsSubmission(text, { observedAt: T0 })
      assert.equal(parsed.refusal, null, parsed.refusal?.message)
      assert.equal(parsed.submission.district, 'turkana')
      assert.equal(parsed.submission.answers.who, 'child')
      assert.equal(parsed.submission.answers.symptom, 'fever')
      assert.equal(parsed.submission.answers.duration_value, 2)
      assert.equal(parsed.submission.answers.duration_unit, 'days')
    })
  }

  it('expands an option abbreviation', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fev duration=2d', { observedAt: T0 })
    assert.equal(parsed.submission.answers.symptom, 'fever')
  })

  it('expands a yes/no shorthand', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2d vacc=y', { observedAt: T0 })
    assert.equal(parsed.submission.answers.vaccination, 'yes')
  })

  it('resolves a district through the registry synonym table', () => {
    const parsed = parseSmsSubmission('SUBMIT moroto who=child symptom=fever duration=2d', { observedAt: T0 })
    assert.equal(parsed.submission.district, 'karamoja')
  })

  it('resolves a unique district prefix', () => {
    const parsed = parseSmsSubmission('SUBMIT turk who=child symptom=fever duration=2d', { observedAt: T0 })
    assert.equal(parsed.submission.district, 'turkana')
  })

  it('resolves a two-word district name', () => {
    const parsed = parseSmsSubmission('SUBMIT South Sudan who=child symptom=fever duration=2d', { observedAt: T0 })
    // South Sudan is a country, not a published district; it has no slug, so the
    // submission is grounded on the country code and files with no district slug.
    assert.equal(parsed.refusal, null)
    assert.equal(parsed.submission.district_code, 'SS')
  })

  it('accepts an explicit district= key', () => {
    const parsed = parseSmsSubmission('SUBMIT district=Mandera who=child symptom=fever duration=2d', { observedAt: T0 })
    assert.equal(parsed.submission.district, 'mandera')
  })

  it('keeps free text after the answers as a note', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2d the road is flooded', { observedAt: T0 })
    assert.equal(parsed.refusal, null)
    assert.match(parsed.submission.note, /road is flooded/)
  })
})

describe('a parse that cannot be grounded refuses, in words a phone can act on', () => {
  it('an empty message is not a submission and carries no refusal', () => {
    for (const text of ['', '   ', '\n\t']) {
      const parsed = parseSmsSubmission(text)
      assert.equal(parsed.recognised, false)
      assert.equal(parsed.refusal, null)
    }
  })

  it('a bare verb refuses with the shape of the grammar', () => {
    const parsed = parseSmsSubmission('SUBMIT')
    assert.equal(parsed.recognised, true)
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.missing_district)
    assert.match(parsed.refusal.message, /district/i)
    assert.equal(parsed.submission, null)
  })

  it('an unknown district names the districts', () => {
    const parsed = parseSmsSubmission('SUBMIT Atlantis who=child symptom=fever duration=2d')
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.unknown_district)
    assert.match(parsed.refusal.message, /Atlantis/)
    assert.match(parsed.refusal.message, /Turkana/)
  })

  it('a district with no answers refuses rather than filing an empty report', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana')
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.missing_answers)
  })

  it('an unknown field is refused, not dropped', () => {
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2d blood_pressure=120')
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.unknown_field)
    assert.match(parsed.refusal.message, /blood_pressure/)
  })

  it('a required answer the message omitted is refused by validation', () => {
    // `who` and `symptom` are given but `duration_value` is not: the form requires
    // it, so the record cannot be filed and the refusal says so.
    const parsed = parseSmsSubmission('SUBMIT Turkana who=child symptom=fever')
    assert.equal(parsed.refusal.code, SUBMIT_REFUSALS.invalid_value)
    assert.match(parsed.refusal.message, /duration_value/)
  })

  it('every refusal message is a sentence, never a bare code', () => {
    const refusals = [
      parseSmsSubmission('SUBMIT'),
      parseSmsSubmission('SUBMIT Atlantis who=child'),
      parseSmsSubmission('SUBMIT Turkana'),
      parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2d bp=1'),
      parseSmsSubmission('SUBMIT Turkana who=child symptom=fever'),
      parseSmsSubmission('SUBMIT Turkana who=child symptom=fever duration=2d', { forms: [FORM_V2], formId: CHW_SYMPTOM_FORM.id, formVersion: 9 }),
    ]
    for (const parsed of refusals) {
      assert.ok(parsed.refusal, 'expected a refusal')
      assert.ok(Object.values(SUBMIT_REFUSALS).includes(parsed.refusal.code), `${parsed.refusal.code} is not a declared code`)
      assert.ok(parsed.refusal.message.length > 20, 'the message must be a sentence a person can act on')
      assert.ok(/[.!?]$/.test(parsed.refusal.message), 'the message must read as a sentence')
    }
  })
})

describe('USSD is a session: a menu in, a keystroke back, the next state out', () => {
  const session = () => startUssdSession({ district: 'Turkana', from: 'tel:+254700000001', observedAt: T0 })

  // Drive the session to the confirmation: answer the four required fields and
  // skip the optional ones. A reporter does the same thing with their thumb.
  const toConfirm = () => {
    let state = session()
    for (const key of ['1', '1', '2', '2', '0', '0', '0', '0', '0']) {
      state = ussdAdvance(state, key).session
    }
    return state
  }

  it('refuses to start against a district it cannot ground', () => {
    const state = startUssdSession({ district: 'Atlantis' })
    assert.equal(state.step, 'refused')
    assert.equal(state.refusal.code, SUBMIT_REFUSALS.unknown_district)
    assert.match(menuFor(state), /Atlantis/)
  })

  it('refuses to start when the shortcode names no district', () => {
    const state = startUssdSession({})
    assert.equal(state.step, 'refused')
    assert.equal(state.refusal.code, SUBMIT_REFUSALS.unknown_district)
  })

  it('starts on the first keypad-answerable field', () => {
    const state = session()
    assert.equal(state.step, 'who')
    assert.equal(state.form_version, CHW_SYMPTOM_FORM.version)
    assert.match(menuFor(state), /1 self/)
  })

  it('advances a field at a time', () => {
    let state = session()
    const steps = []
    for (const key of ['1', '1', '2', '2']) {
      state = ussdAdvance(state, key).session
      steps.push(state.step)
    }
    assert.deepEqual(steps, ['symptom', 'duration_value', 'duration_unit', 'danger_signs'])
    assert.equal(state.answers.who, 'self')
    assert.equal(state.answers.symptom, 'fever')
    assert.equal(state.answers.duration_value, 2)
    assert.equal(state.answers.duration_unit, 'days')
  })

  it('reaches the confirmation once the answers are in', () => {
    assert.equal(toConfirm().step, 'confirm')
  })

  it('does not advance on an out-of-range keystroke', () => {
    const state = session()
    const advanced = ussdAdvance(state, '9')
    assert.equal(advanced.session.step, state.step, 'the step must not move')
    assert.equal(advanced.done, false)
    assert.match(advanced.reply, /Please reply 1 to 3/)
  })

  it('does not advance on a keystroke with no digits for a numeric field', () => {
    let state = session()
    state = ussdAdvance(state, '1').session // who
    state = ussdAdvance(state, '1').session // symptom
    const advanced = ussdAdvance(state, 'x')
    assert.equal(advanced.session.step, 'duration_value')
    assert.equal(advanced.done, false)
  })

  it('skips an optional field on 0', () => {
    let state = session()
    for (const key of ['1', '1', '2', '2']) state = ussdAdvance(state, key).session
    assert.equal(state.step, 'danger_signs')
    const advanced = ussdAdvance(state, '0')
    assert.equal(advanced.session.step, 'contact_sick')
    assert.equal(advanced.session.answers.danger_signs, undefined)
  })

  it('refuses to skip a required field', () => {
    const state = session()
    const advanced = ussdAdvance(state, '0') // `who` is required
    assert.equal(advanced.session.step, 'who')
    assert.equal(advanced.done, false)
    assert.match(advanced.reply, /Please reply 1 to 3/)
  })

  it('sends on 1 and files a report with the version named', () => {
    const advanced = ussdAdvance(toConfirm(), '1')
    assert.equal(advanced.done, true)
    assert.equal(advanced.session.step, 'done')
    assert.equal(advanced.session.submission.source, 'ussd')
    assert.equal(advanced.session.submission.form_version, CHW_SYMPTOM_FORM.version)
    assert.equal(advanced.session.submission.district, 'turkana')
  })

  it('cancels on 2 and files nothing', () => {
    const advanced = ussdAdvance(toConfirm(), '2')
    assert.equal(advanced.session.step, 'cancelled')
    assert.equal(advanced.session.submission, null)
    assert.match(advanced.reply, /Nothing was filed/)
  })

  it('re-prompts on an out-of-range key at the confirmation', () => {
    const advanced = ussdAdvance(toConfirm(), '7')
    assert.equal(advanced.session.step, 'confirm')
    assert.equal(advanced.done, false)
    assert.match(advanced.reply, /Reply 1 to send or 2 to cancel/)
  })

  it('a terminal state absorbs any further keystroke', () => {
    const state = ussdAdvance(toConfirm(), '1').session
    assert.equal(state.step, 'done')
    const after = ussdAdvance(state, '1')
    assert.equal(after.session.step, 'done')
    assert.equal(after.done, true)
    assert.equal(after.session.submission.id, state.submission.id)
  })

  it('is pure: the same state and key yield the same next state', () => {
    const state = session()
    const a = ussdAdvance(state, '1')
    const b = ussdAdvance(state, '1')
    assert.deepEqual(a.session, b.session)
    assert.equal(state.step, 'who', 'the input state must not be mutated')
  })

  it('a multiselect reads several digits and dedupes them', () => {
    let state = session()
    for (const key of ['1', '1', '2', '2']) state = ussdAdvance(state, key).session
    assert.equal(state.step, 'danger_signs')
    const advanced = ussdAdvance(state, '121')
    assert.deepEqual(advanced.session.answers.danger_signs, ['sleepy', 'breathing'])
  })

  it('never emits a menu longer than the carrier budget', () => {
    assert.ok(menuFor(session()).length <= USSD_MENU_MAX)
    assert.ok(menuFor(toConfirm()).length <= USSD_MENU_MAX)
  })

  it('only asks for field types a keypad can answer', () => {
    const state = session()
    // `location` is a geopoint and must never become a step.
    assert.equal(USSD_ANSWERABLE_TYPES.includes('geopoint'), false)
    let walk = state
    const seen = new Set()
    for (let i = 0; i < 12 && walk.step !== 'confirm' && walk.step !== 'done'; i += 1) {
      seen.add(walk.step)
      walk = ussdAdvance(walk, walk.step === 'who' || walk.step === 'symptom' || walk.step === 'duration_value' || walk.step === 'duration_unit' ? '1' : '0').session
    }
    assert.equal(seen.has('location'), false)
  })

  it('records the fields no keystroke can answer as skipped', () => {
    const state = toConfirm()
    assert.ok(state.skipped.includes('location'))
  })
})
