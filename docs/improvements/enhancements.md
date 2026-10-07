# Thirty high-impact enhancements

Each entry names the evidence, the change, the value to a user, and what it
deliberately does **not** license. Effort is rough: S is under a day, M is a
week, L is a multi-week change. Defects referenced as `SEC-01`, `DATA-04` and so
on are in [defects.md](defects.md); supporting evidence is in [_research/](_research/).

The ordering is a sequence, not a ranking. Groups A and B make the numbers
defensible, C makes them legible, D makes them actionable, and E stops the whole
thing from rotting again. Building C before A produces prettier pictures of
numbers that are still wrong.

---

## Group A — Trust: make the honesty reach the payload

The project's deepest asset is that it refuses to overclaim. `flood-probability`
publishes measured negative skill rather than hiding it, risk bands were *renamed*
so they would not read as quantiles, alerts carry `false_alert: null` so the KPI
can say "not yet measurable" instead of a confident zero. That discipline lives in
prose and in `scripts/check-no-flood-probability.mjs`. It does not live in the
response bodies. Of 28 numeric outputs, 13 carry a qualification in the docs that
never reaches the API caller. A user integrating this reads the number; only a user
reading the source reads the caveat.

### ENH-01 — Deny-by-default authorization from an explicit route→scope table

**Evidence.** `src/auth.js:66-79` special-cases five prefixes and returns
`read:hazards` for everything else. **Reproduced:** a read-only token got 201 on
`community-feedback`, `webhooks`, `chw/reply`, `outbox/dispatch` and `equity/scan`,
and 200 on `maintenance/apply-retention` (SEC-03). `src/server.js:229` gates the
whole auth block on env vars being set, and `src/auth.js:13` returns `[]` on a JSON
parse error, so a typo disables auth silently (SEC-04).

**The change.** One exported `ROUTE_SCOPES` table listing every mutating route and
the scope it requires. Lookup returns nothing for an unlisted route, and the
handler refuses. Auth becomes fail-closed on unset config, and `GET` stops being
a free pass (SEC-01). `/api/v1/health` reports the current auth posture so an
operator can see it without reading code.

**Value.** The security perimeter becomes checkable: a test can iterate the table
and assert every entry exists, and a second test can assert no route in
`server.js` is missing from it. Today neither is possible, which is why three
unauthenticated-mutation paths shipped.

**Does not license.** Nothing about the model. **Effort:** M. **Depends on:**
nothing; do it first.

### ENH-02 — Honesty envelopes on every numeric response, policed in CI

**Evidence.** `src/server.js:583` returns a bare `probability`. The model computes
a Wilson interval and a contingency table and both stay on the server. DATA-01,
DATA-02, DATA-05, DATA-06 and DATA-07 are all cases where the payload is more
confident than the code that produced it.

**The change.** A standard envelope on analytics responses:

```json
{ "value": 0.62,
  "limits": { "kind": "empirical_cooccurrence", "not": "hydrology",
              "calibrated_uncertainty": false,
              "sample": { "months": 84, "events": 11, "minimum_required": 60 } },
  "evidence": { "source_ids": ["gdacs_archive:..."], "basis_doc": "...",
                "retrieved_at": "2026-10-02T11:04:00Z" },
  "not_included": ["reporting bias", "gauge observation error"] }
```

Then extend `scripts/check-no-flood-probability.mjs`, which already polices
capability vocabulary across `src/`, `public/`, `scripts/`, `test/` and `docs/`,
to also assert that any route returning a probability also returns a `limits`
object. The gate already exists; it is missing one rule.

**Value.** The caveat travels with the number. An integrator who never opens the
docs still cannot mistake an empirical co-occurrence rate for a hydrological
frequency estimate,
because the response says so in the response.

**Does not license.** A wider claim. It makes the existing narrow claim survive
contact with an API consumer. **Effort:** M.

### ENH-03 — Per-region calibration and a trust score

**Evidence.** `false_alert` is tri-state and `null` means "not determined"
(`docs/architecture/system-overview.md` §7). That honesty is the right default, but
it is currently permanent: nothing in the codebase ever joins an alert to its
outcome and computes the rate.

**The change.** An `alert_outcomes` collection recording, per alert event,
whether it was a true positive once resolved. Join to `alert_events` per district
to produce a Wilson interval on the false-alert rate, then a `trust` score per
region that weights calibration, sample size and data coverage. Surface it on the
district and equity surfaces, and keep `null` for regions still short of data.

