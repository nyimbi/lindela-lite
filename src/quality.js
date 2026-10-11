/**
 * ENH-44 — submission quality gates.
 *
 * The field-report path already has a coordinate guard: a missing fix is stored
 * as `null` with a `location_source` rather than as Null Island. That guard
 * answers one question — "is there a location?" — and a coordinator reading a
 * queue of reports needs a second one: "how much should I trust this one?" A
 * report with a 2 km fix, a device clock a day fast and a near-identical twin
 * filed an hour earlier is not the same evidence as a 12 m fix filed once, and
 * today the two are indistinguishable rows.
 *
 * The verdict is *carried*, never applied. Nothing here drops a record, refuses
 * a submission, or reorders a queue: a health worker who filed a report has
 * filed it, and a gate that silently discards a disease signal is worse than the
 * noise it removes. What changes is that the doubt travels with the record
 * instead of being reconstructed by whoever reads it later, from fields that do
 * not say what they mean.
 *
 * Three axes, each assessed on its own and each able to be *unassessable*:
 *
 *   accuracy   — the GPS fix radius, banded. `null` is `unknown`, not `precise`
 *                and not `unusable`: a report with no fix has told us nothing
 *                about its accuracy, and folding that into either end of the
 *                scale is the falsy-zero defect this repo keeps paying for.
 *   skew       — the gap between when the phone captured the report and when the
 *                server received it. A large *positive* gap is not a defect: it
 *                is what an offline queue produces, and calling it clock drift
 *                would flag every report filed from a village with no signal.
 *                A *negative* gap is a defect — the phone's clock is ahead of
 *                the server's, so the report claims a capture time that has not
 *                happened.
 *   duplicates — near-identical reports already in the store, matched on
 *                category, wording and time, tightened by distance when both
 *                records have a fix.
 *
 * The grade is the *weakest measured* axis, because a chain of evidence is as
 * strong as its weakest link. Duplicates are a penalty on top of that rather
 * than an axis in it — finding none is the absence of a bad sign, not evidence
 * of a good one. The payload names which axes were assessed, so a reader can
 * tell a low grade from an unmeasured one, and a report with nothing measurable
 * grades `unassessable` rather than passing by default.
 *
 * Determinism: nothing here reads a clock. `received_at` is passed in, so the
 * same record and the same candidates produce the same verdict forever.
 */

import { haversineKm, toNumber } from './utils.js'

/** The accuracy bands, weakest-last. Frozen and iterable; consumers assert against it. */
export const ACCURACY_BANDS = Object.freeze(['precise', 'usable', 'coarse', 'unusable', 'unknown'])

/** The skew verdicts. `queued` is not a defect; `clock_ahead` is. */
export const SKEW_VERDICTS = Object.freeze(['ok', 'queued', 'clock_ahead', 'unknown'])

/** The grades, weakest-last. `unassessable` is not a grade — it is the absence of one. */
export const QUALITY_GRADES = Object.freeze(['high', 'medium', 'low', 'unassessable'])

/**
 * The band edges, in metres, and the tolerance in seconds.
 *
 * Exported because a coordinator weighting a queue by accuracy needs to know
 * where the lines are, and because a threshold written into a branch is a
 * threshold nobody can cite.
 */
export const ACCURACY_BANDS_M = Object.freeze({
  precise: 50,
  usable: 250,
  coarse: 2000,
})

export const SKEW_TOLERANCE_S = Object.freeze({
  // Either side of zero, a few seconds is a network round trip and a clock that
  // is merely not synchronised to the millisecond.
  ok: 300,
  // A capture time further ahead of receipt than this is not a round trip. It is
  // a phone whose clock is wrong, and the report claims a moment that has not
  // happened yet.
  ahead: 300,
})

/** The default near-duplicate window and radius. */
export const DUPLICATE_DEFAULTS = Object.freeze({
  radiusKm: 2,
  windowHours: 24,
  similarity: 0.6,
})

/**
 * Weakest-last. `unassessable` ranks below `low` on purpose: a pile holding one
 * report nobody could measure is a pile nobody can vouch for, and ranking it
 * above `low` would let an unmeasured report disappear into a healthy tally.
 */
const RANK = Object.freeze({ high: 1, medium: 2, low: 3, unassessable: 4 })

