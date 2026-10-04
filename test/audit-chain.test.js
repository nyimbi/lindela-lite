import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  chainEntries,
  chainEntry,
  chainGenesis,
  chainPreimage,
  chainStateFrom,
  chainWithdrawal,
  computeEntryHash,
  renderAuditProof,
  resolveChainHead,
  verifyChain,
} from '../src/audit-chain.js'

/**
 * ENH-28: a hash chain over the action log.
 *
 * The interesting tests are the tamper ones. A chain that only proves it was
 * never edited in the obvious way is worth very little — an operator with write
 * access to `action_logs` can re-chain a whole file consistently, and a verifier
 * that compares stored fields to stored fields will call that clean. Every test
 * below therefore edits or removes something and then re-derives, rather than
 * asking the module whether it still likes itself.
 */

const entry = (id, action, at) => ({
  id,
  collection: 'incidents',
  record_id: `inc_${id}`,
  action,
  actor: 'token_abc123def456',
  subject: null,
  created_at: at || '2026-10-01T00:00:00.000Z',
  summary: `${action} incident inc_${id}`,
  metadata: { status: 'open', priority: 'high' },
})

/** A chain of n entries, all with the same timestamp unless stated. */
function build(count, mutate = (records) => records) {
  const { entries } = chainEntries(mutate(Array.from({ length: count }, (_, i) => entry(`e${i + 1}`, 'created'))))
  return entries
}

const defectTypes = (result) => result.defects.map((defect) => defect.type)

describe('audit chain — construction', () => {
  it('numbers entries from one and links each to the previous', () => {
    const entries = build(3)
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3])
    assert.equal(entries[0].prev_hash, '0'.repeat(64))
    assert.equal(entries[1].prev_hash, entries[0].entry_hash)
    assert.equal(entries[2].prev_hash, entries[1].entry_hash)
    assert.match(entries[2].entry_hash, /^[0-9a-f]{64}$/)
  })

  it('computes the same hash from the same content regardless of key order', () => {
    // JSON key order is not a property of the fact being recorded. Two writers
    // that assemble the same entry differently must land on the same hash, or
    // every normaliser change silently forks the chain.
    const a = { ...entry('e1', 'created'), metadata: { priority: 'high', status: 'open' } }
    const b = { ...entry('e1', 'created'), metadata: { status: 'open', priority: 'high' } }
    assert.equal(computeEntryHash(a, chainGenesis().hash), computeEntryHash(b, chainGenesis().hash))
  })

  it('treats array order as content', () => {
    const a = { ...entry('e1', 'created'), metadata: { tags: ['x', 'y'] } }
    const b = { ...entry('e1', 'created'), metadata: { tags: ['y', 'x'] } }
    assert.notEqual(computeEntryHash(a, chainGenesis().hash), computeEntryHash(b, chainGenesis().hash))
  })

  it('hashes created_at, unlike canonicalHash, because re-dating is a forgery', () => {
    const early = chainEntry(entry('e1', 'created', '2026-10-01T00:00:00.000Z'))
    const late = chainEntry(entry('e1', 'created', '2026-10-02T00:00:00.000Z'))
    assert.notEqual(early.entry_hash, late.entry_hash)
  })

  it('leaves the chain linkage fields out of the preimage', () => {
    const chained = chainEntry(entry('e1', 'created'))
    const preimage = JSON.parse(chainPreimage(chained))
    assert.ok(!('entry_hash' in preimage))
    assert.ok(!('prev_hash' in preimage))
    assert.equal(preimage.seq, 1)
  })

  it('derives the head by recomputation, not by reading the last stored hash', () => {
    const entries = build(4)
    const state = chainStateFrom(entries)
    assert.deepEqual(state, { seq: 4, hash: entries[3].entry_hash })
  })

  it('resolves the head from a cached state only when it agrees with the log', () => {
    const entries = build(4)
    const cached = { seq: 4, hash: entries[3].entry_hash }
    assert.deepEqual(resolveChainHead(entries, cached), cached)
    // A state carried across a restore-from-backup is worse than a scan: it
    // would chain onto a head the store does not have. Same seq, wrong history.
    assert.notDeepEqual(resolveChainHead(entries, { seq: 4, hash: 'f'.repeat(64) }), { seq: 4, hash: 'f'.repeat(64) })
    assert.deepEqual(resolveChainHead(entries, { seq: 2, hash: 'a'.repeat(64) }), { seq: 4, hash: entries[3].entry_hash })
    assert.deepEqual(resolveChainHead(entries), { seq: 4, hash: entries[3].entry_hash })
  })

  it('rejects a cached head when the log it points at was edited', () => {
    const entries = build(3)
    const cached = { seq: 3, hash: entries[2].entry_hash }
    const edited = [...entries.slice(0, 2), { ...entries[2], actor: 'someone_else' }]
    assert.notDeepEqual(resolveChainHead(edited, cached), cached)
  })
})

