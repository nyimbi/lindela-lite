/**
 * ENH-41 — field-level two-way sync, and the convergence function underneath it.
 *
 * ENH-39 gave a submission one identity, so a retry of the *same act* lands on the
 * same record instead of writing a second one. It says nothing about two
 * different acts on the same record — a health worker correcting a case status on
 * a phone with no signal while a district officer edits the same case in the
 * console. Both edits are real, both are already stored on their own device, and
 * when they next meet one of them has to survive. The naive rule — the later
 * arrival wins — means the phone's whole record overwrites the console's, or the
 * console's overwrites the phone's, and the losing edit is gone with nothing to
 * say it ever existed. That is the clobbering this entry exists to prevent.
 *
 * This module is the function that decides, and the whole entry is the claim that
 * the function *converges*: a phone that syncs twice, or syncs in a different
 * order, or syncs through a third device in between, reaches the same record as
 * every other replica. "Usually converges" is the bug — a merge that agrees with
 * itself only when the network happens to deliver in order is the clobbering,
 * arrived at less often.
 *
 * ## The design, and the one it rejects
 *
 * Two candidates were on the table. (a) is per-field last-writer-wins on a
 * Lamport counter with a deterministic tiebreak on actor id; (b) is a vector
 * clock per record with a field-level merge over the partial order it induces.
 * This is (b), and the reason is a requirement (a) cannot meet.
 *
 * A Lamport counter is a single integer. It orders *every* pair of writes, and it
 * cannot tell "B happened after A" from "B never saw A". Two writes made at the
 * same time on two devices — the phone offline, the console online — both bump
 * the counter and one of them is, by the rule, simply older. The counter picks a
 * winner and reports nothing, because from where it stands the two writes are
 * indistinguishable from a causal pair. That is the silent clobber the entry
 * names, and a tiebreak on actor id does not fix it: it makes the *choice*
 * deterministic without making the *concurrency* visible. A merge that is only
 * "usually" convergent is the bug; a merge that converges by discarding a
 * concurrent write is the same bug with better manners.
 *
 * A vector clock tracks causality rather than a total order. `compareClocks`
 * returns one of four answers — strictly before, strictly after, equal, or
 * *concurrent* — and the fourth is the one that matters. When two writes are
 * concurrent the merge does not choose: it keeps both, surfaces the conflict, and
 * lets a surface ask. That is the difference between losing an edit and deferring
 * a decision, and it is why the deliverable is (b).
 *
 * ## Why the state is an antichain, and why that is the proof
 *
 * A field does not hold one value; it holds the set of its *maximal* writes — the
 * writes no other write has seen. Merging two fields is set union followed by
 * dropping every element some other element dominates. Call that normalisation
 * `f`. Then:
 *
 *   merge(A, B) = f(A ∪ B)
 *
 * Union is commutative, associative and idempotent, and `f(f(X) ∪ Y) = f(X ∪ Y)`
 * holds because `f` only removes elements that are dominated, and domination is
 * transitive. The three laws follow from those two facts, not from a hope about
 * arrival order:
 *
 *   commutative   f(A ∪ B) = f(B ∪ A)
 *   associative   f(f(A ∪ B) ∪ C) = f(A ∪ B ∪ C) = f(A ∪ f(B ∪ C))
 *   idempotent    f(A ∪ A) = f(A) = A, since A is already maximal
 *
 * The value a reader sees is a *pure function of the antichain* — the greatest
 * head under a total tiebreak — so it converges with the antichain it is drawn
 * from. The tiebreak exists so a surface has something to render; `conflictsOf`
 * is what tells it not to trust it. A head set with one element is a settled
 * field. A head set with two is a question, and it stays a question until a
 * person answers it by writing again — which produces a write whose clock
 * dominates both heads and collapses the set back to one.
 *
 * ## The boundary this module does not cross
 *
 * Identity is ENH-39's, not this module's. `mergeRecords` refuses two records
 * that name different ids rather than inventing a rule for them, because "which
 * of these two records is the record" is not a merge question. Everything outside
 * `fields` — the id, the submission id, form version, timestamps — is the
 * caller's framing and is carried from `local` unchanged: the merge owns the
 * field map and nothing else. A browser loads this file directly; it imports no
 * Node built-in, which is why the module is split the way `submission-id.js` and
 * `audit-chain-core.js` are.
 */

/** A clock that has seen nothing. */
export function emptyClock() {
  return {}
}

/**
 * The clock of a write that has seen `clock` and happened at `actor`.
 *
 * The new clock is `clock` with the actor's own component incremented, so it is
 * strictly greater than everything the writer had seen and strictly greater than
 * the actor's previous write. Two actors ticking from the same base produce
 * clocks that are *incomparable* rather than ordered, which is exactly the fact a
 * Lamport counter throws away.
 */