/** Words that carry no signal about *which* report this is. */
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'has', 'have', 'was', 'were', 'are', 'not', 'but', 'his', 'her', 'its', 'our', 'their'])

function bandFor(metres) {
  if (metres <= ACCURACY_BANDS_M.precise) return 'precise'
  if (metres <= ACCURACY_BANDS_M.usable) return 'usable'
  if (metres <= ACCURACY_BANDS_M.coarse) return 'coarse'
  return 'unusable'
}

/**
 * Band a GPS fix radius.
 *
 * `null`, `undefined`, `''` and a negative radius are all `unknown`. A negative
 * radius is not a very precise fix — it is a value no GPS produced, and reading
 * it as `precise` because it is small is the whole failure mode this function
 * exists to prevent. Zero is a real radius (some devices report it) and is
 * banded as `precise`.
 *
 * @param {unknown} metres
 * @returns {{band: string, metres: number|null, note: string}}
 */
export function assessAccuracy(metres) {
  const value = toNumber(metres)
  if (value === null || value < 0) {
    return {
      band: 'unknown',
      metres: null,
      note: value === null
        ? 'no accuracy was reported with the fix, so the fix is unbanded'
        : `an accuracy of ${value} m is not a radius any receiver reports, so it is treated as unreported`,
    }
  }
  const band = bandFor(value)
  const note = band === 'precise'
    ? `a ${value} m fix is precise enough to place the report at a household`
    : band === 'usable'
      ? `a ${value} m fix places the report in the right settlement`
      : band === 'coarse'
        ? `a ${value} m fix places the report in the right district at best`
        : `a ${value} m fix is wider than the settlements it is meant to distinguish`
  return { band, metres: value, note }
}

/**
 * The clock skew in seconds: capture minus receipt.
 *
 * Negative means the report was captured *before* it arrived, which is what the
 * offline queue produces. Positive means the phone's clock is ahead of the
 * server's. The sign is the whole point of the function, so it is written once
 * here rather than reconstructed at each branch.
 */
function secondsBetween(captured, received) {
  const a = Date.parse(captured)
  const b = Date.parse(received)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return (a - b) / 1000
}

/**
 * Compare when the phone captured a report with when the server received it.
 *
 * The sign is the whole point, and it is the sign the naive version gets wrong.
 * `captured_at - received_at` is *negative* for an offline report, which is the
 * normal case for the population this platform serves; a check written as
 * `Math.abs(skew) > tolerance` flags every queued report as a clock problem and
 * trains an operator to ignore the field. So:
 *
 *   queued       captured before receipt by more than the tolerance. Expected
 *                from the offline queue, and the seconds are reported so a
 *                coordinator can tell an hour from a fortnight.
 *   clock_ahead  captured *after* receipt. No queue produces this; the phone's
 *                clock is wrong and the record claims a future moment.
 *   ok           within the tolerance either way.
 *   unknown      either timestamp is missing or unparseable. An unparseable
 *                timestamp is not "no skew" — it is no evidence.
 *
 * @returns {{verdict: string, seconds: number|null, note: string}}
 */
export function assessSkew({ captured_at = null, received_at = null } = {}) {
  const seconds = secondsBetween(captured_at, received_at)
  if (seconds === null) {
    const missing = captured_at === null || captured_at === undefined || captured_at === ''
      ? 'the client sent no capture time, so the transport delay is unmeasured'
      : 'the capture time could not be parsed, so the transport delay is unmeasured'
    return { verdict: 'unknown', seconds: null, note: missing }
  }
  if (seconds > SKEW_TOLERANCE_S.ahead) {
    return {
      verdict: 'clock_ahead',
      seconds,
      note: `the report claims to have been captured ${Math.round(seconds)} s after it arrived, which no transport delay produces; the device clock is ahead of the server's`,
    }
  }
  if (seconds < -SKEW_TOLERANCE_S.ok) {
    return {
      verdict: 'queued',
      seconds,
      note: `the report was captured ${Math.round(-seconds)} s before it arrived, which is what the offline queue produces rather than a defect`,
    }
  }
  return { verdict: 'ok', seconds, note: 'capture and receipt are within a network round trip of each other' }
}

/** Lowercase word tokens of three or more characters, stopwords removed. */
function tokens(text) {
  if (typeof text !== 'string') return new Set()
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))
}

