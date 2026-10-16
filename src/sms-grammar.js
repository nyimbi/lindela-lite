/**
 * ENH-43 — SMS and USSD submission fallback, for the last mile the platform claims.
 *
 * The RapidPro layer already carries a two-way *reply* grammar (ENH-26:
 * `src/rapidpro.js`, `REPLY_VERBS` = ACK/ESCALATE/RESOLVED/NAK/DONE). A CHW on a
 * feature phone can answer an alert; they cannot file a report. The field report
 * path is a web wizard and a Kobo pull, and both need a smartphone or a partner
 * with a laptop — the two things the population this platform serves is least
 * likely to have. So the verb set gains exactly one verb, `SUBMIT`, and nothing
 * else about the reply grammar moves: `SUBMIT` is disjoint from every reply verb,
 * a message that is not a submission falls through to `parseReplyVerb` unchanged,
 * and the reply path that already works is not touched by a character.
 *
 * **The grammar is a subset of a real form, and it names the version.** A
 * submission is validated with the same `validateAnswers` the wizard's HTTP path
 * uses (`src/forms.js`), against the exact `(form_id, form_version)` the
 * deployment serves — never against a hard-coded question set. So a record filed
 * over SMS is interpretable a year later for the same reason a wizard record is:
 * it names the version it was answered against (CAP-01), and that version is
 * immutable. A question the form does not ask cannot be answered, and an answer
 * the form does not declare is refused rather than dropped.
 *
 * **Forgiving of real handsets, and it refuses rather than guesses.** A health
 * worker types on a cracked keypad: the verb may be `submit` or `report`, the
 * separator a space, a comma, a semicolon or a newline, `fev` means `fever`,
 * `2d` means `duration_value=2 duration_unit=days`, and `moroto` means Karamoja
 * because the registry's synonym table says so (`orgUnitFor`, CAP-03). What it
 * will not do is invent a district it cannot ground or a field it cannot read. An
 * ungrounded parse is a refusal carrying a sentence a person can act on — "we do
 * not know the district 'Atlantis'; the districts are …" — never an internal
 * code, because the reader is holding a phone, not a terminal.
 *
 * **USSD is a session, so it is a state machine.** A USSD exchange is a menu out
 * and one keystroke back, over and over, and the carrier holds no state between
 * the two: the caller persists the session. So the machine is a pure reducer —
 * `startUssdSession` returns a plain-data state, `ussdAdvance(state, keystroke)`
 * returns the next state and the next menu — and it is testable without a phone,
 * a shortcode or a network. An out-of-range key re-prompts rather than advancing,
 * because a keystroke that silently skipped a question would file a report
 * missing the answer the question was for, and nothing downstream could tell.
 *
 * Nothing here imports an npm dependency, touches the DOM, or writes to a store.
 * It imports three sibling modules and nothing else: the form vocabulary it
 * validates against, the registry it grounds districts through, and the id
 * helper every record in this repo is keyed by. The route that receives the
 * message owns authentication (`verifyRapidProWebhook`), flood control
 * (`src/inbound-rate-limit.js`) and the write; this module only decides what the
 * message said.
 */

import { CHW_SYMPTOM_FORM, applicableFields, validateAnswers } from './forms.js'
import { ORG_UNITS, orgUnitFor } from './org-units.js'
import { stableId } from './utils.js'

/**
 * The one verb this file adds to the inbound grammar.
 *
 * `REPORT` is accepted as a synonym, not as a second verb: `parseReportText` in
 * `src/rapidpro.js` already strips a leading `report ` when it reads a free-text
 * field report, so a message beginning "REPORT" has always been a report in this
 * codebase. Naming it here makes that explicit rather than leaving a second
 * introducer half-recognised on the old path and ignored on the new one. The
 * canonical value recorded on the record is always `SUBMIT`.
 */
export const SUBMIT_VERB = 'SUBMIT'
export const SUBMIT_VERB_ALIASES = Object.freeze(['SUBMIT', 'REPORT'])

// Anchored at the start and whole-token, exactly like `REPLY_PATTERN`: "submit"
// in the middle of a sentence is not a submission, and `SUBMITTED` must not match
// `SUBMIT` (the `\b` after the verb is what stops it).
const SUBMIT_PATTERN = /^\s*[>*\-]?\s*(SUBMIT|REPORT)\b[\s:|-]*(.*)$/i

/**
 * The refusal codes. A closed set, so a test can assert every one is reachable
 * and a caller can branch on the code rather than on a message string.
 *
 * `unknown_district` and `unknown_field` are the two a feature-phone user will
 * actually hit; `no_form` is the operator's problem and says so.
 */
