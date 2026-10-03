# Changelog

## Unreleased

Flood, access-risk, seasonal-signal, food-security, and outbreak-context capability.
All additions are additive; no existing endpoint changed shape.

### Added

**An i18n layer on the three surfaces that had none.** `districts/`,
`scenarios/` and `parametric/` shipped no `data-i18n` at all, so
`scripts/check-i18n.mjs` named them as surfaces with no layer rather than
counting them as passing. 217 keys across the three, `en.json` 227 → 444.

Every non-English locale got *relatively* worse — `sw` fell from 92% of the
catalogue to 48%, because the denominator grew by 217 keys and the numerator by
none. That is the honest consequence and it is left visible: the gate holds an
absolute floor on each locale's translated count, since a percentage floor would
force a guess at the new strings rather than a translator's work. Each new
surface therefore offers `en` only, and each test asserts the picker must widen
when a catalogue actually reaches that surface's keys.

Three English strings were also wrong, not merely untranslated. The three
scenario delta cards read "score change (mean points)", which is a mean *number
of points* rather than the change in the mean — a different quantity from the
one the card prints, on all three at once. The parametric sanctions banner said a
match "requires compliance review", which reads as advisory when the rule is
that the disbursement does not proceed until it is cleared.

**Bulk upload with a validation report.** There was no way to get your own data
in. `POST /api/v1/ingest/run` takes CSV as a *string inside a JSON body* — a
district officer with a 4 MB ACLED export had to paste it into a field on a
surface that has no such field, and the API was the only door. It is also a
door with no curtain: the connector returns `errors`, the caller decides what to
do with them, and nothing anywhere enumerates what was wrong with which row. A
paste-and-pray import that reports "imported 400, 12 errors" is worse than one
that refuses, because the twelve are invisible.

`GET /api/v1/upload` publishes the contract — every collection, the columns it
requires, the columns it accepts — so a client never has to guess. `POST
/api/v1/upload` accepts `multipart/form-data`, raw `text/csv`, or `{csv,
collection}` as JSON; all three reach one validator and produce one report.
Every rejected row carries a line number, a column, the value found and what was
expected. `dry_run=true` returns that report and writes nothing.

A batch lands whole or not at all: if any row is rejected the response is 422
and nothing is written. A partial import is the outcome nobody wants — the caller
has to work out which half landed, and the half that landed is the half they did
not look at.

Four judgement calls, each stated because the alternative was tempting. It does
not guess at a column name: `lat`, `latitude` and `Latitude` all appear in real
exports, and guessing which is meant turns a typo into a silently dropped
column. It does not clamp an out-of-range coordinate, because a latitude of 91 is
not a latitude at ±90 and the record would then be in the store claiming to be
somewhere it is not. It does not accept a date it cannot read — `Date.parse`
would have taken `04/03/2026` and quietly meant 3 April, which is a different
answer depending on who is asking. And it treats a coordinate of exactly 0 as a
coordinate, because the equator and the prime meridian are ordinary places; that
is the falsy-zero conflation this codebase has been bitten by repeatedly, and
`latitude && longitude` is not used here.

**A chart library.** Seven of eight surfaces showed no chart of anything — a
sentence in a `<span>`. The four charts that did exist were four unrelated
implementations: a `<polyline>` in `co/`, a CSS-`<div>` bar chart in `co/`, two
pixel-height `<div>`s in `scenarios/`, and 39 `svgEl()` calls in the situation
map. So the visualization ceiling was not a styling problem; the thing the work
needs to build did not exist.

`public/shared/charts.js` — `lineChart` (with an optional uncertainty band),
`barChart`, `stackedBar`, `heatmap`, `smallMultiples`, `sparkline`, and the
scale helpers they rest on. Every function takes a data array and returns
strings, which is why 49 tests can assert on what a chart actually drew without a
browser.

Four properties every chart holds to:

- **An absent value is not a zero.** A gap breaks the line rather than being
  bridged, a missing heatmap cell is a dashed outline rather than the lowest
  colour in the ramp, and a missing bar is not a zero-height bar. A null
  rendered as zero is a claim about the world.
- **Every chart ships a table.** The SVG is `aria-hidden`; the table is its
  sibling. A hue and a slope do not survive a screen reader.
- **The extent is data-derived, shared and printed.** Bars are comparable only
  against one axis, and an axis nobody can read is a decoration.
- **Colour comes from `tokens.css`, never from a literal.** A hex inside an SVG
  would not follow a retune of the palette for contrast.

`smallMultiples` generalises an instinct the console already had:
`loadFloodProbabilityModels` deliberately kept districts that *refused* a model
rather than hiding them, because "this district has 40 months, not the 60
required" is actionable and a blank strip is not. The console strip used to
reduce eight districts to one headline `skill_over_base_rate` and discard the
base rate, the month count and the spread; it now draws all eight side by side,
each with its own sample size, refused ones included.

### Fixed

**Nine mutating routes 403'd a caller holding the scope the docs named.**
`READ_SCOPES` and `WRITE_SCOPES` were module-private, so the deny-by-default rule
was the one rule in the codebase with no way to test it — and an unmapped
mutation fails *closed*, which is correct and invisible at the same time. Making
the table exportable found nine routes no prefix covered: `POST/PATCH
/api/v1/parametric-rules`, `POST /api/v1/trigger-protocols/{id}/backtest` and
`/shadow-run`, `POST /api/v1/report-distributions/{id}/retry`, `POST
/api/v1/report-schedule-runs/{id}/retry`, plus `POST /api/v1/routing/plan` and
`POST /api/v1/equity/scan`.

`scopeForRoute` matches on a `/` boundary, so `/api/v1/parametric` never covered
`/api/v1/parametric-rules`. That is the safe direction — a prefix cannot leak
onto a sibling — and it is exactly why a prefix fails silently and nobody finds
out until somebody reports a 403.

`test/route-scope-coverage.test.js` now enumerates every `(method, path)` in
`docs/openapi.yaml` and requires each mutating one to map to a scope. It reads
the document rather than `src/server.js` because `(method, path)` pairs cannot be
reconstructed from the server's text: only 11 of 64 mutating routes write the
method and path in one `if`, the rest delegate to eleven `match*Route` helpers
that check the method elsewhere. A scan that paired them found 11 routes,
reported every one mapped, and was right about nothing. The document declares all
122, and `check-openapi.mjs` already fails the build when it and the served
routes disagree.

**The operator can now see whether a deployment is secured.** The auth posture
lived only on `/api/v1/auth-info`, which requires a token — so the person asking
"is this secured?" was the one person who could not find out. `GET
/api/v1/health` reports `configured`, `enforced` and the public-path list: a
boolean, a list, and nothing about who holds what.

**Calibration was cited as a feature and wired to nothing.** JTBD-018 in
`docs/platform-jtbd-catalogue.md` offers `calibrationReport` as evidence that
`GET /api/v1/assessments` "includes calibration metadata". The function was
exported, documented, and called from nowhere; the route served no calibration
field. It is served now — over the same scoped score list its six siblings use,
because a mean confidence and a mean interval width describe data the caller may
not be permitted to read, and an unscoped aggregate is a quieter leak than the
record it summarises.

**Ten imports bound names nothing called.** `calibrationReport`,
`computeEnsembleStats` and `biasCorrectClimate` in `analytics.js`;
`pendingForFocalPoint`, `WORKFLOW_TYPES`, `WORKFLOW_STATES`,
`WORKFLOW_TRANSITIONS` and `resolveDistrict` in `server.js`; `stableId` in
`equity.js`; `toNumber` in `upload.js` and `workflows.js`. Six of the ten were in
`server.js`, which makes the file whose dependency graph a reader most needs
correct the one that was most wrong about it. An import is the only place a
reader learns that a module depends on another.

`test/unused-imports.test.js` now holds the line: every named import in `src/`
and `scripts/` must be mentioned again in its own file. It asserts it read a
real tree before it passes, because a scanner matching nothing would report the
same clean bill of health as the code it exists to catch.

**A test that failed when a defect was fixed.** `test/web-co-i18n.test.js`
asserted the i18n gate *reports* the surfaces with no layer — so adding a layer to
a surface failed the test meant to catch a missing one. It also hardcoded the
catalogue's key count, which went stale the moment three surfaces were layered. It
now reads the count and asserts the note is absent, with a companion test that
strips one surface's keys and requires the note back, naming that surface:
otherwise "the list is empty" and "the gate stopped looking" are the same
observation.

**The responsive gate measured nothing and passed.** `check-responsive.mjs`
slept a fixed 2500ms after navigation, then measured. A surface whose content had
not arrived yet reported *zero* controls — which reads exactly like a surface
where every control clears the floor. It was timing-dependent in the one
direction that hides defects: focal-point's rule form (21px inputs, under the
24px floor) passed on one run and failed on the next with no code change between
them. It now polls until the control count stops changing before measuring.

The gate also gained a floor on what it looked at. It reports
`smallTargetCount` with no lower bound, so a dashboard whose map never rendered,
or whose markers lost `data-tap-target` in a refactor, reports zero undersized
targets and passes. The dashboard now fails on "no controls were measured"
outright. Verified sensitive: at a 32px floor the same sweep fails 23 of 24
combinations.

**The sparkline connected across a missing month.** `public/co/app.js` filtered
nulls out of the series and drew one polyline through what remained, so
`[10, null, 30]` rendered as a continuous line through a month nobody measured.
It breaks the line at the gap now. The regression guard for this in
`test/lite.test.js` asserted on the *source text* of `public/co/app.js` — it
would have gone on passing against a file that no longer contained the behaviour
the moment the code moved. It calls the function instead.

**A bulk upload reported success on a file that contained a bad row.** The
`ok` verdict was `rows.length + invalidRows === parsed.length` — arithmetic that
is satisfied by three rows with one rejected just as happily as by three good
ones. It was an accounting coincidence dressed up as a statement of intent. It
is now `errors.length === 0`, which says what it means.

