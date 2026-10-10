import { createHash } from 'node:crypto'

import { logger } from './observability.js'
import { stableId } from './utils.js'

/**
 * Hash chaining for `action_logs` (ENH-28).
 *
 * DATA-15 called the audit trail self-asserted: the row says what happened and
 * nothing else in the system can contradict it. This module makes the row
 * unforgeable *given one anchor* — a published head hash the verifier did not
 * get from the thing being protected.
 *
 * ## What is actually chained
 *
 * Each log entry carries `seq`, `prev_hash` and `entry_hash`. `entry_hash` is
 * SHA-256 over the entry's content fields *plus the hash of its predecessor*.
 * Editing entry 3 changes its own hash, which changes what entry 4 must point
 * at, and the break propagates to the head. Deleting a middle entry leaves a
 * `seq` gap and a `prev_hash` that names a hash nothing recomputes to.
 *
 * ## Why verification recomputes instead of comparing
 *
 * The obvious implementation — walk the chain checking each row's `prev_hash`
 * against its predecessor's stored `entry_hash` — is defeated by an attacker
 * who rewrites the whole file and re-chains it consistently. Every stored field
 * agrees with every other stored field, and the check passes.
 *
 * So `verifyChain` never reads a stored linkage field as truth. It recomputes
 * `entry_hash` from the entry's own content and carries the *recomputed* value
 * forward as the next entry's expected predecessor. The stored `prev_hash` is
 * then compared against that recomputed value, which is a mismatch the moment
 * anything upstream changed. A re-chain changes the head, and the head is the
 * only thing an attacker cannot reach — so `verifyChain` takes it as
 * `expectedHead`, obtained out of band, and a re-chain without the anchor is
 * reported as `head_mismatch` rather than as success.
 *
 * ## The soft-delete tension (ADR-007)
 *
 * ADR-007 amends operational records in place: `deleted_at` and `deleted_by`
 * are stamped onto a row that stays in the store. That is the right call for
 * the records, and it cannot be the right call for the chain. If an audit entry
 * could be amended, "hash-chained" would mean "hash-chained until someone
 * needs it to be quiet", and the chain would only be as strong as the operator
 * running the server — which is precisely the thing a donor is meant not to have
 * to trust.
 *
 * So the chain applies to the *log*, and the log is append-only. ADR-007 already
 * says so: `action_logs` is "append-only and read-only" and `DELETE` on it is a
 * 405. An entry that should not have been written is corrected by a
 * compensating entry, not by editing the first one:
 *
 *   `chainWithdrawal(log, targetEntryId, actor)` → `{ action: 'withdraw', metadata: { withdraws: id } }`
 *
 * That keeps every claim in the trail attributable and permanent, and gives a
 * verifier one rule instead of two: an entry is gone only if the chain says so.
 *
 * ## Write-path cost
 *
 * Appending is O(1) in the length of the log: one SHA-256 over a few hundred
 * bytes, whatever the tenth or the hundred-thousandth entry. Finding the head
 * is O(n), which would be the expensive part — so callers pass the previous
 * `chainState` they already hold and only pay the scan when they do not. Every
 * write path in this product already reads the whole store
 * (`src/server.js:252`, `src/postgres-store.js:60`), so in practice the append
 * adds one hash to a read that has already happened. Verification is the O(n)
 * half and is deliberately never on the write path.
 */

const GENESIS_HASH = '0'.repeat(64)
const HEX64 = /^[0-9a-f]{64}$/

/**
 * Exactly the fields a hash commits to.
 *
 * A whitelist, not a blacklist. The obvious `delete hash && prev_hash` over the
 * whole object breaks the moment someone adds a verification cache field: the
 * cached `verified: true` would silently stop being hashed, and the row would
 * verify under tampering. Naming the fields means a new column is unchained
 * until someone decides it should be — which is the correct default for an
 * audit record.
 *
 * `created_at` is included even though `canonicalHash` in utils drops it. The
 * chain commits to *when* something was claimed as well as *what* was claimed;
 * re-dating an entry is as much a forgery as rewriting its body.
 */
