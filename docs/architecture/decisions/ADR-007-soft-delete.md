# ADR-007: Soft delete rather than hard delete

**Status:** Accepted
**Applies to:** `src/operations.js` (`buildSoftDelete`, `isDeleted`, `actionLog`), `src/server.js`
(operational routes, `apply-retention`)
**Deciders:** whoever adds an operational collection, or describes the platform's retention story

## Context

The product keeps a history of what was done: incidents opened and closed, interventions planned
and paused, tasks assigned and completed, field reports from the district, resources deployed and
returned. `action_logs` records every one of those, as a separate collection, keyed by
`collection` + `record_id`:

```js
export function actionLog(collection, action, record, actor = 'operator', subject = null) {
  ...
  id: stableId('log', [collection, action, record.id, now]),
  collection,
  record_id: record.id,
  action,
  summary: `${action} ${OPERATIONAL_COLLECTIONS[collection] || 'record'} ${record.id}`,
```

`OPERATIONAL_COLLECTIONS` is exactly five entries — `incidents`, `interventions`,
`intervention_tasks`, `field_reports`, `response_resources` — and those are the only collections
that can be deleted at all. `DELETE` on `action_logs` is refused with 405: *"Action logs are
read-only."*

Hard delete would break that trail immediately. A log entry pointing at an id with no row behind it
is a history of actions on records the product can no longer show, which is worse than no history,
because it looks like history.

## Decision

Soft delete, in five collections, with two stamped fields.

```js
const merged = { ...existing, deleted_at: new Date().toISOString(), deleted_by: actor || null }
```

The reason is written on the function (`src/operations.js:70-75`):

> *"Soft-deletes an operational record by stamping deleted_at and deleted_by. Records are never
> removed from the store so action-log history and any downstream references (tasks →
> interventions, field_reports → incidents) stay resolvable."*

`isDeleted` is `Boolean(record?.deleted_at)`. It is applied at read time in six places:
`operationalSummary`, `counts` (so `/api/v1/health` and `/api/v1/assessments` agree), the
collection GET, the single-record GET, the PATCH guard and the `road_access` filter. A record with
`deleted_at` set is invisible to live counts and to every default read, and reachable by
`?include_deleted=true` and by id.

Three properties make it hard to get wrong:

- **Deleting twice is a 409, not a second stamp.** `buildSoftDelete` throws *'Record is already
  deleted'*. The tombstone has one author and one moment.
- **A client cannot un-delete by PATCHing.** Every operational normalizer carries the fields through
  `input.deleted_at || existing?.deleted_at || null`, so `deleted_at: null` falls back to the
  existing value and the 409 holds.
- **A soft delete re-runs the normaliser.** `buildSoftDelete` takes the store snapshot and re-derives
  fields, because the normalizers cross-reference a parent to backfill derived values. Deleting a
  field report can therefore change fields other than the two stamps. That is a real cost, and it is
  the reason for it — see **Harder**.

## Options considered

### Hard delete

| Dimension | Assessment |
|---|---|
| Storage reclaimed | Yes, immediately |
| Audit trail | Broken. `action_logs` points at nothing; the read-only log becomes a list of ghosts |
| Downstream references | A deleted intervention leaves its tasks parentless, with no referential integrity to catch it ([ADR-002](ADR-002-single-table-jsonb-store.md)) |
| `include_deleted` | No meaning |
| Reversibility | None |

**Rejected.** It trades the one thing the product is for — a record of what happened — for disk
space that is not scarce at this scale.

### A separate audit collection, and delete from the main one

| Dimension | Assessment |
|---|---|
| Storage reclaimed | Yes |
| Audit trail | Present, if the audit entry embeds the record's fields |
| Faithfulness | The audit copy is a snapshot taken at delete time, so it diverges from what the record actually was at delete time unless it embeds the pre-delete state |
| Cost | A second writer per delete, a second normalizer, a second place to get it wrong |

**Considered, rejected.** It is the same decision with an extra table. The gain — reclaiming space —
is real but small, and the divergence problem is real and permanent: with soft delete, the record
in the store *is* the record as it was when deleted, because deleting it does not modify anything
else except by re-deriving.

### Tombstones with a scheduled purge

| Dimension | Assessment |
|---|---|
| Eventual storage reclaimed | Yes |
| Trail resolvable | Only until the purge runs |
| Needs | A scheduler, an age threshold, and a rule for what age |
| Fits this product | No — `docs/architecture/decisions/ADR-009-external-scheduler.md` deliberately keeps scheduling out of the process |

**Rejected.** This is hard delete with a delay, and the delay is the only thing soft delete does not
need. It also converts an at-most-once question into an idempotency question: what happens if the
purge runs twice, or runs against a store that was restored from a backup taken before the purge?

### Event sourcing

| Dimension | Assessment |
|---|---|
| Audit completeness | Total, by construction |
| Fit | Wrong shape. The product reads current state constantly and history occasionally |
| Cost | Every read becomes a fold over an event log; `operationalSummary` currently reads four collections and filters them |
| Migration | Every one of the 39 collections becomes an event stream |

