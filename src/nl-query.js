/**
 * ENH-68 — grounded natural-language query.
 *
 * The console has 144 controls because the operator has to assemble a query by
 * hand: pick the collection, the district, the window, the threshold, the
 * second collection that says whether anything was dispatched. This module
 * collapses that into one question —
 *
 *   "Which districts crossed the flood-threshold last week and have no
 *    dispatch?"
 *
 * — but the question is not the interesting part. What makes this worth having
 * is the discipline `src/narrator.js` already applies to generated prose, moved
 * to generated *answers*:
 *
 * **A query layer must not produce a number its fact set does not contain.**
 *
 * So this is not a language model and it is not a search. It is a deterministic
 * parser and resolver over a *declared vocabulary* — the subjects, districts,
 * windows and predicates below are the entire space of questions it can be
 * asked — and it answers by:
 *
 *   1. parsing the question into a structured query, refusing on any term it
 *      does not carry (an unknown subject, two districts where it answers about
 *      one);
 *   2. resolving that query against the store's derived collections and
 *      collecting every value it read into a **fact set**;
 *   3. rendering a sentence from those facts, and then checking the sentence
 *      against the fact set before returning it — every digit the sentence
 *      writes must be a value it retrieved. A sentence that introduces a
 *      figure the facts do not state is REFUSED, with the invented figure
 *      named. This is `narrator.js`'s `allowedNumbers` audit, verbatim in
 *      spirit: a number is a claim, and an unretrieved one is an invention.
 *
 * **An absent value is not zero and not "approximately".** The store holds the
 * *latest* risk score per district, not a history, so "crossed the threshold
 * last week" is answered as "is above the threshold now" and the answer says
 * so. A district with no dispatch records in a store that records no dispatches
 * at all is not "undispatched" — it is unmeasured, and the query refuses rather
 * than reporting an absence it cannot tell from a gap.
 *
 * **A model refusal is rendered, not paraphrased.** When the question asks for a
 * model's output — flood probability for a district — and the model has no
 * trained fit there, the answer is the model's own refusal sentence, read from
 * `src/model-registry.js` (`refusalSentence`, `floorsMissed`), naming the floor
 * that is unmet. That is the integration this entry exists for: a surface that
 * shows a model's number and a surface that shows why there is no number read
 * the same words, so "not measured" reads the same everywhere.
 *
 * No LLM, no network, no new dependency. `now` is injectable so a test can pin
 * the window.
 */

import { KNOWN_DISTRICTS, resolveDistrict } from './districts.js'
import { ORG_UNITS, ORG_UNIT_SYNONYMS } from './org-units.js'
import { floorsMissed, refusalSentence } from './model-registry.js'
import { numericOrNull } from './analytics/numeric.js'

export const NL_QUERY_BASIS = Object.freeze({
  basis: 'a deterministic parser and resolver over a declared vocabulary — no model, no network, no free-text interpretation',
  serves: 'one grounded answer over the store\'s derived collections, carrying the facts it read',
  not: 'the answer is not a search result and not an estimate: every figure it states is a value it retrieved, the sentence is audited against its own fact set before it is returned, and a figure the facts do not contain is refused rather than published',
  refusals: 'no question · unknown subject · ambiguous region · unknown field · no data · unreadable record · unmeasured · model refusal · invented figure',
  checked: 'the count of digit figures the answer restated ships with it (numbers_checked), so a reader can see the sentence was audited, not trusted',
  window: 'the store holds the latest value per district, not a history; a window scopes the event collections (alerts, dispatches, hazards) and is stated on the answer rather than assumed silently',
})

// R-77: the query vocabulary (WINDOWS, SUBJECTS, PREDICATES, DEFAULT_WINDOW,
// NL_QUERY_VOCABULARY, NL_FLOOD_THRESHOLD_SCORE) moved to
// `src/nl-vocabulary.js`, a leaf module, because `src/needle.js` imported it
// from here while this file dynamically imports `needle.js` at
// `parseQueryWithModel` — the fifth cycle in `src/`, reachable only through a
// dynamic import and therefore invisible to a static-only graph.
//
// The import serves this module's own call sites (the parser reads the
// vocabulary throughout); the re-export keeps `test/needle.test.js` and any
// other existing importer on its import path.
import {
  DEFAULT_WINDOW,
  NL_FLOOD_THRESHOLD_SCORE,
  NL_QUERY_VOCABULARY,
  PREDICATES,
  SUBJECTS,
  WINDOWS,
} from './nl-vocabulary.js'