**Re-importing the same file silently overwrote its own records.** The duplicate
check read the id off the row and only generated one if it was absent — so a file
with no `id` column, the common case, never had its generated id compared with
the store. The generated id is deterministic, so a second import produced the
same ids, merged over the existing rows, and answered `imported: 3`. That is the
overwrite the check exists to prevent, reached by the one route that always
generates the id. The id is resolved before the check now.

**`actionLog` silently discarded everything a caller had to say.** Its
`metadata` was a fixed two-key literal built from `record.status` and
`record.priority`, so a caller with more to say passed it in and the whole
object was dropped. The upload route merged `{valid_rows, invalid_rows,
error_count, errors}` into the store and read back a log entry with none of it —
an audit trail that recorded that an import happened and nothing about what it
contained. `actionLog` takes an optional metadata object now, and callers win on
a collision: a fact the caller stated deliberately outranks the default `null`.

**A health worker told their report was filed when it was discarded.** The CHW
offline queue opened `if (!this.db) return` and then fired an IndexedDB write
without awaiting it, so an unavailable store — private mode, storage pressure, a
blocked upgrade — and a write the browser later aborted both resolved
successfully. The surface showed "Report queued", reset the wizard, and walked
the worker away from a typed report that existed nowhere. Nothing about a
discarded report looks like a discarded report.

`enqueue()` now throws unless the record is committed, resolving on
`tx.oncomplete` rather than on the request's own success: a quota error aborts
the transaction after the add has already reported success, so a record the
store then drops must not read as saved. The toast waits for the store's
acknowledgement. A throw leaves the wizard standing with everything typed still
in it — the one outcome in which retrying is right.

**The offline precache was a hand-kept list of an import graph, and was wrong.**
`APP_SHELL` had been repaired twice by hand and still omitted
`/shared/fmt.js`, `/shared/labels.js` and `/components.css`, all three imported by
the surfaces it claimed to cover. A missing ES module is a hard module-resolution
error, not a degraded load, so the console failed to boot offline entirely — the
one case the work exists for. There is no list now: `shellGraph()` walks a
breadth-first closure over `<link href>`, `<script src>`, `@import` and
`from '…'`, and the closure is unit-tested against the real `public/` tree, so
adding an import and forgetting the worker is a test failure rather than a boot
failure nobody sees.

**The CO trend chart described a period nobody selected.**
`computeMonthlyKpiSeries` walks back from `now`; the CO page called it bare
while its KPI tiles came from `?quarter=Q&year=Y`. Selecting a past quarter
plotted the last twelve months under a heading that said so, beside tiles for the
quarter — two different quarters presented as one. The window is now anchored to
the selected quarter and captioned with the range actually plotted, sections are
hidden and emptied before each load so a stale chart cannot be counted as
freshly fetched, and the heading stops claiming a range it no longer implies.

**The scenario delta bars drew score levels under a change.** Each card printed a
change in the mean sensitivity score and drew two bars below it — "Base" at a
hardcoded 40px, "Scen" at `max(4, min(80, 40 + delta))`. The bar encoded a level
while the number was a delta, neither was labelled, and the scale was both fixed
and truncated: a +2 and a +40 came out at nearly the same width, and everything
past +40 came out identical. Bars now encode the delta they sit under, anchored
at a zero rule on a data-derived extent shared by all three cards and printed at
both ends of the axis. A null delta prints an em dash rather than an empty track
that reads as "no change".

**Two keys rendered as themselves.** `footer.powered` reached every Soomaali and
Kiswahili reader on the CHW page as the literal text `footer.powered` — the
shared runtime resolves a missing key to the key — and `co.kpi_title` left
English standing under a Kiswahili flag. Both fixed. The Soomaali translation of
`footer.powered` is not invented; it sits in a named untranslated-key list that
is printed on every run.

**The i18n gate checked one hand-listed namespace against one locale.**
`scripts/check-i18n.mjs` now enforces, over all eight surfaces, that every
`data-i18n` key exists, that every locale a surface offers renders every string
that surface's markup names, and that every locale file meets a recorded
coverage floor that may only rise. The three surfaces with no i18n layer are
named on every run rather than scored as passing.

**The tap-target gate could not see the map.** Its selector listed only HTML form
controls, so every SVG shape was invisible to it — which is why a hazard marker
could be five CSS pixels across while the gate stayed green. The console's own
`data-tap-target` opt-in is now queried, and width is checked alongside height.
Not run live: the gate needs Chrome on :9222 and a server on :4177.

**A data-quality number that was always zero, and would have been meaningless
if it were not.** `computeDataQuality` initialised `confidence_sum` on each
source, read it to produce `mean_confidence`, and never incremented it anywhere
— so it computed `0 / total_records` and reported `0` for every source in the
platform, including sources whose model produced perfectly good confidences. A
panel showing "mean confidence 0" beside a source with thousands of records and
a healthy run is worse than an absent number, because it looks measured.

It now sums only the records that carry a confidence, divides by
`confidence_count` rather than by the record total, and returns `null` when
nothing carried one — raw source rows have no model confidence, and averaging
their absence in understates the sources that do. `confidence_sum` and
`confidence_count` are both in the payload, so the mean can be checked.

The rounding is what concealed it: `Math.round(0.82)` is `1`. A 0-1 mean rounded
to an integer can only ever be 0 or 1, so even a correctly-summed value would
have been meaningless. `mean_confidence` is now two-decimal, with a
`mean_confidence_pct` companion because the 0-1 fraction sits confusingly beside
`confidence` and `geocode_coverage_pct`, which are 0-100. The same defect was in
`calibrationReport`'s `mean_confidence` and `mean_interval_width`; both are now
two-decimal and null-safe.

**A CSV export was a spreadsheet macro.** `csvEscape` escaped commas, quotes and
newlines, and did nothing about the four leading characters a spreadsheet treats
as a formula. A field report whose submitter is named `=HYPERLINK(...)` — or
`+`, `-`, `@` — became an executable cell the moment a district officer opened
the export. Header rows were not escaped at all, so the injection also worked by
way of a column name. Formula-leading cells are now prefixed with `'` unless the
cell is a bare numeric literal, in which case the prefix would corrupt a value
that was already fine. Header rows go through the same neutraliser as values.

**The PII controls were off by default, unsalted, and one value for everyone.**
Three defects in one module. `redactNames` defaulted to `false`, so a deployment
that configured nothing stored reporter names and phone numbers in the clear;
`mergePolicy` then used `||`, which cannot distinguish "the caller said false"
from "the caller said nothing", so the safe default could not be asserted
anywhere; and the digest truncated a prefixed string to 32 characters — of a
`"sha256:"` prefix that is 7 characters, leaving 25 hex digits in which the *name*
prefix survived, so every redacted reporter came out looking the same and a
single confirmation named the population. Redaction now defaults on, policy
merging treats an explicit `undefined` as silence, and names hash through
`crypto.createHmac('sha256', salt)` to 128 bits. The salt comes from
`LINDELA_LITE_PII_SALT`; unset, one is generated rather than omitting — an unset
salt must never mean *no salt* — and the process says so on stderr, because an
ephemeral salt makes yesterday's pseudonym and today's unrelated people.

**GDACS and GloFAS invented severities.** Both connectors derived severity from
free text. GloFAS searched a description for the words "flood" and "orange" and
assigned the levels it found; GDACS matched an alert level against the strings
`green`/`orange`/`red` with `includes`, so a title containing "no orange alert"
produced `orange`. Severity now comes from the alert level against a closed
vocabulary, and anything outside it is `null` with a reason rather than a guess.
GloFAS emits `null` unconditionally and declares it in `model_limit`: it is a
modelled discharge series and has no severity to report.

**CAP could not express a cancellation and would not admit a restriction.**
`msgType` was keyed on the lifecycle string, and `Cancel` was not among the keys
— a cancelled alert was published as an `Update`, which tells a recipient to
update their records about an event that was withdrawn. `resolveMsgType` now
compares exactly and **throws** on an unrecognised status rather than defaulting.
`scope` was the literal `Public` on every alert; `scopeOverride` was accepted and
then discarded, and it was discarded *through `||`*, so `''`, `0` and `false`
all fell through to `Public` — a private alert with an empty scope. The override
is now honoured, validated against `{Public, Restricted, Private}`, and
`<restriction>` is emitted after `<scope>`.

**Flood depth ignored the vertical datum.** `depthAtPoint` refused to answer when
a cell fell below the no-data floor; `depthGrid` did not, so a grid could report
a confident negative depth where the DEM is simply absent — over the ocean, and
over any tile whose vertical reference is not the one the flood model assumes. A
foreign datum with no offset now yields `null` for every depth plus a `reason`,
and void cells in the `Float64Array` serialise as `null` rather than `0`.
`-0` is normalised, because a depth of negative zero is a rounding artefact that
prints as `-0`.

**Road access described the archive.** `computeRoadAccess` matched every hazard
in the store against every road regardless of age, so a 1985 GDACS archive flood
closed a road today with the same `access_status`, the same
`access_reason: "Blocked by flood (red)"` and the same confidence as one from that
morning — and `summarizeRoadAccess` counted it beside live events. A road-access
record is a claim about the present; a thirty-year-old entry is not evidence about
the present. Each obstruction now carries `temporal_status` (`active`,
`forecast`, `stale`, `undated`), `occurred_at` and `age_days`, with a per-hazard
active window — seven days for a flood, thirty for a landslide and an eruption,
because standing water recedes and a deposit does not. Stale evidence is kept in
the record and marked rather than deleted: deleting it would make "how much of
this road's status rests on current information" unanswerable. `undated` still
blocks — an undated hazard is not safe to dismiss — but it caps `confidence`
below 100, because "passable" beside an unexamined record is not the same claim as
"observed clear".