**Value.** The single largest `null` in the platform becomes a measured quantity
for the districts that have enough history, while the districts that do not keep
the honest unknown instead of a fabricated zero. This is also what turns
`README.md`'s "decision support, not an automated command system" from a policy
into a number a focal point can check.

**Does not license.** An auto-joined outcome set measures *reporting* rate, not
false-alert rate: an alert nobody bothered to resolve counts as unknown, not as a
miss. Ship the join as reporting rate first, and say so in the field name.
**Effort:** L.

### ENH-04 — Three tiers of uncertainty on every number

**Evidence.** The model already publishes Wilson intervals on contingency counts
and has a Hessian-style fit, but the payload carries none of it (DATA-02).

**The change.** Every probabilistic output gets three distinct, separately named
tiers:

- **Model** — parameter uncertainty from the fit.
- **Sampling** — Wilson interval on the contingency counts, plus an *effective* n
  corrected for the serial correlation that overlapping 90-day windows introduce
  (`src/flood-probability.js:338`, `:509` currently treat them as independent).
- **Coverage** — a named list of what the number does not represent.

**Value.** Turns "62%" into something an operator can act on: *"between 51% and
72% from 84 months of which 11 had floods, and this excludes reporting bias."*
That is the difference between a number and a decision.

**Does not license.** Never name these `p10`/`p90`. A model interval is not a
predictive interval, which is the exact confusion the rename of the risk bands was
fighting. **Effort:** M.

### ENH-05 — Model-drift monitoring

**Evidence.** `freshnessPenaltyFor` already exists as a data-age concept; nothing
watches the *model*.

**The change.** On each scoring run, compare the stored coefficient vector and
standardisation parameters against the most recent training run. Past a threshold,
attach a `drift` flag to every score and record a `model_drift_events` entry. Add
a `/api/v1/model-drift` endpoint.

**Value.** Silent drift is the failure mode of every deployed statistical model.
The archive backfill means these coefficients will move substantially as the GDACS
archive and GloFAS discharge labels grow. Without monitoring, a district's risk
changes because the training window changed and nobody can tell why.

**Effort:** M.

---

## Group B — Ingestion fidelity, quality, timeliness

The connectors are careful and well-commented, and their refusals are the best
code in the repository. The failures are structural: nothing distinguishes a source
that is *quiet* from one that is *broken*, and five sources re-download their entire
history on every run.

### ENH-06 — Freshness SLAs by cadence, with an `ok | quiet | stale | broken` verdict

**Evidence.** Four conflicting freshness systems: `SOURCE_POLICIES` staleness
windows, connector-local logic (`who-gho.js:134`, `ipc-hdx.js:217`), the summary
staleness verdict, and a global 2/14/45-day clock at `src/analytics.js:454`. ING-09.
`minimum_records: 1` applies to every source regardless of cadence, so a quiet
GDACS week raises a false alarm (ING-10 in the research files).

**The change.** Each source policy gains `cadence_days` and `min_expected_delta`.
The health endpoint reports one verdict per source: `ok` (new data on schedule),
`quiet` (nothing new, which for an event feed may be correct news), `stale`
(overdue against cadence), `broken` (fetched and failed, or assertions tripped).
Annual WHO series and daily rainfall get honest signals instead of both being
judged by a two-week clock.

**Value.** Source health stops being an alarm that operators learn to ignore, which
is what DAT-02 makes worse. It also fixes the current situation where a working
food-security pipeline reports `degraded` and a dead one may report the same.

**Effort:** M.

### ENH-07 — Per-source data assertions with quarantine-on-fail

**Evidence.** GloFAS detects a feed that has become a web app; CHIRPS detects a
raster index with no daily files; FIRMS detects a missing key; WHO detects a
silently-emptying query. Four hand-written guards for four specific breakages. A
partial break matches none of them.

**The change.** A declarative assertion map per source: expected field presence,
coordinate plausibility for the source's geography, plausible value ranges,
expected record count relative to the trailing window, monotonic dates. Failures
quarantine the batch into `quarantine_<collection>` with the failed assertion
attached, rather than publishing it or reporting zero. `counts_found` gets recorded
wherever a cap is applied (ING-08).

**Value.** Catches the class of failure record counts never will: a connector that
returns 4,000 of 40,000 expected rows parses cleanly and reports success. Given
that the GDACS archive silently caps at ~100 results per query, this is the single
most effective fidelity improvement available.

**Effort:** M.

### ENH-08 — Watermarks, incremental fetch, resumable backfill