export {
  DEFAULT_WINDOW,
  NL_FLOOD_THRESHOLD_SCORE,
  NL_QUERY_VOCABULARY,
  PREDICATES,
  SUBJECTS,
  WINDOWS,
}

// These three are the *parser's*, not the vocabulary's, so they stayed here when
// the vocabulary moved: `TIME_FIELDS` is read by `recordTime`, `escapeRegExp` by
// `phrasePattern`, and `REGION_TERMS` by `findRegions`. They sat between the
// vocabulary constants in the file, which is why the first cut of the move
// swept them into the leaf and the parser then failed on `REGION_TERMS is not
// defined` — a move is not a contiguous range, it is the set of bindings whose
// readers moved with them. `KNOWN_DISTRICTS` and `ORG_UNITS` are already
// imported at the head of this file.
/** The timestamps a record may carry, newest-field-wins, as in `SORT_FIELDS`. */
const TIME_FIELDS = Object.freeze(['occurred_at', 'observed_at', 'created_at', 'sent_at', 'trained_at', 'generated_at', 'updated_at'])

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The district and country names a question may name, longest first so a
 * multi-word name is matched before a word inside it.
 *
 * Country *codes* are deliberately absent. `SO` is Somalia and also the English
 * word "so"; a two-letter code matched by word boundary is a filter that fires
 * on prose. Countries are matched by name, districts by name and slug, and the
 * synonym table (`ORG_UNIT_SYNONYMS`) is consulted so `moroto` resolves to
 * Karamoja here exactly as it does in every other resolution path.
 */
const REGION_TERMS = (() => {
  const terms = []
  for (const district of KNOWN_DISTRICTS) {
    const region = { kind: 'district', slug: district.slug, name: district.name, country: district.country }
    terms.push({ phrase: district.name.toLowerCase(), region })
    terms.push({ phrase: district.slug.toLowerCase(), region })
  }
  for (const unit of ORG_UNITS) {
    if (unit.level !== 1) continue
    terms.push({ phrase: unit.name.toLowerCase(), region: { kind: 'country', code: unit.code, name: unit.name } })
  }
  for (const [alias, code] of Object.entries(ORG_UNIT_SYNONYMS)) {
    const unit = ORG_UNITS.find((u) => u.code === code)
    if (!unit) continue
    terms.push({ phrase: alias, region: { kind: 'district', slug: unit.slug, name: unit.name, country: unit.country } })
  }
  const seen = new Set()
  return terms
    .filter((term) => {
      if (seen.has(term.phrase)) return false
      seen.add(term.phrase)
      return true
    })
    .sort((a, b) => b.phrase.length - a.phrase.length)
})()

/** A refusal, as data. Never thrown: a question that cannot be grounded is an answer. */
function refuse(code, reason, extra = {}) {
  return { status: 'refused', code, reason, ...extra }
}

/**
 * Normalise a question into the form the vocabulary is matched against.
 *
 * Hyphens become spaces so `flood-threshold` and `flood threshold` are one
 * term; apostrophes are dropped so "what's" is "whats"; whitespace collapses.
 * Nothing is stemmed and nothing is fuzzy-matched — a vocabulary that guesses
 * is a vocabulary whose misses are silent, which is the failure this module
 * exists to prevent.
 */