**Rejected.** The log that already exists is an event log — `action_logs` is append-only and
read-only. Soft delete is the cheapest way to make the projection consistent with it.

## Consequences

**Easier**

- An `action_logs` entry always resolves. There is no state in which the product records an action
  on a record it cannot display.
- `tasks → interventions` and `field_reports → incidents` survive their parent being deleted,
  because the parent is still there. Nothing has to decide what "orphan" means.
- Undo is a `PATCH` clearing the stamp on a record nobody can find, because the record is still
  there.
- Live counts and default reads are computed by one predicate, `isDeleted`, at read time. Nothing
  has to be migrated when a record is deleted.

**Harder**

- **Storage is never reclaimed by an operator delete.** Soft-deleted rows stay in the JSON file and
  in `lite_records` forever. On `JsonStore` that matters more than usual, because `merge` rewrites
  the whole file for a single record — a delete costs a full-file serialisation and a full disk of
  `deleted_at`-stamped rows.
- **The soft delete is visible in full to anyone who asks.** `?include_deleted=true` returns the
  entire record, not a tombstone. A soft-deleted field report still carries its reporter's details.
  Soft delete is not a privacy control and must not be described as one.
- **Deletion changes fields other than the two stamps.** Because `buildSoftDelete` re-runs the
  normaliser against the store snapshot, a delete is a derived-field recomputation. It is
  deterministic, but it means "what changed" is not "two fields changed".
- **Every read path must remember to filter.** There is no database constraint doing it. A new
  endpoint that forgets `isDeleted` publishes deleted records, and the tests that would catch it do
  not exist until someone writes them.
- **`road_access` honours `?include_deleted=true` and nothing else does.** `GET /api/v1/road-access`
  (`src/server.js:733`) reads the flag and filters on `isDeleted`, exactly like the five operational
  routes. But `road_access` is one of the six derived collections `replaceAnalytics` rewrites
  wholesale — it is computed, never deleted, and no record in it ever carries `deleted_at`. The flag
  is inert. It is a second, wrong copy of the operational read pattern in a collection that is not
  operational. Either the six derived collections should refuse the flag with a 400, or the flag
  should not be there.

## The wrinkle: `apply-retention` used to delete nothing

This has to be recorded, because for most of this product's life the retention endpoint was a lie.

`POST /api/v1/maintenance/apply-retention` computes an expiry set from `field_reports` and
`rapidpro_inbound_messages` against `policy.retentionDays` (`src/pii.js:67`), then used to hand the
**kept** records back to `store.merge()`. Neither store had a delete path — `merge` upserts by id and
cannot remove — so the expired rows were counted, reported as
`{success: true, field_reports: {expired: 1}}`, and left exactly where they were.

The defect is recorded as **DAT-07**:

> *"This is the worst combination in the codebase: the operator asks for deletion of personal data,
> receives `{success: true}`, and has a false compliance record."*

It was reproduced, fixed on 2026-10-03, and is now guarded: `JsonStore.remove()` filters the doomed
ids out of the collection, `PostgresStore.remove()` issues
`DELETE FROM lite_records WHERE collection = $1 AND id = ANY($2::text[])`, both refuse an unknown
collection rather than ignoring it, and `store-conformance.test.js` runs the same
*deletes the records it reports as expired* case against both backends. The endpoint had no test at
all before that.

**What the ADR requires before this is called retention.** The capability exists now, so the
remaining requirements are about the description, not the code:

1. **A test that asserts the deletion, not the count.** The original endpoint had a test-shaped
   surface — it returned `expired: 1` — and no assertion on the store. Any retention claim is
   backed by a read-back after the call, on both backends.
2. **Retention is the one hard delete, and it should say so.** `field_reports` is a soft-delete
   collection, and `apply-retention` removes its rows outright. That is the correct tension to hold
   open: an operational delete keeps the record, a PII retention purge must not, because the whole
   purpose is that the personal data stops existing. Anything described as "deletion" in this
   product should be one or the other, and the docs should never let the word cover both.
3. **`docs/api.md` currently overstates this route in the other direction.** It documents a
   `dry_run` body flag, an `{success, affected, dry_run}` response, and *"Writes an action_log entry
   per affected collection."* None of those exist in the implementation — no `dry_run`, no
   `affected`, no `action_logs` written. A retention endpoint that claims a dry run it does not have
   is the same false compliance record DAT-07 was about, in the documentation rather than the code.
4. **`docs/architecture/data-model.md` is stale on this point.** Its "Nothing hard-deletes a row"
   note describes the pre-DAT-07 code. It should be corrected, or an operator reading the data model
   will conclude, correctly for the wrong reason, that no deletion is possible.

## Revisit when

- Storage becomes the binding constraint rather than a rounding error. At that point the answer is a
  purge with an age threshold and an export-first step, not the removal of soft delete.
- `road_access` or any other derived collection becomes deletable, in which case the
  `include_deleted` flag question above has to be answered before it is copied a seventh time.
- A PII obligation requires that a soft-deleted record's personal fields be unreadable. Soft delete
  does not provide that, and redaction on write plus hard purge on retention is the only honest
  answer.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md),
[ADR-004](ADR-004-sensitivity-is-not-a-probability.md)
