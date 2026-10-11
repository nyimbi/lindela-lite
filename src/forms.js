/**
 * CAP-01 — a form definition is a versioned artifact, not a hard-coded wizard.
 *
 * The CHW wizard's questions lived in `public/chw/app.js` and its five symptom
 * buttons in `public/chw/index.html`. Three things followed, and each is a
 * defect on its own:
 *
 *   - A district could not change a question without a redeploy. The form was
 *     source code, so the person who owns the question and the person who can
 *     merge to `main` had to be the same person.
 *   - A submission carried no statement of what it was filled against. When a
 *     question changed, the records already collected could not be told apart
 *     from the ones collected under the new wording — the same column held
 *     answers to two different questions and nothing said so.
 *   - The web wizard and any mobile client shared no schema. Each had its own
 *     copy of the question set, and the copies drifted.
 *
 * **A form is `{id, version, fields}` and the version is the identity.** Not
 * `{id, fields}` with a version number beside it: two versions of one form are
 * two different questions, so they are two artifacts. A submission names the
 * exact `(form_id, form_version)` it was filled against, which is what makes a
 * record interpretable a year later and what makes two versions in the field
 * reconcilable rather than merely co-existing.
 *
 * **Versions are immutable.** Publishing an edit to a live form writes version
 * `n+1`; version `n` stays readable forever, because submissions name it and a
 * submission that names a version nobody can read is a record nobody can
 * interpret. Editing a published version in place is the same defect as
 * rewriting an applied migration: the artifact keeps its name and changes its
 * meaning, and everything already stamped with that name is silently wrong.
 */

/** The field types a definition may use. */
export const FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'number', 'integer', 'date', 'datetime',
  'select', 'multiselect', 'boolean', 'geopoint', 'image',
])

/** A field name must be a slug, so it is a safe key in an answers object. */
const NAME_SHAPE = /^[a-z][a-z0-9_]*$/

/** A version is a positive integer. `1.0` and `v1` are two spellings of one version. */
export function isVersion(value) {
  return Number.isInteger(value) && value >= 1
}

/**
 * Validate a definition, returning the problems rather than throwing.
 *
 * A list, not a boolean, and every entry names the field it is about: a form
 * builder that says "invalid" and not which question makes the author hunt
 * through a form they cannot see. The same shape as `loadTaxonomySync`'s
 * `problems`, for the same reason.
 */
export function validateFormDefinition(definition) {
  const problems = []
  if (!definition || typeof definition !== 'object') {
    return ['the definition is not an object']
  }
  if (typeof definition.id !== 'string' || !NAME_SHAPE.test(definition.id)) {
    problems.push(`form id ${JSON.stringify(definition.id)} is not a slug`)
  }
  if (!isVersion(definition.version)) {
    problems.push(`version ${JSON.stringify(definition.version)} is not a positive integer`)
  }
  if (!Array.isArray(definition.fields) || !definition.fields.length) {
    problems.push('the form declares no fields')
    return problems
  }
  const seen = new Set()
  definition.fields.forEach((field, index) => {
    const where = field?.name ? `field '${field.name}'` : `field at index ${index}`
    if (!field || typeof field !== 'object') {
      problems.push(`${where} is not an object`)
      return
    }
    if (typeof field.name !== 'string' || !NAME_SHAPE.test(field.name)) {
      problems.push(`${where} has a name that is not a slug`)
    } else if (seen.has(field.name)) {
      // Two fields with one name is one answer with two questions, and the
      // answers object cannot hold both.
      problems.push(`${where} is declared twice`)
    } else {
      seen.add(field.name)
    }
    if (!FIELD_TYPES.includes(field.type)) {
      problems.push(`${where} has type ${JSON.stringify(field.type)}, which is not one of ${FIELD_TYPES.join(', ')}`)
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      problems.push(`${where} has a non-boolean 'required'`)
    }
    if (field.options !== undefined) {
      if (!Array.isArray(field.options)) {
        problems.push(`${where} has options that are not an array`)
      } else if (!field.options.length) {
        problems.push(`${where} declares an empty option list`)
      }
    }
    if (field.relevant !== undefined && typeof field.relevant !== 'string') {
      problems.push(`${where} has a relevance expression that is not a string`)
    }
  })
  return problems
}