export const CHAINED_FIELDS = Object.freeze([
  'seq',
  'collection',
  'record_id',
  'action',
  'actor',
  'subject',
  'summary',
  'created_at',
  'metadata',
])

const CHAIN_FIELDS = Object.freeze(['seq', 'prev_hash', 'entry_hash'])

/** Deterministic JSON with object keys sorted at every depth. Array order is content. */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    )
  }
  return value
}

/** What the hash is taken over: content fields only, in a stable encoding. */
export function chainPreimage(entry) {
  const content = {}
  for (const field of CHAINED_FIELDS) content[field] = entry?.[field] ?? null
  return JSON.stringify(canonicalise(content))
}

/**
 * The hash of one entry, given the predecessor's hash.
 *
 * A pure function of (content, prevHash) with no reference to the entry's own
 * stored hash — that is what makes the recomputation independent.
 */
export function computeEntryHash(entry, prevHash) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(chainPreimage(entry))
    .digest('hex')
}

/**
 * Stamps one log entry into the chain.
 *
 * `prev` is `{ seq, hash }`. Passing the genesis shape (`{ seq: 0, hash: GENESIS_HASH }`)
 * starts a fresh chain.
 */
export function chainEntry(record, prev = { seq: 0, hash: GENESIS_HASH }) {
  const entry = { ...record, seq: prev.seq + 1, prev_hash: prev.hash }
  entry.entry_hash = computeEntryHash(entry, prev.hash)
  return entry
}

/** Chain a batch in order. One pass, so a 200-entry upload pays 200 hashes. */
export function chainEntries(records, prev = { seq: 0, hash: GENESIS_HASH }) {
  let cursor = prev
  const entries = []
  for (const record of records) {
    const entry = chainEntry(record, cursor)
    cursor = { seq: entry.seq, hash: entry.entry_hash }
    entries.push(entry)
  }
  return { entries, head: cursor }
}

/** The head of an already-chained log. Re-reads the head hash rather than trusting a field. */
export function chainStateFrom(entries) {
  let state = { seq: 0, hash: GENESIS_HASH }
  for (const entry of entries) {
    state = { seq: entry.seq, hash: computeEntryHash(entry, state.hash) }
  }
  return state
}

/**
 * Resolves the previous head for an append.
 *
 * `state` is the caller's cached head from the request it just served. It is
 * accepted only when it agrees with the log's last entry on all three of seq,
 * hash, and that entry's own content-to-hash recomputation — the last check
 * costs one hash and is what stops a state carried across a
 * restore-from-backup (same length, different history) from chaining onto a
 * head the store does not actually have. Getting this wrong silently forks the
 * chain in two, which is the one failure mode a chain cannot report on itself.
 */
export function resolveChainHead(logEntries = [], state = null) {
  const ordered = [...logEntries].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
  if (!ordered.length) return { seq: 0, hash: GENESIS_HASH }
  const last = ordered[ordered.length - 1]
  if (state && state.seq === last.seq && state.hash === last.entry_hash
    && computeEntryHash(last, last.prev_hash) === last.entry_hash) {
    return { seq: state.seq, hash: state.hash }
  }
  return chainStateFrom(ordered)
}

export function chainGenesis() {
  return { seq: 0, hash: GENESIS_HASH }
}

/**
 * A withdrawal is a new entry that names the entry it takes back.
 *
 * It goes through the same chain as everything else, so "this row was taken
 * back by someone, at a time, with an actor" is itself tamper-evident. Returns
 * the log entry; the caller merges it.
 */