**Two surfaces computed `false_alert_rate` differently**, and both reported a
confident number where the honest answer was `null`: a district with no reviewed
alerts divided by zero and rendered `0%`, which reads as "no false alerts" rather
than "nobody has looked". One definition now, in both places, with the numerator
published beside it as `false_alert_determined` so the denominator is visible.

### Added

**Documentation links are checked, not assumed.** `validate.mjs` tested a
hand-written list of required sections in eight documents and never followed a
link. So `docs/architecture/decisions/README.md` could list twelve decision
records while six of the files did not exist, and the whole suite exited 0 — which
it did, on the missing rows being the six decisions a new contributor most wants
to read. A dangling link is not cosmetic: it asserts that something exists, it is
the first thing a reader follows, and unlike a broken build it fails *silently* —
the document still renders, still reads well, still lies.

`scripts/check-doc-links.mjs` resolves every relative markdown link in `README.md`,
`CHANGELOG.md`, `llms.txt` and `docs/**/*.md`, stripping fenced and inline code so
a bracket in a CSV example is not read as a link. It found **15** broken links on
its first run: `frontend.md` (the file is `dashboard.md`), four paths in
`deployment.md` pointing at a sibling directory as though it were the current one,
and the six absent ADRs, which have since been written.

**A fourth improvement document.** `docs/improvements/sources-and-decisions-roadmap.md`
asks the question the first three did not: not *can this platform be trusted* and
not *does what it claims work*, but **what does it not know yet**. Thirty-one
items — eleven sources, nine decisions, six operational capabilities, four platform
capabilities, and cold chain taken end to end as the one vertical that proves the
shape. It ships with its own dedup ledger: every item is marked `replaces`,
`extends`, `fixes`, `subsumed` or `new` against ENH-01..30 and items 1–20, and
three items the request duplicated (calibration surfaces, bias-corrected
downscaling, and the IBF backtest already covered by extension 6) are listed as
*considered and rejected* rather than written twice. Two entries are counted twice
on purpose — `cold_chain` exists today as a workflow type, and the KPI that
carries it measures ticket closure, not vaccine viability.

**The API document is now checked against the code.** `docs/openapi.yaml` was
hand-maintained, and the check that existed tested ~30 hand-listed endpoint
strings for presence in the document — a test of the list, not of the server.
Adding a route and forgetting to add it to the list passed, which is how nine
live routes went undocumented while the document still validated.

`scripts/check-openapi.mjs` reads the route surface out of `src/server.js` and
fails when the two disagree, in both directions: a served route the document
omits, and a documented route the server does not serve. It found **21** of the
latter or former, including the entire workflows family (list, detail,
transition) and `/api/v1/metrics`, which had never been documented at all.
All are now described. 121 documented paths, 121 served routes, and the check
runs in `npm run validate`.

**The API substrate.** Four gaps, each of which a caller hits on the first
integration.

- **Collections report their total.** Every list route answered with a bare array
  truncated at `limit` and said nothing about what else existed, so "we found
  nothing" and "we found five hundred" were the same response. List routes now
  return `returned`, `limit`, `total`, `has_more` and `next_cursor` alongside
  `data`. Pagination is cursor-based: pass `next_cursor` back as `cursor`. A
  cursor naming a record that is not in the result set is a `400`, because
  silently restarting from the beginning looks like progress and is not.
- **Conditional requests.** The static-asset path computed ETags; the API did
  not and sent `cache-control: no-store`, so every poll from every open console
  re-downloaded the full payload to be told nothing had changed. Successful
  `200`s now carry an `ETag` and `cache-control: no-cache`, and an
  `If-None-Match` match answers `304` with no body.
- **Idempotency keys.** `Idempotency-Key` on any `POST`/`PUT`/`PATCH`/`DELETE`.
  A repeat inside the window replays the original response byte for byte, with
  `idempotency-replayed: true`. The key is scoped by caller, method and path
  before lookup — unscoped, two partners both using `"1"` would receive each
  other's writes, a cross-tenant read manufactured entirely from request headers.
  A key reused with a *different* body is a `409`, not a replay: answering with
  a receipt for work that was never done is worse than running the request.
  Failures are never cached. The window is 24 hours, in-process, capped at 1000
  entries, and reported by `/api/v1/ready` rather than left to be assumed.
- **`GET /api/v1/ready`**, distinct from `/api/v1/health`. Health answers "is
  this process running"; readiness answers "can it serve a request right now".
  The store is a separate dependency that can be unreachable while the process
  answers `/health` with `200` — so a load balancer polling only `/health` keeps
  a broken instance in rotation and hands every user a `500` it could have
  routed around. Readiness probes the store, times out, and reports `503` with
  the error. Public, like `/health`, and deliberately carries no records.

**Partner isolation, one route further.** `GET /api/v1/assessments` scoped four
of its five record lists and left `recent_events` with no context at all — the
only unscoped list on the route, so a partner token received every hazard and
conflict event in the platform beside four correctly filtered lists.

### Fixed

**Security. Ten defects.** The headline is that authentication was, in effect,
optional — and a deployment with it configured looked secured.

- **Every GET route was unauthenticated.** The guard read
  `if (!auth && req.method !== 'GET')`, so GETs were never rejected.
  `GET /api/v1/export.csv` — which returns field reports and RapidPro message
  bodies — was served to anyone who could reach the port, even with API keys
  correctly configured. All routes now require a token. The widening is
  deliberate and explicit: `LINDELA_LITE_PUBLIC_PATHS` names specific paths and
  there is no blanket public-read switch, because the previous behaviour was
  exactly that switch.
- **A read-only token could perform any mutation.** `scopeForRoute` fell through
  to `read:hazards` for any route not in its five special cases, so a token
  issued for reading hazards could write to everything, including routes added
  after it was issued. Reads and writes now map to explicit scope tables; an
  unmapped mutation requires `admin:*`, which no scoped token holds. Adding a
  route without adding it to the table now closes it rather than opening it.
- **Auth failed open on misconfiguration.** A malformed `LINDELA_LITE_TOKENS`
  parsed to `[]`, and an empty token list disabled the entire auth block — a
  stray comma turned authentication off in production and nothing said so.
  Malformed configuration now throws: an operator error is an outage, not a
  silent downgrade to open.
- **`/metrics` was served before the auth gate**, so `/api/v1/metrics` was
  reachable without a token despite sitting in the authenticated namespace,
  leaking request rates, error rates, latency percentiles and route labels.
- **Internal error messages were returned verbatim.** `error.message` reached
  the client for every failure, including `pg` errors carrying the connection
  string and failing statement, `JSON.parse` errors carrying a fragment of the
  payload, and filesystem errors carrying absolute paths. Errors with an
  explicit 4xx `statusCode` are written for the caller and keep their message;
  everything else logs server-side and returns a correlation id.
- **Token comparison was not constant-time**, and the audit subject was
  `token_${token.slice(0, 8)}` — the first eight characters of the secret in
  every log line that carried it. Now `crypto.timingSafeEqual` across all
  candidates, and a SHA-256 fingerprint that is stable for correlation but
  carries nothing.
- **The RapidPro field-report webhook was open by default.**
  `if (!secret) return true` meant an unconfigured secret was indistinguishable
  from a production deployment where nobody set one. It now returns 503, and
  accepting unsigned webhooks requires `LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED=1`.
  HMAC-SHA256 body signatures were added alongside the shared secret, compared
  in constant time; a present-but-invalid signature does not fall back to the
  secret check. `rapidProStatus` reports which insecure state a deployment is
  in.
- **Signed webhooks never delivered.** `outbox.js` called `signPayload` without
  importing it; the resulting `ReferenceError` was swallowed by an empty
  `catch`, so every secret-protected webhook failed silently and was marked
  `failed` after five attempts with no record of why.
- **Webhook subscriptions were an SSRF primitive.** URL validation was
  `url.startsWith('http')`, which admitted the cloud metadata endpoint,
  loopback, RFC1918 and CGNAT ranges, and decimal- or hex-encoded loopback.
  Now: explicit scheme, no embedded credentials, and every resolved address
  checked against IPv4 and IPv6 private ranges. The check runs at dispatch as
  well as registration, because DNS rebinding means a hostname that resolved
  publicly at registration can resolve to 127.0.0.1 minutes later.
- **Webhook glob patterns compiled to unescaped regex**, so a subscription
  created with pattern `(a+)+` hung the event loop — measured 14.2 s on a
  26-character input. `globMatch` no longer compiles a regex at all; it is a
  two-pointer scan. Escaping metacharacters would not have been enough,
  because translating `*` to `.*` still leaves `*a*a*a…*b` a live combinatorial
  hang. It was also duplicated in two modules; there is now one.

Three further defects surfaced while fixing these and are also fixed:

- **A second mutation auth path** (`isAuthorizedMutation`) authorized by bare
  API-key comparison with no scope check, and was called from nowhere. Deleted
  rather than fixed — dead code that duplicates an authorization decision is a
  bypass waiting to be wired up.
- **Webhook signature verification ran before the body was read.** A unit test
  of `verifyRapidProWebhook` passed whether or not the route could supply the
  bytes it needed, because the body stream is consumed once. The HMAC path was
  green in tests and dead in production: every signed request failed closed.
  `readRawBody` now buffers once and caches on the request.
- **`logger.error({ err })` serialized to `{}`** — an `Error`'s fields are
  non-enumerable, so the log said nothing at all about the failure it was
  recording.

### Fixed (multi-tenancy)

Multi-tenancy was a no-op that displayed itself as working. Three layers were
missing: the claim could not be expressed, could not be enforced, and could not
be checked.

- **The claim could not be expressed.** `scopeToPartnerOrg` keyed on
  `auth.partner_org`, which `authenticate()` never set — so it always returned
  every record — and it had no call sites in `src/` at all. Tokens may now carry
  `partner_org`, and it is read from the token definition into the
  authenticated principal.
