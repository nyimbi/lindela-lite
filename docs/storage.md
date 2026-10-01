# Storage

Lindela Lite can run with embedded/local PostgreSQL through `pg0`, an external PostgreSQL database, or the original JSON store.

## Modes

| Mode | Configuration | Use case |
| --- | --- | --- |
| `auto` | default | Prefer external Postgres if configured, then pg0 if installed, then JSON fallback. |
| `pg0` | `LINDELA_LITE_DB_MODE=pg0` | Local open-source deployment with real PostgreSQL and no Docker. |
| `postgres` | `LINDELA_LITE_DB_MODE=postgres` plus `LINDELA_LITE_DATABASE_URL` | Hosted/community deployment or production-like environments. |
| `json` | `LINDELA_LITE_DB_MODE=json` | Lightweight fallback, demos, and tests. |

## pg0 Local Mode

Install `pg0` using the upstream instructions, then run:

```bash
LINDELA_LITE_DB_MODE=pg0 npm start
```

Lindela Lite runs `pg0 start` and connects to:

```text
postgresql://postgres:postgres@127.0.0.1:5432/postgres
```

Override the binary or URL when needed:

```bash
PG0_BIN=/path/to/pg0 LINDELA_LITE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres LINDELA_LITE_DB_MODE=pg0 npm start
```

`pg0` is recommended for local open-source use. For production or hosted deployments, use `postgres` mode with an externally managed database.

## External PostgreSQL

```bash
LINDELA_LITE_DB_MODE=postgres LINDELA_LITE_DATABASE_URL=postgresql://user:password@localhost:5432/lindela_lite npm start
```

The server creates one table, `lite_records`, and stores each collection record as JSONB. This keeps the current API stable while making migration to relational or geospatial tables straightforward later.

### Writes are incremental

`POST`-style mutations go through `merge()`, which upserts only the records
in the request. An earlier implementation loaded the entire store, issued
`DELETE FROM lite_records`, and reinserted every row — so one new incident
rewrote every hazard event in the database. Measured against 5,000 hazard
events, ten single-record merges took **23.5s before and 201ms after**.

Upserts shallow-merge the incoming body over the stored one, so a partial
update preserves fields the caller did not send. This matches the JSON store's
`mergeById()` semantics.

### `payload_hash` deduplication

Records ingested from an upstream source carry a `payload_hash`. `merge()`
skips a record whose hash is already present in the collection, which makes
re-running an ingestion idempotent.

To check that without loading every body, the hash is stored in a real
`payload_hash` column with a partial index on `(collection, payload_hash)`,
rather than being read out of the JSONB body. On startup `ensureSchema()`
backfills the column from `body->>'payload_hash'` for rows written before the
column existed, so upgrading an existing database keeps deduplication working
instead of silently re-ingesting duplicates.

`ensureSchema()` is idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF
NOT EXISTS`, and a backfill that only touches rows where the column is still
NULL.

## JSON Fallback

```bash
LINDELA_LITE_DB_MODE=json npm start
```

JSON mode stores data in `data/lindela-lite-store.json` or the path set by `LINDELA_LITE_STORE`. Files under `data/*.json` are ignored by git.

## Health Check

`GET /api/v1/health` includes the active storage mode:

```json
{
  "storage": { "mode": "pg0" }
}
```

## Operational Notes

- `auto` mode is forgiving for first-run users.
- Explicit `pg0` or `postgres` mode fails loudly if the required database cannot start or connect.
- Do not commit local JSON stores, database dumps, or downloaded source data.
- The current schema intentionally avoids full Lindela internal schemas, source reputation systems, or enterprise orchestration tables.

## Verification Commands

Validate JSON mode and API tests:

```bash
npm test
```

Validate external PostgreSQL mode:

```bash
LINDELA_LITE_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/lindela_lite_test npm run test:postgres
```

Validate local pg0 mode when the OS allows PostgreSQL shared memory:

```bash
PG0_BIN=/path/to/pg0 npm run verify:pg0
```

In restricted sandboxes, pg0 may fail during PostgreSQL shared-memory initialization even when the binary itself is installed correctly. Use the external PostgreSQL integration test in those environments.