**Evidence.** `open-meteo-archive` and `open-meteo-flood` re-download their whole
history every run and mint a new id daily because `endDate` defaults to today
(`open-meteo-archive.js:73`, `open-meteo-flood.js:81`, ING-04). That is ~16,000
records per region per day, per source, none of it new.

**The change.** Per-source watermark state (`last_success_at`, `last_cursor`),
persisted. Connectors fetch only what is new. Backfills become resumable jobs with
progress, so a district server that loses power mid-backfill continues rather than
restarting.

**Value.** Directly reduces the failure ENH-07 would otherwise start catching: a
daily re-ingest of a 40-year archive is the main way ingestion fails, and the main
way it produces duplicate history.

**Effort:** L.

### ENH-09 — Source-agreement cross-validation

**Evidence.** Two independent precipitation products are already ingested and
never compared: CHIRPS blended satellite rainfall and Open-Meteo ERA5 reanalysis.
Downscaling (`src/analytics/downscaling.js`) consumes both and is currently
degenerate with a single station (DATA-22 in the research files).

**The change.** A minimal GeoTIFF reader (inflate plus a small tag parser) to decode
CHIRPS rasters, then a per-district-month agreement check between CHIRPS, ERA5 and
any uploaded gauge. Report Pearson and rank correlation, mean absolute difference,
and sign disagreement rate. Where the two disagree beyond a threshold, mark the
month `disputed` and say so wherever it feeds a score.

**Value.** This is the largest genuine fidelity gain available, and it is honest in
a way that raising confidence is not: disagreement between independent products is
evidence about how much to trust the number. It also replaces the volume-based
bonus in `computeDataQuality` (ENH-10) with something that means something.

**Does not license.** Resolving the disagreement automatically. Disagreement is the
finding; picking a winner is a separate judgement. **Effort:** L.

### ENH-10 — Connector health scoring and circuit breaking

**Evidence.** `failure_streak` is computed and never acted on. A dead source is
retried in full on every run-due tick.

**The change.** Open a circuit after three consecutive failures; half-open with a
single probe; report `skipped_circuit_open` distinctly from `ok` and from `broken`.
Score each connector on success rate, latency and payload drift against its trailing
window.

**Value.** Makes ENH-06's `broken` verdict actionable, and stops a dead provider
from consuming the wall-clock budget that the healthy ones need (ENH-11).

**Effort:** S.

### ENH-11 — Enforce the rate limits that are already declared

**Evidence.** Every connector declares a `rateLimit`. It is honoured nowhere. IPC
fans ~92 concurrent requests against a documented 20/min budget
(`src/connectors/ipc-hdx.js:265`). `distributeReport` and the RapidPro client have
no timeout at all. There is no rate limiting on the API itself (SEC-07).

**The change.** A token bucket and concurrency cap inside
`src/connectors/http.js`, jittered, honouring `Retry-After` (currently discarded at
`http.js:6`). A per-source wall-clock budget so one slow archive cannot hold a
request socket for the ~4.2 hours `gdacs-archive` can currently reach (ING-06). An
API rate limiter per token.

**Value.** Protects both the upstream provider and this server. The declared
`rateLimit` fields are documentation that currently misleads whoever reads them.

**Effort:** M.

### ENH-12 — Raw payload retention, replay, and fixture seeding

**Evidence.** Every parsing defect in this repository's history — the GloFAS feed
becoming a web app, the CHIRPS index losing its year directories, the WHO endpoint
silently emptying on `$top` — was diagnosed by hand against a live response.
`test/fixtures/` holds seven hand-assembled fixtures that cannot be regenerated.

**The change.** Capture every fetch body under a content hash with retrieval
metadata, behind a retention window. A `replay` mode runs any connector against
captured payloads. A script seeds the fixture suite from captures.

**Value.** Connector parsing becomes testable against the responses that actually
broke, rather than against fixtures shaped by the same assumptions as the parser.
In a district deployment with intermittent connectivity this is also the difference
between a fix that holds and one that regresses on the next provider format change.

**Effort:** M.

### ENH-13 — Bitemporal records

**Evidence.** GDACS, USGS, WHO and NOAA CPC all revise records in place. Because
`write` and `merge` overwrite by id (DATA-12 also means a re-submission is not
even the same id), the prior value is unrecoverable.

**The change.** Keep `valid_from`/`valid_to` alongside `observed_at`, so "the 2019
cholera count changed from 1,204 to 1,388" becomes a queryable fact rather than a
lost one.

**Value.** For a tool whose product claim is auditability, a silently corrected
historical figure is a serious liability. A donor asking what the tool said last
quarter currently has no answer.