- **The claim could not be enforced.** `filterRecords` now applies the token's
  organisation to every scoped read, *deny by default*: a record with no
  `partner_org` is not visible to a partner token. The old form passed untagged
  records through on the reasoning that they belong to nobody and therefore to
  everybody, which is the leak — every record written before the tag existed,
  and every record written by a path that does not set one, was visible to
  every partner. A partner token now sees nothing until records carry the
  field, which is the truthful answer for a deployment with no per-partner
  tagging, and it fails visibly.
- **The claim could not be checked.** `GET /api/v1/auth-info` returns the
  subject, scopes and organisation as the server understands them. The portal
  rendered its organisation from `localStorage` — a value the browser
  remembered from a previous session on a shared machine — and sent
  `?partner_org=<org>` on every request, which the server read nothing from.
  That parameter is now refused unless it matches the token's own claim (403),
  rather than silently ignored: a parameter that looks like isolation should
  either be the isolation or be refused. The portal reads its identity from the
  server and, when the token carries no partner scope, says so instead of
  showing platform data under a partner's heading.
- **`GET /api/v1/export.csv` passed no context at all** — no district
  resolution, and now no tenant scoping either. It is the widest read in the
  API and the route SEC-01 found serving field reports and message bodies
  unauthenticated; an export that ignored the token would undo the scoping the
  list routes now perform.

### Fixed (data integrity and metric honesty)

Ten more defects, in three families: numbers that were counted wrong, numbers
that were computed from something other than what they were named after, and
computation that was never wired to anything.

**Counting.** The recurring bug is a list of collection names being written in
one place and read in another, with nothing checking that they agree.

- **`facilities_at_risk` counted facility-hazard pairs.** The loop was
  `hazards × assets`, so a clinic within 25 km of three separate flood events
  appeared three times in `at_risk_count` and contributed its
  `population_served` three times to `total_population_served`. A district
  under a flood cluster was reported as having more exposed population than it
  has people. The loop order is inverted: assets outside, hazards inside, each
  asset emitted once, and the per-hazard detail that made the duplicate look
  legitimate (`hazard_count`, `high_severity_hazard_count`,
  `worst_hazard_severity`) is preserved on the single record.
- **`counts` reported the size of the sample, not the size of the population.**
  `districtOverview` returned the 30 most recent field reports and reported
  `counts.field_reports: 30`. The true total was 45. Worse, `false_alert_rate`
  was computed over the window, so a district whose 31st-oldest alert was a
  false alarm reported a rate its own records contradicted. Counts now come
  from the full collection, and each truncated list carries
  `samples.{field_reports,alert_events}.{total,returned,limit,truncated}` so a
  caller can see the difference.
- **Ingestion dropped every collection not in its merge map.** The accumulator
  and the lineage rollup were written as two independent object literals over
  the same six keys. Adding a connector that wrote a seventh collection would
  have persisted records that no lineage entry counted. Both now derive from
  the single exported `OUTPUT_COLLECTIONS`, and a registration test asserts it
  agrees with `emptyStore()`.
- **Concurrent writes lost records.** Every `JsonStore` mutation is a
  read-modify-write of one file, and twenty overlapping `merge()` calls each
  read the same snapshot before any of them wrote — six survivors from twenty
  callers. The store now serialises mutations through a promise chain and
  writes through a temp file plus `rename`, so a crash mid-write cannot leave a
  truncated store. `replaceAnalytics` was six separate read-merge-write cycles
  and could interleave with a concurrent ingest; it is now one serialised
  cycle.

**Metrics that measured something else.**

- **`response_rate_pct` counted messages, not people.** It divided inbound
  messages by dispatches, so one community health worker answering the same
  alert twice — or a flow emitting several messages per answer — produced
  200%. A percentage above 100 is not a rounding problem; it is a metric that
  does not mean what its name says, and an operator cannot distinguish "twice
  as responsive" from "broken". Replies are now matched to the dispatch
  recipient and deduplicated. When the dispatches carry no recipient identity
  there is no rate to report, so `response_rate_pct` is `null` with a note, and
  the message count is still returned. `null` when nobody has answered yet
  for the same reason: zero would report silence as a measured outcome, the
  conflation the alert model already refuses with `false_alert: null`.
- **Dispatch precision divided by the wrong denominator.** `equityByDistrict`
  counted every dispatch but subtracted false positives that included alerts
  never dispatched, and reported 100% for a district where every alert was
  still open. It is now `dispatch_precision_pct`, over *determined* dispatches
  only — resolved, with an outcome — and `null` when there are none.
  `accuracy_pct` remains as an alias with a `data_gaps` entry saying not to
  trust it.
- **`/score` returned a bare probability.** The Wilson intervals and
  contingency counts the model was actually fit to never left the server, so
  the one number an integrator would quote was the one number with no way to
  see it rests on four events. `/score` now returns `uncertainty.by_feature`,
  keyed by the feature the caller supplied — `contingency()` returns a flat
  array, and returning `row[0]` attributed the `max_7_day` interval to
  whoever asked about `sum_90_day`.
- **`/score` guessed the region.** With no `region` parameter it scored
  `models[0]`, whichever district trained most recently. A caller who omitted
  the parameter got an authoritative-looking answer about a district they
  never asked about. With more than one model it now returns 400 and lists
  `available_regions`.
- **Trigger backtests ignored the trigger.** `backtestTriggerProtocol` never
  read `metric`, `operator` or `threshold` and scored every run on "did any
  hazard event follow", so backtesting a protocol and backtesting an unrelated
  one produced identical numbers. It also classified every sample as a true or
  false positive, which made `misses` identically zero and forced `recall` to
  equal `precision` — two numbers that could never disagree, and so could never
  disagree usefully. Runs are now scored against the protocol condition,
  misses are counted separately, and the result reports the event base rate
  and `precision_lift` — a protocol with precision 0.5 that fires on every run
  has learned nothing, and the verdict now says so.

**The money path.** Parametric insurance was the least-governed code in the
repository.

- **The trigger was stored and never read.** `normalizeParametricRule` persisted
  `trigger_metric` and `trigger_threshold`; `simulateDisbursement` copied
  `disbursement_amount_local_currency` unconditionally. Any POST to
  `/parametric-rules/:id/simulate` produced a full payout — the defining
  property of parametric cover, that it pays on an observed event rather than
  an adjuster's judgement, was unimplemented. The trigger is now evaluated
  against the platform's own state (the same context alert rules see), with
  `trigger_operator` added and validated. Three outcomes, not two: met, not
  met, and **not evaluable** — an unevaluated trigger is not a triggered one.
  An unmet trigger pays nothing, reports `amount: null` rather than `0` (no
  amount is owed; zero would read as a measured payout of nothing), and mints
  no `tx_hash`, since a transaction for a payout that is not owed is a hash of
  nothing. An operator may still quote an observation the store has not
  ingested, recorded as `trigger.source: 'supplied'` so it cannot be confused
  with the store's own reading.
- **A rule with no trigger paid out on request.** The same defect wearing a
  parametric label: no condition, full disbursement. It now pays nothing and
  says why.
- **The approval gate was a field the same request set.**
  `Boolean(body.focal_point_approved)` meant a payout could be approved by the
  request that requested it, while `src/workflows.js` defined a
  `parametric_disbursement` workflow whose states include
  `focal_point_confirmed` and was consulted nowhere. It is consulted now: a
  named instance that does not exist, is the wrong workflow type, or has not
  reached a confirmed state is a 409. Where no workflow backs the approval it
  is still accepted, and recorded as
  `focal_point_approval.source: 'request_body'` with `verified: false` — a
  compliance reader needs to see that it was asserted, not upgraded into a
  verification it did not get.
- **None of the three parametric write paths wrote an action log.** A rule
  defining what gets paid, to whom, on what condition could be created and
  edited with nothing recording who did it. All three log now.

**Alert suppression.** `Math.floor(Date.parse(now) / windowMs)` is a calendar
grid anchored at the Unix epoch, so the bucket boundary had nothing to do with
when the last alert was raised. Two evaluations two minutes apart either side
of a boundary fell in different buckets and both fired: an operator who asked
for a 120-minute suppression got two alerts, two dispatches, two sets of
response metrics, and two open alerts inflating the equity KPIs. Suppression
is now a rolling window measured from the most recent alert for that rule.
Records predating `created_at` fall back to their bucket, and a record whose
timestamp will not parse is treated as no evidence the window elapsed — the
naive `Math.max` over a `NaN` would have returned `NaN`, `NaN < windowMs` is
`false`, and the alert would have re-fired on top of itself.

**One open alert per rule.** A persistent condition raised an open,
dispatchable alert every suppression window — about 84 a week at the default
120-minute setting — each one sendable to a CHW, each one counted in the equity
KPIs. `evaluateAlertRules` now keeps one open alert per rule and records a
repeat as an observation on it (`observations`, `last_observed_at`,
`peak_value`). A genuinely worse reading escalates instead: the old alert
becomes `superseded` with a note saying what it was superseded by, and the new
one carries `supersedes` and `prior_value`.

Escalation is strict. `compare(value, operator, prior)` treats equality as
satisfying a `>=`, so an unchanged reading would have superseded the alert on
every evaluation — a supersede that says nothing has changed is a worse
artefact than the duplicate alert it replaced.

**Hysteresis.** `hysteresis` on a rule (default `0`, so existing rules are
unaffected) is the margin, in the metric's own units, the value must fall back
*past* before an open alert is released. An alert whose gauge has visibly
settled is closed by the evaluation with `resolution: 'cleared'` and a note
naming the reading — otherwise it stays open until a person triages it, and an
alert nobody clears because the reading came back down is an alert nobody
reads. `==` and `!=` have no direction to move away in, so any non-firing
reading clears them.

**Breaking changes**

