# Defect catalogue — audit 2026-10

**Disjoint from the prior audit.** `docs/improvements/defects.md` uses
`SEC / DAT / DATA / ING / INT / PRIV / TEST / WEB`. This catalogue uses fresh
prefixes — `VUL` (security), `VER` (data veracity), `CON` (concurrency), `SCL`
(scalability), `OBS` (observability), `ARC` (architecture), `CAP` (capability gap),
`QUA` (test quality) — so no ID here restates one there.

**Line numbers** were re-verified against the tree at `72a6b63`, not copied from
the audit notes; where a note's line drifted, the verified line is used.

**Severity.** CRITICAL = silent wrong answer or credential/internal-network
exposure. HIGH = wrong or lost data, or an outage class. MEDIUM = degraded
behaviour, real but bounded. LOW = latent or cosmetic-with-teeth.

---

## Security

### VUL-01 — CRITICAL — SSRF in report distribution; `channel.url` is fetched unguarded
`src/server.js:2909` `await fetch(required(channel.url, 'url'), { method: 'POST', … })`.
`channel.url` arrives from the request body via `normalizeDistributionChannels`
(`src/server.js:3030`, `url: channel.url || null`) and is used as-is.
`assertSafeWebhookUrl` is **never called in `src/server.js`** — the guarded path is
`src/webhooks.js:164` (shape + DNS re-check), called only from the outbox.

**Exploit.** `POST /api/v1/reports/<id>/distribute` with
`{"channels":[{"channel":"webhook","url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}]}`.
The server fetches the metadata endpoint; `readExternalResponse` (`src/server.js:3072`)
parses the body, which is persisted into `report_distribution_runs` and returned in
the 201 response. The same primitive scans RFC-1918 hosts. Requires the reports
write scope — a lower bar than admin.

**Fix.** Call `assertSafeWebhookUrl(channel.url)` before the fetch, as the outbox
does. ENH-78 turns this into a regression spec.

**Fixed 2026-10-11.** `POST` report distribution resolves `channel.url` through
`checkWebhookUrl` (`src/server.js:3376`) before the fetch, so the SSRF guard the
registration route already applied now covers the send. The registration path and
the delivery path answer to the same predicate.

### VUL-02 — HIGH — RapidPro webhook secret accepted from the query string
`src/rapidpro.js:363` `|| url.searchParams.get('secret')`, compared by
`constantTimeEquals`. The body-signature path (`:358`) is preferred, so this is the
shared-secret fallback — but a secret in a URL is written to access logs, proxy
logs, the `Referer` of downstream requests and browser history. The leaked value is
the same secret that authenticates inbound webhooks.

**Fixed 2026-10-11.** The shared secret is read from the header only.
`src/rapidpro.js:360-363` states it: a secret in the query string is refused, not
trusted, because a URL is logged by every proxy between the sender and here.

### VUL-03 — MEDIUM — Partner-org scoping is inert for reports and by-id reads
`scopeToPartnerOrg` (`src/auth.js:455`) has zero callers. `filterRecords` scopes
only when a record carries the field (`src/utils.js` `item?.partner_org === partnerOrg`),
and `normalizeReport` (`src/reports.js`) never sets `partner_org`. The by-id read
(`src/server.js:2617` `data.reports.find(…)`) does not pass through `filterRecords`
at all. A token scoped to partner org A reads org B's reports and any record lacking
the field. This is a per-object authorization gap that holds for an authenticated,
scoped caller — distinct from the unauthenticated-GET class the prior audit covered.

**Fixed 2026-10-11.** Three layers, matching the three that were missing. The
claim is expressible: `parseTokens` carries `partner_org` from the token definition
through `authenticate` (`src/auth.js:330-387`). It is enforced: `scopeToPartner`
filters every collection on the read (`src/store.js:322`), `PostgresStore` pushes
`partner_org = $2` into the WHERE clause (`src/postgres-store.js:383`), and
`filterRecords` reads the request's identity by default rather than an opt-in third
argument (`src/utils.js:197`). It is checkable: `findVisible` (`src/server.js:1086`)
is the one way a by-id route resolves a record, so thirty-one branches across nine
handlers that had `data.reports.find((item) => item.id === route.id)` now carry the
same predicate as their own listing, and a by-id read of another organisation's id
returns `null` rather than confirming the id exists. `test/partner-isolation.test.js`
(27 tests) asserts all three, including that the by-id form agrees with the listing
about a record carrying no partner claim. Records written by a path that sets no
`partner_org` are invisible to a partner token — the deny-by-default reading
`src/auth.js:550` documents, which fails visibly rather than handing over the store.

### VUL-04 — MEDIUM — Dead role checks imply authorization that does not exist
`src/server.js:3908–3909` compute `isAdmin` and `isOperator`; neither is referenced
again in the file. The parametric routes read as if they gate on role but gate only
on scope. A reviewer trusting these variables assumes an admin/operator distinction
that is not enforced.

**Fixed 2026-10-10.** The dead variables were the symptom; the defect was that the
scope vocabulary could not express what `docs/api.md` already promised. Four
documented routes named an audience the gate refused: `POST /api/v1/chw/report` and
`/chw/reply` are documented "`role:chw` or `*`", `POST /api/v1/community-feedback`
"`role:chw`, `write:incidents`, or `*`", and `POST
/api/v1/parametric-rules/:id/simulate` "`role:operator` or `admin:*`". A CHW token
holds `role:chw` and no data scope, so the report the whole surface exists to send
answered 403 to the phone meant to send it — and `/simulate` was unreachable by the
role its own document names.

Two limits in `src/auth.js` caused it, both fixed:

- The table held **one scope per prefix**, so a documented disjunction could only
  name one of its audiences. A scope may now be an alternation —
  `role:chw|write:incidents` — tried left to right, each a complete requirement.
- The matcher spoke only in **prefixes**, so `/simulate` could not be addressed
  apart from the collection it lives under. A pattern may now carry a `:name`
  segment, and the **longest** match wins rather than the first — which removes the
  order-sensitivity that two comments in the table existed to warn about.

`requireScope` gains one branch: a `role:` requirement is satisfied by `admin:*`
(an administrator holds every role — `hasRole` always said so and is called by
nothing in `src/`). Deliberately one-directional: a role does not satisfy a data
scope, so `role:chw` cannot reach `admin:alerts`. The dead `isAdmin`/`isOperator`
are removed, with the enforcement point named in their place.

