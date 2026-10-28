import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  BUILTIN_FORMS, CHW_SYMPTOM_FORM, FIELD_TYPES, applicableFields, formCatalogue,
  fieldHook, formFor, isRelevant, isVersion, latestForm, mergeForms, readField, renderField, validateAnswers,
  validateFormDefinition,
} from '../src/forms.js'
import { createServer } from '../src/server.js'
import { JsonStore } from '../src/store.js'

describe('versioned form definitions (CAP-01)', () => {
  it('ships a symptom form whose fields are all well formed', () => {
    assert.deepEqual(validateFormDefinition(CHW_SYMPTOM_FORM), [])
    assert.equal(CHW_SYMPTOM_FORM.version, 1)
  })

  it('names the field it is unhappy about, not just that it is unhappy', () => {
    // A form builder that says "invalid" and not which question makes the author
    // hunt through a form they cannot see.
    const problems = validateFormDefinition({
      id: 'x', version: 1, fields: [{ name: 'ok', type: 'text' }, { name: 'bad', type: 'nonsense' }],
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /field 'bad'/)
    assert.match(problems[0], /nonsense/)
  })

  it('refuses two fields with one name, which is one answer with two questions', () => {
    const problems = validateFormDefinition({
      id: 'x', version: 1, fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'number' }],
    })
    assert.match(problems.join('\n'), /declared twice/)
  })

  it('refuses a version that is not a positive integer', () => {
    for (const version of [0, -1, 1.5, '1', null, undefined]) {
      assert.equal(isVersion(version), false, `${JSON.stringify(version)} was accepted as a version`)
      assert.ok(validateFormDefinition({ id: 'x', version, fields: [{ name: 'a', type: 'text' }] })
        .some((p) => /version/.test(p)), `${JSON.stringify(version)} produced no version problem`)
    }
    assert.equal(isVersion(1), true)
    assert.equal(isVersion(2), true)
  })

  it('keeps two versions of one form as two artifacts', () => {
    // The whole point of the row: a question that changed is a different
    // question, so version 2 is an addition and version 1 stays readable —
    // submissions name it, and a submission naming a version nobody can read is
    // a record nobody can interpret.
    const v2 = {
      id: 'chw_symptom_report', version: 2, title: 'Symptom report',
      fields: [...CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', label: 'MUAC (mm)', type: 'integer' }],
    }
    const forms = mergeForms([v2])
    assert.ok(formFor(forms, 'chw_symptom_report', 1), 'version 1 stopped being readable when version 2 was published')
    assert.ok(formFor(forms, 'chw_symptom_report', 2))
    assert.equal(latestForm(forms, 'chw_symptom_report').version, 2)
    // And the old version is unchanged — publishing is not an edit.
    assert.equal(formFor(forms, 'chw_symptom_report', 1).fields.length, CHW_SYMPTOM_FORM.fields.length)
  })

  it('refuses a published definition that does not validate', () => {
    // A malformed definition must not become servable by being published. It is
    // dropped rather than stored broken, and the built-in survives.
    const forms = mergeForms([{ id: 'bad', version: 1, fields: [] }])
    assert.equal(formFor(forms, 'bad', 1), null)
    assert.ok(formFor(forms, 'chw_symptom_report', 1))
  })

  it('treats a definition whose version it cannot read as absent, not as version 1', () => {
    const forms = mergeForms([{ id: 'newform', version: 'one', fields: [{ name: 'a', type: 'text' }] }])
    assert.equal(forms.some((f) => f.id === 'newform'), false)
  })

  it('drops an answer to a question this version does not ask, and says so', () => {
    // Storing it would put a value in the record that no version of the form
    // can interpret, which is how a JSON column becomes unqueryable.
    const { answers, problems } = validateAnswers(CHW_SYMPTOM_FORM, {
      who: 'self', symptom: 'fever', duration_value: 2, duration_unit: 'days', muac_mm: 125,
    })
    assert.equal(answers.muac_mm, undefined, 'an answer to an undeclared field was stored')
    assert.ok(problems.some((p) => /muac_mm is not a field/.test(p)), problems.join('; '))
    assert.equal(answers.symptom, 'fever')
  })

  it('requires a required field and reports its name', () => {
    const { problems } = validateAnswers(CHW_SYMPTOM_FORM, { who: 'self', duration_value: 1, duration_unit: 'days' })
    assert.ok(problems.includes('symptom is required'), problems.join('; '))
  })

  it('refuses an option outside a select\'s own list', () => {
    // A select whose values are not its options is free text wearing a dropdown.
    const { problems, answers } = validateAnswers(CHW_SYMPTOM_FORM, {
      who: 'self', symptom: 'ebola', duration_value: 1, duration_unit: 'days',
    })
    assert.ok(problems.some((p) => /symptom must be one of/.test(p)), problems.join('; '))
    assert.equal(answers.symptom, undefined)
  })

  it('coerces a number that arrived as a string, and refuses one that is not a number', () => {
    // A form post from an HTML input is a string. `Number('')` is 0, so an empty
    // duration must be absence rather than a measured zero — the same class as
    // every other falsy-zero defect in this codebase.
    const ok = validateAnswers(CHW_SYMPTOM_FORM, { who: 'self', symptom: 'fever', duration_value: '3', duration_unit: 'days' })
    assert.equal(ok.answers.duration_value, 3)

    const blank = validateAnswers(CHW_SYMPTOM_FORM, { who: 'self', symptom: 'fever', duration_value: '', duration_unit: 'days' })
    assert.equal(blank.answers.duration_value, undefined, 'an empty duration became a measured zero')
    assert.ok(blank.problems.includes('duration_value is required'))

    const nan = validateAnswers(CHW_SYMPTOM_FORM, { who: 'self', symptom: 'fever', duration_value: 'many', duration_unit: 'days' })
    assert.ok(nan.problems.some((p) => /duration_value is not a valid number/.test(p)))
  })

  it('applies skip logic, so a question that does not apply is not required', () => {
    const shown = applicableFields(CHW_SYMPTOM_FORM, { danger_signs: ['other'] }).map((f) => f.name)
    assert.ok(shown.includes('danger_signs_other'))
    const hidden = applicableFields(CHW_SYMPTOM_FORM, { danger_signs: ['sleepy'] }).map((f) => f.name)
    assert.equal(hidden.includes('danger_signs_other'), false)
  })

  it('treats an unreadable relevance expression as always applicable', () => {
    // A skip rule the evaluator cannot parse must fail open, not closed: a
    // question hidden by a typo is a question nobody can answer and no error
    // says so.
    assert.equal(isRelevant('symptom == fever', { symptom: 'fever' }), true)
    assert.equal(isRelevant('symptom == fever', { symptom: 'cough' }), false)
    assert.equal(isRelevant('symptom != fever', { symptom: 'cough' }), true)
    assert.equal(isRelevant('symptom == other', { symptom: 'other' }), true)
    // A multiselect answer is an array, so `==` is membership. Comparing the
    // array itself would make every rule on a checkbox group false, which is a
    // skip rule that silently hides a question nobody can then answer.
    assert.equal(isRelevant('danger_signs == other', { danger_signs: ['sleepy', 'other'] }), true)
    assert.equal(isRelevant('danger_signs == other', { danger_signs: ['sleepy'] }), false)
    assert.equal(isRelevant('danger_signs != other', { danger_signs: ['sleepy'] }), true)
    assert.equal(isRelevant('this is not a rule', {}), true)
    assert.equal(isRelevant(undefined, {}), true)
    assert.equal(isRelevant('', {}), true)
  })

  it('validates a boolean as a boolean, not as a truthy string', () => {
    // `"false"` is truthy. A yes/no field typed as a boolean would report every
    // respondent as having had contact. The wizard renders these as selects
    // (`yes`/`no`/`unknown`) precisely so the third state exists, but the type
    // is offered and has to behave, so the coercion is asserted directly.
    const definition = { id: 'x', version: 1, fields: [{ name: 'contact', type: 'boolean' }] }
    const { answers, problems } = validateAnswers(definition, { contact: 'false' })
    assert.equal(answers.contact, undefined, 'the string "false" was stored as a boolean')
    assert.ok(problems.some((p) => /contact is not a valid boolean/.test(p)))

    const ok = validateAnswers(definition, { contact: false })
    assert.equal(ok.answers.contact, false, 'a real false must survive as false')
  })

  it('refuses a coordinate pair that is not a pair', () => {
    const { answers, problems } = validateAnswers(CHW_SYMPTOM_FORM, {
      who: 'self', symptom: 'fever', duration_value: 1, duration_unit: 'days',
      location: { latitude: 'north', longitude: 35 },
    })
    assert.equal(answers.location, undefined)
    assert.ok(problems.some((p) => /location is not a valid geopoint/.test(p)))
  })

  it('presents a catalogue naming the newest version and every readable one', () => {
    const forms = mergeForms([{
      id: 'chw_symptom_report', version: 2, title: 'Symptom report',
      fields: [...CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', type: 'integer' }],
    }])
    const [entry] = formCatalogue(forms).filter((c) => c.id === 'chw_symptom_report')
    assert.equal(entry.latest_version, 2)
    assert.deepEqual(entry.versions, [1, 2])
  })

  it('matches the options the CHW wizard actually offers, attribute for attribute', async () => {
    // A definition that does not match the client that fills it is worse than
    // none: it looks authoritative, it validates, and every answer the real
    // client sends is refused as out of vocabulary. So the wizard's own
    // attributes are the source and the definition has to agree with them —
    // adding a sixth symptom button fails here until version 2 is published.
    const html = await fs.readFile(new URL('../public/chw/index.html', import.meta.url), 'utf8')
    const optionsOf = (attribute) => [...new Set(
      [...html.matchAll(new RegExp(`data-${attribute}="([^"]+)"`, 'g'))].map((m) => m[1]),
    )].sort()
    const field = (name) => CHW_SYMPTOM_FORM.fields.find((f) => f.name === name)

    assert.deepEqual([...field('who').options].sort(), optionsOf('symptom-who'))
    assert.deepEqual([...field('symptom').options].sort(), optionsOf('symptom-type'))
    assert.deepEqual([...field('duration_unit').options].sort(), optionsOf('symptom-duration'))
    assert.deepEqual([...field('danger_signs').options].sort(), optionsOf('severity'))
    // The exposure selects are three fixed yes/no/unknown lists in the markup,
    // so the assertion is that the definition agrees with what is rendered.
    for (const name of ['contact_sick', 'contact_dead', 'vaccination']) {
      assert.deepEqual([...field(name).options].sort(), ['no', 'unknown', 'yes'], `${name} does not offer the three the markup renders`)
    }
    assert.deepEqual([...field('water_source').options].sort(), ['clean', 'unclean', 'unprotected'])
  })

  it('agrees with the wizard about which version of the form is in the field', async () => {
    // The wizard renders these questions, so it names the version on every
    // submission and the server validates against exactly that pair. If the
    // client and the server disagree, every report from the field is refused —
    // and the disagreement is invisible until someone files one.
    //
    // ENH-38 changed what "agrees" means. The wizard used to carry its own
    // `const CHW_SYMPTOM_FORM_ID` and `const CHW_SYMPTOM_FORM_VERSION = 1`, kept
    // in step with this file by hand — and the hand-kept pair was the defect: a
    // district could publish version 2 and the wizard would file version 1
    // forever. The wizard now imports the shared definition and resolves the
    // served version at runtime, so the invariant is that its *default* is the
    // shared built-in and that it files `activeForm`, not a constant.
    const src = await fs.readFile(new URL('../public/chw/app.js', import.meta.url), 'utf8')
    assert.match(src, /import \{[^}]*CHW_SYMPTOM_FORM[^}]*\} from '\/shared\/forms\.js'/,
      'the wizard no longer imports the shared definition; the client and server can drift again')
    assert.match(src, /let activeForm = CHW_SYMPTOM_FORM/,
      'the wizard no longer starts from the shared built-in definition')
    assert.match(src, /form_id: activeForm\.id/,
      'the wizard files a form id that is not the definition it rendered')
    assert.match(src, /form_version: activeForm\.version/,
      'the wizard files a version that is not the definition it rendered — the ENH-38 defect')
    assert.ok(!/const CHW_SYMPTOM_FORM_VERSION/.test(src),
      'a hard-coded version is back; it is the defect ENH-38 removed')
  })

  it('keys the answers it sends by the active definition\'s own field names', async () => {
    // ENH-38 changed how the answers object is built. It used to be a hand-typed
    // literal, and the invariant was that every key in it was a declared field —
    // a key the definition does not declare is dropped by the server and reported
    // as a problem, so a typo was a 400 on every report from the field. The
    // wizard now reads its answers from the DOM by the definition's own field
    // list (`readAnswers`), so a key the version does not ask cannot be produced:
    // the property holds by construction rather than by a literal kept in step by
    // hand. What is asserted here is that construction.
    const src = await fs.readFile(new URL('../public/chw/app.js', import.meta.url), 'utf8')
    assert.match(src, /answers: readAnswers\(activeForm\)/,
      'the wizard no longer builds its answers from the active definition')
    assert.match(src, /function readAnswers\(definition\)/,
      'the wizard has no schema-driven answer reader; the hand-typed literal is back')
    // The reader iterates the definition's fields, not a fixed list.
    const reader = src.slice(src.indexOf('function readAnswers('), src.indexOf('async function submitSymptomReport'))
    assert.match(reader, /for \(const field of definition\.fields\)/,
      'the answer reader does not walk the definition\'s fields')
  })

  it('declares every field type it validates, and no type it does not', () => {
    // A type in FIELD_TYPES with no `coerce` branch would validate as a
    // definition and fail every answer, which reads as "the client sent
    // nonsense" rather than "the server cannot read this type".
    for (const type of FIELD_TYPES) {
      const definition = { id: 'x', version: 1, fields: [{ name: 'a', type }] }
      assert.deepEqual(validateFormDefinition(definition), [], `${type} is declared but does not validate as a field`)
    }
    const samples = {
      text: 'x', textarea: 'x', number: 1, integer: 1, date: '2026-10-11',
      datetime: '2026-10-11T00:00:00Z', select: 'x', multiselect: ['x'], boolean: true,
      geopoint: { latitude: 1, longitude: 2 }, image: 'data:image/png;base64,AA',
    }
    for (const type of FIELD_TYPES) {
      const definition = { id: 'x', version: 1, fields: [{ name: 'a', type }] }
      const { problems } = validateAnswers(definition, { a: samples[type] })
      assert.deepEqual(problems, [], `${type} rejected its own sample answer: ${problems.join('; ')}`)
    }
  })
})