describe('audit chain — verification', () => {
  it('verifies a chain it built', () => {
    const entries = build(5)
    const result = verifyChain(entries, { expectedHead: entries[4].entry_hash })
    assert.equal(result.verified, true)
    assert.equal(result.anchored, true)
    assert.equal(result.entry_count, 5)
    assert.deepEqual(result.defects, [])
  })

  it('sorts by seq before walking, so a shuffled export is not reported as reordered', () => {
    const entries = build(5)
    const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]]
    assert.equal(verifyChain(shuffled, { expectedHead: entries[4].entry_hash }).verified, true)
  })

  it('reports an unanchored check as advisory rather than as success', () => {
    const result = verifyChain(build(3))
    assert.equal(result.anchored, false)
    assert.deepEqual(defectTypes(result), ['unanchored'])
  })

  it('detects an edited entry', () => {
    const entries = build(5)
    const result = verifyChain(entries, { expectedHead: entries[4].entry_hash })
    assert.equal(result.verified, true)

    // The tamper: an operator rewrites what entry 3 claims happened.
    const tampered = entries.map((e, i) => (i === 2 ? { ...e, action: 'deleted', summary: 'deleted incident inc_e3' } : e))
    const after = verifyChain(tampered, { expectedHead: entries[4].entry_hash })
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('entry_hash_mismatch'))
    assert.ok(defectTypes(after).includes('prev_hash_mismatch'), 'the break must propagate to the next entry')
    assert.equal(after.defects.find((d) => d.type === 'entry_hash_mismatch').seq, 3)
  })

  it('detects a removed middle entry', () => {
    const entries = build(5)
    const removed = entries.filter((e) => e.seq !== 3)
    const after = verifyChain(removed, { expectedHead: entries[4].entry_hash })
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('seq_gap'))
    assert.ok(defectTypes(after).includes('prev_hash_mismatch'))
  })

  it('detects an entry renumbered into a different position', () => {
    // File order is not the chain — `seq` is, and the sort above exists so a
    // shuffled export is not reported as a forgery. Reordering *with*
    // renumbering is a different act, and it is an edit like any other.
    const entries = build(4)
    const renumbered = entries.map((e, i) => (i === 2 ? { ...e, seq: 4 } : e))
    const after = verifyChain(renumbered, { expectedHead: entries[3].entry_hash })
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('entry_hash_mismatch'))
    assert.ok(defectTypes(after).includes('prev_hash_mismatch'))
  })

  it('detects truncation of the tail against a published head', () => {
    const entries = build(6)
    const truncated = entries.slice(0, 4)
    const after = verifyChain(truncated, { expectedHead: entries[5].entry_hash })
    assert.equal(after.verified, false)
    const head = after.defects.find((d) => d.type === 'head_mismatch')
    assert.ok(head)
    assert.equal(head.expected, entries[5].entry_hash)
    assert.equal(head.found, entries[3].entry_hash)
  })

  it('detects a published entry-count mismatch', () => {
    const entries = build(5)
    const after = verifyChain(entries.slice(0, 4), { expectedHead: entries[3].entry_hash, expectedCount: 5 })
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('count_mismatch'))
  })

  it('fails a consistent re-chain of the entire log', () => {
    // This is the case the whole module exists for. Every row agrees with every
    // other row; only the anchor is left, and the anchor is what is checked.
    const original = build(4)
    const publishedHead = original[3].entry_hash

    const rewritten = chainEntries(
      original.map((e) => ({ ...e, actor: 'token_operator_forged' })),
    ).entries
    assert.equal(verifyChain(rewritten).verified, true, 'internally consistent, as designed')

    const after = verifyChain(rewritten, { expectedHead: publishedHead })
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('head_mismatch'))
  })

  it('rejects an entry_hash that is not a digest', () => {
    const entries = build(2)
    const after = verifyChain([entries[0], { ...entries[1], entry_hash: 'not-a-hash' }])
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('malformed_hash'))
  })

  it('reports a duplicated entry', () => {
    const entries = build(3)
    const after = verifyChain([entries[0], entries[1], entries[1], entries[2]])
    assert.equal(after.verified, false)
    assert.ok(defectTypes(after).includes('duplicate_seq'))
    assert.ok(defectTypes(after).includes('duplicate_id'))
  })
})