export const SUBMIT_REFUSALS = Object.freeze({
  missing_district: 'missing_district',
  unknown_district: 'unknown_district',
  no_form: 'no_form',
  unknown_field: 'unknown_field',
  missing_answers: 'missing_answers',
  invalid_value: 'invalid_value',
})

/**
 * The field types a USSD menu can ask for with a keypad.
 *
 * A map pin, a photograph, a typed paragraph and a calendar date are all things
 * a feature phone cannot produce through a menu, so a USSD session does not
 * pretend to ask them — it skips them and records which it skipped. When a
 * skipped field is required, `validateAnswers` refuses at the confirmation step
 * and the refusal names the question, which is the honest outcome: a form whose
 * required question needs a map cannot be filed from a phone without one.
 */
export const USSD_ANSWERABLE_TYPES = Object.freeze(['select', 'multiselect', 'boolean', 'integer', 'number'])

/**
 * The USSD response budget, in characters.
 *
 * A USSD screen is 182 characters of GSM-7 in one response; past that the carrier
 * truncates and the last option on a menu becomes invisible. Menus are built to
 * fit and clipped defensively at this bound, because a clipped menu is worse than
 * a short one but far better than a request the carrier rejects.
 */
export const USSD_MENU_MAX = 182

/**
 * The key that skips an optional question.
 *
 * `0` rather than a word, because a USSD menu is answered with digits and `0` is
 * the conventional "none/skip" on the menus this population already uses. It is
 * honoured only for a field the form marks optional; on a required field the
 * machine re-prompts, because a skip that filed a report missing a required
 * answer would be a silent hole in the record.
 */
export const USSD_SKIP_KEY = '0'

// A leading bare word is a district; a token with `=` in it starts a field. These
// are the explicit spellings for a district that arrives as a key rather than
// positionally, which is what a caller who did not read the instructions will do.
const DISTRICT_KEY = /^(?:district|dist|wilaya|county|location)\s*=\s*(.*)$/i

// The separators a handset actually produces between fields: `;`, `|`, a comma
// and a newline all end a field, and whitespace separates tokens within one. A
// comma is a field separator *and* appears inside values — a coordinate pair
// ("3.12,35.6") and a multiselect list ("sleepy,breathing") both use it. The
// split is on `,` only when the surrounding text looks like fields, which is
// what `splitSeparators` decides; a comma inside a value is rejoined there.
const STRONG_SEPARATORS = /[;|\n\r]+/
const COMMA = /\s*,\s*/

/**
 * Split one separator-delimited part into fields, keeping commas that belong to
 * a value.
 *
 * A comma is a separator when the segment that follows it begins a new
 * `key=value` token ("who=child, symptom=fever"); it is part of a value when it
 * sits inside a coordinate pair or a list ("location=3.12,35.6" or
 * "signs=sleepy,breathing"). Distinguishing the two by lookahead — a comma is a
 * separator only if a `=` follows before the next comma — is what lets a single
 * rule serve both, rather than a heuristic that would cut a coordinate in half.
 */
function splitSeparators(part) {
  const segments = part.split(COMMA)
  if (segments.length === 1) return [part]
  const out = []
  let buffer = segments[0]
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i]
    // The comma before `segment` is a field boundary if this segment carries a
    // `key=value`, or if the buffer so far already carries one and this segment
    // does not look like the tail of a value (no `=` and not numeric).
    const startsField = segment.includes('=')
    if (startsField) {
      out.push(buffer)
      buffer = segment
    } else {
      buffer = `${buffer},${segment}`
    }
  }
  out.push(buffer)
  return out
}

/** Common abbreviations for a field key that is not a prefix of the real name. */
const FIELD_ALIASES = Object.freeze({
  duration: 'duration_value',
  howlong: 'duration_value',
  unit: 'duration_unit',
  signs: 'danger_signs',
  dangersigns: 'danger_signs',
  water: 'water_source',
  vacc: 'vaccination',
  vax: 'vaccination',
  vaccinate: 'vaccination',
  signsother: 'danger_signs_other',
  other: 'danger_signs_other',
  sickcontact: 'contact_sick',
  deadcontact: 'contact_dead',
})

/** Common spellings and shorthands for an option value, mapped to the canonical. */
const OPTION_ALIASES = Object.freeze({
  y: 'yes', n: 'no', u: 'unknown',
  me: 'self', myself: 'self', i: 'self',
  kid: 'child', baby: 'child', infant: 'child', son: 'child', daughter: 'child',
  diarrhoea: 'diarrhea', diarrhoeal: 'diarrhea', loose: 'diarrhea', stool: 'diarrhea',
  temp: 'fever', hot: 'fever', temperature: 'fever',
  tired: 'sleepy', lethargic: 'sleepy', drowsy: 'sleepy',
  breath: 'breathing', difficultbreathing: 'breathing',
  drink: 'drinking', refuse: 'drinking',
  bleed: 'bleeding', blood: 'bleeding',
  weakness: 'weak',
  tap: 'clean', safe: 'clean', borehole: 'clean', treated: 'clean',
  open: 'unprotected', river: 'unprotected', pond: 'unprotected', lake: 'unprotected',
  dirty: 'unclean', contaminated: 'unclean',
  hr: 'hours', hrs: 'hours', hour: 'hours',
  day: 'days',
})