export function tickClock(clock, actor) {
  const next = { ...(clock || {}) }
  next[actor] = (Number(next[actor]) || 0) + 1
  return next
}

/**
 * The pointwise maximum of two clocks — the clock of a replica that has seen
 * both.
 *
 * Commutative and associative by construction: `max` is, component by component.
 */
export function mergeClocks(a, b) {
  const left = a || {}
  const right = b || {}
  const out = {}
  for (const actor of new Set([...Object.keys(left), ...Object.keys(right)])) {
    out[actor] = Math.max(Number(left[actor]) || 0, Number(right[actor]) || 0)
  }
  return out
}

/**
 * The causal order between two clocks.
 *
 * Returns `1` when `a` is strictly after `b`, `-1` when strictly before, `0` when
 * they are the same version, and `null` when they are **concurrent** — neither
 * has seen the other. The fourth answer is the whole point: it is the state a
 * total order cannot express, and the state in which a merge must not pick.
 *
 * `a` is ≤ `b` iff every component of `a` is ≤ the corresponding component of
 * `b`; a component missing from one side is zero. Concurrency is exactly "some
 * component of `a` is greater and some component of `b` is greater".
 */
export function compareClocks(a, b) {
  const left = a || {}
  const right = b || {}
  let leftAhead = false
  let rightAhead = false
  for (const actor of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const l = Number(left[actor]) || 0
    const r = Number(right[actor]) || 0
    if (l > r) leftAhead = true
    else if (r > l) rightAhead = true
  }
  if (leftAhead && rightAhead) return null
  if (leftAhead) return 1
  if (rightAhead) return -1
  return 0
}

/** A record with no fields written. */
export function emptyRecord() {
  return { fields: {} }
}

/**
 * Deterministic JSON: object keys sorted at every depth, array order preserved.
 *
 * Used for two things that both have to be stable across devices and across
 * Node versions — the identity of a head, and the tiebreak between concurrent
 * heads. `JSON.stringify` alone is not enough: it preserves insertion order, so
 * the same object built in a different order would compare unequal.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const body = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${body.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Code-unit string order, not `localeCompare`.
 *
 * `localeCompare` is locale-dependent, so two replicas under different locales
 * would break a tie in opposite directions and fail to converge — the same defect
 * class as an unpinned hash seed. `<` compares UTF-16 code units and is the same
 * everywhere.
 */