export function chainWithdrawal(logEntries, targetEntryId, actor, now = new Date().toISOString()) {
  const target = (logEntries || []).find((entry) => entry.id === targetEntryId)
  if (!target) throw Object.assign(new Error(`No action-log entry with id ${targetEntryId}`), { statusCode: 404 })
  const head = resolveChainHead(logEntries)
  return chainEntry({
    id: stableId('log_withdrawal', [targetEntryId, now]),
    collection: 'action_logs',
    record_id: targetEntryId,
    action: 'withdraw',
    actor: actorFor(actor),
    subject: target.actor || null,
    created_at: now,
    summary: `withdraw ${target.action} ${target.collection} ${target.record_id}`,
    metadata: {
      withdraws: targetEntryId,
      withdrawn_action: target.action,
      withdrawn_seq: target.seq ?? null,
    },
  }, head)
}

/**
 * Actor resolution that prefers the authenticated token (SEC-09).
 *
 * The body-supplied `actor` string is caller-controlled: anyone who can reach a
 * mutating route can write "field-officer-nairobi" into the row and then read
 * that back from the export. `req.__auth.subject` is a SHA-256 fingerprint
 * derived from the token by `src/auth.js`, so it names *which credential* acted
 * without the operator having to keep a roster.
 *
 * When there is no authenticated identity the raw string is still recorded,
 * because an unattributed action is better than an unactioned one — but it is
 * recorded as unattributed, and `unattributed: true` says so in the row.
 */
export function actorFor(input) {
  if (input && typeof input === 'object') {
    if (input.auth?.subject) return { actor: input.auth.subject, unattributed: false }
    if (input.__auth?.subject) return { actor: input.__auth.subject, unattributed: false }
    if (typeof input.actor === 'string' && input.actor) return { actor: input.actor, unattributed: true }
    return { actor: 'anonymous', unattributed: true }
  }
  if (typeof input === 'string' && input) return { actor: input, unattributed: true }
  return { actor: 'anonymous', unattributed: true }
}

/** Ids of entries a withdrawal names, minus the ones that name nothing in the chain. */
function withdrawalIndex(entries) {
  const withdrawn = new Map()
  const dangling = []
  for (const entry of entries) {
    if (entry.action !== 'withdraw') continue
    const target = entry.metadata?.withdraws
    if (typeof target !== 'string' || !target) continue
    if (!entries.some((candidate) => candidate.id === target)) {
      // A withdrawal naming an absent entry is either a chain that lost rows or
      // a withdrawal of something that never existed. Both need a human.
      dangling.push({ withdraws: target, by_seq: entry.seq ?? null, by_entry: entry.id })
      continue
    }
    withdrawn.set(target, entry.id)
  }
  return { withdrawn, dangling }
}

/**
 * Verifies a chain by recomputation.
 *
 * `entries` may arrive in any order — it is sorted by `seq` first, because a
 * verifier that reports "reordered" when handed a shuffled export is a verifier
 * operators stop reading. Reordering *within* the file is not itself detectable
 * and is not what the chain claims; changing what an entry says, or removing
 * one, is.
 *
 * `expectedHead` is the trust anchor: the head hash as published or witnessed
 * somewhere the operator does not control. Supplying it is what makes a
 * full re-chain detectable. Without it, an internal-consistency check is still
 * run and its weaker guarantee is reported explicitly rather than silently.
 *
 * Returns `{ verified, anchored, entry_count, head, withdrawn, defects }`.
 * `verified` is false on any defect; `anchored` says whether the head was
 * checked against an external claim.
 */