// ---------------------------------------------------------------------------
// SMS: a structured submission, parsed forgivingly and grounded strictly.
// ---------------------------------------------------------------------------

/**
 * Parse an inbound SMS message as a field-report submission.
 *
 * Returns one of three shapes, and the distinction is the whole contract:
 *
 *   - `{ recognised: false, refusal: null }` — not a submission at all. The
 *     caller falls through to `parseReplyVerb`, which is the path that must keep
 *     working unchanged.
 *   - `{ recognised: true, refusal: {code, message} }` — a submission that could
 *     not be grounded. `message` is written for the handset that sent it.
 *   - `{ recognised: true, submission }` — a submission that validated against
 *     the named form version. `submission` is a `field_reports`-shaped record.
 *
 * Options: `forms` (the merged catalogue, as `mergeForms` returns it), `formId`
 * and `formVersion` (which version to file against; defaults to the newest
 * version of the built-in CHW form the deployment serves), and `from`, `sourceId`,
 * `observedAt` for the record's identity and clock.
 */
export function parseSmsSubmission(text, options = {}) {
  const {
    forms = null, formId = null, formVersion = null,
    from = null, sourceId = null, observedAt = null,
  } = options

  const raw = String(text ?? '')
  const trimmed = raw.trim()
  // An empty message is not a submission, so it falls through like any other
  // non-submission — and a refusal with `recognised: false` would be a refusal
  // the caller is entitled to ignore. The reply grammar counts a blank message
  // as someone responding, which is the honest reading of a blank message.
  if (!trimmed) return { recognised: false, verb: null, refusal: null, submission: null }

  const match = trimmed.match(SUBMIT_PATTERN)
  if (!match) return { recognised: false, verb: null, refusal: null, submission: null }

  // The alternation in `SUBMIT_PATTERN` and `SUBMIT_VERB_ALIASES` above are the
  // same two words spelled twice, and the list was the copy nothing read — a
  // verb added there would document a synonym the parser rejects. Comparing the
  // matched token against the list makes the list load-bearing, so the drift
  // this repository keeps paying for cannot be introduced silently: a pattern
  // that grew a verb the list lacks throws here rather than accepting it.
  if (!SUBMIT_VERB_ALIASES.includes(match[1].toUpperCase())) {
    throw new Error(`SUBMIT_PATTERN matched ${JSON.stringify(match[1])}, which is not in SUBMIT_VERB_ALIASES (${SUBMIT_VERB_ALIASES.join(', ')})`)
  }

  const verb = SUBMIT_VERB
  const rest = (match[2] || '').trim()
  // A bare verb: recognised as a submission, but with nothing to ground it. The
  // refusal teaches the shape rather than reporting a parse error.
  if (!rest) {
    return {
      recognised: true,
      verb,
      refusal: refusal(SUBMIT_REFUSALS.missing_district,
        'A SUBMIT needs a district. Send SUBMIT, the district, then your answers — for example: SUBMIT Turkana who=child symptom=fever duration=2 days.'),
      submission: null,
    }
  }

  const form = resolveForm(forms, formId, formVersion)
  if (!form) {
    return {
      recognised: true,
      verb,
      refusal: refusal(SUBMIT_REFUSALS.no_form,
        'No form is published for this deployment, so the report cannot be filed. Tell your focal point that the CHW form is not being served.'),
      submission: null,
    }
  }

  const tokens = tokenize(rest)
  const grounded = groundDistrict(tokens)
  if (grounded.error) return { recognised: true, verb, refusal: grounded.error, submission: null }

  const parsed = parseFieldTokens(grounded.remaining, form)
  if (parsed.unknownKeys.length) {
    return {
      recognised: true,
      verb,
      refusal: refusal(SUBMIT_REFUSALS.unknown_field,
        `We do not know the answer "${parsed.unknownKeys.join(', ')}". The answers for this report are: ${form.fields.map((f) => f.name).join(', ')}.`),
      submission: null,
    }
  }

  if (!Object.keys(parsed.answers).length && !parsed.note) {
    return {
      recognised: true,
      verb,
      refusal: refusal(SUBMIT_REFUSALS.missing_answers,
        `The district was understood but no answers were. Send SUBMIT ${grounded.unit.name} then your answers — for example: SUBMIT ${grounded.unit.name} who=child symptom=fever duration=2 days.`),
      submission: null,
    }
  }

  const built = buildSubmission({
    channel: 'sms',
    form,
    answers: parsed.answers,
    district: grounded.unit,
    note: parsed.note || null,
    rawText: trimmed,
    from,
    sourceId,
    observedAt,
  })
  if (built.problems.length) {
    return { recognised: true, verb, refusal: refusalForProblems(built.problems), submission: null }
  }
  return { recognised: true, verb, refusal: null, submission: built.submission }
}

