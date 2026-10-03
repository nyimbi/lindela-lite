# Lindela Lite — frontend & visualization audit

Scope: `public/` (8 PWA surfaces, no build step), `public/shared/`, `public/i18n/`,
`scripts/check-*.mjs`. Vanilla JS + hand-rolled SVG. Audited 2026-10-03.

Context that shapes every recommendation below: **there is no charting layer.**
No charting library, no `<canvas>`, and no reusable chart component anywhere in
`public/`. The only graphics primitives are 39 `svgEl()` calls inside
`public/app.js` (the situation map), one 30×40 px inline `<polyline>` sparkline in
`public/co/app.js:308`, one CSS-div bar chart in `public/co/app.js:234`, and a pair
of pixel-height `<div>`s in `public/scenarios/app.js:342`. Every other "chart" in
the product is a text strip — a `<span>` holding a sentence. That is the single
most important finding in this document: the visualization ceiling is not a
styling problem, it is that the thing the visualization work needs to build does
not exist yet.

## Defects

### D1 — Scenario delta bars are a silently truncated, unlabelled, fixed-origin chart
**Severity: High** (the only place in the product where a wrong visual reading
produces a wrong decision)

`public/scenarios/app.js:336-351`
```js
const baseH = 40
const scenH = Math.max(4, Math.min(80, baseH + value))
barsEl.innerHTML = `
  <div>
    <div class="bar" style="height:${baseH}px;background:var(--stroke-strong)"></div>
    <div class="bar-label">Base</div>
  </div>
  <div>
    <div class="bar" style="height:${scenH}px;background:var(--brand)"></div>
    <div class="bar-label">Scen</div>
  </div>`
```

Four independent axis defects in eight lines:

1. **Silent truncation.** The scale is `clamp(baseH + value, 4, 80)`. Any delta
   worse than −36 points and any delta better than +40 points render identically to
   their neighbour. A run that doubles rainfall and a run that raises it by 5%
   draw the same bar. There is no overflow indicator and no "clipped" note.
2. **No axis, no ticks, no scale.** Nothing says a pixel is a score point. The
   number next to it (`signed(value, { dp: 1 })`) is the only quantitative
   reading, and it carries no unit — a reader must infer from a comment 30 lines
   away that these are uncalibrated sensitivity score points, not percent.
3. **The baseline bar is not a baseline.** `baseH` is the constant 40. It is not
   the scenario's own `baseline` mean. The chart therefore draws
   "arbitrary reference vs reference+delta", which is a *slope*, not a comparison
   of two modelled states. A reader reasonably reads it as "before vs after",
   which is exactly what it looks like and not what it is.
4. **Colour-only encoding** of the two series with the difference carried by
   position alone; `var(--stroke-strong)` vs `var(--brand)` fails deuteranopia
   and protanopia (both are low-chroma blue-greys at 30%/16% chroma).

Fix: replace with a zero-baseline axis — one shared scale where
`px = value * unitScale`, an axis rule at 0, a tick label in "score points", and
a "±N (off scale)" caption when the value exceeds the domain. If the true
`baseline` mean is available, plot it; otherwise say "change from base" and label
the chart as a delta, not a comparison.

### D2 — Map encodes hazard type and severity by colour alone
**Severity: High**

`public/app.js:1383-1392` (legend) + `public/styles.css:405-421` (fills)

```js
const items = [
  { cls: 'hazard-flood',     label: 'Flood',     shape: 'circle' },
  { cls: 'hazard-landslide', label: 'Landslide', shape: 'circle' },
  { cls: 'hazard-fire',      label: 'Fire',      shape: 'circle' },
  { cls: 'hazard-conflict',  label: 'Conflict',  shape: 'circle' },
```
```css
.hazard-flood    { fill: oklch(60% 0.20 220); stroke: oklch(72% 0.20 220); }
.hazard-landslide{ fill: oklch(52% 0.16 55);  stroke: oklch(66% 0.16 55); }
.hazard-storm    { fill: oklch(65% 0.18 195); stroke: oklch(75% 0.18 195); }
.hazard-fire     { fill: var(--sev-critical); stroke: var(--sev-high); }
.hazard-conflict { fill: oklch(62% 0.17 300); stroke: oklch(72% 0.17 300); }
```

Four hazard classes are drawn as **identical circles differing only in fill
hue**. `hazard-flood` (h=220, L=60%) and `hazard-storm` (h=195, L=65%) are 25°
apart in OKLCH hue with near-identical lightness — under deuteranopia they
collapse to the same desaturated blue. `asset-water`
(`oklch(62% 0.20 220)`, `public/styles.css:420`) is effectively the same colour
as `hazard-flood`; only circle-vs-rect saves it.

Severity *is* redundantly encoded by radius (`sevRadius`, `public/app.js:1032`,
13/10/7/5) — good — but the legend never mentions radius, so a reader has no key
for it at all. The severity radius encoding is therefore unused.

Fix: give each hazard class a distinct shape (triangle=flood, diamond=landslide,
square-with-cross=fire, X=conflict) *and* keep the hue; add a size key to the
legend (`critical ●●●  /  low ●`); separate flood (h=250) from storm (h=195) and
from asset-water (h=200 + rect) by ≥40° of hue.

### D3 — A district map drops every record at the equator or prime meridian
**Severity: High** (silent data loss in the one surface a district officer uses)