export function verifyChain(entries = [], options = {}) {
  const { expectedHead = null, expectedCount = null } = options
  const defects = []
  const ordered = [...entries].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))

  const { withdrawn, dangling } = withdrawalIndex(ordered)
  for (const item of dangling) {
    defects.push({
      type: 'unknown_withdrawal',
      severity: 'fatal',
      detail: `withdrawal at seq ${item.by_seq} names entry ${item.withdraws}, which is not in the chain`,
      entry_id: item.by_entry,
    })
  }

  const seenSeq = new Set()
  const seenId = new Set()
  let running = chainGenesis()
  let recomputedHead = null

  for (const entry of ordered) {
    const seq = Number(entry.seq)
    const label = { seq: Number.isFinite(seq) ? seq : null, entry_id: entry.id || null }

    if (!Number.isFinite(seq)) {
      defects.push({ type: 'missing_seq', severity: 'fatal', detail: 'entry carries no sequence number', ...label })
    } else if (seenSeq.has(seq)) {
      defects.push({ type: 'duplicate_seq', severity: 'fatal', detail: `seq ${seq} appears more than once`, ...label })
    } else if (seq !== running.seq + 1) {
      // Either rows were removed from the middle, or the chain was restarted.
      // Both are the same observable fact: this entry does not follow the last.
      defects.push({
        type: 'seq_gap',
        severity: 'fatal',
        detail: `expected seq ${running.seq + 1}, found ${seq} — an entry was removed or reordered`,
        ...label,
      })
    }
    seenSeq.add(seq)

    if (seenId.has(entry.id)) {
      defects.push({ type: 'duplicate_id', severity: 'fatal', detail: `entry id ${entry.id} appears more than once`, ...label })
    }
    seenId.add(entry.id)

    // The recomputed hash is what the *next* entry must reference. Reading
    // `prev_hash` here instead would let a consistent re-chain pass, which is
    // the whole failure mode this module exists to close.
    const recomputed = computeEntryHash(entry, running.hash)
    if (entry.entry_hash !== recomputed) {
      defects.push({
        type: 'entry_hash_mismatch',
        severity: 'fatal',
        detail: 'entry content does not hash to its recorded entry_hash — the entry was edited',
        expected: recomputed,
        found: entry.entry_hash ?? null,
        ...label,
      })
    }
    if (entry.prev_hash !== running.hash) {
      defects.push({
        type: 'prev_hash_mismatch',
        severity: 'fatal',
        detail: 'prev_hash does not match the recomputed hash of the preceding entry',
        expected: running.hash,
        found: entry.prev_hash ?? null,
        ...label,
      })
    }
    if (!HEX64.test(String(entry.entry_hash))) {
      defects.push({ type: 'malformed_hash', severity: 'fatal', detail: 'entry_hash is not a 64-character hex digest', ...label })
    }

    running = { seq: Number.isFinite(seq) ? seq : running.seq, hash: recomputed }
    recomputedHead = recomputed
  }

  if (expectedHead !== null && expectedHead !== undefined) {
    if (expectedHead !== recomputedHead) {
      // The signature of a rewrite: every row agrees with every other row, and
      // none of them agrees with the hash the operator published or the donor
      // witnessed at the time.
      defects.push({
        type: 'head_mismatch',
        severity: 'fatal',
        detail: 'recomputed head does not match the published head — the log was rewritten, or entries were removed from the end',
        expected: expectedHead,
        found: recomputedHead ?? null,
        seq: running.seq,
      })
    }
  } else {
    defects.push({
      type: 'unanchored',
      severity: 'advisory',
      detail: 'no published head was supplied; a consistent re-chain of the whole log cannot be detected without one',
      seq: running.seq,
    })
  }

  if (expectedCount !== null && expectedCount !== undefined && expectedCount !== ordered.length) {
    defects.push({
      type: 'count_mismatch',
      severity: 'fatal',
      detail: `published entry count ${expectedCount} does not match ${ordered.length} entries`,
      expected: expectedCount,
      found: ordered.length,
    })
  }

  return {
    // Advisory defects never flip the verdict: they describe the limit of what
    // was checked, not a break in the log.
    verified: defects.every((defect) => defect.severity !== 'fatal'),
    anchored: expectedHead !== null && expectedHead !== undefined,
    entry_count: ordered.length,
    head: recomputedHead,
    seq: running.seq,
    withdrawn: [...withdrawn.entries()].map(([target, by]) => ({ entry_id: target, withdrawn_by: by })),
    defects,
  }
}

/**
 * The artefact a donor can check without trusting the operator.
 *
 * It carries the entries, the recomputed head, and a short procedure in plain
 * language rather than a link to documentation they have no reason to open. A
 * proof nobody can execute is a claim; this one is four lines of SHA-256.
 */
