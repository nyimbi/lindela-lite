import crypto from 'node:crypto'

import { mintSubmissionId, stampSubmissionId } from '../public/shared/submission-id.js'

/**
 * ENH-39 — the server half of the submission identity.
 *
 * The rule lives in `public/shared/submission-id.js`, which the browser loads:
 * one submission, one random identity, minted where the act of filing happens
 * and carried through every retry. This file is the other half — turning that
 * identity into a record id the store can merge on — and it is separate only
 * because a browser may not import `node:crypto` and the hash needs one.
 *
 * The defect this closes, measured against a live server before it existed: the
 * field-report id hashed the submission's content together with the server's
 * arrival time, so three POSTs of one body wrote three rows. The sequence
 * `submitOrQueue` actually performs — attempt online with no key, time out,
 * queue, retry — wrote two.
 *
 * Re-exported so a server-side caller has one import for the pair, and so the
 * gate that checks every `src/` module is reached by a test sees the browser
 * file reached through this one.
 */
export { mintSubmissionId, stampSubmissionId, SUBMISSION_ID_BYTES } from '../public/shared/submission-id.js'

/** The id prefix for a field report. Kept here so the caller names a record, not a string. */
export const FIELD_REPORT_PREFIX = 'report'

/**
 * A deterministic record id for a submission, or `null` when the body carries
 * none.
 *
 * A submission that names itself produces an id derived from that name alone, so
 * the second delivery of one submission resolves to the id the first delivery
 * wrote and `mergeById` updates rather than appends. A submission that names
 * nothing returns `null` and the caller keeps whatever it did before — the
 * honest answer for a client that has not been updated, and what makes the
 * pre-ENH-39 records identifiable.
 *
 * The prefix and the hash length match `stableId` in `src/utils.js` so an id
 * minted here is indistinguishable in shape from every other id in the store.
 */
export function recordIdForSubmission(prefix, submissionId) {
  if (typeof submissionId !== 'string' || !submissionId) return null
  const hash = crypto.createHash('sha256').update(submissionId).digest('hex').slice(0, 16)
  return `${prefix}_${hash}`
}

/** The submission id a record carries, or `null`. */
export function submissionIdOf(record) {
  const id = record?.submission_id
  return typeof id === 'string' && id ? id : null
}

/** Asserted at import so a broken export cannot look like a working one. */
if (typeof mintSubmissionId !== 'function' || typeof stampSubmissionId !== 'function') {
  throw new Error('public/shared/submission-id.js did not export the minting pair')
}