`public/districts/app.js:208` and `:229`
```js
...records.map(r => ({ lat: r.latitude ?? r.lat, lon: r.longitude ?? r.lon })).filter(p => p.lat && p.lon)
...
if (!lat || !lon) continue
```

`p.lat && p.lon` is a truthiness test. A record at latitude 0 (equator) or
longitude 0 (prime meridian) is falsy and is filtered out — twice, in two
different places. The file's own comment two lines below the dot loop claims the
count is honest ("`plotted`, not `records.length`… is the sort of small
overstatement that makes a reader distrust the counts beside it"), so the intent
was clearly to count exactly what was drawn; the filter defeats it.

Fix: `Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))` in both
places, and hoist to one `hasCoords(r)` helper so the filter and the plot cannot
diverge again.

### D4 — Severity filter passes every record that has no severity
**Severity: High** (a control that appears to work and does not)

`public/app.js:1173-1179`
```js
const visible = geo.filter((r) => {
  if (sevFilter && r.severity && r.severity !== sevFilter) return false
  if (srcFilter && r.source && r.source !== srcFilter) return false
  if (since && !withinRange(r, since)) return false
  if (coldOnly && !isColdChainAsset(r)) return false
  return true
})
```

The guard is `sevFilter && r.severity && …`. The middle clause lets every record
with a *null* severity through the severity filter. With `mapSeverity` set to
`critical`, the map keeps showing every medium/low record *and* every record with
no severity at all — which, on the region-wide feeds, is most of them. The same
shape is in the source filter (`r.source && …`). The map record list at
`public/app.js:1289` is built from the same `visible` array, so the count in the
filter bar is equally wrong.

Fix: when a filter is active, records that cannot satisfy it must be excluded, not
admitted — `if (sevFilter && r.severity !== sevFilter) return false` — and surface
"47 of 312 records carry no severity and are hidden by this filter" so the
exclusion is visible rather than surprising.

### D5 — CHW offline queue reports success for a report it has already discarded
**Severity: High** (loss of field data; the UI makes a promise the code breaks)

`public/shared/runtime.js:55-56`
```js
async enqueue(path, options) {
  if (!this.db) return
```
`public/chw/app.js:243-245`
```js
if (!navigator.onLine) {
  await window.lindelaQueue.enqueue('/api/v1/chw/report', { method: 'POST', body })
  showToast(t('chw.report_queued', { what: 'symptom report' }), 'info')
}
```

`enqueue` returns immediately and silently when IndexedDB is unavailable — private
browsing, a blocked upgrade, a quota error, `open.onerror` (which
`runtime.js:52` resolves over rather than rejecting). The CHW wizard cannot tell
the difference, shows "Report queued", resets the wizard, and returns to the home
screen. The report exists nowhere. This is precisely the failure the surrounding
comments in `runtime.js:88-98` describe as the bug class this codebase is most
careful about — it was fixed for `flush()` and left in `enqueue()`.

Fix: `enqueue` returns `false` (or throws) when `!this.db`, and every caller
branches on the result — toast "could not save, connection lost and no local
storage available", keep the wizard populated, and offer retry.

### D6 — Service worker precache omits two modules of the console's own import graph
**Severity: Medium**

`public/sw.js:23-32`, `:45-76`. `SHARED_MODULES` lists eight paths. The console
imports ten:

```
public/app.js:10  import { … } from '/shared/fmt.js'
public/app.js:11  import { metricLabel } from '/shared/labels.js'
```

Neither `/shared/fmt.js` nor `/shared/labels.js` is in `APP_SHELL`, and
`/components.css` — linked by seven of the eight surfaces — is not either. The
comment above the list asserts it is "the full module graph of every surface",
which it is not. In practice stale-while-revalidate catches them on the first
online load, so this bites on a *first* offline load: install, go offline, open
the console, module resolution fails hard.

Fix: add the two modules and `/components.css` to `APP_SHELL`, and add a test
that walks each surface's `<script type="module">` graph and asserts every
resolved path is in the shell.

### D7 — Console redraws panels and destroys keyboard focus every 30 seconds
**Severity: Medium**

`public/app.js:3047` (`setInterval(refresh, 30_000)`) →
`public/app.js:1708-1711` → `renderAlertsPanel()` →
`public/app.js:2160` (`container.innerHTML = filtered.map(…)`).

Every 30 seconds the alerts list, the reports list and the ingestion grid are
replaced wholesale. A keyboard operator mid-way through triaging alerts —
focus on the third "Approve" button — finds focus on `<body>` when the DOM node
they were on is discarded. The same rebuild drops the `role="status"` regions
and any `aria-*` state, and re-triggers the `animation-delay` entrance animation
(`public/app.js:2161`) on all 30 items, so the list visibly re-animates under the
reader every 30 seconds.

There is already a partial defence — `restoreDialogFocus` checks
`opener.tabIndex >= 0` "because the opener may be a live button that the 30-second
refresh has already replaced" (`public/app.js:2692-2694`) — the problem is known
in this file and not applied at the list level.

Fix: diff by id before writing; only mutate changed rows, and only move focus if
the currently-focused element is one of the nodes being replaced.

### D8 — CO dashboard keeps last quarter's charts under this quarter's KPI tiles
**Severity: Medium** (stale data shown without a marker — the codebase's stated
worst failure mode)

`public/co/app.js:471-541`. `load()` never resets the previously rendered
sections before fetching. `renderTrend` and `renderQoQ` both early-return when
their data is absent:

```js
function renderTrend(series) {
  const grid = document.getElementById('trend-grid')
  if (!grid || !series || !series.length) return
```

So if `/api/v1/kpi/monthly-series` fails on a quarter change, `trend-grid` keeps
the previous quarter's four sparklines and the quarter-over-quarter table, while
`renderKpi` has already replaced the KPI tiles with the new quarter's figures.
Nothing marks the charts as belonging to a different period.

Worse, the honesty check that is supposed to catch this counts the wrong thing —
`public/co/app.js:550`:
```js
const loaded = sections.filter((id) => !document.getElementById(id)?.hidden).length
```
A section still showing stale data is *not hidden*, so it counts as loaded. The
banner reads "Loaded 7 of 7 sections" while two of them are a quarter out of
date.

Fix: hide all seven sections at the top of `load()`, and stamp each rendered
section with its period; count "loaded" as *rendered in this pass*, not
*not hidden*.

### D9 — Districts list page issues one request per district
**Severity: Medium** (N+1 on a page whose whole point is to scan many districts)

`public/districts/app.js:368` fires `/api/v1/districts/{slug}` inside the render
loop for every district card, and `renderList` runs on every hash change. With
40 districts on a 2G link that is 40 sequential-ish round trips before the grid is
usable; on a district laptop it is 40 SQLite reads to render 40 name labels.

Fix: add `?counts=1` to the list endpoint (the counts query already exists —
`src/districts.js` computes them per district) and delete the per-card fetch.

### D10 — District route has no in-flight guard
**Severity: Medium** (stale-response race)

`public/districts/app.js:606-641`. `route()` awaits `apiFetch` with no request
token and no abort. `loadingNote` → `clearApp()` → `renderOverview` means a slow
first navigation followed by a fast second paints the *first* district's overview
onto the *second* district's URL. `renderOverview` also calls `clearApp()` and
rebuilds, so there is no partial-merge protection either.

Fix: an incrementing `routeToken`; every `await` boundary checks it before
touching the DOM, plus an `AbortController` on the fetch.

### D11 — Scenarios attaches a fresh click listener on every run
**Severity: Low**

`public/scenarios/app.js:315-325` — `showResults()` is called from `runScenario()`
and again from the hash-restore path in `init()`. Each call re-executes:
```js
$('copyShareBtn')?.addEventListener('click', async () => { … })
```
on the same button. After five runs, one click fires five handlers; the status
line is written five times and the user sees flicker.

Fix: bind the listener once at module scope, reading `shareUrl` from state.

### D12 — `pct()` cannot distinguish 0.5 % from 50 %
**Severity: Low but pervasive** (silent unit corruption)

`public/shared/fmt.js:49-53`
```js
const n = Number(value)
return `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(dp)}%`
```
The "already scaled" branch keys on magnitude, not on a declared unit. A genuine
0.8 % false-alert rate (`false_alert_rate: 0.008` → 0.8 %) and a genuine 0.8 %
stored as `0.8` are distinguishable only by accident, and the exact boundary
`abs(n) === 1` is ambiguous in both directions: `1` renders as `100.0%`, `1.0`
stored-as-percent renders as `1.0%`. Used in `districts/app.js:575-576` and
`co/app.js:182`.

