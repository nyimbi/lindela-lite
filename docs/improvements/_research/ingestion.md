# Ingestion layer audit — Lindela Lite

Scope: `src/ingestion.js`, all 17 files in `src/connectors/`, `connectors.registry.json`,
`src/webhooks.js`, `src/outbox.js`, `src/workflows.js`, `src/lineage.js`,
`src/store.js` (merge semantics), `src/postgres-store.js` (merge semantics),
`src/analytics.js` (`computeDataQuality`), `scripts/check-live-sources.mjs`.

The codebase is unusually honest about its own limits — the CHIRPS/GloFAS/FIRMS
"reported success while ingesting nothing" fixes are all still visible in the
comments, and `docs/architecture/ingestion.md` documents the sequential design
rather than pretending otherwise. Most findings below are therefore not "nobody
noticed", but "the guard exists for case X and not for case Y". Where a finding
is already documented as a deliberate choice, it is listed under Enhancements
rather than Defects.

---

## Defects

### D1 — GDACS severity is chosen by substring match on free text

**Severity: High** (drives risk scoring; geographic false-positive mode)

`src/connectors/gdacs.js:137-146`

```js
const severity = normalizeSeverity(
  alertLevel === 'red' || lower.includes('red')
    ? 'red'
    : alertLevel === 'orange' || lower.includes('orange')
      ? 'orange'
      : alertLevel === 'green' || lower.includes('green')
        ? 'green'
        : 'unknown',
)
```

`lower` is `` `${title} ${stripTags(description)}`.toLowerCase() `` (gdacs.js:105).
`includes('red')` matches any word *containing* `red`: `predicted`, `hundred`,
`spreading`, `reduced`, `centered`, `shared`, `considered`, `Red Sea`. The
`alertlevel` field is already fetched and used first in the condition, but the
free-text clause overrides it whenever any such token appears anywhere in the
description.

Failure scenario: a GDACS **green** flood alert over South Sudan — a country whose
alerts routinely reference the Red Sea basin in the description text — is stored
with `severity: 'red'` and `alert_level: 'green'` side by side. `alert_level`
carries the truth and `severity` carries the keyword match, and downstream risk
scoring reads `severity`. The same substring hazard exists for `orange`
("Orange River" flood alerts in Lesotho/South Africa) and, less often, `green`.

One-line fix: trust `alertlevel` alone, with a word-boundary regex
(`/\b(red|orange|green)\b/`) only as a fallback for feeds that omit the field.

---

### D2 — Lineage attributes every record in the run to every source

**Severity: High** (audit correctness; the lineage feature is inert)

`src/ingestion.js:178-189`

```js
const data_lineage = []
for (let i = 0; i < source_runs.length; i++) {
  const run = source_runs[i]
  const allRecords = [
    ...merged.climate_observations,
    ...merged.hazard_events,
    ...merged.conflict_events,
    ...merged.service_assets,
  ]
  const lineageRecord = recordLineage(store, run, allRecords)
  data_lineage.push(lineageRecord)
}
```

`allRecords` is the union of everything merged during the run, rebuilt
identically inside the loop and not filtered by `run.source`. A nine-source run
emits nine `data_lineage` records, each claiming all ~600 records with identical
`payload_hashes` and `upstream_checksum` and differing only in `source`. A reader
asking "which run produced this FIRMS detection?" is told it was also produced by
the `gdacs` run.

Two further gaps in `src/lineage.js`:
- `upstream_url_or_endpoint: null` (line 14) — always null, never populated from
  the feed the connector actually read.
- `transform_version: '0.1.0'` (line 15) — a constant, so a changed parser
  produces an identical transform version and lineage cannot distinguish v1 from
  v2 output.
- `recordLineage(store, ...)` accepts `store` and never uses it (line 3).

Also note the collection list omits `food_security_records` and
`disease_observations`, so IPC and WHO records are never in lineage at all.

One-line fix: build lineage per source inside the source loop from that source's
own `output`, and have connectors return `{ _provenance: { url, fetched_at,
http_etag, transform_version } }` to populate the empty fields.

---

### D3 — No per-source wall-clock budget, so one slow upstream can hold a run for hours

**Severity: High**

`src/connectors/http.js:5` sets a timeout **per HTTP attempt**, and every
connector loops its own request list sequentially with no overall budget:

- `src/connectors/gdacs-archive.js:46-74` walks `1985..currentYear` × 4 quarters
  = ~168 requests.
- `src/connectors/ipc-hdx.js:265` fans out one `package_show` plus one GeoJSON
  download per country in the feed (46 by default).

Worst case for `gdacs_archive` alone: 168 requests × 3 attempts × 30 s
(`timeout_ms: 30000`, ingestion.js:77) ≈ **4.2 hours**, during which
`POST /api/v1/ingest/run` holds a socket open — `src/server.js` sets no request
timeout and `fetchWithRetry` has no circuit breaker. A hung GDACS archive does not
just slow the run; it consumes the whole request and the schedule slot
(`runDueIngestionSchedules` runs each due schedule in a `for` loop,
ingestion.js:243).

The per-attempt timeout is real and correct (http.js:5). What is missing is a
deadline for the *source*, not the *request*.

One-line fix: give each source a `budget_ms` in `SOURCE_POLICIES` and pass a
deadline into `fetchWithRetry`; stop the connector when `Date.now() > deadline`
and record a `budget_exhausted` error.

---

### D4 — Retries are doubled, and the outer layer never fires for the common failure

**Severity: Medium**

Two independent retry loops exist:

- `src/ingestion.js:311-325` — `runConnectorWithRetries`, `delay(Math.min(1000 * 2**attempt, 5000))`
- `src/connectors/http.js:3-19` — `fetchWithRetry`, `delay(150 * 2**attempt)`

Both read the same `options.retries`, so a network failure costs 3 HTTP attempts
per connector attempt. The outer loop is inert for network failures anyway:
every connector wraps its fetches in `try { ... } catch (error) { errors.push(...) }`
and **returns** rather than throwing (e.g. `gdacs.js:53-55`,
`usgs-earthquake.js:74-76`, `open-meteo.js:114-116`), so `runConnectorWithRetries`
only retries connectors that throw — `JSON.parse` failures in `ipc-hdx.js:395`,
`open-meteo-archive.js:61`, `usgs` schema drift. Net effect: a transient 503 gets
3 fast retries (150 ms, 300 ms) and no escalation, while a deterministic parse bug
gets 3 full re-fetches of a multi-megabyte GeoJSON.