export function renderAuditProof(entries = [], options = {}) {
  const { expectedHead = null, generatedAt = new Date().toISOString(), product = 'Lindela Lite' } = options
  const result = verifyChain(entries, { expectedHead })

  const lines = []
  lines.push(`${product} — audit trail proof`)
  lines.push(`generated at: ${generatedAt}`)
  lines.push(`entries:       ${result.entry_count}`)
  lines.push(`recomputed head: ${result.head}`)
  if (result.anchored) {
    lines.push(`published head:  ${expectedHead}`)
    lines.push(`head matches published: ${result.verified ? 'YES' : 'NO'}`)
  } else {
    lines.push('published head:  (none supplied — a full rewrite of this log cannot be ruled out)')
  }
  lines.push('')
  lines.push('How to check this yourself, without trusting the server that produced it:')
  lines.push('  1. Take the entries below in seq order. The first entry\'s prev_hash is 64 zeros.')
  lines.push('  2. For each entry, build the text:  prev_hash + "\\n" + JSON of')
  lines.push('     {seq, collection, record_id, action, actor, subject, summary, created_at, metadata}')
  lines.push('     with object keys sorted at every depth (array order unchanged; absent fields are null).')
  lines.push('  3. SHA-256 that text. It must equal the entry\'s entry_hash, and it is the')
  lines.push('     prev_hash the next entry must carry.')
  lines.push('  4. If any step fails, an entry was edited. If a seq is missing, one was removed.')
  lines.push('')
  lines.push(result.verified
    ? 'RESULT: the chain recomputes cleanly.'
    : `RESULT: BROKEN — ${result.defects.filter((d) => d.severity === 'fatal').length} defect(s).`)
  for (const defect of result.defects) {
    lines.push(`  [${defect.severity}] ${defect.type}${defect.seq !== undefined && defect.seq !== null ? ` (seq ${defect.seq})` : ''}: ${defect.detail}`)
  }
  if (result.withdrawn.length) {
    lines.push('')
    lines.push(`${result.withdrawn.length} entry/entries were withdrawn by a later entry, not deleted:`)
    for (const item of result.withdrawn) lines.push(`  ${item.entry_id}  ←  ${item.withdrawn_by}`)
  }
  return lines.join('\n')
}

/**
 * Verification at the read path, logged once per head.
 *
 * A chain that has been broken should be loud the first time, and quiet
 * afterwards — the same reasoning as the unconfigured-secret warning in
 * `rapidpro.js`. Without this the operator learns about a break from a donor,
 * which is the worst possible ordering.
 */
/**
 * CON-08. Bounded, because the key is a head and a head changes on every append.
 *
 * The set was unbounded and its key is `event:head`, so *every* action-log write
 * produced a new key and the set grew for the process lifetime. It is a dedupe
 * cache, not a record — the point is to stop one persistent break from filling
 * the log every request, not to remember every head ever seen. A FIFO bound does
 * that; the cost of eviction is that a break old enough to have been evicted can
 * warn again, which is the direction that fails safe.
 *
 * A thousand is far more than the number of distinct heads that can be relevant
 * at once — a chain with a thousand new entries between two reads of the same
 * break is not a chain anybody is watching — and bounded at roughly 80 KB rather
 * than at whatever the deployment happens to write.
 */
const REPORTED_HEAD_LIMIT = 1000
const reportedHeads = new Set()

function rememberHead(key) {
  reportedHeads.add(key)
  while (reportedHeads.size > REPORTED_HEAD_LIMIT) {
    // Insertion order, so this is the oldest key. `Set` has no `shift`, and
    // iterating to find the first is O(1) amortised across the eviction.
    reportedHeads.delete(reportedHeads.values().next().value)
  }
}

/**
 * Takes either shape — the `verifyChain` result or the `auditRollup` the read
 * path actually has. The rollup is the reduced form, and requiring callers to
 * reach past it for the full result is how this function ended up with no
 * callers at all.
 */