- `evaluateAlertRules` returns `{ raised, updated }`, not a flat array of new
  alerts. `updated` holds existing alerts whose state changed; merging them
  with the raised ones, as a flat array invites, makes "an alert was raised"
  and "an alert was closed" indistinguishable — and the webhook fan-out fires
  on both. `POST /api/v1/alerts/evaluate` reports `created` and `updated`
  separately and emits only for raised alerts.
- Alert rules accept `hysteresis`. Absent means `0`, which preserves existing
  behaviour exactly.

**Tests**

- `test/store-conformance.test.js`, `test/flood-score-honesty.test.js`,
  `test/trigger-backtest.test.js`, `test/rapidpro-response-metrics.test.js`,
  `test/counting-honesty.test.js`, `test/rapidpro-signature-live-route.test.js`,
  `test/alert-suppression.test.js`, `test/parametric-trigger.test.js`,
  `test/falsy-zero.test.js`.

### Fixed (falsy zero)

A field that was never populated and a field that is zero are different facts,
and the UI rendered both as `0`.

- `pii.js` skipped coarsening any coordinate at exactly 0 degrees, so a point
  on the equator or prime meridian was dropped from the privacy-preserving
  output — the one location that cannot be coarsened away was the one removed.
- The districts map used `if (!lat || !lon)`, dropping Null Island for the same
  reason, and filtered through two independent truthiness checks that could
  disagree about the same record.
- The console map's severity filter admitted every record with **no** severity,
  and the source filter one line below had the identical inverted defect: a
  record with `source: null` passed every source filter.
- Four `|| 0` coercions printed a zero for an absent value — an unfitted model
  rendered "0% flood-month base rate" (the exact claim `src/analytics.js` warns
  against) and a summary that never loaded rendered the reassuring half of the
  sentence, "All N roads passable".

Map record counts now report what they hid and why: `42 records — hidden by the
filter: 6 with no severity`.

24 tests, verified against a pristine `HEAD` tree (21 fail without the fixes),
with each predicate separately mutated back to its buggy form so the guard is
behavioural rather than a missing export. That mutation testing surfaced a gap
in the obvious fix: `r.latitude ?? r.lat` shields `null` from the fallback but
not `''`, and `Number('')` is `0`, so a tidy `Number.isFinite(Number(x))` guard
passes a blank field and plants a dot on Null Island.

### Breaking changes

- `evaluateAlertRules` returns `{ raised, updated }` rather than a flat array.
- Repeated alert evaluations no longer create a second open alert for an
  unchanged condition; the existing alert gains `observations` and `peak_value`.
- `response_rate_pct` is now `null` rather than `0` when nobody has responded,
  and `null` when dispatches carry no recipient identity. Consumers that
  treated `0` as "no response" should treat `null` as "not yet known".
- `equityByDistrict` returns `dispatch_precision_pct`; `accuracy_pct` is
  retained as an alias.
- `districtOverview.counts.*` are true totals, not sample sizes — the same
  fields, different and correct values. `samples.*` reports the window.
- `/api/v1/flood-probability/score` without `region` returns 400 when more
  than one model is trained.
- GET routes require authentication when `LINDELA_LITE_TOKENS` or
  `LINDELA_LITE_API_KEY` is set. Set `LINDELA_LITE_PUBLIC_PATHS` to reopen
  specific paths.
- Narrow-scoped tokens now get 403 on routes that were never mapped. Grant
  `*`, `admin:*`, or the specific scope.
- `RAPIDPRO_WEBHOOK_SECRET` must now be set, or
  `LINDELA_LITE_RAPIDPRO_INSECURE_ALLOW_UNSIGNED=1` set, for the field-report
  webhook to accept anything.

### Added

- `test/auth-deny-by-default.test.js` — 20 tests. Every one of the auth fixes
  above was verified by reverting it and watching the suite fail.
- `test/rapidpro-signature-live-route.test.js` — 7 tests against the real HTTP
  route, because a unit test of the verifier could not see the body-ordering
  defect.
- `test/webhook-security.test.js` — 23 tests. The HMAC round-trip needed a
  seam: `dispatchPending` accepts `options.checkUrl`, defaulting to the SSRF
  guard. Nothing in the request path passes it; a companion test exercises the
  default policy against a real loopback listener and asserts no request
  arrives.
- `llms.txt` — a map of the repository for agents: how to verify, the model
  contract, the three collection lists that must agree, and the known gaps.
- `test/store-conformance.test.js` — one behavioural contract run against every
  storage backend. This is what makes the class of defect above impossible to
  reintroduce: it would have failed on the four-collection `replaceAnalytics`,
  the missing `payload_hash`, and the concurrency loss. Set
  `LINDELA_LITE_TEST_DATABASE_URL` to exercise the Postgres half; without it that
  half silently skips. `runIngestion` now takes an injectable connector map so
  the ingestion path is testable without network access.

- `GET /api/v1/flood-depth`. Static inundation from an operator-supplied water
  surface elevation, using keyless AWS Terrarium (SRTM) terrain — no API key and
  no data licence to obtain. Returns point depth, a level profile, an area grid,
  `extent_geojson`, and terrain context.
- `GET /api/v1/road-access` and `/api/v1/road-access/summary`. Flood and landslide
  events matched against road segments by bounding box rather than centre
  distance, so a large hazard polygon cuts the roads it actually contains. Reports
  passable / restricted / impassable with reasons.
- `POST /api/v1/routing/plan`. Dijkstra over imported road assets, returning the
  route, severed-segment diagnostics, and restricted-route penalties. Separates
  foot and vehicle classification, and reports infeasibility rather than returning
  a straight line.
- Flood-depth and road-status overlays on the operations map, with depth-banded
  shading and a legend. The water level is an operator input, not a forecast; the
  UI labels it a simulation.
- `noaa_enso` connector. NOAA CPC **monthly** Niño 3.4 SST anomaly from a keyless
  fixed-width ASCII feed, verified live on 2026-10-01. The overlapping three-month
  means are derived from it and are what the CPC episode rule is applied to. The
  monthly value is reported as a monthly anomaly and is **not** labelled the ONI,
  which is by definition the three-month running mean of those numbers. Emits
  `climate_observations` with coordinates deliberately null, because a
  basin-wide Pacific index must not be attributed to a district by proximity.
- `ipc_hdx` connector → `food_security_records`, plus `GET /api/v1/food-security`
  and `/api/v1/food-security/summary`. IPC Acute Food Insecurity classifications
  (phases 1-5 and the Phase 3+ aggregate, national and subnational) via the
  Humanitarian Data Exchange — keyless, CC0 / public domain, verified live
  2026-10-02. This supersedes the scoping conclusion that IPC needed a FAO/WFP
  licence: the HDX channel carries the same classifications, subnational, with
  no licence needed. Records are grouped one per area and validity window with
  every phase's published figure, relayed verbatim and never re-derived. The
  source `Percentage` column is a fraction of the analysed population (0.2 means
  20%), stated on every record. Geometry is bounding boxes only, joined from
  per-country GeoJSON where the area name matched; coordinates stay null. The
  summary rolls up the latest `current` window per country and the ten worst
  areas by Phase 3+ fraction. Default ingestion scope: all Sub-Saharan Africa.
- `who_gho` connector → `disease_observations`, plus
  `GET /api/v1/disease-observations`. WHO Global Health Observatory
  outbreak-relevant indicators (cholera cases/deaths/CFR, meningitis cases and
  epidemic districts, measles, yellow fever, plague) from keyless OData,
  verified live 2026-10-02. URL construction omits `$filter`, `$orderby`, and
  `$top` deliberately, after probing that the endpoint silently empties or
  ignores each of them — the full series is fetched and windowed in-process,
  where the failure mode is visible. National-annual aggregates only, with
  `coordinates: null` and a policy note per record (decision-support context
  with attribution; not district evidence; not an alert trigger), because
  outbreak figures can move funding flows and stigmatise areas. The summary
  marks each indicator series `current`/`aging`/`stale` against the calendar:
  a series that stopped publishing (cholera ends 2016, verified) is labelled,
  not hidden.
- IPC area bbox overlay and food-security/outbreak surfaces on the dashboard.

Flood probability, on an agreed empirical basis (the operator's directive:
implement the most functional defensible option, never invented coefficients):

- `open_meteo_archive` connector → `climate_observations`: one record per pilot
  district carrying the whole ERA5 daily precipitation series (1981 onward)
  from the keyless Open-Meteo archive, verified live 2026-10-02. Null days
  stay null; the record states that this is reanalysis, not gauge data, at a
  single point.
- `gdacs_archive` connector → `hazard_events`: GDACS historical floods (1985
  onward, Sub-Saharan Africa) via quarter-by-quarter archive walk, verified
  live. The upstream `eventtype` filter is accepted and ignored, so floods are
  filtered in-process; flood `severitydata` is a fill-in zero upstream and is
  stored as null. Both connectors run on demand (`regular: false`) so a
  default ingestion run never issues a 40-year crawl.
- `open_meteo_flood` connector → `climate_observations`: GloFAS v4 modelled
  daily river discharge per pilot district with a river reach, verified live
  2026-10-02 (Turkana non-null from 1997; Mogadishu/Juba have no reach and
  are refused as errors). `regular: false` backfill like the others.
- Discharge label variant for training: `POST
  /api/v1/flood-probability/train` accepts `label_source: 'glofas_discharge'`,
  labelling months where GloFAS discharge at the district's river cell is
  above its 95th-percentile of monthly maxima. The label percentile is a
  fixed definition, not a fitted parameter; the model card carries a
  `label_caveat` stating that the label is model-conditioned hydrology and
  the fit measures anticipation skill.
