/**
 * ENH-75 — the audit chain's verification core, in a module a browser can load.
 *
 * `src/audit-chain.js` verifies the chain server-side, with the head hash
 * supplied out of band. That is the right half of the property, and it is the
 * weaker half: the verifier and the thing being verified are the same process,
 * so a donor checking an export has to trust the server that produced it. The
 * chain is a hash walk — pure, synchronous, no I/O — and this file is that walk,
 * in a shape a browser can run over an export a partner downloaded. A partner
 * who recomputes the head in their own browser and finds the published one is
 * holding evidence rather than a claim.
 *
 * **Why the file is split and what that costs.** The two halves cannot be one
 * file: this one is loaded by a browser and may not import `node:crypto`, and
 * the server's half needs a `createHash`. So the *rule* lives here — the chained
 * field list, the canonical encoding, the defect taxonomy — and `src/audit-chain.js`
 * imports it and supplies the one function this file cannot write itself:
 * `sha256Hex`. The split is the same one `public/shared/submission-id.js` makes,
 * and it carries the same risk: two encodings that drift. The defence is that
 * there is only one encoding, here, and `src/audit-chain.js` no longer has its
 * own copy of the preimage or the field list.
 *
 * **The one thing a browser verifier cannot do.** `crypto.subtle.digest` is
 * asynchronous and available only in a secure context; a field pilot served over
 * a plain-HTTP LAN address does not have it. So `verifyChainWith` takes the hash
 * function as an argument, and the async wrapper `verifyChainInBrowser` awaits
 * `crypto.subtle` — refusing, with a reason, when it is absent, rather than
 * falling back to a synchronous hash that would produce a different digest and
 * report every intact chain as broken.
 */

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

/** The genesis predecessor: sixty-four zeros, so the first entry has a prev_hash. */
export const GENESIS_HASH = '0'.repeat(64)

/** A well-formed digest. Anything else is a defect, not a hash. */
export const HEX64 = /^[0-9a-f]{64}$/

/** Deterministic JSON with object keys sorted at every depth. Array order is content. */
export function canonicalise(value) {
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
 * The exact bytes a digest is taken over: the predecessor's hash, a newline, the
 * preimage. One function so the browser half and the server half cannot encode
 * this differently — which is the failure a split module invites.
 */
export function chainDigestInput(entry, prevHash) {
  return `${prevHash}\n${chainPreimage(entry)}`
}

/** Ids of entries a withdrawal names, minus the ones that name nothing in the chain. */
export function withdrawalIndex(entries) {
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
 * Verifies a chain by recomputation, given a hash function.
 *
 * `hash(text) -> hex` is the only thing the caller supplies. The server passes a
 * `createHash('sha256')` wrapper; a browser passes a `crypto.subtle` wrapper.
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
 * Returns `{ verified, anchored, entry_count, head, seq, withdrawn, defects }`.
 * `verified` is false on any defect of fatal severity; `anchored` says whether
 * the head was checked against an external claim.
 */
export function verifyChainWith(entries, hash, options = {}) {
  const { expectedHead = null, expectedCount = null } = options
  const defects = []
  const ordered = [...(entries || [])].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))

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
  let running = { seq: 0, hash: GENESIS_HASH }
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
    //
    // `entry` is passed to the hash function as a second argument so an async
    // caller can precompute the digests and hand back a lookup by entry. The
    // server's synchronous hash ignores it.
    const recomputed = hash(chainDigestInput(entry, running.hash), entry)
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
 * The browser verifier: recompute a chain's head with `crypto.subtle`.
 *
 * Asynchronous because WebCrypto is. Resolves to the same shape `verifyChainWith`
 * returns, plus `available: true`. When the browser has no `crypto.subtle` — a
 * non-secure origin, which is how a field pilot is often served — it resolves to
 * `available: false`, `verified: false`, and a reason, rather than throwing. A
 * verifier that throws is one the caller wraps in a try/catch and then renders as
 * "could not check", which is indistinguishable from "the chain is broken" on
 * the screen. Reporting the absence as its own state is what keeps the two apart.
 */
export async function verifyChainInBrowser(entries, options = {}) {
  const scope = options.scope || globalThis
  const subtle = scope?.crypto?.subtle
  if (!subtle || typeof subtle.digest !== 'function') {
    return {
      available: false,
      verified: false,
      anchored: false,
      entry_count: (entries || []).length,
      head: null,
      seq: null,
      withdrawn: [],
      defects: [{
        type: 'no_webcrypto',
        severity: 'advisory',
        detail: 'this browser has no crypto.subtle — a secure context (https, or localhost) is required to verify the chain here',
      }],
    }
  }

  const encoder = new TextEncoder()
  const hash = (text) => subtle.digest('SHA-256', encoder.encode(text))
    .then((buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join(''))

  // `verifyChainWith` hashes synchronously and WebCrypto does not, so the walk is
  // precomputed here — one awaited digest per entry, in order — and the
  // synchronous verifier is then handed a hash that reads the table back by
  // entry. The rules stay in one implementation; only the digest source differs.
  const ordered = [...(entries || [])].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
  const digests = new Map()
  let running = GENESIS_HASH
  for (const entry of ordered) {
    const digest = await hash(chainDigestInput(entry, running))
    digests.set(entry, digest)
    running = digest
  }
  const result = verifyChainWith(ordered, (_text, entry) => digests.get(entry), options)
  return { available: true, ...result }
}