**Effort:** L.

### ENH-14 — Completeness tripwires for capped pagination

**Evidence.** The GDACS archive caps results at roughly 100 per query, and a
capped quarter is currently indistinguishable from a complete one. `CHIRPS` caps
730 files to 30 without recording `counts_found` (ING-08).

**The change.** Each paginated source records pages fetched, records seen, whether
the provider reported a total, and whether the last page came back full. Any source
whose last page is exactly full is flagged `possibly_incomplete`.

**Value.** Turns a silent truncation into a visible one. Small change, and it
removes a whole category of "the model was trained on half the data and nobody
knows".

**Effort:** S.

### ENH-15 — Record-level provenance with real transform versions

**Evidence.** `src/lineage.js` is implemented, tested, and wrong. `src/ingestion.js:181-188`
rebuilds a run-wide union inside the per-source loop, so a nine-source run writes
nine identical lineage rows. `upstream_url_or_endpoint` is always null and
`transform_version` is a constant. IPC and WHO are excluded entirely.

**The change.** A `_provenance` envelope per record: `source_run_id`, connector id
and version, retrieval URL and time, payload hash, transform version derived from
the code that actually transformed the row, and the upstream record identifier.
Wire it into every connector including IPC and WHO.

**Value.** This is roadmap item 5, and it is still genuinely open. Auditability is
the difference between decision support and shadow IT, and it is a donor-facing
requirement.

**Effort:** M.

---

## Group C — Visualization depth

**Evidence for the whole group.** There is no charting layer. No charting library,
no `<canvas>`, no reusable chart component anywhere in `public/`. The complete set of
graphics primitives in the product is 39 `svgEl()` calls inside `public/app.js` (the
situation map), one 30×40 px inline `<polyline>` sparkline at `public/co/app.js:308`,
one CSS-div bar chart at `public/co/app.js:234`, and a pair of pixel-height `<div>`s
at `public/scenarios/app.js:342`. `public/app.js` — 3,059 lines, the largest file in
the repository — is map rendering with a single `svgEl` helper at `:940`.

Seven of eight surfaces show no chart of anything. What they show instead is a text
strip: a `<span>` holding a sentence. The visualization ceiling is not a styling
problem; it is that the thing the work needs to build does not exist yet, which is
why ENH-16 is first and why the rest of this group is composition rather than
invention.

### ENH-16 — A chart component library, shared by all eight surfaces

**Evidence.** One surface has charts. Seven duplicate the small number of shared
primitives (number formatting in `public/shared/fmt.js`, status tiles, empty and
loading states) and none can reach for a common chart.

**The change.** Extract the four `public/co/app.js` chart functions into
`public/shared/charts.js`, built on the existing `svgEl` helper, and add the
missing primitives: line with optional uncertainty band, stacked bar, categorical
bar, month×year heatmap, and small-multiple grid. Every chart takes a data array
and options, renders an accessible `<table>` sibling, and takes its palette from
`tokens.css`.

**Value.** Makes the next seven items a matter of composition rather than
invention, and means an accessibility fix lands on all eight surfaces at once.

Two existing behaviours are worth preserving deliberately when this lands.
`loadFloodProbabilityModels` (`public/app.js:768`) already keeps districts that
*refused* rather than hiding them, because "this district has 40 months, not the 60
required" is actionable and a blank strip is not. That instinct is right and the
small-multiple grid should generalise it. But the same function reduces every
trained district to the single best `skill_over_base_rate`, discarding the base
rate, the month count and the spread. Small multiples are exactly the fix: eight
districts side by side, each with its sample size, beats one headline district.

**Effort:** M. — **SHIPPED** (2026-10-03).

**What shipped.** `public/shared/charts.js` and `test/charts.test.js` (49 tests).
Five primitives — `lineChart` (with an optional uncertainty band), `barChart`,
`stackedBar`, `heatmap`, `smallMultiples` — plus `sparkline` and the scale
helpers they rest on (`extentOf`, `scale`, `ticks`, `completeness`).

Two design decisions worth recording, because they are the reason the tests can
run without a browser:

- **Every function returns strings, not DOM.** A component library would have
  needed jsdom or a live page; a string-returning one is testable by asserting on
  what was drawn, which is the same reason `public/shared/map-frame.js` and
  `evictionPlan` in `public/sw.js` are pure. Same constraint, same reason.
- **The SVG is `aria-hidden` and always ships a `.chart-table` sibling.** Not a
  nicety: the SVG's `role="presentation"` and the table's contents are two
  statements about the same data, and if one can drift the other is the
  authoritative copy. Every chart returns `{svg, table, label, missing, total}`.