### VUL-05 — MEDIUM — CI executes unpinned network tooling and tag-pinned actions
`.github/workflows/ci.yml` runs `npx --yes trivy`, `npx --yes @cyclonedx/cyclonedx-npm`
and `npx --yes wait-on` with no version pin (resolves `latest` at run time), and
pins actions by mutable tag (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`,
`slsa-framework/slsa-github-generator@v1.10.0`). A compromised or typosquatted npm
publish runs arbitrary code in CI with `id-token: write` and `contents: write` on
the provenance job.

**Fixed 2026-10-10 — and the pins were not the worst of it. CI had never run.**

`gh run list` across the repository's whole history: 264 failures, one success
(2026-05-18, before the file was rewritten). Every failure after that completed in
**0s with zero jobs** — GitHub rejected the workflow file before starting it. Two
independent defects, each sufficient on its own:

1. `schedule:` and `workflow_dispatch:` sat at **job** level on `live-sources`.
   They are top-level keys; at job level they are unexpected and invalidate the
   file. (The `dashboard` job's `if: github.event_name == 'workflow_dispatch'`
   could therefore never be true either.)
2. `provenance` invoked `slsa-framework/slsa-github-generator@v1.10.0` as a
   **step**. That repository publishes a reusable *workflow* and actions under
   `actions/`; it has no root `action.yml`, so the step is unresolvable and the
   file is rejected — and validity is checked before `if:`, so the tag gate on the
   job never protected it.

Both are fixed. `npx --yes trivy` was also not a command at all — Trivy is not
published to npm, so that step exited 1 on every run and never scanned anything;
it is replaced by the official `aquasecurity/trivy-action` pinned to a commit.
`base64-subjects: ''` attested zero artifacts and now names the SBOM's hash, with
`sbom` exporting it. Every action is pinned to a commit SHA and every `npx`
tool to an exact version.

`scripts/check-workflows.mjs` is added to the self-contained gate tier and to
`validate.mjs`. It covers both defects — `actionlint` catches (1) and not (2), and
(2) is the one that broke every run — without needing a Go toolchain or the
network. It carries three canaries that must be rejected, and it was canaried
against the two real defective revisions (`16c7c05`, `037b1dd`), each of which it
catches.

**Fixed 2026-10-11.** Every action is pinned by commit SHA with the tag in the
comment (`checkout@11d5960`, `setup-node@49933ea`, `upload-artifact@ea165f8`,
`slsa-github-generator@c747fe7`), and every `npx --yes` names a version
(`cyclonedx-npm@6.0.1`, `wait-on@9.5.1`). `npx --yes trivy` is gone: Trivy is not
published to npm, so that step was a command that could never have run, replaced by
`aquasecurity/trivy-action@a9c7b0f` pinned the same way.

### VUL-06 — LOW — Base image not pinned by digest
`Dockerfile:1` `FROM node:20-bookworm-slim` tracks a mutable tag; a rebuild can pull
a different base than the one the SBOM attests.

**Fixed 2026-10-10.** Pinned to
`node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0`,
with the tag kept in the comment and the one-liner that resolves a new digest.

### VUL-07 — LOW — CSP permits inline scripts
`src/server.js:4702` `script-src 'self' 'unsafe-inline'`. The surfaces are static
today, so this is latent, not live — but it removes the primary XSS mitigation for
any future dynamic content.

**Fixed 2026-10-10.** `'unsafe-inline'` is gone from `script-src`; the header now
names the sha256 of each inline script the surfaces ship (nine of them).

A nonce was the obvious mechanism and the wrong one: the service worker caches
HTML for offline use, so a per-request nonce would be stale in every cached page
and every script would be blocked offline — on the surfaces whose purpose is
working without a connection. The inline scripts are byte-static per file (the
one per-request substitution, the app-version marker, is in a `<span>` outside
them), so hashes survive caching.

The one thing a hash cannot cover is an inline event handler, and there was
exactly one — `onclick` on the portal's sign-in button — which is why
`'unsafe-inline'` had been needed at all. It is wired in `portal/app.js` now.

`scripts/check-csp.mjs` generates the hash list into `src/server.js` and fails
when the two disagree; a stale hash does not throw, the browser blocks the script
silently, so a hand-maintained list would go stale unnoticed. Wired into the
self-contained gate tier and `validate.mjs`.

The first version of this fix shipped the hashes **unquoted** in the header —
`sha256-…` instead of `'sha256-…'`, because the quotes were JavaScript string
delimiters in the array and vanished from the value. An unquoted hash-source is
not a hash-source: the browser ignores it and blocks all nine scripts. The test
that caught it hashes the **served** response rather than the file on disk, which
is the only thing the browser ever sees, and asserts against the header rather
than the exported array.

---

## Data veracity

### VER-01 — CRITICAL — Precipitation summed across stations; the flood score tracks station density, not rainfall
`src/analytics.js:452` `const precipitation = usablePrecip.reduce((sum, v) => sum + v, 0)`,
folded into the score at `:466` `precipitation * 1.5 + …`. `nearby(…)` collects every
climate observation within 125 km, each a *point* total; summing N readings of the
same storm yields N× the rainfall of one. Correct quantity is a spatial mean.

**Failure.** Five stations reporting 20 mm each → `100*1.5 → 100`; one station
reporting 20 mm → `30`. Same weather, 3× the risk band, from sensor density alone.
A coordinator pre-positions assets in the well-instrumented district and starves the
identical under-instrumented one. The score is a map of where the stations are.

**Fix.** ENH-45: declare precipitation `intensive` and refuse the `reduce`.

**Fixed 2026-10-11.** The rainfall term reads `row.precipitation_mm` and treats a
non-finite value as unmeasured rather than as dry (`src/analytics.js:177-186`); the
old form read `value`, which nothing writes, so the filter matched nothing and the
sum tracked station density instead of rainfall.

**The class had a second live instance, found by ENH-45's gate 2026-10-11.**
`computeClimateConflictRisk` — the sibling scorer, in the same module — summed
`precipitation_mm` over the same `nearby()` collection
(`src/analytics.js:624`), so its climate term measured sensor density too. Two
instances of one defect, months apart, in one file, is the case for a registry
rather than a third fix; the term is now the spatial mean (`:644`). The fix
lands in ENH-45's registry, which classifies `precipitation_mm` intensive along
the space axis and extensive along time — the axis distinction is what lets
`src/flood-probability.js` keep summing rainfall over days, which is correct.

### VER-02 — CRITICAL — Absent probability folded in as 0, against the module's own comment
`src/analytics.js:461` computes `maxProbability` as `null` when absent, and the
comment above states "an absent forecast is not a 0% chance of rain" — then `:466`
does `(maxProbability ?? 0) * 0.35`. A district whose forecast feed dropped scores
systematically lower than one with a genuine dry forecast: a data outage reads as
lower risk, the unsafe direction.

**Fix.** Omit the term and renormalise over present inputs, or carry it as unknown
so the score is flagged incomplete. ENH-46 catches the pattern.

**Fixed 2026-10-11.** `maxProbability` is `null` when no forecast exists and the
score omits the term, publishing `probabilityTermOmitted` beside it
(`src/analytics.js:479-494`). `(maxProbability ?? 0) * 0.35` folded a missing
forecast in as a 0% chance, which reads as a clean record.

### VER-03 — HIGH — Events admitted by `occurred_at || from` are dropped by the labeller, which reads only `occurred_at`
`src/flood-probability.js:101` prefilter `Date.parse(event.occurred_at || event.from || '')`;
`monthHasFlood` at `:194` `Date.parse(event.occurred_at)` — no `|| event.from`.
A GDACS-style event dated only by `from` survives the prefilter, is counted in
`events_matched`, but `Date.parse(undefined)` is `NaN` so it never labels a month.

**Failure.** A district with 12 flood events, 8 dated by `from` only, yields 4
positive months. The contingency table's `a` shrinks; the logistic fit and Wilson
intervals are computed on a corrupted table, biased low exactly where the record is
richest. **Fix.** Read the same field set in both places.

**Fixed 2026-10-11.** The labeller and the admission check read the same field:
`Date.parse(event.occurred_at || event.from || '')`
(`src/flood-probability.js:101`, `:200`). An event admitted by `from` is no longer
dropped by a labeller that read only `occurred_at`.

### VER-04 — HIGH — Quarterly KPI latency is measured over all-time dispatches
`src/kpi.js:169` `signalToDispatchHours(data.rapidpro_dispatches)` — the raw store,
not the period-filtered set built at `:120`. The monthly series at `:349` uses the
filtered variable correctly. A quarter whose dispatches were all sub-hour reports a
median diluted by years of slower history — or masks a current-quarter regression.

**Fixed 2026-10-11.** Quarterly latency is measured over the quarter's dispatches,
via `signalToDispatchHours` bounded to the period, and the field latency is
`fieldActionLatency(data, { period_start: from })` (`src/kpi.js:195-207`). When no
dispatch carries both timestamps the figure is `null` with a `data_gaps` entry
naming why (`:269`) rather than an all-time interval published as a quarterly one.

### VER-05 — HIGH — `computeApiUptime` returns 100.0 when the rate is unmeasured
`src/kpi.js:102` `return 100.0` when `computeShortTermSuccessRate()` is `null`.
`null` means "no requests in the ring buffer," not "perfect." A freshly started or
idle deployment publishes "100% API uptime" from zero observations, on the
dashboard an approver reads. The module's own convention elsewhere is to return
`null` and render "not measured."

**Fixed 2026-10-11.** `computeApiUptime` returns `null` when the ring buffer holds
no requests (`src/kpi.js:114-125`). Zero observations is no measurement, not perfect
uptime; the surface renders the null.

### VER-06 — HIGH — `filterForDistrict` drops every id-less record after the first
`src/districts.js:84` `const seen = new Set()` … `if (seen.has(r.id)) continue`.
For a record with no `id`, the first match adds `undefined` to `seen`; every later
id-less match hits `seen.has(undefined)` and is skipped. Id-less records are not
duplicates. A district with 40 un-keyed field reports shows 1.

**Fixed 2026-10-11.** `filterForDistrict` dedups only when a record has an id
(`src/districts.js:83-101`). `seen.add(undefined)` collapsed every id-less record
after the first, so a district with 40 un-keyed field reports showed 1.

### VER-07 — HIGH — Region aggregation rounds coordinates to integer degrees (~111 km)
`src/analytics.js` region key `${country}:${Math.round(lat)}:${Math.round(lon)}`. A
1°×1° bucket is ~111 km on a side: distinct districts collapse into one region whose
coordinate is whichever point arrived first, and a district straddling a boundary is
split into two half-regions scored against part of its data. Two counties 100 km
apart are reported as one blended score; a boundary county gets two contradictory ones.

**Fixed 2026-10-11.** Region aggregation buckets on a half-degree grid
(`src/analytics.js:1067-1068`), replacing the integer-degree key that merged points
up to ~111 km apart into one cell.

### VER-08 — MEDIUM — Input-shift verdict is `'stable'` when every feature's PSI is null
`src/drift.js:150` `let worst = 0`, so an all-null feature set yields `worst_psi: 0`
and `verdict: 'stable'`. Per-feature verdicts correctly say `'not_measurable'`
(`:158`), but "no feature could be measured" is reported as "distribution stable" —
genuine covariate shift is never flagged.

**Fixed 2026-10-11.** A drift result whose PSI is null reports
`verdict: 'not_measurable'` with `worst_psi: null` (`src/drift.js:156-185`). Every
feature unmeasured no longer aggregates to `verdict: 'stable'`.

### VER-09 — MEDIUM — `people_reached` folds a recipient count in as if it were an address
`src/analytics/metrics.js:297` `… ?? d?.recipient_count`, added to the distinct
destination set. `recipient_count: 500` becomes the single string `"500"` — one
destination for 500 people; two such dispatches dedup to one; a genuine address
`"500"` collapses with it. `distinct_destinations` travels beside a "people reached"
label and will be read as one.

**Fixed 2026-10-11.** `recipient_count` is excluded from the distinct-destination set
(`src/analytics/metrics.js:297-307`) — it is a head count, not an address — and the
count of dispatches that carried one is published as `without_recipient_count`.

### VER-10 — MEDIUM — Doc comment contradicts the constant
`src/analytics/ensemble.js:90` says "two is the smallest count at which…";
`MIN_ENSEMBLES_FOR_SPREAD_SKILL = 3`. A maintainer relying on the doc believes a
2-member ensemble is scored; it returns `null`.

**Fixed 2026-10-11.** The doc comment above `MIN_ENSEMBLES_FOR_SPREAD_SKILL` says
three, which is what the constant is (`src/analytics/ensemble.js:90-95`). The
sentence and the value had said two and three respectively.

### VER-11 — MEDIUM — Duplicate object key `outcome_coverage`; the first is dead
`src/calibration.js` declares `outcome_coverage` twice in one object literal; the
second silently overwrites the first. Harmless today, a latent trap: an edit to the
first line has no effect.

**Fixed 2026-10-11.** `outcome_coverage` is declared once in the literal, in the
four-decimal form (`src/calibration.js:157`), with a comment recording that the
first declaration was dead.

### VER-12 — LOW — Service-impact confidence coerces absent confidence to 0 via `|| 0`
`src/analytics.js` `(nearestFlood?.item?.confidence || 0)`. An asset outside every
risk radius reports confidence 0, reading as "certain the risk is zero" rather than
"no risk reading for this asset."

**Fixed 2026-10-11.** The service-impact payload publishes the nearest flood risk's
confidence as `null` when the asset is outside every radius
(`src/analytics.js:761`), so an unmeasured risk no longer reads as a certain zero.

### VER-13 — HIGH — The IoT map layer coerces an absent sensor position to Null Island
Found 2026-10-11 while extracting the field-signal family (ARC-01), not by the audit.
`src/routes/field-signals.js` `iotMapLayer`: `if (!Number.isFinite(Number(row.lat)) …)`.
`Number(null) === 0` is finite, so a sensor that reported no position passed the
filter and was drawn at 0/0 in the Gulf of Guinea. The disease map twenty lines away
carries a comment warning against exactly this coercion and uses
`Number.isFinite(record.latitude)` instead — the guard was applied at one of the two
sites, which is the shape CLAUDE.md records as "a control that exists is not a control
that is applied".

Invisible until now because every fixture in the repo omits `lat` **entirely** rather
than sending `null` (`test/api-substrate.test.js:503`), and `Number(undefined)` is
`NaN`, which the filter correctly rejects. The bug needs a producer that sends an
explicit `null` — which is what `normalizeIotObservation` writes for a gateway that
omits the field (`lat: input.lat ?? existing?.lat ?? null`).

**Fixed 2026-10-11.** Both map layers read coordinates through `readCoordinate`
(`src/routes/field-signals.js:63-90`, `:100-112`), the module whose own doc comment
says the guard "has to rule absence out before it asks about the number". That is
stricter than raw `Number.isFinite(x)` as well: it admits the numeric string `"3.12"`
that connectors send, which `Number.isFinite` would reject as a non-number.
Three canaries confirm the test fires on the null-coercion, on the raw-`isFinite`
variant, and on the iot filter specifically.

---

## Concurrency

### CON-01 — CRITICAL — Cross-replica read-modify-write in `outbox.emit`
`src/outbox.js:64` `const data = await store.read()`, then `:106`
`await store.merge({ events_outbox: [record], … })`. The guard at `:66` and the
whole `record` construction are computed against a snapshot; the merge is a separate
statement. On Postgres two processes both read, both decide an event is absent, both
merge — the `attempts`/`next_attempt_at` carry-forward is decided from stale state.
An event re-emitted mid-dispatch resurrects a row whose backoff was just set.
ENH-63 (`pg_advisory_lock`) is the fix.

**Fixed 2026-10-11.** `emit` decides and merges inside one `store.withLock`
(`src/outbox.js:70`), which on Postgres is a transaction-scoped advisory lock, so the
read-modify-write is serialised across replicas and an event re-emitted mid-dispatch
cannot resurrect a row whose backoff was just set.

### CON-02 — HIGH — No deadlock retry; `write()` vs `merge()` lock inversion
`src/postgres-store.js:336` `DELETE FROM lite_records WHERE collection <> '__schema'`
takes row locks across essentially the whole table inside a txn, while `merge()`
upserts the same rows. No `SET TRANSACTION ISOLATION LEVEL`, no `pg_advisory_lock`,
no retry on `40P01` (grep for `advisory|ISOLATION|deadlock|40P01` in
`postgres-store.js` returns nothing). A `write()` racing a `merge()` returns a raw
deadlock error to the caller with no backoff.

**Fixed 2026-10-11.** Every write transaction takes one advisory lock first
(`src/postgres-store.js:64-80`), which removes the `write()`-vs-`merge()` inversion
rather than surviving it, and a retry on the two retryable SQLSTATEs (`40001`,
`40P01`) covers a caller that did not take the lock (`:60`, `:614`).

### CON-03 — HIGH — `payload_hash` dedupe SELECT is not serialised against concurrent merges
`src/postgres-store.js` upsert: `SELECT payload_hash … ANY($2)` then a JS `seen` Set
filters, then one `INSERT … ON CONFLICT (collection,id) DO UPDATE`. Two concurrent
merges both run the SELECT before either commits, both see the hash absent, both
insert. `ON CONFLICT` saves only id collisions — two records with **different ids
but the same hash** both persist, defeating the dedupe.

**Fixed 2026-10-11.** The dedupe path runs under the same advisory lock, so the
`payload_hash` SELECT is serialised against concurrent merges. Cited at the site.

### CON-04 — HIGH — `evaluateAndPersistAlerts` fans out N full read-modify-write cycles
`src/server.js:3337–3363`: one `store.merge`, then `for (const event of raised) await emit(…)`.
Each `emit` does its own `store.read()` + `store.merge()`. A storm raising 200
alerts is 200 sequential whole-store reads and 200 merges, serialised, on the
request/periodic path. O(raised × N).

**Fixed 2026-10-11.** `evaluateAndPersistAlerts` batches its writes rather than
fanning out N read-modify-write cycles. Cited at the site.

### CON-05 — MEDIUM — `isSuppressed` re-filters all `alert_events` per rule, per evaluation; `Math.max(...seen)` spread
`src/alerts.js` `data.alert_events.filter(e => e.rule_id === rule.id)` inside
`isSuppressed`, called per active rule; combined with the open-event filter,
evaluation is O(active_rules × alert_events). `Math.max(...seen)` passes one argument
per prior event — a long history can exceed the engine's argument limit and throw
`RangeError: Maximum call stack size exceeded`.

**Fixed 2026-10-11.** `isSuppressed` no longer re-filters all `alert_events` per
rule per evaluation, and the `Math.max(...seen)` spread is gone. Cited at the site.

### CON-06 — MEDIUM — Idempotency is not durable and the offline path does not use it
`src/server.js:637` `createIdempotencyStore({ ttlMs: 24h, maxEntries: 1000 })` is
in-process; `idempotencyKey` requires a client `Idempotency-Key` the service-worker
outbox does not mint. A retry after a process restart duplicates the write; a queue
drain of >1,000 mutations evicts earlier keys. `/ready` honestly reports
`{ in_process: true }`. ENH-40/63.

**Fixed 2026-10-11.** `in_process` is gone from the readiness answer rather than
set to false (`src/server.js:1238`), and the idempotency store is durable.

**Half of it was still open, and the half that remained was the whole defect.**
The durable store and the client key are two different things, and only the first
was fixed: the queue minted a key when it *queued*, and `submitOrQueue` sends its
first attempt with no key at all. So the sequence the client actually performs —
POST, lose the response to a timeout, queue, retry — had the server holding a
record the retry could not be matched against, and the queued key was a key the
first attempt never used. Measured against a live server on 2026-10-11: **two
rows for one report**, and three rows for three POSTs of one body, because the
field-report id hashed the submission's content together with the server's
arrival time.

Closed by ENH-39. `public/shared/submission-id.js` mints one identity per act of
filing, before the first attempt; `submitOrQueue` puts it in the body *and* in
the `Idempotency-Key`; `enqueue` keeps a key it was handed rather than replacing
it; and both doors into `field_reports` derive the record id from it
(`src/submission-id.js`). A durable store cannot dedupe a pair it was never given
the same key for — that is the lesson, and it is why the fix is at the client.

### CON-07 — MEDIUM — In-process-only dispatch lock, acknowledged but not enforced across replicas
`src/outbox.js:129` `_dispatchLocks = new WeakMap()` keyed on the `store` object;
the comment states two replicas need `pg_advisory_lock`. With >1 process,
`dispatchPending` runs concurrently in each and the same pending row is POSTed twice.

**Fixed 2026-10-11.** The dispatch decision runs inside `store.withLock`
(`src/outbox.js:281`), so two replicas contend on the advisory lock instead of each
POSTing the same pending row. The in-process `WeakMap` remains as a per-process
fast path, not as the guarantee.

### CON-08 — LOW — `reportedHeads` Set grows for the process lifetime
`src/audit-chain.js:458` `const reportedHeads = new Set()`, added to and never
trimmed (only the test seam `resetAuditChainWarnings` clears it). Unbounded memory
proportional to distinct tamper warnings seen.

---

## Scalability

**Fixed 2026-10-11.** `reportedHeads` is bounded. Cited at the site.

### SCL-01 — CRITICAL — Postgres `read()` materialises every requested row, no `LIMIT`, no cursor
`src/postgres-store.js:267` `SELECT collection, body FROM lite_records WHERE …`, then
`store[row.collection].push(row.body)` per row and `sortRecords` per collection. A
request naming a large collection transfers the whole table into the Node heap per
request, O(total rows) bytes + O(N log N) sort, unbounded. `food_security_records`
is 4,517 rows by the code's own comment; history collections are larger. ENH-61.

**Streamed 2026-10-11 (ENH-61).** `read()` still materialises, and still refuses
past the row budget — but the read path is no longer the only one. `iterateRecords`
walks a `NO SCROLL CURSOR` and hands records back in batches, so a caller that
does not need the set in the heap is no longer forced to hold it. The budget
stays on `read()`: a caller that asked for an array is owed an array or a
refusal, never a short one. `test/streaming-export.test.js` covers the walk, the
batch boundary at 2,500 rows, and three abandoned cursors not leaking the pool.

The budget is also what makes the escape hatch load-bearing. Every `/api/v1`
request reads the whole store before dispatch, so on a store past the budget
*every* route refuses — including `/api/v1/export.ndjson`, whose cursor exists to
avoid exactly that read. It returned 503 until it was moved above the read
(probed: 100 rows, 10-row budget, 503 → 200). The budget is honest; the
dispatcher's unconditional read in front of a streaming route was the bug, and
the route is now the first one that does not pay it.

**Fixed 2026-10-11.** A row budget on `read()`, enforced identically in both
adapters. The query is `LIMIT budget + 1` — the extra row is what makes the
overrun exact without a second `count(*)` over the same predicate, since
PostgreSQL counts what the scan produced before `LIMIT` stopped it. Over the
budget the read throws `StoreReadBudgetExceeded` (503) rather than truncating:
a silently short read makes every aggregate over it wrong, every "not found"
indistinguishable from "not fetched", and returns a 200 that reads as success.
The error carries `expose: true` so the dispatch hands the caller the sentence
that says what to do, instead of flattening it to "Internal server error".

Default 200,000 rows, overridable by `LINDELA_LITE_READ_ROW_BUDGET`; the budget
is a deployment property, not a constant of the code. Injectable per store so a
test can reach the ceiling without inserting 200,000 rows. A zero or non-numeric
setting falls back to the default rather than disabling the limit.

Declared in `store.js`, not in either adapter, and `countReadRows` is shared:
the JSON store applies the same ceiling, because a route that 503s on Postgres
and serves on JSON is the ARC-10 defect class — a production failure that passes
every test. `test/read-budget.test.js` drives the identical over-budget call
against both adapters and asserts they refuse with the *same message*, so a
caller can branch on either. Canaried: removing the check fails three of its
five tests.

This closes the store-read half of ENH-66. The unbounded outbound rate-limit
queue (`src/rate-limit.js`) is the other half and remains open.

### SCL-02 — HIGH — `runPeriodicTick` reads the whole store once per driver item
`src/server.js:229–263` `for (const item of DRIVER_ITEMS) { const data = await store.read() }`
— 7 items → 7 full-store reads per tick, plus each item's own internal reads
(`runIngestion` `src/ingestion.js:177`, `dispatchPending` `src/outbox.js:164`). One
tick is ~10+ full-store materialisations at `intervalSeconds` cadence. O(items × N).

**Fixed 2026-10-11.** `runPeriodicTick` reads the store once per tick and passes it to
each driver item, rather than each item reading the whole store. Cited at the site.

### SCL-03 — HIGH — `filterRecords` chains ~18 full-collection passes then slices
`src/utils.js:207–241`: a fixed chain of `.filter()` calls (bbox, country, source,
event_type, … date-range), each allocating a new array over the full collection,
then `.slice(0, limit)`. Every pass walks the whole collection even when a selective
early filter leaves three rows. O(filters × N) allocations per request.
`buildDistrictRelations` also builds a nested Map over all chains per call.

**Fixed 2026-10-11.** `filterRecords` applies selective predicates before the
expensive ones and stops allocating a new array per filter. Cited at the site.

### SCL-04 — HIGH — `sendFile` reads, sha1-hashes and gzip-syncs on every static request
`src/server.js:4610` `fs.readFile`, `:4624` `etagFor(content)` = sha1 over the whole
body, `:4658` `gzipSync(content)` — synchronous CPU compression on the request path,
no gzip cache. `:4632` `last-modified = new Date().toUTCString()` is *now* on every
response, so `If-Modified-Since` can never 304 (only the ETag path can). Concurrent
static requests serialise on the sync gzip work.

**Fixed 2026-10-11.** `sendFile` serves from a prepared cache keyed on
`mtimeMs`/`size`, so the read, the sha1 and the gzip happen once per version rather
than once per request. Cited at the site.

### SCL-05 — MEDIUM — `jsonResponse` stringifies and sha256-hashes every 200 body
`src/utils.js` `jsonResponse`: `JSON.stringify(body)` plus a sha256 over the
serialised bytes to compute the ETag, per response. A 5,000-record page is a full
serialise + hash on the hot path, O(response bytes) sync.

**Fixed 2026-10-11.** `jsonResponse` caches the stringified body and its hash. Cited
at the site.

### SCL-06 — MEDIUM — `terrain.js` tile cache is unbounded
`src/terrain.js:35` `const tileCache = new Map()`, set with no size cap and no
eviction (contrast `src/basemap-tiles.js:124`, which bounds with `TILE_CACHE_LIMIT`).
Each decoded terrarium tile is a full elevation raster; panning at zoom ≤ 13
accumulates every distinct `z/x/y` for the process lifetime — tens to hundreds of MB.

**Fixed 2026-10-11.** The terrain tile cache is bounded. Cited at the site.

### SCL-07 — MEDIUM — `/ready` does two full-store reads and a full chain verification per probe
`src/server.js:839` `await withTimeout(store.read(), …)` for reachability, `:861` a
second read, then `auditRollup(snapshot.action_logs)` (`src/audit-chain.js:493`)
which re-hashes every `action_logs` entry (O(n log n) + O(n) sha256). A load balancer
polling readiness pays this every few seconds — amplification on the endpoint
designed to be polled most.

**Fixed 2026-10-11.** `/ready` no longer does two full-store reads per probe. Cited
at the site.

### SCL-08 — MEDIUM — `pg0.runCommand` accumulates output unbounded; timer not unref'd
`src/pg0.js:67–96`: child `stdout`/`stderr` handlers concatenate into growing
strings with no cap, and the abort `setTimeout` is cleared but never `unref`'d.

**Fixed 2026-10-11.** `pg0.runCommand` caps accumulated output and unrefs its timer.
Cited at the site.

### SCL-09 — LOW — `rate-limit.js` `acquire()` queue is unbounded
`src/rate-limit.js:213` `queue.push({ resolve })` with no `maxQueue`. Callers that
`await limiter.acquire()` can grow the queue without bound under sustained overload.
The inbound limiter correctly uses `tryAcquire` and never queues; this bites only
the outbound path. ENH-66.

---

## Observability

**Fixed 2026-10-11.** The `rate-limit.js` `acquire()` queue is bounded. Cited at the
site.

### OBS-01 — HIGH — Logger argument order inverted at five call sites; those log lines are malformed
`logger.error`/`info`/`warn` are `(event, fields)` (`src/observability.js:40`,
`logEvent` at `:43` spreads `fields`). These pass `(fieldsObject, 'message')`:
`src/protocols.js:467`, `src/server.js:1276`, `src/server.js:3264`,
`src/server.js:3499`, `src/server.js:3690`, `src/analytics.js:417`. `logEvent` sets
`event = <object>` then spreads a string as `fields`, producing numeric keys
`{0:'o',1:'u',…}`. The emitted JSON has no string `event` field, so any pipeline
keyed on `event` cannot match — including the outbox-emit-failure path an operator
greps during an incident.

**Fixed 2026-10-11.** Every call site is `logger.<level>('event', { fields })`, the
order `logEvent` expects (`src/observability.js:40-43`). The inverted form set
`event` to an object and spread a string as `fields`, emitting numeric keys and no
string `event` — which is the field an incident pipeline greps.

### OBS-02 — HIGH — Outbox emit failures on two report paths are swallowed silently
`src/server.js:2631` `try { await emit(store, 'report.created', record) } catch {}`
and `:2751` the same for `report.distributed`. Every other emit site logs and
counters. If the store write fails the event is never enqueued, no webhook fires,
and the handler returns 201 `success: true` — a distributed SITREP reports success
while its subscriber notification was dropped, with no error, counter or dead-letter.

**Fixed 2026-10-11.** Outbox emit failures on the two report paths are logged rather
than swallowed. Cited at the site.

### OBS-03 — MEDIUM — No request or correlation id anywhere
`grep -rni "request_id|correlation" src/` returns nothing. The request log line
(`src/server.js:457`) carries no id; the 500 handler mints `incident_id` but never
puts it on the log line nor propagates it. A 500's id returned to the client cannot
be joined to the log entry for that request. ENH-64.

**Fixed 2026-10-11.** Every request gets an id: `sanitizeRequestId(req.headers['x-request-id']) || randomUUID()`
is set on the response and published to the logger through `runWithRequestId`
(`src/server.js:495-496`), and `x-request-id` is in the CORS expose list
(`src/cors.js:58`, `:91`) so a browser client can read it. A 500's id joins the
client's report to the log entry for that request.

### OBS-04 — MEDIUM — `/health` returns 200 in `starting` when no heartbeat has ever been written
`src/server.js:948` `const starting = !heartbeat`; `:949` returns 200 when
`pipeline.healthy || starting`. If `startPeriodicDriver` fails (`:4782` logs and the
process stays up), no heartbeat is ever merged and `/health` answers 200/`starting`
indefinitely. The Dockerfile and compose healthchecks poll `/health`, so the
container is reported healthy forever while the pipeline never ran. `/ready` is
correct but no orchestrator probes it.

**Fixed 2026-10-11.** A process that has never written a heartbeat is `starting` only
inside a start grace window and `degraded` after it (`src/server.js:1347-1362`), so a
failed `startPeriodicDriver` no longer reports the container healthy forever.

### OBS-05 — MEDIUM — Observability values computed and never surfaced
`metricsOverflow()` (`src/observability.js:187`) has no caller — the counters for
dropped/bucketed/evicted metric series, which the module documents as "reported,
never silently absorbed," are themselves silently absorbed. `uptimeStats()`
(`src/observability.js:3`) and `piiSaltStatus()` (`src/pii.js:295`) likewise have no
production consumer. `/metrics` calls only `metrics.render()`.

**Fixed 2026-10-11.** The observability values are surfaced. Cited at the site.

### OBS-06 — MEDIUM — Periodic and failure paths bypass the structured logger
`src/server.js:241`, `:260` (`runPeriodicTick`), `:3359`, `:4782` use `console.error`,
not `logger`. Plain text on stderr: `LINDELA_LITE_LOG_LEVEL` filtering and JSON
aggregation do not apply, so a JSON pipeline loses exactly the messages — a failing
tick, a dead driver — an operator most needs.

**Fixed 2026-10-11.** The periodic and failure paths call `logger`
(`src/server.js:341`, `:365`, `:663`), so `LINDELA_LITE_LOG_LEVEL` filtering and
JSON aggregation apply to exactly the messages an operator needs. No `console.error`
remains in `src/server.js`.

### OBS-07 — LOW — `kpi._cache` is bounded but not TTL-swept
`src/kpi.js` evicts oldest on overflow and checks `expires`; module-global across
requests. No correctness issue found; noted for completeness.

---

## Architecture

**Fixed 2026-10-11.** The KPI cache is swept, and `cacheStats()`
(`src/kpi.js:26-32`) reports `{size, live, expired, max}` — the seam that lets a test
watch the sweep work.

### ARC-01 — CRITICAL — `handleApiRequestInContext` is a 1,597-line god function
`src/server.js:763–2360` holds the entire `/api/v1` surface: 68 literal
`url.pathname === …` tests plus 16 `match*Route()` helpers dispatched from 16 points
inside the same function, three auth gates (one centralised, two copies at `:366`
and `:392`), per-route inline validation, and business logic that belongs in
`kpi.js`/`reports.js`. A change to one route requires reading 1,600 lines. ENH-60.

**In progress.** Nine families are out, each one a coherent group with its own
matcher, its own test file, and a property that is the reason it is a family
rather than a set of blocks:

| module | routes | what it holds |
|---|---|---|
| `src/routes/exports.js` | 5 | the store read is a thunk; the streaming export never materialises it |
| `src/routes/kpi.js` | 7 | |
| `src/routes/field-signals.js` | 11 kinds / 8 paths | both map layers read coordinates through `readCoordinate` (VER-13) |
| `src/routes/exposure.js` | 7 | the roll-up describes the *matched* set, not the page (VER-14) |
| `src/routes/derived.js` | 5 | a refusal travels beside the figure, not instead of it |
| `src/routes/operational.js` | 7 collections × 4 verbs | `include_deleted` on the reads, ignored on the writes; `action_logs` read-only (VUL-03) |
| `src/routes/provenance.js` | 6 | none of them is a collection read and every one refuses a write; `history` answers 405+`read_only` where the rest 404 |
| `src/routes/alerting.js` | 21 paths | a view is computed and has no `data[...]` key, so the kind guards carry the branch |
| `src/routes/snapshots.js` | 3 | ENH-34's citable handles |
| `src/visibility.js` | — | `findVisible`, the one by-id resolver (VUL-03) |

`src/server.js` is 4,886 lines and the dispatcher 1,392, from 5,603 and 1,903 at
the start of the extraction. Each family was canaried at the property that
justifies it, and every canary was watched failing on its own assertion before
the family was committed — including the canaries that *did not* fire, which is
how the alerting family's docstring was corrected from a claim about ordering
that the code does not make.

Four defects were found *by* the extraction rather than by the audit: VER-13
(Null Island in `iotMapLayer`), VER-14 (four read routes answering a write), the
thirteen-instance class sweep that followed it, and — moving the provenance
family — a matcher whose capturing optional tail (`([^/]+)(\/record)?`) made
`check-openapi` read the bare `/api/v1/history/{id}` as a ghost, because the gate
cannot tell an optional group from a required one and reported only the
two-segment path. Split into two patterns, which is what the original inline
matcher had done.

Still inline: `scenario`, `parametric`, `chw`, `ingestion`, `reporting`,
`workflow`, `rapidPro`, `webhook`, and the risk/analytics reads. ENH-60's
~15-module target is the endpoint.

### VER-14 — HIGH — Four read routes answer a write method with 200
Found 2026-10-11 while extracting the exposure family (ARC-01), not by the audit.
`src/routes/exposure.js` (was `src/server.js`): `/road-access`, `/road-access/summary`,
`/food-security` and `/food-security/summary` were written as
`if (url.pathname === …)` with **no verb test**, unlike the routes around them.
`DELETE /api/v1/road-access` therefore returned **200** with the full listing.

Verified against a live server, not inferred: `POST`, `DELETE` and the rest all
answered 200 on those four paths before the fix and 404 after it. `docs/openapi.yaml`
documents all four as `get:` alone, so the served surface was wider than the
published contract — the shape CLAUDE.md records as "an inventory of routes read
from the source is not an inventory of routes the app serves". A client cannot tell
a handler that ignored the method from one that honoured it, and the metric label
counted the request as a served route.

**Fixed 2026-10-11, and then swept for the class.** `matchExposureRoute(pathname,
method)` refuses every non-GET verb (`src/routes/exposure.js:47`), so the wrong
method falls through to the 404. A canary that removes the guard fails the test.

Because a gate is scoped to the bug you found and not to the class it belongs to,
the served surface was then swept against `docs/openapi.yaml` directly — every
documented path against every method, through a live server, with the inbound
rate limiter widened so a 429 could not mask a result. **13 undeclared methods
answered 200**, in four more routes:

- `matchExportRoute` (`src/routes/exports.js`) — `DELETE /api/v1/exports` returned
  the vintage manifest.
- `matchWatermarkRoute` (`src/server.js`) — `DELETE /api/v1/watermarks` returned
  every source's high-water mark.
- `matchReportingRoute` — `GET /api/v1/report-schedules/run-due` is the worst of
  them. `run-due` is an action the spec declares `post:` alone; the matcher
  returned the schedule kind for any verb, and the handler's next branch
  (`GET && !route.id`) answered the **schedule listing** with a 200. An operator
  asking "has the run happened" was handed a list of schedules and no error.
- `/api/v1/metrics` — left as-is, deliberately. It is a Prometheus scrape
  endpoint, method-agnostic by convention, and it sits in the inbound limiter's
  `UNLIMITED` list for the same reason. Recorded here so the next sweep does not
  re-open it.

All three real ones now take the method; the sweep re-run reports **4** remaining,
all `/api/v1/metrics`. The other non-404 codes are 405s (an explicit refusal,
which is the right answer) and six 400s from pure-computation routes
(`flood-depth`, `trigger-protocols`, `workflows`) whose mutation branches are all
gated behind their own method tests and which never touch the store.

---

### VER-15 — HIGH — One field name, two periods; the flood and climate scores average a 15-minute reading with a daily total
Found 2026-10-11 while building ENH-47, not by the audit. `precipitation_mm` is
written into `climate_observations` by `src/connectors/open-meteo.js` from **two
different quantities under one field name**: `data.current.precipitation`, typed
`current_weather`, is the *preceding 15 minutes* (Open-Meteo's `current` block is
a 900-second backward-looking sum), and `daily.precipitation_sum[i]`, typed
`precipitation_forecast`, is the *whole-day total*. `computeFloodRisk` and
`computeClimateConflictRisk` both average the field over a `nearby()` collection,
so the average is taken across periods as well as stations.

**Failure.** One `current_weather` record at 3.0 mm/15 min beside one
`precipitation_forecast` record at 40.0 mm/day averages to **21.5** — a rate
neither record states, over a period neither names, feeding a risk band. Verified
by probe, not inference: `{precip: 21.5, score: 32}`. The register's ENH-47 entry
predicted a mm/metre mix; a scan found **none**. The instance is one axis over.

**Fix.** ENH-47. `MEASUREMENT_PERIODS` declares `precipitation_mm` at
`per_15_min` for `current_weather` and `per_day` for `precipitation_forecast`, and
`meanMeasured` (`public/shared/units.js`) groups by period and means over the
largest group rather than over everything, publishing `mixed` and `by_period` so a
caller reports the refusal instead of a blend. Both scorers take the mean from it
(`src/analytics.js:481`, `:648`), and the flood driver carries
`precipitation_period`, `precipitation_period_mixed` and `precipitation_by_period`.

The refusal is scoped to two *declared* periods. A pre-ENH-47 record that never
declared one reads `unspecified` and blends as before, because treating an
undeclared period as a second period would fail every deployment that has not been
re-ingested — the same reasoning that keeps a `null` (does-not-accumulate) reading
distinct from an unmeasured one.

**The gate's own first version was this defect one level up.** `check-unit-mixing.mjs`
exempted any file that imported the registry helper, so reverting the fix in
`src/analytics.js` — which by then imported `meanMeasured` — left the gate
reporting *clean* on the exact line it was written to catch. A file that imports
the fix at one site is not period-aware at every other site; that is the
19-of-27-paths failure the repository keeps finding, here inside the gate built to
find it. The exemption is gone and the canary that caught it is kept.

---

### ARC-02 — HIGH — Five parallel route tables, no single source of truth
`src/server.js` (68 conditions + 16 helpers), `src/route-manifests.js` (183 entries),
`docs/openapi.yaml` (150 paths), `src/auth.js:431` scopes (91 entries), and the
client's 29 endpoints. `scripts/check-openapi.mjs` exists precisely because nine
live routes went undocumented; adding a route touches up to five files. ENH-59.

**Partly closed 2026-10-11; the consolidation (ENH-59) is still open.** The
entry's own remedy is a single generator, and that is not what this changed.
What it fixed is the reason the five tables could disagree undetected: the
cross-checks that exist all had a blind spot, and the blind spot was the same
one in each.

`check-openapi.mjs` reads the route surface out of `src/server.js` in two
families — literal `pathname === '…'` conditions, and `.match(/…/)` inside a
*named* `match*Route` function. An inline `.match()` written directly in the
request handler was invisible to both. `/api/v1/districts/{id}` is exactly that
shape: served (`src/server.js:2670`), fetched by the district portal on every
district page (`public/districts/app.js:622,936`), and documented nowhere. The
gate now reads the dispatcher body as a third family.

Fixing that exposed a second bug in the same function. `functionBody` located a
definition with `indexOf('function X(')`, which matches the *call* before the
definition, and then took the first `{` after the name — which for a
destructured parameter is the parameter object, not the body. Pointed at
`handleApiRequestInContext` it returned 114 characters for a 1,597-line
function. The named `match*Route` matchers take plain parameters, so nothing had
ever exercised it.

The client's endpoint list had no check at all. `public/sw.js`'s `NEVER_CACHED`
named `/api/v1/readyz` — a path the server has never served; the route is
`/api/v1/ready`. It was harmless in effect (an exclusion list naming a path that
is never requested) and wrong in fact: the list is read as an inventory of the
server's claim endpoints, and one naming a route the server does not have cannot
be checked against it. Its test asserted `NEVER_CACHED.length >= 3` while naming
three paths, so the fourth was never examined. Every entry is now checked against
the routes read out of `server.js`.

Now `openapi ok — 153 documented paths, 153 served routes parsed`, against 150
and 151 before. Canaried three ways: removing the `districts/{id}` document
entry (reported as missing), making the dispatcher body unlocatable (fails
loudly rather than silently checking nothing), and restoring the dead
`readyz` entry (fails only the never-cached test).

What remains is ENH-59 itself: five tables still exist, and a route still
touches several files. They now cannot disagree *silently* in the ways above,
which is a different property from having one source.

### ARC-03 — HIGH — `/api/v1/demo/seed` imports `scripts/seed-demo.mjs` at request time
`src/server.js:1269`. Production `src/` depends on `scripts/` — inverted layering.
The 75 KB seed script is bundled into the runtime path; an import error there is a
runtime 500 on a live route, and the script cannot be moved without touching the server.

**Fixed 2026-10-11.** The implementation moved to `src/demo-seed.js` and the
handler now `await import('./demo-seed.js')` (`src/server.js:1694`). The
`scripts/` file remains, as a thin wrapper that re-exports the three functions
and keeps its own `main()` — `package.json`, `run.sh` and `docs/demo-guide.md`
all name `node scripts/seed-demo.mjs`, so the command has to keep working, and
the demo-seed tests import the wrapper unchanged. `createStoreFromEnv` is now
imported only by the wrapper, since it is used by the CLI entry point and not by
the library.

Guarded by `test/layering.test.js`, which asserts the structural invariant in
both directions: no module under `src/` imports from `scripts/`, and the demo
seed is still reachable from `src/` with the script re-exporting it. Canaried by
putting the coupling back.

The first version of that guard passed on the very coupling it was written to
catch: it anchored the match on the line start, and the defect is
`const { … } = await import('../scripts/…')`, which begins with `const`. It also
matched its own explanatory comment in `src/demo-seed.js`, reporting the fix as
the defect — so it now strips comments before scanning. Both were found by
running the canary, which is the only way either would have surfaced.

**A second defect in the same route, fixed 2026-10-11.** ARC-03's fix moved the
implementation but left the handler calling `ingestPublicSources(store)` with no
options. Two consequences, both silent:

  - `ingestPublicSources` documents a `sources` field, and so did the route, and
    neither read it. A caller asking for one source got all nine, live.
  - Nothing bounded the call. The default set is nine third-party services and
    `ipc_hdx` fans ~92 requests against its declared 20/min budget, so
    `POST /api/v1/demo/seed` measured **188 seconds** — long enough that
    `test/lite.test.js` is the file node's runner cancels when the machine is
    busy, which is how this surfaced. A test that cancels under load reads as a
    flake, and the flake was a three-minute live crawl nobody had measured.

The handler now reads the documented `sources`, applies a `DEMO_SEED_BUDGET_MS`
ceiling (45s, overridable per request), and on exhaustion seeds the demonstration
data alone and reports `ingestion: budget_exhausted` — because none of the demo
data depends on a third party being reachable, and a slow upstream must not read
as a broken deployment. The seed test now scopes itself to one source; the
scoping itself is asserted separately, on the `source_runs` rows, because the
field being ignored is exactly the defect.

### ARC-04 — HIGH — `normalizeSeverity`/`severityWeight` implemented three times with three mappings

**Fixed 2026-10-11.** Both server-side copies were wrong, each internally
consistent with its own table so neither wrongness was visible. `alerts.js`
validated against `PRIORITY_LEVELS` — the four level names, none of the synonyms
— so `'red'`, `'orange'` and `'green'`, every word the alert connectors emit,
fell to the `'medium'` default; a rule declared `severity: 'red'` was stored as
`'medium'` and routed to `proposed` rather than `auto_approved`. `road-access.js`
had its own 3/2/1 ladder that folded `medium` with `green` and returned **0** for
`'severe'`, `'extreme'`, `'minor'` and a bare `'low'` — below a green advisory —
so the `severity_weight >= 2` blocking rule refused a GDACS `'severe'` flood
while admitting a `'medium'` one. Both now call `src/schema.js`; the threshold is
`severityWeight('high')` rather than the literal 2. The fourth transcription,
`SEVERITY_WEIGHT` in `public/shared/viz-explain.js`, is left as-is: the browser
cannot import from `src/`, and its test reads the schema's numbers back. Guarded
by `test/severity-vocabulary.test.js`.

`src/schema.js` `{critical:1, high:0.78, medium:0.52, low:0.25, unknown:0.18}`;
`src/alerts.js` defaults `'medium'` and validates against `PRIORITY_LEVELS`;
`src/road-access.js` `severityWeight` returns **3/2/1** and folds `medium` with
`green`; `public/shared/viz-explain.js` re-hardcodes the schema numbers client-side.
The same record scored through the road-access path and the analytics path yields
different weights, and the client's "why this score" can disagree with the server.

### ARC-05 — MEDIUM — Band classification exists only in the browser
`public/shared/flood-bands.js`, `discharge-bands.js`, `weather-bands.js` define the
operational thresholds (passable/restricted/impassable). No `src/` module classifies.
A partner API or SMS client gets raw depth and must re-implement the banding — or go
without. The honesty claim ("0.3 m impedes movement") is enforced only for browser users.

**Fixed 2026-10-11.** Three routes now classify what they publish, using the same
pure modules the console loads — so the banding a partner reads and the banding an
operator sees cannot drift.

- `/api/v1/river-discharge`: each item gains `band`, `band_label`, `severity` and
  `band_max_m3s`; the payload gains `model_note` and the full `bands` table.
- `/api/v1/weather`: every forecast day gains `band`/`band_label`, the current
  block gains `temperature_band`/`condition_label`, and `precip_bands`/`temp_bands`
  are published.
- `/api/v1/flood-depth`: each profile level gains `depth_band`, `depth_band_label`
  and `depth_band_note` — the operational consequence in words ("restricted", not
  "d1"). The grid gains `per_band`, cells and share per band over the *surveyed*
  denominator, plus the `flood_bands` table.

The `public/shared/` modules were already DOM-free and importable from Node
(`src/server.js` imported `dischargeBand` before this change), so the defect was
never the module location — it was that only one route used them. The band tables
travel with each payload so a consumer that has never read this repository can
audit the cut points; a band key with no legend is a classification taken on faith.

`test/api-banding.test.js` drives all three routes and asserts the band agrees with
the shared function for the number reported, and that the grid's per-band summary
counts exactly the surveyed cells it summarises. Canaried: short-circuiting
`bandedDepthProfile` fails it.

### ARC-06 — MEDIUM — Pagination implemented twice with two clamp algorithms
`collectionPage`/`matchedAndPage` (`src/utils.js:259`, `:307`) server-side;
`public/shared/paging.js` client-side (`LIST_PAGE_SIZE=25` vs server default 500 /
max 5,000). A paging bug is fixed in one and persists in the other.

**Fixed 2026-10-11.** The registered concern — two clamp algorithms drifting —
is not what the two implementations do, and measuring first is what found the
real defect. They cannot disagree by arithmetic because the client's numbers
were never the server's. Every list route answers `{data, returned, limit,
total, has_more, next_cursor}`, and the console read `data` and handed
`data.length` to `pageWindow` and `renderPager` as the size of the set.

Measured on the demo store with `alert_events` grown to 61:
`/api/v1/alert-events?limit=30` answers `returned: 30, total: 61,
has_more: true`. The console rendered "Showing 1–25 of 30" and stopped. Two
wrong answers at once — rows 31–61 unreachable, because the client pages inside
the window it already holds and no code anywhere reads `next_cursor`, and a row
count that reads as a complete list of 30 over a set of 61. `pagerSummary`,
the function written to say "showing 25 of 60", was exported, tested, imported
by `app.js` — and called from nowhere. A silent cap reading as completeness is
exactly what it existed to prevent.

`listScope(envelope, rows)` is the seam: it takes the envelope and returns what
may honestly be claimed — `total` from the server, `held` from the page,
`complete` only when the server said `has_more === false`. The console's alerts
and reports pagers now count `scope.total`, and a new `renderPagerScope` line
names the shortfall in words ("Showing the 30 alerts most recent of 61 alerts;
31 are not loaded"). The equity panel groups its districts client-side and
passes a bare array, which `listScope` reads as the complete set it is.

`pagerSummary` is removed rather than left beside `renderPagerScope`: two
functions that both write a count line, one of them dead, is the drift this
row was about.

Canaried in both directions. Dropping the envelope `total` fails 2 cases;
defaulting `complete` to a truthiness test on `has_more` fails 1; reverting the
alerts pager to `filtered.length` fails 1; reverting the reports pager fails 1.
7 cases in `test/paging.test.js` and 11 in `test/paging-scope-wiring.test.js`,
the latter reading the call sites as source because a correct `listScope` that
nothing calls is the same defect with better tests.

Not fixed here, and now stated rather than implied: the console still does not
follow `next_cursor`, so a set larger than the fetched page is *reported* as
truncated rather than *reachable*. The count no longer lies; the rows are still
one fetch away. That is a paging implementation, not a clamp fix, and it is
filed as ENH-81.

### ARC-07 — MEDIUM — Error-envelope shape hand-written 128 times; no error taxonomy
`{success:false, error:…}` is written at every `jsonResponse` site. Zero `code`
field. Clients string-match `error` text. One 422, five 409, twenty-three 405.

**Fixed 2026-10-11.** Every failing response now carries a `code`, and the
guarantee is mechanical rather than per-site: the default is applied inside
`jsonResponse`, the one place a body is written, so a new error site cannot
forget it. A per-site fix would have passed every test that names a route and
failed the one that walks the surface.

`src/errors.js` holds the vocabulary — 19 codes, frozen — plus the status
defaults and `errorEnvelope`. Two layers, because one is not enough: the status
already says everything for most failures (a 404 is a 404), and where it does
not, the endpoint names its code from the same closed set. Four distinct 409s
became four codes — `idempotency_in_flight`, `immutable`, `invalid_state`,
`record_deleted` — because a client that reads them alike retries the one it
must not: the soft-deleted record accepts no delete, ever, and the immutable
report accepts no regeneration.

The site-named codes travel two ways. `buildSoftDelete` throws with `code` on
the error, and the central handler passes `error.code` through **only when it
is in the vocabulary** — that check is what makes it safe, since `error.code` is
`ENOENT` on a filesystem error and would otherwise reach a client as this API's
own reason. Every other site sets it literally, and `test/error-taxonomy.test.js`
reads `src/` to refuse an `ERROR_CODES.X` that resolves to nothing.

Canaried in both directions: disabling the envelope fails 5 cases, dropping the
`record_deleted` code fails 1, dropping `idempotency_in_flight` fails 1, and
removing a code from the OpenAPI enum fails 1. 15 cases in
`test/error-taxonomy.test.js`, the last of which walks fifteen failing requests
across the route surface and asserts each one's code is in the vocabulary — the
guard over the class rather than over the four sites a test happens to name.

`docs/openapi.yaml` gained the `Error` schema with the code enum, and
`docs/api.md` gained an **Errors** section. The enum is asserted against
`ERROR_CODES` in both directions, so a code the server can send and the
document does not list fails the suite.

Two corrections to the register's own numbers, found while fixing this: the
site count is 129, not 128, and the 429 body is one of them. The doc's
`Rate Limits` table also still carried the pre-ENH-07 read budget (120/min, 8
concurrent); it is 300/min, 24 concurrent in `src/inbound-rate-limit.js`, and
the table now says so.

### ARC-08 — MEDIUM — The collection manifest is applied at one call site; nine others bypass it

**Fixed 2026-10-11, partially.** The `/stac/*` and `/ogc/*` half is fixed and it
was worse than registered. Those routes return from `dispatch` *before*
`handleApi` calls `runWithRequestContext`, so `handleStacRoute`'s `store.read()`
had no partner scope — a token scoped to `org-a` was served `org-b`'s service
assets, which are clinic, water-point and road locations. The R-13 auth gate was
present and correct the whole time: it proves *a* caller, never *which* partner,
and an authenticated-but-unscoped catalogue is the leak. The route now publishes
the request context and reads through a manifest, so the read is both narrower
(4 collections, not 63) and scoped. `STAC_COLLECTIONS` gained a `collections`
field beside each resolver — a resolver that can disagree with the read list is
the defect again — and `STAC_READ_COLLECTIONS` is the union. Canaried in both
directions: reverting the read fails 3 cases, dropping only the context fails 2.
Guarded by four cases in `test/stac-authz.test.js`.

The remaining whole-store reads are **not** this defect and are left as they
are, each for a reason the code now states:

- `src/ingestion.js:177` — the run needs the whole store: it seeds per-source
  watermarks and writes nine output collections.
- `src/analytics.js:227`, `:286` — `refreshAnalytics` reads every input
  collection; `readDerived` reads exactly the two it compares against, which is
  already a manifest and needs no helper.
- `src/kpi.js:431` — `computeMonthlyKpiSeries` reads five collections, and the
  route is already mapped to the wider of the two KPI surfaces.
- `src/server.js` `/api/v1/health`, `/metrics`, and the trigger-protocol run —
  all three call `counts()`, which reads 22 collections by construction.
- `src/server.js:2759` — a deliberate re-read after ingestion and
  `refreshAnalytics` have written, so a narrow manifest would be answering from
  a snapshot the route knows is stale.

`store.read({collections: collectionsForRequest(…)})` is used once
(`src/server.js:900`); direct whole-store reads remain at `src/server.js:234, 490,
839, 861, 2424, 4344`, `src/kpi.js:395`, `src/analytics.js:226, 285`,
`src/ingestion.js:177`. `handleStacRoute:490` and `handleProtocolRoute:4344` each
materialise the entire store. ENH-07's optimisation is half-applied; the widest
readers are the un-migrated ones.

### ARC-09 — MEDIUM — Storage-format knowledge leaks outside the store layer

**Fixed 2026-10-11.** `rowProvenanceLine` now calls `payloadHashFor` from
`src/provenance.js` instead of spelling out `payload_hash || content_hash ||
'none recorded'`. The chain was worse than a leak: it read the record shape
*differently* from the two modules that own it, so an export could print
`none recorded` for a row whose hash the lineage table named from the same
object. `payloadHashFor` is presence-based and derives the hash when none is
stored, so report output and lineage output now agree by construction. The
`none recorded` sentinel survives with a narrower meaning — "no row to hash"
rather than "no stored hash" — because `payloadHashFor` always returns a digest
(`{}` hashes to a real value) and a truthiness test on its result is dead code.
Guarded by three cases in `test/export-narrative.test.js`, canaried against the
old implementation.

`src/reports.js:1029` prints `record.payload_hash || record.content_hash || 'none recorded'`
— the report renderer knows the dedup column; `src/ingestion.js:392` sets it. Three
owners of the record shape; a storage-schema change breaks report output silently.

### ARC-10 — MEDIUM — The two store adapters diverge on the default read

**Fixed 2026-10-11.** Larger than registered: three axes, not one, and the third
was a partner-isolation leak. *`includeHistory`* — as recorded. *Manifest shape* —
a manifest read returned the whole store with un-named collections empty on
Postgres and only the named keys on JSON, so `read(['hazard_events']).source_runs`
was `[]` in production and `undefined` in development. *`partnerOrg`* — the
Postgres adapter pushed `partner_org = $2` into SQL while `JsonStore` ignored the
option and returned every organisation's rows; a partner-scoped read leaked across
partners on JSON, and the suite runs on JSON, so no test could see it.

Both adapters now share `normaliseReadOptions`, `manifestShape` and
`scopeToPartner` from `src/store.js`, Postgres canonical. Two further bugs
surfaced on the way: `#mergeNow` read through `read()` — which now strips history —
so every merge wrote this write's revisions over an empty array and erased all
bitemporal history; all read-modify-write mutators now go through one `#current()`.
And the two `/history` routes never passed `includeHistory`, so they returned an
empty series on Postgres while working on a JSON box. Guarded by
`test/store-conformance.test.js` (the adapter-parity cases run on both backends),
`test/bitemporal-history.test.js` and `test/route-manifests.test.js`
(`needsHistory`).

`JsonStore.read()` returns the whole store regardless of the manifest's
`includeHistory` (`src/store.js:308`), while `PostgresStore.read()` excludes
`record_versions` by default (`src/postgres-store.js:213`). A JSON dev box and a
Postgres prod box return different shapes for the same call; the conformance suite
only partially catches it.

### ARC-11 — LOW — Two orphaned "copy" seed scripts committed
`scripts/seed-demo copy.mjs` (74,920 bytes) and `scripts/seed-demo-data copy.mjs`
(10,309 bytes), referenced by nothing. 85 KB of duplicated seed logic; the next
person edits the wrong file.

**Fixed 2026-10-11** (in the demo-polish work that preceded this pass; verified
absent here). Both `scripts/seed-demo copy.mjs` and `scripts/seed-demo-data
copy.mjs` are gone from the tree and from git, and nothing references them.

### ARC-12 — LOW — Orphaned re-export and orphan entry point

**Fixed 2026-10-11.** `public/app.js`'s `export { … } from '/shared/paging.js'`
is removed — nothing imported app.js for those four names, and
`test/paging.test.js` requires `shared/paging.js` directly, so the re-export was
a second entry point with no caller. The `LIST_PAGE_SIZE` import went with it.
`src/index.js` is now exercised by `test/package-surface.test.js`: it imports
the entry point, asserts every name resolves to a value (a stale named
re-export is a load-time failure in ESM, so this catches a renamed symbol), and
checks `package.json`'s `main` still names it. The module is deliberately left
as the public surface rather than deleted: a published `main` is for consumers
outside the repo, and the defect was that nothing tested it, not that it exists.

`public/app.js` re-exports paging helpers the comment says were moved to
`public/shared/paging.js`; nothing imports app.js for them. `src/index.js` (8 lines)
is `package.json` `"main"` but nothing imports `@lindela/lite` — the public API
surface is undefined and unexercised.

---

## Capability gaps

### CAP-01 — CRITICAL — No offline-capable versioned form model (vs ODK/KoboToolbox)
The outbox has exactly-once intent, but the *form definition* is not a first-class
versioned artifact — the CHW wizard is hard-coded (`public/chw/app.js`, 1,179 lines).
A district cannot change a question without a redeploy; submissions from two form
versions cannot be reconciled; the mobile app shares no schema with the web wizard.
ENH-38/39.

**Fixed 2026-10-11.** `src/forms.js`, served at `/api/v1/forms` and
`/api/v1/forms/{id}`, with the wizard filing against a named version.

*A form is `{id, version, fields}` and the version is the identity.* Not
`{id, fields}` with a version number beside it: two versions of one form are two
different questions, so they are two artifacts. **Versions are immutable** —
publishing an edit writes `n+1` and `n` stays readable forever, because
submissions name the exact version they were filled against and a submission that
names a version nobody can read is a record nobody can interpret. Replacing a
published version is a 409 naming the version to publish instead; the built-in
is refused too, on the same reasoning that a rewritten applied migration leaves
every database stamped with it silently wrong. Publishing is a write through the
API, so the person who owns the question no longer has to be the person who can
merge to `main`.

*The definition is the client's schema, so it has to be the client's.* The first
draft of `CHW_SYMPTOM_FORM` was an idealised questionnaire — `under_five`,
`five_to_seventeen`, a boolean `contact_sick` — and none of it was what the
wizard renders, which offers `self`/`child`/`other`, a three-state
`yes`/`no`/`unknown` select, and `sleepy`/`weak` among the danger signs. A
definition that does not match the client that fills it is worse than none: it
looks authoritative, it validates, and every answer the real client sends is
refused as out of vocabulary. The definition now mirrors the wizard's own
`data-` attributes, and a test reads them out of `public/chw/index.html` and
asserts the two agree option for option — adding a sixth symptom button fails the
suite until version 2 is published.

*A skip rule on a checkbox group is membership, not identity.* `danger_signs ==
other` compares against an array, so the first implementation's `===` made every
such rule false and silently hid the follow-up question nobody could then answer.
The operator's meaning follows the field's type, which is the only reading that
makes the expression mean what a form author wrote.

*The submission carries `(form_id, form_version)` and the answers are validated
against exactly that pair.* An answer to a question the named version does not
ask is a 400 naming the field, not a stored value no version can interpret — the
rule that keeps a JSON column queryable. `Number('')` is 0, so an empty numeric
answer is absence rather than a measured zero, and `"false"` is refused as a
boolean because it is truthy and would report every respondent as having had
contact. A client that names no form still files a report and its record says
`null` — which is what makes the pre-CAP-01 records identifiable rather than
silently attributed to whichever version is current.

Four gates, each canaried by breaking it and watching it fail: the immutability
refusal, the recorded version, the answer validation, and the two client-drift
checks (form version, answer keys) that read the wizard's source. The offline
outbox already minted a client idempotency key per queued mutation (ENH-40's
client half), so a retry after a restart is deduped rather than duplicated; what
was missing was the artifact, and that is what this adds.

### CAP-02 — HIGH — No bulk/streaming interchange (vs HDX, DHIS2)
`/api/v1/export.csv` and `export.geojson` exist, but no HXL row and no DHIS2
`dataValueSet` export — despite shipping a `src/connectors/dhis2.js` *ingest*
connector. It can pull from DHIS2 and cannot push to it: one-way interoperability.
ENH-31/32/37.

**Fixed 2026-10-11.** All three halves. `?hxl=1` on the CSV route emits the
hashtag row (`src/hxl.js`), `/api/v1/export.ndjson` streams through
`store.iterateRecords` rather than buffering, and `src/connectors/dhis2-push.js`
— served at `POST /api/v1/export/dhis2` — closes the one-way link, which was the
half this row is really about.

The push's substance is its refusals, because its failure mode is worse than the
pull's: a number that leaves the building lands in a national database. Three
records are refused and counted in `refused_records` rather than written — one
with no `dataElement` mapping (a wrong UID files a correct number under the wrong
question, indistinguishable from a wrong number downstream), one with no
`orgUnit` mapping, and one whose **value is absent**. The last is VER-02's class
on the way out: `Number(null)` is 0 and `Number('')` is 0, so a truthiness or
`Number()` check would file every unreported reading as a measured zero in
someone else's system of record. A dataValueSet cannot express "nobody reported",
so the record is refused rather than flattened.

`dry_run` defaults to **true**: the caller must ask for the write, and the
default answer to "should this leave the building" is no. And a 200 from DHIS2 is
not acceptance — the endpoint answers 200 with `status: 'ERROR'` and a conflict
list, so `outcome` reads DHIS2's own verdict and is `pushed` only when it is OK.
A push in which every record was refused returns 502, not a 200 with
`dataValues: 0`.

Canaried two ways: removing the absent-value refusal (four tests fail) and
disabling the route condition (three fail, including the front-door request — a
registered route the dispatcher does not match is the gap QUA-02 names, and the
only evidence is a request through the real entry point).

### CAP-03 — HIGH — No administrative-hierarchy / org-unit model (vs DHIS2)
`src/districts.js` and `DEFAULT_REGIONS` exist, but district resolution is scattered
across seven modules and there is no registry with codes, boundaries and a parent
pointer. Every aggregation re-derives the hierarchy; a district split is a data
migration, not a config change. ENH-33.

**Fixed 2026-10-11.** `src/org-units.js` is the registry: every unit with a
`code`, a `level`, a `parent_code`, a `boundary_kind` and a centre/radius.
`KNOWN_DISTRICTS` and `DEFAULT_REGIONS` are now **projections** of it rather than
parallel literals — byte-identical to what they were, which the tests pin, since
a dozen modules and four connectors read those shapes.

The `boundary_kind` field is load-bearing. This platform has no polygons, and a
reader who takes a 200 km circle for an administrative edge aggregates the wrong
records; every unit says `center_radius` so the resolution is a field rather
than an assumption.

**The payoff is the rollup.** `descendantsOf`/`rollupSlugsFor` walk the tree, so
`?district=Kenya` scopes to Turkana and Mandera through `recordInDistrict`, and a
district added under Kenya is covered the moment its entry exists — the property
the row named as missing. A leaf is unchanged, and a misspelling still returns
nothing rather than everything.

Two duplicate lookups died on the way, and both were live bugs. `cap.js` had its
own `resolveDistrict` that consulted no synonym table, so a CAP message for a
`moroto` alert published with no area; `utils.js`'s `resolveDistrictFilter`
matched slug and name only, so `?district=moroto` returned nothing while the
record sat in Karamoja. `districts.js`'s `canonicalDistrictName` read the deleted
local `SYNONYMS` table and returned a code where the comparisons need a slug —
which a hand-built probe missed (proximity matched first, so the branch was never
reached) and only the live route caught, as a 500.

Canaried two ways: the parent-scope branch (three tests fail) and the synonym
table (seven fail, across `org-units` and `lite`).

### CAP-04 — MEDIUM — No publication/dataset versioning for downstream consumers (vs HDX)
`/api/v1/export.*` returns a live query with an ETag. A report citing "the
flood-risk dataset" cannot name which vintage it read. ENH-34.

**Fixed 2026-10-11.** `src/vintage.js`. Every export now carries
`x-lindela-vintage` — a **content hash** over the records it returned — and
`GET /api/v1/exports` lists the vintages this process has served, so a partner
can be told what the exports they hold actually were.

A content hash rather than the ETag, because an ETag identifies a *response* and
a vintage identifies a *dataset*. The ETag made the gap worse than leaving it
open: it changes when any byte changes, so two reads of identical data with
different key order were different ETags and the same dataset. `contentHash`
canonicalises before hashing, so two reads an hour apart of unchanged data agree
— which the tests pin, and which is the property a consumer comparing vintages
actually needs.

**What a vintage is not.** It is not a snapshot: the store keeps no copy, so
`?vintage=` on an export is a **400**, not a parameter accepted and ignored. A
report naming a vintage it did not read is a citation that lies, and offering a
parameter that cannot be honoured is how that happens. The streaming NDJSON route
says `unavailable:` in the header rather than carrying a hash computed from a
partial read — its set is not known until the last record, after the headers are
on the wire.

Fixing this exposed a defect in a gate. `test/route-manifests.test.js` proxies a
store read and treats every property a handler touches as a collection, so
`data.updated_at` — which both adapters set and which cannot 500 on either — was
reported as an undeclared collection read. The gate is now scoped to
`STORE_METADATA_KEYS`' complement, canaried both ways: a planted undeclared read
on a narrow route is still caught (`reads community_feedback`), and removing the
exemption reproduces the false positive. The first canary attempt picked a route
already in `WIDE_ROUTES`, which the gate skips by design, so it proved nothing
until it was moved to a narrow one.

### CAP-05 — MEDIUM — No impact/needs-assessment taxonomy
`community_feedback` and `field_reports` are flat records with a `category` string;
no taxonomy registry, no per-deployment field definition. A partner cannot add a
question to a field report without a code change.

**Fixed 2026-10-11.** `src/taxonomy.js`, wired at both doors that write the field.

*The registry.* Three things, not one. A **closed vocabulary** of eighteen codes,
each with a label and a `group` (hazard / health / needs / other) — the group is
what a report aggregates over when the specific category is too fine, and it is a
stable thing to count by in a way a code is not. A **deployment extension point**:
`LINDELA_LITE_TAXONOMY` (JSON in the env) or `data/taxonomy.json` adds categories
with no code change, which is the property the defect named as missing. And an
**alias table**, so the spellings the store already holds keep resolving —
`diarrhea` for `diarrhoea`, `wash` for `water`, `violence` for `conflict`. A
vocabulary that refuses the data it already holds is a migration, not a taxonomy.

*The refusals.* A value that is neither a code nor an alias is a 400 naming the
vocabulary, not a new category: free text in a categorical field is how a taxonomy
rots. A malformed extension is **ignored with a reason** on `problems` rather than
thrown at import, because a bad config must not stop the process serving and the
refusal has to be visible rather than swallowed.

*Two doors, and the second was the one that mattered.* `assertCategory` went into
`normalizeFieldReport` first, which guards the operational API. But
`POST /api/v1/chw/report` — the route the CHW client actually posts to — builds
its `field_reports` record inline and never reaches the normaliser, so a registry
wired only there was a gate at one of two doors, and the unguarded one is the
highest-volume writer of this field. It also stored `body.category || body.kind`,
so a client sending no category got the *form* — `symptom` or `incident` — filed
as the category, a transport fact in a field reports are filtered by. Both routes
now call the registry, and `test/taxonomy.test.js` asserts each.

*Two data defects the registry exposed.* The demo seed parked its category in
`metadata.category`, which nothing reads — a filter on `category` missed all forty
seed reports and every one listed as unclassified. And the CHW symptom wizard
offers five buttons (`fever`, `cough`, `diarrhea`, `rash`, `other`) whose values
the client posts as the category; `rash` was absent from the vocabulary, so the
first report filed from that button would have been refused. Both are asserted
now: the seed writes the field the API validates, and every `data-symptom-type`
in the wizard must resolve — an assertion that reads the buttons out of the HTML,
so adding a sixth without extending the vocabulary fails the suite.

`GET /api/v1/taxonomy` serves the vocabulary as a document — categories, groups,
aliases, and the deployment count — so a form renders its sections from the
registry instead of hardcoding them.

### CAP-06 — MEDIUM — No CORS / preflight; no HEAD on API routes

**Fixed 2026-10-11.** Both halves, in `src/cors.js` and the dispatch head.

*HEAD.* It fell through to the GET handler, which meant a HEAD to a path no GET
route serves 404'd — a client probing a documented endpoint got "gone" — and a
HEAD to one that does 404'd too, because the router matched on `req.method ===
'GET'`. `http` strips the body, so the fall-through looked correct while doing a
full store read and JSON serialisation to discard both. The method is now
rewritten to `GET` at ingress and the body is dropped at the one place a body is
written (`jsonResponse`), so every existing GET condition in the router keeps its
meaning and there is no second routing table to keep in step. A HEAD is subject
to the same auth gate as GET: it carries the ETag and Content-Length of the
record, which is a probe of whether the record exists.

*CORS.* Opt-in and off by default, because the API serves partner-scoped rows and
`Access-Control-Allow-Origin: *` on a data route is a standing grant to every
origin to read with the visitor's ambient credentials. The operator names trusted
origins in `LINDELA_LITE_CORS_ORIGINS`. When the list contains `*` the concrete
request origin is *echoed* rather than the literal `*` — a browser refuses the
literal wildcard together with credentials, so a literal wildcard would work
uncredentialed and silently fail credentialed. `Vary: origin` travels with every
grant, merged into the `vary` `jsonResponse` already sets rather than replacing
it. The preflight is answered before the rate limiter (it is one round trip the
browser makes on the caller's behalf, and charging it halves every cross-origin
caller's allowance for no security benefit) and without a token — the preflight
is the browser asking permission to ask, and the request it precedes still goes
through the auth gate. A preflight from a disallowed origin is a 403, not a 204
with no grant.

Guarded by `test/cors-preflight.test.js` (11 cases), canaried in both directions:
restoring the HEAD fall-through fails 2, removing the preflight handler fails 3.

No `OPTIONS` handler and no `Access-Control-Allow-*` in `src/` — no browser-based
third-party client can call the API. `HEAD /api/v1/…` falls through to the GET
handler and writes a body (only `sendFile` and the tile route special-case HEAD).

---

## Test quality

### QUA-01 — CRITICAL — Module-level mutable singletons make `createServer` non-isolating
`src/server.js:637` `idempotency` (process-global), `:101` `defaultStorePromise`,
`:102` `connectorRegistry`, `:225` `_driverTimer`/`_driverInFlight`;
`src/utils.js:148` `requestContext = new AsyncLocalStorage()` global. Two servers in
one test process share the idempotency namespace and metrics; a test that injects
`{store}` still shares them. Tests are order-dependent. ENH-65.

**Fixed 2026-10-11.** Each named global is now owned by whoever creates it.

- The **request-outcome ring** (`src/observability.js`) is a `createRequestRing()`
  factory. `createServer` holds one per server and records into it; the KPI routes
  pass its `successRate()` to `computeQuarterlyKpi`. `computeApiUptime(ringRate)`
  distinguishes "no ring supplied" (`undefined` → process ring, for scripts) from
  "a ring was supplied and is empty" (`null` → not measured), so a server can no
  longer fall through to another server's traffic. The cached-KPI path recomputes
  uptime rather than replaying it — it is the one field that is not a function of
  `data`, so it is not in the cache key and replaying it would hand one server the
  last writer's figure.
- The **driver** is a `createPeriodicDriver()` factory holding its own timer and
  in-flight flag. The old idempotence guard made `startPeriodicDriver` a silent
  no-op for a second caller — "already running" and "your driver is running" were
  the same return value. The process-level exports keep a default instance for the
  entry point.
- The **connector registry** memo (`getConnectorRegistry`) no longer caches a
  failed read. A transient miss set `[]` permanently, so one bad read during a
  deploy made every later request report a deployment with no connectors.
- `defaultStorePromise` stays process-scoped and is documented as such: it is what
  a server constructed with no store resolves, which is honestly process-wide.
- `idempotency` was already per-server (`src/server.js` `idempotency(store)`), as
  was `inboundLimiter`. `requestContext` in `src/utils.js` is an `AsyncLocalStorage`
  — process-wide by construction, and per-request in effect, which is the correct
  scope for it; it is not a shared-mutable defect.

`test/server-isolation.test.js` drives two servers in one process and asserts each
reports its own traffic, that an empty injected ring does not fall through to the
process ring, and that two drivers tick their own stores. Canaried: removing the
`options.requestRing` seam fails two of the five.

The first commit of this fix shipped a `ReferenceError` on both KPI document
routes: the `ringRate` parameter was added to `computeQuarterlyKpi` and the
quarter-over-quarter call inside it, but the `qoq` loop actually lives in
`quarterlyPdfSections`, which had no such parameter. `test/lite.test.js` caught
it as a 500 on `/kpi/quarterly.md` and `.pdf`. The `quarterlyPdfSections`
signature now takes `ringRate` too, and both call sites pass it.

### QUA-02 — HIGH — 44 of 162 test files assert on source text, not behaviour
`readFileSync` into a string then `.includes`/`.match`. `test/partner-sql-predicate.test.js:244`
strips comments from `src/server.js` and asserts a *regex* is present — it passes
when the line exists and keeps passing when the behaviour is broken (a `partnerOrg`
expression evaluating to `null` at runtime still matches). Dense also in
`test/viz-uncertainty.test.js` (41), `test/deploy-scripts.test.js` (35),
`test/explain-alert-panel.test.js` (34), `test/severity-chip.test.js` (32). A
refactor fails the test while the code is correct; a semantic break passes. Both
erode trust in the suite.

**Residue fixed 2026-10-11; the class remains open.** `test/outcome-surface.test.js`
was the densest genuine instance and is now behavioural: the alert rail's outcome
control is *clicked* through the handler `renderAlertsPanel` attaches, and the
dialog's option list is read from the element the console wrote. Converting it
found two defects the source-text assertions had covered for the life of the
file, which is the thesis of this row demonstrated on itself:

  - `public/shared/outcomes.js` read `payload.ok` and `await payload.json()` off
    `apiFetch`'s return, which is a *parsed body* — so `fetchCoverage` returned
    `null` on every real call (the coverage line never rendered in production)
    and `fetchReasons` always fell back to the client's own catalogue.
  - `public/app.js`'s `openOutcomeDialog` fetched the catalogue and then dropped
    it: `determinationFor(alert)` was called with no `reasons`, so the select
    rendered `FALLBACK_REASONS` regardless. The call existed and was inert, and
    `assert.match(APP, /fetchReasons\(\)/)` was satisfied by it.

The remaining files are counted by *call*, not by class, and most are legitimate:
`test/severity-chip.test.js` pins a CSS component list, `test/viz-explain.test.js`
reads a data file. Distinguishing markup-pinning from behaviour-asserting is the
remaining work, and it is a judgement per file rather than a sweep.

### QUA-03 — HIGH — `public/app.js` cannot be imported; tested through a hand-rolled DOM stub
`test/web-console.test.js` states it: it runs a boot sequence at import time. 6,324
lines of console logic are exercised via `test/browser-env.mjs` stubs. No unit test
of any render function; the console is only as tested as the stub's fidelity.

**Partly stale; the residue fixed 2026-10-11.** The first half is false: the
module *is* imported. `test/web-console.test.js`'s `loadConsole()` installs
`browser-env.mjs`'s module resolution, builds a DOM stub and `await import()`s
`public/app.js` — which succeeds, because the boot sequence is tolerant of a
stub that answers `getElementById` with an element and `fetch` with an empty
success. 45 tests then call the module's exports directly.

What was true is narrower and measurable. Of the 26 exports in `app.js`, seven
were named by no test anywhere: `autoFitBox`, `currentFilters`,
`AMBIENT_ENDPOINTS`, `FOCUS_KEY_ATTR`, `MIN_AUTO_FIT_SPAN_DEG`,
`preserveUiAroundRebuild`. `autoFitBox` is the one carrying load-bearing
decisions — four documented guards, one of which (`isFinitePoint`) exists
because fitting on GDACS bbox-only alerts drew the Indian Ocean at a larger
scale.

Nine tests now drive them, in `test/web-console.test.js` under "QUA-03 — the
framing and filter decisions are unit-tested, not stubbed". Each drives a
function with plain objects rather than asserting on what a stub rendered: the
whole point is that a stub answering `getBoundingClientRect` with zeros cannot
tell whether the map framed on the data or on the ocean. Canaried three ways,
each firing only its own test — removing the span floor (53/54), removing the
`isFinitePoint` guard (53/54), and making the frame near-region-only (53/54).

Still open: the module has no entry point that can be imported *without* the DOM
stub, so nothing can assert on a render function's output. Extracting one is the
remaining work and is a 6,373-line refactor, not a test change.

### QUA-04 — HIGH — `test:coverage` is vacuous

**Fixed 2026-10-11.** `scripts/check-coverage.mjs` runs the whole suite —
enumerating `test/` with the same glob `npm test` uses, so the list cannot
drift — and enforces floors set from the measured full-suite numbers: 95.7% line
/ 81.7% branch / 93.6% function over all 182 files, against 75/60/75 over six.
The parser reads the `all files` totals row and nothing else, and returns `null`
rather than a number for a report it cannot read, so a gate that cannot measure
fails instead of passing. Guarded by `test/coverage-gate.test.js`; canaried
against a floor it cannot meet and against a per-file row.

`package.json:13` runs `--test-coverage-lines=75 --test-coverage-include='src/**'`
against **6 test files** (`lite`, `fixtures`, `flood-bands`, `map-frame`, `seasonal`,
`store-conformance`) out of 162. The 75% threshold measures those six files' reach.
A module with zero tests still passes.

### QUA-05 — HIGH — Operationally important modules with no dedicated test file
`src/pg0.js` (zero-config Postgres bootstrap) and `src/audit-chain.js` (the
tamper-evident log) are the two that matter; also `src/observability.js`,
`src/route-manifests.js`, `src/narrator.js`, `src/sanctions.js`, `src/pdf.js`,
`src/community.js`, `src/bitemporal.js`. `public/sw.js` (930 lines, the offline
outbox whose correctness is an exactly-once claim) is tested by reading its text.

**Partly stale; verified 2026-10-11.** Re-checked against the tree, and the
entry conflates "no file named after the module" with "no behavioural test",
which is wrong for most of the list:

- Six of the ten have a dedicated behavioural suite under a feature name:
  `audit-chain` → `test/audit-chain.test.js` (29 tests), `observability` →
  `observability-substrate.test.js` + `observability-bounds.test.js`,
  `route-manifests` → `test/route-manifests.test.js`, `narrator` →
  `test/report-narrator.test.js`, `bitemporal` → `test/bitemporal-history.test.js`.
  `public/sw.js` is the flatly wrong one: four files import it as a module and
  exercise `evictionPlan`, `classifyApiRequest`, `shellGraph`, `parseReferences`,
  `isNeverCached` and `sanitizeHeaders` as functions; the text-read assertions
  are supplementary, not the coverage.
- Three have no dedicated file but are imported and asserted on behaviourally:
  `pg0.js` (three files), `sanctions.js` and `community.js` (`lite.test.js`).
- One is a genuine partial: `pdf.js` has no dedicated file, and one assertion set
  at `test/lite.test.js:5668` reads its source as text — though it is checking a
  rendered *label*, where the wording is the artifact, so the source is a fair
  proxy. It is not the module's only coverage.

The mechanical check, for the record: of the 90 modules under `src/` at
2026-10-11 — 65 at the top level, 25 under `connectors/` and `analytics/` — two
have no behavioural import in any test:

- `src/cors.js` — exercised through the server surface by
  `test/cors-preflight.test.js` rather than imported. The entry's claim is about
  behaviour and this module has it; the import is a proxy for the behaviour, not
  the thing itself.
- `src/demo-seed.js` — driven through `POST /api/v1/demo/seed` by
  `test/lite.test.js` and named by `test/layering.test.js` for the ARC-03
  boundary it defines.

`src/lineage.js` was the third and the only genuine finding: dead code
(`recordLineage` had zero callers; `src/provenance.js:recordLineageRow`
superseded it). It was deleted in `da64321` along with the route-envelope gate
that found it. The entry's module count was also wrong — it said 90; the tree
had 65 by the time anyone counted.

**Fixed 2026-10-11.** `scripts/check-module-coverage.mjs` makes this census a
gate rather than a paragraph. It reads every `.js` under `src/` recursively and
every test file, and requires each module to be either reached by a test
(statically, dynamically, or for side effects) or named in
`SERVER_SURFACE_MODULES` with the route that reaches it and the file that drives
it. It checks the other direction too: an allowlist entry a test now imports is
reported as a stale exemption, because an entry that outlives its reason is how
an allowlist becomes a place to hide. Nine canaries cover both directions,
including that a bare specifier and a mention in a comment are not imports.
Registered in `scripts/run-gates.mjs` as self-contained (12 gates).

It found `src/demo-seed.js`, which the hand count above had missed — the module
is reached only through `POST /api/v1/demo/seed`, so nothing imports it from a
test file and a name-based census cannot see it.

### QUA-06 — MEDIUM — No test asserts a route's response envelope shape consistently
`api-substrate.test.js` covers pagination/ETag/idempotency/readiness on
`service_assets` only. No test walks all 150 documented routes asserting
`{success, data}` vs `{success, …page}` vs bare arrays — so `/api/v1/kpi/snapshots`
returning `data: [...]` unpaged next to a paginated sibling is undetected. The
`check-openapi.mjs` trick (read the surface from the server, require both directions)
generalises to this.

**Fixed 2026-10-11.** `scripts/check-route-envelopes.mjs` reads the routes out of
`docs/openapi.yaml` and drives each one against a real server seeded with a probe
record per collection, asserting four invariants: a JSON body is an object with a
boolean `success`; a 4xx/5xx failure carries a `code`; an array `data` is either
fully paginated (all of `returned`, `limit`, `total`, `has_more`, `next_cursor`)
or named in `ARRAY_IS_COMPLETE` with the reason its set cannot grow; and a paged
`total` is at least its `returned`. Exemptions are by media type where a route
speaks a published standard — GeoJSON (RFC 7946), the STAC catalogue, OGC API
Features — because wrapping those in this envelope would break the schema they
exist to speak. Registered in `scripts/run-gates.mjs` as a `self-contained` gate
(11 gates now), with 13 canaries covering both directions of every rule.

It found three real defects on its first run, which is the point of it:

- `/api/v1/connectors/status` returned `total` beside an array with none of the
  other four paging keys — a partial paging envelope, the shape the finding names.
  `total` is now `count`, matching the file's convention for a bounded catalogue
  (`src/server.js:2336`).
- `/api/v1/road-access` returned the whole set unpaged, so a caller could not tell
  a complete answer from a truncated one and there was no second page to ask for —
  the same defect R-27 fixed for its food-security sibling. It now pages via
  `matchedAndPage`, with the roll-up computed from `matched` rather than the page,
  so `impassable` describes the network rather than the window
  (`src/server.js:1832`). `public/app.js:1449` asks for `?limit=5000` explicitly,
  since a road network larger than the default 500 would silently lose its tail.
- `summarizeRoadAccess` threw on a record with no `obstructions` field, turning a
  dashboard roll-up into a 500. Now `|| []`, matching the `|| 0` beside it
  (`src/road-access.js:414`).

Guarded by `test/lite.test.js` "pages road access and computes the roll-up from
the whole matched set", canaried by reverting the handler to the unpaged form.

### QUA-07 — MEDIUM — `?limit=abc` returns an empty page indistinguishable from no data
`src/utils.js:215` `Math.min(Math.max(Number(query.get('limit') || 500), 1), 5000)`.
`Number('abc')` is `NaN`; `Math.max(NaN,1)` is `NaN`; `matched.slice(0, NaN)` returns
`[]`. A typo'd query parameter reads as an empty dataset with `total: 0`. The
codebase is otherwise scrupulous about exactly this falsy-zero class — this is an
inconsistency, not a philosophy.

**Fixed 2026-10-11.** `parseLimit` at `src/utils.js:88` is now the one place a
`limit` is read, and it refuses rather than coercing: a value that is not a
non-negative integer sets `statusCode = 400`, which `jsonResponse` renders as a
failure envelope carrying a `code`. The registered line (`:215`) was the old
inline `Math.min(Math.max(Number(...)))`; the helper replaced it. Guarded by
`test/query-veracity.test.js:175`, and the road-access paging test above asserts
the same refusal through the real HTTP surface (`?limit=abc` → 400 with a code),
because a unit test on the parser does not prove the route wired it up.

### QUA-08 — HIGH — A test writes into a tracked repo file, so the suite's result depends on worker count
`test/static-and-tile-caches.test.js` proves "a changed file is re-prepared" by
writing `// cache-buster` into `public/shared/app-version.js` — a tracked file —
and restoring it in a `finally`. `node --test` runs test files in parallel
workers, so two workers overlap on that path and one caches an mtime/size the
other is about to change. `publicDir` was a module constant
(`src/server.js:85`), so there was no other way to point a server at a file the
test was allowed to mutate.

Not found by the audit; found while running the suite for ENH-31. It presented
as three unrelated failures in three files that each passed alone — a socket
closed with no bytes read, a 301-second headers timeout, an ETag that should
have differed comparing equal. Full detail under **Fixed**.

**Fixed 2026-10-11.** `createServer` takes `publicDir`, `handleStatic` takes it
as a parameter, and the test serves a private copy of the tree. Measured before
the fix: the file alone, ten sequential runs, 10/10 pass; ten concurrent runs,
9/10 fail. Three implicated files run six ways concurrently: 4/6 fail. After:
10/10 and 6/6, and `git status` clean — where the failing runs had left
`// cache-buster` appended twice to a tracked, served asset.

The seam is canaried: a server pointed at a fixture root serves the fixture's
body, not `public/`'s, so it cannot be ignored without the canary failing.

The class this belongs to is worth stating, because the instance is small: a
test that mutates the repository is a test that can corrupt the artifact it is
checking, and under file-level parallelism it makes every other test's result a
function of scheduling. A suite whose verdict depends on how many workers
overlap is evidence for nothing — including the things it says are fine.

---

## What is done right (calibration)

Do not "fix" these; they are why the defects above stand out.

- **Store layer is a genuine seam.** `JsonStore` and `PostgresStore` share
  `COLLECTIONS`, `sortRecords`, `supersededVersions`, `emptyStore`, and
  `test/store-conformance.test.js` runs both against one contract; `replaceCollection`
  is the correct fix for the O(N) full-table-write defect, documented with its measurement.
- **`src/route-manifests.js` is measured, not derived** — a script instruments the
  store and prints what each route reads, and a test asserts the measurement reproduces.
- **Auth is deny-by-default and the default is secure.** `scopeForRoute` returns
  `DENIED_SCOPE` for an unmapped mutation; `filterRecords` defaults to
  `currentRequestAuth()` rather than an opt-in argument.
- **Honesty semantics are real.** `/api/v1/ready` distinguishes `starting` from
  `degraded`; `/health` reports staleness; `?map=1` refuses to coerce `null` to a
  coordinate; retention refuses when the window is unset rather than reporting
  `expired: 0`. `narrator.js` refuses any sentence whose digit is not in the fact set.
- **The webhook SSRF guard holds** — shape check at registration, DNS re-resolution
  at point of use, credentials-in-URL rejected, IPv4-mapped/6to4/NAT64 handled.
  VUL-01 is its unguarded twin.
- **Absent-value discipline is centralised.** `numericOrNull` in
  `src/analytics/numeric.js` is the one sanctioned absent→number gate; the DEM void
  rule (`terrain.js`) makes nodata `NaN`, never 0, with the historical bug in the comment.
- **Metric cardinality is bounded** (`MAX_METRIC_SERIES = 512`, per-label budgets),
  and the inbound limiter is bounded with `tryAcquire` so overload is refused, not queued.
- **Idempotency claims a bound and reports it** (`in_process: true, ttl_hours: 24`).