/** Jaccard similarity of two token sets. Two empty sets are not similar — they are both empty. */
export function summarySimilarity(a, b) {
  const left = tokens(a)
  const right = tokens(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

const observedAt = (record) => record.observed_at || record.created_at || null

/**
 * Reports already in the store that look like this one.
 *
 * Matched on category, wording and time. Distance *tightens* a match when both
 * records carry a fix and is silent when either does not — a record with no
 * coordinates is not "far away", it is unlocated, and treating the missing
 * distance as a large one would let a double submission through on exactly the
 * phones least able to place themselves.
 *
 * Each match names the evidence that carried it, so a coordinator can judge the
 * claim rather than the verdict.
 *
 * @param {object} record the submission under assessment
 * @param {object[]} candidates records already in the store
 * @param {{radiusKm?: number, windowHours?: number, similarity?: number}} [options]
 * @returns {object[]} matches, nearest first
 */
export function findNearDuplicates(record, candidates = [], options = {}) {
  const { radiusKm, windowHours, similarity } = { ...DUPLICATE_DEFAULTS, ...options }
  const at = observedAt(record)
  const atMs = at ? Date.parse(at) : NaN
  if (!Number.isFinite(atMs)) return []

  const matches = []
  for (const candidate of candidates || []) {
    if (!candidate || candidate.deleted_at) continue
    if (candidate.id && candidate.id === record.id) continue
    if ((candidate.category ?? null) !== (record.category ?? null)) continue

    const candidateAt = observedAt(candidate)
    const candidateMs = candidateAt ? Date.parse(candidateAt) : NaN
    if (!Number.isFinite(candidateMs)) continue
    const hoursApart = Math.abs(candidateMs - atMs) / 3_600_000
    if (hoursApart > windowHours) continue

    const score = summarySimilarity(record.summary, candidate.summary)
    if (score < similarity) continue

    const evidence = [`the same category (${record.category ?? 'none'})`, `wording ${(score * 100).toFixed(0)}% alike`, `${hoursApart.toFixed(1)} h apart`]

    const bothLocated = Number.isFinite(toNumber(record.latitude)) && Number.isFinite(toNumber(record.longitude))
      && Number.isFinite(toNumber(candidate.latitude)) && Number.isFinite(toNumber(candidate.longitude))
    let distanceKm = null
    if (bothLocated) {
      distanceKm = haversineKm(
        { latitude: toNumber(record.latitude), longitude: toNumber(record.longitude) },
        { latitude: toNumber(candidate.latitude), longitude: toNumber(candidate.longitude) },
      )
      if (distanceKm > radiusKm) continue
      evidence.push(`${distanceKm.toFixed(2)} km apart`)
    } else {
      evidence.push('at least one of the two has no fix, so distance is not evidence here')
    }

    matches.push({ id: candidate.id ?? null, distance_km: distanceKm, hours_apart: hoursApart, similarity: score, evidence })
  }

  return matches.sort((a, b) => b.similarity - a.similarity)
}

/**
 * The whole verdict for one submission.
 *
 * The grade is the weakest *assessed* axis. An axis that could not be measured
 * is excluded from the minimum and named in `unassessed`, because including it
 * would require inventing a value for it — and a verdict that quietly assumed
 * `high` for a missing measurement is the defect class this module is part of
 * the fix for. When no axis could be assessed at all the grade is
 * `unassessable`, which is not a passing grade.
 *
 * @param {{record: object, candidates?: object[], received_at: string, options?: object}} input
 * @returns {{grade: string, reasons: string[], assessed: string[], unassessed: string[], accuracy: object, skew: object, duplicates: object[]}}
 */
export function assessSubmissionQuality({ record, candidates = [], received_at, options = {} } = {}) {
  const accuracy = assessAccuracy(record?.location_accuracy_m)
  const skew = assessSkew({ captured_at: record?.captured_at ?? null, received_at })
  const duplicates = findNearDuplicates(record, candidates, options)

  const axes = []
  const reasons = []

  if (accuracy.band !== 'unknown') {
    axes.push(accuracy.band === 'precise' || accuracy.band === 'usable' ? 'high' : accuracy.band === 'coarse' ? 'medium' : 'low')
    if (accuracy.band !== 'precise') reasons.push(`location accuracy is ${accuracy.band}: ${accuracy.note}`)
  } else {
    reasons.push(`location accuracy is unassessable: ${accuracy.note}`)
  }

  if (skew.verdict !== 'unknown') {
    axes.push(skew.verdict === 'ok' ? 'high' : skew.verdict === 'queued' ? 'medium' : 'low')
    if (skew.verdict === 'clock_ahead') reasons.push(`capture time is suspect: ${skew.note}`)
  } else {
    reasons.push(`capture time is unassessable: ${skew.note}`)
  }

  // Duplicates are assessed, but they are a *penalty* rather than an axis in
  // the minimum: finding none is not evidence that a report is good, it is only
  // the absence of one bad sign. Counting an empty duplicate list as a `high`
  // axis is how an empty store hands an unmeasured report a passing grade —
  // the failure the `unassessable` test below pins. So the minimum is taken
  // over the measured axes alone, and a duplicate can only lower the result.
  const measured = axes.reduce((worst, g) => (RANK[g] > RANK[worst] ? g : worst), 'high')
  const grade = duplicates.length ? (RANK.low > RANK[measured] ? 'low' : measured) : measured

  if (duplicates.length) {
    reasons.push(`${duplicates.length} near-duplicate report(s) already in the store, closest ${(duplicates[0].similarity * 100).toFixed(0)}% alike ${duplicates[0].hours_apart.toFixed(1)} h apart`)
  }

  return {
    grade: axes.length ? grade : 'unassessable',
    reasons,
    assessed: [
      ...(accuracy.band !== 'unknown' ? ['accuracy'] : []),
      ...(skew.verdict !== 'unknown' ? ['skew'] : []),
      'duplicates',
    ],
    unassessed: [
      ...(accuracy.band === 'unknown' ? ['accuracy'] : []),
      ...(skew.verdict === 'unknown' ? ['skew'] : []),
    ],
    accuracy,
    skew,
    duplicates,
  }
}

/**
 * Stamp a record with its verdict, without ever refusing it.
 *
 * Both doors into `field_reports` call this — the CHW route writes the
 * collection directly, the operational API goes through `normalizeFieldReport`
 * — and they call *this* rather than `assessSubmissionQuality` so the two
 * cannot drift into two different verdicts on the same report. A gate applied
 * at one door of two is the defect this repo keeps finding; the guard is only
 * a guard if every path passes it.
 *
 * The verdict is attached as `quality` and the record is returned unchanged
 * otherwise. Nothing here can reject a submission: a health worker who filed a
 * report has filed it, and a gate that silently discards a disease signal is
 * worse than the noise it removes. The doubt travels with the record instead.
 *
 * @param {object} record the record about to be stored
 * @param {{candidates?: object[], received_at: string, options?: object}} input
 * @returns {object} the record with `quality` set
 */
export function stampQuality(record, { candidates = [], received_at, options = {} } = {}) {
  return { ...record, quality: assessSubmissionQuality({ record, candidates, received_at, options }) }
}

/**
 * The verdict for a queue of records, so a coordinator can weight the pile.
 *
 * A summary of an empty set reports `unassessable` rather than `high`: nothing
 * was measured, and a clean bill of health for no evidence is the report this
 * whole audit keeps finding.
 */
export function qualityTally(verdicts = []) {
  const rows = (verdicts || []).filter((v) => v && typeof v === 'object')
  const by_grade = {}
  for (const grade of QUALITY_GRADES) by_grade[grade] = 0
  for (const row of rows) {
    const grade = QUALITY_GRADES.includes(row.grade) ? row.grade : 'unassessable'
    by_grade[grade] += 1
  }
  return {
    total: rows.length,
    by_grade,
    // Seeded at `high` so the reduce can only lower it, and an unrecognised
    // grade is read as `unassessable` — the same fold `by_grade` does, so the
    // headline and the counts cannot disagree about a row.
    grade: rows.length
      ? rows.reduce((worst, r) => {
        const grade = QUALITY_GRADES.includes(r.grade) ? r.grade : 'unassessable'
        return RANK[grade] > RANK[worst] ? grade : worst
      }, 'high')
      : 'unassessable',
    duplicates_flagged: rows.filter((r) => Array.isArray(r.duplicates) && r.duplicates.length).length,
  }
}