function normalise(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const phrasePattern = (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`)

/**
 * Every district or country the question names.
 *
 * A phrase matched by name *and* slug is one region, deduped on the resolved
 * identity rather than the phrase, so `Turkana`/`turkana` does not read as two.
 */
function findRegions(text) {
  const found = []
  const seen = new Set()
  for (const term of REGION_TERMS) {
    if (!phrasePattern(term.phrase).test(text)) continue
    const key = JSON.stringify(term.region)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(term.region)
  }
  return found
}

/** The subject the question is about, or a refusal when none is carried or two are. */
function findSubject(text) {
  const matches = []
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    for (const phrase of subject.phrases) {
      if (phrasePattern(phrase).test(text)) matches.push({ key, subject, length: phrase.length })
    }
  }
  if (!matches.length) return refuse('unknown_subject', 'the question names no subject this layer answers about; the vocabulary carries: ' + Object.keys(SUBJECTS).join(', '))
  matches.sort((a, b) => b.length - a.length)
  const longest = matches[0]
  const tied = matches.filter((m) => m.length === longest.length && m.key !== longest.key)
  if (tied.length) {
    return refuse('unknown_subject', `the question matches two subjects equally (${[longest.key, ...tied.map((t) => t.key)].join(', ')}); name one`)
  }
  return { status: 'matched', key: longest.key, subject: longest.subject }
}

/**
 * The declared default window, stamped `assumed`.
 *
 * The single spelling of "no window was named", because there are two callers
 * and a second copy would be a second thing to keep in step: `findWindow` falls
 * back to it, and so does `parseQueryWithModel` when Needle proposes no window.
 */
function defaultWindow() {
  const fallback = WINDOWS.find((w) => w.key === DEFAULT_WINDOW)
  return { ...fallback, assumed: true }
}

/** The window the question names, or the declared default, stamped `assumed`. */
function findWindow(text) {
  const phrases = []
  for (const window of WINDOWS) for (const phrase of window.phrases) phrases.push({ window, phrase })
  phrases.sort((a, b) => b.phrase.length - a.phrase.length)
  for (const { window, phrase } of phrases) {
    if (phrasePattern(phrase).test(text)) return { ...window, assumed: false }
  }
  return defaultWindow()
}

/** The predicates the question names. */
function findPredicates(text) {
  const found = []
  for (const [key, predicate] of Object.entries(PREDICATES)) {
    if (predicate.phrases.some((phrase) => phrasePattern(phrase).test(text))) found.push(key)
  }
  return found
}

/** An explicit numeric threshold — "above 70" — else null for the declared default. */
function findThreshold(text) {
  const match = text.match(/\b(?:above|over|exceeds?|at least)\s+(\d+(?:\.\d+)?)\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Turn a question into a structured query, or a refusal naming the term it
 * could not ground.
 *
 * This is the whole parser. It reads a declared vocabulary and nothing else;
 * there is no model here to interpret a question it was not built for, which is
 * why an unrecognised subject is a refusal rather than a best-effort guess.
 */
export function parseQuery(question, { now = new Date().toISOString() } = {}) {
  const raw = String(question ?? '').trim()
  if (!raw) return refuse('no_question', 'the question is empty; there is nothing to answer')
  const text = normalise(raw)

  const regions = findRegions(text)
  if (regions.length > 1) {
    return refuse('ambiguous_region', `the question names ${regions.length} regions (${regions.map((r) => r.name).join(', ')}); this layer answers about one at a time`)
  }

  const subject = findSubject(text)
  if (subject.status === 'refused') return subject

  const window = findWindow(text)
  const predicates = findPredicates(text)
  const threshold = findThreshold(text)

  return {
    status: 'parsed',
    question: raw,
    subject: subject.key,
    subject_label: subject.subject.label,
    region: regions[0] ?? null,
    window,
    predicates,
    threshold,
    now,
  }
}

/**
 * Parse a question, falling back to the Needle sidecar when the declared
 * vocabulary does not carry a subject.
 *
 * The deterministic parse runs first and its answer wins whenever it succeeds —
 * the model is not consulted for a question the vocabulary already grounds, so
 * its cost is paid only on the questions that would otherwise refuse. When the
 * parse refuses with `unknown_subject` *and* Needle is configured, Needle is
 * asked to propose the slots; its proposal is validated against the same
 * vocabulary by `src/needle.js` before it is used here.
 *
 * Two properties this keeps, and the reason it is written this way:
 *
 * 1. **Needle never invents a subject.** `proposeSlots` accepts a subject only
 *    from `SUBJECTS`, so a proposal that survives carries a key this module
 *    already knows. The `subject_label` is read off the vocabulary here, not
 *    taken from the model, so the label cannot drift from the subject.
 * 2. **Off, unreachable, or unconfident is the deterministic refusal.** Every
 *    failure of the model path returns the original refusal unchanged, so a
 *    deployment with no sidecar behaves exactly as one that never had this
 *    function — which is what makes the fallback safe to ship enabled.
 *
 * The returned object is the same shape `parseQuery` returns, with
 * `proposed_by: 'needle'` added so a caller can tell a model-assisted parse from
 * a deterministic one. Nothing downstream branches on it; it is there to be
 * audited.
 */
export async function parseQueryWithModel(question, {
  now = new Date().toISOString(), needle = null, env = process.env, http = undefined,
} = {}) {
  const parsed = parseQuery(question, { now })
  if (parsed.status === 'parsed' || parsed.code !== 'unknown_subject') return parsed

  const { proposeSlots } = await import('./needle.js')
  const proposal = await proposeSlots(question, http === undefined ? { env, needle } : { env, needle, http })
  if (proposal.status !== 'proposed') {
    return { ...parsed, needle: { code: proposal.code, reason: proposal.reason } }
  }

  const subject = SUBJECTS[proposal.subject]
  // `proposeSlots` already refused an unknown subject, so this is a guard against
  // the vocabulary changing between the two reads rather than a live branch.
  if (!subject) return { ...parsed, needle: { code: 'unknown_subject', reason: `'${proposal.subject}' is not a subject this layer carries` } }

  // The window is resolved to the vocabulary's own entry, so a proposal naming a
  // real window key carries that window's phrases and `assumed: false`.
  //
  // A proposal naming none takes the same declared default `findWindow` falls
  // back to — NOT `parsed.window`. This path is only reached when `parseQuery`
  // *refused*, and a refusal carries no window, so inheriting from it produced
  // `window: undefined` and the first `query.window.days` downstream threw a
  // TypeError out of `renderAnswer`. The route has no try/catch there, so a
  // question Needle widened into a windowed subject answered 500 instead of
  // 200-with-a-refusal. `defaultWindow()` is the one spelling of that fallback.
  const window = proposal.window
    ? { ...WINDOWS.find((w) => w.key === proposal.window), assumed: false }
    : defaultWindow()

  return {
    status: 'parsed',
    question: String(question ?? ''),
    subject: proposal.subject,
    subject_label: subject.label,
    region: proposal.region ? (resolveDistrict(proposal.region) ?? null) : null,
    window,
    predicates: proposal.predicates,
    threshold: proposal.threshold,
    now,
    proposed_by: 'needle',
    needle: { confidence: proposal.confidence, slots_validated: proposal.slots_validated },
  }
}

/** The district or country a record belongs to, or null when it names none. */
function recordRegion(record, data) {
  if (!record || typeof record !== 'object') return null
  const names = [
    record.region_name,
    record.district,
    record.region,
    record.location?.name,
    record.location?.admin1,
    record.admin1,
  ]
  for (const name of names) {
    const district = resolveDistrict(name)
    if (district) return { slug: district.slug, name: district.name, country: district.country }
  }
  // A dispatch is about wherever its alert was. The alert carries the location
  // resolved at the moment it fired; the dispatch carries only the id, so the
  // join is the only way to place it.
  if (record.alert_event_id && Array.isArray(data?.alert_events)) {
    const alert = data.alert_events.find((a) => a.id === record.alert_event_id)
    if (alert) return recordRegion(alert, data)
  }
  // A population row is keyed by hazard, so it is about wherever that hazard is.
  if (record.hazard_event_id && Array.isArray(data?.hazard_events)) {
    const hazard = data.hazard_events.find((h) => h.id === record.hazard_event_id)
    if (hazard) return recordRegion(hazard, data)
  }
  if (record.country) return { slug: null, name: record.country, country: String(record.country).toUpperCase() }
  return null
}

function regionMatches(recordRegionValue, queryRegion) {
  if (!recordRegionValue || !queryRegion) return false
  if (queryRegion.kind === 'district') return recordRegionValue.slug === queryRegion.slug
  if (queryRegion.kind === 'country') return recordRegionValue.country != null && recordRegionValue.country === queryRegion.code
  return false
}

/** The timestamp a record carries, newest-field-wins, or null when it carries none. */
function recordTime(record) {
  for (const field of TIME_FIELDS) {
    const parsed = Date.parse(record?.[field] ?? '')
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Whether a record falls in the window.
 *
 * An undated record is *not* in any window. It is not "in" by default: a record
 * whose time is unknown cannot be placed in a period, and treating the absence
 * as a pass would put an undatable record into every window a caller asks
 * about. `days: null` is "all time" and admits everything, dated or not.
 */
function inWindow(time, window, now) {
  if (!window || window.days === null) return true
  if (time === null) return false
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return false
  const from = nowMs - window.days * 86400000
  return time >= from && time <= nowMs + 60000
}

/** The months of archive series the store holds for a region, for a model floor. */
function observedForModel(region, data) {
  const series = (data?.climate_observations || []).filter((record) => record.source === 'open_meteo_archive'
    && (!region || regionMatches(recordRegion(record, data), region)))
  if (!series.length) return { months: null, events: null, coverage: null }
  const months = new Set()
  for (const record of series) for (const day of record.daily || []) months.add(String(day.date).slice(0, 7))
  // Only the months floor is read here. The event floor needs the radius match
  // the model does, and guessing it would be a second, unaudited reading path;
  // `floorsMissed` reports an unsupplied floor as unverified rather than met.
  return { months: months.size, events: null, coverage: null }
}

/**
 * A model's answer, or the model's own refusal.
 *
 * When a trained fit exists for the region, the answer carries its facts. When
 * it does not, the answer is the model's refusal *sentence* read from the
 * registry — not a sentence written here — with the floors the store's own
 * counts miss, so the surface that shows a number and the surface that shows
 * why there is none read the same words.
 */
function runModelQuery(query, data) {
  const subject = SUBJECTS[query.subject]
  const source = (data[subject.collection] || [])
  // The same guard `runQuery` applies, for the same reason: `m.model` on a
  // non-record throws, and a model subject is a `collectionPage` read like any
  // other.
  const malformed = source.filter((m) => !m || typeof m !== 'object' || Array.isArray(m)).length
  if (malformed) {
    return refuse('unreadable_record', `the store's ${subject.collection} collection holds ${malformed} of ${source.length} entries that are not records, so the model floor cannot be read over the rest`)
  }
  const region = query.region
  if (!region) {
    const regions = [...new Set(source.filter((m) => m.model).map((m) => m.region_name))]
    return refuse('ambiguous_region', regions.length
      ? `the store holds trained flood-probability models for ${regions.length} regions (${regions.join(', ')}); name one`
      : 'the question asks for a flood probability without naming a district, and the store holds no trained model to answer for')
  }

  const trained = source.filter((m) => m.model && regionMatches(recordRegion(m, data), region))
  if (trained.length) {
    const record = trained[0]
    const resolved = recordRegion(record, data)
    const values = {}
    const facts = []
    for (const [field, value] of subject.factsOf(record)) {
      if (value === undefined || value === null) continue
      values[field] = value
      facts.push(fact(query.subject, resolved?.name ?? null, field, value, subject.collection))
    }
    facts.push(fact('query', null, 'records_read', source.length, subject.collection))
    return { status: 'resolved', facts, regions: [{ name: resolved?.name ?? region.name, values }], source_count: source.length }
  }

  const observed = observedForModel(region, data)
  const floors = floorsMissed(subject.model, observed)
  const sentence = refusalSentence(subject.model)
  // The unmet floor with a real count, in the model's own terms. The registry's
  // `floorsMissed` returns one entry per floor, including the two this layer
  // cannot observe (`events`, `coverage`), and those are reported as unverified
  // rather than met — an unsupplied count has not shown the floor is passed.
  const missed = floors.filter((f) => f.observed !== null)
  const unverified = floors.filter((f) => f.observed === null)
  const floorText = missed.length
    ? `The counts miss: ${missed.map((f) => `${f.observed} of the required ${f.required} ${f.floor}`).join('; ')}.`
    : unverified.length
      ? `The store carries no counts for ${unverified.map((f) => f.floor).join(' or ')}, so those floors are unverified rather than met.`
      : ''
  return refuse('model_refusal', floorText ? `${sentence} ${floorText}` : sentence, {
    refusal: { model: subject.model, sentence, floors, region: region.name },
  })
}

