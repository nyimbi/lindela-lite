# ADR-002: One JSONB table rather than a relational schema

**Status:** Accepted
**Applies to:** `src/postgres-store.js`, `src/store.js`, `src/storage.js`
**Deciders:** whoever needs a query the application does not already expose

## Context

The product has 39 record collections: hazards, climate observations, food-security classifications,
outbreak indicators, incidents, interventions, field reports, alert events, workflows, reports, KPI
snapshots, and so on. The relationships between them are real but shallow — a workflow points at an
alert event by id; a district overview joins hazards, assets, incidents and workflows — and almost
every read is "give me a collection, optionally scoped".

Two consumers pull in opposite directions:

- The **API** wants whole collections. Every request does one `store.read()` and renders.
- A **data user** wants relational access: `psql`, a BI tool, STAC and OGC consumers, and whoever
  asks the next question the API has not implemented.

A conventional schema would answer the second audience well and the first adequately. The first
audience is the product.

## Decision

One table.

```sql
CREATE TABLE lite_records (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX lite_records_collection_updated_idx
  ON lite_records (collection, updated_at DESC);
```

Records are documents, not rows. The application normalises shape on write (`src/schema.js` owns every
vocabulary) and the schema is therefore evolvable without migrations.

The JSON backend is the same interface with a file behind it, so the entire product runs with no
database at all.

## Options considered

### Conventional relational schema, one table per collection

| Dimension | Assessment |
|---|---|
| Query expressiveness | High — real joins, real constraints |
| Migration burden | Every schema change is a migration, on a product deployed by `one-click.sh` |
| Read cost for the API | Low but not free — 39 collections become 39 queries or one big `UNION` |
| Shape evolution | Poor — a connector that starts sending a new field needs a column |
| Operational surface | Highest — the most likely thing to fail in a district office |

**Rejected.** The decisive cost is shape evolution. Ingestion is the hot path and its shape is decided
by sixteen third-party providers, several of which change their payloads without notice.

### Document database (MongoDB, CouchDB)

| Dimension | Assessment |
|---|---|
| Shape flexibility | Excellent |
| Operational burden | A new service to run, secure and back up |
| Postgres JSONB parity | Effectively complete for this workload — indexing, transactions, `jsonb_exists` |

**Rejected.** It buys what `JSONB` already buys and costs a deployment the product does not need.
`docker-compose.yml` has two services, not three.

### Two tables: documents plus a relational index over the queried fields

**Considered, deferred.** A partial index on `(collection, region_name)` or `(collection,
payload_hash)` covers the two queries that dominate — and one of them, `payload_hash`, already exists.
If a third hot query appears, add a generated column rather than a table.

## Consequences

**Easier**

- No migrations. A connector adding a field needs no schema change and no deploy.
- The API's read path is one query regardless of how many collections it needs.
- The product runs from a JSON file. `LINDELA_LITE_DB_MODE=auto` falls through Postgres → embedded
  Postgres → JSON with no code change.
- STAC and OGC consumers get the same documents the application already produced.

**Harder**

- **No referential integrity.** A workflow can point at an alert event that does not exist. The
  application resolves these joins at read time, and a broken reference renders as an empty field
  rather than an error.
- **No cross-collection query.** "Alerts in Bor that have no workflow" is an application question, not
  a SQL one. Every new analytic is a code change, and `docs/platform.md` lists six routes that exist
  as a backend with no UI.
- **`JsonStore` and `PostgresStore` can drift.** They share an interface, not an implementation, and
  have drifted: `PostgresStore.replaceAnalytics` once took four parameters against `JsonStore`'s six,
  silently discarding `population_at_risk` and `facilities_at_risk`, and delegated to `merge()` where
  `JsonStore` replaced — so the two backends disagreed about whether a de-scoped region kept its last
  risk score. Both are now correct, and the class of bug is worth a test rather than a memory.

**Revisit when**

- A query becomes hot that the application cannot serve without reading every collection. The answer
  is a materialized view or a generated column, not a second store.
- Write concurrency becomes a problem. `PostgresStore.write` deletes and reinserts within a
  transaction, which is a whole-table rewrite; `refreshAnalytics` uses `replaceAnalytics`, which is
  per-collection. Anything that needs to write more than a few collections at once under load will want
  `upsertCollection` throughout.

## A note on the silent-drop failure mode

`COLLECTIONS` in `src/store.js` is load-bearing: `JsonStore.merge` and `PostgresStore` both key
strictly off it, and a collection missing from the list has its records dropped with no error. The
source is explicit — *"an unlisted collection's records are dropped silently — the same class of bug
the runIngestion merged map had"* — and registration tests assert on `emptyStore()` for the three
collections added after their own incidents.

The parallel list inside `runIngestion` had drifted independently and cost two sources their ability
to report success. All three now derive from one list. This is the single most repeated structural bug
in the codebase, and it is worth treating as a design smell rather than three coincidences.

Related: [ADR-003](ADR-003-content-hash-idempotency.md)