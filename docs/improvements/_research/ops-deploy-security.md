# Ops, Deployment, Supply Chain and Security Audit — Lindela Lite

Audit date 2026-10-03. Threat model: a district-office server or a laptop, in a
humanitarian response, on flaky power and intermittent internet, in a country
where the operator may be physically at risk. Physical and operational
security, and data at rest, are first-class requirements, not nice-to-haves.

---

## Defects

### D1 — Every GET API route is unauthenticated, including the full-data exports

**Severity: Critical**

`src/server.js:229-240`

```js
if (process.env.LINDELA_LITE_TOKENS || process.env.LINDELA_LITE_API_KEY) {
  if (url.pathname === '/api/v1/rapidpro/field-report' && req.method === 'POST') {
    ...
  } else if (url.pathname !== '/api/v1/health') {
    auth = authenticate(req)
    if (!auth && req.method !== 'GET') {
      jsonResponse(res, 401, { success: false, error: 'Unauthorized' })
      return
    }
    if (auth) {
      requireScope(auth, scopeForRoute(req.method, url.pathname))
    }
  }
}
```

Two independent compounding faults in six lines:

1. **GET is never gated.** `if (!auth && req.method !== 'GET')` means an
   unauthenticated GET proceeds. The `requireScope(...)` call sits inside
   `if (auth)`, so `scopeForRoute`'s `'read:hazards'` branch is dead code for
   anonymous callers — the read scope is never enforced against anyone.
2. **Auth is opt-in by environment.** If neither `LINDELA_LITE_TOKENS` nor
   `LINDELA_LITE_API_KEY` is set, the whole block is skipped and POSTs are open
   too. `docs/configuration.md:10` calls the key "Optional".

The blast radius is not abstract. `src/server.js:853` (`/api/v1/export.geojson`)
and `src/server.js:869` (`/api/v1/export.csv`) are both plain GETs, and the CSV
export concatenates:

```js
...data.field_reports,
...data.response_resources,
...data.alert_rules,
...data.rapidpro_dispatches,
...data.rapidpro_inbound_messages,
```

`rapidpro_inbound_messages` holds reporter phone numbers and names in plaintext
(see D4). So a single unauthenticated `curl http://<host>:4177/api/v1/export.csv`
from any machine that can route to the host — the district LAN, a shared VPS, a
hotel uplink — returns the full operational picture and the PII in one request.

**Attack/failure scenario.** Lindela Lite is deployed on a shared VPS per
`docs/deployment.md:193-205`. The operator follows the one-click script, adds a
reverse proxy for TLS as instructed, and considers the deployment hardened. The
proxy terminates TLS but adds no access control (the doc says "where possible").
An exfiltrator, a curious network neighbour, or anyone who learns the host IP
issues one unauthenticated GET and walks away with field reports, response
resource locations, intervention tasks, and community member phone numbers. There
is no audit trail — `action_logs` only records mutations, and there was no
mutation. Nothing in the logs shows the read happened.

**Fix.** Require a valid token for **every** `/api/v1/*` route except
`/api/v1/health`. Move the scope check out of the `if (auth)` guard:

```js
if (url.pathname !== '/api/v1/health') {
  auth = authenticate(req)
  if (!auth) { 401; return }
  try { requireScope(auth, scopeForRoute(req.method, url.pathname)) }
  catch (e) { 403; return }
}
```

Then, because a laptop-in-the-field deployment cannot reasonably carry a key,
add a second, separately-configurable read credential for the public dashboard
(`LINDELA_DASHBOARD_READ_TOKEN`) and default the export routes to a dedicated
`write:exports` scope. Ship an explicit `LINDELA_LITE_AUTH_MODE=required|open`
that **fails startup** when `open` is combined with a non-loopback bind, rather
than degrading silently.

---

### D2 — The RapidPro field-report webhook is open by default

**Severity: Critical**

`src/rapidpro.js:229-237`

```js
export function verifyRapidProWebhook(req, url, env = process.env) {
  const secret = env.RAPIDPRO_WEBHOOK_SECRET
  if (!secret) return true          // <-- no secret configured means "allow"
  ...
  return provided === secret
}
```

And `.env.example:28` ships the variable empty:

```
RAPIDPRO_WEBHOOK_SECRET=
```

`src/server.js:230` routes `POST /api/v1/rapidpro/field-report` to this
verifier **instead of** the API-key check. Combined with D1's opt-in auth block,
the one endpoint that is explicitly designed for third-party unauthenticated
callers is, out of the box, fully open to anyone who can reach port 4177.

**Attack/failure scenario.** An unauthenticated POST of a well-formed RapidPro
field-report payload writes into `field_reports`, synthesises an `incident`, and
appends an `action_log` — the three writes at `src/server.js:1609-1615`. An
attacker injects fabricated flood/disease reports into the district's live
operational picture. Downstream, `cluster detection` and "facilities near this
report" joins consume those records; alert rules read them. The result is a
poisoned assessment feeding evacuation and resourcing decisions, with action
logs attributing the write to `rapidpro`. Failing closed here is the only
defensible default: an unconfigured webhook is a security boundary that does not
exist, and the current code pretends otherwise.

**Fix.** Invert the default. Unset secret → refuse the write with 503 and a
"webhook secret not configured" error, unless an explicit
`LINDELA_LITE_ALLOW_ANON_WEBHOOK=true` is set (for local laptop demos only).
Generate the secret in `deploy/one-click.sh` alongside the other two secrets
rather than shipping it blank in `.env.example`.

---

### D3 — The JSON store is not crash-safe: a power cut destroys the database

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

And `src/store.js:75-84`:

```js
async merge(partial) {
  const current = await this.read()      // read
  const next = { ...current }
  for (const collection of COLLECTIONS) { ... }
  return this.write(next)                 // write
}
```

Three defects stacked:

- **Non-atomic write.** `fs.writeFile` opens with `w`, truncating to zero
  immediately. There is no write-temp-then-`rename`, no `fsync`. A power cut
  mid-write — the single most likely failure in this deployment context — leaves
  a zero-length or half-JSON file. `read()` then throws a `SyntaxError` that is
  not `ENOENT`, so it propagates: every subsequent request 500s and the entire
  district's history is unrecoverable.
- **No fsync.** Even a completed `writeFile` lives in the page cache. Brownout
  after a clean `return` and before the flush loses the write anyway.
- **Unsynchronised read-modify-write.** Two concurrent `merge()` calls both read
  state A, both write A+their-own-change; the second clobbers the first. The
  ingestion run and the scheduler sidecar (`docker-compose.yml:59-63`, firing
  every 900s) both merge, so this is reachable in normal operation, not a
  theoretical race.

There is also **no `SIGTERM`/`SIGINT` handler anywhere in `src/`** (the only
`SIGTERM` in the tree is `src/pg0.js:73`, killing the pg0 child). `docker compose
down`, a container restart, or an OOM kill therefore kills the process mid-write
with no flush.

**Fix.** Write to `${file}.tmp`, `fsync` the fd, `rename` (atomic on POSIX),
then fsync the directory. Serialise `merge()` through a promise chain or an
`AsyncMutex` so read-modify-write is atomic in-process. Add
`process.on('SIGTERM'|'SIGINT')` that stops accepting connections, drains
in-flight writes, and calls `server.close()`.

---

### D4 — Reporter phone numbers and names are stored unredacted on the CHW path

**Severity: High**

`src/server.js:2231-2245`

