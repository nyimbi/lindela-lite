/**
 * ENH-14 — completeness tripwires for capped and paginated sources.
 *
 * The defect this exists for: a connector that returns 40 of 4,000 rows parses
 * cleanly, merges cleanly, and trains a model on 1% of the events with nothing in
 * the run record to say so. GDACS archive caps a query at roughly 100 results,
 * so the connector walks quarter-by-quarter windows — and a quarter that happens
 * to hit the cap looks exactly like a quarter that did not. CHIRPS lists 730
 * daily files and `.slice(0, 30)`s them, so 700 of them vanish with no record
 * that anything was dropped. Both are silent, and both are the same bug: a
 * truncation that leaves no evidence of itself.
 *
 * What the wiring gets (see `src/connectors/gdacs-archive.js` for the consumer):
 *
 *   assessPagination({ pagesFetched, recordsSeen, providerTotal, pageSize,
 *                      lastPageFull, cappedAt, expectedTotal })
 *     → { complete, possibly_incomplete, reason, counts_found }
 *     One verdict for a whole paginated run. `possibly_incomplete` is the
 *     load-bearing one and it is deliberately not `incomplete`: a last page that
 *     came back exactly full means there *may* have been a page after it, which
 *     is a different and much weaker claim than having counted the shortfall.
 *
 *   recordCap({ found, taken, cap, reason })
 *     → { records, counts_found, capped, cap_reason }
 *     For list-and-slice sources (CHIRPS' 30-of-730). `counts_found` is the
 *     number found *before* the cap bound, and it is recorded whether or not
 *     the cap bound — a cap that did not fire is still worth recording, because
 *     "we looked at 30 and there were 30" and "we looked at 730 and kept 30" are
 *     different facts. When nothing was found and no cap bound, `counts_found`
 *     is null: zero found and zero counted are different claims, and ING-08's
 *     failure was a zero that meant the second one.
 *
 *   mergeCompleteness(entries)
 *     → the same shape, one verdict from many per-page assessments. A crawl
 *     needs a verdict at the end, not per page.
 *
 *   COMPLETENESS_VERDICTS — the frozen vocabulary. Iterate it; do not re-type
 *     the strings. This repo's recurring defect is a list written once and
 *     checked nowhere.
 *
 * Determinism: nothing here reads a clock, so the same inputs produce the same
 * output forever. There is no timestamp to inject because there is no
 * timestamp to make flaky — the verdict is a function of page shape alone.
 */

/** The verdict vocabulary. Frozen and iterable; consumers assert against it. */
export const COMPLETENESS_VERDICTS = Object.freeze([
  'complete',
  'possibly_incomplete',
  'incomplete',
])

/**
 * Reason strings are exported because they are part of the contract: a run
 * record is only useful downstream if a human or a check can tell *which* piece
 * of evidence produced the verdict. A single generic "incomplete" is what the
 * old connectors had, and it is indistinguishable from a network failure.
 */
export const REASONS = Object.freeze({
  NO_PAGES: 'no pages were fetched, so there is no page evidence either way',
  PARTIAL_PAGE: 'last page came back partial, so the provider ran out of records before filling it',
  TOTAL_SATISFIED: 'the reported total was met, so a full last page is accounted for and a further page would contradict it',
  TOTAL_SHORTFALL: 'the provider reported a total and fewer records were seen than it reported',
  EXPECTED_SHORTFALL: 'the caller expected more records than were seen, and the provider reported no total to check against',
  // One wording, not two: reaching this branch with a total in hand is
  // impossible, because a met total clears the page earlier. Two constants here
  // would have been one reachable and one dead — the exact defect this repo
  // keeps paying for.
  FULL_PAGE: 'last page came back exactly full, so there may have been another page; the provider reported no total, so this rests on the last-page heuristic alone',
  CAPPED: 'the source cap was reached, so the cap may have truncated the result set',
})

const RANK = Object.freeze({
  complete: 1,
  possibly_incomplete: 2,
  incomplete: 3,
})

function verdictFor(verdict, reason, counts_found) {
  return {
    complete: verdict === 'complete',
    possibly_incomplete: verdict === 'possibly_incomplete',
    reason,
    counts_found,
  }
}

/**
 * A total that is actually a number. `null`, `undefined`, `NaN` and a
 * non-numeric string are all "the provider told us nothing", and 0 is a real
 * total of zero — the falsy-zero case that loses records at exactly the
 * boundary it was written to protect.
 */