Fix: require the caller to declare the scale — `pct(0.008)` vs `pct(0.8, { alreadyScaled: true })`
— and delete the magnitude sniff.

### D13 — Console detail dialog flattens nested objects to `[object Object]`
**Severity: Low** (readability; and it hides exactly the connector payloads an
operator opened the record to see)

`public/app.js:2706-2709`
```js
const entries = Object.entries(record).filter(([k]) => k !== 'metadata')
detailBodyEl.innerHTML = `<dl>${entries.map(([k, v]) =>
  `<dt>${escapeHtml(k.replaceAll('_', ' '))}</dt><dd>${escapeHtml(String(v ?? ''))}</dd>`
).join('')}</dl>`
```
`metadata` is dropped outright; every other object and array renders as
`[object Object]` / `1,2,3`. `labels.js` already has `describeRecord()`
(`public/shared/labels.js:105`) written for exactly this and is not used here.
The `<dt>` also shows the raw key, not `metricLabel(key)`, so the dialog
reintroduces `precipitation_mm` as a column header — the thing `labels.js` exists
to prevent.

Fix: iterate with `metricLabel(k)` and `describeRecord(v)` for nested values.

### D14 — Equity "rate" column can go negative and renders "—%" when undefined
**Severity: Low**

`public/app.js:1896-1902`
```js
const rate = data.dispatched > 0 ? ((data.dispatched - data.acknowledged) / data.dispatched * 100).toFixed(1) : '—'
…
<td>${escapeHtml(String(rate))}%</td>
```
The `%` is outside the escape, so the no-data branch renders the literal string
"—%" — a dash with a percentage sign, which reads as a tiny non-zero value. And
`acknowledged` counts *alerts* while `dispatched` counts *dispatches*, with no
guarantee one dispatch maps to one alert (`public/app.js:1869-1874` counts every
`sent` dispatch per alert), so a district with two alerts and three dispatches
renders −50.0% under a column headed "Not acknowledged" — a share that should be
bounded at 100 %.

The column's meaning is otherwise handled well: `public/index.html:363-369` has
a comment and a `title` explaining precisely why it is not called a false-positive
rate, and `public/index.html:372+` carries a method note. That care is undone by
an arithmetic case that produces a negative percentage under it.