**Two surfaces are wired.** `public/co/app.js` drops its private `<polyline>`
sparkline and its CSS-`<div>` histogram — the only two charts that existed
anywhere — and calls the library. The `#histogram-data` container went with
them: the chart's own table replaced a second place to keep in sync.
`public/app.js`'s `loadFloodProbabilityModels` now renders small multiples instead
of reducing eight districts to one headline.

`public/scenarios/app.js` keeps its delta bar. It is a *diverging* single-value
chart around a zero rule, which is not one of the five primitives and which the
library has no honest way to express without losing the zero anchor; replacing a
correct chart with an approximation is not a consolidation.

**One behaviour changed rather than being carried across.** The CO sparkline
filtered nulls out and connected what remained, so `[10, null, 30]` drew a line
through a month nobody measured. It breaks the line at the gap now, as
`lineChart` always did. `test/lite.test.js`'s existing guard for this asserted on
the *source text* of `public/co/app.js` and would have gone on passing against a
file that no longer contained the behaviour — it calls `sparkline` instead.

### ENH-17 — Render uncertainty as geometry, not as a footnote

**Evidence.** ENH-02 and ENH-04 produce intervals in payloads. Nothing draws them.

**The change.** Every probabilistic chart renders its interval as a visible band
or whiskers, and `not_included` as a caption directly under the chart. Map layers
gain an uncertainty mode: at lower confidence, reduce opacity and hatch the
polygon rather than flattening it.

**Value.** Of everything in this group, this changes what a user can tell at a
glance, because it
makes the project's central virtue legible. A hatched, faded polygon reads as
"uncertain" instantly and without a legend. Today a user cannot tell a
well-supported score from a thin one by looking at it, only by opening the JSON.

**Effort:** M. **Depends on:** ENH-02, ENH-04.

### ENH-18 — Time-slider playback of hazard history

**Evidence.** Hazard data is deeply historical — the GDACS archive reaches 1985,
ERA5 reaches 1981 — and every surface shows it as a single current-state map.

**The change.** A scrubber that replays hazard extent, rainfall and alerts across
time, with a play/pause and a speed control. Frame rendering reuses the existing
map pipeline.

**Value.** Emergency operations is a temporal problem. Seeing a flood spread and
recede, and watching the alert cadence track it, is worth more than any static
improvement to the current map.

**Effort:** L.

### ENH-19 — Map → chart → record drill-down, with a `/explain` endpoint

**Evidence.** `src/server.js:835` shows `calibrationReport` is computed and never
routed. No endpoint traces a score back to its inputs.

**The change.** Clicking a map feature drills to a time series, then to the
underlying records. Alongside it, `GET /api/v1/explain/:kind/:id` returns every
contributing term with its coefficient and points contribution, so a risk score
can be read as an equation.

**Value.** Converts a score into something a focal point can argue with, which is
what "decision support" means. It also gives ENH-02's `evidence` block a UI.

**Effort:** M.

### ENH-20 — Month × year seasonal calendar heatmap

**Evidence.** `public/shared/seasonal.js` exists and has exactly one consumer.
The console already fetches 200 climate records on every poll
(`public/app.js:1627`, `load('climate', '/api/v1/climate?limit=200')`) and uses
almost none of them: the seasonal strip shows one summary, and the per-month
distribution that would make a heatmap possible is already in the browser and
already paid for.

**The change.** A month×year matrix per district, cell-shaded by departure from the
climatological median for that calendar month, with the missing-data case drawn as
absent rather than as zero. Overlay flood months and alert months on the same grid.

**Value.** The clearest available picture of *changing* rainfall risk, which a
single current-state map cannot show. Because the data is already fetched, this is
close to free once ENH-16 lands. Departure-from-climatological-median is the right
framing and keeps the model within its agreed basis.

**Effort:** M.

### ENH-21 — Forecast-versus-observed verification charts

**Evidence.** `src/connectors/open-meteo.js` ingests both forecasts and
observations, and nothing ever compares them. `src/analytics/ensemble.js` exists,
is dead (no connector sets `ensemble_*`), and would have needed exactly this.

**The change.** Reliability diagrams per lead time: forecast probability against
observed frequency, with sample size per bin. Apply to seasonal forecasts as well,
using the Niño 3.4 record already parsed in full by `noaa_enso`.

**Value.** Converts a forecast from a number into a *measured* number with a
measured skill. For an anticipatory-action platform this is the difference between
"we publish a forecast" and "we publish a forecast and here is its verified skill,
which is negative in this basin and month".