// ---------------------------------------------------------------------------
// USSD: a menu state in, a keystroke back, the next state out.
// ---------------------------------------------------------------------------

/**
 * Begin a USSD session against one form version, scoped to one district.
 *
 * USSD shortcodes are district-scoped in the deployment this serves — the
 * shortcode is the district, and the session does not ask which one it is — so
 * the district is an argument and is grounded here, once, rather than being a
 * step in the menu. A district that cannot be grounded refuses the session at
 * start, with the same message the SMS path gives.
 *
 * The returned state is plain data (the form definition rides on it, which is
 * what makes the reducer pure and the state JSON-serialisable across a carrier
 * boundary). The caller shows `menuFor(state)` and calls `ussdAdvance` for each
 * keystroke the carrier delivers.
 */
export function startUssdSession(options = {}) {
  const {
    forms = null, formId = null, formVersion = null,
    district = null, from = null, sourceId = null, observedAt = null,
  } = options

  const base = {
    channel: 'ussd',
    form: null,
    form_id: null,
    form_version: null,
    district: null,
    step: 'refused',
    answers: {},
    skipped: [],
    refusal: null,
    submission: null,
    from: from || null,
    source_id: sourceId || null,
    observed_at: observedAt || null,
  }

  const form = resolveForm(forms, formId, formVersion)
  if (!form) {
    return { ...base, refusal: refusal(SUBMIT_REFUSALS.no_form, 'No form is published for this deployment, so a report cannot be filed. Tell your focal point.') }
  }

  const unit = groundDistrictPhrase(district)
  if (!unit) {
    const message = district === null || district === undefined || String(district).trim() === ''
      ? 'This shortcode is not set up for a district, so a report cannot be filed. Tell your focal point.'
      : unknownDistrictMessage(district)
    return { ...base, form, form_id: form.id, form_version: form.version, refusal: refusal(SUBMIT_REFUSALS.unknown_district, message) }
  }

  const session = {
    ...base,
    form,
    form_id: form.id,
    form_version: form.version,
    district: { slug: unit.slug || null, code: unit.code, name: unit.name },
  }
  session.step = nextStep(form, session.answers, null)
  return session
}

/**
 * One keystroke against one menu state, returning the next state and the menu to
 * show. Pure: the input state is never mutated, and the same state plus the same
 * key always yields the same next state.
 *
 * Terminal states (`done`, `cancelled`, `refused`) absorb any further keystroke
 * and return themselves, so a carrier that delivers one extra key after the
 * session ended cannot resurrect it.
 */
export function ussdAdvance(session, keystroke) {
  if (!session || session.step === 'done' || session.step === 'cancelled' || session.step === 'refused') {
    return { session, reply: menuFor(session), done: true }
  }

  const key = String(keystroke ?? '').trim()

  if (session.step === 'confirm') {
    if (key === '1') {
      const built = buildSubmission({
        channel: 'ussd',
        form: session.form,
        answers: session.answers,
        district: session.district,
        note: null,
        rawText: null,
        from: session.from,
        sourceId: session.source_id,
        observedAt: session.observed_at,
        skipped: session.skipped,
      })
      if (built.problems.length) {
        const next = { ...session, step: 'refused', refusal: refusalForProblems(built.problems) }
        return { session: next, reply: menuFor(next), done: true }
      }
      const next = { ...session, step: 'done', submission: built.submission, refusal: null }
      return { session: next, reply: menuFor(next), done: true }
    }
    if (key === '2') {
      const next = { ...session, step: 'cancelled' }
      return { session: next, reply: menuFor(next), done: true }
    }
    // An out-of-range key at the confirmation does not send and does not cancel.
    return { session, reply: `Reply 1 to send or 2 to cancel.\n${menuFor(session)}`, done: false }
  }

  const field = fieldByName(session.form, session.step)
  if (!field) {
    // Unreachable while the machine is well-formed, but an unrecognised step must
    // not fall through to a silent advance — that is the hang-waiting-for-input
    // shape. Refuse, so the session ends rather than looping.
    const next = { ...session, step: 'refused', refusal: refusal(SUBMIT_REFUSALS.invalid_value, 'This report could not continue. Start again by dialling the shortcode.') }
    return { session: next, reply: menuFor(next), done: true }
  }

  const read = readKeystroke(field, key)
  if (!read.ok) {
    // A menu needs a way past a question the reporter cannot answer. `0` skips an
    // optional field and is refused on a required one — a session that could not
    // skip anything would strand a reporter on a question the form itself calls
    // optional, and one that could skip a required question would file a report
    // missing the answer the question was for.
    if (key === USSD_SKIP_KEY && !field.required) {
      const answers = { ...session.answers }
      const step = nextStep(session.form, answers, field.name)
      const next = { ...session, step }
      if (step === 'confirm') next.skipped = skippedFields(session.form, answers)
      return { session: next, reply: menuFor(next), done: false }
    }
    return { session, reply: `${read.hint}\n${menuFor(session)}`, done: false }
  }

  const answers = { ...session.answers, [field.name]: read.value }
  const step = nextStep(session.form, answers, field.name)
  const next = { ...session, answers, step }
  // The skipped list is recomputed once, at the point the session leaves the
  // questions, because relevance depends on answers that are only now complete.
  if (step === 'confirm') next.skipped = skippedFields(session.form, answers)
  return { session: next, reply: menuFor(next), done: false }
}