/**
 * The form a CHW symptom report is filled against.
 *
 * Version 1 mirrors the wizard as it shipped — every option list below is the
 * `data-` attribute set in `public/chw/index.html`, not an idealised
 * questionnaire. A definition that does not match the client that fills it is
 * worse than none: it looks authoritative, it validates, and every answer the
 * real client sends is refused as out of vocabulary. `test/forms.test.js` reads
 * the wizard's own attributes and asserts they are exactly these options, so the
 * two cannot drift — adding a sixth symptom button fails the suite until the
 * definition is bumped to version 2.
 *
 * `relevant` is a skip expression. The grammar is deliberately one comparison —
 * a field name, `==` or `!=`, and a literal — because a general expression
 * language is a thing to sandbox, and a form builder's skip logic is not worth
 * an evaluator. A definition that needs more than that needs a new field type,
 * which is a code change and should be.
 */
export const CHW_SYMPTOM_FORM = Object.freeze({
  id: 'chw_symptom_report',
  version: 1,
  title: 'Symptom report',
  fields: Object.freeze([
    Object.freeze({ name: 'who', label: 'Who has this symptom?', type: 'select', required: true, options: ['self', 'child', 'other'] }),
    Object.freeze({ name: 'symptom', label: 'Which symptom?', type: 'select', required: true, options: ['fever', 'cough', 'diarrhea', 'rash', 'other'] }),
    Object.freeze({ name: 'duration_value', label: 'How long?', type: 'number', required: true }),
    Object.freeze({ name: 'duration_unit', label: 'Measured in', type: 'select', required: true, options: ['hours', 'days'] }),
    Object.freeze({ name: 'danger_signs', label: 'Danger signs', type: 'multiselect', options: ['sleepy', 'breathing', 'drinking', 'bleeding', 'weak', 'other'] }),
    Object.freeze({ name: 'danger_signs_other', label: 'Something else serious', type: 'textarea', relevant: 'danger_signs == other' }),
    Object.freeze({ name: 'contact_sick', label: 'Close contact with a sick person with similar symptoms?', type: 'select', options: ['yes', 'no', 'unknown'] }),
    Object.freeze({ name: 'contact_dead', label: 'Close contact with someone who died of a bleeding or fever illness?', type: 'select', options: ['yes', 'no', 'unknown'] }),
    Object.freeze({ name: 'vaccination', label: 'Vaccinated for measles or the relevant disease?', type: 'select', options: ['yes', 'no', 'unknown'] }),
    Object.freeze({ name: 'water_source', label: 'Main drinking water source', type: 'select', options: ['clean', 'unprotected', 'unclean'] }),
    Object.freeze({ name: 'location', label: 'Where is the person?', type: 'geopoint' }),
  ]),
})

/** The forms a fresh deployment serves. */
export const BUILTIN_FORMS = Object.freeze([CHW_SYMPTOM_FORM])

/**
 * The one comparison grammar a `relevant` expression may use.
 *
 * Exported so the client and the server evaluate the same rule rather than two
 * implementations that agree until they do not.
 */
export function isRelevant(expression, answers = {}) {
  if (typeof expression !== 'string' || !expression.trim()) return true
  const match = expression.trim().match(/^([a-z][a-z0-9_]*)\s*(==|!=)\s*([A-Za-z0-9_]+)$/)
  if (!match) return true
  const [, name, operator, literal] = match
  const actual = answers[name]
  const expected = literal === 'true' ? true : literal === 'false' ? false : literal
  // A multiselect answer is an array, so `==` is membership rather than
  // identity: `danger_signs == other` asks whether `other` is among the boxes
  // ticked, and comparing the array itself would make every such rule false.
  // The operator's meaning follows the field's type, which is the only reading
  // that makes the expression mean what a form author wrote it to mean.
  if (Array.isArray(actual)) {
    const holds = actual.includes(expected)
    return operator === '==' ? holds : !holds
  }
  return operator === '==' ? actual === expected : actual !== expected
}

/** The fields that apply, given the answers so far. */
export function applicableFields(definition, answers = {}) {
  return (definition?.fields || []).filter((field) => isRelevant(field.relevant, answers))
}