One-line fix: pick one layer. Keep retries in `fetchWithRetry` and have
`runConnectorWithRetries` re-run only on a declared retryable error class.

---

### D5 — `open_meteo` stores `observed_at` with no timezone

**Severity: High** (timeliness; every downstream date filter is offset)

`src/connectors/open-meteo.js:65-71, 85, 105`

```js
url.searchParams.set('timezone', 'UTC')
...
observed_at: data.current.time,          // line 85
...
observed_at: daily.time[i],              // line 105
```

Open-Meteo returns `current.time` as a *local* ISO time for the requested zone
with **no offset suffix** — `2026-10-03T14:00`, not `...14:00Z`. Stored verbatim,
`Date.parse` in every consumer (`mergeById`'s `recordTimestamp`,
`latestDate` in `analytics.js`, the alerts engine) reads it in the **server's**
local timezone. On a UTC+3 host the same observation is stamped three hours
early; `daily.time[i]` is date-only and so shifts across the day boundary in
negative offsets.

Failure scenario: the server moves from UTC to EAT, and every `open_meteo`
observation silently rewinds three hours. Nothing errors; freshness scores shift.

One-line fix: normalise to UTC at the connector — `${time}Z` for the local-time
string, or better, request `timeformat=unixtime` and store `new Date(n*1000).toISOString()`.

---

### D6 — Backfill connectors mint a new record id every day, duplicating 45-year series

**Severity: High** (store growth; duplicate-record ambiguity)

`src/connectors/open-meteo-archive.js:47-48, 73-75` (identical at
`open-meteo-flood.js:48-49, 81-83`)

```js
const endDate = options.archive_end_date ||
  new Date().toISOString().slice(0, 10)
...
id: stableId('climate', ['open_meteo_archive', region.name, startDate, endDate]),
source_id: `open_meteo_archive:${region.name}:${startDate}:${endDate}`,
```

The identity key includes `endDate`, which defaults to *today*. Every calendar day
of backfill runs produces a **new record id** for the same region and the same
1981-start series, and each carries the full `daily` array (~16,000 entries for
ERA5, ~15,000 for discharge). Three regions × 30 days = 90 near-identical
multi-megabyte records, and `mergeById`'s `payload_hash` skip does not catch them
because the ids differ.

The same applies to any manual re-run with a different `archive_end_date`.

One-line fix: key the record on `(source, region)` and store `series_end` as
mutable state; append only the delta past the stored `series_end`.

---

### D7 — `metadata.fetched_at` makes `payload_hash` volatile, so "unchanged" never holds

**Severity: Medium** (defeats the dedup/change-detection mechanism)

`src/utils.js:35`

```js
export function canonicalHash(record, ignoreKeys = ['id', 'payload_hash', 'ingested_at',
  'generated_at', 'updated_at', 'created_at', 'first_seen_at']) {
```

Only **top-level** keys are ignored. Five connectors stamp
`metadata.fetched_at = new Date().toISOString()` on every record
(`ipc-hdx.js:248`, `who-gho.js:147`, `gdacs-archive.js:145`,
`open-meteo-archive.js:97`, `open-meteo-flood.js:106`), which is inside `metadata`
and therefore inside the hash.

Consequence: for those sources `mergeById`'s `hashMap` short-circuit
(`src/store.js:114`) never fires, so every run rewrites every record; in Postgres
`ON CONFLICT (collection, id) DO UPDATE` bumps `updated_at = now()` for the whole
collection (`src/postgres-store.js:151`), reordering the store by write time
rather than observation time. The change-detection primitive that replay, audit
and "what moved today" would all be built on is already unusable for a third of
the sources.

One-line fix: exclude `metadata.fetched_at` (or add `fetched_at` to a nested
ignore set) in `canonicalHash`.

---

### D8 — `payload_hash` dedup is not namespaced by source or id

**Severity: Medium** (silent record loss)

`src/store.js:100-124`

```js
for (const item of incoming) {
  if (item.payload_hash && hashMap.has(item.payload_hash)) {
    continue
  }
  map.set(item.id, { ...map.get(item.id), ...item })
```

The hash map is keyed on payload alone, per collection — not per `source`, and not
per `id`. Combined with `canonicalHash` ignoring `id`, **two records that differ
only by their id are the same record as far as the store is concerned**, and the
second is dropped with no error.

Failure scenario: a GeoJSON of service assets is re-imported after the upstream
assigns new feature ids. `normalizeServiceAsset` (`uploads.js:98`) prefers
`asset.id` over the derived `stableId`, so ids differ, every field is identical,
`payload_hash` matches, and the entire re-import is silently discarded with
`records_processed: N` and `status: 'success'`.

One-line fix: namespace the hash as `canonicalHash({ source: item.source, body: item })`
or make the map key `${item.source}:${item.payload_hash}`.

---

### D9 — One unparseable date destroys an entire conflict CSV import

**Severity: Medium** (whole-source failure from one bad row)

`src/connectors/uploads.js:177-204`

```js
function normalizeConflictEvent(row, source) {
  ...
  occurred_at: new Date(eventDate).toISOString(),
```

`new Date('not a date').toISOString()` throws `RangeError`. There is no
per-row guard: `conflictCsvConnector.ingest` does
`rows.map((row) => normalizeConflictEvent(row, 'conflict_csv')).filter(Boolean)`
(uploads.js:26). One row with a blank-but-present date, an Excel serial, or a
`DD/MM/YYYY` string throws, `runConnectorWithRetries` retries the same parse
twice more, and the run is recorded `failed` with **zero** conflict events
persisted.

The mirror case is worse: a CSV that parses to zero rows (empty input,
`parseCsv('')` returns `[]`) yields `{ conflict_events: [], errors: [] }`, and with
`minimum_records: 0` (ingestion.js:82) that is a **clean success**. So a malformed
upload either loses everything or silently imports nothing, and the store can
tell you neither apart.