Fix: move the unit into the formatter so the dash renders as a bare "—"; compute
acknowledgement as a *set* over alerts (dedupe dispatches to distinct alert ids)
before dividing, so the numerator cannot exceed the denominator.

### D15 — `loadSignalToAction` re-fetches dispatches and bypasses auth
**Severity: Low** (redundant traffic on a 30-second timer)

`public/app.js:1912-1915` uses bare `fetch` (no `authHeaders()`, no 20 s timeout)
for `/api/v1/rapidpro/dispatches?limit=50`, while the same data was already
fetched a few lines earlier in `refresh()` as `load('dispatches',
'/api/v1/rapidpro/dispatches?limit=200')` (`public/app.js:1628`) and stored in
`state.data.dispatches`. Two requests per refresh, one of them un-timed.

Fix: read `state.data.dispatches.data`.

### D16 — Token stylesheet is an `@import`, and the console is the one surface not linking `components.css`
**Severity: Medium** (render-blocking waterfall on the surface with the largest
critical path; one unstyled class on the console)

`public/styles.css:6`
```css
@import url('/tokens.css');
```
A CSS `@import` is discovered only *after* `styles.css` has been fetched and
parsed, so the browser then blocks rendering on a second round trip for
`tokens.css`. Every other stylesheet link in the product is a plain `<link>`. On
2G this is one extra serial RTT on the console's critical path, and `tokens.css`
is referenced twice across the product (`public/parametric/index.html:9` links it
directly *and* gets it via the import, so it is fetched once but the two cascades
are resolved in different orders).

`public/index.html:9`
```html
<link rel="stylesheet" href="/styles.css">
```
The console is the only one of the eight surfaces that does not also link
`/components.css` — the other seven all do. `docs/plans/ui-ux-world-class.md`
(line 942) records "all 8 surfaces link `tokens.css` + `styles.css` +
`components.css`" as **done**; it is false. The console uses exactly one
`components.css` class, `empty-note` (`public/index.html`), and
`public/styles.css` defines no `.empty-note` rule, so the console's empty-state
message renders unstyled.

Fix: `<link rel="stylesheet" href="/tokens.css">` before `styles.css` in every
surface and delete the `@import`; add `/components.css` to `public/index.html`.

### D17 — i18n coverage is 8 %–92 % depending on the locale, and three surfaces have no i18n at all
**Severity: Medium** (a Somali operator on the districts page gets English with no
indication that a Somali version exists)

Key counts, measured from `public/i18n/*.json` against `en.json` (227 keys):

| locale | keys | share |
|---|---:|---:|
| en | 227 | 100 % |
| sw | 209 | 92 % |
| so | 101 | 44 % |
| din | 58 | 26 % |
| km | 55 | 24 % |
| nk | 55 | 24 % |
| ar | 54 | 24 % |
| am / fr / pt | 38 | 17 % |

`public/districts/`, `public/parametric/` and `public/scenarios/` contain **zero**
`data-i18n` attributes in their markup and import no i18n layer — they are
English-only by construction. `scripts/check-i18n.mjs` only checks CHW strings
(44 keys, correctly reporting `am`/`ar`/`fr`/`km`/`nk`/`pt` as *not offered*), so
the districts/parametric/scenarios gap is invisible to CI.

Arabic is 24 % translated and RTL (`public/shared/fmt.js:271`), which
`applyLocaleToDocument` correctly applies — but with 182 untranslated keys, the
RTL layout renders mostly English strings.

Fix: extend `scripts/check-i18n.mjs` to every surface and every `data-i18n` key,
not just CHW; either mark the low-coverage locales as un-offered everywhere
(consistent with the current CHW behaviour) or fund the translation.

### D18 — `ar` is offered in the locale picker on every surface including CHW
**Severity: Low** (a promise the product cannot keep)

`public/shared/fmt.js:275` derives `AVAILABLE_LOCALES` from the table, so all ten
locales appear in every picker. `scripts/check-i18n.mjs` correctly withholds six
of them from CHW — via a separate mechanism. Two systems, one outcome, not shared.

Fix: derive offered locales from measured coverage, in `fmt.js`, once.


### D19 — All twelve endpoints are polled every 30 s regardless of which panel is open
**Severity: Medium** (the dominant cost on a 2G district link)

`public/app.js:1605-1630`. `refresh()` fetches health, sources, ingestion status,
flood risk, conflict risk, two event queries, service assets, alert events,
reports, report templates, 200 climate records, 200 dispatches and 200 workflows
— then fires three more strip loads (`:1695-1697`), `loadWorkflowMetrics()`
(`:1706`) and `loadSignalToAction()` (`:1713`), which fetches a fifth copy of the
dispatches list. Fifteen-plus requests per tick, unconditionally.

Only one of the five rail panels is ever visible, and the map needs four of the
twelve. `document.hidden` (`public/app.js:1593`) guards tab-visibility, not
panel-selection, so an operator sitting on the Alerts tab for an hour still pulls
200 workflow records and 200 climate observations every 30 seconds.

The console does gate one thing on state — `renderIngestionPanel` etc. run only
for the active tab (`:1708-1711`) — but the *fetching* is not gated at all.