**Effort:** L. **Related:** this is what would justify preferring `ensemble_p90`
over a deterministic run, and what would rescue `ensemble.js` from deletion.

### ENH-22 — Offline-first drill-down and cached map tiles

**Evidence.** `public/sw.js:219-287` precaches the module graph and queues writes
via IndexedDB. `README.md` is explicit that the CHW works on a shared phone with
no signal. Three defects sit here: the precache list omits two modules of the
console's own import graph, which is a hard boot failure offline rather than a
degradation (WEB-06); the offline queue acknowledges a submission it discarded
(WEB-05); and API responses are not cached, so any drill-down returns nothing.

**The change.** Verify the precache list against the actual import graph in CI, so
an omitted module fails the build. Make the queue acknowledge only what it has
actually persisted, and tell the worker otherwise. Cache the last N successful
`/api/v1/*` responses for drill-down, and add a tile cache for the district's own
extent so the map renders offline rather than degrading to an empty frame. Show an
explicit "last synced" indicator with the staleness of each panel.

**Value.** Offline is not a feature here, it is the operating condition. A CHW who
opens a drill-down and gets nothing has learned not to open drill-downs — and a CHW
who is told a report was filed when it was not has lost the one thing the platform
exists to provide.

**Effort:** M.

### ENH-23 — Colourblind-safe and high-contrast themes

**Evidence.** `public/tokens.css` is OKLCH and dark-only. The map encodes hazard
type and severity by colour alone, with no secondary encoding (WEB-04).

**The change.** Add a deuteranopia/protanopia/tritanopia-safe palette checked
against all three, a high-contrast mode, and secondary encoding — pattern and
shape — on every severity class so colour is never the sole carrier. Audit
contrast ratios in both themes.

**Value.** Roughly 8% of men have a colour vision deficiency, and a district
operations wall display is exactly the place that gets read by many people in a
cramped room under bad light. Severity is the one thing on that screen that must
never be misread, and today a reader with deuteranopia misreads it.

**Effort:** M.

### ENH-24 — Shareable, deep-linked, per-role dashboard state

**Evidence.** Eight surfaces, none of which encodes view state in the URL.
`public/shared/runtime.js` centralises API access but not view configuration.

**The change.** Filters, map extent, time window and selected feature all encode
to the URL. Each role gets a saved default view. A share link reproduces exactly
what the sender was looking at.

**Value.** Decides arguments by link instead of by screenshot, and lets a focal
point hand an analyst the exact view they are describing. Cheap to build, and it
multiplies the value of every other visualization item here.

**Effort:** M.

---

## Group D — Response and delivery

### ENH-25 — Bulk upload with a validation report

**Evidence.** There is no bulk upload anywhere in the system. No multipart, no
`FormData`, no `<input type="file">` on any of the eight surfaces.
`src/connectors/uploads.js:52-57` expects CSV as a **string pasted into a JSON
body**. No surface mentions `multipart` in the entire frontend.

**Why this is first in the group.** A district officer with a 4 MB ACLED export or
a year of rainfall CSVs has no path in. This is the hardest adoption blocker in the
platform and it is not on any existing roadmap.

**The change.** `POST /api/v1/upload` accepting multipart, streaming to disk
rather than buffering, with a dry-run mode that returns a row-level validation
report — required columns, date parse failures, coordinate bounds, duplicate
detection — before anything is written. A client-side CSV picker on the districts
and scenarios surfaces.

**Value.** Converts the platform from "you must already have your data in this
exact JSON shape" to "bring your data". Everything else in this document assumes
users can get their own data in.

**Effort:** M. — **SHIPPED** (2026-10-03).

**What actually shipped, against the proposal above.** `src/upload.js`,
`GET /api/v1/upload` (the contract) and `POST /api/v1/upload` (the import),
`test/upload.test.js` (52 tests). Three deviations from the proposal, each with a
reason:

- **It buffers rather than streaming to disk.** `readRawBody` already caps the
  body (`DEFAULT_MAX_BODY_BYTES`) and the parse is pure, so streaming would add a
  temp-file lifecycle and a second failure mode — a half-written upload left on
  disk — to solve a problem the size cap already answers.
- **No client-side CSV picker.** The proposal put a file input on the districts and
  scenarios surfaces. Both are gated behind the i18n work (WEB-11) and doing it
  first would mean shipping a picker with an untranslated label on surfaces whose
  strings are not yet keyed.