```js
const redacted = redactPii(record, {
  redactNames: body.anonymous,
  redactPhone: true,
  coarsenGeoToH3Cell: 3,
})

const inbound = {
  id: stableId('inbound', [redacted.id, now]),
  text: body.description,
  contact_urn: body.reporter_phone || '',      // <-- raw
  contact_name: body.reporter_name || '',      // <-- raw
  ...
}
```

`redactPii` is applied to `record`, which never carries the phone or name fields.
The fields that do — written into `rapidpro_inbound_messages` — are copied
straight from the request body. The RapidPro webhook path does it correctly
(`src/server.js:1602, 1614`), so the two inbound paths disagree about whether
identifiers are PII.

This is the community health worker's own phone number, submitted from a device
that may be lost or seized. Combined with D1 (unauthenticated `export.csv`
including `rapidpro_inbound_messages`), it is exfiltrable in one GET.

**Fix.** Apply `redactPii` (or an explicit allow-list projection) to the `inbound`
record too. Add a test asserting no `contact_urn` matching `^\+?\d{7,}$` and no
`contact_name` survives a `POST /api/v1/chw/report` round trip.

---

### D5 — PII controls are off by default, unsalted, and skip the equator

**Severity: High**

`src/pii.js:4-9`

```js
const DEFAULT_POLICY = {
  redactNames: false,
  redactPhone: true,
  coarsenGeoToH3Cell: null,
  retentionDays: 365,
}
```

`redactNames: false` means `reporter_name` and `contact_name` are stored in
plaintext by default on every path that uses `loadPolicy()` directly
(`src/server.js:1600-1609`, `src/server.js:375-378`).

`src/pii.js:90-92`