/** One fact: a value this layer read, with where it read it from. */
function fact(subject, region, field, value, source) {
  return {
    id: `${subject}:${region ?? '-'}:${field}`,
    subject,
    region,
    field,
    value,
    source,
  }
}

/**
 * Resolve a parsed query against the store, collecting the facts it read.
 *
 * Returns either `{ status: 'resolved', facts, regions, source_count }` or a
 * refusal. Every refusal here is a state where an answer would have to invent
 * something: no collection to read, a subject with no field to threshold, or an
 * absence that cannot be told from a gap.
 */
export function runQuery(query, data = {}) {
  const subject = SUBJECTS[query.subject]
  if (!subject) return refuse('unknown_subject', `'${query.subject}' is not a subject this layer carries`)
  if (subject.model) return runModelQuery(query, data)

  const rows = data[subject.collection]
  if (!Array.isArray(rows) || !rows.length) {
    return refuse('no_data', `the store holds no ${subject.collection} records, so there is nothing to answer from`)
  }
  // A collection can carry an entry that is not a record — a `null` in a
  // hand-edited JSON store, which Postgres's `body JSONB NOT NULL` admits as the
  // JSON value `null` and whose write-time `assertRecordsNamed` only sees on the
  // path that wrote it. Every predicate below dereferences a record, so one such
  // entry threw a TypeError out of the route: a 500 where this module promises a
  // 200. Skipping it silently would be worse, because the answer's counts state
  // what was read — a row dropped without a word turns "no match" into a claim
  // about a collection nobody fully looked at. So it is a refusal that names the
  // count, in the same voice as `unmeasured`.
  const malformed = rows.filter((r) => !r || typeof r !== 'object' || Array.isArray(r)).length
  if (malformed) {
    return refuse('unreadable_record', `the store's ${subject.collection} collection holds ${malformed} of ${rows.length} entries that are not records, so a count over it would describe the readable ones and say nothing about the rest`)
  }
  const source = subject.filter ? rows.filter(subject.filter) : rows
  if (!source.length) {
    return refuse('no_data', `the store holds no ${subject.label} records (the ${subject.collection} collection is present but carries none of this type)`)
  }

  let matches = source
  if (query.region) matches = matches.filter((r) => regionMatches(recordRegion(r, data), query.region))
  if (subject.windowed) matches = matches.filter((r) => inWindow(recordTime(r), query.window, query.now))

  if (query.predicates.includes('above_threshold')) {
    if (!subject.valueField) {
      return refuse('unknown_field', `'${subject.label}' carries no threshold to cross, so the question asked for a field this subject does not have`)
    }
    const threshold = query.threshold ?? NL_FLOOD_THRESHOLD_SCORE
    // `numericOrNull`, not `Number.isFinite(Number(x))`. The coercion turns
    // "this district has no score" into a score: `Number(null)` and `Number('')`
    // are 0, and `Number(true)` is 1, `Number([90])` is 90. Below a threshold of
    // 60 those fail the comparison and the district is dropped, so the answer's
    // count is right for the wrong reason — but a question that asks "at or
    // above 0" matches every record whose score is merely absent, and reports it
    // as a district that crossed. Measured before the fix: with the default
    // threshold, `score: [90]` matched as 90 — a number nobody wrote in that
    // field — and `score: null` matched every threshold at or below zero.
    matches = matches.filter((r) => {
      const score = numericOrNull(r[subject.valueField])
      return score !== null && score >= threshold
    })
  }

  if (query.predicates.includes('no_dispatch')) {
    const dispatches = data.rapidpro_dispatches
    // An absence is only evidence of absence when the store records the thing
    // at all. A deployment that records no dispatches returns an empty
    // collection, and reporting "no dispatch" for every district would turn a
    // missing feed into a finding.
    if (!Array.isArray(dispatches) || !dispatches.length) {
      return refuse('unmeasured', 'the store holds no dispatch records, so "no dispatch" cannot be told apart from dispatches that were never recorded')
    }
    const dispatched = new Set(dispatches
      .filter((d) => inWindow(recordTime(d), query.window, query.now))
      .map((d) => recordRegion(d, data)?.slug)
      .filter(Boolean))
    matches = matches.filter((r) => !dispatched.has(recordRegion(r, data)?.slug))
  }

  const facts = []
  const regions = []
  for (const record of matches) {
    const resolved = recordRegion(record, data)
    const name = resolved?.name ?? record.region_name ?? null
    const values = {}
    for (const [field, value] of subject.factsOf(record)) {
      if (value === undefined || value === null) continue
      values[field] = value
      facts.push(fact(query.subject, name, field, value, subject.collection))
    }
    if (query.predicates.includes('no_dispatch')) {
      values.dispatches_in_window = 0
      facts.push(fact('dispatches', name, 'dispatches_in_window', 0, 'rapidpro_dispatches'))
    }
    regions.push({ name: name ?? '(no district recorded)', values })
  }

  // The query's own parameters are facts too: the count of matches, the count
  // of records read, the window length and the threshold are all numbers the
  // sentence may write, so they must be in the fact set before it may.
  facts.push(fact('query', null, 'matched_regions', regions.length, subject.collection))
  facts.push(fact('query', null, 'records_read', source.length, subject.collection))
  if (query.window.days !== null) facts.push(fact('query', null, 'window_days', query.window.days, 'query'))
  if (query.predicates.includes('above_threshold')) {
    facts.push(fact('query', null, 'threshold', query.threshold ?? NL_FLOOD_THRESHOLD_SCORE, 'query'))
  }
  if (query.region) facts.push(fact('query', null, 'region', query.region.name, 'query'))

  return { status: 'resolved', facts, regions, source_count: source.length }
}

