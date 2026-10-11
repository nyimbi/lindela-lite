/**
 * ENH-38 — the client half of a versioned form definition.
 *
 * A form is a server artifact (`src/forms.js` publishes and serves it), and this
 * module is what turns one into a screen. It lives in `public/shared/` because
 * both realms run it: the browser renders the wizard from a served definition,
 * and the server validates answers with the same field vocabulary and the same
 * skip grammar. `src/forms.js` re-exports it, so a server caller has one import
 * and `check-module-coverage` sees the browser file reached through it.
 *
 * **The defect this closes.** The wizard hard-coded `form_version: 1` and its
 * questions in `public/chw/index.html`. A district could publish version 2 and
 * the wizard would keep filing version 1 forever — the server serves every
 * version immutably, so v2 never breaks v1, and the wizard answers the old
 * question while the record claims a version the district has moved past. The
 * wizard now renders the version the deployment serves and files *that* version.
 *
 * **The renderer speaks the wizard's own hooks, not a new vocabulary.** It emits
 * `data-symptom-who="self"`, `data-symptom-type="fever"` and the rest, because
 * those attributes are the contract `test/forms.test.js` reads the built-in
 * definition's options *out of*. A renderer that invented its own attribute names
 * would leave that test reading a markup nobody fills any more — green over a
 * client that no longer exists.
 */

/** The field types a definition may use. Mirrors `src/forms.js`. */
export const FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'number', 'integer', 'date', 'datetime',
  'select', 'multiselect', 'boolean', 'geopoint', 'image',
])

/** A field name is a slug, so it is a safe key in an answers object. */
const NAME_SHAPE = /^[a-z][a-z0-9_]*$/

/** A version is a positive integer. `1.0` and `v1` are two spellings of one version. */
export function isVersion(value) {
  return Number.isInteger(value) && value >= 1
}

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
 * Coerce one answer to its field's type, or `INVALID`.
 *
 * A sentinel rather than a throw, because the caller collects every problem and
 * reports them together — an author who fixes one field only to be told about
 * the next is being made to guess.
 */
export const INVALID = Symbol('invalid')

export function coerce(field, value) {
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
    case 'image':
      return typeof value === 'string' ? value : INVALID
    default:
      return INVALID
  }
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

/** Validate a definition, returning the problems rather than throwing. */
export function validateFormDefinition(definition) {
  const problems = []
  if (!definition || typeof definition !== 'object') return ['the definition is not an object']
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
      if (!Array.isArray(field.options)) problems.push(`${where} has options that are not an array`)
      else if (!field.options.length) problems.push(`${where} declares an empty option list`)
    }
    if (field.relevant !== undefined && typeof field.relevant !== 'string') {
      problems.push(`${where} has a relevance expression that is not a string`)
    }
  })
  return problems
}

/**
 * The `data-` attribute a field's answers are keyed by, in the wizard's own
 * vocabulary.
 *
 * The wizard shipped with `data-symptom-who`, `data-symptom-type` and so on, and
 * `test/forms.test.js` reads the built-in definition's options out of exactly
 * those attributes. A renderer is free to choose its own hook, but then that
 * test reads a contract nothing fills. Keeping the vocabulary is what makes the
 * built-in definition and the rendered markup the same artifact.
 */
const FIELD_HOOKS = Object.freeze({
  who: 'data-symptom-who',
  symptom: 'data-symptom-type',
  duration_unit: 'data-symptom-duration',
  location: 'data-symptom-location',
})

export function fieldHook(name) {
  return FIELD_HOOKS[name] || `data-field-${name.replace(/_/g, '-')}`
}

/**
 * Render one field into the DOM, returning the element the answer binds to.
 *
 * Deliberately small: this is the field *vocabulary*, not a form builder's
 * canvas. `select` and `multiselect` with a short option list render as button
 * groups and checkboxes — the wizard's shape — and everything else as an input
 * whose `data-field-<name>` hook the app reads on submit. A field type with no
 * renderer is a definition the client cannot show, which is reported rather than
 * silently skipped: a question that vanishes is a question nobody answers.
 */
export function renderField(doc, field, { selected } = {}) {
  const group = doc.createElement('div')
  group.className = 'form-group'
  group.dataset.field = field.name

  if (field.type === 'select' && Array.isArray(field.options) && field.options.length <= 6) {
    const row = doc.createElement('div')
    row.className = 'icon-button-group'
    for (const option of field.options) {
      const button = doc.createElement('button')
      button.className = 'icon-button'
      button.setAttribute(fieldHook(field.name), option)
      button.textContent = option
      if (selected === option) button.classList.add('selected')
      row.appendChild(button)
    }
    group.appendChild(row)
    return group
  }

  if (field.type === 'multiselect') {
    for (const option of field.options || []) {
      const label = doc.createElement('label')
      const input = doc.createElement('input')
      input.type = 'checkbox'
      input.setAttribute(fieldHook(field.name), option)
      if (Array.isArray(selected) && selected.includes(option)) input.checked = true
      label.appendChild(input)
      label.appendChild(doc.createTextNode(option))
      group.appendChild(label)
    }
    return group
  }

  const input = doc.createElement(field.type === 'textarea' ? 'textarea' : 'input')
  if (field.type !== 'textarea') input.type = field.type === 'number' || field.type === 'integer' ? 'number' : 'text'
  input.setAttribute(fieldHook(field.name), field.name)
  if (selected !== undefined && selected !== null) input.value = String(selected)
  group.appendChild(input)
  return group
}

/**
 * Render a whole definition as a sequence of screens, one per field.
 *
 * The screens carry the same `data-step`/`data-step-counter`/`.screen-title`
 * hooks the static wizard used, so `showScreen`, `renderStepProgress` and the
 * step announcer keep working unchanged. Returns `{screens, steps}` where
 * `steps` is the `SYMPTOM_STEPS`-shaped list the progress dots are drawn from.
 */
export function renderForm(doc, definition) {
  const screens = []
  const steps = []
  for (const field of definition.fields) {
    const screen = doc.createElement('div')
    screen.className = 'screen'
    screen.id = `${field.name}Screen`
    const heading = doc.createElement('h2')
    heading.className = 'screen-title'
    heading.textContent = field.label || field.name
    screen.appendChild(heading)
    screen.appendChild(renderField(doc, field))
    screens.push(screen)
    steps.push({ screen: field.name, label: field.label || field.name, field })
  }
  return { screens, steps }
}

/**
 * The form a CHW symptom report is filled against, as a fresh deployment ships
 * it.
 *
 * It lives here, not only on the server, because the field app is offline-first:
 * a health worker with no signal must still open the wizard and file a report,
 * and a wizard that waits for `/api/v1/forms` before it can draw a screen has
 * made the one surface that must work without connectivity need it. The app
 * renders this, then *upgrades* to the version the deployment serves when the
 * fetch succeeds — so a district's published v2 is picked up the moment the
 * phone is online, and the phone is never unable to ask a question.
 *
 * Every option list is the `data-` attribute set in `public/chw/index.html`, not
 * an idealised questionnaire. `test/forms.test.js` reads the wizard's own
 * attributes and asserts they are exactly these options, so adding a sixth
 * symptom button fails the suite until the definition is bumped to version 2.
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