/**
 * Validate answers against one version of a form.
 *
 * Returns `{answers, problems}`. `answers` is the input narrowed to fields the
 * definition declares: an answer to a question this version does not ask is
 * **dropped and reported**, not stored. Storing it would put a value in the
 * record that no version of the form can interpret, which is how a JSON column
 * becomes unqueryable.
 */
export function validateAnswers(definition, input = {}) {
  const problems = []
  if (!definition) return { answers: {}, problems: ['no form definition to validate against'] }
  const byName = new Map(definition.fields.map((f) => [f.name, f]))
  const answers = {}

  for (const key of Object.keys(input)) {
    if (!byName.has(key)) problems.push(`${key} is not a field of ${definition.id} v${definition.version}`)
  }

  for (const field of applicableFields(definition, input)) {
    const value = input[field.name]
    const absent = value === undefined || value === null || value === ''
    if (absent) {
      if (field.required) problems.push(`${field.name} is required`)
      continue
    }
    const checked = coerce(field, value)
    if (checked === INVALID) {
      problems.push(`${field.name} is not a valid ${field.type}`)
      continue
    }
    if (field.options && !Array.isArray(checked) && !field.options.includes(checked)) {
      // An out-of-vocabulary option is refused rather than stored: a select
      // whose values are not its options is free text wearing a dropdown.
      problems.push(`${field.name} must be one of ${field.options.join(', ')}`)
      continue
    }
    if (field.options && Array.isArray(checked)) {
      const unknown = checked.filter((v) => !field.options.includes(v))
      if (unknown.length) {
        problems.push(`${field.name} carries values not in its options: ${unknown.join(', ')}`)
        continue
      }
    }
    answers[field.name] = checked
  }
  return { answers, problems }
}

const INVALID = Symbol('invalid')

function coerce(field, value) {
  switch (field.type) {
    case 'integer': {
      const n = Number(value)
      return Number.isInteger(n) ? n : INVALID
    }
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : INVALID
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : INVALID
    case 'multiselect':
      return Array.isArray(value) ? value : INVALID
    case 'geopoint': {
      if (typeof value !== 'object' || Array.isArray(value)) return INVALID
      const lat = Number(value.latitude)
      const lon = Number(value.longitude)
      return Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : INVALID
    }
    case 'date':
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : INVALID
    case 'select':
      return typeof value === 'string' || typeof value === 'number' ? String(value) : INVALID
    case 'text':
    case 'textarea':
      return typeof value === 'string' ? value : INVALID
    case 'image':
      return typeof value === 'string' ? value : INVALID
    default:
      return INVALID
  }
}

/**
 * The forms a deployment serves, newest version of each, plus every published
 * version a submission may name.
 *
 * Built-ins are version 1 of their id. A deployment's published versions are
 * merged over them the same way the taxonomy merges its extension: a published
 * `(id, version)` replaces the built-in with that pair, and a higher version is
 * an addition rather than a replacement, because both stay readable.
 */
export function mergeForms(published = []) {
  const byKey = new Map(BUILTIN_FORMS.map((form) => [`${form.id}@${form.version}`, form]))
  for (const form of Array.isArray(published) ? published : []) {
    if (!form || typeof form !== 'object') continue
    if (validateFormDefinition(form).length) continue
    byKey.set(`${form.id}@${form.version}`, Object.freeze({ ...form, deployment: true }))
  }
  return [...byKey.values()].sort((a, b) => (a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id)))
}

/** The exact `(id, version)` a submission names, or null. */
export function formFor(forms, id, version) {
  return forms.find((form) => form.id === id && form.version === version) || null
}

/** The newest version of a form id, which is what a client renders by default. */
export function latestForm(forms, id) {
  const versions = forms.filter((form) => form.id === id)
  return versions.length ? versions[versions.length - 1] : null
}

/**
 * The catalogue as a client would present it: one entry per id, naming the
 * newest version and listing every version still readable.
 */
export function formCatalogue(forms) {
  const byId = new Map()
  for (const form of forms) {
    if (!byId.has(form.id)) byId.set(form.id, { id: form.id, title: form.title, latest_version: form.version, versions: [] })
    const entry = byId.get(form.id)
    entry.latest_version = Math.max(entry.latest_version, form.version)
    entry.versions.push(form.version)
  }
  return [...byId.values()].map((entry) => ({ ...entry, versions: entry.versions.sort((a, b) => a - b) }))
}