/**
 * The menu text for a state, or null for a state with nothing to show.
 *
 * Exported because the caller renders it without advancing, and because a test
 * can assert a menu's shape without driving a keystroke through it.
 */
export function menuFor(session) {
  if (!session) return null
  if (session.step === 'done') return 'Report filed. Thank you.'
  if (session.step === 'cancelled') return 'Report cancelled. Nothing was filed.'
  if (session.step === 'refused') return session.refusal?.message || 'This report could not be filed.'
  if (session.step === 'confirm') return confirmMenu(session)
  const field = fieldByName(session.form, session.step)
  return field ? clipUssd(fieldMenu(field)) : null
}

// ---------------------------------------------------------------------------
// Grounding: districts, forms, and the record both channels produce.
// ---------------------------------------------------------------------------

/** The districts the platform publishes, for a refusal that names them. */
function districtUnits() {
  return ORG_UNITS.filter((unit) => unit.publishes_page)
}

/**
 * Resolve a district phrase through the registry, then through a unique prefix.
 *
 * The registry's `orgUnitFor` already handles a code, a slug, a name and the
 * synonym table (`moroto → Karamoja`). What it does not do is expand an
 * abbreviation, and a health worker on a keypad types `turk` long before they
 * type `Turkana`. The expansion is conservative: it fires only when exactly one
 * district starts with the token, because an ambiguous prefix that picked one
 * district would put a report in the wrong place and say nothing.
 */
function groundDistrictPhrase(phrase) {
  if (phrase === null || phrase === undefined) return null
  const text = String(phrase).trim()
  if (!text) return null
  const direct = orgUnitFor(text)
  if (direct) return direct
  const key = text.toLowerCase()
  const prefixed = districtUnits().filter((unit) => (
    String(unit.name).toLowerCase().startsWith(key) || String(unit.slug).toLowerCase().startsWith(key)
  ))
  if (prefixed.length === 1) return orgUnitFor(prefixed[0].name) || prefixed[0]
  return null
}

/**
 * Pull the district out of the token list, and return the tokens that remain.
 *
 * An explicit `district=` wins wherever it appears. Failing that, the leading
 * bare words (before the first `key=`) are the district phrase, and the longest
 * prefix of them that grounds is taken — so "South Sudan" resolves as two words,
 * and "Turkana fever" resolves the district and leaves "fever" as a note.
 */
function groundDistrict(tokens) {
  const explicit = tokens.find((token) => DISTRICT_KEY.test(token))
  if (explicit) {
    const value = explicit.match(DISTRICT_KEY)[1].trim()
    const unit = groundDistrictPhrase(value)
    const remaining = tokens.filter((token) => token !== explicit)
    return unit
      ? { unit, remaining, error: null }
      : { unit: null, remaining, error: refusal(SUBMIT_REFUSALS.unknown_district, unknownDistrictMessage(value)) }
  }

  const leading = []
  let i = 0
  while (i < tokens.length && !tokens[i].includes('=')) {
    leading.push(tokens[i])
    i += 1
  }
  if (!leading.length) {
    return { unit: null, remaining: tokens, error: refusal(SUBMIT_REFUSALS.missing_district, 'A SUBMIT needs a district. Put it right after SUBMIT, for example: SUBMIT Turkana who=child symptom=fever.') }
  }
  for (let n = leading.length; n >= 1; n -= 1) {
    const unit = groundDistrictPhrase(leading.slice(0, n).join(' '))
    if (unit) return { unit, remaining: [...leading.slice(n), ...tokens.slice(i)], error: null }
  }
  return {
    unit: null,
    remaining: tokens.slice(leading.length),
    error: refusal(SUBMIT_REFUSALS.unknown_district, unknownDistrictMessage(leading.join(' '))),
  }
}