describe('audit chain — withdrawal (ADR-007)', () => {
  it('takes an entry back with a new entry rather than editing it', () => {
    const entries = build(3)
    const withdrawal = chainWithdrawal(entries, 'e2', 'token_abc123def456', '2026-10-01T01:00:00.000Z')
    const chained = [...entries, withdrawal]
    assert.equal(withdrawal.seq, 4)
    assert.equal(withdrawal.action, 'withdraw')
    assert.equal(withdrawal.metadata.withdraws, 'e2')
    // The original is untouched, so the chain still verifies.
    assert.equal(verifyChain(chained, { expectedHead: withdrawal.entry_hash }).verified, true)
  })

  it('lists the withdrawn entry without hiding it', () => {
    const entries = build(2)
    const withdrawal = chainWithdrawal(entries, 'e1', 'token_abc123def456', '2026-10-01T01:00:00.000Z')
    const result = verifyChain([...entries, withdrawal])
    assert.deepEqual(result.withdrawn, [{ entry_id: 'e1', withdrawn_by: withdrawal.id }])
    assert.equal(result.entry_count, 3, 'a withdrawn entry is still an entry')
  })

  it('flags a withdrawal that names an entry not in the chain', () => {
    const entries = build(2)
    const forged = chainEntry({
      ...entry('e9', 'withdraw'),
      metadata: { withdraws: 'e_does_not_exist' },
    }, chainStateFrom(entries))
    const result = verifyChain([...entries, forged])
    assert.equal(result.verified, false)
    assert.ok(defectTypes(result).includes('unknown_withdrawal'))
  })

  it('refuses to withdraw an entry that does not exist', () => {
    assert.throws(() => chainWithdrawal(build(1), 'nope', 'token_abc123def456'), /No action-log entry/)
  })

  it('detects the deletion of a withdrawn entry', () => {
    // The soft-delete tension made concrete: with ADR-007 there is no DELETE on
    // action_logs, and if one happens anyway the chain notices.
    const entries = build(2)
    const withdrawal = chainWithdrawal(entries, 'e1', 'token_abc123def456', '2026-10-01T01:00:00.000Z')
    const result = verifyChain([entries[1], withdrawal], { expectedHead: withdrawal.entry_hash })
    assert.equal(result.verified, false)
    assert.ok(defectTypes(result).includes('unknown_withdrawal'))
  })
})

describe('audit chain — the donor proof', () => {
  it('states the recomputation in plain language and reports a clean result', () => {
    const entries = build(3)
    const text = renderAuditProof(entries, { expectedHead: entries[2].entry_hash })
    assert.match(text, /recomputed head: /)
    assert.match(text, /SHA-256/)
    assert.match(text, /RESULT: the chain recomputes cleanly\./)
    assert.ok(text.includes(entries[2].entry_hash))
  })

  it('says the limit out loud when no head was published', () => {
    const text = renderAuditProof(build(2))
    assert.match(text, /a full rewrite of this log cannot be ruled out/)
  })

  it('names every defect and reports BROKEN', () => {
    const entries = build(3)
    const tampered = entries.map((e, i) => (i === 1 ? { ...e, actor: 'someone_else' } : e))
    const text = renderAuditProof(tampered, { expectedHead: entries[2].entry_hash })
    assert.match(text, /RESULT: BROKEN/)
    assert.match(text, /entry_hash_mismatch/)
  })

  it('lists withdrawals so a donor can see the entry was taken back, not deleted', () => {
    const entries = build(2)
    const withdrawal = chainWithdrawal(entries, 'e1', 'token_abc123def456', '2026-10-01T01:00:00.000Z')
    const text = renderAuditProof([...entries, withdrawal])
    assert.match(text, /withdrawn by a later entry, not deleted/)
    assert.ok(text.includes(withdrawal.id))
  })
})