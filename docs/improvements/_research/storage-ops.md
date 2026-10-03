# Storage, operations and reporting audit

Scope: `src/store.js`, `src/postgres-store.js`, `src/pg0.js`, `src/storage.js`, `src/schema.js`,
`src/lineage.js`, `src/operations.js`, `src/outbox.js`, `src/workflows.js`, `src/webhooks.js`,
`src/reports.js`, `src/pdf.js`, `src/cap.js`, `src/rapidpro.js`, `src/community.js`,
`src/sanctions.js`, `src/observability.js`, plus `src/pii.js`, `src/auth.js`, `src/utils.js` and
the `src/server.js` route handlers that write to them.

Every defect below is quoted from the line cited. Where a claim is "not called anywhere", the
repo-wide grep result is stated.

---

## Defects

### D1 — Retention purges nothing; the two collections the policy targets are never pruned

**Severity: Critical** (regulatory — right-to-erasure / data-protection obligation claimed as met)

`src/server.js:373-380`

```js
  if (req.method === 'POST' && url.pathname === '/api/v1/maintenance/apply-retention') {
    const policy = await loadPolicy()
    const fieldReportRetention = applyRetention(data.field_reports, policy.retentionDays)
    const inboundRetention = applyRetention(data.rapidpro_inbound_messages, policy.retentionDays)
    await store.merge({
      field_reports: fieldReportRetention.kept,
      rapidpro_inbound_messages: inboundRetention.kept,
    })
```

`applyRetention` (`src/pii.js:46`) correctly partitions into `kept` and `expired`. The caller then
passes only `kept` to `store.merge`. **Neither store adapter has a delete operation.** `JsonStore.merge`
(`src/store.js:75-84`) calls `mergeById`, which is an upsert. `PostgresStore.merge`
(`src/postgres-store.js:97-120`) is an `INSERT ... ON CONFLICT DO UPDATE`. Nothing is ever removed.

Failure scenario: an operator runs `POST /api/v1/maintenance/apply-retention` daily for a year against
the documented 365-day policy. The response reports `expired: 412` on every run and returns
`success: true`. Every one of those 412 field reports — symptoms, locations, `reported_by` — is still
in `field_reports` in both backends, and still returned by `GET /api/v1/field-reports`. The route is
documented as "removes records older than the retention window" (`docs/api.md:565`) and `docs/unicef-requirements-traceability.md:147`
marks requirement 5.4 "Met". Neither statement is true.

The same commit also writes no `action_logs` entry, so there is no record that a purge ran or what it
touched — noted independently at `docs/platform-jtbd-catalogue.md:117`.

Fix: add `store.deleteWhere(collection, predicate)` to both adapters (`DELETE FROM lite_records WHERE collection=$1 AND body->>'field_report_id' ...`
for PG; filter-and-rewrite for JSON), and call it with the `expired` set inside the same operation.
Add a `action_logs` entry naming the collection and the count, and a `dry_run=true` parameter that
returns counts without writing.

---

### D2 — `PostgresStore.write()` truncates the whole table and wipes the `payload_hash` column

**Severity: Critical**

`src/postgres-store.js:69-95`

```js
  async write(data) {
    await this.ensureSchema()
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM lite_records')
      for (const collection of COLLECTIONS) {
        for (const item of next[collection] || []) {
          await client.query(
            `INSERT INTO lite_records (collection, id, body, updated_at)
             VALUES ($1, $2, $3::jsonb, now())
             ON CONFLICT (collection, id)
             DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
            [collection, item.id, JSON.stringify(item)],
          )
```

Three separate problems in one method:

1. `DELETE FROM lite_records` has no `WHERE` clause. Any row in a collection not present in the
   hardcoded `COLLECTIONS` array is destroyed. See D9 for how those rows get there.
2. The INSERT column list omits `payload_hash`. Every row it writes gets `payload_hash = NULL` (new
   rows) or retains its prior value (conflict rows), but since `DELETE` ran first, *every* row is
   reinserted with `NULL`. `upsertCollection` (`src/postgres-store.js:132-136`) dedupes against the
   **column**, not the body:
   ```js
   `SELECT payload_hash FROM lite_records
    WHERE collection = $1 AND payload_hash IS NOT NULL`,
   ```
   After one `write()` call the dedup set is empty for every collection, and re-ingesting identical
   upstream data writes duplicate rows instead of no-ops. The backfill at `src/postgres-store.js:45-49`
   exists precisely to recover this column; `write()` silently undoes it.
3. It is a full-table rewrite driven by a snapshot read at request entry. `store.write()` is called
   from `src/server.js:2073`, `src/server.js:2099` and `src/server.js:2162`, all with
   `{ ...data, ... }` where `data` came from `await store.read()` at `src/server.js:252`. Any write
   committed between the read and the `write()` is lost — a lost update on the entire table, not one
   record.

`JsonStore.write` (`src/store.js:68-73`) does not delete: it preserves unknown top-level keys from
`data`. So the two adapters disagree about whether `write()` is destructive. See the divergence table.

Fix: give the adapters a `put(collection, records)` method that upserts only the given rows, and
route `src/server.js:2073/2099/2162` through `store.merge()` like every other write site. Keep
`write()` as a dev-only fixture loader, and have it set `payload_hash` in the INSERT column list.

---

### D3 — Report distribution performs an unvalidated server-side fetch to a caller-supplied URL

**Severity: Critical** (SSRF)

`src/server.js:1379-1392`

```js
      } else if (channel.channel === 'webhook') {
        const response = await fetch(required(channel.url, 'url'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(channel.headers || {}) },
          body: JSON.stringify({ report, markdown: renderReportMarkdown(report) }),
        })