export function auditChainWarning(event, result) {
  const verified = result.verified ?? result.valid
  const key = `${event}:${result.head}`
  if (reportedHeads.has(key)) return null
  rememberHead(key)
  const defects = Array.isArray(result.defects)
    ? result.defects.filter((defect) => defect.severity === 'fatal').map((defect) => defect.type)
    : (result.fatal_types || [])
  logger.error('audit_chain_broken', {
    message: verified
      ? 'audit chain verified without a published head to anchor it'
      : 'audit chain does not recompute; action_logs have been edited, removed, or rewritten',
    head: result.head,
    entry_count: result.entry_count,
    defects,
  })
  return key
}

/**
 * R-51. The verification result, in the shape a readiness probe wants.
 *
 * `verifyChain` was called from exactly one route — the one that returns the
 * proof — so a tampered or truncated `action_logs` was detected when somebody
 * asked for the proof, or never. Tamper-evidence that only fires on request is
 * a capability, not evidence.
 *
 * This is the rollup for `/ready`: a boolean, the head, the counts, and the
 * first fatal defect by name. Pure — it re-verifies from the entries, so
 * calling it costs the same as asking for the proof and changes nothing.
 *
 * `unanchored` is reported separately rather than folded into `valid`. A chain
 * that recomputes against itself proves it has not been *edited in place*; it
 * cannot prove it has not been *rewritten end to end*, and only an
 * out-of-band head can. Reporting those as one verdict would mean a rewritten
 * log read as valid, which is the case the whole module exists to close.
 */
export function auditRollup(actionLogs = [], { expectedHead = null } = {}) {
  const logs = Array.isArray(actionLogs) ? actionLogs : []
  // SCL-07. What was actually verified.
  //
  // `chainEntries(logs)` stamps a fresh chain over whatever it is handed, so
  // `verifyChain` on the result is a tautology: edit a stored row's `actor` and
  // the recomputation produces a *different* head that still verifies cleanly.
  // Measured, not reasoned — a tampered `action_logs` row reported `valid: true`
  // on `/ready`, before and after the edit, with only the head changing.
  //
  // The rollup therefore verifies the stored linkage when the rows carry one,
  // and otherwise says so. `linked: false` is not a break in the log; it is the
  // statement that the check performed here is content-consistency, which
  // cannot detect an edit made before this call. A reader that cannot tell
  // those apart is being told their proof is stronger than it is, which is the
  // same failure `anchored` exists to prevent one level up.
  const linked = logs.length > 0 && logs.every((row) => row?.entry_hash && row?.seq !== undefined)
  const entries = linked ? logs : chainEntries(logs).entries
  const result = verifyChain(entries, { expectedHead })
  const fatal = result.defects.filter((defect) => defect.severity === 'fatal')
  return {
    valid: result.verified,
    // Whether the rows carried their own linkage, and so whether `valid` means
    // "the stored chain recomputes" or only "the content is internally
    // consistent". See the note above; the two are not the same claim.
    linked,
    // True when the chain recomputes but nothing outside it says it should.
    // A readiness probe that reports `valid: true` for an unanchored chain is
    // telling a donor their proof is stronger than it is.
    anchored: result.anchored,
    head: result.head,
    seq: result.seq,
    entry_count: result.entry_count,
    withdrawn_count: result.withdrawn.length,
    defect_count: result.defects.length,
    first_defect: fatal[0] ? { type: fatal[0].type, detail: fatal[0].detail, seq: fatal[0].seq ?? null } : null,
    // Names only. The full defect list belongs to whoever asks for the proof.
    fatal_types: [...new Set(fatal.map((defect) => defect.type))],
  }
}

/** Test seam: the "already warned" set is process state, not audit state. */
export function resetAuditChainWarnings() {
  reportedHeads.clear()
}

/** Test seam: CON-08, how many heads are being remembered. */
export function auditChainWarningStats() {
  return { size: reportedHeads.size, limit: REPORTED_HEAD_LIMIT }
}

export { CHAIN_FIELDS, GENESIS_HASH }