- **A client-side picker would have needed the browser's own preview.** The
  server-side report is strictly better evidence than a JS re-implementation of it:
  one validator, one answer, and the same report for a browser and a `curl`.

The proposal's own four refusals all survived into the implementation and are
tested: no column guessing, no coordinate clamping, no date format guessing, no
partial import.

### ENH-26 — Two-way SMS acknowledgement, escalation, and delivery tracking

**Evidence.** `src/rapidpro.js` is one-way outbound plus a free-text inbound parse.
There is no delivery tracking, `response_rate_pct` divides by dispatch count rather
than recipients so a broadcast to 500 can report 300% (ALERT-05), and there is no
inbound idempotency so a retried webhook double-SMs (ALERT-06).

**The change.** Structured reply verbs — ACK, ESCALATE, RESOLVED, plus a reason
code. Correlate replies back to the originating alert event. Track delivery state
per recipient and expose a delivery-report endpoint. Escalation trees with an
acknowledgement SLA.

**Value.** Dispatch without a feedback loop is broadcasting, not coordination. This
is what turns SMS from a notification channel into the operational channel the
architecture doc already describes it as.

**Effort:** L.

### ENH-27 — Export that carries the narrative

**Evidence.** `/export.csv` and `/export.geojson` (`src/server.js:1129-1137`)
return only the source-record appendix. The narrative, the data-quality warnings
and the caveats exist solely in `export.md`, with nothing on the export endpoints
saying so. No KMZ, no XLSX. `markdown_download` records a byte count rather than
the artefact (`src/reports.js:1373`), so the exported report is not retrievable
later.

**The change.** XLSX and KMZ export; a signed PDF that carries the report *and* its
provenance appendix; and one-line provenance stamped on every exported row
(`source_id`, `observed_at`, `payload_hash`). Store rendered artefacts, not byte
counts.

**Value.** The country office and the donor are the actual consumers of this
platform's output. Today they get a spreadsheet with no indication of which rows
are uncertain, and a narrative they have to request separately.

**Effort:** M.

### ENH-28 — A donor-inspectable, hash-chained audit trail

**Evidence.** `action_logs` exists but is self-asserted (DATA-15), carries 8
characters of the bearer token as its actor (SEC-09), is written on some paths and
not others, has no UI, no export, and **none of the three parametric write paths
write one at all** (`src/server.js:2073, 2095, 2162`) — the money path is
unaudited.

**The change.** Append-only action log, hash-chained (`prev_hash` in each row, so
tampering is detectable), actor bound to the authenticated token rather than to a
caller-supplied string, covering every mutating route including the money path.
Plus a read-only audit view and an export a donor can inspect without trusting the
operator running the server.

**Value.** For a platform whose value proposition includes donor-inspectable
decision support, the audit trail is currently the weakest link in the chain and
it sits directly under the money.

**Effort:** M.

---

## Group E — Platform foundations

### ENH-29 — A store conformance suite, a real schema, and migrations

**Evidence.** `PostgresStore` and `JsonStore` share a method signature and disagree
about nearly everything: replace versus merge, ordering and tiebreakers, dedup,
deletion, id-less records, `now()` semantics. Fifteen divergences are tabulated in
[_research/storage-ops.md](_research/storage-ops.md). `src/postgres-store.js` has
**0% function coverage in CI** because the coverage script omits the integration
test and that test skips itself (TEST-02). `ensureSchema` writes `version: 1` and
never reads it (DATA-11).

**The change.** Three parts, in order:

1. A **conformance suite** — one set of behavioural tests run against both
   adapters, so "the backends must agree" becomes an assertion rather than a hope.
   This alone would have caught DAT-01, DAT-05, DAT-07 and DATA-13 at zero cost.
2. A **migration runner** keyed on a real `schema_version` column, with the
   current hardcoded `ALTER TABLE` becoming migration 1.
3. Only then, a **relational schema** — proper columns and indexes for the
   collections queried by region and time, rather than one JSONB table scanned and
   filtered in application code.

**Value.** The single-table design is a deliberate and defensible trade for a
district laptop, and this does not abandon it. It makes the difference between the
two backends a tested invariant rather than an accident, which is what allows a
deployment to switch from JSON to Postgres without discovering afterwards that
some figure was never persisted.

**Effort:** L, but the conformance suite alone is S and is the part that pays
immediately.

### ENH-30 — API substrate: pagination, conditional requests, idempotency, readiness