function numericTotal(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Assess one paginated run.
 *
 * @param {object} input
 * @param {number} [input.pagesFetched]  how many pages the crawl actually got
 * @param {number} input.recordsSeen     how many records those pages held
 * @param {number|null} [input.providerTotal] a total the provider itself reported, if any
 * @param {number} [input.pageSize]      the page size requested
 * @param {boolean} [input.lastPageFull] whether the last page came back exactly full
 * @param {number|null} [input.cappedAt] a cap the source applies, e.g. GDACS' ~100
 * @param {number|null} [input.expectedTotal] the caller's own expectation, used
 *   when the provider reports nothing. Provider total wins when both are present:
 *   the provider's count is evidence, ours is a guess.
 * @returns {{complete: boolean, possibly_incomplete: boolean, reason: string, counts_found: number}}
 */
export function assessPagination(input = {}) {
  const {
    pagesFetched,
    recordsSeen,
    pageSize,
    lastPageFull,
    cappedAt,
  } = input
  const providerTotal = numericTotal(input.providerTotal)
  const expectedTotal = numericTotal(input.expectedTotal)
  const total = providerTotal ?? expectedTotal

  const seen = Number.isFinite(recordsSeen) ? Math.max(0, Math.trunc(recordsSeen)) : 0
  const cap = numericTotal(cappedAt)

  // Every record we actually saw is counted, including zero. `recordsSeen` is a
  // measurement, not an assertion: zero here means "the pages came back empty",
  // which is a fact worth recording and is nothing like the silent zero that
  // ING-08 was about.
  const counts_found = seen

  if (Number.isFinite(pagesFetched) && pagesFetched === 0) {
    return verdictFor('complete', REASONS.NO_PAGES, counts_found)
  }

  // A reported total outranks the page shape. If the provider says 4,000 and we
  // saw 100, the heuristic can only guess; the total is an answer.
  if (total !== null && seen < total) {
    const shortfall = total - seen
    return verdictFor(
      'incomplete',
      `${providerTotal !== null ? REASONS.TOTAL_SHORTFALL : REASONS.EXPECTED_SHORTFALL}`
        + ` (expected ${total}, seen ${seen}, short by ${shortfall})`,
      counts_found,
    )
  }

  // The provider's total was met, so a full last page is accounted for: another
  // page would contradict the provider's own count. This is checked before the
  // page-shape heuristic below, which is why that heuristic only ever fires
  // without a total to check against — and why its wording says so.
  if (total !== null && seen >= total) {
    return verdictFor('complete', `${REASONS.TOTAL_SATISFIED} (${seen} of ${total})`, counts_found)
  }

  // Two independent signals that there may be more behind us: the last page came
  // back exactly full, and the source's own cap bound. GDACS trips both at 100,
  // and the reason names both — picking one and hiding the other would leave the
  // next reader with a guess about which limit actually bit.
  const capBound = cap !== null && cap > 0 && seen >= cap
  if (capBound || lastPageFull) {
    const evidence = []
    if (lastPageFull) evidence.push(REASONS.FULL_PAGE)
    if (capBound) evidence.push(`${REASONS.CAPPED} (${cap})`)
    const fullness = Number.isFinite(pageSize) && pageSize > 0 ? ` (${seen} of ${pageSize} on the last page)` : ''
    return verdictFor('possibly_incomplete', `${evidence.join('; ')}${fullness}`, counts_found)
  }

  return verdictFor(
    'complete',
    Number.isFinite(pageSize) && pageSize > 0
      ? `${REASONS.PARTIAL_PAGE} (${seen} of ${pageSize} on the last page)`
      : REASONS.PARTIAL_PAGE,
    counts_found,
  )
}

/**
 * Record a list that may have been sliced.
 *
 * @param {object} input
 * @param {number} input.found  records the source offered
 * @param {number} input.taken  records kept (defaults to `found`)
 * @param {number|null} [input.cap] the cap, if a cap applies to this source
 * @param {string} [input.reason] why, recorded only when the cap bound
 * @returns {{records: number[], counts_found: number|null, capped: boolean, cap_reason: string|null}}
 *   `records` holds the numbers, not the payloads — the caller keeps the
 *   payloads and splices them by the same indices.
 */
export function recordCap(input = {}) {
  const { found, taken, cap: rawCap, reason } = input
  const offered = Number.isFinite(found) ? Math.max(0, Math.trunc(found)) : 0
  const limit = numericTotal(rawCap)
  const kept = Number.isFinite(taken) ? Math.max(0, Math.trunc(taken)) : offered

  // The cap binds when it is a real limit and we have at least that many
  // records to take. `found >= cap` rather than `found > cap`: reaching the cap
  // exactly is the suspicious case, and it is the one GDACS hits every time.
  const capped = limit !== null && limit > 0 && offered >= limit

  // Zero found with no cap applied records nothing rather than a zero. A zero
  // here would assert "we counted and there was nothing"; the truth is "we
  // never counted".
  const counts_found = offered > 0 || capped ? offered : null

  return {
    records: kept,
    counts_found,
    capped,
    cap_reason: capped ? (reason || `capped at ${limit} of ${offered} found`) : null,
  }
}

/**
 * One verdict for a run assembled from many pages.
 *
 * Worst wins. A run is only as complete as its least complete page, and a
 * provider-total shortfall anywhere outranks a full-last-page guess, because
 * one of them is an answer and the other is a heuristic.
 *
 * Entries are read as the verdict the booleans describe, not as a string:
 * `complete: true` is complete, `possibly_incomplete: true` is a guess, and
 * neither flag set is a shortfall. An entry that claims nothing is read as
 * `incomplete` — an unassessable page is not evidence of a whole one.
 *
 * @param {Array<{complete?: boolean, possibly_incomplete?: boolean, reason?: string, counts_found?: number|null}>} entries
 * @returns {{complete: boolean, possibly_incomplete: boolean, reason: string, counts_found: number|null, pages: number}}
 */
export function mergeCompleteness(entries = []) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : []
  if (!list.length) return { ...verdictFor('complete', REASONS.NO_PAGES, null), pages: 0 }

  const verdictOf = (entry) => {
    if (entry.complete === true) return 'complete'
    if (entry.possibly_incomplete === true) return 'possibly_incomplete'
    return 'incomplete'
  }

  let worst = null
  let worstReason = ''
  let counted = null
  for (const entry of list) {
    const verdict = verdictOf(entry)
    if (worst === null || RANK[verdict] > RANK[worst]) {
      worst = verdict
      worstReason = entry.reason || ''
    }
    if (Number.isFinite(entry.counts_found)) counted = (counted ?? 0) + entry.counts_found
  }

  // The reason of the losing page, plus how many pages sat at that verdict —
  // otherwise a single full last page in a 40-page run reads as if all 40 were
  // full, and a 40-page run of full pages reads as a single one.
  const atWorst = list.filter((e) => verdictOf(e) === worst).length

  return { ...verdictFor(worst, `${worstReason} (worst of ${list.length} pages; ${atWorst} at this verdict)`, counted), pages: list.length }
}