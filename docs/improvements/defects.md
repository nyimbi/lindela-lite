# Defects, security holes, and architectural deficiencies

Companion to [enhancements.md](enhancements.md) and [roadmap-extension.md](roadmap-extension.md).

Everything here was read in the current tree. Line numbers refer to clean `HEAD`
(`b07bbe4`); the audit working tree was reverted before writing. Where a claim was
non-obvious it was reproduced, and the reproduction is stated. Raw evidence sits in
[_research/](_research/), one file per domain.

## How to read this

Severity is impact on a humanitarian operator, not CVSS.

| Severity | Meaning here |
|---|---|
| **Critical** | Loses data silently, hands out data that should not leave, or reports a thing is broken when it is working. |
| **High** | A plausible operational sequence produces a wrong decision. |
| **Medium** | Correct today, fragile tomorrow, or leaks more than it should. |
| **Low** | Noise, hygiene, dead weight. |

Roughly 55 findings. The four that decide whether this platform can be deployed
outside a laptop: **SEC-01** (every GET is unauthenticated), **SEC-04**
(auth fails open), **DAT-03** (concurrent writes are silently lost), **DAT-01**
(Postgres `write()` wipes the table and breaks dedup).

---

## Critical

### SEC-01 — Every GET route is unauthenticated, including full-data export

`src/server.js:237`

```js
} else if (url.pathname !== '/api/v1/health') {
  auth = authenticate(req)
  if (!auth && req.method !== 'GET') {
    jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
```

`req.method !== 'GET'` means an unauthenticated GET is never rejected. This holds
even when API keys are correctly configured, which makes it worse than having no
auth: the deployment looks secured.

`GET /api/v1/export.csv` (`src/server.js:869`) returns field reports, RapidPro
inbound messages and interventions. `docs/configuration.md:10` describes the API
key as "Optional". `docker-compose.yml` binds `0.0.0.0:4177`.

**Failure.** One unauthenticated `curl` to a district server yields the
operational picture and the personal data of everyone who reported through it.
For a tool used in conflict settings, that is the whole asset.

**Fix.** Invert the rule: reject unauthenticated requests regardless of method,
carve out only `/api/v1/health` and static assets. See ENH-01 for the scope table.

### SEC-02 — The RapidPro field-report webhook is open by default

`src/rapidpro.js:229-231`

```js
export function verifyRapidProWebhook(req, url, env = process.env) {
  const secret = env.RAPIDPRO_WEBHOOK_SECRET
  if (!secret) return true
```

`.env.example:28` ships `RAPIDPRO_WEBHOOK_SECRET=` empty. The verification result
is only consulted at `src/server.js:230-234`, and that branch short-circuits the
entire auth block, so `authenticate()` and `requireScope()` are never reached.

**Failure.** Anyone who can reach the port can POST a fabricated field report.
It becomes an incident, a task and an action-log entry (`src/server.js:1609-1615`).
The tool that field staff rely on to escalate can be written into by a stranger.

### SEC-03 — A read-only token can perform every unnamed mutation

`src/auth.js:66-79`. `scopeForRoute` has five special-cased prefixes; everything
else falls through to `return 'read:hazards'`.

**Reproduced.** A `read:hazards` token received **201** on `community-feedback`,
`webhooks`, `chw/reply`, `outbox/dispatch` and `equity/scan`, and **200** on
`maintenance/apply-retention`. `alert-rules` and `reports` correctly returned 403,
which is what makes this invisible in a smoke test.

**Failure.** Scope is enforced only where someone remembered to name a route. A
token issued "just to view the map" can register a webhook pointing anywhere and
trigger a broadcast to every field team.

### SEC-04 — Auth fails open on unset *or malformed* configuration

`src/server.js:229` gates the whole auth block on env vars being present:

```js
if (process.env.LINDELA_LITE_TOKENS || process.env.LINDELA_LITE_API_KEY) {
```

`src/auth.js:13` returns `[]` on a JSON parse error. A typo in
`LINDELA_LITE_TOKENS` therefore disables authentication silently rather than
failing startup. `README.md:79`'s documented start command deploys
unauthenticated.

**Fix.** Fail closed and fail loudly. Refuse to start if auth env is present but
unparseable; require an explicit `LINDELA_LITE_AUTH_DISABLED=1` to run open, and
have `/api/v1/health` report the auth posture so it is visible.

### DAT-03 — Concurrent writes to the JSON store are silently lost

`src/store.js:75-83`

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

Read, `await`, modify, write. No lock, no queue, no compare-and-set.