function unknownDistrictMessage(value) {
  return `We do not know the district "${String(value).trim()}". The districts are: ${districtUnits().map((unit) => unit.name).join(', ')}.`
}

/**
 * Split a message body into tokens.
 *
 * Strong separators and commas end a field; whitespace separates tokens within
 * one. Spaces around the `=` are removed first, because a keypad user types
 * `who = child` as readily as `who=child` and a token that failed to split there
 * would leave the key unrecognised and the whole field refused. The result is a
 * flat list in which a token containing `=` begins a new field and a token
 * without one continues the current field's value — which is what lets a
 * multi-word answer ("2 days", "very sleepy") survive a keypad.
 */
function tokenize(text) {
  return String(text)
    .replace(/\s*=\s*/g, '=')
    .split(STRONG_SEPARATORS)
    .flatMap((part) => splitSeparators(part))
    .flatMap((part) => part.trim().split(/\s+/))
    // Strip edge commas the separator split leaves behind, so a message that
    // begins "SUBMIT, Turkana" grounds the district rather than a token reading
    // ",Turkana". Interior commas survive: they are a multiselect list or a
    // coordinate pair, both of which belong to the value.
    .map((token) => token.replace(/^,+|,+$/g, ''))
    .filter((token) => /[a-z0-9]/i.test(token))
}

/**
 * Read the `key=value` tokens into an answer object.
 *
 * A key is resolved to a field by exact name, by alias, or by a unique prefix.
 * A value is normalised to its field's type forgivingly (an option prefix, a
 * yes/no shorthand, a duration that carries its own unit). Unknown keys are
 * collected rather than dropped: a key the form does not declare is refused, the
 * same discipline `validateAnswers` applies to an unknown answer.
 */
function parseFieldTokens(tokens, form) {
  const answers = {}
  const unknownKeys = []
  const notes = []
  let current = null
  let currentRaw = ''

  const flush = () => {
    if (!current) return
    applyField(form, current, currentRaw, answers)
    current = null
    currentRaw = ''
  }

  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq > 0) {
      flush()
      const field = fieldForToken(token.slice(0, eq), form.fields)
      if (!field) {
        unknownKeys.push(token.slice(0, eq))
        continue
      }
      current = field
      currentRaw = token.slice(eq + 1)
    } else if (current && absorbsContinuation(current, token)) {
      // A multi-word value ("2 days", "very sleepy"). Only a field that can hold
      // one absorbs the next token; anything else closes the field and starts a
      // note, so trailing free text after the answers does not silently become
      // part of the last answer.
      currentRaw = `${currentRaw} ${token}`.trim()
    } else {
      // The field ends here and the token is free text. Flush the field before
      // the note begins, or the last answer before the prose is never applied —
      // a report that reads as complete on the handset but arrives with a
      // required field missing.
      flush()
      notes.push(token)
    }
  }
  flush()

  return { answers, unknownKeys, note: notes.join(' ').trim() }
}

/**
 * Whether a token continues the current field's value.
 *
 * Free text fields hold a whole phrase, so they absorb everything until the next
 * `key=`. Every other type takes a single token, with one exception worth naming:
 * `duration_value` absorbs a following unit word, because "duration=2 days" is
 * how a person writes a duration and the unit is part of the same value. A token
 * that neither case claims becomes a note rather than corrupting the answer.
 */
function absorbsContinuation(field, token) {
  if (field.type === 'text' || field.type === 'textarea') return true
  if (field.name === 'duration_value' && durationUnitIn(token)) return true
  return false
}

/** Normalise one raw value and place it, with the duration shorthand handled. */
function applyField(form, field, rawValue, answers) {
  // The duration shorthand: "duration=2 days" is a value and a unit in one
  // breath, and a keypad user will not type them as two fields. Fill the unit
  // only when the value named one and the form asks for a unit at all.
  if (field.name === 'duration_value' && !answers.duration_unit && form.fields.some((f) => f.name === 'duration_unit')) {
    const unit = durationUnitIn(rawValue)
    if (unit) answers.duration_unit = unit
  }
  answers[field.name] = normalizeValue(field, rawValue)
}

/** Resolve a key token to a field: exact, alias, then unique prefix. */
function fieldForToken(token, fields) {
  const key = normalizeKey(token)
  if (!key) return null
  const byName = new Map(fields.map((field) => [normalizeKey(field.name), field]))
  if (byName.has(key)) return byName.get(key)
  const alias = FIELD_ALIASES[key]
  if (alias && byName.has(normalizeKey(alias))) return byName.get(normalizeKey(alias))
  const prefixed = fields.filter((field) => normalizeKey(field.name).startsWith(key))
  return prefixed.length === 1 ? prefixed[0] : null
}

