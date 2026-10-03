# ADR-003: Content-hash idempotency for ingestion

**Status:** Accepted — the canonicalisation defect below was found and fixed in `canonicalHash`
**Applies to:** `src/utils.js`, `src/store.js`, `src/ingestion.js`, `src/postgres-store.js`
**Deciders:** whoever changes how records are identified, hashed or merged

## Context

Sixteen connectors poll third-party feeds on a schedule ([ADR-009](ADR-009-external-scheduler.md)),
and every one of them will, on some run, return data the store already holds. The
`gdacs_archive` walk re-crawls forty years; `gdacs` alone is polled every 60 minutes against a
feed that republishes the same events. Re-ingestion is therefore the normal case, not the exception,
and the store has to answer one question on every record:

> Is this the same thing I already have, or the same content under the same identity?

Answering that with a timestamp is a trap. A feed that stops updating looks identical to a feed that
was never ingested, and a record re-served with a corrected value looks identical to a record that
was already correct. Neither can be resolved by comparing timestamps.

Two identities are needed, and they are not the same thing:

- **Entity identity** — *is this the same river flood, the same district asset, the same month of
  rainfall?* It has to be derived deterministically from the record's natural key, because the
  upstream id is not always present, is not always stable, and is occasionally reused.
- **Content identity** — *has anything about this record actually changed?* It has to be derived from
  the bytes, because that is the only thing that can tell a re-fetch from a correction.

## Decision

Both, and they are kept separate.

**Entity identity** is `stableId(prefix, value)` (`src/utils.js:4`) — SHA-256 over the JSON of a
natural-key array, truncated to 16 hex characters. Connectors supply their own keys:
`stableId('hazard', ['gdacs', parsed.source_id || item.link || item.title])` in
`src/connectors/gdacs.js:30`, `stableId('climate', ['chirps', date])` in
`src/connectors/chirps.js:73`, `stableId('disease', [indicator.code, row.SpatialDim, year])` in
`src/connectors/who-gho.js:119`. The key is the thing the source itself treats as the identity, so a
record keeps its id across updates instead of accumulating as a new row.

**Content identity** is `canonicalHash(record)` (`src/utils.js:35`), assigned in
`runIngestion` at `src/ingestion.js:145-147` if the connector did not set it. Two details make it
work, and both are load-bearing:

- **Key order is canonicalised at every depth.** `canonicalise` (`src/utils.js:25`) recursively sorts
  object keys before stringifying, so two JSON objects with the same pairs hash the same regardless
  of insertion order.
- **Locally-owned fields are excluded.** The default `ignoreKeys` (`src/utils.js:35`) drops `id`,
  `payload_hash`, `ingested_at`, `generated_at`, `updated_at`, `created_at` and `first_seen_at`.
  Otherwise every run would produce a new hash and nothing would ever be recognised as unchanged.

**The merge keys on both.** `mergeById` (`src/store.js:161`) builds two maps over the existing
collection — one keyed by `id`, one keyed by `payload_hash` — and for each incoming record:

```js
if (item.payload_hash && hashMap.has(item.payload_hash)) continue   // src/store.js:175
map.set(item.id, { ...map.get(item.id), ...item })                 // src/store.js:178
```

An unchanged re-fetch costs no write. A changed one merges over the existing row so a corrected
upstream value wins. `first_seen_at` is stamped once, at first ingest (`src/ingestion.js:148-150`)
and never refreshed, so the column answers "when did we first see this" and not "when did we last
write this row".

`PostgresStore` mirrors the query side with a partial index on `(collection, payload_hash)`
(`src/postgres-store.js:50-54`) plus a backfill that populates the column for rows written before it
existed.

## Options considered

### Timestamps and `updated_at > last_seen` guards

| Dimension | Assessment |
|---|---|
| Implementation | Trivial — one comparison per record |
| Correctness on a re-fetch | Fails immediately: the record is newer, so it is written again |
| Correctness on a correction | Works, but only if the whole row is replaced |
| Correctness on a withdrawn upstream record | Nothing ever removes a row, so a retraction is invisible |
| Works with a JSON-file store | Only with an application-side diff of every record |

**Rejected.** A timestamp answers "when did this arrive", which is not the question. It cannot
distinguish a republish from a revision, and it cannot be indexed in SQL.