One-line fix: guard `normalizeConflictEvent` per row — return `{ error }` like
`normalizeServiceAsset` does — and give the CSV connectors `minimum_records: 1`
when a body was supplied.

---

### D10 — CHIRPS silently truncates to 30 records out of up to 730

**Severity: Medium** (completeness claimed but not delivered)

`src/connectors/chirps.js:41, 104-106`

```js
const maxYears = Number.isFinite(options.chirps_years) ? Number(options.chirps_years) : 2
...
// Keep only the most recent requested number of dates.
const limit = options.limit || 30
return { climate_observations: climate_observations.slice(0, limit), errors }
```

Two caps stack. With `chirps_years: 2`, the two probed year directories yield up
to ~730 daily files; `.slice(0, 30)` keeps 30. `counts_found` is not recorded and
no error is raised, so the source run reports `status: 'success'`,
`records_processed: 30`, and a reader concludes the platform holds 30 days of
CHIRPS coverage when it probed for 730.

One-line fix: push `dates_found` and `records_retained` into the record
metadata and report a `truncated` diagnostic; default `limit` to `null` for
on-demand runs.

---

### D11 — The CHIRPS connector is catalogued as rainfall and delivers `precipitation_mm: null`

**Severity: High** (fidelity / claim-vs-reality gap)

`src/connectors/chirps.js:82-83`

```js
precipitation_mm: null,
metadata: { ... values_included: false, values_note: 'This connector reports dataset
  availability and dates, not pixel values. ...' },
```

The record-level disclosure is exemplary. But `connectors.registry.json:104`
describes the source as `"CHIRPS rainfall dataset index"` under tags
`["rainfall", "precipitation", "climate"]`, and the connector id is `chirps` —
so any consumer querying `climate_observations WHERE source='chirps' AND
precipitation_mm IS NOT NULL` correctly gets nothing, while any consumer that
sees the source in a list of rainfall feeds reasonably assumes the platform holds
CHIRPS rainfall. It does not. The README's "normalizes them into simple schemas"
claim does not extend to values here.

One-line fix: either decode the GeoTIFFs (see E6) or rename the source to
`chirps_index` in `schema.js`, `ingestion.js` and `connectors.registry.json` so
the catalog stops implying rainfall the platform does not have.

---

### D12 — GloFAS severity is fabricated for every item

**Severity: High** (fidelity; a severity assigned where none exists)

`src/connectors/glofas.js:38`

```js
severity: /high|severe|red/i.test(`${title} ${description}`) ? 'high' : 'medium',
```

Every parsed item receives a severity. There is no `unknown` branch, no alert
level, and no threshold. A flood forecast whose description happens to contain
the word "high" (in any context, including "highly likely") becomes `high`; every
other item becomes `medium`. The GloFAS RSS carries no severity field at all, so
this is a keyword guess presented in the same field as GDACS's own graded
`alertlevel` and USGS's magnitude band.

One-line fix: store `severity: null` and put the keyword hit in
`metadata.severity_heuristic`, or fetch the underlying EFAS/Copernicus layer that
carries a real magnitude.

---

### D13 — Annual and window-scoped data is stamped so the global freshness clock reads it as stale

**Severity: Medium** (timeliness signal is wrong for 3 of 16 sources)

- `who-gho.js:134` — `observed_at: \`${year}-01-01T00:00:00.000Z\``
- `ipc-hdx.js:217` — `observed_at: \`${row.From}T00:00:00.000Z\``
- `analytics.js:454-461` — one global scale: `ageDays <= 2 ? 0 : <= 14 ? 10 : <= 45 ? 20 : 30`

A WHO annual count for 2025 is stamped 1 January, so by October it is ~275 days
old and takes the maximum 30-point penalty, even though the source is behaving
exactly as specified. An IPC `current` window that started 1 August is stamped
1 August and penalised, though its `valid_to` (e.g. 2026-10-31) is current.
Meanwhile `SOURCE_POLICIES.who_gho.stale_after_minutes` is 20160 (14 days) for the
**run** clock (ingestion.js:72) — the two staleness systems disagree with each
other and with the data's actual cadence.

Note the asymmetry: `ingestionStatus` measures staleness from `completed_at`
(ingestion.js:369), i.e. *when we last fetched*; `computeDataQuality` measures it
from `observed_at`, i.e. *when the observation is about*. Both are published as
"freshness".

One-line fix: give every connector a `cadence_days` and evaluate freshness as
`age / cadence` per source, using `valid_to`/`series_end` where a source publishes
a validity window rather than a point in time.

---

### D14 — `minimum_records: 1` cannot tell "source broken" from "quiet week"

**Severity: Medium** (false alarm vs missed alarm, both directions)

`src/ingestion.js:126-129`

```js
if (errors.length || records < (policy.minimum_records || 0)) status = 'degraded'
if (records < (policy.minimum_records || 0)) {
  errors = [...errors, `Expected at least ${policy.minimum_records} records for ${source}; received ${records}.`]
}
```

The comment at ingestion.js:56-60 is explicit that `minimum_records: 1` exists
because GloFAS/CHIRPS/FIRMS "hid broken ingestion" as zero-record successes. But
a threshold of 1 is equally wrong in the other direction: GDACS, GloFAS and USGS
all publish **legitimately empty** feeds (no new disaster alerts in an hour, no
forecast in a dry spell, no M2.5+ anywhere on Earth in a day — the real count is
~40–50/day but a quiet day is possible). A quiet feed becomes `degraded`, an
alert appears, an operator investigates, and finds nothing.

There is no third state. The model needs `quiet` (fetched OK, schema intact, zero
rows, cadence not yet elapsed) distinct from `broken` (fetched OK, schema changed,
zero rows).

One-line fix: distinguish `errors.length > 0` (broken) from
`records === 0 && !errors.length` (quiet), and back the "quiet" verdict with a
schema assertion so a parse that returns nothing still reads as broken.

---

### D15 — `ipc_hdx` fans out ~92 concurrent requests against a 20/min declared limit

**Severity: Medium** (abuse of a free service; self-inflicted 429s)

`src/connectors/ipc-hdx.js:265`