/** Lower-case, alphanumerics only — so `duration_value`, `durationValue` and `Duration Value` agree. */
function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Coerce one raw string to the field's type, as forgivingly as the type allows. */
function normalizeValue(field, raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  switch (field.type) {
    case 'select':
      return matchOption(field.options || [], text) || text
    case 'multiselect':
      return text.split(/[,+&/\s]+/).map((part) => matchOption(field.options || [], part) || part).filter(Boolean)
    case 'boolean':
      return matchBoolean(text)
    case 'integer': {
      const n = leadingNumber(text)
      return n === null ? text : Math.trunc(n)
    }
    case 'number': {
      const n = leadingNumber(text)
      return n === null ? text : n
    }
    case 'geopoint':
      return matchGeopoint(text) || text
    default:
      return text
  }
}

/** An option value matched exactly, by alias, or by a unique prefix. */
function matchOption(options, text) {
  const key = normalizeKey(text)
  if (!key) return null
  const exact = options.find((option) => normalizeKey(option) === key)
  if (exact) return exact
  const alias = OPTION_ALIASES[key]
  if (alias) {
    const hit = options.find((option) => option === alias)
    if (hit) return hit
  }
  const prefixed = options.filter((option) => normalizeKey(option).startsWith(key))
  return prefixed.length === 1 ? prefixed[0] : null
}

function matchBoolean(text) {
  const key = normalizeKey(text)
  if (['yes', 'y', 'true', '1'].includes(key)) return true
  if (['no', 'n', 'false', '0'].includes(key)) return false
  return text
}

function leadingNumber(text) {
  const match = String(text).match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function matchGeopoint(text) {
  const match = String(text).match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/)
  return match ? { latitude: Number(match[1]), longitude: Number(match[2]) } : null
}

/** The unit word a duration value carries, or null. "2d" and "2 days" both give `days`. */
function durationUnitIn(text) {
  const match = String(text).match(/(hours?|hrs?|h|days?|d)\b/i)
  if (!match) return null
  const unit = match[1].toLowerCase()
  if (unit.startsWith('h')) return 'hours'
  if (unit.startsWith('d')) return 'days'
  return null
}

/**
 * Resolve which form version a submission files against.
 *
 * With an explicit `(formId, formVersion)` it is that exact pair, or nothing —
 * a client that names a version the deployment does not serve is refused, not
 * silently filed under the newest one, because a record that claims a version
 * nobody can read is a record nobody can interpret. With no id it is the newest
 * version of the built-in CHW form the deployment serves.
 */
function resolveForm(forms, formId, formVersion) {
  const list = Array.isArray(forms) && forms.length ? forms : [CHW_SYMPTOM_FORM]
  if (formId) {
    const versions = list.filter((form) => form.id === formId)
    if (!versions.length) return null
    if (Number.isInteger(formVersion)) return versions.find((form) => form.version === formVersion) || null
    return versions[versions.length - 1]
  }
  const chw = list.filter((form) => form.id === CHW_SYMPTOM_FORM.id)
  return chw.length ? chw[chw.length - 1] : null
}

/**
 * Build the record both channels file.
 *
 * The shape is the one the Kobo connector writes into `field_reports`
 * (`src/connectors/kobo.js`): `id`, `external_id`, `form_id`, `submitted_at`,
 * `district`, `body`, `source`, `reporter_urn_hash`. It is a field report that
 * happens to have arrived by text, so it lands in the same collection with the
 * same readers.
 *
 * `reporter_urn_hash` stays null, deliberately. The sender is carried in `from`,
 * and the ingest route runs `redactPii` over the record the way the RapidPro
 * inbound path does — masking, which is what lets an operator recognise a
 * reporter who has called before. Hashing here would be a second
 * pseudonymisation scheme beside the one `src/pii.js` owns, and this repo's
 * recurring defect is exactly a second copy of a vocabulary kept in step by hand.
 */
function buildSubmission({ channel, form, answers, district, note, rawText, from, sourceId, observedAt, skipped = [] }) {
  const { answers: valid, problems } = validateAnswers(form, answers)
  if (problems.length) return { problems, submission: null }

  const now = observedAt || new Date().toISOString()
  const id = stableId('field_report', [channel, sourceId || from || null, rawText || JSON.stringify(valid), now])
  const body = JSON.stringify({
    form_id: form.id,
    form_version: form.version,
    answers: valid,
    note: note || null,
    channel,
    raw_text: rawText || null,
  })

  return {
    problems: [],
    submission: {
      id,
      external_id: sourceId || null,
      form_id: form.id,
      form_version: form.version,
      submitted_at: now,
      district: district?.slug || null,
      district_code: district?.code || null,
      district_name: district?.name || null,
      body,
      source: channel,
      // See the note above: the sender is carried and redacted downstream, never
      // hashed here.
      reporter_urn_hash: null,
      reported_by: from || null,
      from: from || null,
      channel,
      answers: valid,
      note: note || null,
      skipped,
      captured_at: now,
      raw_text: rawText || null,
    },
  }
}