Fix: fetch per-panel on `switchTab()` with a short TTL, keep only health + the
four map sources on the 30 s tick, and add `If-None-Match` handling so an
unchanged panel costs a 304 rather than a full body. On a 2G link this is the
single largest saving available in the frontend.

### D20 — Map markers are below the 24 px touch-target floor and have no hit padding
**Severity: Medium** (unreachable markers on a phone; the map is the console's
primary surface)

`public/app.js:1032-1034`
```js
function sevRadius(severity) {
  return { critical: 13, high: 10, medium: 7, low: 5 }[String(severity).toLowerCase()] ?? 5
}
```
These are radii in an 800×500 viewBox (`public/app.js:882-883`). A `low` marker is
r=5 → 10 units across, 1.25 % of the map width. `scripts/check-responsive.mjs`
enforces the WCAG 2.2 SC 2.5.8 24 px floor but only against DOM controls, and SVG
circles have no hit padding: the click target is exactly the painted geometry.
`mapEl` also scales with the viewport, so on a 360 px-wide phone the effective
target shrinks again. A `low`-severity hazard on a district officer's phone is
effectively untappable.

Fix: give each marker an invisible `r = max(painted, 12)` `<circle>` with
`fill="transparent"` beneath it as the pointer target, and mirror the keyboard
path from `renderMapRecordList` so every marker is reachable without a pointer at
all.

## Enhancements

### E1 — Extract a `shared/charts.js` and rebuild every chart on it
**Severity of the alternative: this is the prerequisite for E2–E12.**

The product has four chart implementations written four ways: SVG via
`svgEl()` (`public/app.js:939`), an inline SVG `<polyline>` string
(`public/co/app.js:328`), CSS `<div>` heights (`public/co/app.js:236-238`), and CSS
`<div>` heights again (`public/scenarios/app.js:342-349`). There is no shared
axis, no shared scale, no shared tooltip, no shared screen-reader table. Every
axis defect in D1 exists because four people each decided what a bar was.

Build one module exporting `linearScale`, `bandScale`, `timeScale`, `axisBottom`,
`axisLeft`, `Sparkline`, `BarChart`, `Heatmap`, and a `chartA11y()` companion
that takes the same data and returns the sentence plus the `<table>`. All four
sites become calls. Roughly 400 lines, no dependencies, and it makes E2–E12 each
a few hours rather than a day.

### E2 — Per-district flood-probability small-multiples with confidence
**Value: a district officer sees, in one grid, every district the store has a
model for — base rate, validated skill, and sample size — instead of the single
highest-skill headline the console currently shows.**
This is the highest-value unimplemented visualization in the codebase because the
data is already in memory and 95 % of it is discarded.

`public/app.js:769-807` — `loadFloodProbabilityModels()` receives one record per
district and reduces them to one sentence:
```js
const best = okModels
  .filter((m) => Number.isFinite(m.folds?.folds?.skill_over_base_rate))
  .sort((a, b) => b.folds.folds.skill_over_base_rate - a.folds.folds.skill_over_base_rate)[0]
```
Everything below the maximum is thrown away: `training.base_rate`,
`training.months`, `training.flood_months`, `folds.folds.skill_over_base_rate`,
`trained_at`, and the per-district `refusal` strings.

Implementation: one small-multiple panel per district — a dot plot of
`base_rate` against `skill_over_base_rate` with a zero line (skill below zero
means the model is worse than the base rate), dot size by `months`, dot
styling split trained/refused — plus a `<table>` alternative via E1's `chartA11y()`.
The refusal rows keep their own visual: an outlined slot with the refusal text,
because "this district has 40 months, not the 60 required" is actionable and a
blank is not. This is the single best answer to "render uncertainty visually
rather than only in JSON" available in this repo.

### E3 — Time-slider playback of the hazard record over the map
**Value: an operator answers "what did this corridor look like in the week before
the flood?" by scrubbing a slider instead of mentally reconstructing it from a
filtered list — and the same control animates the flood, road and IPC overlays
in step.**

`public/app.js:1145` `renderMap(records)` already takes a record array and knows
how to draw every layer against it. The only thing missing is a time dimension:
`rangeStart()` (`public/app.js:1101`) implements exactly three fixed windows
(24 h / 7 d / 30 d) and `FILTER_READERS.range` (`public/app.js:2068`) already
round-trips it through the URL.

Implementation: an `<input type="range" step="3600">` bound to a scrub instant,
with `renderMap(records.filter(r => withinRange(r, until) && withinRange(r, until - window)))`.
`recordTime()` (`public/app.js:1112`) is the ordering primitive. Add a play/pause
button advancing the scrub by one hour every 400 ms. Persist `t` in the existing
`FILTER_READERS` map so a scrubbed view is shareable by URL. Cumulative mode
(rather than a sliding window) is the right default for flood — the question is
"has this road been cut", not "was it cut this hour".

### E4 — Monthly climate calendar heatmap (month × year)
**Value: 200 climate observations currently produce one sentence
(`renderSeasonalStrip`, `public/app.js:517-547`); as a calendar heatmap they show
which months in which years broke, which is the actual question a seasonal
advisory reader has.**

`public/app.js:1627` already fetches `load('climate', '/api/v1/climate?limit=200')`
and `public/app.js:1687-1691` hands the whole array to a strip that uses the last
five observations to compute an ENSO phase. 195 of the 200 records are unused.