/** The criteria the answer states, as prose built only from the parsed query. */
function describeCriteria(query) {
  const bits = []
  if (query.predicates.includes('above_threshold')) {
    bits.push(`${query.subject_label} score at or above ${query.threshold ?? NL_FLOOD_THRESHOLD_SCORE}`)
  } else {
    bits.push(query.subject_label)
  }
  if (query.predicates.includes('no_dispatch')) bits.push('with no dispatch')
  if (query.region) bits.push(`in ${query.region.name}`)
  return bits.join(', ')
}

/**
 * Render the answer from the facts, and only from the facts.
 *
 * Every number this function writes is a value `runQuery` retrieved: the match
 * count, the record count, the window length, the threshold, and the per-region
 * values. `auditAnswer` checks that claim before the sentence is returned, so a
 * change here that introduced a figure the facts do not contain would be a
 * refusal, not a published number.
 */
export function renderAnswer(query, resolved) {
  const { regions, source_count: sourceCount } = resolved
  const windowClause = query.subject === 'flood_probability'
    ? ''
    : (SUBJECTS[query.subject].windowed || query.predicates.includes('no_dispatch'))
      ? ` in ${query.window.label}`
      : ''
  const criteria = describeCriteria(query)

  if (!regions.length) {
    return `No ${query.subject_label} record matches ${criteria}${windowClause}. ${sourceCount} record(s) were read.`
  }

  const parts = regions.map((region) => {
    const values = Object.entries(region.values)
      .map(([field, value]) => `${field.replaceAll('_', ' ')} ${value}`)
      .join(', ')
    return `${region.name}${values ? ` (${values})` : ''}`
  })
  const latest = SUBJECTS[query.subject].windowed
    ? ''
    : ' These are the latest stored values per district, not a within-window reading.'
  return `${regions.length} of ${sourceCount} ${query.subject_label} record(s) match ${criteria}${windowClause}: ${parts.join('; ')}.${latest}`
}