describe('the form routes, through the front door', () => {
  async function withServer(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-forms-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      return await fn(base, store)
    } finally {
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('serves the catalogue and one version', async () => {
    await withServer(async (base) => {
      const catalogue = await (await fetch(`${base}/api/v1/forms`)).json()
      const entry = catalogue.data.forms.find((f) => f.id === 'chw_symptom_report')
      assert.ok(entry, 'the built-in symptom form is not in the catalogue')
      assert.equal(entry.latest_version, 1)

      const one = await (await fetch(`${base}/api/v1/forms/chw_symptom_report`)).json()
      assert.equal(one.data.id, 'chw_symptom_report')
      assert.ok(one.data.fields.some((f) => f.name === 'symptom'))
    })
  })

  it('answers a request for a version it does not hold with a 404 naming what it holds', async () => {
    // Not a fallback to the newest. A submission names an exact version, and
    // answering a request for version 3 with version 4's fields is how two
    // versions in the field stop being reconcilable.
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/forms/chw_symptom_report?version=9`)
      assert.equal(res.status, 404)
      const body = await res.json()
      assert.match(body.error, /holds 1/, 'the 404 does not say which versions exist')
    })
  })

  it('publishes a version and serves it on the next request, with no restart', async () => {
    await withServer(async (base) => {
      const definition = {
        id: 'chw_symptom_report', version: 2, title: 'Symptom report',
        fields: [...CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', label: 'MUAC (mm)', type: 'integer' }],
      }
      const res = await fetch(`${base}/api/v1/forms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: definition }),
      })
      const body = await res.json()
      assert.equal(res.status, 201, JSON.stringify(body))

      const two = await (await fetch(`${base}/api/v1/forms/chw_symptom_report?version=2`)).json()
      assert.ok(two.data.fields.some((f) => f.name === 'muac_mm'))
      // And version 1 is still readable — publishing is not an edit.
      const one = await (await fetch(`${base}/api/v1/forms/chw_symptom_report?version=1`)).json()
      assert.equal(one.data.fields.some((f) => f.name === 'muac_mm'), false)
    })
  })

  it('refuses to overwrite a published version, naming the version to publish instead', async () => {
    await withServer(async (base) => {
      const post = (version) => fetch(`${base}/api/v1/forms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          form: {
            id: 'chw_symptom_report', version, title: 'Symptom report',
            fields: [...CHW_SYMPTOM_FORM.fields, { name: 'muac_mm', type: 'integer' }],
          },
        }),
      })
      assert.equal((await post(2)).status, 201)
      const again = await post(2)
      assert.equal(again.status, 409)
      assert.match((await again.json()).error, /publish v3/)
      // The built-in is immutable too: replacing v1 in place would leave every
      // record already stamped with it silently wrong.
      const builtin = await post(1)
      assert.equal(builtin.status, 409)
      assert.match((await builtin.json()).error, /built-in/)
    })
  })

  it('refuses a definition that does not validate, naming the field', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/forms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: { id: 'x', version: 1, fields: [{ name: 'a', type: 'nonsense' }] } }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /field 'a'/)
      // And nothing was stored, so a malformed form cannot become servable.
      const after = await (await fetch(`${base}/api/v1/forms`)).json()
      assert.equal(after.data.forms.some((f) => f.id === 'x'), false)
    })
  })
})

describe('a submission carries the form version it was filled against', () => {
  async function withServer(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-submission-'))
    const store = new JsonStore(path.join(dir, 'store.json'))
    const listener = createServer({ store }).listen(0)
    const base = `http://127.0.0.1:${listener.address().port}`
    try {
      return await fn(base, store)
    } finally {
      await new Promise((resolve) => listener.close(resolve))
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  const post = (base, body) => fetch(`${base}/api/v1/chw/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('records the version, and validates the answers against it', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        kind: 'symptom',
        form_id: 'chw_symptom_report',
        form_version: 1,
        answers: { who: 'self', symptom: 'fever', duration_value: 3, duration_unit: 'days' },
        description: 'child with fever',
      })
      const body = await res.json()
      assert.equal(res.status, 201, JSON.stringify(body))
      assert.equal(body.data.form_id, 'chw_symptom_report')
      assert.equal(body.data.form_version, 1)
      assert.equal(body.data.answers.symptom, 'fever')
      assert.equal(body.data.answers.duration_value, 3)
    })
  })

  it('refuses an answer to a question that version does not ask', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        kind: 'symptom',
        form_id: 'chw_symptom_report',
        form_version: 1,
        answers: { who: 'self', symptom: 'fever', duration_value: 1, duration_unit: 'days', muac_mm: 125 },
        description: 'x',
      })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /muac_mm is not a field/)
    })
  })

  it('refuses a form version this deployment does not serve', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        kind: 'symptom', form_id: 'chw_symptom_report', form_version: 99,
        answers: {}, description: 'x',
      })
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /serves no chw_symptom_report v99/)
    })
  })

  it('still files a report from a client that names no form, and says so', async () => {
    // An older client still files a report. Its record says `null` rather than
    // claiming a version it did not use — which is what makes the pre-CAP-01
    // records identifiable as such.
    await withServer(async (base) => {
      const res = await post(base, { kind: 'symptom', category: 'fever', description: 'legacy client payload' })
      const body = await res.json()
      assert.equal(res.status, 201, JSON.stringify(body))
      assert.equal(body.data.form_id, null)
      assert.equal(body.data.form_version, null)
    })
  })
})


/**
 * A blank is not a zero, in the form module both realms run.
 *
 * `Number('  ')`, `Number([])` and `Number(false)` are all 0, and
 * `Number.isFinite(0)` is true, so `coerce` turned every kind of nothing into a
 * *measured zero*. A worker who typed a space into "days of fever" filed zero
 * days of fever; a geopoint whose latitude was left blank filed the equator. Both
 * read downstream as findings nobody made.
 */
describe('a form answer that states nothing is absence, not zero', () => {
  const definition = {
    id: 'blank_probe', version: 1,
    fields: [
      { name: 'fever_days', type: 'number' },
      { name: 'age_years', type: 'integer' },
      { name: 'location', type: 'geopoint' },
    ],
  }
  const answersFor = (input) => validateAnswers(definition, input)

  for (const blank of ['  ', '\t', '\n']) {
    it(`refuses whitespace-only text where a number was asked for: ${JSON.stringify(blank)}`, () => {
      const { answers, problems } = answersFor({ fever_days: blank })
      assert.deepEqual(answers, {}, `a blank was stored as ${JSON.stringify(answers.fever_days)}`)
      assert.deepEqual(problems, [])
    })
  }

  it('still accepts a stated zero, which is a real answer', () => {
    // The control. A guard that could not tell `0` from `''` would reject a
    // facility that genuinely reported zero days of fever.
    for (const stated of [0, '0', ' 0 ']) {
      const { answers } = answersFor({ fever_days: stated })
      assert.equal(answers.fever_days, 0, `${JSON.stringify(stated)} was not read as a stated zero`)
    }
  })

  it('refuses an array, a boolean or a non-numeric string rather than coercing them', () => {
    for (const value of [[], false, true, [5], 'abc']) {
      const { answers } = answersFor({ fever_days: value })
      assert.equal(answers.fever_days, undefined, `${JSON.stringify(value)} was coerced to a number`)
    }
  })

  it('reports a required question filled with a space as unanswered', () => {
    const required = {
      id: 'blank_probe', version: 1,
      fields: [{ name: 'fever_days', type: 'number', required: true }],
    }
    const { answers, problems } = validateAnswers(required, { fever_days: '  ' })
    assert.deepEqual(answers, {})
    assert.deepEqual(problems, ['fever_days is required'])
  })

  it('refuses a geopoint whose latitude is blank rather than placing it on the equator', () => {
    for (const lat of ['', '  ', null, undefined]) {
      const { answers, problems } = answersFor({ location: { latitude: lat, longitude: 35.6 } })
      assert.equal(answers.location, undefined, `a blank latitude became ${JSON.stringify(answers.location)}`)
      assert.ok(problems.some((p) => /location is not a valid geopoint/.test(p)), problems.join('; '))
    }
  })

  it('still accepts a geopoint whose latitude really is zero', () => {
    const { answers } = answersFor({ location: { latitude: 0, longitude: 35.6 } })
    assert.deepEqual(answers.location, { latitude: 0, longitude: 35.6 })
  })

  it('reads a rendered geopoint the same way, so the widget and the validator agree', () => {
    // `readField` is the mirror of `renderField`. A widget that hands back `0`
    // for a blank half and a validator that refuses `0` would be two rules for
    // one answer; worse, the pre-fix pair agreed on the wrong answer.
    const part = (name, value) => ({ getAttribute: (attr) => (attr === 'data-geopoint-part' ? name : null), value })
    // The hook lookup comes first: `readField` returns `undefined` for a field
    // nothing rendered, so the stub has to hold the hidden holder as well as the
    // two coordinate inputs or it never reaches the branch under test.
    const docFor = (lat, lon) => ({
      querySelectorAll: (selector) => (selector === `[${fieldHook('location')}]`
        ? [{ getAttribute: () => 'location' }]
        : selector === '[data-geopoint-part]' ? [part('latitude', lat), part('longitude', lon)] : []),
    })
    const field = { name: 'location', type: 'geopoint' }

    assert.equal(readField(docFor('', '35.6'), field), undefined, 'a blank latitude was read as a coordinate')
    assert.equal(readField(docFor('  ', '35.6'), field), undefined)
    assert.equal(readField(docFor('3.1', ''), field), undefined)
    assert.equal(readField(docFor('0', '0'), field), undefined, '(0, 0) is absence, not a location')
    assert.deepEqual(readField(docFor('3.1', '35.6'), field), { latitude: 3.1, longitude: 35.6 })
    assert.deepEqual(readField(docFor('0', '35.6'), field), { latitude: 0, longitude: 35.6 })
  })

  it('renders an absent half as blank rather than as the zero a bare Number makes', () => {
    // The renderer is the other half of the pair. Reopening a half-filled report
    // used to show `0` in the latitude box — a latitude the worker never typed,
    // which then read back as a stated zero and was filed.
    const makeElement = (tag) => {
      const el = {
        tag, children: [], attributes: {}, value: '', className: '', dataset: {},
        setAttribute(name, v) { el.attributes[name] = v },
        getAttribute(name) { return el.attributes[name] ?? null },
        appendChild(child) { el.children.push(child); return child },
        classList: { add() {}, remove() {}, contains: () => false },
      }
      return el
    }
    const doc = { createElement: makeElement }
    const partsOf = (container) => container.children.flatMap((wrap) => wrap.children)
      .filter((el) => el.getAttribute && el.getAttribute('data-geopoint-part'))
    const valueFor = (container, name) => partsOf(container)
      .find((el) => el.getAttribute('data-geopoint-part') === name).value

    const field = { name: 'location', type: 'geopoint' }
    const blank = renderField(doc, field, { selected: { latitude: '', longitude: 35.6 } })
    assert.equal(partsOf(blank).length, 2, 'the geopoint did not render two parts')
    assert.equal(valueFor(blank, 'latitude'), '', 'a blank latitude was rendered as a number')
    assert.equal(valueFor(blank, 'longitude'), '35.6')

    const stated = renderField(doc, field, { selected: { latitude: 0, longitude: 35.6 } })
    assert.equal(valueFor(stated, 'latitude'), '0', 'a stated zero latitude was not rendered')
  })
})