Implementation: a 12-column × N-row grid, month on x, year on y, cell fill from a
diverging ramp (cold ↔ zero ↔ warm) with the anomaly in °C, cells with no
observation hatched in `--ink-faint` and marked `data-gap` rather than drawn at
zero. `shared/seasonal.js` already computes anomalies, and `shared/fmt.js:signed()`
already renders `+2.17 °C`. Add a month-mean row and a year-mean column so the
seasonality is legible without reading every cell, and overlay the CPC advisory
period as a bracket on the year axis so the reader can see whether the warm cells
actually met the declaration criterion — which is precisely the honesty rule
`seasonalNarrative()` already enforces in prose.

### E5 — Map → chart → record drill-down, with the selection carried in the URL
**Value: the console has a map and a table of the same records but no way to
select; linking a map marker to a time series to a record is what turns eight
unrelated panels into one analysis tool.**

`public/app.js:1240` and `:1256` attach `click` handlers to hazard markers that
open a flat key/value dialog. `public/app.js:1289` builds a record list. Nothing
joins them.

Implementation: clicking a marker sets `state.selection = { id, source, type }`;
`syncFiltersToUrl()` (`public/app.js:2074`) gains a `sel=` parameter, so the
selection is shareable like every other filter — that machinery already exists and
is already tested. Below the map, render a time series for the selected record's
source and metric over the past 90 days with the record's own date marked; below
that, the record list filtered to the same source. Keyboard path: the existing
`renderMapRecordList` "Details" button
(`public/app.js:1365`) becomes "Focus", which sets the same selection, so the
whole path is operable without touching the SVG.

### E6 — District comparison view with a slope/dumbbell chart
**Value: the equity table gives one row per district and no sense of which
districts are diverging; a dumbbell of acknowledged-vs-dispatched per district,
sorted by gap, makes the worst three obvious in one glance.**

`public/app.js:1857-1905` `renderEquityTab()` already computes `dispatched` and
`acknowledged` per district, and `public/co/app.js:175-197` has a near-identical
`renderEquity()` on a cleaner data source. The cross-app duplication is the
problem and the dumbbell is the fix.

Implementation: rows sorted by gap descending, a horizontal dumbbell per district
(dot = dispatched, ring = acknowledged, connector = gap), districts breaching the
80 % accuracy rule from `public/co/app.js:183` marked with the same `chip-breach`
token the CO surface already uses so the two surfaces agree. Keyboard: each row
is a button that deep-links to `/districts#/<slug>` (the link the CO surface
already builds at `public/co/app.js:188`).

### E7 — Replace the text strips with charts that keep the sentence
**Value: the console's four context strips — seasonal, IPC, disease, flood
probability — are each one sentence long; each has a distribution behind it that
would change what an operator does, and each can carry its sentence as the
`aria-label` E1 already produces.**

The strips are `public/app.js:713-730` (IPC worst area), `:736-761` (disease
series), `:769-807` (flood probability), `:517-547` (seasonal).

Implementation, one per strip:
- **IPC** → a horizontal band chart of `worst_areas` by `phase3plus_fraction`
  against the four `IPC_FRACTION_BANDS` thresholds, with the `food-unclassified`
  rows (no published figure) as outlined, unfilled slots. The honesty rule at
  `public/app.js:255-257` — "shading it green would invent a value" — survives as
  the slot styling.
- **Disease** → a per-indicator recency dot plot, x = years behind calendar,
  grouped by `series_state`. The strip's own sentence ("silence is absence of
  published data, not absence of disease", `public/app.js:756`) becomes the
  chart's caption, because a chart of *gaps* makes that point better than a
  sentence does.
- **Seasonal** → E4.

### E8 — Signal-to-action timeline with the distribution and the outliers
**Value: the console shows a median lag (`public/app.js:1946`) that by
construction hides the tail; a strip plot with the median, the 90th percentile and
every dispatch over 24 h named turns a vanity metric into an operational one.**

`public/app.js:1910-1962` computes `lags` from up to 50 dispatches, takes
`lags[Math.floor(lags.length / 2)]` and discards the rest. `public/co/app.js:217`
builds a 5-bucket histogram of the same quantity on a different endpoint with a
different window (`queued_at` vs `matched_signal_at`) — two answers to the same
question.

Implementation: one strip plot, one endpoint, one definition — and reconcile the
two lag definitions, because the console measures signal→SMS while CO measures
queued→sent, and neither is the field-response warning-to-action the CO surface
renamed itself away from at `public/co/app.js:147`. Median as a rule, p90 as a
tick, each dispatch over threshold as a labelled dot. This is the
forecast-vs-observed *latency* verification chart, and it is the cheapest one
available because the data is already fetched twice.

### E9 — Forecast-vs-observed verification: the flood-probability model, honestly plotted
**Value: the product trains a per-district probabilistic flood model
(`src/flood-probability.js`, surfaced at `public/app.js:769`) and shows only its
validation score; a reliability diagram would show a focal point exactly what the
model is worth in their district, and would make a bad model look bad.**