/**
 * Audit a rendered sentence against the fact set it claims to restate.
 *
 * The same rule `narrator.js` applies to generated prose: a digit token is a
 * claim, and a claim whose value is not in the fact set is an invention. Word
 * numbers ("two", "several") are prose and are not figures; a digit is.
 */
export function auditAnswer(text, facts) {
  const allowed = new Set()
  for (const item of facts) {
    for (const token of String(item.value ?? '').match(/\d+(?:\.\d+)?/g) || []) allowed.add(token.replace(/,/g, ''))
  }
  const found = (String(text ?? '').match(/\d+(?:\.\d+)?/g) || []).map((token) => token.replace(/,/g, ''))
  const invented = found.filter((token) => !allowed.has(token))
  return { ok: invented.length === 0, invented: [...new Set(invented)], numbers_checked: found.length }
}

/**
 * Resolve a parsed query, render it, and audit the sentence before returning it.
 *
 * The tail every entry point shares. It is split out rather than duplicated
 * because the audit is the module's whole claim: a second copy of this function
 * is a second place the audit can be forgotten, and a caller that skipped it
 * would publish a sentence no fact set backs.
 */
function finishAnswer(question, parsed, data, options, now) {
  if (parsed.status === 'refused') return refusedResult(question, parsed, null, now)

  const resolved = runQuery(parsed, data)
  if (resolved.status === 'refused') return refusedResult(question, resolved, parsed, now)

  const text = (options.render || renderAnswer)(parsed, resolved)
  const audit = auditAnswer(text, resolved.facts)
  if (!audit.ok) {
    return refusedResult(question, refuse('invented_figure', `the answer cited a figure its ${resolved.facts.length} facts do not contain: ${audit.invented.join(', ')}`), parsed, now)
  }

  return {
    status: 'answered',
    question: String(question ?? ''),
    query: parsed,
    facts: resolved.facts,
    text,
    numbers_checked: audit.numbers_checked,
    basis: NL_QUERY_BASIS,
    answered_at: now,
  }
}