- `src/flood-probability.js` + `POST /api/v1/flood-probability/train` and
  `GET /api/v1/flood-probability/score`. Empirical rainfall–flood
  co-occurrence: month-grain contingency counts (Wilson intervals, lift over
  base rate) plus an L2-regularised logistic fit (full-matrix Newton with
  step-halving on collinear standardized rainfall features), validated
  leave-one-year-out (Brier vs always-base-rate skill). Hard refusals are part
  of the model: under 60 valid months, under 5 flood months, or all-one-class
  data return no probability. Every model and score carries its basis, sample
  counts, and the reporting condition — the label is *GDACS-reported*, so the
  probability is for a flood entering the archive, not for water reaching a
  given elevation. Basis and the rejected MERIT-Hydro/GEV route are documented
  in `docs/flood-probability-model-basis.md` (Status: agreed and implemented).
- Trained-model strip on the dashboard: per district, the base rate/skill card
  or the refusal text — a district with 34 months shows why it has no model.
- `docs/flood-probability-model-basis.md` rewritten from proposal to the
  implemented record; the validator's status check updated in the same change.
- `docs/outbreak-and-food-security-scoping.md` amended 2026-10-02: its "no
  keyless IPC feed" conclusion never checked HDX; the original verification
  record is kept, with the supersession stated.

### Fixed (storage)

Storage correctness. Six defects, all of which presented as working code.

- **`replaceAnalytics` dropped two derived collections on Postgres.** The method
  took four parameters where the caller passes six, so `population_at_risk` and
  `facilities_at_risk` — people at risk, facilities at risk — were computed,
  passed in, and never written. Impact-based forecasting worked on the JSON
  backend and was silently absent on Postgres, which is the default backend
  whenever `DATABASE_URL` is set. It also delegated to `merge()` where `replace()`
  was meant, so a region that stopped qualifying kept its last risk score
  forever, and the two backends disagreed about whether stale analytics survive
  depending on an environment variable.
- **`write()` disabled content-addressed dedup permanently.** `payload_hash` is a
  first-class column that `merge()` reads to skip re-ingested identical upstream
  data. The full-table rewrite path omitted it, so after a single `write()` call
  every stored hash read back `null`, no incoming hash could ever match, and
  dedup was dead for the life of the table — with no error anywhere, because a
  null hash simply never matches.
- **`JsonStore` lost writes under concurrency.** Every mutation is a
  read-modify-write of one file. Twenty concurrent merges left six survivors:
  each caller read the same snapshot and the last writer won. All mutations are
  now serialised through an in-process promise chain. Writes also go to a temp
  file and are `rename()`d into place, so an interrupted write leaves the
  previous store intact instead of a truncated JSON file.
- **Retention deleted nothing.** `POST /api/v1/maintenance/apply-retention`
  merged the surviving records back over the originals, and `merge()` keys on
  `id` — so the route reported `{success: true, expired: 1}` and every expired
  record stayed exactly where it was. Both stores gained `remove()`, the
  counterpart to `merge()`, and the route now calls it.
- **Ingestion reported failure on success.** `countRecords()` and
  `countRecordsByCollection()` named four collections while the merge accumulator
  handled six. `ipc_hdx` returns only `food_security_records` and `who_gho` only
  `disease_observations`, so both produced
  `degraded — Expected at least 1 records; received 0` on fully successful runs.
  An operator watching source health sees a healthy food-security pipeline as
  broken and learns to ignore the health signal that would have told them data
  was lost. All three consumers now derive from one exported
  `OUTPUT_COLLECTIONS` list, as do the run's `counts` and the per-run lineage
  record, which were separately truncated to the same four collections.
- **Two regression guards asserted on source text.** They read `src/ingestion.js`
  and checked that the string `food_security_records: []` was present — which
  tests the accumulator (correct) while the actual defect sat in `countRecords`
  fifty lines away, and which fails the moment the accumulator is refactored to
  derive from the shared list that *fixes* the bug. Replaced with behavioural
  assertions driven through stub connectors. No test covered retention at all,
  which is why that no-op survived; it is now covered at the HTTP boundary.

### Known limitations

- Flood depth is a static water-surface calculation: **no flow routing, channel
  geometry, or storage is modelled.** A water surface at *L* shades everything
  below *L* that is hydraulically connected, which in reality is only some of it —
  a closed basin below *L* does not become a lake. Every response carries this
  statement and the vertical resolution (±15 m, inherited from SRTM) so a caller
  can judge whether the question is answerable at their margin.
- ENSO output is **advisory strength, not a declared event.** CPC declares an
  episode only after ±0.5 °C holds for five consecutive overlapping three-month
  seasons; the connector reports how many consecutive seasons currently qualify
  and never asserts an episode from fewer.
- The ENSO connector reads the **ONI**. Per NWS Public Information Statement
  26-05, CPC now uses RONI for official ENSO monitoring, but RONI is not published
  as a stable keyless monthly feed, so reading ONI and labelling it RONI would be
  a fabricated capability. Recorded in each record's `index_used` and `index_note`.
- Rainfall intensity and duration to flood probability now **is** implemented,
  but only as the **empirical co-occurrence model** agreed in
  `docs/flood-probability-model-basis.md`, with hard sample-size refusals and
  reporting-conditioned labels. It is not a hydrological model: no return
  periods, no depth, no water-surface mapping. The Merit-Hydro/GEV route that
  would produce those remains blocked (MERIT unreachable and EULA-gated; no
  validated 36-year gauge discharge for the pilot basins).
- Landslide clearance is a **fixed 5 km radius** around the reported location,
  not a run-out model. It is a screening radius chosen to reflect that debris
  travels further than standing water, not a slope-stability or volume estimate.
  Treat it as "this road needs checking", not "this road is safe".

### Fixed

- **The flood risk model was scoring against an invented uncertainty band.**
  The Open-Meteo connector reads a *deterministic* forecast and has no ensemble
  members to report. It used to manufacture them: a spread of
  `0.25 + (1 - probability/100) * 0.75` was applied to the single point value to
  produce `p10`/`p50`/`p90`, published under exactly the field names a real
  probabilistic forecast uses. At a reported probability of 10% that made `p90`
  about **1.9x the observed precipitation**.

  The risk scorer preferred `ensemble_p90` over the point value, so every flood
  score was computed against an inflated number before being multiplied by
  `precipitation * 1.5`. 82 of 130 climate observations carried a synthesized
  band and 8 of 16 risk scores reported `ensemble_used`. Invented uncertainty is
  worse than none: it is indistinguishable from a calibrated ensemble downstream
  and it moves a number someone dispatches resources on.

  The connector no longer produces percentiles. Each observation states
  `model_limit: "Deterministic point forecast only; no ensemble members are
  produced."` and carries null percentiles. The scorer only prefers a percentile
  when `ensemble_source` identifies a genuine probabilistic forecast, and
  `drivers.ensemble_used` can no longer be raised by a synthesized value.
  GloFAS, which carries neither an extent nor an ensemble, published
  `ensemble_p10/p50/p90` of `0` — a certain forecast of zero rather than the
  absence of one; those are now null with their own stated limit.

- **233 of 280 hazard events were published to STAC at Null Island.** The STAC and
  OGC Features catalogues are what GIS tooling loads — QGIS, Earth Engine,
  planetary-computing clients — and `stacItem` guarded its coordinates with
  `Number.isFinite(Number(record.latitude))`. `Number(null)` is `0`, so every
  record that explicitly had *no* location passed the guard and was published with
  `geometry: Point [0, 0]` and `bbox: [0,0,0,0]`. 233 hazard events carry
  `latitude: null`; each was placed in the Gulf of Guinea. A FIRMS forest-fire
  notification for Indonesia with no coordinates became a point at 0,0.

  Coordinates are now read through a helper that treats null, blank and
  whitespace-only values as absent, the same way `toNumber` does after the
  field-report fix. A location-less record is published with `geometry: null`,
  `bbox: null`, `location_basis: "none"` and a `location_status` saying the source
  reported no coordinates — STAC permits a null geometry, and an honest absent one
  beats an invented point. Real points carry `location_basis: "point"` so a client
  can tell a measured position from a derived one.

  `computeBbox` returned `[0, 0, 1, 1]` for a collection with no coordinates —
  an extent in the Gulf of Guinea that no record occupied. The `spatial` extent
  key is now omitted rather than filled in.

- **District filtering reported no activity for collections that carry no
  location.** Interventions, their tasks and alert dispatches have no
  coordinates and no district field. Filtered directly they matched nothing, so
  `?district=Bor` returned 0 interventions while `/api/v1/districts/Bor` reported
  3 — the same district, two different answers, depending on the endpoint. A
  partner building a district view would have shown partners and responders an
  empty list next to a populated summary.

  They are now attributed through the record that does carry a location:
  interventions through their incident, tasks through the intervention, dispatches
  through the alert event. Every filterable list endpoint now agrees with the
  district overview it sits beside — Bor returns 2 incidents, 3 interventions, 5
  tasks, 6 service assets, 3 flood-risk and 3 conflict-risk scores, 10 field
  reports and 3 alerts, matching `/api/v1/districts/Bor` exactly. Note that
  `/risk-scores` is a STAC/OGC catalogue rather than a filterable list; the
  filterable risk endpoints are `/flood-risk` and `/conflict-risk`.

- **`?district=` on every list endpoint was a no-op that returned everything.**
  `filterRecords` ignores parameters it does not understand, and `district` and
  `region` were not among the ones it understood. `GET /api/v1/incidents?district=Bor`
  was byte-for-byte the same as no filter: all 8 records, including Aweil and
  Turkana. A caller that asked to be scoped to one district received every
  district's data with nothing to indicate the filter had been dropped.

  Both are now real filters. A record matches on an explicit district label where
  it has one — including multi-value labels such as `"Turkana, Bor"` — and
  otherwise on its position within the district extent. A record with neither is
  not in the district, which is the same rule report scoping uses, so the API and
  a report cannot disagree about what is in Turkana. A misspelt district now
  returns nothing rather than everything.

  This was the API half of the report scoping bug, still live after the report
  fix: the reports now count Bor's 2 incidents and Turkana's 3, and the endpoints
  return the same 2 and 3.

