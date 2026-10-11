/**
 * ENH-39 — the browser half of the submission identity.
 *
 * One submission, one record, however many times it is delivered. This file
 * mints the identity and stamps it into the body; `src/submission-id.js` derives
 * the server-side record id from it. The two are separate files for a mechanical
 * reason — this one is loaded by a browser and may not import `node:crypto`, and
 * the server's half needs a sha256 — but the *rule* lives in one place: the id is
 * a random value minted once per act of filing, and nothing derives it from
 * content.
 *
 * **Why a submission id and not a longer content hash.** The server identified a
 * field report by hashing its content together with the server's arrival time,
 * so a retry wrote a second record. Dropping the time would make two genuinely
 * separate reports of the same symptom at the same coordinates collide — a
 * health worker filing for a second child in the same household writes an
 * identical body, and that report would be swallowed as a duplicate of the
 * first. Content cannot distinguish "the same submission twice" from "two
 * identical submissions", because the difference is not in the content: it is in
 * the *act*. So the identity is minted where the act happens — on the device,
 * once, before the first attempt — and carried through every retry. That is
 * ODK's `instanceID`, and it is the whole of this module.
 *
 * **Why the idempotency key alone is not enough.** `submitOrQueue` POSTs without
 * a key, and `enqueue` minted one only when it queued. A response lost to a
 * timeout is indistinguishable from a request that never arrived, so the server
 * had already written the record and the queued retry — carrying a key the first
 * attempt never used — wrote it again. Measured against a live server: two rows
 * for one report. A key minted per *attempt* is a nonce, not an idempotency key.
 */

/** The length of the random half, in bytes. 16 bytes is 128 bits. */
export const SUBMISSION_ID_BYTES = 16

/**
 * A stable identity for one act of filing a submission.
 *
 * Random rather than derived, deliberately. A content-derived id cannot tell a
 * retry from a genuine second report with the same content, and a
 * counter-or-clock-derived id collides across devices and across a clock that a
 * field handset resets. A UUIDv4 is the one construction with no collision
 * argument to make.
 *
 * `crypto.randomUUID` is the implementation everywhere this code runs, and the
 * byte path exists because a non-secure origin — a plain-HTTP LAN address, which
 * is how a field pilot is often served — leaves it undefined in some browsers.
 * `getRandomValues` is available on those origins, and `Math.random` is
 * deliberately not a fallback: a collision here is a silently swallowed report.
 *
 * `scope` is a parameter rather than a closed-over global so a test can drive
 * the fallback and the refusal without mutating `globalThis.crypto`, which Node
 * exposes as a getter.
 */
export function mintSubmissionId(scope = globalThis) {
  const source = scope?.crypto
  if (typeof source?.randomUUID === 'function') {
    // Caught rather than allowed to propagate: a `randomUUID` that throws — a
    // polyfill that rejects on a non-secure origin — is a reason to use the
    // fallback, not a reason to fail the filing. The throw that matters is the
    // one at the bottom, where *no* source is available.
    try {
      const id = source.randomUUID()
      if (typeof id === 'string' && id) return id
    } catch {
      // fall through to the byte source
    }
  }
  const bytes = typeof source?.getRandomValues === 'function'
    ? source.getRandomValues(new Uint8Array(SUBMISSION_ID_BYTES))
    : null
  if (bytes) {
    // Version 4 and the RFC 4122 variant, so a consumer that validates the shape
    // does not reject it. This path runs precisely where `randomUUID` is absent,
    // so the shape has to be built by hand.
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error(
    'no cryptographic source of randomness is available, so a submission cannot be given an identity '
    + 'that would survive a retry; refusing to mint one from Math.random, which would collide silently',
  )
}

/**
 * The submission id a body already carries, or a new one stamped into it.
 *
 * Returns `{ body, submission_id }` and never mutates the input, because the
 * caller holds the body it is about to send and a stamp that mutated it would
 * make a second call see the first call's id — the behaviour we want, arrived at
 * by accident rather than by contract.
 *
 * A body that already names a submission keeps it. That is the retry path: the
 * queue hands back the body it stored, which carries the id minted before the
 * first attempt.
 */
export function stampSubmissionId(body, scope = globalThis) {
  const existing = body?.submission_id
  if (typeof existing === 'string' && existing) {
    return { body, submission_id: existing }
  }
  const submission_id = mintSubmissionId(scope)
  return { body: { ...(body || {}), submission_id }, submission_id }
}