// ---------------------------------------------------------------------------
// The USSD menu rendering and keystroke reading.
// ---------------------------------------------------------------------------

/** The ordered, applicable, keypad-answerable fields for the answers so far. */
function answerableFields(form, answers) {
  return applicableFields(form, answers).filter((field) => USSD_ANSWERABLE_TYPES.includes(field.type))
}

/** The fields the menu will have to skip, because no keystroke can answer them. */
function skippedFields(form, answers) {
  return applicableFields(form, answers)
    .filter((field) => !USSD_ANSWERABLE_TYPES.includes(field.type))
    .map((field) => field.name)
}

/**
 * The next step after `afterName`, recomputed from the answers.
 *
 * Recomputing rather than precomputing is what makes a form's skip logic work
 * over USSD: answering one question can make another applicable or irrelevant,
 * and a menu that walked a fixed list would ask a question the answers just
 * excluded.
 */
function nextStep(form, answers, afterName) {
  const list = answerableFields(form, answers)
  if (!afterName) return list.length ? list[0].name : 'confirm'
  const index = list.findIndex((field) => field.name === afterName)
  if (index < 0) {
    const unanswered = list.find((field) => answers[field.name] === undefined)
    return unanswered ? unanswered.name : 'confirm'
  }
  const next = list[index + 1]
  return next ? next.name : 'confirm'
}

function fieldByName(form, name) {
  return (form?.fields || []).find((field) => field.name === name) || null
}

/** The numbered options a field presents, or null for a field typed as a number. */
function optionsFor(field) {
  if (field.type === 'boolean') {
    return [{ key: '1', value: true, label: 'yes' }, { key: '2', value: false, label: 'no' }]
  }
  if (field.type === 'select' || field.type === 'multiselect') {
    return (field.options || []).map((option, index) => ({ key: String(index + 1), value: option, label: option }))
  }
  return null
}

/** Read one keystroke against one field, returning the value or a re-prompt hint. */
function readKeystroke(field, key) {
  const options = optionsFor(field)
  if (options) {
    if (field.type === 'multiselect') {
      const digits = key.replace(/\D/g, '')
      const chosen = [...new Set(digits.split(''))].map((digit) => options[Number(digit) - 1]).filter(Boolean)
      if (!chosen.length) return { ok: false, hint: `Please reply with the numbers of your answers, for example 13 (1 to ${options.length}).` }
      return { ok: true, value: chosen.map((option) => option.value) }
    }
    const digit = key.replace(/\D/g, '')
    const byDigit = digit ? options[Number(digit) - 1] : null
    if (byDigit) return { ok: true, value: byDigit.value }
    // A keypad user may type the word instead of the number; accept it.
    const byLabel = options.find((option) => normalizeKey(option.label) === normalizeKey(key))
    if (byLabel) return { ok: true, value: byLabel.value }
    return { ok: false, hint: `Please reply 1 to ${options.length}.` }
  }
  const number = leadingNumber(key)
  if (number === null) return { ok: false, hint: 'Please reply with a number.' }
  return { ok: true, value: field.type === 'integer' ? Math.trunc(number) : number }
}

function fieldMenu(field) {
  const options = optionsFor(field)
  const label = field.label || field.name
  const skip = field.required ? '' : ' 0 skip'
  if (!options) return `${label} (reply a number${skip})`
  const lines = options.map((option) => `${option.key} ${option.label}`)
  const instruction = field.type === 'multiselect' ? ' (reply the numbers, for example 13)' : ''
  return `${label}${instruction}${skip}\n${lines.join('\n')}`
}

function confirmMenu(session) {
  const summary = Object.entries(session.answers)
    .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join('+') : value}`)
    .join(' ')
  return clipUssd(`Send this report?\n${summary}\n1 Send  2 Cancel`)
}

function clipUssd(text) {
  const value = String(text ?? '')
  return value.length <= USSD_MENU_MAX ? value : value.slice(0, USSD_MENU_MAX)
}

// ---------------------------------------------------------------------------
// Small shared shapes.
// ---------------------------------------------------------------------------

function refusal(code, message) {
  return { code, message }
}

function refusalForProblems(problems) {
  return refusal(
    SUBMIT_REFUSALS.invalid_value,
    `The report was not complete or not readable: ${problems.join('; ')}. Send it again as SUBMIT, the district, then the answers — for example: SUBMIT Turkana who=child symptom=fever duration=2 days.`,
  )
}