/**
 * Answer a question, grounded, or refuse it.
 *
 * `options.render` exists so a test can inject a sentence and watch the audit
 * refuse it — the enforcement path is exercised, not asserted about. `now` is
 * injectable so a window is reproducible.
 *
 * Synchronous, and it stays synchronous: the deterministic parser is the whole
 * path here, so a caller that wants the model-assisted parse asks for it by name
 * (`answerQueryWithModel`). Reaching for the network from a function that reads
 * as pure is how a route ends up waiting on a sidecar it never meant to call.
 */
export function answerQuery(question, data = {}, options = {}) {
  const now = options.now ?? new Date().toISOString()
  return finishAnswer(question, parseQuery(question, { now }), data, options, now)
}

/**
 * Answer a question, widening recall with the Needle sidecar when the declared
 * vocabulary does not carry the subject.
 *
 * The disposal is identical to `answerQuery`'s — the same `finishAnswer` runs the
 * same resolve, render and audit — so a model-proposed subject is held to the
 * same grounding rule as a deterministically parsed one. That is the property
 * that makes the model safe to enable: it may widen which questions parse, and
 * it may not put a number in the answer that the facts do not contain.
 *
 * `options.parse` mirrors `options.render`: a test injects a parse (a
 * model-shaped one, or a broken one) and watches the audit act on what it
 * produced. With Needle off, unreachable or unconfident, `parseQueryWithModel`
 * returns the deterministic refusal byte-identical, so this function is
 * `answerQuery` plus a network call that did not happen.
 */
export async function answerQueryWithModel(question, data = {}, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const parse = options.parse || parseQueryWithModel
  const parsed = await parse(question, {
    now,
    needle: options.needle ?? null,
    env: options.env ?? process.env,
    http: options.http,
  })
  return finishAnswer(question, parsed, data, options, now)
}

function refusedResult(question, refusal, query, now) {
  return {
    status: 'refused',
    question: String(question ?? ''),
    query,
    code: refusal.code,
    reason: refusal.reason,
    text: refusal.code === 'model_refusal' ? refusal.reason : null,
    refusal: refusal.refusal ?? null,
    facts: refusal.facts ?? [],
    basis: NL_QUERY_BASIS,
    answered_at: now,
  }
}