Implementation: reliability diagram per district — predicted probability decile
on x, observed flood-month frequency on y, 45° line as "no better than the base
rate", dot area by decile population. `folds.folds.skill_over_base_rate` is the
summary; the diagram is the evidence. Overlay the `trained_at` date and the
reporting-conditioning caveat the strip already states verbatim at
`public/app.js:800-802` ("the probability is a flood entering the archive, not
water at a given elevation") as the chart caption. Requires the per-fold
predictions from the server rather than the summary — a small addition to
`/api/v1/flood-probability/models`.

### E10 — Service-access and road-network flow diagram
**Value: the road-access overlay is 200 indistinguishable dots
(`public/app.js:212-229`); a force-directed or Sankey view of
asset → nearest-road → district shows which assets are cut off and by how much,
which is the actual logistics question.**

`state.roadAccess` (`public/app.js:665`) holds `road_name`, `access_status`,
`access_reason`, coordinates. `state.roadsById` (`public/app.js:552`) already
indexes the network. `src/road-access.js` computes the accessibility model
server-side.

Implementation: nodes = assets, edges = the roads a route would use; node fill by
`access_status`, edge width by class, edge style dashed for restricted. Clicking a
cut road reveals `access_reason` verbatim — the server already returns it and the
map only shows it in a `<title>` tooltip. This is the one place a diagram beats a
map: a road that matters because of what is behind it, not where it is.

### E11 — Offline map tiles and a cached last-known basemap
**Value: the console's basemap is ~40 hardcoded polygons in `shared/basemap.js`
covering the Horn only; a district officer in Aweil with no signal currently sees
an empty grid outside that extent, and the SVG map carries no tiles at all.**

`public/app.js:997-1030` draws the ocean polygon, `REGION_POLYGONS`, and
`PILOT_DISTRICTS` circles. There is no basemap imagery anywhere in the product.
Every one of the eight surfaces re-projects points into an SVG coordinate system
with its own `project()` — `public/app.js:946`, `public/districts/app.js:217` —
and they do not agree.

Implementation: cache the last successful `/api/v1/*` payloads (the SW API cache
already does this at 24 h TTL, `public/sw.js:10`) into IndexedDB under a
`mapframes` store on every successful `refresh()`, and on a failed fetch draw the
cached frame with an "as of HH:MM" stamp. Precache a low-zoom raster tile set
from the same SRTM/terrain pipeline the flood depth service already calls. Fixes
D-stale-data on the map in the same move, and makes the map usable past the Horn.

### E12 — Colourblind-safe and high-contrast themes as a token swap
**Value: three of the four hazard classes are hue-only
(`public/styles.css:405-411`); a `data-theme` attribute swapping the seven hazard
tokens fixes D2 for the ~8 % of men with a CVD without touching a renderer.**

`public/tokens.css` is already a single `:root` block of 60 custom properties
with zero hex literals. Implementation: `[data-theme="cvd"]` and
`[data-theme="contrast"]` blocks overriding the hazard, food, severity and flood
ramp tokens only, plus a `?theme=` URL parameter and a preference in the settings
panel. In the CVD theme, flood moves to h=250, storm to h=145, landslide stays
h=55, conflict to h=330, and hazard shape becomes load-bearing regardless.
Also raise `--ink-faint` and the `--legend-label` fill: `.legend-label` at
`public/styles.css:562` is `10px` in `--ink-muted` on a `--bg-elevated` box over
a live map — the smallest and lowest-contrast text in the product, on the element
that explains every other element.

### E13 — A print/PDF layout per surface
**Value: the paper workflows this product serves end in a printed situation
report; a 90-character-wide SVG map does not print, and the CO surface already
generates a server-side PDF (`public/co/app.js:468`) that the print layout should
match rather than duplicate.**

`public/styles.css` has a print stylesheet (recorded as done in
`docs/plans/ui-ux-world-class.md`) but nothing prints a *chart*. Implementation:
a `@media print` block per surface that expands collapsed sections, forces the
`#`-alternative data tables from `sparkSeriesTable` (`public/co/app.js:377`) and
`renderMapRecordList` (`public/app.js:1301`) to visible, stamps every figure with
its period and a "generated at" line, and swaps SVG fills for the print-safe
hatch patterns so a monochrome district printer can still read the flood bands.

### E14 — Per-role dashboards off the existing command palette
**Value: eight surfaces exist and an operator moves between them by hand; the
command palette already enumerates actions, so role views are a filter over data
the console already fetches.**

`public/app.js:2733-2748` defines `PALETTE_BASE`; `switchTab()`
(`public/app.js:1993`) already has six panels. Implementation: a `?role=` URL
parameter (`focal-point`, `chw-lead`, `co`, `analyst`) that selects a default tab,
map filter set and pinned panels, persisted like every other filter through
`FILTER_READERS`. Reuse `mountNavbar()` from `shared/navbar.js`, which already
takes an `activePath` and renders all eight surfaces — a role view is the same
mechanism with a preset.

## Per-surface notes

| surface | audience | what it shows | biggest gap |
|---|---|---|---|
| `/` ops console | regional operations officer | situation map (12 SVG layers), alerts rail, reports, equity, ingestion, settings | 12 requests every 30 s regardless of the visible tab; no charts, only text strips; map has no scale bar, north arrow or time dimension |
| `/districts` | district officer | per-district counts, KPIs, a scatter map, paged record lists | map drops equator/meridian records (D3), auto-frames to data so the district can be off-screen, N+1 fetch per card |
| `/chw` | community health worker | offline symptom/incident/reply wizard | queued reports are invisible — no pending-count badge; `enqueue` silently drops when IndexedDB is unavailable (D5) |
| `/co` | country office / donor | 12 KPI tiles, cohort, 4 sparklines, QoQ table, lag histogram, equity, feedback | charts survive a failed fetch and count as loaded (D8); sparklines have no y-axis or time labels |
| `/focal-point` | focal point / decision maker | pending workflow queue, protocols, decision audit | no before/after view of what a decision released; approve/reject is a bare form |
| `/parametric` | programme / finance | trigger rules, simulation runs, disbursements | simulations have no outcome distribution — only point estimates; no uncertainty rendering at all |
| `/scenarios` | planner | perturbation presets, delta cards, affected-asset table | delta bars are truncated and unlabelled (D1); the one chart in the product is the one that misleads |
| `/portal` | external / read-only | generic record table over a whitelisted endpoint | entirely tabular; no visualization of any kind; hardcoded English column set |

## Already done

Verified against `docs/plans/ui-ux-world-class.md` (progress table, lines
937-957) and against the code. **Do not re-propose these.**

- Native `<dialog>` + `showModal()` on every modal — focus containment, Esc and
  inert background for free (`public/app.js:2711`, `:1974`, `:2755`).
- Focus restoration on dialog close, with the "opener was replaced by the
  30-second refresh" case handled (`public/app.js:2689-2700`).
- Roving tabindex + arrow/Home/End on the rail tablist (`public/app.js:2028-2045`).
- `aria-activedescendant` + `scrollIntoView` on the command palette
  (`public/app.js:2804-2822`).
- Keyboard pan/zoom on the map with a live-region zoom announcement
  (`public/app.js:1471-1503`), and a full text alternative table
  (`public/app.js:1301`).
- **Honesty engineering, which is the strongest thing in the codebase and must not
  be diluted:** bbox-only hazards drawn as dashed footprints rather than invented
  centre points (`public/app.js:1216-1246`); IPC boxes labelled "Bounding box,
  not the mapped polygon" (`public/app.js:287`); route hops ringed rather than
  joined by a fabricated polyline (`public/app.js:417-426`); a sequential flood
  ramp with the reasoning written down (`public/shared/flood-bands.js:1-11`,
  `public/styles.css:427-431`); a seasonal label function that cannot say
  "El Niño" without "advisory" (`public/app.js:509-516`); a flood-coverage share
  that names the surveyed box rather than the district (`public/app.js:369-384`).
- One escape helper (`shared/fmt.js:20`), one date format with a zone, one
  severity→class map with an allowlist (`shared/fmt.js:74-86`), `metricLabel` for
  every domain field (`shared/labels.js:19-64`).
- `res.ok` checked everywhere via one `apiFetch` with a 20 s timeout
  (`public/shared/runtime.js:155-189`).
- Per-panel `Promise.all` settling so one dead endpoint does not freeze the
  status bar (`public/app.js:1596-1602`), plus a 3-strike degraded indicator.
- Offline queue routed through one IndexedDB implementation with Background Sync
  and an in-page flush on `online` / 30 s / load (`public/shared/runtime.js:99-136`),
  and the service worker's duplicate dead queue removed (`public/sw.js:230-273`).
- `skipWaiting` + `clients.claim()` + an `activated` message so a deploy reaches
  an operator with the tab open (`public/sw.js:95`, `:114-118`).
- Bounded, TTL-pruned API cache separate from the app shell (`public/sw.js:191-216`).
- `check-a11y.mjs` (96 assertions, 8 surfaces), `check-responsive.mjs` (24 px
  target floor, overflow, clipping), `check-i18n-offers.mjs` — all currently
  passing.

Two claims in that progress table are **not** true against the current code and
are the source of D6 and D17: "full module graph precached" (`/shared/fmt.js` and
`/shared/labels.js` are not in `APP_SHELL`), and "all 8 surfaces link tokens.css +
styles.css + components.css" (`public/index.html:9` links only `styles.css`;
`components.css` is linked by the other seven, and the console's one
`components.css` class, `empty-note`, is therefore unstyled).

