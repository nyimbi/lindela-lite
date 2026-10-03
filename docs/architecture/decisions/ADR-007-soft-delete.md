# ADR-007: Soft delete rather than hard delete

**Status:** Accepted — the hard-delete defect below is recorded in `src/store.js:114-124`
**Applies to:** `src/operations.js`, `src/server.js`, `src/store.js`, `src/pii.js`
**Deciders:** whoever writes a destructive endpoint, or a retention policy

## Context

Operational records in this product form a graph, not a list. A task points at an intervention, an
intervention at an incident, a field report at an incident, and every operational mutation writes an
`action_log` entry naming the record and the actor. Deleting a row from the middle of that graph
breaks it in a way the schema cannot express — there are no foreign keys to cascade, because
[ADR-002](ADR-002-single-table-jsonb-store.md) chose one JSONB table over a relational schema, so
referential integrity is an application problem and a missing row is not an error, it is an empty
field.

That has a second, sharper consequence on the **write** path. `mergeById` keys on `id`
(`src/store.js:161`) and there was no counterpart operation: until `JsonStore.remove` existed,
`src/store.js:117-120` records, *"there was no path by which a record could ever leave the store."*
`apply-retention` computed its survivors and wrote them back over the top of the originals, so a
correct run returned `{success: true, expired: 1}` **and deleted nothing**. The endpoint reported the
outcome it intended rather than the one it achieved, which is the failure mode this whole repository
keeps running into.

The uncomfortable part of the context is that hard delete is what the word "delete" means, and every
operator who types it expects the record to be gone.

## Decision

**Operational records are soft-deleted. The row stays; it is stamped and filtered.**

```js
const merged = { ...existing, deleted_at: new Date().toISOString(), deleted_by: actor || null }
```

`buildSoftDelete` (`src/operations.js:76`) stamps two fields and re-runs the collection's normalizer,
so a soft-deleted record has exactly the shape of a live one. `isDeleted` (`src/operations.js:97`) is
`Boolean(record?.deleted_at)` — one predicate, used everywhere.

Reads filter unless the caller asks otherwise:

- `src/server.js:2117` — collection reads apply `!isDeleted(item)` unless `includeDeleted`
- `src/server.js:2124` — a single-record read 404s on a deleted record, again unless `includeDeleted`
- `src/server.js:2159` — updates are refused on an already-deleted record
- `src/server.js:736` — `road_access` filters deleted rows out of the derived surface

Every normalizer round-trips both fields rather than stripping them
(`deleted_at: input.deleted_at || existing?.deleted_at || null`, e.g. `src/operations.js:149`), which
is what makes a soft delete survive a subsequent update.

`buildSoftDelete` also refuses a second delete with `409 Record is already deleted`
(`src/operations.js:78-80`). Un-deleting is not an operation.

**Hard delete exists, and is scoped.** Two places, both deliberate:

- `JsonStore.remove({ collection: [ids] })` (`src/store.js:125`) is the storage capability that
  retention needs. It throws on an unrecognised collection rather than ignoring it — the same
  reasoning as `COLLECTIONS` itself.
- `POST /api/v1/maintenance/apply-retention` (`src/server.js:627-630`) applies
  `applyRetention` to `field_reports` and `rapidpro_inbound_messages`, splits into
  `{kept, expired}` (`src/pii.js:67`) and writes back. Those two collections hold personal data —
  names, phone numbers, locations — and a retention window that leaves the data in place has no
  meaning.

So the rule is not "never delete". It is: **operational records are stamped, personal data is
purged.** The comment at `src/operations.js:71-74` states the first half and its reason: *"Records
are never removed from the store so action-log history and any downstream references (tasks →
interventions, field_reports → incidents) stay resolvable."*

## Options considered

### Hard delete everywhere

| Dimension | Assessment |
|---|---|
| Matches the operator's expectation | Yes |
| Graph integrity | Broken — `includeDeleted` cannot exist, and references resolve to empty fields |
| Audit trail | The `action_logs` entries outlive their subjects and point at nothing |
| Retention compliance | The only thing that satisfies it |
| Undo | Impossible. There is no backup path in the one-click deployment |

**Rejected** for operational collections. Note that it is the correct choice for personal data, which
is why it is kept for two collections rather than abandoned.

### Tombstones — a `deleted` boolean

| Dimension | Assessment |
|---|---|
| Marginally smaller than a timestamp | Yes |
| Answers "who, and when" | No — both are required by `src/operations.js:81` |
| Answers "was this deleted before the audit window started" | No |

**Rejected.** `deleted_at` and `deleted_by` are one `if (existing.deleted_at)` away from each other,
and the audit trail is the point of keeping the row.

### Soft delete plus an `include_deleted=true` escape hatch everywhere

**Rejected as a default.** It exists (`src/server.js:2117`) and is opt-in per request, but the
operational endpoints deliberately do not expose it: a CHW-facing app that could list deleted
incident records would be listing records a coordinator removed on purpose.

### Purge after a grace period

**Considered.** It is the obvious completion of the policy and it is not implemented.

**Rejected for now**, for the same reason `apply-retention` is manual
([ADR-009](ADR-009-external-scheduler.md)): an unattended purge is irreversible, and nothing in the
current deployment has a backup to restore from. This is a genuine gap, not a design.

## Consequences

**Easier**

- **The graph stays resolvable.** A task whose intervention was soft-deleted still resolves to it.
- **An accidental delete is recoverable.** `deleted_at` is data; clearing two fields restores the
  record through the normal update path.
- **The audit trail is not orphaned.** `actionLog` (`src/operations.js:101`) writes
  `stableId('log', [collection, action, record.id, now])` against a record that will still be there.
- **Deleted-records questions become answerable.** "Who removed this, and when?" is a query over the
  collection, not a log reconstruction.
- Retention compliance is unaffected, because it was never on the same code path.

**Harder**

- **Every read has to remember.** The filter is applied by hand at each read site. A new endpoint
  that forgets `!isDeleted` will serve deleted records and no test will catch it — the same silent-
  omission class that `countRecords` has.
- **The fields never go away.** `deleted_at` and `deleted_by` ride along on every operational record,
  including the vast majority that are live, and they are carried into exports and reports.
- **`deleted_at` is not the same as deleted.** A record soft-deleted at 14:00 can still be updated
  through any path that does not check `isDeleted`. The server route checks
  (`src/server.js:2159`); a direct `store.merge` call does not.
- **Storage grows without bound for the two purged collections too.** `apply-retention` is a manual
  endpoint ([ADR-009](ADR-009-external-scheduler.md)), so personal data sits in the store until
  someone POSTs. That is a compliance gap that the decision knowingly leaves open.
- **There is no un-delete endpoint**, and adding one contradicts `src/operations.js:78-80`. Recovery
  means a direct store edit.

**Revisit when**

- An operator-facing "restore deleted record" need appears. It should be a new endpoint with its own
  `action_logs` entry, not a relaxation of the 409.
- Backup and restore exists in the deployment, at which point the grace-period purge becomes
  implementable and the retention endpoint can move onto the scheduler.
- A collection holds personal data *and* is referenced by another collection. Today the split is
  by collection; if that stops being true, retention has to become per-record.

## The general shape

Soft delete here is not primarily a data-retention choice — retention is handled separately and does
delete. It is a **reference-integrity** choice, adopted because
[ADR-002](ADR-002-single-table-jsonb-store.md) moved referential integrity out of the database and
into application code, where a deleted row has no way to announce itself. The uncomfortable residue
is that every read site now carries a manual filter, and a manual filter is a promise rather than a
constraint.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md), [ADR-009](ADR-009-external-scheduler.md)