```js
await Promise.all([...new Set(isoCodes)].map(async (iso) => {
  const dataset = await packageShow(slugFor(iso), options)
  ...
  const text = await fetchWithRetry(geo.url, { timeoutMs: options.timeout_ms || 30000, ... })
```

With the default 46-country list (`ipc-hdx.js:57-63`) this issues 46 concurrent
`package_show` calls followed by 46 concurrent GeoJSON downloads — national IPC
GeoJSON files are megabytes of coordinates. The connector's own spec declares
`rateLimit: { perMinute: 20 }` (ipc-hdx.js:417) and the registry repeats it
(`connectors.registry.json:255`), but **nothing in the codebase reads
`rateLimit`**; it is documentation, not behaviour. `grep -rn "rateLimit" src/`
returns only the declarations.

Failure scenario: HDX throttles with 429; `fetchWithRetry` retries twice with
150/300 ms backoff, which is nowhere near a `Retry-After`; the geometry half
degrades to null bboxes for most countries and the errors array fills with
identical messages — the failure mode looks like "IPC published no geometry",
which is false.

One-line fix: enforce the declared `rateLimit` with a token bucket in
`http.js`, and bound IPC's fan-out with a concurrency limit of 4–6.

---

### D16 — The outbox claims exponential backoff it does not implement, and swallows every error

**Severity: Medium**

`src/outbox.js:69-97`

```js
if (response.ok) {
  successCount += 1
}
...
} catch (error) {
  // Swallow individual webhook errors; retry in next cycle
}
...
} else {
  // Exponential backoff: don't retry yet, will retry in next dispatch cycle
  updates.push({ ...outboxEvent, attempts: nextAttempts, last_attempt_at: nowIso() })
}
```

Three problems in one block:
1. `catch (error) {}` discards the error entirely — `last_error` is declared on
   the record (outbox.js:13) and **never written**, so a subscriber whose endpoint
   has been down for four cycles is indistinguishable from one that never
   matched.
2. A non-`ok` HTTP response (500, 404, 401) is not an error path at all — it just
   fails to increment `successCount`, so the reason is invisible.
3. The comment says "exponential backoff: don't retry yet". There is no
   `next_attempt_at` field and no time comparison anywhere in the file; a failed
   event is retried on the very next dispatch cycle. After 5 attempts it is marked
   `failed` (`status: 'failed'`, line 84) and **is dropped forever** — the
   `pending` filter at line 22 will never select it again.

One-line fix: add `next_attempt_at` and compute `now + 2**attempts * base`, write
`last_error` in the catch and on non-ok responses, and give `failed` events a
terminal-state count in the return value.

---

### D17 — HTTP error responses are discarded before the error is constructed

**Severity: Low** (diagnosability)

`src/connectors/http.js:6`

```js
if (!response.ok) throw new Error(`HTTP ${response.status}`)
```

The response body — which for GDACS, HDX and GDACS-archive carries the actual
explanation ("Invalid MAP_KEY.", "dataset not found", a Cloudflare challenge) — is
dropped. `Retry-After` is not read either, so a 429 retries on a 150/300 ms
schedule regardless of what the server asked for.

One-line fix: read up to 512 bytes of body into the error message and honour
`Retry-After` when present.

---

### D18 — `connectors.registry.json` has drifted from the code it describes

**Severity: Medium** (the registry is the public contract; it is not verified)

Three concrete mismatches:

- `connectors.registry.json:282` — `"gho_top_years": "number (default 40)"`. No
  such option exists in `who-gho.js`; the actual window is `gho_min_year`
  (who-gho.js:87).
- `connectors.registry.json:244` — `"countries": "array of ISO3 codes to keep
  (default ['KE','SO','SS'])"`. The code default is `DEFAULT_COUNTRIES`, 46 codes
  (ipc-hdx.js:57-63), so an operator reading the registry scopes the source to
  three countries and gets three countries' worth of records silently.
- `rateLimit` appears in 10 registry entries and in most connector `defaults`, and
  is enforced nowhere (see D15).

`src/connectors/spec.js` validates only the shape of a spec object at definition
time; nothing cross-checks the registry against `SOURCE_IDS`, `CONNECTORS` or the
`defineConnector` schemas. `src/server.js:66` loads the file and serves it as-is.

One-line fix: add a CI assertion that every registry id exists in `SOURCE_IDS`
and `CONNECTORS`, and that every declared `schemas.input` key appears in the
connector's `requestSchema`.

---

### D19 — The two stores order `source_runs` differently, and the Postgres order is not stable

**Severity: Medium** (health verdict is order-dependent)

`src/ingestion.js:284-286`

```js
const sourceRuns = runs.filter((run) => run.source === source)
const lastRun = sourceRuns[0] || null
const lastSuccess = sourceRuns.find((run) => run.status === 'success') || null
```

`lastRun` assumes newest-first ordering. `JsonStore.mergeById` sorts by the
body's `completed_at` (store.js:126-134), so that holds. `PostgresStore.read`
does `ORDER BY updated_at DESC` with **no secondary key**
(`src/postgres-store.js:60`), and `updated_at` is the write timestamp, not
`completed_at`. Re-running the same source twice in the same minute gives two
rows with identical `updated_at` and no defined order, so `lastRun` — and
therefore `sourceHealth` (`ingestion.js:366`), `failure_streak`
(`ingestion.js:378`), and `last_success` — can return the *older* of two runs.

One-line fix: `ORDER BY updated_at DESC, (body->>'completed_at') DESC, id DESC`
in Postgres, and have `ingestionStatus` sort `sourceRuns` itself rather than
trusting storage order.

---

### D20 — `dhis2` always reports the scaffold error, enabled or not

**Severity: Low** (dead source in the catalog)

`src/connectors/dhis2.js:5-21`

```js
const enabled = process.env.LINDELA_LITE_DHIS2_ENABLED === 'on'
if (!enabled || !request.base_url) {
  return { climate_observations: [], errors: [SCAFFOLD_MSG] }
}
// Scaffold: real bidirectional sync would fetch from DHIS2 data elements here.
return { climate_observations: [], errors: [SCAFFOLD_MSG] }
```