### Replace the collection on every run (write-through, last-writer-wins)

| Dimension | Assessment |
|---|---|
| Cost | One delete and one reinsert per collection |
| Ingestion history | Destroyed — `source_runs` is itself a collection |
| Failure mode | A run that returns nothing wipes the collection |
| Postgres | `PostgresStore.write` is a whole-table rewrite |

**Rejected.** It makes an upstream's worst minute into the product's worst minute.

### Trust the upstream id alone

| Dimension | Assessment |
|---|---|
| Implementation | Free — no hashing at all |
| `gdacs` | `parsed.source_id \|\| item.link \|\| item.title` — the title is part of the fallback key |
| Sources with no id | `chirps`, `open_meteo`, `who_gho` have no per-record identifier at all |
| Change detection | None. An upstream edit is indistinguishable from a re-fetch |

**Rejected.** Half the sources have no identifier, and none of them guarantees stability.

### Drop content hashing and accept duplicate rows

**Considered.** Duplicates are visible, and a dashboard can filter them.

**Rejected.** `first_seen_at`, the source-health view and the KPI counts are all computed over stored
records. Duplicates are not a display problem, they are a measurement problem, and they are silent.

## Consequences

**Easier**

- **Re-ingestion is free and safe.** Running a connector twice in a minute changes nothing, which is
  what makes the on-demand backfills in `docs/ingestion.md` safe to retry by hand.
- Corrections propagate. A corrected upstream value produces a new hash, misses the skip, and merges
  over the row.
- `first_seen_at` is trustworthy, because it is stamped under an `if (!record.first_seen_at)` guard
  that a re-fetch cannot reach.
- Both backends agree on the semantics, so switching from the JSON file to Postgres does not change
  what a second run does.

**Harder**

- **The canonicalisation has a failure mode that is invisible from the outside.** The comment at
  `src/utils.js:9-24` records it: the previous implementation passed a key allowlist as the second
  argument to `JSON.stringify`, which applies *at every level of nesting*. Only top-level keys
  survived, so a change confined to `metadata` produced an identical hash and the update was silently
  discarded. Since connector metadata is where qualifications and provenance live, the one field that
  must be able to change was the one that could not. The fix is nine lines and one comment, and the
  general lesson is that a hash function which is *nearly* correct is worse than one that is not,
  because the failure has no symptom.
- **The content skip is global to the collection, not to the id.** `hashMap` is keyed on
  `payload_hash` alone, so an upstream that re-issues an identical record under a new id produces no
  new row. That is correct for re-fetch and wrong for a genuine second entity with identical content.
  Nothing in the code distinguishes the two, because nothing upstream can.
- **Merges never remove fields.** `{ ...existing, ...incoming }` cannot express a key the upstream has
  dropped. A renamed field leaves the old one behind, and the record carries both until something
  else overwrites the value.
- **The Postgres side is indexed, not enforced.** `src/postgres-store.js:50` is a *partial index* on
  `(collection, payload_hash)`, not a unique constraint. The skip is application behaviour in both
  backends; nothing at the database level would stop a duplicate. (`docs/architecture/ingestion.md`
  describes it as a unique index — it is not.)
- **Lineage inherits the same weakness.** `recordLineage` derives one `upstream_checksum` from the
  hashes of the whole batch (`src/lineage.js:5-6`), so it detects that *something* changed, not which
  source changed. `docs/architecture/ingestion.md` records this as a known defect.

**Revisit when**

- A connector starts emitting a real, stable upstream identifier. Entity identity should move from a
  derived natural key to that id, with the derived key retained as a fallback.
- Duplicate detection needs to be a database invariant rather than application behaviour, in which
  case the partial index becomes a unique index and `mergeById` becomes an `ON CONFLICT`.
- Field-level removal is needed — an upstream that renames a field is currently additive-only. The
  answer is a per-connector field manifest, not a smarter merge.

## The general shape

This is the same idea as [ADR-002](ADR-002-single-table-jsonb-store.md) seen from the write path:
because records are documents rather than rows, identity has to be carried inside the document rather
than declared by the schema. Two of the three load-bearing keys — `id` and `payload_hash` — are
content, and only the `(collection, id)` pair is structural.

Related: [ADR-002](ADR-002-single-table-jsonb-store.md), [ADR-006](ADR-006-exclude-gdelt.md)