**Reproduced.** 20 concurrent `POST` requests left **6 survivors**. Fourteen
writes vanished with no error, and each caller received 201.

Node is single-threaded, which invites the assumption that this is safe. It is
not: every `await` is a yield point, and the two sidecars plus N browser tabs
generate plenty of interleaving.

**Fix.** Serialise writes through an in-process promise chain per store instance,
and write to a temp file then `rename()` (see DAT-04).

### DAT-01 — `PostgresStore.write()` wipes the table and permanently breaks dedup

`src/postgres-store.js:70-82`

```js
await client.query('BEGIN')
await client.query('DELETE FROM lite_records')
for (const collection of COLLECTIONS) {
  for (const item of next[collection] || []) {
    await client.query(
      `INSERT INTO lite_records (collection, id, body, updated_at)
       VALUES ($1, $2, $3::jsonb, now()) ...`)
```

Two faults in one method.

**a.** `DELETE FROM lite_records` has no `WHERE`. It is defensible as "the caller
passed the whole store", but `write()` is public and the JSON adapter's `write()`
is equally whole-store, so the trap is that any caller reaching for `write()` to
update one thing erases everything else.

**b.** The INSERT omits `payload_hash`. The dedup path at
`src/postgres-store.js:133-134` reads that column to skip already-seen records.
After a single `write()`, every row has `payload_hash IS NULL`, so dedup matches
nothing and never recovers until a full re-ingest. The backfill dedup that
`analytics/ensemble.js` and roadmap item 18 depend on is dead on the Postgres
backend after any write.

### DAT-02 — `countRecords` reads four collections while ingestion merges six