- **Every report was an empty document, and every district report contained the
  whole store.** `scripts/seed-demo.mjs` built reports with `normalizeReport`
  alone, which sets `section_ids` from the template and leaves `sections` empty.
  All six demo reports therefore rendered as a title and four metadata lines with
  no summary, no figures and no findings; their CSV and GeoJSON provenance
  appendix exported zero records; and `formatReportSmsSummary` found no metrics to
  read, so every SMS read *"0 incidents, 0 open alerts"* — a positive claim that a
  district was quiet, sent to the people meant to act on it. Two of these were
  marked `distributed` and one `approved`.

  Reports are now generated before their lifecycle status is applied, so they
  carry sections, source refs and warnings. A report with no sections cannot be
  approved or distributed: `approveReport` already refused, but POST and PATCH set
  `status` through `normalizeReport`, so a client could declare one `distributed`
  with no content and no warnings. The SMS summary now says a report is not
  generated instead of asserting zero, and an empty report renders a visible
  warning that it must not be used as a situation picture.

- **A district-scoped report reported global data as district figures.** `district`
  is not a key `filterRecords` understands, and it ignores unknown parameters
  silently, so a report scoped to `district=Turkana` fell through to *no filtering
  at all*: the Turkana Flood SITREP presented all 280 hazard events in the store —
  Indonesia, Brazil, Australia, Chad — as though they were Turkana's. Most
  collections carry no district label, so a district cannot be read off a record
  the way a country can. A district report now counts only records attributable to
  that district, using the district extent for geo-located records and its label
  otherwise, and reports how many records it excluded and why. Scope keys that are
  not supported filters are named in the report's warnings rather than ignored.

  Making the reports non-empty made this visible: the first regenerated Turkana
  SITREP confidently reported 280 events, which is the global total. It now reports
  what is attributable and states that 490 records carry no location or district
  label. Source freshness could not be assessed for any district either — all nine
  data-quality records are unattributed — and the reports say so instead of
  implying the sources are fine.

- **The CAP alert feed was placeholder content with a fabricated location.** CAP is
  the interchange format external alerting systems, EWS gateways and SMS providers
  consume. The generator read `headline`, `description`, `event_type`,
  `latitude`, `longitude`, `radius_km` and `lead_time_days`; an alert event
  carries none of them, so every field fell through to a default. Every alert
  published as *"Hazard Alert / A hazard alert has been issued"*, every urgency was
  `Immediate`, and the area was emitted as **`<circle>0,0 50</circle>`** — a 50 km
  circle at Null Island in the Gulf of Guinea, for an alert about Bor. It was valid
  XML in the correct namespace, so nothing failed: a downstream system would have
  placed every humanitarian alert this product can produce in open water.

  The feed now carries the real alert: headline and description from the alert's
  own message, the rule and the trigger (`metric value operator threshold`), the
  reviewed outcome where one exists, and a provenance line saying it is not an
  official forecast. The area is resolved from the alert's district to that
  district's real centroid and radius and labelled as a district extent; where no
  district exists no circle is emitted and the feed says the extent is not
  established. Urgency is derived from severity, a resolved alert is published as
  a `Cancel` so downstream systems retire it, and the null-island circle is
  impossible. Verified across all seeded alerts: 0 at (0,0), 0 placeholder texts.

- **"Warning-to-action median" was this platform's own SMS latency, presented
  against an external response-time target.** The figure is the median hours from a dispatch
  matching a signal to that dispatch being sent — how fast our own API enqueued an
  SMS. Warning-to-action in the field-response sense runs from a warning reaching a household to a
  field action being completed and reported, which this system does not observe at
  all. It was labelled "Warning-to-action median", annotated "target: <24h", showed
  0.16 h, and the quarterly PDF printed "warning-to-action < 24h"
  directly beneath the number. Read quickly, that is a system asserting it meets a
  humanitarian outcome target.

  Renamed to "Signal-to-dispatch median" everywhere — payload, dashboard tile,
  trend card, PDF row — with `warning_to_action_measure`,
  `warning_to_action_limit` and `warning_to_action_is_field_outcome: false`. The
  bid target is kept in the PDF as reference, explicitly separated, with a caveat
  that a low value does not mean the response was fast.

  The quarterly figure also carried a silent fallback: when no dispatch had
  `matched_signal_at` it switched to measuring hazard-observed to sent, so the
  same number could quietly change meaning depending on the data, and the monthly
  series had no such fallback. Both paths now use one helper and one interval; where
  the interval is unavailable the figure is null and says so, rather than becoming
  a different measurement under the same name.

- **The scenario workbench did not work at all.** "Run scenario" read `json.data`
  from a response that carries the scenario at the top level, so it threw on every
  run, rendered nothing and left all three delta cards on em dashes. A second
  mismatch — the markup had `impactBars` where the script looked for `impactsBars`
  — threw again partway through rendering and took the affected-assets table with
  it. Nothing caught either: the errors were caught and shown as text, so the page
  reported no console error and every check passed. The surface looked loaded and
  was entirely dead.

- **Scenario deltas were labelled "(mean %)" and coloured red.** They are score
  points, not percentages, and not modelled outcomes: the response carried no unit,
  no method and no limitation, so "+19.13%" read as a prediction that doubling
  rainfall raises flood risk by nineteen percent. The payload now carries `unit`,
  both means, the number of regions compared and a `model_limit`; the cards say
  "score change (mean points)" and the colour is dropped, because a higher
  sensitivity score is not by itself a worse outcome.

- **Every asset in the scenario table showed a fabricated +75 impact change.** The
  API never returned `baseline_impact_score`, and the UI computed
  `scenario - (baseline ?? 0)`. Assessments are now paired with their real baseline
  by asset, so the table reads e.g. "Aweil East Primary, school, Aweil, 48 → 75,
  +27", and rows are ranked by how far the scenario moved them rather than by an
  identical score. Type and Region were reading `asset_type` and `region_name`,
  which impact assessments do not carry, so both columns showed em dashes.

- **The CO dashboard reported a 0% false alert rate that meant nothing.** It was a
  keyword scan of free-text resolution notes (`/false|invalid|noop/i`) divided by
  the alert count. On the demo data that returned 0%, which reads as "no false
  alerts occurred" when it means "nobody wrote the word false" — none of the
  seeded resolutions ("situation stabilised", "temperature normalised") says
  whether the alert was warranted at all. A note reading "not a false alarm: wind
  damage" would have been counted as one.

  Alert events now carry an explicit `false_alert` determination (`true` / `false`
  / `null` for not determined, refusing anything else rather than coercing it to
  `false`). The rate is measured only over determined alerts, is `null` rather than
  `0` when none are, reports the reason as a data gap, and states its denominator
  and method. The seed records one genuine false alarm — an auto-approved heat
  alert that turned out to be a faulty sensor — and leaves one resolution
  deliberately undetermined.

- **The same metric contradicted itself on one screen.** The monthly series kept
  its own copy of the old scan, so the trend card showed a flat 0% while the KPI
  tile above it correctly showed a gap. Both paths now agree.

- **Sparklines filled gaps with zero**, so a month with no recorded outcome drew
  as a flat line sitting on the axis — visually identical to a month in which
  nothing happened. Months without a value are no longer plotted, and a lone
  value is a dot rather than a trend line.

- **Sanctions screening was invisible in the parametric UI.** The screening
  capability worked — a match blocks the disbursement — but the simulate form
  never sent the field that reaches it, so every simulation started from the
  dashboard was unscreened while the result panel showed a green "Simulation
  complete" for a 5,000 USD disbursement and mentioned screening nowhere. A
  reader could reasonably conclude the OFAC check had run. The form now collects a
  recipient name, the result panel states the screening outcome whatever it is,
  and the disbursements table has a screening column.
- `sanctions_screened` was a boolean, which made "nothing was screened because no
  recipient was supplied" and "the SDN list was unreachable" look identical to
  someone deciding whether a disbursement had been checked. It is now
  `sanctions_status`: `clear` or `not_screened`, with a reason on the unscreened
  case so it cannot read as a clean result.
- **Workflow transitions recorded every actor as "anonymous".** The handler read
  `req.__auth?.subject || 'anonymous'` and discarded the actor the caller supplied,
  so on an unauthenticated deployment nobody could tell who approved an
  anticipatory alert. Preferring the verified subject is still correct — a caller
  must not be able to claim an identity — but the claim is now kept and labelled:
  each transition records `actor_source` of `authenticated`, `claimed` or
  `unattributed`, matching the `actor`/`subject` split `actionLog` already used.
- **A CHW field report with no GPS fix was stored at (0, 0) — Null Island.** The
  CHW client used `{latitude: 0, longitude: 0}` as its "no location" sentinel in
  six places, including for the "here" button, so auto-detect and manual were
  indistinguishable whenever the fix failed. The server then wrote
  `body.location?.latitude || 0`, which turned a missing fix, an explicit null and
  a real zero alike into latitude 0, longitude 0. A disease signal that looks
  located while pointing at open water is worse than one with no coordinate:
  cluster detection and any "facilities near this report" join both treat it as
  real. Location is now nullable and self-describing: `location_source` says
  whether a fix was obtained, refused, timed out, or self-reported, and
  `location_accuracy_m` survives when there is one.

- **`toNumber(null)` returned 0.** `Number(null)`, `Number('')` and `Number([])`
  are all 0, so absence coerced to a real zero. Harmless for a threshold;
  not harmless for a coordinate — it meant the CHW fix above reappeared the moment
  anything updated or soft-deleted the report through the operational API, since
  the normaliser read those nulls and wrote 0. Null is now an absence and 0 is a
  value, with numeric strings still coercing.

- **A field report raised through `/api/v1/chw/report` could be listed but never
  updated or withdrawn.** It has no incident linkage by design — a health worker
  reporting a symptom does not know which incident it belongs to — and the
  normaliser re-checked that linkage on every mutation, so DELETE returned 400.
  A duplicate or mistaken disease signal could not be taken back. Linkage is now
  required at creation and not re-required afterwards. `normalizeFieldReport` also
  carries `category`, `status`, `source` and the location fields explicitly rather
  than relying on the store's shallow merge to preserve them.