Both branches return the same thing. Because `errors.length > 0`, the run is
permanently `degraded`; with `minimum_records: 0` (ingestion.js:83) it can never
fail. This is the source the README's DHIS2 integration story rests on.

One-line fix: when enabled and configured, either implement the fetch or throw a
loud "not implemented" that sets `status: 'failed'` so it is not mistaken for a
working integration.

---

### D21 — FIRMS fabricates an acquisition date when the CSV omits one

**Severity: Low** (a detection with no known time gets today's date)

`src/connectors/nasa-firms.js:54`

```js
occurred_at: `${row.acq_date || new Date().toISOString().slice(0, 10)}T${...}Z`,
```

Every other connector in this codebase is careful to preserve the difference
between "no reading" and "a reading of zero" (`readMeasurement`, open-meteo.js:36;
`toNumber`, utils.js:49). Here a fire detection with a missing `acq_date` is
stamped with **today**, which places it at the top of every "recent fire
activity" query and inside every recent-activity freshness window. Same class of
defect as the one already fixed in analytics (commit 4a1ce17, "a missing forecast
is not a measured dry spell").

The `days` clamp (firms.js:35) and the region loop are otherwise correct, and the
API-key handling is clean: the key is read from env or option (line 24), never
logged, and never included in an error string — `fetchWithRetry` throws a bare
`HTTP 400`, so `errors.push(\`${region.name}: ${error.message}\`)` is safe. (Minor
caveat: accepting the key from a request body means it can land in a reverse
proxy's access log; `options.nasa_firms_key` is undocumented in the request
schema.)

One-line fix: skip the detection, or store `occurred_at: null` with the source
date range in metadata.

---

## Enhancements

### E1 — Per-source freshness SLAs evaluated against cadence, not a wall clock

Value: today the same "freshness" word means three different things — time since
we fetched, time since the observation, and a global 2/14/45-day scale — so an
operator cannot tell a broken source from a quarterly one. Publishing `cadence_days`
and `data_sla` per source makes "stale" an actionable verdict for every source,
including the annual and monthly ones the current model flattens.

Exists (`src/ingestion.js:54-84` `SOURCE_POLICIES` with `stale_after_minutes` per
source; `src/ingestion.js:366-376` `sourceHealth`; `src/analytics.js:454-461`
`freshnessPenaltyFor`). Missing: any notion of how fast each source actually
publishes; no `cadence` field; no distinction between run freshness and data
freshness; no "quiet" state (see D14).

Sketch: add `cadence_days` and `quiet_is_valid` to each policy —
`gdacs: 1`, `usgs: 1`, `glofas: 1`, `open_meteo: 0.125`, `nasa_firms: 0.04`,
`chirps: 1`, `noaa_enso: 30`, `ipc_hdx: 30`, `who_gho: 365`, archives `null`.
Expose `/api/v1/ingest/status` as a verdict triple per source
`{ run_freshness, data_freshness, verdict: ok|quiet|stale|broken|never_run }`,
where `data_freshness` is `age(observed_at or valid_to or series_end) / cadence_days`.
Return HTTP 503 from a `/api/v1/ingest/health` endpoint when any source is `stale`
or `broken` so an external scheduler can see it without parsing JSON.

---

### E2 — Watermarks and incremental fetching

Value: five sources re-download everything on every run — the full 45-year ERA5
series per region, the full IPC 44k-row CSV, the full WHO OData series per
indicator — which is the dominant cost of a run and the main source of rate-limit
pressure. A per-source watermark turns each into a delta fetch and makes
backfill resumable after the first D7/D6 duplicate-class failures.

Exists: nothing. Every connector builds its request from `new Date()` or a fixed
start (`open-meteo-archive.js:47-48`, `open-meteo-flood.js:48-49`,
`who-gho.js:87` `currentYear - 5`, `gdacs-archive.js:46` from `archive_start_year`).
`store.merge` upserts by id, so nothing incremental is possible downstream either.

Sketch: a `watermarks` collection (`source`, `key`, `value`, `updated_at`) read
before `ingest` and written after. `open_meteo_archive` requests
`start_date = stored series_end + 1d` and appends to `daily`; `who_gho` requests
nothing new unless `gho_min_year` changed; `gdacs` filters items with
`pubDate > watermark` after parsing (the feed is only ~30 days deep anyway);
`gdacs_archive` skips quarters already below the watermark. Fail closed: if the
watermark read fails, fall back to a full fetch rather than a partial one.

---

### E3 — Per-source data-quality assertions with quarantine-on-fail

Value: the project's own history is three connectors that "reported success while
ingesting nothing", and the only structural defence today is `minimum_records: 1`
— which cannot catch a feed that returns 3 records where it used to return 222.
Per-source assertions catch partial breakage, which is the case a record count
never will, and quarantining keeps bad records queryable for audit without letting
them into risk scoring.

Exists: `minimum_records` (ingestion.js:54-84), `looksLikeFeed` for GloFAS
(`glofas.js:23, 97-102`), `requiredResource` for IPC (`ipc-hdx.js:114-121`), the
CHIRPS `probed && !filesFound` check (`chirps.js:97-99`), and the WHO
`!kept && maxRowYear >= minYear` check (`who-gho.js:156-158`). All are
per-connector, ad hoc, and none reject a record — they only annotate the run.

Sketch: a `QUALITY_RULES` map keyed by source returning assertions evaluated
against the output:
```js
gdacs: [
  { id: 'min_items', test: (o) => o.hazard_events.length >= 20 },
  { id: 'parse_ratio', test: (o) => ratioOf(o) >= 0.98 },
  { id: 'alert_level_present', test: (o) => fracWith(o, r => r.metadata.alert_level) >= 0.9 },
  { id: 'coords_in_range', test: (o) => allCoords(o, (la,lo) => Math.abs(la)<=90 && Math.abs(lo)<=180) },
],
usgs_earthquake: [{ id: 'expected_band', test: (o) => o.hazard_events.length >= 5 }],
```
Records failing a per-record assertion (`bbox` unparseable, `severity` from a
fallback branch, coordinate out of range, `occurred_at` in the future) go to a
`quarantine` collection carrying the reason and the raw payload; the run is
`degraded` with the assertion id. This is also the natural home for the D12
GloFAS severity flag and the D21 FIRMS date.

---

### E4 — Replace the synthetic confidence score with an evidence-based one

Value: `computeDataQuality`'s `confidence` currently rewards **volume** — up to
+45 points for having ≥25 records and +55 for geocoding them — which means a
source returning 222 low-value GDACS alerts outscores a source returning 3
verified, well-attributed observations. Since the README sells "source-data
quality and confidence signals", this number should measure whether the source
is behaving, not how much it said.

Exists: `src/analytics.js:336-354`
```js
const confidence = clamp(Math.round(geocodeCoverage * 55
  + Math.min(quality.total_records, 25) * 1.8 - runPenalty - freshnessPenalty), 0, 100)
```
plus `runPenalty` (failed −35, degraded −15), `freshnessPenaltyFor`
(2/14/45 days, global), and `geocode_coverage_pct`.

Missing: any link to the source's *declared* behaviour. Nothing asks whether the
fetch parsed, whether the schema matched, whether the cadence held, or whether
any E3 assertion passed.

Sketch: compose from four named, explainable components with the reason attached —
`delivery` (did the fetch succeed and parse, from `source_runs.diagnostics`),
`cadence` (`age / cadence_days`, per E1), `assertions` (E3 pass ratio),
`fidelity` (`geocode_coverage_pct` *and* `records with model_limit set` ratio).
Ship `confidence_components` alongside the score so a dashboard can explain a
number instead of asserting it. Keep `mean_confidence` as-is (it is correctly
null-safe, analytics.js:346-348).

---

### E5 — Record-level provenance and a real transform version

Value: today the only link between a stored record and the run that produced it
is a hash list in `data_lineage` that is wrong (D2); with `source_run_id` and
`schema_version` on the record itself, every downstream number can be traced to a
fetch, a parser version and a payload hash in one hop.

Exists: `record.payload_hash` and `record.first_seen_at` set in
`src/ingestion.js:136-147`; `data_lineage` collection (`src/store.js:18`) written
via `src/lineage.js`. Missing: `recordLineage` never populates
`upstream_url_or_endpoint` (lineage.js:14), `transform_version` is the literal
`'0.1.0'` (line 15), the `store` argument is unused (line 3), and the record list
omits `food_security_records` and `disease_observations`.

Sketch: connectors return a `_provenance` envelope —
`{ url, fetched_at, http_status, etag, last_modified, byte_length, sha256, transform_version }` —
and `ingestBody()` folds it into each record as `provenance`, bumping
`schema_version` per record. `transform_version` comes from a per-module constant
(`TRANSFORM_VERSION = 'gdacs@2'`) bumped in the same commit as any parser change;
add a test asserting that every registered connector declares one. Then
`data_lineage` becomes a cheap per-run rollup and D2 disappears as a side effect.

---

### E6 — Source-agreement cross-validation between the two rainfall products

Value: the platform holds ERA5 precipitation (`open_meteo_archive`), GloFAS v4
discharge (`open_meteo_flood`), GDACS reported floods (`gdacs_archive`) and a
CHIRPS index that currently yields no values — which makes a genuine two-product
agreement check the single largest fidelity win available. Where ERA5 and a
decoded CHIRPS disagree over a district-month, that disagreement is exactly the
signal the model's confidence should be conditioned on, and it is the honest
replacement for the synthetic confidence score in E4.

Exists: `readMeasurement` deliberately preserves nulls in both archive connectors
(`open-meteo-archive.js:67-71`, `open-meteo-flood.js:67-71`); `daily` arrays carry
per-day values; the CHIRPS index already enumerates every available daily file
(`chirps.js:71-94`). Missing: CHIRPS has no values (D11), so there is nothing to
compare; no cross-source validation anywhere in the codebase; the flood-probability
model consumes the two series independently.

Sketch (two stages). First, decode CHIRPS: the `.tif.gz` files are
`zlib.inflateSync` + a minimal baseline TIFF reader (~150 lines, no deps) — read
the pixel at each `DEFAULT_REGIONS` point for the last N days and store a real
`precipitation_mm`, replacing `chirps.js:83`. Second, publish a
`source_agreement` collection: per region-month, ERA5 mean vs CHIRPS mean, the
absolute and relative difference, and a status `agree|disagree|unavailable`,
gated on overlap ≥ 30 days. Feed the disagreement into E4's fidelity component and
into the flood model's training-sample filter.

---

### E7 — Backfill / replay with a dry-run diff

Value: the repo has `scripts/check-live-sources.mjs` (does upstream answer?) but
nothing that answers "if I re-ingest March 2019, what changes?" — which is the
question you must be able to answer before touching a store that feeds
dispatch decisions.

Exists: `payload_hash` per record (`src/ingestion.js:140`) is exactly the diff
primitive needed; `runIngestion` accepts `sources`, `run_type`, and per-source
options; `scripts/seed-demo.mjs:99` shows the single-source call pattern. Missing:
no CLI, no dry-run mode, no diff output, and `runIngestion` always writes
(`ingestion.js:191`).

Sketch: `scripts/replay-ingestion.mjs --source gdacs_archive --since 2019-01-01
--until 2019-06-30 --dry-run`. Add `request.dry_run` to `runIngestion`: build
`merged` and the source runs as today, then skip `store.merge` and instead return
`diff: { added, changed, unchanged, removed }` by comparing `payload_hash` against
`store.read()`. `--apply` performs the merge. Reuse the same harness for
backfill-with-resume (`--resume` reads the E2 watermark).

---

### E8 — Connector health scoring and circuit breaking

Value: D3's four-hour worst case is the concrete argument, but the deeper win is
that after three consecutive failures a source should stop costing the schedule
any time at all, and should be visibly *open* rather than quietly degrading every
run.

Exists: `failure_streak` (`src/ingestion.js:378-385`), `last_run_status`,
`error_count` (`src/analytics.js:325-334`), `attempts` in diagnostics
(`ingestion.js:164-171`). Missing: `failure_streak` is computed but never used to
change behaviour — nothing short-circuits a source, and there is no half-open
recovery probe.

Sketch: a `breaker` object in `ingestion.js` fed from the last N runs of a source.
Open after 3 consecutive `failed` within a sliding window; while open, `skip` the
connector and record `status: 'skipped_circuit_open'` with the reason — a distinct
status so it is never mistaken for a fresh success. Half-open after
`interval_minutes`, permitting one probe. Expose breaker state in
`ingestionStatus` output so the health endpoint (E1) can show it. This is the
defence that would have caught today's GloFAS feed outage without anyone reading
the error array.

---

### E9 — Rate-limit-aware scheduling, actually enforced

Value: `rateLimit` is declared in 10 registry entries and most connector
`defaults` and honoured in zero places, which means the documented limits are
fiction and the only back-pressure in the system is upstream's 429.

Exists: `rateLimit: { perMinute: N }` in `connectors.registry.json` (10 entries)
and in the connector specs (`gdacs.js:76`, `glofas.js:79`, `ipc-hdx.js:417`,
`open-meteo.js:137`, `usgs-earthquake.js:106`, `noaa-enso.js:266`,
`who-gho.js:245`, `gdacs-archive.js:429`); `fetchWithRetry` retries
(`http.js:3-19`). Missing: no token bucket, no concurrency cap, no `Retry-After`
(D17).

Sketch: move the `rateLimit` declaration into `SOURCE_POLICIES` (single source of
truth; have the registry read from there) and add a per-host token bucket in
`http.js`, plus a `concurrency` cap applied to the IPC fan-out (D15). Jitter the
backoff so nine sources retrying on the same second do not synchronise. Honour
`Retry-After` on 429/503 and fail fast rather than retrying a rate limit three
times.

---

### E10 — Completeness / partial-page detection for the GDACS archive

Value: the archive's own docstring records that "a full-range query returns only
the most recent ~100 events" — meaning the upstream has an undocumented result
cap. The connector works around it with quarter-sized windows but never checks
whether a window was itself capped, so a year with more than the cap's worth of
events in one quarter is silently truncated with no error and no marker.

Exists: the quarter-walk (`gdacs-archive.js:46-74`) and its honest comment about
the ignored `eventtype` filter (lines 18-21); the empty-window case *is* caught
(`errors.push(... returned no features)`, line 64). Missing: no upper-bound
tripwire, and no `complete` flag on the emitted records.

Sketch: if `features.length >= OBSERVED_UPSTREAM_CAP` for a window, add
`metadata.completeness: 'at_risk'` and push a `window returned N features, at or
above the observed upstream cap of ~100 — the archive may have truncated this
quarter` error, which already degrades the run. Record the measured cap in
`SOURCE_POLICIES` so the tripwire is a calibrated number rather than a guess.
Belt-and-braces: after a full walk, verify the year total against the archive's
own event-count endpoint if one exists.

---

### E11 — Bitemporal records so upstream revisions are auditable

Value: GDACS revises alert levels, USGS revises magnitudes after review, WHO
republishes historical counts, and CPC revises its climatology base period every
five years. Today every one of those revisions silently overwrites the stored
value, so "the cholera count for 2024 changed" leaves no trace — and a model
trained on last month's snapshot cannot be reconciled with this month's.

Exists: `stableId` excludes the value, so a revision lands on the same id
(`who-gho.js:119`, `usgs-earthquake.js:44`, `gdacs.js:26`);
`mergeById` shallow-merges over the stored body (`src/store.js:117`); the payload
hash changes when a value changes. Missing: no previous value, no
`last_changed_at`, no revision counter, and Postgres `DO UPDATE` leaves no
history either.

Sketch: on merge, when an incoming record's `payload_hash` differs from the
stored one for the same id, write the prior body to a `record_revisions`
collection (`record_id`, `previous_hash`, `previous_body`, `superseded_at`,
`source_run_id`) and stamp `last_changed_at` on the record. Then
`USGS: M5.1 → M5.4` and `WHO: 2019 cholera 1,204 → 1,388` become queryable
facts. Also add `metadata.revision` where the source publishes one (USGS
`properties.status` goes `automatic` → `reviewed`).

---

### E12 — Raw payload retention and a bitemporal replay surface

Value: every parsing defect in this audit — the CHIRPS layout move, the GloFAS
HTML app, the `eventtype` filter being ignored, the OData `$orderby` being
silently dropped — was diagnosed by hand against the live response. Retaining
what was actually received turns that from archaeology into a regression test.

Exists: `fetchWithRetry` parses and discards (`http.js:7-14`); `payload_hash`
records *that* a body was seen, never what it said; `scripts/check-live-sources.mjs`
is the closest thing to a capture, and it keeps nothing. Missing: no raw archive,
no content-addressed store, no ability to replay a parse against a recorded body.

Sketch: a `raw_payloads` collection keyed by `(source, url)` with the SHA-256 of
the body, byte length, `fetched_at`, HTTP status and — for HTML/XML/CSV under
100 KB — the body itself (compressed), written by `fetchWithRetry` under a
`LINDELA_LITE_RETAIN_RAW` flag that is **on by default for text formats and off
for rasters**. Then `npm run replay:parse -- --source gdacs --body <sha>` re-runs
the parser against a captured response, and the fixture suite can be seeded with
real upstream bodies — which is precisely the gap
`scripts/check-live-sources.mjs` was written to cover and cannot cover on every
push.

---

## Per-source notes

| source id | what it fetches | pagination / limits | retry / timeout | staleness risk | biggest fidelity concern |
|---|---|---|---|---|---|
| `open_meteo` | forecast + current weather, 3 default regions | `forecast_days` (default 7); 1 request per region, sequential | 2 retries in `fetchWithRetry`, 20 s/attempt; outer retry inert (D4) | low (3 h policy) but `observed_at` has no timezone (D5) | timestamps shift by the server's UTC offset; every downstream date filter is wrong off-UTC |
| `gdacs` | one combined RSS feed, all hazard types | none — single feed, ~222 items; ~30 days deep | 2 retries, 20 s | 180 min policy | severity from substring match: `red` in *predicted* / *Red Sea* (D1) |
| `glofas` | Copernicus flood forecast RSS | none — single feed | 2 retries, 20 s | 180 min policy; feed was serving an HTML app as of 2026-10-01 | severity fabricated for every item; no `unknown` (D12). Also no country, no coordinates, no extent |
| `chirps` | CHIRPS-2.0 daily raster **file index**, 2 most recent year dirs | year dirs probed one level down; `limit` default 30 vs up to ~730 available (D10) | 2 retries, 20 s | 1440 min policy | delivers `precipitation_mm: null` (D11) — catalogued as rainfall, is a file listing |
| `nasa_firms` | VIIRS active fire CSV, 3 regional bboxes | `days` clamped 1–10; per-region request; rows uncapped | 2 retries, 30 s | 720 min policy | missing `acq_date` stamps the detection today (D21). FRP→severity band is a local invention; no confidence filtering (`row.confidence` stored but never used) |
| `usgs_earthquake` | GeoJSON summary feed, default `2.5_day` | 4 windows available; no pagination | 2 retries, 20 s | 180 min policy | `country` is always null — no reverse geocode (`:55`); preliminary `automatic` magnitudes stored as final, no revision tracking (E11) |
| `noaa_enso` | CPC Niño 3.4 monthly SST anomaly, fixed-width ASCII, full file every run | full 900-row file re-fetched; window of 18 months stored | 2 retries, 20 s | 1440 min policy vs a **monthly** cadence (D13) | `observed_at` stamped at mid-month (`-15T00:00Z`) — a fabricated instant within the month; base period revised every 5 years with no version stamp |
| `ipc_hdx` | IPC national + area classifications via HDX; 2 CSVs + per-country GeoJSON | 2 CSVs re-fetched whole each run (44k rows); **~92 concurrent requests**, no cap (D15) | 2 retries, 30 s; backoff 150/300 ms, no `Retry-After` | 2880 min policy vs a **monthly** analysis cycle (D13) | `observed_at` = window start makes a current window look months stale; duplicate phase rows silently overwrite in `record.phases[row.Phase]` (`:225`) |
| `who_gho` | 8 GHO OData indicators, full series each | no `$top`/`$filter`/`$orderby` by design; full series re-fetched ×8 every run (E2) | 2 retries, 20 s | 20160 min (14 d) for a **yearly** series; analytics uses a 45-day scale (D13) | `observed_at` = 1 Jan of the reported year (D13); revisions to historical values overwrite silently (E11) |
| `gdacs_archive` | historical FL events, 1985→now, quarter-by-quarter | ~168 sequential requests, quarter windows; **no upstream-cap check** (E10); worst case ~4.2 h (D3) | 2 retries, 30 s, per request; no source budget | 43200 min; not on the regular schedule | completeness is assumed; a capped quarter is indistinguishable from a complete one. In-process `eventtype` filter is correct but unverified upstream |
| `open_meteo_archive` | ERA5 daily precipitation, full series per region | one request per region, 1981→today, re-fetched whole; `endDate` defaults to today (D6) | 2 retries, 60 s | 43200 min | id includes `endDate` → a new near-identical 45-year record every day (D6); ERA5 lags ~5 days with no lag metadata; point value presented as district rainfall |
| `open_meteo_flood` | GloFAS v4 daily river discharge per region | same shape as above, from 1984 | 2 retries, 60 s | 43200 min | same daily-duplication problem (D6); reaches absent for some cells (refused as errors, correct); discharge is modelled, not gauged |
| `service_assets` | user CSV / GeoJSON | none | no network; 0 retries, 5000 ms policy | none (`regular: false`) | payload-hash dedup can silently discard a re-import with changed ids (D8) |
| `acled_csv` | user CSV | none | none | none | one bad date throws and loses the whole import (D9); empty CSV reports clean success with 0 records |
| `conflict_csv` | user CSV | none | none | none | identical to `acled_csv` (D9) |
| `dhis2` | nothing — scaffold | n/a | n/a | n/a | returns the scaffold error in both branches; permanently `degraded`, never `failed` (D20) |

---

## Rejected

- **Adding a real XML parser dependency** — the project is zero-dep beyond `pg`; the RSS regexes work for GDACS/GloFAS and `readNamespacedTag` (`spec.js:9`) already handles the prefix problem that broke bbox parsing.
- **Retrying the whole connector on partial failure** — a connector that returned 100 of 222 GDACS alerts is not a transient failure; re-fetching doubles load on a free feed for no gain.
- **Replacing the JSON file store with something transactional** — out of scope; `store.merge` already upserts by id and the Postgres path has a real unique index.
- **Adding a `setInterval` scheduler** — `docs/architecture/ingestion.md` documents the external scheduler deliberately, and it avoids running a free-tier API key from a resident process.
- **Running all connectors concurrently by default** — real, but it multiplies the rate-limit exposure in D15; the fix is a bounded concurrency cap (E9), not unbounded parallelism.
- **Auto-geocoding `usgs_earthquake` / `gdacs` countries from coordinates** — needs a gazetteer the project does not ship; the honest null is better than a guess, which is what the current code already does.
- **Storing full IPC polygons instead of bboxes** — the docstring at `ipc-hdx.js:38-42` is right: a national GeoJSON is megabytes of coordinates and a bbox is honest about precision.
- **Deriving an ONI from the Niño 3.4 monthly series and calling it ONI** — commit 250b59c already removed this mislabel; the remaining gap (RONI not being keyless-machine-readable) is a data-availability fact, not a code defect.
- **Rewriting `parseCsv`** — it handles quoted fields, embedded newlines and `""` correctly; only a UTF-8 BOM in the header would mis-key the first column, which is a one-line `.replace(/^﻿/, '')` if it ever bites.
- **Treating `source_runs` retention as a defect** — unbounded history is a storage question for `prune`, not an ingestion-fidelity bug; the lineage accumulation (`src/lineage.js:9`, keyed on `now`) is the part worth bounding.
- **Cross-validating ERA5 against in-country gauges** — no gauge network is available keylessly, which E6's CHIRPS-vs-ERA5 check is the achievable substitute for.
- **Flagging `gdelt` as blocked-source dead code** — `BLOCKED_SOURCE_IDS` (`schema.js:20`) is a deliberate editorial decision, checked in two places, and needs no ingestion change.