**Evidence.** Every request reads the entire store (`src/server.js:252`,
`postgres-store.js:60`) and returns everything. `store.read()` JSON-parses 1.7 MB
per request. Exports are uncapped and unauthenticated (SEC-01). There is no
readiness endpoint that probes Postgres. Mutations have no idempotency key, so the
retries that ENH-11 will introduce create duplicates.

**The change.**

- **Cursor pagination** with a total-count envelope, on the collection endpoints.
- **ETag and conditional requests** — already working for static assets, so the
  mechanism exists; extend it to API responses.
- **Idempotency keys** on the mutating routes, which ENH-11's retries then depend
  on.
- **A readiness endpoint** that probes the database and reports store mode, as
  distinct from the existing liveness `/api/v1/health`.
- **Generated OpenAPI** from the route table, diffed in CI, closing D4 — nine live
  routes are currently undocumented and `/api/v1/impact/facilities-at-risk` is
  missing while its sibling is present.

**Value.** Turns an API that works at demo scale into one that works on a district
server after a year of accumulation, and makes the OpenAPI document trustworthy
instead of decorative.

**Effort:** M.

**Status: implemented 2026-10-03, in two parts.** Cursor pagination with a
total-count envelope, ETag/conditional requests, idempotency keys and the
readiness endpoint are in `src/utils.js` (`collectionPage`, `jsonResponse`,
`createIdempotencyStore`) and `src/server.js` (`/api/v1/ready`, the `handleApi`
idempotency wrapper). Tests in `test/api-substrate.test.js`; each piece was
reverted and confirmed to fail before being restored.

Two things in the spec above are **not** done and remain open:

1. **Generated OpenAPI from the route table, diffed in CI.** The route table
   lives in `scopeForRoute`'s two tables and in `handleApiRequest`'s chain of
   `if` statements; neither is machine-readable as a specification. Extracting
   one is real work and is not started.
2. **The evidence line is now partly stale.** "Exports are uncapped and
   unauthenticated (SEC-01)" was fixed earlier — exports now require
   `read:export` and are scoped to the caller's partner organisation. The
   uncapped part still stands:
   `filterRecords` clamps `limit` to 5000, but the CSV and GeoJSON exports are
   built from the whole store, not from a filtered page.

`/api/v1/assessments` also had one unscoped list (`recent_events`); found and
fixed while threading pagination.

---

## What is deliberately not on this list

Worth recording, because "we considered it" is the useful part.

**Clear the `calibrated_uncertainty` flag on the risk score once ENH-03 lands.**
Rejected outright. Calibration on alert outcomes is a different quantity from
calibration on a risk score's continuous output, and a `false_alert: null` that
becomes a number is more honest than one that becomes a different kind of wrong.

**Wire `analytics/ensemble.js` to a live feed because it is written.** Either wire
it to a real ensemble source or delete it. A dead branch with a null-fed
`spreadSkillIndex` is worse than an absent module, because the module inventory
(`docs/architecture/system-overview.md` §4) lists it as a working capability.
ENH-21 is what would earn it a place.

**Add more data sources.** Sixteen connectors already exist, and two of them
(`glofas`, `nasa_firms`) return nothing. The binding constraints are not source
count; they are ENH-07 assertions, ENH-06 verdicts and ENH-11 rate limits. A
seventeenth source adds coverage and inherits every defect in this document.

**Add a machine-learning model.** The platform's advantage is that a number can be
traced to a source and a refusal. That advantage is destroyed by a model that
cannot be explained, and it is the thing that distinguishes this from every
proprietary system the open-source boundary document exists to avoid.

**Resolve source disagreement automatically** in ENH-09. Disagreement between
independent products is the finding. Picking a winner is a separate judgement that
belongs to a person.

---

## Sequencing

**First, before anything else:** ENH-01. Until GET is gated and unlisted routes are
refused, every other item is being built on a surface that hands the district's
operational picture and PII to anyone who can reach the port.

**Then, as one block:** DAT-01, DAT-02, DAT-05, DAT-03, DAT-07 from
[defects.md](defects.md). These are small, mechanical, and each one is currently
losing data or lying about it. The conformance suite in ENH-29 is what stops them
coming back.

**Then the trust group:** ENH-02, ENH-04, ENH-03. These are what make the numbers
defensible, and they are what everything in Group C draws.

**Then the two blockers:** ENH-25 (nobody can get their data in) and ENH-01's
completion with SEC-02 closed (data must not leak out).

**Then visualization, in ENH-16 first order**, because the library makes the other
seven cheap.

**Throughout:** ENH-06 and ENH-07. They are unglamorous, they are what keeps the
data honest, and they are the difference between an operator trusting source health
and ignoring it.