## Rejected

- **Any charting library (D3, Chart.js, uPlot, Observable Plot, Plotly).** The
  product's entire value proposition to a low-bandwidth district deployment is
  64 KB gzipped, zero runtime dependencies, no CDN, no webfont
  (`docs/plans/ui-ux-world-class.md:473-501`). A single charting library costs
  more than the whole console. E1 is ~400 hand-written lines and adds nothing.
- **WebGL / canvas map.** The map's ceiling is data, not pixels — 40 polygons and
  a few hundred records. SVG is correct here, is accessible, and is already built.
- **Offline raster tiles (E11, second half).** Tile caching is a large, separate
  project with its own versioning and expiry story. The IndexedDB last-known-frame
  cache in the same enhancement is the 20 % that fixes the actual problem.
- **A print/PDF generator in the browser.** `src/pdf.js` and
  `/api/v1/kpi/quarterly.pdf` already exist server-side. A client print stylesheet
  (E13, first half) covers the paper workflow at a fraction of the cost.
- **Localised *number and date* formatting.** Already done —
  `shared/fmt.js:41-61` and `:177-193` use `toLocaleString` and an explicit
  `en-GB` day-month order with a zone label.
- **Deleting the text strips in favour of charts.** The sentences are correct and
  the honesty they carry is deliberate. E7 keeps the sentence and adds the
  distribution beneath it; replacing them would lose the caveat.
- **Animating the risk blobs or adding transitions to the map layers.** The
  console already re-animates its alert list every 30 s (D7). Adding motion to
  the map would make a low-end district laptop's repaint cost worse for no
  analytical gain.