Full write-up in [_research/00-audit-baseline.md](_research/00-audit-baseline.md#d1-countrecords-reads-four-collections-while-ingestion-merges-six).
Short form: `src/ingestion.js:334-342` hardcodes four collection names; the merge
accumulator at `:105-111` handles six.

**Failure.** `ipc_hdx` and `who_gho` report `degraded — Expected at least 1
records; received 0` after fetching hundreds of classifications. Ingestion claims
failure while succeeding, which trains operators to ignore the health signal.

### DAT-05 — `PostgresStore.replaceAnalytics` discards the impact figures

`src/postgres-store.js:164`

```js
async replaceAnalytics({ risk_scores = [], impact_assessments = [], data_quality = [], road_access = [] }) {
  return this.merge({ risk_scores, impact_assessments, data_quality, road_access })
}
```

`src/analytics.js:21` passes six collections. `JsonStore.replaceAnalytics`
(`src/store.js:86`) accepts six. On Postgres, `population_at_risk` and
`facilities_at_risk` are computed and thrown away — the people-at-risk and
facilities-at-risk figures are never persisted. It also merges where the JSON
store replaces, so a region that stops qualifying keeps its last risk score
forever. See [_research/00-audit-baseline.md](_research/00-audit-baseline.md#d2-postgresstore-replaceanalytics-silently-discards-the-impact-figures).

### SEC-05 — The webhook URL is an SSRF primitive

`src/webhooks.js:6-9`

```js
const url = String(input.url || '').trim()
if (!url || !url.startsWith('http')) {
  throw Object.assign(new Error('url must be an HTTPS or HTTP URL'), { statusCode: 400 })
}
```

`startsWith('http')` accepts `httpfile:`, and more importantly accepts any host.
**Reproduced:** `http://169.254.169.254/latest/meta-data/` registered and armed.

Combined with SEC-03, a read-only token can arm an SSRF probe. `distributeReport`
(`src/server.js:1380`) then fetches it with no timeout and no signature.

### DAT-07 — The retention endpoint purges nothing and reports success

`src/server.js:373-391` computes `expired`, then calls `store.merge` with only
`kept`. Neither store adapter has a delete path; `merge` cannot remove.

**Reproduced.** A 400-day-old record reported `expired: 1` and remained readable
afterwards.

This is the worst combination in the codebase: the operator asks for deletion of
personal data, receives `{success: true}`, and has a false compliance record.
`docs/api.md:567-573` additionally documents a `dry_run` flag on this route that
does not exist.

### INT-01 — Signed webhooks never deliver, silently

`src/outbox.js:54` calls `signPayload`, defined at `src/webhooks.js:44` and
imported nowhere into `outbox.js`. The resulting `ReferenceError` is swallowed by
the empty `catch` at `src/outbox.js:72-74`; `last_error` is never written.

**Reproduced against a live listener.** Signed subscription: nothing received,
retried 5 times, marked failed. Unsigned: delivered.

Every secret-protected webhook subscription is dead, and the outbox reports
"failed" without a reason. Integrators conclude the signature scheme is wrong.

### INT-02 — The trigger backtest never evaluates the trigger

`src/alerts.js:163-200` ignores `protocol.metric`, `protocol.operator` and
`protocol.threshold`. It counts "did a hazard follow this ingestion run".
`misses` is arithmetically always 0, so recall equals precision and both are
meaningless. (This is the one defect `docs/architecture/system-overview.md` §7
already records; it is repeated here because it is severe enough not to be left
in a comment.)

**Failure.** An anticipatory-action protocol is backtested, reports 100% precision
and recall, and is presented to a donor as evidence. The number describes
incidence of hazards, not trigger performance.

### INT-03 — Parametric insurance stores a trigger and never reads it

`src/parametric.js:46-49` persists `trigger_metric`, `trigger_threshold` and
`disbursement_amount_local_currency`. Neither the metric nor the threshold is
ever read. `simulateDisbursement` copies the static amount.
`src/server.js:2160` gates on `Boolean(body.focal_point_approved)`, a
self-asserted field, while the workflow machinery that could carry a real
approval (`src/workflows.js`) is unused. All three parametric write paths
(`src/server.js:2073, 2095, 2162`) write no action log.

The money path is unaudited, unruled, and self-approved.

### SEC-06 — Multi-tenancy is a provable no-op that displays itself as working

`scopeToPartnerOrg` (`src/auth.js:85-88`) keys on `auth.partner_org`, which
`authenticate()` never sets. It has no call sites in `src/`. Yet
`public/portal/app.js:96-99` renders the filter as applied.

The partner portal promises per-organisation isolation and delivers the whole
store to every partner.

---

## High

### Authentication and network

- **SEC-07 — No rate limiting anywhere.** No limiter exists in `src/`. The
  connectors' declared `rateLimit` fields are honoured nowhere, so IPC fans ~92
  concurrent requests against a documented 20/min budget (`src/connectors/ipc-hdx.js:265`).
  Compounds SEC-01: the export endpoint is uncapped and unauthenticated.
- **SEC-08 — Webhook glob patterns compile to unescaped regex.** `src/webhooks.js:51-59`
  escapes only `.` before mapping `*` to `.*`. A pattern containing `(`/`+` becomes
  a catastrophic-backtracking regex. **Measured 14,168 ms at n=26** on `(a+)+`.
  Duplicated at `src/outbox.js:119`. Patterns are user-supplied via
  `POST /api/v1/webhooks`, so this is an unauthenticated-cost DoS under SEC-03.
- **SEC-09 — Token comparison is not constant-time**, `src/auth.js:31`
  (`t.token === token`), and **the first 8 characters of the bearer token are
  persisted as the actor** at `src/auth.js:37` into every `action_logs` row.
  **Reproduced:** `token_SUPERSEC` in a stored record. Action logs are exported
  and shipped in reports.
- **SEC-10 — `/metrics` is served before the auth gate.** `src/server.js:105-109`
  returns before `handleApi` at `:110`. `/api/v1/metrics` is unauthenticated
  despite its namespace. Leaks route labels, rates and error counts.
- **SEC-11 — Internal error messages reach the client.** `src/server.js:118-122`
  returns `error.message`. `pg` errors carry connection strings and statement
  text; `JSON.parse` errors carry payload fragments; filesystem errors carry
  absolute paths.
- **SEC-12 — CSV export is formula-injectable.** **Reproduced:** a field name
  beginning with `=` survives into `export.csv`, and Excel executes it on open.
  Field reports contain attacker-supplied text by design.
- **SEC-13 — Container runs as root; `.dockerignore` typo.** No `USER` directive.
  `.dockerignore:5` lists `.omx`, not `.omc`, so agent session state ships in the
  image. `.claude/` and the 19 MB `.zvec-grep/` index are also unexcluded.
  `docs/` (including a 946 KB PDF) and `scripts/` ship at runtime.

### Privacy

- **PRIV-01 — CHW reporter name and phone stored unredacted.**
  `src/server.js:2240-2241` sets `contact_urn: body.reporter_phone` and
  `contact_name: body.reporter_name` on the `record`, while `redactPii` is
  applied to an object that never receives those fields. The RapidPro path
  redacts correctly; the HTTP path does not. **Reproduced:** name and phone
  returned by unauthenticated `GET /rapidpro/inbound` and present in `export.csv`.
- **PRIV-02 — PII controls are off by default, unsalted, and skip the equator.**
  `src/pii.js:5` `redactNames: false`; `src/pii.js:91` uses unsalted SHA-256
  truncated to 32 bits, dictionary-reversible for a bounded name set;
  `src/pii.js:34` guards with `if (record.latitude && record.longitude)`, so a
  coordinate at exactly 0° is treated as absent and skips geo-coarsening. This is
  precisely the null-vs-zero conflation `src/server.js:2205` warns against
  elsewhere in the same codebase.
- **PRIV-03 — Soft delete retains PII permanently** (`src/operations.js:81`), and
  community feedback is in no retention list at all.

### Data correctness

- **DATA-01 — `/api/v1/flood-probability/score` with no `region` scores an
  arbitrary district.** `src/server.js:560-563` sorts all models by `trained_at`
  and takes `models[0]`. **Reproduced semantics:** asking for flood probability
  without naming a region returns whichever district trained most recently, with
  no indication that a different district was chosen.
- **DATA-02 — The scored probability ships bare.** `src/server.js:583` returns a
  number with no interval, no sample size, and no contingency table, while the
  model computes all three. The honesty lives in the model card, not the payload.
- **DATA-03 — `computeFacilitiesAtRisk` counts each asset once per nearby
  hazard.** `src/analytics/impact.js:71` increments `at_risk_count` inside the
  per-hazard loop. An asset near three hazards is counted three times, inflating
  both the facility count and `total_population_served`. **This file has 100% line
  coverage** (`npm run test:coverage`), which is the clearest evidence in the
  repository that coverage was treated as a target rather than a signal.
- **DATA-04 — Risk scores scale with hazard *count*, not conditions.**
  `src/analytics.js:76`: `hazards.reduce((sum, event) => sum + severityWeight(event.severity) * 30, 0)`.
  Backfilling a historical archive raises every covered district's risk score
  toward 100 without any change in conditions. This compounds the 233-events-at-
  Null-Island incident already fixed in `36ad94e`.
- **DATA-05 — District overview truncates to 30 and reports the total.**
  `src/districts.js:73-74` applies `.slice(0, 30)` to field reports and alert
  events, which then feed `false_alert_rate` denominators.
- **DATA-06 — Equity accuracy can go negative.** `src/equity.js:57` divides
  dispatched alerts by resolved alerts, and the numerator and denominator are
  different populations. It also drives workflow creation.
- **DATA-07 — Two surfaces disagree about missing false-alert rates.**
  `src/equity.js:43` renders `null` as "not yet measurable"; `src/districts.js:107`
  renders the same value as `0%`. One district's honest unknown is another's
  confident zero, and the equity KPI cannot be reconciled across surfaces.
- **DATA-08 — Road access ignores time.** `src/road-access.js:132` never reads
  `occurred_at`, so a 1985 archive flood closes roads today. Road passability also
  has no elevation or depth input at all (`src/road-access.js:139`) and is not
  connected to `flood-depth.js`, which computes exactly that.
- **DATA-09 — `depthGrid` lacks the `NO_DATA_FLOOR_M` guard `depthAtPoint` has**
  (`src/flood-depth.js:214`), so coastal bathymetry is reported as flood depth.
  `src/flood-depth.js:43` asserts output is "above sea level" with no datum
  parameter and no datum check anywhere in the codebase.
- **DATA-10 — Lineage attributes every record to every source.**
  `src/ingestion.js:181-188` rebuilds a run-wide `allRecords` union inside the
  per-source loop, so a nine-source run writes nine identical lineage records with
  the same `record_count` and `upstream_checksum`. `upstream_url_or_endpoint` is
  always null and `transform_version` is a constant (`src/lineage.js:14-15`).
  IPC and WHO collections are excluded from lineage entirely.
- **DATA-11 — There is no migration path.** `src/postgres-store.js:47` issues a
  single hardcoded `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; the `version: 1`
  written by `ensureSchema` is never read. A deployment that has been running
  when a record shape changes has no upgrade route.
- **DATA-12 — Record ids mix the current timestamp into the hash**
  (`src/operations.js:104`, `src/lineage.js:9`, `src/reports.js:187`,
  `src/workflows.js:98`, `src/community.js:36`, `src/server.js:2213`), so
  re-submitting identical content produces a different id and defeats dedup.
- **DATA-13 — `payload_hash` dedup is not namespaced** (`src/store.js:114`): two
  records differing only by id collide, and a re-imported GeoJSON is silently
  discarded as a success.
- **DATA-14 — `schema.js` performs no validation.** There is no `extra=forbid`
  equivalent; arbitrary shapes are accepted and persisted.
- **DATA-15 — The audit trail is self-asserted.** `src/operations.js:101` records
  an actor string the caller controls, there is no auth on many of the paths that
  write it, and `src/server.js:1162-1163` shows the outbox write is not
  transactional with the state change that produced it.

### Ingestion fidelity

- **ING-01 — GDACS severity is a substring match.** `src/connectors/gdacs.js:139`
  `lower.includes('red')` matches *predicted*, *Red Sea*, *reduced*. A green South
  Sudan flood is stored `severity: 'red'` beside `alert_level: 'green'`, and risk
  scoring reads `severity`.
- **ING-02 — GloFAS severity is fabricated.** `src/connectors/glofas.js:38` matches
  `/high|severe|red/i` over title and description and otherwise always emits
  `'medium'`. The feed has no severity field; the connector invents one.
- **ING-03 — `open_meteo.observed_at` carries no timezone.**
  `src/connectors/open-meteo.js:85`. Open-Meteo returns local time without an
  offset, and it is parsed in the server's local zone, so observations shift by
  the server's offset.
- **ING-04 — Backfills mint a new id every day.**
  `src/connectors/open-meteo-archive.js:73` and `open-meteo-flood.js:81` include
  `endDate` (defaulting to today) in the id, generating a fresh ~16k-entry series
  per region per day that payload-hash dedup cannot catch.
- **ING-05 — `metadata.fetched_at` defeats `payload_hash`.**
  `src/utils.js:35` strips only top-level keys; five connectors stamp the fetch
  time inside `metadata`, so dedup never fires and Postgres `updated_at` churns
  on every run.
- **ING-06 — No per-source wall-clock budget.** `src/connectors/http.js:5` times
  out per attempt only. `src/connectors/gdacs-archive.js:46-74` issues ~168
  sequential requests; worst case ~4.2 hours holding a `POST /ingest/run` socket,
  and `src/server.js` sets no request timeout.
- **ING-07 — Retry is doubled and the outer layer is inert.**
  `src/ingestion.js:314-323` plus `src/connectors/http.js:3-19`. Connectors catch
  and *return* rather than throw, so network failures receive only the 150/300 ms
  inner retries.
- **ING-08 — CHIRPS catalogues as rainfall and delivers nulls.**
  `src/connectors/chirps.js:83` against `connectors.registry.json:104`, which
  silently caps 730 files to 30 without recording `counts_found`.
- **ING-09 — Three staleness systems disagree.** `src/connectors/who-gho.js:134`,
  `src/connectors/ipc-hdx.js:217`, `src/analytics.js:454` and `SOURCE_POLICIES`
  each compute freshness differently. Annual and validity-window data is flagged
  stale by a global 2/14/45-day clock.
- **ING-10 — One bad date kills a whole CSV.**
  `src/connectors/uploads.js:191` calls `new Date(x).toISOString()` outside any
  per-row guard; a `RangeError` aborts the upload. An empty CSV reports clean
  success with zero records.
- **ING-11 — The outbox backoff is fictional.** `src/outbox.js:72-97`: silent
  `catch`, `last_error` never written, no `next_attempt_at`. Events are dropped
  permanently after five tries.

### Alerts and dispatch

- **ALERT-01 — CAP `Cancel` is unreachable.** `src/cap.js:39` keys on
  `'rejected'`/`'cancelled'`, but `ALERT_EVENT_STATUSES` (`src/schema.js:127`) is
  `open`/`acknowledged`/`resolved`. Rejected alerts keep publishing as live
  alerts to national systems.
- **ALERT-02 — The CAP endpoint has no approval gate.** `src/server.js:1649-1661`
  renders and serves CAP without the approval check that the SMS path enforces at
  `:1582`, despite `README.md` committing to human review of high-impact actions.
- **ALERT-03 — Alert suppression is a calendar bucket, not a rolling window.**
  `src/alerts.js:227-230`. **Reproduced:** evaluations two minutes apart across a
  bucket boundary produce buckets 248751 and 248752, hence a duplicate alert.
- **ALERT-04 — No hysteresis and no auto-supersede.** A persistent condition
  accumulates ~84 open alerts per week, all dispatchable, all inflating the equity
  KPIs that DATA-06 already miscomputes.
- **ALERT-05 — No delivery tracking.** `src/rapidpro.js:214` computes
  `response_rate_pct` as replies over dispatch count rather than over recipients;
  a broadcast to 500 people can report 300%. There is no delivery-report endpoint.
- **ALERT-06 — RapidPro sends have no timeout, retry or backoff**
  (`src/rapidpro.js:29-37`); a 429 hangs the request. There is no inbound
  idempotency, so a retried webhook double-SMs.
- **ALERT-07 — CAP `scope` is hardcoded `Public`** (`src/cap.js:42`) for every
  alert including security and conflict; the `scopeOverride` option is unreachable
  dead configuration.

### Tests and coverage

- **TEST-01 — The registration guards are blind to the defect they name.** `main` is
  green (370/370), which is the problem. The guards at `test/lite.test.js:5462` and
  `:5519` assert that a string appears in `src/ingestion.js`, and they grep the
  accumulator — which is correct — while DAT-02 lives in `countRecords` fifty lines
  away. Demonstrated, not inferred: refactoring the accumulator to derive from the
  same shared list as `countRecords` **fixes DAT-02**, and makes both tests fail.
  The guard is blind to the bug in its own failure message and brittle to the fix.
  Full analysis in
  [_research/00-audit-baseline.md](_research/00-audit-baseline.md#b1-the-registration-guards-are-blind-to-the-defect-they-name-and-break-on-the-fix).
- **TEST-02 — The production storage backend is effectively untested.**
  `src/postgres-store.js` sits at **23.29% line and 0.00% function coverage** while
  the aggregate reads 87.08% and the CI gate is 75%. Two mechanisms conspire: the
  `test:coverage` script omits `test/database.integration.test.js`, and that file
  skips itself without env vars CI never sets. Both DAT-01 and DAT-05 live here.
- **TEST-03 — The security boundary has no tests.** `authenticate`, `parseTokens`
  and `requireScope` have zero tests (`src/auth.js` at 47% branch).
  `verifyRapidProWebhook` has zero tests. `src/pii.js` has no tests at all, and it
  is the product's only PII control.
- **TEST-04 — The human-in-the-loop control is untested.** `src/alerts.js` is at
  41.58% branch with lines 164-224 uncovered: the approval gate, trigger
  protocols, backtest and shadow mode.

---

## Frontend: the eight surfaces

Full detail in [_research/frontend-visualization.md](_research/frontend-visualization.md).

**Finding that shapes everything else in this section: there is no charting
layer.** No charting library, no `<canvas>`, no reusable chart component anywhere
in `public/`. The complete inventory of graphics primitives in the product is 39
`svgEl()` calls inside `public/app.js` (the situation map), one 200×40 px inline
`<polyline>` sparkline at `public/co/app.js:328`, CSS-`<div>` bars at
`public/co/app.js:236`, and CSS-`<div>` bars again at `public/scenarios/app.js:342`.
Every other "chart" is a text strip: a `<span>` holding one sentence.

### WEB-01 — A district map drops every record on the equator or prime meridian

`public/districts/app.js:208` and `:229`

```js
...records.map(r => ({ lat: r.latitude ?? r.lat, lon: r.longitude ?? r.lon })).filter(p => p.lat && p.lon)
...
if (!lat || !lon) continue
```

Truthiness test on a coordinate. Latitude 0 and longitude 0 are real places and
both are falsy. This is the district officer's surface, and the file's own comment
three lines below asserts the count is honest.

This is the third instance of the falsy-zero conflation. See **Root cause 6**.

### WEB-02 — The severity filter admits every record that has no severity

`public/app.js:1173-1174`

```js
const visible = geo.filter((r) => {
  if (sevFilter && r.severity && r.severity !== sevFilter) return false
```

The middle clause is the bug: a record with `severity: null` satisfies
`sevFilter && null && ...`, which is falsy, so it is *not* filtered out. Set the
filter to `critical` and the map continues to show every medium and low record plus
every unclassified one. The record list at `public/app.js:1289` is built from the
same array, so the count in the filter bar is wrong too.

A control that visibly changes and does not do what it says is worse than no
control, because the operator trusts the map afterwards.

### WEB-03 — Scenario delta bars are truncated, unlabelled, and fixed-origin

`public/scenarios/app.js:342`. Bars encode a change, but the axis has no labels, no
units, and does not start at a meaningful baseline, so a −2% delta and a +40% delta
can render at similar widths.

### WEB-04 — The map encodes hazard type and severity by colour alone

`public/app.js`. No secondary encoding, so the three colour-vision deficiencies
(~8% of men) read severity incorrectly. Severity is the one thing on this screen
that must never be misread. This is the evidence behind **ENH-23**.

### WEB-05 — The CHW offline queue reports success for a report it discarded

`public/shared/runtime.js:55`

```js
async enqueue(path, options) {
  if (!this.db) return
```

A silent no-op. `public/chw/app.js:243` shows "Report queued", resets the wizard,
and the report exists nowhere. `flush()` was hardened for exactly this case;
`enqueue()` was not.

This is the one surface where telling the user something untrue is most
consequential: a health worker is told a health report was filed, and stops trying
to file it.

### WEB-06 — The service worker precache omits three files of the console's import graph

`public/sw.js:23-32` lists eight modules. `/shared/fmt.js`, `/shared/labels.js`
and `/components.css` are absent, though the console imports them. The list's own
comment claims "the full module graph".

As `docs/architecture/system-overview.md` §6 notes, a missing precache entry is a
hard boot failure offline, not a degradation — so the first offline load fails
outright. Nothing verifies the list against the real import graph.

### WEB-07 — The console redraws every 30 seconds and destroys keyboard focus

`public/app.js:3047` triggers a whitelisted `innerHTML` rebuild of the alerts list
at `:2160`. Focus falls to `<body>` and all 30 items re-animate. A user
mid-interaction with a keyboard loses their place twice a minute.

### WEB-08 — The CO dashboard shows last quarter's charts under this quarter's KPI tiles

`public/co/app.js:471-541`. `renderTrend` early-returns on absent data, and `:550`
counts a section as "loaded" when it is *not hidden* — so a stale chart counts as
loaded. A reader comparing a headline number against the chart beneath it is
looking at two different quarters presented as one.

### WEB-09 — Twelve-plus endpoints polled every 30 seconds, unconditionally

`public/app.js:1605-1630`. Every panel refetches on the same timer regardless of
whether it is open or whether anything changed. On 2G, which is the stated
constraint for the field surfaces, this is the single largest avoidable cost in the
frontend and it runs constantly.

### WEB-10 — Map markers sit below the 24px touch-target floor

`public/app.js:1032`. Radius 5 on low severity against an 800-unit viewport, with
no hit padding. `scripts/check-responsive.mjs` cannot see SVG, so CI is blind to it.

### WEB-11 — i18n coverage runs 17% to 92%, and three surfaces have none

Measured against `en.json` (227 keys): `sw` 209, `so` 101, `din` 58, `km` 55,
`nk` 55, `ar` 54, `am`/`fr`/`pt` 38. `npm run validate` prints the CHW table
separately and shows `am`, `ar`, `fr`, `km`, `nk`, `pt` at **0 of 44** — so the
locales offered on the console are largely empty on the surface built for the
person least able to read English.

`districts/`, `scenarios/` and `parametric/` contain zero `data-i18n` attributes
and have no i18n layer at all. `scripts/check-i18n.mjs` only checks CHW, so CI is
structurally blind to the other seven surfaces.

### WEB-12 — Two claims in `docs/plans/ui-ux-world-class.md` are false against the code

"Full module graph precached" and "all 8 surfaces link tokens.css + styles.css +
components.css". Neither is true: see WEB-06 and the fact that the console is the
one surface that does not link `components.css`. A planning document that records
completed work which is not complete will be trusted by the next reader.

---

## Medium and low, grouped

**Persistence** — Postgres and JSON disagree on ordering
(`postgres-store.js:60` `ORDER BY updated_at DESC` with no tiebreaker vs
`store.js:123` body timestamp; `now()` is transaction-scoped, so a whole batch
ties and report slices of 8 differ per backend). The JSON store writes in place
with no temp-file rename, no `fsync` and mode 0644 (`store.js:71`), so a power cut
mid-write truncates the file and every later request 500s. There is no SIGTERM
handler in `src/`. Unlisted collections are dropped silently by both adapters
(`store.js:78`, `postgres-store.js:63,100`), and the guard against that is a
comment, not code. `min(…spread)` (`Math.min(...array)`) can OOM on large
collections.

**Outbound HTTP** — `distributeReport` fetches with no timeout, unlike every
connector. HTTP error bodies are discarded at `src/connectors/http.js:6`, so
`Retry-After` is never seen. RapidPro outbound is likewise unbounded.

**Reports** — `markdown_download` records a byte count rather than the artefact
(`src/reports.js:1373`), so the exported report is not retrievable later. Report
webhooks are unsigned and untimed. `src/pdf.js:11` computes a "signature" that is
a self-referential 64-bit digest. Export returns only the record appendix;
the narrative exists solely in `export.md` with nothing saying so.

**Dead code** — `src/analytics/ensemble.js` is entirely dead: no connector sets
`ensemble_*`, `spreadSkillIndex` has zero callers, `computeEnsembleStats` is
test-only, and the `ensemble_used` branch is unreachable. `calibrationReport` is
exported at `src/analytics.js:5`, never routed (`src/server.js:835`), and cited in
the JTBD catalogue as evidence. `signPayload`, `recentRequestOutcomes`,
`resetSdnCache` and `pendingForFocalPoint` are all defined and never called.
`globMatch` is duplicated between `webhooks.js` and `outbox.js`, which is how
SEC-08 happened twice.

**Supply chain** — CI fetches unpinned packages at build time:
`npx --yes trivy` (`.github/workflows/ci.yml:44`, the scanner being the
least-safely-fetched thing in the repo), cyclonedx at `:53`, `wait-on` at
`:103,108`. Six of seven jobs have no `permissions:` block, all actions use mutable
tags, and there is no CodeQL job.

**Documentation** — eight broken internal links in `docs/architecture/`, pointing
at `frontend.md`, `deployment.md` and `decisions/`, which are referenced by the
reading-order README but were never written. Nine live routes are missing from
`docs/openapi.yaml`, including `/api/v1/impact/facilities-at-risk` while its
sibling is documented. `docs/plans/world-class-roadmap.md` is stale: at least 14 of
its 20 items have shipped, so a reader re-proposes work that exists. Full tables in
[_research/00-audit-baseline.md](_research/00-audit-baseline.md).

---

## The root causes

Fixing the 55 findings individually will not hold. They cluster.

**1. Everything is a `path:line` string and the tests assert on strings.**
TEST-01 is the proof. A guard that reads source text is simultaneously blind to the
defect and brittle to the fix. Every registration guard in this repository
(`store.js` COLLECTIONS, the ingestion merged map, `validate.mjs` doc tables) has
this shape, and the silent-key-list bug class has now recurred three times.

**2. Two adapters, two specifications.** `PostgresStore` and `JsonStore` share a
method signature and disagree about almost everything: replace versus merge,
ordering, dedup, deletion, id-less records, tiebreakers. Every divergence traced to
one adapter having a capability the other lacks. A conformance suite run against
both would have caught DAT-01, DAT-05, DAT-07 and DATA-13 at zero cost.

**3. Guards on one entry point, not its siblings.** DAT-02 counts the wrong
collections. DATA-04 coerces missing values that a sibling path handles correctly.
ALERT-03 suppresses in one bucket while ALERT-01 fails in another. The codebase
fixes case X properly and leaves case Y open, which is a good instinct applied
locally rather than systematically.

**4. Fail-open defaults.** Auth off when unset, webhook secret off when unset, PII
redaction off by default, `minimum_records: 1` for every source regardless of
cadence. In a humanitarian tool, the safe default is the expensive one.

**5. Coverage was treated as a number.** `src/analytics/impact.js` is at 100% line
coverage and double-counts. `src/postgres-store.js` is the production backend at 0%
function coverage. The aggregate (87%) and the gate (75%) are both satisfied while
the two most consequential modules are untested. What is missing is not more
coverage but assertions about behaviour: a per-module floor that cannot be satisfied
by executing a file, and behavioural tests for the adapters.

**A sixth, cross-cutting — and the easiest to eliminate:** falsy-zero conflation,
in both directions, in a codebase that has explicitly written down not to do it.
`src/server.js:2205` warns against it. `src/analytics.js` carries the comment
*"an absent forecast is not a 0% chance of rain"*, and `4a1ce17` was a commit
whose entire purpose was fixing it. Yet:

- `src/pii.js:34` — `if (record.latitude && record.longitude)`, so a coordinate at
  0° is treated as absent and skips geo-coarsening (PRIV-02).
- `public/districts/app.js:208,229` — `p.lat && p.lon`, dropping every record on the
  equator and prime meridian (WEB-01).
- `public/app.js:1173` — `sevFilter && r.severity && ...`, where the falsy zero
  *admits* rather than excludes, so the severity filter is inverted for null
  (WEB-02).

Three instances, two directions, in a repository with the correct rule written down
twice and a dedicated commit enforcing it. A lint rule banning truthiness tests on
`latitude`, `longitude`, `severity` and any `?count` field would catch all three,
and the fourth instance that has not been found yet.

**A seventh:** honesty is well policed in prose and poorly policed in payloads.
`scripts/check-no-flood-probability.mjs` enforces capability vocabulary across
`src/`, `public/`, `scripts/`, `test/` and `docs/`, which is genuinely unusual
discipline. But of 28 numeric outputs, 13 carry a qualification in the docs that
never reaches the response body — DATA-01, DATA-02, DATA-05, DATA-06, DATA-07 are
all instances. A user consuming the API sees a number; a user reading the docs sees
a number with caveats. That gap is the single most important thing to close, and it
is the subject of ENH-02.