function strCompare(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** One head's identity: same version, same value, same claimant — the same write. */
function headKey(head) {
  return `${canonicalJson(head.clock)}|${canonicalJson(head.value)}|${head.actor}`
}

/** Whether `a`'s clock strictly dominates `b`'s. Equal clocks do not dominate. */
function dominates(a, b) {
  return compareClocks(a.clock, b.clock) === 1
}

/** A total order over heads, so a set of them sorts and a winner exists. */
function compareHeads(a, b) {
  return strCompare(canonicalJson(a.clock), canonicalJson(b.clock))
    || strCompare(String(a.actor), String(b.actor))
    || strCompare(canonicalJson(a.value), canonicalJson(b.value))
}

/**
 * The maximal writes of a set of heads — the antichain.
 *
 * Deduplicate first, then drop every head some other head strictly dominates.
 * Two heads with *equal* clocks but different values dominate neither, so both
 * survive and the field reads as conflicted: the same version claiming two
 * values is not a merge that can be made silently, and it is surfaced like any
 * other concurrency. The result is sorted so it is byte-identical wherever it was
 * produced — which is what lets a test compare two merge orders with `deepEqual`.
 */
function maximalHeads(heads) {
  const byKey = new Map()
  for (const head of heads || []) {
    if (!head) continue
    byKey.set(headKey(head), { value: head.value, clock: head.clock || {}, actor: head.actor })
  }
  const candidates = [...byKey.values()]
  return candidates
    .filter((head) => !candidates.some((other) => other !== head && dominates(other, head)))
    .sort(compareHeads)
}

/** The value a reader sees: the greatest maximal head, under a total tiebreak. */
function winnerOf(heads) {
  return heads.length ? heads[heads.length - 1].value : undefined
}

/** A field name and an actor are the two things the write cannot proceed without. */
function assertWrite(field, actor) {
  if (typeof field !== 'string' || !field) {
    throw new Error('a field write needs a field name')
  }
  if (typeof actor !== 'string' || !actor) {
    throw new Error(`a field write needs an actor id; the write on '${field}' named none`)
  }
}

/**
 * Writes one field, as the act of an actor who has seen `record`.
 *
 * The new clock is the join of everything this field currently holds, ticked at
 * `actor` — so the write is causally after every head it could see and therefore
 * *supersedes* all of them. That is what makes an edit mean "this is the value
 * now" rather than "this is another opinion", and it is why resolving a conflict
 * needs no special function: a person choosing a value is a write, and a write
 * collapses the antichain back to one head.
 *
 * Returns a new record; the caller's is untouched, so a failed sync leaves the
 * device exactly as it was.
 */
export function writeField(record, field, value, actor) {
  assertWrite(field, actor)
  const prior = record?.fields?.[field]?.heads || []
  const base = prior.reduce((clock, head) => mergeClocks(clock, head.clock), emptyClock())
  const head = { value, clock: tickClock(base, actor), actor }
  return { ...(record || {}), fields: { ...(record?.fields || {}), [field]: { heads: [head] } } }
}

/**
 * The value of a field: the deterministic winner among its maximal writes, or
 * `undefined` when the field was never written.
 *
 * The result is a pure function of the head set, so it converges with the set.
 * It is *not* the same as "the field is settled" — a conflicted field still
 * returns a value, because a surface has to render something. `fieldConflict` and
 * `conflictsOf` are what tell the surface it is looking at a question.
 */
export function readField(record, field) {
  return winnerOf(maximalHeads(record?.fields?.[field]?.heads))
}

/**
 * Every maximal write of a field — the raw candidates a surface can show.
 *
 * More than one means concurrent, unresolved writes. Exported so a conflict UI
 * can offer the choices without re-deriving them, and so a test can assert the
 * losers were kept rather than dropped.
 */
export function fieldHeads(record, field) {
  return maximalHeads(record?.fields?.[field]?.heads)
}

/**
 * The conflict on one field, or `null` when it is settled.
 *
 * A conflict carries both candidate values *and* the actors who wrote them,
 * because "resolved vs monitoring" is not enough for a person to choose between —
 * they need to know which device said which.
 */
export function fieldConflict(record, field) {
  const heads = maximalHeads(record?.fields?.[field]?.heads)
  if (heads.length < 2) return null
  return {
    field,
    candidates: heads.map((head) => ({ value: head.value, actor: head.actor, clock: head.clock })),
    actors: [...new Set(heads.map((head) => head.actor))],
  }
}

/**
 * Every unresolved field on a record, ordered by field name.
 *
 * The one function a surface must consult before it treats a record as settled.
 * An empty array is the only evidence that a record has no concurrent writes
 * pending, and it is cheap to ask.
 */
export function conflictsOf(record) {
  const fields = record?.fields || {}
  const conflicts = []
  for (const field of Object.keys(fields).sort()) {
    const conflict = fieldConflict(record, field)
    if (conflict) conflicts.push(conflict)
  }
  return conflicts
}

/**
 * Merges two versions of the same record. **This is the deliverable.**
 *
 * Returns `{ record, conflicts }`. `record` is convergent — commutative,
 * associative, idempotent — because every field is `f(local ∪ incoming)` and the
 * laws of `f` are proved in the header, not asserted. `conflicts` names every
 * field where the two versions were concurrent, with both values and both actors,
 * so the caller can ask rather than discover a lost edit later.
 *
 * The two records must name the same id. Merging versions of *different* records
 * is a caller error with no correct answer — there is no rule that says which
 * record survives — so it throws rather than guessing. This is the jurisdiction
 * the convergence guarantee is scoped to: same record, any arrival order.
 *
 * Non-field keys are carried from `local` unchanged. The merge owns the field
 * map; identity and coordination (ENH-39's submission id, the form version) ride
 * outside it and are not this function's to decide.
 */
export function mergeRecords(local, incoming) {
  const left = local || emptyRecord()
  const right = incoming || emptyRecord()
  const leftId = left.id ?? null
  const rightId = right.id ?? null
  if (leftId !== null && rightId !== null && leftId !== rightId) {
    throw new Error(
      `mergeRecords refuses to merge two different records (${leftId} and ${rightId}); `
      + 'identity is ENH-39\'s, and there is no rule that says which of two records is the record',
    )
  }

  const fields = {}
  for (const field of new Set([...Object.keys(left.fields || {}), ...Object.keys(right.fields || {})])) {
    const heads = maximalHeads([
      ...(left.fields?.[field]?.heads || []),
      ...(right.fields?.[field]?.heads || []),
    ])
    fields[field] = { heads }
  }

  const record = { ...left, id: leftId ?? rightId, fields }
  return { record, conflicts: conflictsOf(record) }
}

/** Asserted at import so a broken export cannot look like a working one. */
if (typeof mergeRecords !== 'function' || typeof compareClocks !== 'function') {
  throw new Error('public/shared/field-merge.js did not export the merge pair')
}