- The browser check now walks the CHW symptom wizard end to end (82 checks, from
  78) and asserts the created report carries no fabricated coordinate and says how
  its location was determined. It cleans up after itself.

- **Payload hashing ignored record metadata, so connector corrections could never
  reach stored data.** `canonicalHash` passed `Object.keys(record)` as
  `JSON.stringify`'s second argument, which is a property *allowlist applied at
  every nesting level*: `metadata` survived as a key with every key inside it
  stripped, so a record's hash was identical no matter what its metadata said.
  `mergeById` skips an incoming record whose hash already exists, so any change
  confined to metadata was silently discarded on re-ingest. Connector metadata is
  where the qualifications live — `model_limit`, `episode_declared`,
  `geolocation_note`, `index_note` — so the one thing that must be able to change
  was the one thing that could not.

  Found because the seasonal strip reported "0 of 5 overlapping seasons" while
  `classifyNino34` computed 3 on the live feed and the connector emitted it: the
  field had never reached the stored record. Now canonical JSON with keys sorted
  at every depth, stable under reordering at any depth. The strip reads
  "3 of 5 seasons" with three pips filled, matching the computation, and
  `episode_declared` stays false because three is not five.

### Changed

- `?bbox=` now returns events the source reported as an **area** overlapping the
  box, not only events with a point inside it. GDACS reports most events as a box
  and the connector withholds a point when that box is regional, so a point-only
  filter told a caller asking about a district that nothing was there for hazards
  the source had explicitly placed there.
- The map requests the operational area and recent global events as two separate
  queries. It previously requested only the 50 most recent events worldwide, which
  with GDACS and USGS both live is always the same Pacific and Caribbean
  earthquakes: the seeded flood and landslide that the road-access and routing
  walkthrough depends on were paginated out and never drawn.
- The **OpenAPI contract now covers 93 paths / 118 operations**, up from 63. It
  was missing 26 documented endpoints: equity by district and breaches, the
  equity scan, parametric rules and disbursements, webhooks, community feedback
  and its summary, quarterly KPIs, data lineage, the connector catalog,
  scenarios, trigger-protocol backtest and shadow-run, outbox dispatch,
  retention, bias correction, and the CHW report and reply routes. All 26 were
  real and reachable; they simply were not in the contract, so a technical reader
  could not discover them or generate a client. `info.version` also said 0.1.0
  while the package was at 0.2.0.
- The flood-probability build guard now scans **documentation, the OpenAPI
  contract and the dashboard markup**, not just `.js` files, and matches prose
  phrasings as well as identifiers. A flood probability asserted in the contract
  or a UI label is the claim a panel would act on; previously such a claim could
  be added anywhere outside a `.js` file and pass. Two documents that exist to
  discuss the constraint may name the terms, by explicit list.
- `GET /api/v1/health` now reports **`version`**, read from `package.json` at
  startup and fatal if unreadable — a wrong version is worse than a missing one.
  The footers in the partner portal, the CHW app and the Settings panel source it
  from there instead of carrying their own literal, which had drifted: three
  copies of an older release, including one in a translation file, all reporting
  a build that was not the one running.
- The browser check now runs at a **1440x900 laptop viewport**. It previously
  inherited headless Chrome's default of about 756x469, which is the mobile
  breakpoint: the console is a single column and the rail is full width. Every
  layout assertion therefore ran against a layout no panel will see.
- The **equity table overflowed the 360px rail** on a laptop, and the last
  column — "Not acknowledged", the one that says who was not reached, on the
  surface whose purpose is that — was clipped behind `overflow-x: hidden` and
  unreachable. Headers now wrap and cells are right-aligned with tabular figures
  so the table fits. Confirmed to fail without the change.
- Planning a route now **frames the map on that route**, the way a flood
  simulation frames on its extent. The Lodwar corridor is four roads inside six
  kilometres, so a region-wide frame collapsed the reroute into one unreadable
  cluster. The frame is derived from the returned hops, not the requested
  endpoints, because a plan that detours around a cut segment passes through
  neither. Clearing the route returns the region frame.
- The map has a **minimum rendered height**. `.map-container` is a flex column
  that also holds the seasonal strip, filters, flood controls and routing panel,
  so `flex: 1` gave the map only the leftover space: on a 1440x900 laptop it
  rendered at 195x122 with 82% of the width unused and legend text at 2.4px. The
  cells were present in the DOM, so every assertion passed while the map was
  effectively invisible. `.map-section` now scrolls instead of clipping.
- The flood status line reports the inundated area in km² and names the box the
  percentage is a share of, stating that it is not a share of the district. It
  previously read "40% of the area", which invites reading 40% of the district as
  underwater.
- Landslide hazards now render with their own class and appear in the map legend.
  `.hazard-landslide` was declared in CSS but no code path ever applied it, so a
  landslide fell through to the generic marker and looked like any other event
  even though road-access models it differently from flood.
- GDACS parsing reads namespaced RSS tags by local name and extracts event type
  codes, bbox, and country. The previous literal-prefix match returned null for
  all three.
- **Risk score bands renamed to say what they are.** `score_p10` / `score_p50` /
  `score_p90` / `interval_width` are a *sensitivity range driven by input
  coverage*, not quantiles of a predictive distribution. A well-populated region
  returned `p10 == p90` with `interval_width: 0`, which reads as certainty while
  actually meaning inputs were sufficient. Responses now carry
  `sensitivity_low` / `_mid` / `_high` / `_width`, `calibrated_uncertainty: false`,
  and a `limits` string. The old names remain as aliases with identical values,
  so stored records and consumers keep working. No calibrated bands ship with
  this release and no Brier/CRPS calibration report exists.

### Fixed

- **Three connectors reported success while ingesting nothing.** CHIRPS matched
  filenames against a product index that now lists year directories, so the
  pattern matched zero times. GloFAS's published RSS URL serves the EFAS web app,
  so the parse found no items. NASA FIRMS has no keyless access and the
  placeholder key returned HTTP 400 per region while the catalog claimed no
  credentials were needed. Each now reports an error instead of an empty success,
  and their fixtures reproduce the real upstream responses.
- **A source returning zero records can no longer report `success`.**
  `minimum_records` was 0 on four regular sources, so an empty parse passed the
  health check as fresh. Every regular public source now declares a floor of 1,
  verified against live record counts first. User-supplied sources keep a floor
  of 0, since uploading an empty CSV is a legitimate operator action.
- **Country-scale hazard bboxes no longer block distant roads.** A GDACS green
  flood alert for France arrived with a bbox spanning ~40°, and bbox containment
  is authoritative in the road-access matcher — every road in the Horn of Africa
  came back restricted by an alert 2,051 km away. Only hazard-scale boxes
  (≤5°, ~555 km) may block on containment; wider ones fall back to proximity
  matching around the reported centre.
- `POST /api/v1/routing/plan` rejects coordinate objects with an error naming the
  problem. They previously produced "Unknown origin or destination road", which
  is indistinguishable from missing data.
- The demo seed reports a degraded source as degraded. `runIngestion` does not
  throw for one, so every source was labelled "ok".

## v0.2.0 - 2026-10-01

Hardening pass focused on operational integrity and payment compliance. No breaking
API changes; all additions are additive.

### Added

- USGS real-time earthquake ingestion (`usgs_earthquake`), emitting `hazard_events`
  so existing risk scoring and alerting pick it up unchanged. Follows the connector
  spec and is registered in `schema.js`, `ingestion.js`, and `connectors.registry.json`.
  Offline fixture tests cover parsing and upstream failure.
- OFAC SDN sanctions screening on parametric disbursement simulation. A match returns
  HTTP 409 and records nothing; clean screens are stamped on the disbursement so an
  audit can distinguish screened from unscreened payments. Name-based only — see
  Limitations in `docs/parametric.md`.
- `DELETE` on operational collections with soft-delete semantics. Records are stamped
  `deleted_at` / `deleted_by` rather than removed, so action-log history and
  referential links survive. Hidden from lists and `GET` unless `?include_deleted=true`;
  writing to or re-deleting a deleted record returns 409.
- Request body size cap (5 MB default, `LINDELA_LITE_MAX_BODY_BYTES`) returning 413,
  and 400 with a clear message for malformed JSON.

### Changed

- PostgreSQL `merge()` now upserts only the request's records instead of
  `DELETE`-ing and reinserting the whole table. Ten single-record merges against
  5,000 rows: 23,515 ms → 201 ms. `payload_hash` moved to an indexed column and
  backfilled from existing bodies on startup, so upgrades keep dedupe working.
- `operationalSummary()` and `counts()` exclude soft-deleted records, so
  `/api/v1/health` and `/api/v1/operations/summary` agree.

### Fixed

- USGS connector used an endpoint that returns HTML rather than JSON; every live
  ingest failed to parse. Now uses the `feed/v1.0/summary` GeoJSON paths.

## v0.1.0 - 2026-05-18

Initial public release candidate for Lindela Lite.

### Added

- Public climate, hazard, fire, flood, service-asset, and optional conflict CSV ingestion.
- Baseline flood risk, climate-conflict risk, and service-impact scoring.
- JSON, pg0, and external PostgreSQL storage modes.
- REST API, CSV export, GeoJSON export, and static dashboard.
- Service asset import endpoint and dashboard CSV/GeoJSON import controls.
- OpenAPI contract, storage docs, contribution docs, security policy, and trigger protocol examples.
- CI workflow with Node 20/22 and PostgreSQL integration coverage.

### Excluded

- GDELT ingestion.
- WorldMonitor code.
- Proprietary Lindela fusion, calibrated models, report management, wargaming, classified workflows, and source reputation systems.