```js
function hashString(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`
}
```

Unsalted SHA-256 truncated to 8 hex characters (32 bits). "Achola Wanjiru" is a
name in a bounded, largely enumerable set — a dictionary of district officer and
CHW names recovers every one of them from a 32-bit truncated hash. This is
obfuscation presented as redaction; it defeats anyone who has a name list, and
`docs/pii.js` never claims it is reversible-safe.

`src/pii.js:34`

```js
if (record.latitude && record.longitude) {
```

Truthiness, not `!= null`. A report on the equator (lat 0) or the prime meridian
(lon 0) skips geo-coarsening entirely and is stored at full precision. `src/server.js:2205-2209`
already went to real trouble to distinguish a genuine zero from a missing fix —
`pii.js` reintroduces the exact bug that comment warns about.

**Fix.** Default `redactNames: true`. Replace the bare hash with
`HMAC-SHA256(key, value)` where the key comes from a generated, chmod-600 key
file, so the mapping is not invertible from the database alone. Change the
coordinate guard to `Number.isFinite(record.latitude) && Number.isFinite(record.longitude)`.

---

### D6 — Authentication is silently disabled by an unset environment variable

**Severity: High**

`src/auth.js:1-15`

```js
export function parseTokens() {
  try {
    const tokensJson = process.env.LINDELA_LITE_TOKENS
    if (!tokensJson) {
      const apiKey = process.env.LINDELA_LITE_API_KEY
      if (!apiKey) return []
      return [{ token: apiKey, scopes: ['*'] }]
    }
    ...
  } catch {
    return []
  }
}
```

Two failure modes, both silent:

- **Empty → no tokens → `authenticate` returns `null` → the whole API is open.**
  `LINDELA_LITE_DB_MODE=postgres LINDELA_LITE_DATABASE_URL=... npm start` — the
  command in `README.md:79` and `docs/platform.md:204` — deploys fully
  unauthenticated, because neither of those two variables sets a key.
- **Malformed JSON → `catch { return [] }` → also fully open.** A typo in
  `LINDELA_LITE_TOKENS` (a trailing comma, a single-quoted string) fails closed
  in the sense that nothing works, but fails **open** in the sense that the
  operator's intent to restrict access silently evaporates and there is no
  warning. There is no log line, no startup banner, no health field.

**Fix.** A configured-but-unparseable `LINDELA_LITE_TOKENS` must throw at
startup, not return `[]`. When no credential is configured, print a loud
startup banner and set `auth.mode` in `/api/v1/health` so the operator can see
it from the browser. Refuse to bind a non-loopback address with no credential.

---

### D7 — Token comparison is not timing-safe, and the token prefix is persisted as the actor identity

**Severity: Medium**

`src/auth.js:31`

```js
const found = tokens.find(t => t.token === token)
```

`===` short-circuits on the first differing byte. Over a network an attacker
can mount a timing oracle to recover an API key byte by byte. The same applies
to `src/rapidpro.js:236` (`provided === secret`) and
`src/rapidpro.js:234`'s bearer comparison.

`src/auth.js:34-38`

```js
return {
  token,
  scopes: found.scopes || [],
  subject: `token_${token.slice(0, 8)}`,
}
```

The first 8 hex characters of the API key — 32 bits of a 192-bit secret — are
written into every `action_log` record as the actor, per `src/server.js:2416-2429`.
Action logs are append-only, exported through `/api/v1/export.csv`, and shipped
in reports. So the audit trail — the artefact you would hand to an investigator —
quietly contains a fragment of the credential that protects it.

**Fix.** `crypto.timingSafeEqual` on fixed-length buffers (hash both sides to a
digest first so lengths match). Replace the subject with a stable operator
identifier from `LINDELA_LITE_TOKENS`, or with `HMAC(pepper, token).slice(0,8)`,
never the raw prefix.

---

### D8 — Multi-tenant isolation (`scopeToPartnerOrg`) is dead code

**Severity: Medium**

`src/auth.js:85-88`

```js
export function scopeToPartnerOrg(records, auth, field = 'partner_org') {
  if (!auth?.partner_org) return records
  return records.filter((record) => record[field] === auth.partner_org || !record[field])
}
```

`authenticate()` (`src/auth.js:34-38`) returns only `{ token, scopes, subject }`.
It never sets `partner_org`, so `auth?.partner_org` is always `undefined` and
the function returns `records` unfiltered, every time. A grep confirms
`scopeToPartnerOrg` and `hasRole` have **no call sites in `src/`** outside their
own definition — they are exercised only by `test/lite.test.js:28`.

The design intent was partner-scoped visibility for a multi-agency district
office. The implementation is a no-op that reads as if isolation exists. Anyone
reading `auth.js` concludes cross-partner data is filtered. It is not.

Note also that the filter as written would be wrong even if wired:
`record[field] === auth.partner_org || !record[field]` returns records with a
*missing* `partner_org` to every partner — unowned records leak by default.

**Fix.** Either wire it (`parseTokens` reads `t.partner_org` into the auth
principal; `handleApi` applies it to `field_reports`, `incidents`,
`interventions`, `response_resources`, `rapidpro_dispatches`) or delete it. Dead
security primitives are worse than absent ones — they transfer false assurance.

---

### D9 — Container runs as root, ships the build context, and the `.dockerignore` typo leaks `.omc/`

**Severity: Medium**

`Dockerfile:1-26`. No `USER` directive: the process runs as **root** inside the
container. A container escape or an RCE in the Node process starts as uid 0.
`HEALTHCHECK` is present and correct (`Dockerfile:23-24`), `npm ci --omit=dev`
is used, and no secrets are baked via `ARG`/`ENV` — those are fine. Two real
problems remain:

`Dockerfile:14-16` copies `docs`, `examples`, and `scripts` into the runtime
image. `scripts/` is a build-time toolchain (74 KB of `seed-demo.mjs` plus the
Playwright-driven `check-*.mjs`) with no runtime role, and `docs/61440-BermejoF.pdf`
is a 946 KB research paper. They are also **served over HTTP**:
`src/server.js:65` sets `docsDir` and `handleStatic` exposes `/docs/platform.md`
(`deploy/one-click.sh:70` prints that URL). Attack surface and image size for
nothing.

`.dockerignore:5`

```
.omx
```

The directory is spelled `.omc` (`.gitignore:8` gets it right). The typo means
**`.omc/` is copied into the Docker build context** — agent session state
including `feb92df3-*.json` (13 KB of session-end job records) lands in the
image. `.claude/` (containing `settings.local.json`) and `.zvec-grep/` (a 19 MB
local index) are not excluded either; `.zvec-grep` alone is larger than the
entire rest of the context.

**Fix.** Add `USER node` (with a `chown` of `/app` before it). Drop `scripts`
and `examples` from the runtime stage; keep `docs` only if the served-docs
feature is intentional, and serve a subset. Fix the typo to `.omc` and add
`.claude/`, `.zvec-grep/`, `test/`, `*.pdf`.

---

### D10 — CI pulls unpinned packages at build time via `npx --yes`

**Severity: Medium**

`.github/workflows/ci.yml:44`

```yaml
run: npx --yes trivy fs --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 --no-progress .
```

`.github/workflows/ci.yml:53`

```yaml
run: npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json
```

`.github/workflows/ci.yml:103` and `:108`

```yaml
run: npx --yes wait-on http://127.0.0.1:4177/api/v1/health --timeout 60000
```

`--yes` means npm fetches the **latest** version of each package from the
registry at the moment the job runs, with no version constraint, no integrity
check, and no lockfile entry. `trivy` is the security scanner for this
repository — the package whose compromise is least tolerable is the one
fetched least safely. A maintainer account takeover, a typosquat-adjacent
publication, or a registry compromise executes arbitrary code in a job that has
`actions/checkout` credentials available. This is the single most actionable
supply-chain item in the repo.

Additional CI gaps in the same file:

- **No `permissions:` block** on the `test`, `coverage`, `audit`, `sbom`, and
  `live-sources` jobs. They inherit the repository default, commonly
  `contents: write`. Only `provenance` (`ci.yml:115-117`) scopes down.
- **All actions pinned by mutable tag**, not SHA: `actions/checkout@v4`,
  `actions/setup-node@v4`, `actions/upload-artifact@v4`,
  `slsa-framework/slsa-github-generator@v1.10.0` (`ci.yml:14,15,54,79,119,120`).
  A moved tag is a moved tag.
- **No SAST/CodeQL job.** For an app whose pages build markup with `innerHTML`
  (per the comment at `src/server.js:2591-2598`) and which takes JSON bodies on
  authenticated routes, CodeQL's JS queries are close to free.
- **`slsa-github-generator@v1.10.0` is not digest-pinned** and the tag format
  looks like a version string rather than the documented short-SHA generator
  ref. Worth verifying that this job actually produces a verifiable
  attestation, because `docs/security/supply-chain.md:21-25` claims SLSA level 3.
- **No `concurrency:` group**, so a force-push onto `main` races two CI runs.
- **SBOM is uploaded as an artifact with default retention** and
  `docs/security/supply-chain.md:11` says it is "Attached to GitHub release as
  an artifact" — the workflow does not attach it to a release. The doc
  overstates what CI does.

**Fix.** `npm i -g trivy@0.5x.y` / `npx trivy@<exact-version>`; add
`--package-lock-only` generation for the SBOM tool; install `wait-on` as a
pinned devDependency. Add a top-level `permissions: contents: read` and widen
only `provenance`. Pin every action by 40-char commit SHA with the tag in a
trailing comment. Add `github/codeql-action` (JS + actions). Reconcile
`supply-chain.md` with reality, or make reality match the doc.

---

### D11 — `logger.error` is called with reversed arguments, corrupting the log line

**Severity: Medium**

`src/observability.js:32-47`

```js
export const logger = {
  info: (event, fields = {}) => logEvent('info', event, fields),
  error: (event, fields = {}) => logEvent('error', event, fields),
}

function logEvent(level, event, fields) {
  ...
  const log = { ts: ..., level, event, ...fields }
  console.error(JSON.stringify(log))
}
```

`src/server.js:404`

```js
logger.error({ err: e }, 'demo seed failed')
```

`event` becomes the error object and `fields` becomes a string. Spreading a
string into an object enumerates its indices, so the emitted line is
`{"ts":"…","level":"error","event":{"err":{…}},"0":"d","1":"e","2":"m",…}` — one
character per key. The log line is unparseable by any structured log shipper,
and the raw error object is serialised into `event` where a string is expected.

The log-injection question: `logEvent` builds a plain object and
`JSON.stringify`s it, so newlines and control characters in user data are
escaped and cannot forge log lines. That part is sound. `logger.info('http_request', …)`
at `src/server.js:126` uses `route` from `normalizeRoute()`, which replaces
UUID/numeric path segments with `:id` — so attacker-supplied path segments are
not written verbatim to logs. Good.

**Fix.** Swap to `logger.error('demo_seed_failed', { err: { message: e.message, stack: e.stack } })`.
Serialise `err` explicitly — `JSON.stringify(new Error(...))` yields `{}` because
`message` and `stack` are non-enumerable, so a naive swap silently loses the
message too.

---

### D12 — Data at rest is world-readable, unencrypted, with no key-management story

**Severity: Medium**

```
data/                      drwxr-xr-x
data/lindela-lite-store.json -rw-r--r--   (1.7 MB)
```

`JsonStore` (`src/store.js:68-73`) writes with default mode; nothing sets
`mode: 0o600`. The store holds field reports, intervention tasks with named
owners (`scripts/seed-demo.mjs:401-412` shows the real shape:
`owner: 'Achola Wanjiru'`), community feedback, and — via D4 — plaintext phone
numbers. On a shared district server with several accounts, or on a laptop, any
local user can read it. Nothing is encrypted at rest. There is no documented key
management, no key rotation, and no mention of encryption anywhere in
`docs/storage.md`, `docs/deployment.md`, or `docs/configuration.md`.

The PostgreSQL volume has the same problem in a different form: `postgres:16-alpine`
runs its server as uid 999 by default, so the data directory is owned by that
uid and readable by it; the compose file sets no `POSTGRES_INITDB_ARGS`, and the
container has no `read_only` or `cap_drop` hardening.

**Fix.** `fs.writeFile(path, data, { mode: 0o600 })` plus an explicit `chmod`
after the first write; `chmod 700` the directory. Document a
`LINDELA_LITE_STORE_KEY` envelope-encryption option (AES-256-GCM, key from a
chmod-600 file outside the data directory) for deployments where the host is
shared. Add `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`
to the app service in compose.

---

### D13 — `.env.example` ships a known-weak key pair, and the key-generation path is a silent skip

**Severity: Medium**

`.env.example:4,9,11`

```
LINDELA_LITE_API_KEY=change-me
POSTGRES_PASSWORD=change-me
LINDELA_LITE_DATABASE_URL=postgresql://lindela:change-me@db:5432/lindela_lite
```

The README and deployment docs both show a copy-and-edit flow. Any operator who
copies rather than edits deploys a system whose API key and database password
are the literal string `change-me`, which is in every clone of this repository
and therefore in every attacker's wordlist.

`deploy/one-click.sh:31-41` handles the correct path:

```sh
if [[ ! -f "$ENV_FILE" ]]; then
  API_KEY="$(random_secret)"
  DB_PASSWORD="$(random_secret)"
  sed ... .env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
```

The secret generation itself is sound — `openssl rand -hex 24`, 192 bits, with a
`crypto.randomBytes` fallback (`one-click.sh:7-13`). `set -euo pipefail` is
present (`one-click.sh:2`). But the guard is `if [[ ! -f "$ENV_FILE" ]]`: if a
`.env` already exists — because someone copied `.env.example`, or because a
previous run was interrupted — the script proceeds with the weak credentials
and prints nothing about it. There is no validation that the values in the
existing `.env` are not the placeholders.

Two lesser issues in the same script: `source "$ENV_FILE"` (`one-click.sh:45`)
executes the file as shell, so any `.env` line becomes code; and the readiness
loop's final check (`:61`) plus the defaults seeding (`:62`, `|| true`) mean a
degraded deployment still prints "Lindela Lite is deployed."

**Fix.** Refuse to proceed if the resulting `.env` contains `change-me` in any
of the three variables; print the offending variable name and exit 1. Print a
distinct "used an existing .env — verify its credentials" line on that branch.
Parse `.env` instead of `source`-ing it.

---

### D14 — The production storage backend has zero executed test coverage in CI

**Severity: Medium**

`test/database.integration.test.js:17` and `:126`

```js
describe('external PostgreSQL integration', { skip: !testDatabaseUrl }, () => {
describe('pg0 integration', { skip: !pg0Enabled }, () => {
```

`testDatabaseUrl` requires `LINDELA_LITE_TEST_DATABASE_URL` and `pg0Enabled`
requires `LINDELA_LITE_TEST_PG0=1`. `.github/workflows/ci.yml` sets neither — it
runs only `npm test`, `npm run validate`, `npm run check:model-boundaries`, and
`npm run test:coverage`. Both suites **skip in CI**.

`package.json:15-17` defines `test:postgres`, `test:pg0`, and `verify:pg0`, none
of which any workflow invokes. So `src/postgres-store.js` — the store that
`docker-compose.yml:24-25` actually runs in the shipped deployment, including
`ensureSchema()` migration behaviour, merge semantics, and restart persistence —
is never executed by CI. Only `JsonStore`, the laptop fallback, is.

**Fix.** Add a `services: postgres: image: postgres:16-alpine` block to the CI
test job (or use the existing pg0 path with a `pg0` install step) and export the
URL. This is a five-line workflow change guarding the primary datastore.

---

### D15 — Metrics and the service version are exposed unauthenticated, ahead of the auth gate

**Severity: Low**

`src/server.js:104-108`

```js
if (url.pathname === '/metrics' || url.pathname === '/api/v1/metrics') {
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' })
  res.end(metrics.render())
  return
}
```

This is handled in `createServer` **before** `handleApi` and therefore before any
authentication. It leaks internal route names, status-code distributions, and
latency percentiles — useful reconnaissance, and a way to time an operator's
activity. `/api/v1/health` is similarly exempt (`:235`) and returns
`counts(data)`: the exact number of incidents, field reports, alert events, and
response resources in the district.

**Fix.** Gate `/metrics` behind the `read:hazards` scope (or restrict it to
loopback by binding a second listener). Reduce `/api/v1/health` to liveness plus
store mode; move record counts behind an authenticated endpoint.

---

### D16 — No rate limiting on authentication or on any route

**Severity: Low** (escalates to Medium where D1 is unfixed)

There is no rate limiter, no lockout, and no request-size throttle beyond the
5 MB body cap (`docs/configuration.md:12`). `authenticate()` is called on every
API request and re-parses `process.env.LINDELA_LITE_TOKENS` from scratch each
time (`src/auth.js:1-18`) — a JSON.parse per request, and an O(n) `===` scan.

Against D1, an attacker on the same LAN can enumerate `/api/v1/export.csv` at
request rate; against D2 they can write field reports at request rate. Neither
is logged.

**Fix.** A per-source-IP token bucket at the `createServer` boundary — around
40 lines, no dependency. Cache the parsed token list at startup and invalidate
on `SIGUSR2` so rotation is possible without a restart (which also gives you the
rotation path D7 needs).

---

### D17 — Secrets were committed to git history (mitigated)

**Severity: Low / informational**

`.gitignore:24-25` now excludes `start-claude.sh`, and commit `3241a82`
("chore(git): stop tracking start-claude.sh") removed it. Inspecting the blob
at `2a74feb:start-claude.sh`:

```sh
export ANTHROPIC_AUTH_TOKEN="OPENROUTER_KEY_REMOVED"
```

The live token was already replaced with the literal placeholder before the
removal commit, so **no live credential is recoverable from history**. Tracked
files were also swept for keys, tokens, and database URLs; the only hits are
placeholders (`change-me`, `user:pass`, `postgres:postgres` in
`docs/storage.md:25,31`).

Two residuals: the removal commit does not scrub the blob from history — it
remains reachable at `2a74feb:start-claude.sh` — so anyone with the pre-image
knows the exact shape of the secret and where it lived. And `docs/storage.md`
publishes the default `postgres:postgres` credentials, which are what a
misconfigured Postgres actually listens on in many field deployments.

**Fix.** Confirm with the credential owner that the OpenRouter key was rotated
after it was first committed. Replace the documented literal
`postgres:postgres` with a generated password in `docs/storage.md`.

---

### D18 — No graceful shutdown; no offline/air-gapped deployment path

**Severity: Medium** (operational, not exploitable)

**Shutdown.** As covered in D3, there is no `SIGTERM` handler in `src/`. Under
`docker compose down`, `restart: unless-stopped` (`docker-compose.yml:19`), or
an OOM kill, the Node process dies mid-`writeFile`. In this deployment context —
"flaky power" is in the brief — the graceful path matters more than usual.

**Air-gap.** There is no offline path anywhere. `docker-compose.yml:3` pins
`postgres:16-alpine` and `Dockerfile:1` pins `node:20-bookworm-slim`, both of
which must be pulled from a registry. `npm ci` (`Dockerfile:10`) requires a
reachable npm registry at build time. The scheduler sidecar's loop
(`docker-compose.yml:59-63`) calls `curl` with `|| true`, so it degrades
silently offline, but nothing documents that a district office with no uplink
needs a `docker save` / `docker load` mirror plus a vendored `node_modules`
tarball. `docs/deployment.md` does not mention air-gap at all.

**Fix.** A `shutdown()` in `src/server.js` that closes the listener, awaits
outstanding writes, and exits 0, wired to `SIGTERM`/`SIGINT`. Ship
`npm run export-offline-bundle` producing a `docker save` tarball plus a
vendored `npm ci --offline` tarball, plus a `docs/deployment-offline.md` with
the mirror-primer steps and a checksum manifest to verify against on arrival.

---

## Enhancements

### E1 — Non-root container, read-only root filesystem, dropped capabilities

**Value.** Turns a Node RCE from "root inside the container with a writable
filesystem" into "an unprivileged uid on a filesystem it cannot modify", which
removes the two primitives every container-escape chain needs. Compose
`read_only: true` + `cap_drop: [ALL]` + `tmpfs: /tmp` costs four lines.

**Evidence.** `Dockerfile:1-26` — no `USER` directive; `docker-compose.yml:17-44`
— no `security_opt`, `cap_drop`, `read_only`, or `user`.

**Sketch.**
```dockerfile
RUN chown -R node:node /app
USER node
```
```yaml
app:
  user: "1000:1000"
  read_only: true
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
```
The JSON-store default path `data/lindela-lite-store.json` must move to a
mounted volume, since `/app` becomes read-only.

### E2 — Field-safe crypto-wipe for handing back or losing a device

**Value.** An operator who loses a laptop must be able to destroy the data
without a secure-erase specialist, and a device handed back at post-mission
close must leave nothing recoverable. In a conflict setting a seized laptop is a
predictable, not exotic, event.

**Evidence.** `src/store.js:68-73` — plaintext write, no encryption layer to
destroy; no wipe path exists in `src/`, `scripts/`, or `deploy/`.

**Sketch.** With E5's encryption in place, a `scripts/wipe.mjs` that overwrites
the store file with random bytes, `fsync`s, unlinks, and confirms. Without
encryption, provide a documented `shred`-and-verify procedure plus a
`npm run wipe -- --confirm` that refuses to run unless an operator-supplied
phrase derived from the deployment ID is typed, so it cannot be triggered by a
curious or automated process.

### E3 — Encrypted-at-rest with a documented key-management story

**Value.** A copied volume or a stolen disk currently yields every field report,
intervention, and phone number in plaintext. Envelope encryption moves the
threat from "someone gets the file" to "someone gets the file *and* the key",
which is a materially different and much smaller surface.

**Evidence.** `src/store.js:68-73` (unencrypted `fs.writeFile`);
`docker-compose.yml:9-10` (named volume, no encryption); no encryption anywhere
in `docs/storage.md` or `docs/configuration.md`.

**Sketch.** AES-256-GCM per record with a data key (DEK) wrapped by a key
encryption key (KEK) loaded from `LINDELA_LITE_STORE_KEY` — env var, or a
chmod-600 file at `/etc/lindela/keystore` for compose. Store `iv`/`tag` alongside
the ciphertext; fail startup loudly on a wrong key rather than returning garbage.
Document: where the KEK lives, who holds a copy, how to rotate (re-wrap the DEK,
do not re-encrypt), and what key loss means.

### E4 — Signed releases with a verifiable provenance chain, plus cosign for the image

**Value.** Lets a district operator verify that the tarball they were handed over
USB matches a source commit, rather than trusting the courier. Today the
deployment path has no integrity check at all — the operator runs whatever
`deploy/one-click.sh` they received.

**Evidence.** `docs/security/supply-chain.md:35-37` — "Image signing via cosign
is not currently implemented but is reserved for future releases." The
`provenance` job (`ci.yml:111-124`) is the only signing, it is tag-triggered
only, and its generator is not digest-pinned.

**Sketch.** Add `cosign sign --yes` and `cosign attest --yes` to the `provenance`
job; publish the image to GHCR and sign it. Add a `release/SHA256SUMS` and a
`docs/deployment.md` section: `sha256sum -c SHA256SUMS` then
`cosnet verify-attestation`. Add `npm run verify-release` to `one-click.sh` that
refuses to proceed on a mismatch.

### E5 — Offline-first install and an air-gapped deployment path

**Value.** Half the intended deployments are district offices with an
intermittent or absent uplink; today the documented install requires a working
registry for both the base image and npm. An offline bundle makes "install" a
matter of copying one tarball, which is also the natural integrity-check
opportunity.

**Evidence.** `Dockerfile:10` (`npm ci` needs a registry); `docker-compose.yml:3`
(`postgres:16-alpine` needs a registry); `docs/deployment.md:193-205` covers VPS
and localhost only, with no air-gap section.

**Sketch.** `npm run bundle:offline` → `docker save` both images + `npm ci
--offline` tarball + a `manifest.json` with SHA-256 of each. One `deploy/one-click.sh
--offline-bundle ./lindela-offline.tar.gz` path that loads the images and installs
from the vendored tarball. Verify checksums on arrival; document the
registry-mirror primer for a site that has a local mirror.

### E6 — Secrets rotation without a restart, plus a rotation runbook

**Value.** Operator turnover is routine in humanitarian deployments and the
current runbook's advice is one line — "Rotate `LINDELA_LITE_API_KEY` after
operator turnover" — with no procedure and no overlap window. Rotation currently
requires a container restart, which on a district server means an outage during
which ingestion stops.

**Evidence.** `src/auth.js:1-18` re-parses `process.env` on every request, so a
`SIGHUP` could re-read it but nothing wires that. `docs/runbook.md:218-224` gives
the instruction without steps.

**Sketch.** Cache parsed tokens at module scope; `process.on('SIGHUP')` re-reads
`LINDELA_LITE_TOKENS` and swaps the cache atomically, so a new token can be added
*before* the old one is removed — a genuine overlap window. Write
`docs/runbook.md#rotating-credentials` covering the API key, the Postgres
password (`ALTER ROLE … PASSWORD` plus the `DATABASE_URL` update plus a restart),
the RapidPro token, and the webhook secret, with the verify command for each.

### E7 — Vulnerability scanning beyond `npm audit`

**Value.** `npm audit --audit-level=high` reads the npm advisory database, which
does not cover the OS packages in `node:20-bookworm-slim` (glibc, openssl, curl)
and knows nothing about the base image itself. For a device that may sit
unpatched for months, the OS layer is the more likely compromise surface.

**Evidence.** `.github/workflows/ci.yml:35-44` — `npm audit` plus the unpinned
`npx --yes trivy fs`. `docs/security/supply-chain.md:39-46` claims "build
integrity" from tests, SBOM, provenance, and release signing, with no image
scanning. There is no Dockerfile scanner and no OS CVE gate.

**Sketch.** `npx trivy@<pinned> image --severity HIGH,CRITICAL --exit-code 1`
against the built image in CI; `npx osv-scanner@<pinned> --lockfile=package-lock.json`
for transitive advisory coverage beyond npm's own feed; Renovate or
`npm-check-updates` for the base image digest. Make trivy a pinned devDependency
rather than a build-time `npx --yes` fetch (see D10).

### E8 — Power-failure resilience: write-ahead log and a shutdown contract

**Value.** Flaky power is a stated operating condition. Today a brownout during
a write loses the store; a periodic backup only bounds the loss if someone set
one up. A WAL plus a documented restore path turns total loss into a bounded
replay.

**Evidence.** `src/store.js:68-73` (single non-atomic `writeFile`); no `SIGTERM`
handler anywhere in `src/` (only `src/pg0.js:73`, for the child process);
`docs/runbook.md:200-217` — "1. Back up the store/database" as step 1, with no
scheduled-backup job and no verification.

**Sketch.** Append-only `data/wal.jsonl` of individual record mutations, fsync
per append; the periodic `write()` becomes a compaction that truncates the WAL
after the snapshot lands. On startup, replay any WAL entries newer than the
snapshot. Pair with the atomic rename from D3 and a `shutdown()` that drains.
Add a scheduled `npm run backup` to compose and a restore drill in the runbook.

### E9 — Health dashboard with data-freshness and storage-burn indicators

**Value.** `uptimeStats()` and the request ring buffer exist but are surfaced
only through `/api/v1/health`. An operator cannot tell from the UI whether
ingestion has silently stopped for three days — the exact failure
`check-live-sources.mjs` was written to catch in CI, where nobody is watching.

**Evidence.** `src/observability.js:3-27` (uptime, 100-entry ring buffer,
success rate — computed, then largely unused); `src/server.js:2655-2670` (`/health`
exposes counts and `storage.mode`, nothing else); no dashboard surface.

**Sketch.** A `/ops` page reading `/api/v1/health` plus a new
`/api/v1/ops/sources` that returns per-source `last_success_at`, staleness in
hours, and consecutive-failure count, colour-coded against the schedule
interval. Surface `recentRequestOutcomes()` as a sparkline so a rising 5xx rate
is visible without reading logs.

### E10 — Performance and load regression testing

**Value.** `export.csv` and `export.geojson` serialise the entire dataset on
every GET with no pagination and no result cap, and `JsonStore.read()` parses a
1.7 MB (and growing) JSON file on *every request*. On a district-office server
that is already the slowest machine in the building, the dashboard becomes
unusable as the store grows, and there is no test that would notice.

**Evidence.** `src/server.js:853-889` (full-dataset export, no limit);
`src/server.js:246` (`const data = await store.read()` on every API request);
`src/store.js:57-66` (`JSON.parse` of the whole file per request). No
performance test exists — `.github/workflows/ci.yml` has no load job, and
`scripts/check-responsive.mjs` covers rendering, not throughput.

**Sketch.** A `scripts/bench.mjs` that seeds a realistic store (10k hazard events,
2k incidents), then asserts p50/p95 latency for `/api/v1/health`,
`/api/v1/export.csv`, and a representative dashboard query stay under budget.
Track the numbers as a committed `bench-baseline.json` and fail CI on a 20%
regression. Fix the underlying issue first with an in-process snapshot cache
invalidated on write.

---

## Test coverage assessment

Coverage is measured by direct import from `test/`, and separately by whether
CI actually executes the suite. 375 `it()` blocks across six files;
`test/lite.test.js` alone holds 296 and imports ~40 modules.

**CI reality check.** `package.json:12` runs `node --test test/*.test.js`, which
includes `test/database.integration.test.js` — but both of its `describe` blocks
are gated on env vars CI never sets (D14), so they skip. `scripts/validate.mjs`
and `scripts/check-*.mjs` are lint-and-boundary checks, not behavioural tests.
`npm run test:coverage` (`package.json:13`) is excluded from that job, so its
thresholds cover five files and exclude the DB suite entirely.

| Module | Tests | What is not covered | Risk if broken |
|---|---|---|---|
| `src/alerts.js` | yes (lite) | `backtestTriggerProtocol` edge cases; shadow-mode threshold parity | Silent wrong alert thresholds; no evacuation triggered |
| `src/analytics.js` | yes (lite) | Degenerate inputs (all-zero population, single district) | Bogus risk scores drive resource allocation |
| `src/analytics/downscaling.js` | yes (lite) | Quantile-map bin edge cases, ties, out-of-range quantiles | Silently distorted district values |
| `src/analytics/ensemble.js` | yes (lite) | Empty ensemble, single-member spread | Spread reported as 0 → false confidence |
| `src/analytics/impact.js` | yes (lite) | Facilities-at-risk join with missing geometry | Missing facilities from impact estimates |
| `src/auth.js` | thin (lite: `hasRole`, `scopeToPartnerOrg` only) | **`authenticate`, `parseTokens`, `requireScope` never tested.** Malformed `LINDELA_LITE_TOKENS`; timing; `Bearer` vs `x-api-key` precedence; empty-token edge | **Highest-risk gap in the repo.** D1/D6/D7 are all in this file and all untested |
| `src/cap.js` | yes (lite) | XML escaping of alert text containing `&`, `<` | Feed-parser breakage in partner systems |
| `src/community.js` | yes (lite) | Normalisation of non-Latin / mixed-script feedback | Community signals dropped |
| `src/connectors/chirps.js` | yes (fixtures) | Upstream layout change — the class of bug `check-live-sources.mjs` exists to catch | Rainfall silently stops ingesting |
| `src/connectors/dhis2.js` | yes (lite) | Auth failure, pagination end conditions | Partial DHIS2 sync reported as success |
| `src/connectors/gdacs-archive.js` | **NONE** | Entirely unexercised | Dead code that *looks* live |
| `src/connectors/gdacs.js` | yes (fixtures) | Upstream XML drift | Disaster events lost |
| `src/connectors/glofas.js` | yes (fixtures) | Reach lookup miss | Flood forecasts refuse valid regions |
| `src/connectors/http.js` | via importers | No direct test: timeout, redirect, TLS failure, size cap | Hanging ingestion; unbounded response memory |
| `src/connectors/ipc-hdx.js` | via fixtures | Large-file CSV parse, quote escaping | IPC phase data corrupted silently |
| `src/connectors/nasa-firms.js` | yes (fixtures) | API-key rejection path | Fire data stops without an error |
| `src/connectors/noaa-enso.js` | via fixtures | El Niño index range validation | Seasonal forecast inverted |
| `src/connectors/open-meteo-archive.js` | **NONE** | Entirely unexercised | Backfill that powers flood-probability training quietly broken |
| `src/connectors/open-meteo-flood.js` | **NONE** | Entirely unexercised | Discharge labels for the model absent |
| `src/connectors/open-meteo.js` | yes (lite + fixtures) | Rate-limit / 429 backoff | Ingestion storm throttled upstream |
| `src/connectors/spec.js` | yes (lite) | Namespaced tag precedence | Connector registered under the wrong key |
| `src/connectors/uploads.js` | yes (lite) | Malicious filename, path traversal in upload | Write outside intended directory |
| `src/connectors/usgs-earthquake.js` | yes (fixtures) | Magnitude-null records | Quakes filtered out |
| `src/connectors/who-gho.js` | **NONE** | Entirely unexercised | Health data source silently dead |
| `src/districts.js` | yes (lite) | Unknown-district fallback | Unknown district reports to a wrong district's totals |
| `src/equity.js` | yes (lite) | Small-n accuracy breaches | False equity alarms, or missed ones |
| `src/flood-depth.js` | yes (lite) | No-data and DEM-gap regions | Fabricated depths presented as measured |
| `src/flood-probability.js` | yes (lite, ~40 assertions) | Well covered on refusals and fits. **Gaps: no numeric tolerance test on `predict()` outputs, no test that `MODEL_BASIS` actually reaches the API response, no test for `contingencyCount`/`contingency` at p0/p100** | A sign flip or calibration drift ships a *probability* — the highest-consequence output in the product — with no numeric guard |
| `src/i18n.js` | yes (lite) | RTL beyond ar/he; missing-key fallback in production | Garbled UI for non-Arabic speakers under duress |
| `src/index.js` | **NONE** | Library entry point; npm-published shape | Import path breaks for SDK consumers |
| `src/ingestion.js` | yes (lite + DB) | **Happy-path dominant.** No test for a connector that throws mid-run leaving partial writes; no test that `runIngestion` is idempotent across a crash; the `runIngestion` merged-map silent-drop bug class is now guarded by comment but only for the collections listed in `store.js:43-50` | **The documented silent-key-list bug class recurs on any new collection.** A partially-failed ingestion run looks successful |
| `src/kpi.js` | yes (lite) | Period boundaries crossing year end; division by zero | Wrong quarterly numbers in board reports |
| `src/lineage.js` | **NONE** | 672 bytes, never imported by a test | Provenance gaps invisible |
| `src/observability.js` | yes (lite, `uptimeStats` only) | **`logger.*` never tested — which is why D11's reversed-argument call ships.** Ring-buffer wrap, `metrics.render()` label formatting, histogram bucket boundaries | Unparseable logs; broken Prometheus exposition |
| `src/operations.js` | yes (lite, `buildCreate`) | Transition validation matrix, soft-delete interactions | Records moved through invalid states |
| `src/outbox.js` | yes (lite) | Retry backoff, poison-message handling | Events silently never dispatched |
| `src/parametric.js` | yes (lite) | Boundary payout triggers | Wrong money movement amount |
| `src/pdf.js` | yes (lite) | Font/unicode fallback for non-Latin names | Report renders boxes for Amharic/Somali names |
| `src/pg0.js` | yes (lite, mocks only) | Real binary lifecycle; crash recovery | Supervisor silently fails to restart the DB |
| `src/pii.js` | **NONE** | **Every function.** Falsy-zero coordinates, hash reversibility, retention boundary (exactly `retentionDays` old), non-array input | **D4/D5 ship undetected.** The only PII control with zero tests |
| `src/postgres-store.js` | present but **skipped in CI** | `ensureSchema` migration on an existing older schema; merge semantics; restart persistence | **The shipped production store is untested by CI** (D14) |
| `src/rapidpro.js` | yes (lite, `sendRapidProAlert` only) | **`verifyRapidProWebhook` untested** — the default-open behaviour (D2) has no test at all | Unauthenticated write path; SMS sent to the wrong people |
| `src/reports.js` | yes (lite) | Warning suppression with incomplete data | A report issued with a warning that never rendered |
| `src/road-access.js` | yes (lite) | Isolated graph components | "Unreachable" reported as "accessible" |
| `src/routing.js` | yes (lite) | Unreachable destination; fuel/constraint violations | Convoy route planned that cannot be driven |
| `src/sanctions.js` | yes (lite) | Fuzzy-match false positives | Wrongly flagged counterparties |
| `src/scenarios.js` | yes (lite) | Round-trip with unicode and `%` in params | Shared scenario URL decodes to a different scenario |
| `src/schema.js` | via store | `emptyStore()` completeness vs `COLLECTIONS` drift | The exact silent-drop class `store.js:43-50` warns about |
| `src/server.js` | yes (lite, largest suite) | **Only two 401 assertions (`lite.test.js:1011`, `:1672`). No test asserts that GET requires auth — because it does not.** No test for `/metrics` gating, no concurrent-request test, no body-size-limit test, no traversal-test for encoded `%2e%2e` | **The largest file in the repo, the entire security boundary, is tested mostly for happy-path responses.** Everything in D1–D3, D7, D15 lives here |
| `src/stac.js` | yes (lite) | STAC paging; non-numeric bbox | Broken catalogue pagination for partner GIS |
| `src/storage.js` | yes (lite + DB-skipped) | `auto` mode ordering: pg0 available-but-fails → JSON fallback silently | **A production deployment configured for Postgres silently degrading to a JSON file on disk.** Highest-consequence untested branch |
| `src/store.js` | yes (lite) | **`write()` atomicity (D3) untested — there is no crash simulation.** No concurrent `merge()` test | Power cut destroys the store; silent write loss |
| `src/terrain.js` | yes (lite) | Tile-cache staleness across a deployment boundary | Stale elevation → wrong flood depth |
| `src/utils.js` | yes (lite) | `toCsv` injection: a cell beginning `=`, `+`, `-`, `@` | **CSV formula injection in an export the operator opens in Excel** |
| `src/webhooks.js` | yes (lite) | Non-HTTPS webhook URLs; redirect following | Report sent in the clear |
| `src/workflows.js` | yes (lite) | Illegal transition from each terminal state | Workflow instances in impossible states |

**Three structural gaps worth naming.**

1. **Nothing tests the security boundary.** `auth.js` has no test of
   `authenticate` or `parseTokens`; `rapidpro.js` has no test of
   `verifyRapidProWebhook`; `server.js` has two 401 assertions and no
   negative-authorization matrix. Every defect in the D1/D2/D6/D7 family is
   invisible to the suite by construction.
2. **The store that ships is not the store that is tested.** CI exercises
   `JsonStore`; compose runs `PostgresStore` (D14). And `JsonStore.write()` — the
   one function whose failure mode is total data loss — has no crash or
   concurrency test.
3. **Coverage thresholds measure the wrong thing.** `package.json:13` enforces
   75% lines across `src/**`, but `src/pii.js` (103 lines) and `src/lineage.js`
   sit at 0% and barely move the aggregate against a 111 KB `server.js`. The
   77.9% baseline cited in `ci.yml:31-32` is compatible with a completely
   untested authentication path.

---

## Supply chain

Every unpinned or build-time-fetched dependency, with its risk. Note first that
the *runtime* dependency surface is genuinely tiny: `package.json:31-33` declares
exactly one direct dependency, `pg`, and `package-lock.json` (lockfileVersion 3)
pins it to `pg@8.20.0` with an `integrity` SHA-512, alongside `pg-cloudflare`,
`pg-connection-string`, `pg-int8`, `pg-pool`, `pg-protocol`, `pg-types`, and
`pgpass`. There are **no devDependencies at all** — the test runner is Node's
built-in `node --test`. That is a genuinely strong posture and worth
preserving. The risk is concentrated entirely in CI-time tooling and base
images.

| Item | Pinning | Where | Risk |
|---|---|---|---|
| **`npx --yes trivy`** | **none** — latest at run time | `ci.yml:44` | **Highest.** The repo's vulnerability scanner is fetched unpinned from npm on every run, with no integrity check and no lockfile. Compromise of the `trivy` npm wrapper yields arbitrary code execution in a job holding checkout credentials — and the scanner's own output becomes attacker-controlled. This inverts the control it provides |
| **`npx --yes @cyclonedx/cyclonedx-npm`** | **none** — latest at run time | `ci.yml:53`; also `docs/security/supply-chain.md:16` | Same mechanism. A malicious version can emit a sanitised SBOM naming known-good packages while the build actually ships different code — defeating the entire SBOM control. The doc teaches operators this exact unpinned command |
| **`npx --yes wait-on`** (×2) | **none** — latest at run time | `ci.yml:103`, `ci.yml:108` | Same mechanism, in the manual `dashboard` job. Runs immediately after the server starts, so it is the first third-party code to execute in that job |
| `actions/checkout@v4` | mutable tag | `ci.yml:14, 27, 38, 49, 68, 93, 119` | Tag is mutable; a compromised action repo or a maintainer push retargets it |
| `actions/setup-node@v4` | mutable tag | `ci.yml:15, 28, 40, 50, 69, 94` | Same. Supply-chain-relevant beyond the general case — it controls the Node toolchain |
| `actions/upload-artifact@v4` | mutable tag | `ci.yml:54, 79` | Same |
| `slsa-framework/slsa-github-generator@v1.10.0` | tag, not generator digest | `ci.yml:120` | The one action with `contents: write` and `id-token: write` (`ci.yml:115-117`). SLSA generators are supposed to be pinned to a generator digest for the attestation to be meaningful; a `vX.Y.Z` tag ref does not provide that. **Verify this job produces a verifiable attestation at all** — `docs/security/supply-chain.md:21-25` claims SLSA L3 on its strength |
| `node:20-bookworm-slim` | **mutable tag, no digest** | `Dockerfile:1` | Every rebuild pulls whatever `20-bookworm-slim` points to. For a device deployed for months and rarely patched, the base image is the longest-lived, least-controlled supply-chain artifact. Pin by digest |
| `postgres:16-alpine` | **mutable tag, no digest** | `docker-compose.yml:3` | Same, and it holds the district's data |
| `google-chrome` (runner preinstalled) | runner image | `ci.yml:106` | `ubuntu-latest` is a moving target; the Chrome build is not controlled by this repo. Acceptable for a manual-only job |
| `npm ci` | **lockfile-pinned, integrity-checked** | `Dockerfile:10` | Correct. The best-controlled link in the chain |
| `pg@8.20.0` + 7 transitive | lockfile-pinned with `integrity` | `package-lock.json` | Correct. `pg-protocol@1.13.0` is the historic parser-DoS family — currently pinned with integrity, so a CVE would be caught by the audit job |
| OS packages (`ca-certificates`, `curl`) | **unpinned apt versions** | `Dockerfile:5-7` | Built at image-build time from Debian's current pool. No SBOM covers them; `npm audit` cannot see them (D-level finding in E7) |
| Fork-PR secret exposure | **not applicable** | `ci.yml` | No `secrets:` are referenced in any job, and the only credentialed job (`provenance`) is `if: startsWith(github.ref, 'refs/tags/')`, which a fork PR cannot satisfy. **No fork exfiltration path.** Worth preserving deliberately — do not add secrets to the `test` job |
| Absent permissions blocks | — | `ci.yml` | No `permissions:` on `test`, `coverage`, `audit`, `sbom`, `live-sources`, `dashboard`. They inherit the repo default. Add a top-level `permissions: contents: read` |
| `npm audit --audit-level=high` | — | `ci.yml:42` | Reasonable for one dependency, but it covers only the npm advisory feed. No OS-package or image scanning (E7) |
| Secrets in the tracked tree | clean | `git grep` + history sweep | No live credentials in the working tree or history. `start-claude.sh` was removed at `3241a82`; its blob at `2a74feb` already reads `OPENROUTER_KEY_REMOVED` (D17) |
| Secrets in the image | clean | `Dockerfile` | No `ARG` or `ENV` carries a secret; all secrets arrive via compose environment. Correct pattern |
| `.dockerignore` | **incomplete** | `.dockerignore:5` | `.omx` is a typo for `.omc`; `.claude/` and `.zvec-grep/` (19 MB) are unexcluded, so a developer's local agent state and index enter the build context (D9) |

**Prioritised remediation order.** (1) Replace the three `npx --yes`
invocations with pinned versions — this is the one item that turns a supply-chain
compromise into remote code execution in CI. (2) Pin all actions by commit SHA.
(3) Add `permissions: contents: read` at workflow level. (4) Pin
`node:20-bookworm-slim` and `postgres:16-alpine` by digest. (5) Pin the SLSA
generator properly, or downgrade the SLSA claim in `supply-chain.md` to match
what CI actually does. (6) Fix `.dockerignore`.

---

## Rejected

**Docker Compose anonymous volumes.** `docker-compose.yml:9-10` and `:65-66` both
declare `lindela_lite_pgdata` as a *named* volume, declared once at top level and
referenced by name. The classic anonymous-volume footgun (`/var/lib/postgresql/data`
declared inline without a top-level name) is not present. `docker compose down -v`
will still destroy the data — that is inherent to `-v` and is not a defect — but
`one-click.sh:76` advertises plain `docker compose down`, not `-v`. Named, correct,
no change needed.

**Exposing Postgres to the host.** `docker-compose.yml` has no `ports:` on the
`db` service (the only `ports:` block is line 38-39, for the app). Postgres is
reachable only on the compose network. Correct as written.

**`.env` baked into the image.** `Dockerfile` sets only `NODE_ENV` and
`LINDELA_LITE_PORT` via `ENV`; no `ARG`, no `COPY .env`. Secrets reach the
container through compose environment variables. The correct pattern, and the
reason `docker history` shows nothing sensitive.

**A HEALTHCHECK.** Present and correct — `Dockerfile:23-24` with a real interval,
timeout, start-period, and retry count against `/api/v1/health`, plus matching
healthchecks in compose for both `db` (`pg_isready`) and `app`. This is better
than most projects of this size. No finding.

**`openssl rand -hex 24` in the one-click script.** `deploy/one-click.sh:7-13`
uses 192 bits from a CSPRNG, with a `crypto.randomBytes` fallback when openssl is
absent. `chmod 600` is applied (`:39`). `set -euo pipefail` is present (`:2`). The
script does not echo the generated secrets — it prints only the dashboard URL.
This is the correct implementation; the defects around it (D13) are about the
*existing-file* branch and the `change-me` placeholders, not the generator.

**Log injection.** `src/observability.js:46` builds a plain object and
`JSON.stringify`s it, so control characters in user-supplied data are escaped and
cannot forge log lines. `src/server.js:126` logs `route` from
`normalizeRoute()`, which rewrites UUID and numeric path segments to `:id`, so
attacker-chosen path text does not reach the log verbatim. No injection defect.

**Path traversal.** `src/server.js:95-102` (`hasTraversalSegment`) rejects any
URL whose decoded path contains a `..` segment, and a decode failure returns
`true` (fail closed). Checked before routing. Adequate.

**A default API key in the repository.** `.env.example:4` ships
`LINDELA_LITE_API_KEY=change-me`, which is a placeholder rather than a working
default — `src/server.js:229` treats an unset key as "auth off", not "match
`change-me`". So there is no shipped credential that silently grants access. The
placeholder is still a real weakness (D13) but it is a deployment-process
problem, not a backdoor.

**PII in the tracked git tree.** `data/` is gitignored (`.gitignore:1`) and
`data/lindela-lite-store.json` is untracked. The committed
`data/calibration/latest.json` (13 KB, model calibration) contains no personal
data. `SECURITY.md:18-20` states the no-client-data rule explicitly. No leak.

**`.claude/`, `.omc/`, `.zvec-grep/` in git.** All three are correctly gitignored
(`.gitignore:8, 14, and CLAUDE.md/AGENTS.md at 21-22) and none appear in
`git ls-files`. `start-claude.sh` was untracked at `3241a82`. The exposure is
confined to the Docker build context (D9), not to version control.

**SQL injection in `postgres-store.js`.** The single dependency is `pg`, which
uses parameterised queries throughout; there is no string-concatenated SQL path.
The residual risk is the classic one — the connection string is passed via
`LINDELA_LITE_DATABASE_URL` with the password inline (`.env.example:11`), so the
credential appears in the process environment and in `docker inspect` output.
Accepted for this deployment model; noted under E3's key-management story rather
than raised as a separate defect.

**Dockerfile multi-stage build.** `npm ci --omit=dev` with zero devDependencies
produces a `node_modules` containing only `pg` and its seven transitive packages.
There is no build toolchain, no compiler, and no `node_modules/.cache` to strip,
so a multi-stage build would remove approximately nothing. Single-stage is the
correct choice here. (The image still runs as root — D9 — and still ships
`docs/` and `scripts/` it does not need, but multi-stage would not help either
point.)

**A `pg` native/crypto vulnerability gate beyond `npm audit`.** With one direct
dependency and eight total packages, `npm audit` plus a pinned lockfile is a
reasonable bar. The gap is the *OS layer* (E7), not the npm layer. Raising this as
a defect would be proportionate inflation.