```

`channel.url` comes straight from the request body (`normalizeDistributionChannels`, `src/server.js:1501-1504`,
passes `{...channel}` through unchanged). There is no scheme check, no host allowlist, no DNS
resolution check, and no `AbortController` timeout.

Failure scenario: a caller with only `write:reports` scope sends
`POST /api/v1/reports/{id}/distribute` with
`{"channels":[{"channel":"webhook","url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}]}`.
The server fetches the cloud metadata endpoint and returns the body in
`report_distribution_runs.response_body`. `http://127.0.0.1:5432` and any RFC1918 host work equally.
The caller also controls `channel.headers`, so `Host` and `Authorization` are settable.

Three further defects in the same block:
- **No signing.** The outbox path signs webhook bodies (`src/outbox.js:53-55`); this path does not,
  so a subscriber receiving the same `report.distributed` payload two ways can tell which is which
  and cannot verify either.
- **No timeout.** An unresponsive target hangs the request until the platform default.
- **Non-idempotent.** Re-POSTing `/distribute` re-fetches. `markReportDistributed` preserves
  `distributed_at` (`src/reports.js:180`), so the report reads as the same run while the receiver has
  been called N times. Nothing records a deduplication key.

Note this is a *different* code path from the webhook-subscription mechanism, and the stricter one
still has its own gap (D16).

Fix: validate `channel.url` at normalisation time — `https:` only by default, resolve the hostname
and reject loopback/link-local/private ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16`, `::1`, `fc00::/7`), then re-check after resolution to defeat DNS rebinding. Wrap the
fetch in an `AbortController`. Sign the body with the subscription secret. Require an idempotency
key and record it on the run.

---

### D4 — `outbox.js` calls a `signPayload` that is not imported and not defined in that module

**Severity: High**

`src/outbox.js:1` and `src/outbox.js:53-55`

```js
import { stableId, nowIso } from './utils.js'
...
        if (webhook.secret) {
          headers['x-signature'] = signPayload(webhook.secret, body)
        }
```

`signPayload` exists at `src/webhooks.js:44` and is **never imported anywhere in the repo**
(`grep -rn "signPayload" src/` returns exactly two hits: the definition and this call site).
`outbox.js` defines its own local `matchEvent` (`src/outbox.js:107`) but has no `signPayload`.

Failure scenario: any webhook subscription created with a `secret` fails. The `ReferenceError` is
caught by the bare handler at `src/outbox.js:72-74` — `// Swallow individual webhook errors; retry in
next cycle` — so it looks like a network fault. The event is retried five times and then marked
`failed` (`src/outbox.js:79-96`), and the operator is told the subscriber's endpoint is down. No
signed webhook has ever been delivered.

Fix: `import { signPayload } from './webhooks.js'` at the top of `src/outbox.js`, and add a test that
dispatches one secret-protected subscription and asserts on `x-signature`. Also narrow the
`catch` — a `ReferenceError` must not be swallowed into a retry loop.

---

### D5 — The RapidPro inbound endpoint is unauthenticated by default and bypasses the API token gate

**Severity: Critical**

`src/rapidpro.js:229-237`

```js
export function verifyRapidProWebhook(req, url, env = process.env) {
  const secret = env.RAPIDPRO_WEBHOOK_SECRET
  if (!secret) return true
```

`src/server.js:230-234`

```js
    if (url.pathname === '/api/v1/rapidpro/field-report' && req.method === 'POST') {
      if (!verifyRapidProWebhook(req, url)) {
        jsonResponse(res, 401, { success: false, error: 'Invalid RapidPro webhook' })
        return
      }
    } else if (url.pathname !== '/api/v1/health') {
```

This `if/else` means the field-report route is handled by the first branch and **never reaches**
`authenticate()` / `requireScope()`. Its only gate is `verifyRapidProWebhook`, which returns `true`
when `RAPIDPRO_WEBHOOK_SECRET` is unset.

Failure scenario: a deployment using SMS ingestion without setting `RAPIDPRO_WEBHOOK_SECRET` exposes
an unauthenticated write endpoint that creates an incident, a field report, two action logs and an
inbound message per request (`src/server.js:1598-1617`). Anyone can fabricate disease signals in a
humanitarian early-warning system — and because the fabricated records enter the same store as real
ones, downstream reporting treats them as observations. `RAPIDPRO_WEBHOOK_SECRET` is optional in every
deployment doc; it is not marked required when the inbound route is enabled.

The secret comparison itself (`return provided === secret`, `src/rapidpro.js:236`) is also
non-constant-time; use `crypto.timingSafeEqual` over equal-length buffers.

Fix: fail startup (or refuse the route with 503) when the inbound route is registered and
`RAPIDPRO_WEBHOOK_SECRET` is empty. Apply `authenticate`/`requireScope` on top of, not instead of,
the webhook secret. Use a timing-safe comparison.

---

### D6 — Postgres ordering collapses to a single timestamp per batch; JSON orders by record time

**Severity: High** (silent divergence in what a report shows)

`src/postgres-store.js:147-154`

```sql
      `INSERT INTO lite_records (collection, id, body, payload_hash, updated_at)
       SELECT u.collection, u.id, u.body, u.payload_hash, now()
       FROM UNNEST(...)
```

`src/postgres-store.js:60`

```js
    const { rows } = await this.pool.query('SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC')
```

`now()` in Postgres is the **transaction** timestamp, not the clock. Every row written by one
`merge()` — a whole ingestion run, typically thousands of records — receives the identical
`updated_at`. `ORDER BY updated_at DESC` is therefore a no-op within the batch and the returned
order is heap order.

`src/store.js:123` sorts the JSON store by the record's own timestamp field:

```js
  return [...map.values()].sort((a, b) => recordTimestamp(b).localeCompare(recordTimestamp(a)))
```

where `recordTimestamp` (`src/store.js:126-135`) prefers `updated_at`, then `completed_at`,
`generated_at`, `observed_at`, `occurred_at`, `created_at`.

Failure scenario: a run ingests 400 GDACS hazard events. On JSON, `eventsSummary`
(`src/reports.js:593`) slices `context.events.slice(0, 8)` and shows the eight most recent.
On Postgres it shows eight arbitrary rows from the batch. Same store contents, different SITREP.
`executiveSummary`, `incidentSummary` and `appendixSources` all use the same slice-and-truncate
pattern, so every headline figure in a generated report is affected.

Fix: order by a value from the body. Add a generated/extractable expression index —
`CREATE INDEX ON lite_records (collection, (body->>'observed_at') DESC)` — and select
`(body->>'occurred_at')`, `(body->>'generated_at')` in `read()` with a deterministic tiebreak on `id`,
matching `recordTimestamp`'s precedence order.

---

### D7 — The JSON store is a single non-atomic, unlocked file rewritten in full on every write

**Severity: High**

`src/store.js:68-73`

```js
  async write(data) {
    const next = { ...emptyStore(), ...data, updated_at: nowIso() }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }
```

- **Not atomic.** `fs.writeFile` opens with `'w'`, truncating immediately. There is no temp file and
  no `rename`. A crash, an OOM kill, or a full disk between truncate and flush leaves a truncated or
  half-written JSON document.
- **No recovery.** `read()` (`src/store.js:57-66`) handles only `ENOENT`:
  ```js
      } catch (error) {
        if (error.code === 'ENOENT') return emptyStore()
        throw error
      }
  ```
  A `SyntaxError` from `JSON.parse` propagates, so **one torn write bricks the entire store** — every
  route calls `store.read()` at `src/server.js:252`. There is no `.bak`, no journal, no repair path.
- **No permissions.** No `mode` is passed, so the file is created at the process umask, typically
  `0644` — world-readable. It holds field reports, coordinates, `reported_by`, and RapidPro sender
  numbers (see D24).
- **Fully in memory, always.** `JSON.stringify(next, null, 2)` materialises the entire store as a
  pretty-printed string on every single write, in addition to the already-parsed object graph. The
  `null, 2` indentation roughly doubles the bytes for no benefit.

Fix: write to `${filePath}.tmp` in the same directory, `fsync`, then `fsync` the directory and
`rename` — POSIX rename is atomic within a filesystem. Create with `mode: 0o600`. On parse failure,
fall back to `${filePath}.bak` and log loudly rather than throwing. Drop the indentation.

---

### D8 — JSON `merge()` is an unlocked read-modify-write; concurrent requests lose records

**Severity: High**

`src/store.js:75-84`

```js
  async merge(partial) {
    const current = await this.read()
    const next = { ...current }
    for (const collection of COLLECTIONS) {
      const incoming = partial[collection] || []
      if (!incoming.length) continue
      next[collection] = mergeById(current[collection] || [], incoming)
    }
    return this.write(next)
  }
```

Two `await`s between the read and the write, with no lock held. Node is single-threaded, but both
awaits yield to the event loop, so another request's `merge()` interleaves freely.

Failure scenario: `POST /api/v1/ingest/run` writes 3,000 hazard events over several seconds while a
CHW posts a field report. Both call `read()`, both build a `next` from their own snapshot, both call
`write()`. The second `write()` lands last and erases the first's records entirely. The action log
for the CHW report exists (both went into `partial`) but the record it describes does not.

The same applies to the D2 `store.write()` snapshot path on Postgres, where the blast radius is the
whole table.

Fix: serialise all `JsonStore` mutations through a promise chain (`this._queue =
this._queue.then(() => doMerge())`), and for multi-process deployments take an exclusive lock file.
Note in `docs/storage.md` that the JSON mode is single-process only.

---

### D9 — A collection missing from `COLLECTIONS` is silently dropped, on both adapters

**Severity: High** (this exact bug class has already been hit once — see `src/store.js:43-46`)

`src/postgres-store.js:63`

```js
      if (COLLECTIONS.includes(row.collection)) store[row.collection].push(row.body)
```

`src/store.js:78`

```js
    for (const collection of COLLECTIONS) {
```

The in-file comment at `src/store.js:43-46` documents that this already cost a release:

> Every collection JsonStore.merge writes must be listed here: the loop below keys strictly off
> COLLECTIONS, and an unlisted collection's records are dropped silently — the same class of bug the
> runIngestion merged map had, caught first by the food-security API test.

The guard is a comment, not code. Nothing derives `COLLECTIONS` from `emptyStore()`
(`src/schema.js:211-255`, 37 keys) and nothing asserts the two lists agree. `emptyStore()` has
`data_lineage` between `kpi_snapshots` and `road_access` while `COLLECTIONS` has it elsewhere; they
happen to match today by hand.

Failure scenario: a contributor adds `sanctions_screens` to `emptyStore()` and a POST route that
merges into it. Every record is accepted with a 201 and a valid id, then discarded. The API reports
success for data that does not exist. Compounded by D2, on Postgres the *next* `write()` deletes them
from the table outright.

Fix: derive `COLLECTIONS` from `emptyStore()` by filtering the two known non-collection keys
(`version`, `updated_at`), and make the merge loop throw on an unknown key rather than skip it. Add a
test that asserts `Object.keys(emptyStore())` minus the two scalars equals `COLLECTIONS`.

---

### D10 — `schema.js` contains no validation; nothing validates a record before it is stored

**Severity: High**

`src/schema.js` is 412 lines of frozen constant arrays, four pure helper functions
(`normalizeSeverity`, `severityWeight`, `riskLevel`), `emptyStore()` and `publicSourceCatalog()`.
There is no `validate`, no field spec, no `extra=forbid` equivalent anywhere in it.

Validation is scattered across per-collection normalisers invoked by the route handler, and only for
the paths that reach one:

- `src/operations.js:50-57` — `buildCreate` covers five collections and `throw`s otherwise:
  ```js
  export function buildCreate(collection, input, data) {
    if (collection === 'incidents') return normalizeIncident(input, data)
    ...
    throw new Error(`Unsupported operational collection: ${collection}`)
  ```
- Reports: `normalizeReport` (`src/reports.js:95`). Templates: `normalizeReportTemplate`.
- Community: `normalizeCommunityFeedback` (`src/community.js:12`). Webhooks: `webhooks.js:4`.

But the store itself validates nothing. `JsonStore.merge` and `PostgresStore.merge` write whatever
they are handed, and `action_logs`, `alert_events`, `data_lineage`, `source_runs`,
`rapidpro_dispatches`, `workflow_instances`, `kpi_snapshots`, `parametric_disbursements` and
`events_outbox` have no normaliser at all on some or all of their write paths.

Failure scenario: `POST /api/v1/incidents` with `{"title":"x","severity":123,"service_asset_ids":"not-an-array","metadata":{"__proto__":{}}}`
is accepted — `arrayValue` (`src/operations.js:360`) wraps a string into `["not-an-array"]` rather
than rejecting it, and `metadata` is an unvalidated passthrough object (`objectValue`,
`src/operations.js:366`) accepted at any depth. There is no `extra=forbid` behaviour: fields outside
the normaliser's literal are *dropped* for the five operational collections (an allowlist in effect)
and *accepted verbatim* everywhere else. Two different behaviours from the same request, depending
on which collection you hit.

Fix: add a declarative per-collection field spec to `schema.js` (required, type, enum, `extra:
'forbid'`) and a single `validateRecord(collection, body)` that every write path calls, including
inside `merge()` so a direct store call cannot bypass it. Reject rather than coerce in `arrayValue`.

---

### D11 — No migration path exists; `version: 1` is written but never read

**Severity: High** (production-breakage risk on any record-shape change)

`src/schema.js:213`

```js
export function version: 1 {
```

written by `emptyStore()`. Grepping `src/` for `store.version`, `schemaVersion` and reads of that
field returns nothing — the number is emitted and never consumed.

The only forward-compatibility work in the codebase is three statements in `ensureSchema`
(`src/postgres-store.js:22-56`): `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS payload_hash`, and a one-off backfill `UPDATE`. That is a single hardcoded additive column,
not a migration system.

Failure scenario: `normalizeFieldReport` is changed to make `demographics.age_band` an enum (as
`normalizeDemographics`, `src/operations.js:212-219`, already does). Every `field_report` written
before the deploy has `age_band: 'child'` or `'children'` or `'<5'`. `normalizeDemographics` silently
coerces all of them to `'unknown'`, so historical demographic breakdowns flatten to a single bucket
on the first update or soft-delete of any record — with no migration, no backfill, no log line, and
no way to recover the original value. The same shape of failure applies to any enum or required-field
tightening.

There is also no rollback and no down-migration, so a bad `ensureSchema` change is unrecoverable
without a restore.

Fix: a `schema_migrations` table and an ordered list of `{id, up}` migrations applied inside one
transaction at startup, with the current version asserted against `store.version`. Add a
`migrateRecords(collection, fn)` step for JSONB shape changes, run once per record, idempotently,
recording which ids it has processed.

---

### D12 — Ids mix the wall clock into the hash input, so retries and re-submissions create duplicates

**Severity: High**

`stableId` (`src/utils.js:3-6`) is a deterministic SHA-256 over the supplied values — the mechanism
is sound. The callers defeat it by including `now`:

`src/operations.js:104`
```js
    id: stableId('log', [collection, action, record.id, now]),
```

`src/lineage.js:9`
```js
    id: stableId('lineage', [sourceRun.source, sourceRun.id, now]),
```

`src/reports.js:187`
```js
    id: existing?.id || input.id || stableId('report_distribution', [report.id, channel, now]),
```

`src/workflows.js:98`
```js
    id: input.id || stableId('workflow', [type, input.subject_kind, input.subject_id, now]),
```

`src/community.js:36`
```js
    stableId('feedback', [input.alert_event_id, input.message, now])
```

`src/server.js:2213`
```js
      id: stableId('report', [body.description, body.location?.latitude, body.location?.longitude, now]),
```

Contrast `normalizeIncident` (`src/operations.js:129`), which hashes content and is genuinely
idempotent. The operational normalisers and the action log are not.

Failure scenario: a CHW's phone loses connectivity after POSTing to `/api/v1/chw/report`. The app
retries after three seconds. `now` differs, so the id differs, and the store now holds two identical
disease signals. There is no idempotency key, no `Content-IDempotency-Key` handling, and no
natural-key dedup on any write path. In a `chw_outbreak_triage` workflow (`src/workflows.js:19`)
duplicated symptom reports inflate the district's case count, which is the number a triage decision
is made on.

Fix: drop `now` from the hash input wherever the remaining tuple is a natural key; accept an
`Idempotency-Key` header, hash it into the id, and return the original record with 200 on replay.

---

### D13 — The action log is append-only by convention only; the actor is caller-asserted and the subject leaks the token

**Severity: High**

Append-only: `src/server.js:1829`, `1849`, `1867` return 405 for POST/PATCH/DELETE on
`action_logs`. That is enforced — good. But the record is only as trustworthy as its actor field,
and there is no tamper evidence.

`src/operations.js:101-117`

```js
export function actionLog(collection, action, record, actor = 'operator', subject = null) {
  const now = new Date().toISOString()
  return {
    id: stableId('log', [collection, action, record.id, now]),
    collection,
    record_id: record.id,
    action,
    actor,
    subject,
```

`actor` is `body.actor` first, `req.__auth?.subject` second, at every one of the ~30 call sites
(`src/server.js:1835`, `1860`, `1873`, `1201`, `1587`, …).

Failure scenario: a caller with any valid token POSTs
`{"title":"...","actor":"system"}`. The action log records `actor: 'system'`, `subject: 'token_ab12…'`.
Because `actor` takes precedence over the authenticated subject, an operator can attribute any action
to any other actor, including to the RapidPro service account (`actor: 'rapidpro'`, used at
`src/server.js:1607` and `1615`) or to a named human who never performed it. The log is the only
attribution mechanism for a humanitarian decision record and it is self-asserted.

Compounding: `src/auth.js:37`

```js
    subject: `token_${token.slice(0, 8)}`,
```

The first eight characters of the bearer token are written into every action log for that identity.
Action logs are readable by any `read:hazards` token via `GET /api/v1/action-logs`, so an eight-char
prefix of a secret is disclosed to every reader. (Eight hex/base64 characters of a longer token is a
meaningful reduction of the search space, and it is unnecessary — the token is already a stable
identifier and can be hashed.)

There is also no hash chain: nothing links `log[n]` to `log[n-1]`, so an operator with write access to
the `lite_records` table can edit or delete a log row (D2's `write()` rewrites all of them) and no
detection is possible.

Fix: prefer `req.__auth.subject` over `body.actor` and record the caller's claim in a separate
`claimed_actor` field — the pattern `transitionWorkflow` already uses at `src/workflows.js:144-153`,
which is the one piece of the codebase that gets this right. Hash the token for the subject
(`sha256:` + first 16 hex). Add a `prev_hash`/`hash` chain over `action_logs` in chronological order
and verify it on read.

---

### D14 — The outbox is not transactional with the state change it publishes

**Severity: High**

`src/server.js:1162-1163`

```js
    await store.merge({ reports: [record], action_logs: [log] })
    try { await emit(store, 'report.created', record) } catch {}
```

Same pattern at `src/server.js:1836-1843` (`incident.created`), `src/server.js:828`
(`community_feedback.created`), `src/server.js:2401` and `2434` (workflow events), `src/server.js:1640`
and `1687`.

`emit` (`src/outbox.js:3-17`) performs a **second** `store.read()` followed by a **second**
`store.merge()`. It is not in the same transaction as the state change on any adapter, and the errors
are swallowed by `catch {}`.

Failure scenario: the report commits. The process is killed (deploy, OOM) between the two merges, or
`emit`'s internal `read()` hits a torn JSON file (D7). The report exists; the `report.created` event
does not and never will. Subscribers — including the webhook that is supposed to trigger a partner
organisation's response workflow — never hear about it. There is no reconciliation scan for
"committed but un-emitted" records.

`outbox.js` is genuinely used (seven `emit` call sites plus `dispatchPending` at
`src/server.js:319`), so it is not dead code — but it is a *best-effort* outbox, not a transactional
one, and the naming implies a guarantee it does not provide.

Fix: add `store.mergeWithOutbox(event, payload, partial)` that writes the state change and the outbox
row in one transaction (both adapters already have a transaction in `merge()`; the JSON adapter needs
the write queue from D8). Delete the `catch {}` around every call site, or downgrade it to a logged
warning with a reconciliation job.

---

### D15 — Distribution sends the message before persisting anything; a failure leaves no record

**Severity: High**

`src/server.js:1206-1224` calls `distributeReport` (`src/server.js:1354`), which performs the network
side effects inline, and only merges the results afterwards:

```js
    const result = await distributeReport(existing, body, body.actor, data)
    const record = result.report
    const log = actionLog('reports', 'distributed', record, body.actor, req.__auth?.subject)
    await store.merge({
      reports: [record],
      report_distribution_runs: result.runs,
      rapidpro_dispatches: result.rapidproDispatches,
      action_logs: [log, ...result.runs.map(...)],
    })
```

Inside `distributeReport`, `fetch(...)` to the caller's webhook (`src/server.js:1380`) and
`sendRapidProReportSummary` (`src/server.js:1395`, which POSTs to RapidPro and can block for as long
as the platform fetch default) run **before** any write.

Failure scenario: a SITREP is distributed to 5 SMS groups and one partner webhook. All six succeed.
The `store.merge` then fails — Postgres connection dropped, JSON file unwritable. The response is a
500. The report is still `approved`, `distributed_at` is unset, and no `report_distribution_runs` row
exists. The operator, seeing the 500, distributes again. Every recipient receives the SITREP twice
and the partner webhook double-counts the incident. There is no `distribution_attempted_at` to warn
them and no run record to reconcile against.

The same applies to the multi-collection writes at `src/server.js:1616` (`rapidpro_inbound_messages`
+ optional `incidents` + `field_reports` + `action_logs`) — those are one `merge()` and therefore
atomic *within* a backend, which is the one thing here that is right.

Fix: write a `report_distribution_runs` row with `status: 'prepared'` first, then perform the sends
against that row's id, then update each run's outcome. Reject `/distribute` when a prepared run
already exists for the report and channel. Add the idempotency key from D3.

---

### D16 — A read-only token can register a webhook to an internal address and then trigger delivery to it

**Severity: High**

`src/auth.js:57-77`

```js
export function scopeForRoute(method, pathname) {
  if (method === 'GET') return 'read:hazards'
  ...
  if (pathname.includes('/incidents') || ... ) return 'write:incidents'
  return 'read:hazards'
}
```

The fallback is `read:hazards`. `POST /api/v1/webhooks` and `POST /api/v1/outbox/dispatch` match no
prefix rule, so both require only `read:hazards` — the scope that is also what every `GET` requires.

`normalizeWebhookSubscription` (`src/webhooks.js:4-30`) validates only:
```js
  if (!url || !url.startsWith('http')) {
    throw Object.assign(new Error('url must be an HTTPS or HTTP URL'), { statusCode: 400 })
  }
```
— which accepts `http://169.254.169.254/`, `http://localhost:5432/`, `http://[::1]/`, and `https://`
on internal hosts. The subscription also accepts arbitrary caller-supplied `headers`
(`src/webhooks.js:17, 26`), which `dispatchPending` merges into the outbound request
(`src/outbox.js:48-51`).

Failure scenario: a partner organisation holding a read-only token registers
`{url: "http://169.254.169.254/latest/meta-data/", events: ["*"], headers: {"accept":"*/*"}}`, then
calls `POST /api/v1/outbox/dispatch`. The server issues the request, and on failure the status and
error surface in the outbox record. With `*` as a pattern, every event the system ever emits is
delivered to the metadata endpoint.

This is the same class as D3 through the subscription path, and it is separately exploitable because
it needs only a read token.

Fix: give `scopeForRoute` an explicit entry mapping `/api/v1/webhooks` and `/api/v1/outbox/dispatch` to
`admin:webhooks`, and make the default for an unmatched non-GET route a denial rather than
`read:hazards`. Apply the same URL validation from D3 in `normalizeWebhookSubscription`.

---

### D17 — The whole store is loaded for every request; `read()` is an unbounded `SELECT`

**Severity: High** (performance, and it scales into correctness at volume)

`src/server.js:252`

```js
  const data = await store.read()
```

runs unconditionally at the top of `handleApi`, before any route matching. On Postgres that is
`src/postgres-store.js:60`:

```js
    const { rows } = await this.pool.query('SELECT collection, body, updated_at FROM lite_records ORDER BY updated_at DESC')
```

No `WHERE`, no `LIMIT`, no projection beyond the full JSONB body. Every row of every collection is
transported, parsed, and materialised into JS objects, then `JSON.parse`'d out of JSONB a second time
by `pg`. `store.merge()` then does the same again (`src/postgres-store.js:119`: `return this.read()`),
so a single `POST /api/v1/incidents` transfers the entire database twice.

With 400 hazard events per GDACS run and a quarterly ingest cadence, this crosses tens of megabytes
per request and pins the event loop in `JSON.parse`. On the JSON backend the same request is a full
file read plus a full file serialise (D7).

Fix: push the filter into SQL — `SELECT body FROM lite_records WHERE collection = $1` plus predicate
clauses derived from `filterRecords`' query parameters — and only fall back to a full read for the
aggregate routes that genuinely need it. Change `merge()` to return the affected records rather than
the whole store.

---

### D18 — `redactPii` does not cover the fields the RapidPro path actually stores

**Severity: High**

`src/pii.js:11-44` handles exactly five keys: `reporter_name`, `contact_name`, `phone`, `urn`,
`latitude`/`longitude`.

The inbound record it is applied to (`src/server.js:1600-1614`) carries none of them under those
names. `parseRapidProFieldReport` (`src/rapidpro.js:129-144`) produces:

```js
    inbound: {
      ...
      from,
      contact_name: contact.name || payload.contact_name || null,
      ...
      payload,
    },
```

- `from` (`src/rapidpro.js:135`) is the sender's phone number, raw. `redactPii` does not touch `from`.
- `payload` (`src/rapidpro.js:143`) is the **entire** request body, stored verbatim. It contains
  `urns: {tel: ["+2547…"]}`, `contact.name`, and any other field RapidPro sent.
- `metadata.from` (`src/rapidpro.js:158`) again.

And the derived field report (`src/rapidpro.js:149`):

```js
      reported_by: payload.reported_by || contact.name || from || 'rapidpro',
```

— falls back to the raw phone number, stored in `field_reports.reported_by`.

Failure scenario: every SMS field report writes the community member's phone number to
`rapidpro_inbound_messages.from`, to `metadata.from`, to the embedded `payload`, and to
`field_reports.reported_by`. `redactPii` masks none of them. Combined with D1 (retention purges
nothing) and D7 (the JSON file is world-readable), a community member's phone number is retained
indefinitely and readable by anyone with filesystem access.

Fix: replace the five hardcoded keys with a declared PII field registry
(`from`, `contact_name`, `reporter_name`, `phone`, `urn`, `reported_by`, `contact_urn`,
`reporter_phone`, plus a recursive walk of `payload`), and apply it recursively. Better: store a
`sender_ref` HMAC instead of the number, as `community.js` already does with `hashUrn`
(`src/community.js:7-10`) — that module is the pattern the rest of the codebase should follow.

---

### D19 — The API is entirely unauthenticated when no token env var is set, with no warning

**Severity: High** (deployment risk)

`src/server.js:229-250` wraps the whole auth block in:

```js
  if (process.env.LINDELA_LITE_TOKENS || process.env.LINDELA_LITE_API_KEY) {
```

Set neither and there is no authentication, no scope check, and no startup diagnostic. Every route
is open, including `POST /api/v1/incidents`, `/api/v1/reports/{id}/distribute` (which makes outbound
fetches), `/api/v1/outbox/dispatch`, `/api/v1/maintenance/apply-retention`, and the webhook
registration route. That is a reasonable default for a local demo, but it is not distinguishable at
runtime from a deliberate production open-API deployment.

Fix: log a single prominent warning at startup when neither variable is set, name it in
`GET /api/v1/health` as `auth: {enabled: false}`, and honour an explicit
`LINDELA_LITE_ALLOW_ANONYMOUS=true` so the open state is a decision rather than an omission.

---

### D20 — The RapidPro dispatch has no timeout and no retry

**Severity: Medium**

`src/rapidpro.js:30-37`

```js
    const response = await fetch(request.url, {
      method: 'POST',
      headers: {
        authorization: `Token ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request.body),
    })
```

No `signal`, unlike `outbox.js:57-58` which does use an `AbortController`. A hung RapidPro endpoint
holds the HTTP request open indefinitely, on both `/api/v1/rapidpro/alerts/{id}/send-alert`
(`src/server.js:1574`) and the distribution path. There is no retry; a single transient failure marks
the dispatch `failed` and it is only recovered by an operator calling the retry route.

`src/connectors/http.js`'s `fetchWithRetry` is already used by `sanctions.js:25` — the pattern exists
in the codebase and is not applied here.

Fix: wrap in `AbortController` with a configured timeout and use `fetchWithRetry` with bounded
backoff for 5xx and network errors.

---

### D21 — The PDF "signature" is a self-referential 64-bit digest that changes on every render

**Severity: Medium** (a trust claim printed on a humanitarian deliverable that does not hold)

`src/pdf.js:11-13`

```js
function signatureHash(kpi) {
  return crypto.createHash('sha256').update(JSON.stringify(kpi)).digest('hex').slice(0, 16)
}
```

printed at `src/pdf.js:74`:

```js
  lines.push({ text: `Signature (SHA-256/16): ${signatureHash(kpi)}`, size: 8, y: 28 })
```

This is a digest of the KPI object *including* `generated_at` (`src/pdf.js:22`), truncated to 16 hex
characters (64 bits), keyed by nothing. It is not a signature: anyone holding one PDF can compute it,
it cannot be verified against a second document, and rendering the same report twice yields two
different values. `docs/api.md:649` describes it as a "SHA-256 signature footer", which is misleading.

On scale: the PDF is not the risk it looks like. `renderQuarterlyReportPdf` renders a fixed 12-row KPI
table and a 5-row cohort table (`src/pdf.js:29-63`) with a hard `y < 300` break (`src/pdf.js:48`), so
row count is bounded, the buffer is a few kilobytes, and synchronous generation does not block on
volume. Report content is not injected into the PDF producer at all — `reports.js` PDFs are not
produced; distribution of `markdown_download` records only a byte count
(`src/server.js:1373`). There is no template injection surface here.

Fix: either remove the footer, or make it an HMAC over the report body with a key the operator holds,
and print the key id so a verifier can check it.

---

### D22 — Prometheus output is malformed when a metric has no labels, and histograms grow without bound

**Severity: Medium**

`src/observability.js:110-115`

```js
      const labelWithLe = labels.slice(0, -1)
      for (const [bucket, count] of buckets) {
        const le = bucket === '+Inf' ? '+Inf' : bucket.toString()
        const fullLabels = labelWithLe + (labelWithLe.length > 1 ? ',' : '') + `le="${le}"}`
        output += `${entry.name}_bucket${fullLabels} ${count}\n`
      }
```

With `labels === ''` (a metric recorded with no label object), this emits
`http_request_duration_ms_bucketle="5"} 3` — missing the opening brace, `le` concatenated to the
metric name. The line will not parse. The guard should be on `labels.length`, not `labelWithLe.length`.

Separately, `entry.values` (`src/observability.js:77`) is an unbounded array that is never pruned, and
`src/server.js:124` records a histogram with a `route` label derived from the request path:

```js
      metrics.histogram('http_request_duration_ms', elapsed, { method: req.method, route, status: String(statusCode) })
```

For unmatched paths that route value is the raw URL, so every distinct 404 URL creates a new label set
and a new unbounded `values` array — unbounded Prometheus cardinality and a slow memory leak, both
driven by client-controlled input.

Fix: build the label string properly (`labels ? labels.slice(0, -1) + ',' : '{'`). Bound `values` to
the last N samples or aggregate into fixed buckets on insert. Normalise `route` to a route pattern, or
replace it with a constant `unmatched`.

---

### D23 — The SDN matcher is O(n·m) with no persistence and no failure mode

**Severity: Medium**

`src/sanctions.js:72-84`

```js
  for (const entry of entries) {
    const candidate = normalizeName(entry.name)
    if (!candidate || candidate.length < 4) continue
    if (candidate === target) {
```

`normalizeName` — five regex passes — is recomputed for all ~15,000 SDN entries on **every** name
screened, for every call to `screenNames`. Screening one disbursement batch of 50 counterparties runs
750,000 string normalisations on the event loop.

The list is also held only in a module-level variable (`let cache = null`, `src/sanctions.js:16`),
refetched in full from `sanctionslistservice.ofac.treas.gov` after every process restart
(`src/sanctions.js:25`), and `loadSdnList` has no fallback: if OFAC is unreachable the caller gets an
exception rather than an unscreened-but-labelled result.

Fix: normalise the SDN list once at parse time and build a `Map<normalisedName, entry>`. Make the
load failure non-fatal and return `{entries: [], degraded: true}` so the screening decision is
recorded as unscreened rather than skipped.

---

### D24 — Soft delete leaves PII in place permanently

**Severity: Medium**

`buildSoftDelete` (`src/operations.js:76-92`) stamps `deleted_at` and `deleted_by` and keeps the
record:

```js
  const merged = { ...existing, deleted_at: new Date().toISOString(), deleted_by: actor || null }
```

The file comment states the rationale — "Records are never removed from the store so action-log
history and any downstream references stay resolvable" — and that rationale is sound for a deleted
*incident*. It is not sound for a deleted *field report*: the record body carries `summary`,
`latitude`, `longitude`, `reported_by` and `demographics`, which are exactly the fields a
right-to-erasure request targets. Combined with D1, deleting a field report through the API leaves
the health information permanently resident.

Fix: separate retention classes. Keep incidents, interventions and tasks soft-deleted; for
`field_reports` and `rapidpro_inbound_messages`, a DELETE should redact the body in place (retain
id, timestamps, action-log linkage; drop `summary`, `needs`, `demographics`, `reported_by`,
coordinates) and record `erased_at` with the requesting actor.

---

### D25 — The JSON store's `payload_hash` dedup is defeated by records that carry no id

**Severity: Low**

`src/store.js:100-124` keys by `item.id` with no guard; `src/postgres-store.js:101` filters:

```js
      const incoming = (partial[collection] || []).filter((item) => item?.id)
```

A record with `id: undefined` is keyed at `undefined` in a `Map` on JSON (all such records collapse
into one) and silently dropped on Postgres. Since the merge returns the result to the caller, the
JSON caller receives a 201 with a record it cannot subsequently retrieve by id. Normalisers
`stripUndefined` their output, so this only triggers for a record whose id genuinely resolves to
`undefined`.

Related and larger: `mergeById` skips an incoming item whenever *any* existing record in the
collection shares its `payload_hash` (`src/store.js:113-116`) — even one with a different id. That is
intended dedup, but it means a genuine second record with identical content is discarded rather than
stored, on both adapters, with no counter and no log line. For connector output that is correct; for
two field reports with the same text it silently loses one.

Fix: reject records without an id in `merge()` on both adapters. Scope the hash dedup to the
connector collections only, not to human-submitted ones.

---

## Enhancements

### E1 — Real relational schema with typed columns and per-collection indexes

**Value.** Filtering, aggregation and reporting currently run in JavaScript over the whole database
because nothing is typed or indexed; a per-collection table with real columns turns the most common
queries into index scans and makes referential integrity enforceable. It also removes the
`COLLECTIONS`-array fragility behind D9, since the schema becomes the single source of truth.

Evidence: `src/postgres-store.js:27-33` — one table, `body JSONB NOT NULL`, no foreign keys;
`docs/architecture/data-model.md:4` — "no migration, no join, and no foreign key".

Sketch: keep `lite_records` as the default and add an opt-in `LINDELA_LITE_SCHEMA=relational`. One
table per collection mirroring the docs' own column tables, e.g.
`CREATE TABLE intervention_tasks (id TEXT PRIMARY KEY, intervention_id TEXT NOT NULL REFERENCES interventions(id), title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('todo','in_progress','blocked','done','cancelled')), due_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, ...)`. Partial indexes on the hot paths: `intervention_tasks(due_at) WHERE status NOT IN ('done','cancelled')`,
`field_reports(incident_id)`, `alert_events(status, severity)`, `events_outbox(status, created_at)`.
Add `GENERATED ALWAYS AS (body->>'observed_at') STORED` for the ordering fix in D6.

### E2 — A migration runner with versioned, transactional, forward-only steps

**Value.** Today any record-shape change silently corrupts historical data on first touch (D11); a
migration runner makes shape changes an explicit, reviewable, testable step that runs once and is
recorded. It is the single highest-leverage item for production safety, because it is the only one
that makes every other storage change safe to deploy.

Evidence: `src/postgres-store.js:22-56` — `ensureSchema` is three hardcoded statements; `src/schema.js:213` — `version: 1` written and never read.

Sketch: `schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL, checksum TEXT)`.
A `migrations/` directory of `NNN-name.sql` files, applied in order inside one transaction per file,
with a checksum guard that refuses to run a file that has been edited after release. Record the
applied version in `lite_records`'s store envelope alongside `version`. For JSON mode, the same
runner calls a per-collection `migrateRecords` transform idempotently, tracking processed ids.

### E3 — Hash-chained immutable audit log

**Value.** The action log is the only attribution mechanism for humanitarian decisions and it is
currently self-asserted and silently editable (D13). A hash chain makes any edit or deletion
detectable by recomputing the chain, which is what turns it from a convenience log into evidence.

Evidence: `src/operations.js:101-117` — no `prev_hash`, no `hash`; `src/server.js:1829-1869` — 405 guards prevent API mutation but not table-level.

Sketch: add `prev_hash` and `hash` to the action-log record, with
`hash = sha256(prev_hash || canonicalHash({collection, action, record_id, actor, subject, created_at, metadata}))`
and `prev_hash` chained in `(created_at, id)` order. Verify the full chain on read of
`GET /api/v1/action-logs` and surface `chain_valid: false` plus the break point. For a deployment
that also needs to *prove* it, periodically seal the chain head into `kpi_snapshots` (which already
carries a `signatureHash` slot, `src/pdf.js:11`).

### E4 — Wire the lineage graph end to end

**Value.** Provenance is the difference between "this figure came from GDACS on this date" and "it
came from somewhere", which is the question every humanitarian report reviewer asks. Today lineage is
a single checksum row per run with no per-record linkage, so a specific figure cannot be traced to its
source.

Evidence: `src/lineage.js:3-20` — 20 lines; `recordLineage(store, sourceRun, records)` takes `store`
and **never uses it**; `upstream_url_or_endpoint: null` and `transform_version: '0.1.0'` are hardcoded
(lineage.js:13-14). The record stores only `payload_hashes` — an array of opaque hashes, not the
`(collection, id)` pairs they belong to. `docs/platform-jtbd-catalogue.md:398` already flags that
`GET /api/v1/data-lineage` is undocumented, though the route exists at `src/server.js:650`.

Sketch: have `recordLineage` store
`edges: [{collection, id, payload_hash, source, source_record_id, retrieved_at}]` alongside
`source_run_id`, and drop the unused `store` parameter. Add a `GET /api/v1/data-lineage/:recordId`
that walks the graph backwards, and have `buildSection` (`src/reports.js:540`) emit a
`provenance` block in `appendix_sources` naming the source run and upstream checksum for each cited
figure.

### E5 — Transactional outbox

**Value.** Currently a committed state change and its published event are two separate writes with
the second one silently droppable (D14). Making the outbox row part of the same transaction closes
the window entirely and is the standard remedy.

Evidence: `src/server.js:1162-1163` — `await store.merge(...)` then `try { await emit(store, ...) } catch {}`; `src/outbox.js:15` — `emit` performs its own `read()` + `merge()`.

Sketch: add `store.mergeWithOutbox(partial, event, payload)` to both adapters. The Postgres
implementation appends the outbox row to the same `UNNEST` batch inside the existing transaction; the
JSON implementation adds the row to `partial` before a single `write()` under the write queue from
D8. Replace all seven `emit` call sites. Add a reconciliation job that reports events committed
without a matching outbox row for the last 24 hours, as a safety net for any path that is missed.

### E6 — Retention and PII erasure that actually removes data

**Value.** Right-to-erasure is currently a no-op on disk (D1) and soft-delete preserves the exact
fields an erasure request targets (D24). A real erasure path is what makes the
`docs/unicef-requirements-traceability.md:147` "Met" defensible.

Evidence: `src/server.js:377-380` — merges `kept` only; no adapter has a delete;
`src/operations.js:81` — soft delete stamps `deleted_at` and retains the body.

Sketch: add `store.deleteWhere(collection, predicate)` to both adapters and an
`ERASURE_TARGETS` map naming the PII fields per collection. `POST /api/v1/maintenance/apply-retention`
then deletes from `field_reports` and `rapidpro_inbound_messages` and writes an `action_logs` entry
per run. Add `POST /api/v1/erasure` taking a subject reference (a `hashUrn` value,
`src/community.js:7`), which resolves matching records by hashed key and redacts the body in place —
retaining id, timestamps and action-log linkage so history stays resolvable. Add `dry_run=true`
returning counts without writing.

### E7 — A declared PII field registry applied recursively

**Value.** `redactPii` currently masks five hardcoded key names and misses every field the RapidPro
path actually writes (D18), so the redaction that appears to run is largely a no-op. A registry
driven by a recursive walk would be both correct and auditable.

Evidence: `src/pii.js:15-31` — five keys; `src/rapidpro.js:135,143,158` write `from`, `payload`, `metadata.from`, none matched.

Sketch: `PII_FIELDS = new Set(['from','urn','phone','contact_urn','reporter_phone','reporter_name','contact_name','reported_by'])` plus
`PII_SUBTREES = new Set(['payload','metadata','demographics'])`. Walk the record recursively,
applying `maskPhone` to anything matching a phone-ish name and `hashString` to names. Add a test
that ingests a realistic RapidPro payload and asserts no 9+-digit sequence survives anywhere in the
stored record.

### E8 — Idempotency keys on write endpoints

**Value.** Every retry today creates a new record (D12), and the distribution path in particular can
send a SITREP twice while reporting failure (D15). Content-addressed ids plus a header make the
unsafe operations safe to retry, which is a prerequisite for any client that retries.

Evidence: `src/server.js:2213` and `src/operations.js:104` — `now` in the hash input; no `Idempotency-Key` handling anywhere in `src/`.

Sketch: accept `Idempotency-Key` in `readRequestJson`'s caller, hash it with the route and the
authenticated subject into the record id, and on a collision with a matching key return the stored
record with 200 and a replay header. Drop `now` from the six id computations listed in D12 so that
even a client without idempotency support converges. Add it to `/distribute`, `/ingest/run` and
`/outbox/dispatch`.

### E9 — Push filtering into the store instead of loading everything

**Value.** Every request currently reads, transfers and parses the entire database (D17), so latency
and memory grow with total history rather than with result size. Pushing the predicate down makes
the API's cost proportional to what it returns.

Evidence: `src/server.js:252`; `src/postgres-store.js:60` — `SELECT ... FROM lite_records ORDER BY updated_at DESC` with no `WHERE`; `src/utils.js:125` — `filterRecords` is a pure in-memory chain of `.filter()`.

Sketch: add `store.query(collection, {filters, limit, order})` that compiles the `filterRecords`
parameter set into a `WHERE` clause against generated columns (`body->>'country'`,
`body->>'severity'`, `(body->>'observed_at')::timestamptz`), with `LIMIT`/`OFFSET` and a matching
`store.count()`. Migrate the read-only routes first (`/hazard-events`, `/risk-scores`,
`/field-reports`), leaving aggregate routes on the full read. Add `INDEX_ON` hints to
`COLLECTIONS`-adjacent config so the `extra=forbid` boundary stays visible.

### E10 — Incremental report generation with a materialised section cache

**Value.** Report generation recomputes every section from the whole store on every request, and
`resolveReportContext` (`src/reports.js:408`) re-filters fifteen collections each time. Caching
sections keyed on (scope, report_type, data_version) makes a re-render of an unchanged situation
picture free, and makes the cost of a large store proportional to what changed.

Evidence: `src/reports.js:149-165` — `generateReportSections` maps every `section_id` through
`buildSection` on every call; `src/reports.js:464-466` — fifteen `filterRecords` passes per request.

Sketch: compute a `data_version` from `store.updated_at` plus per-collection row counts (cheap on
Postgres via `count(*) GROUP BY collection`). Cache `buildSection` output in a `report_section_cache`
collection keyed by `sha256(report_type, scope, section_id, data_version)`. Invalidate by version
bump rather than by deletion. Bound the cache by age.

### E11 — Report templates as versioned, rendered artifacts

**Value.** `version` is incremented on every update (`src/reports.js:82`) but the version is never
referenced by a report, so two reports rendered from "the same" template are not comparable and a
template edit silently changes future output. Making the version an explicit reference turns template
history into something a reviewer can audit.

Evidence: `src/reports.js:78-82` — `id: existing?.id || ...` with `version: existing ? Number(existing.version||1)+1 : ...`; `docs/architecture/data-model.md:320` — "a PATCH is a new template version, not an in-place edit"; but `normalizeReport` stores only `template_id` (`src/reports.js:119`).

Sketch: give each update a new `id` of `${template_id}@v${n}` and keep the previous version readable;
stamp `template_version` onto the report at render time. Add a `GET /api/v1/report-templates/{id}/versions`
listing and a rendered-output store (`report_renders`) so a distributed report can be replayed byte
for byte. Add `content_hash` over the rendered markdown for tamper evidence, which D21 attempts and
fails to deliver.

### E12 — Resumable, durable ingestion

**Value.** `POST /api/v1/ingest/run` performs the whole run in one request with no persisted
checkpoint, so a restart or deploy mid-ingestion loses the run and the operator cannot tell how far it
got. Durable per-source state turns a 40-minute GDACS archive walk into a resumable job.

Evidence: `src/server.js:353-364` — one synchronous call chain; `src/ingestion.js` has no
checkpoint, resume or `in_progress` state; `docs/architecture/ingestion.md` describes the walk as
"paginated quarter-by-quarter and slow by design".

Sketch: record a `source_run` row with `status: 'running'`, a `cursor` (quarter/page) and
`heartbeat_at` *before* each page, and write fetched records incrementally so partial work is
durable. On startup, scan for `source_run` rows stuck in `running` past the heartbeat and mark them
`interrupted` with a resumable cursor. Add `POST /api/v1/ingest/run` with `resume: true` and expose
run progress on `GET /api/v1/sources`.

### E13 — Full-text and structured search over records

**Value.** There is no way to ask a question of the store beyond the fixed filter set in
`filterRecords`; an analyst looking for "every field report mentioning a water point in Turkana last
quarter" cannot express it. Search is the difference between a record store and a usable archive.

Evidence: `src/utils.js:125-175` — fourteen fixed equality filters plus bbox, district and date range;
no text matching anywhere in the read path.

Sketch: on Postgres, a generated `tsvector` column
(`to_tsvector('simple', body::text)`) with a GIN index, exposed at `GET /api/v1/search?q=&collection=`.
On JSON mode, build an inverted index in a sidecar file at write time. Add `?fields=` projection so a
search returns matching ids and snippets rather than whole records, which also mitigates D17.

---

## Postgres-vs-JSON divergence table

Adapter references: `J` = `src/store.js` (`JsonStore`, `mergeById`), `P` = `src/postgres-store.js`
(`PostgresStore`).

| Behaviour | Postgres adapter | JSON adapter | Same? |
|---|---|---|---|
| Read scope | Filters rows to `COLLECTIONS`; anything else invisible (`P:63`) | Returns every key in the file, including unlisted/legacy ones (`J:61`, `{ ...emptyStore(), ...parsed }`) | **No** |
| `merge()` with an unknown collection key | Ignored silently — loop is over `COLLECTIONS` (`P:100`) | Ignored silently (`J:78`) | Yes (both a defect — D9) |
| Record with no `id` | Dropped: `.filter((item) => item?.id)` (`P:101`) | Kept, keyed at `undefined` in a `Map`, collapsing all such records into one (`J:117`) | **No** |
| Record ordering within a collection | `ORDER BY updated_at DESC` on the row column; `now()` is transaction-scoped so a whole batch shares one timestamp (`P:80,148`) | Sorted in JS by `recordTimestamp` — the record's own `updated_at`/`observed_at`/`occurred_at`/… (`J:123,126-135`) | **No** (D6) |
| `payload_hash` source for dedup | The indexed `payload_hash` **column** (`P:132-136`) | The `payload_hash` field inside the body (`J:106,114`) | **No** — see next row |
| `payload_hash` after `write()` | Column set to `NULL` for every row (INSERT column list omits it, after `DELETE FROM lite_records`) (`P:75,79-82`) | Body field untouched; survives | **No** (D2) |
| `write()` semantics | Destructive: `DELETE FROM lite_records`, then reinsert (`P:75`) | Non-destructive to unknown keys: `{ ...emptyStore(), ...data }` (`J:69`) | **No** (D2) |
| `write()` cost | Full-table delete + one INSERT per row, no batching | One `JSON.stringify` of the whole store | Comparable; P leaves table bloat |
| Atomicity of a single write | One transaction: `BEGIN` / `COMMIT` / `ROLLBACK` (`P:74,87,90`) | None — `fs.writeFile` truncates in place (`J:71`) | **No** (D7) |
| Concurrency on `merge()` | Row-level upsert; concurrent merges do not lose each other | Unlocked read-modify-write; concurrent merges lose records wholesale (`J:76,83`) | **No** (D8) |
| Durability / crash safety | WAL-backed | Single file, no temp+rename, no backup; a torn write bricks every route (`J:57-66`) | **No** (D7) |
| File permissions | n/a (DB roles) | Created at process umask, typically `0644` — world-readable (`J:71`) | **No** |
| Corrupt-store behaviour | Unaffected — rows are independent | `JSON.parse` throws and propagates; only `ENOENT` is handled (`J:62-65`) | **No** |
| Record validation on write | None (`P:97-120`) | None (`J:75-84`) | Yes (both a defect — D10) |
| Schema migration | One additive `ALTER TABLE ... IF NOT EXISTS` plus a backfill (`P:40-49`) | None; `version: 1` never read | **No** (D11) |
| `replaceAnalytics()` | Deletes and reinserts the six analytics collections in one transaction (`P:183-214`) | Rewrites the file with the six collections replaced, rest preserved (`J:86-97`) | Yes |
| `read()` return `updated_at` | Newest row's column timestamp (`P:65`) | `nowIso()` of the last write (`J:69`) | **No** — differs by design |
| Full read per request | Yes — unbounded `SELECT` (`P:60`), and `merge()` reads again (`P:119`) | Yes — full file read + full serialise on write (`J:57,71`) | Yes (both a defect — D17) |

The pattern across the table: **every divergence is caused by one of the two adapters having a
capability the other lacks.** Postgres has transactions and an index; JSON has neither. Postgres has
a `payload_hash` column; JSON has the body field. JSON has a body-timestamp sort; Postgres has a
column sort. The two are not two implementations of one specification — they are two different
specifications that happen to share a method signature.

---

## Dead code and stubs

Verified with a repo-wide grep across `src/`, `test/`, `examples/`, `scripts/`, `docs/` excluding
`node_modules`.

### `signPayload` — defined, exported, never imported
`src/webhooks.js:44`. Repo-wide grep for `signPayload` returns exactly two hits: the definition and
the broken call in `src/outbox.js:54`. Nothing imports it. Meanwhile `outbox.js` calls an undefined
identifier (D4). The function is correct; the wiring is missing in both directions.

### `recentRequestOutcomes` — exported, never called
`src/observability.js:19`. Repo-wide grep returns only the definition. Its sibling
`computeShortTermSuccessRate` has two call sites, so the ring buffer is populated and read — just not
through this accessor.

### `resetSdnCache` — exported, comment claims tests use it, none do
`src/sanctions.js:99-104`, with the comment `Clear the cached SDN list. Used by tests.` Repo-wide
grep returns only the definition. No test in `test/` clears the SDN cache, so any test that exercised
the 24-hour TTL would be order-dependent.

### `pendingForFocalPoint` — imported, never called
`src/workflows.js:162`. Imported at `src/server.js:60` in a six-name import from `workflows.js`, and
`grep -n "pendingForFocalPoint" src/server.js` returns only that import line. It is the
`focal_point_review`-by-district queue query — the natural queue for an operator worklist — and it is
not wired to any route.

### `recordLineage` — called, but a stub with a dead parameter
`src/lineage.js:3-20`. Called once, at `src/ingestion.js:187`, so this is not dead code — but it is
incomplete. `store` is accepted and never used. `upstream_url_or_endpoint` is hardcoded `null` and
`transform_version` is hardcoded `'0.1.0'`. The `payload_hashes` array carries no `(collection, id)`
pairing, so no individual record can be traced to its run. See E4.

### `outbox.js` local `matchEvent` — duplicated from `webhooks.js`
`src/outbox.js:107-127` is a byte-identical copy of `src/webhooks.js:32-42`. `webhooks.js` exports
its copy and it is used by `src/server.js:2003` (`normalizeWebhookSubscription`, a different export
from the same module); `outbox.js` could import it. Duplication is what let D4 happen — the
`signPayload` sibling was copied in one place and not the other.

### `recordsForReportSources` / `markdown_download` — records a count, not an artefact
`src/reports.js:1373`: `markdown_download: { bytes: renderReportMarkdown(report).length }`. The
distribution run records how many bytes the document *would* be and then throws the document away,
so a delivered SITREP cannot be replayed or verified after the fact. Not dead code — a stub
producing a metric where the code expects a deliverable. See E11.

### `renderQuarterlyReportPdf`'s `signatureHash`
`src/pdf.js:11`. Not dead, but see D21 — it produces a value with no verification path.

---

## Rejected

**Full event sourcing.** Rejected. The system is a single-writer lite deployment; replaying the
event log to rebuild state would replace one JSONB table with a projection pipeline and a replay
harness, for an audit guarantee that a hash-chained action log (E3) plus a transactional outbox
(E5) delivers at a fraction of the complexity. If the guarantee is ever needed, E3 is the ratchet to
turn before committing to replay.

**A graph database for lineage.** Rejected. No traversal query exists in the codebase — lineage is
read linearly (`src/lineage.js:6`). Adding Neo4j to answer a question that an indexed
`edges JSONB` column and one `WHERE` answers is infrastructure for its own sake. E4 stays relational.

**Full-database encryption (pgcrypto or disk-level).** Rejected as the primary PII control. It
prevents an operator with database access from reading data, but it does nothing for the actual
failure modes: retention that does not delete (D1), redaction that misses fields (D18), and a
world-readable JSON file (D7). Field-level crypto-shredding over a declared PII registry (E7) plus
working erasure (E6) addresses the requirement directly. Disk encryption belongs in the deployment
guide, not the schema.

**A PDF library (pdfkit, puppeteer, pdfmake).** Rejected. `src/pdf.js` renders a fixed 12-row KPI
table with built-in Helvetica and no dependencies; the zero-runtime-dep constraint is a stated
project property and `pg` is already the only exception. Real multi-page or templated PDFs are an
enhancement (E11), not a reason to take on a native dependency.

**Kafka, Redis or a dedicated job queue.** Rejected. The job volume is a handful of ingestion runs
and report schedules per day. Durable per-run state rows plus a resumable cursor (E12) and a
`pg_jobs`-style table satisfy the requirement inside the existing Postgres instance. A broker is a
service to operate, monitor and secure for zero throughput gain at this scale.

**`node-pg-migrate` or a third-party migration tool.** Rejected in favour of ~60 lines of runner
(E2). The dependency budget is a project constraint, the migration set is small, and the checksum
guard that matters (detecting an edited-after-release migration file) is a dozen lines.

**Validating every record against a full schema at the store boundary (as an immediate fix for
D10).** Rejected as a *fix*, adopted as part of the *enhancement*. Enforcing a full spec inside
`merge()` would break every connector that legitimately emits evolving shapes — hazard events
explicitly preserve unknown `event_type` values by design (`src/schema.js:63-66`). The spec should
be per-collection, opt-in strictness, and default to warning rather than rejection for connector
output. E1's generated columns give the same structural guarantee without a validation tax on every
write.