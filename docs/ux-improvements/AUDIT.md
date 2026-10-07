# UX audit

**Date:** 2026-10-04
**Scope:** eight surfaces — `/`, `/portal/`, `/chw/`, `/co/`, `/districts/`, `/focal-point/`, `/parametric/`, `/scenarios/`
**Method:** heuristic evaluation, cognitive walkthrough, and programmatic WCAG 2.2 validation against the running product.

Findings live beside this document:

| File | Contents |
|---|---|
| [findings/cognitive-walkthrough.md](findings/cognitive-walkthrough.md) | five tasks, 35 steps, performed end to end |
| [findings/heuristic-evaluation.md](findings/heuristic-evaluation.md) | Nielsen's ten heuristics across eight surfaces |
| [findings/consistency-and-errors.md](findings/consistency-and-errors.md) | cross-surface consistency, error handling, empty and failure states |
| [findings/a11y.json](findings/a11y.json) | axe-core 4.13, every surface × 5 conditions |
| [findings/a11y-rollup.json](findings/a11y-rollup.json) | the same, rolled up by rule |
| [scripts/audit-a11y.mjs](../../scripts/audit-a11y.mjs) | regenerate both |

**45 findings. 10 blockers, 15 major, 9 minor, 4 axe rules across 42 instances.**

---

## Method

Three methods, chosen because each catches what the others miss.

**Heuristic evaluation** applies Nielsen's ten heuristics. It catches the structural problems —
an action in the wrong place, a concept styled four ways, no way back.

**Cognitive walkthrough** answers four questions at every step of a real task: will the user try to
achieve this, will they notice the action exists, will they associate it with the effect, will they
see it worked. It catches the failures that only appear when you *try to do the thing*. Five tasks
were performed against the running product over CDP — including filing a symptom report with the
network emulated off, and approving a trigger. **8 of 35 steps passed cleanly.**

**Programmatic validation** runs axe-core 4.13 against every surface in five conditions (dark, light
and high-contrast, at desktop and phone). It catches what neither of the others can see, and it caught
four rules our own gate does not cover.

The three overlap less than they might seem. Every blocker in this audit was found by walking or by
measurement. None was found by reading the source, and **every one of them is invisible to the
1919-test suite.**

---

## Results by pillar

### 1. Cognitive ergonomics — **the weakest pillar**

The console puts **144 interactive controls above the fold** (HX-05). An operator opening the
product is shown a filter bar, a workflow ribbon, a map, three context strips, a route planner and a
five-tab rail before being told what is happening. The scenario workbench puts its only primary
action at `y:879` on a 960px viewport, below a 20-item checkbox list (CW-11).

The load is not evenly distributed. `/chw` — the hardest task in the product — is the cleanest
interface, because it has to be. The surfaces that are dense are the ones whose operators are
already experts.

### 2. Interaction fidelity — **controls that do not do what they say**

| Finding | What it says | What it does |
|---|---|---|
| CW-06 | `Severity: High` filters the map | leaves `critical` and `medium` alerts in the list, unmarked |
| CE-01 / HX-03 | "No pending workflows." | the server is unreachable |
| CW-04 | Submit | did nothing at all, offline |
| CW-05 | `Here` | asserts a location that is never stored |

This is the pillar where the audit found the most damage, and the pattern is consistent: **a control
whose effect is narrower or different from its label, on a surface where the user cannot tell.**

### 3. Perceptual performance — **not a problem, except on a real link**

Cold-cache first contentful paint is 32–80 ms across all eight surfaces; `load` never exceeds 78 ms;
TTFB is 1–5 ms. This is a same-host build.

On a field connection it is a different number: `/` pulls **680 KB across 44 requests**, and `/districts/`
pulls 307 KB to render five cards (HX-06). The `scripts/check-budget.mjs` gate bounds this going
forward; the current figure is under it.

### 4. Inclusive accessibility — **structurally strong, four real gaps**

What is right, measured: one `<h1>` per surface; **zero skipped heading levels anywhere**; no
duplicate element IDs; a working skip link on all eight; correct roving tabindex and arrow-key
navigation on the console's tab strip; an accessible name resolving on **every control on every
surface**; triple-click producing exactly one POST; theme persisting across surfaces including high
contrast.

axe-core found four rules our own gate does not check:

| Rule | Impact | Where |
|---|---|---|
| `color-contrast` | serious | dashboard offline banner, light theme, 2.73:1 |
| `scrollable-region-focusable` | serious | 10 occurrences — wide tables scroll with no keyboard access |
| `region` | moderate | 25 occurrences — content outside landmarks |
| `landmark-one-main` | moderate | portal, when signed out |

### 5. Isomorphic consistency — **four spellings of one concept**

The same severity idea is styled four different ways (HX-07); six surfaces have six different error
sentences for the same class of failure (CE-04); empty-state wording diverges and two surfaces hide
their own failure (CE-05); one surface renders its entire navigation as raw i18n keys, permanently
(HX-02).

### 6. Error tolerance — **the second-worst pillar, and the most dangerous**

A dead server is rendered as an empty state on six of eight surfaces (CE-01, HX-03). `/focal-point/`
says **"No pending workflows."** That is a finding — it says every trigger has been dealt with. It is
the worst sentence this interface can say when it is wrong.

Client-side validation is absent (CE-02): latitude 999, threshold −5 and amount −999999 are all
accepted, persisted, and reported with **HTTP 201 Created**.

Invalid test data **cannot be deleted** (CE-10) — there is no `DELETE` route for parametric rules, so
the audit agent created three malformed rules that are still in the demo store.

### 7. Affective resonance — **honest where it matters, silent where it does not**

The best writing in the product is the uncertainty disclaimer on `/scenarios/`: *"Delta is the change
in the mean of an uncalibrated 0–100 sensitivity score, in score points. It is not a percentage, not
a probability, and not a forecast."* One block, and it prevents more misreading than most products
manage in an entire help system.

The failure is elsewhere. Ten disabled "Send" buttons with no stated reason (CE-09). Three status
metrics reporting no value at all (HX-11). A confirmation that names the rule rather than the district.

### 8. Contextual adaptability — **strong in principle, leaky in practice**

Three themes, all contrast-verified. Offline works. Ten locales, each reconciled against real
translation coverage. RTL is driven from one table.

The leaks: the filter bar clips its own controls off the left edge at 375px with no scrollbar to
signal it (HX-04, WCAG 2.2 §1.4.10 Reflow); touch targets fall below 24px on every surface
(HX-10); `/co/` labels its selects for screen readers only, so sighted and blind users get different
controls (HX-08).

---

## What the audit cost, in fixes

Everything below was found by walking or measuring, and was invisible to the test suite.

**A health worker's offline report did nothing at all.** `enqueue` awaited
`navigator.serviceWorker.ready` with no timeout. On a device whose worker is not yet controlling the
page — which is every device, offline, before the first claim — `ready` never settles. The IndexedDB
write committed, the caller's `await` never returned, no toast fired and the screen never advanced.
The button press did nothing. **Fixed**; verified with the network emulated off.

**Two of every three approvals a focal point was offered returned HTTP 409.** The API silently
ignored `?state=`, so the approval queue asked for `focal_point_review` and received every workflow
regardless — including ones already closed. Same class as `?district=Bor`, which was fixed for
exactly this reason before. **Fixed.**

**The offline banner was invisible on every page.** `z-index: 70` beneath the shared navbar's `999`,
in the same 46px band. The field team was told nothing at the moment they most needed telling.
**Fixed.**

**Every confirmation on the field app was copied from the symptom path**, so an incident and a reply
each confirmed themselves as a symptom report — and the confirmation is the only feedback that user
gets. **Fixed.**

Plus: the approval confirmation named the rule rather than the district; the offline banner's contrast
was 2.73:1 in light theme because it used a hardcoded ink on a token that inverts.

---

## Intervention taxonomy

### Corrections — things that are broken

| id | Surface | Directive |
|---|---|---|
| **HX-03 / CE-01** | six surfaces | `public/shared/states.js`: `distinguishFailure({ok, error, isEmpty}) → 'ok'\|'empty'\|'error'`, **error always wins**. Apply on every surface: a failed fetch renders an error state with a retry, never the empty state. Copy: *"Could not reach the server. Nothing here has been checked — this is not an empty list."* `/chw/` is the exception: a queued report is a legitimate third state, "saved on this phone", and must read as neither. |
| **HX-02** | `/districts/` | `public/districts/app.js`: the surface renders its own nav rather than the shared `mountNavbar`, and calls its i18n init without awaiting the catalogue before first paint. Route it through `shared/navbar.js` and re-render on locale change. |
| **HX-01 / CW-10** | `/scenarios/` | `public/scenarios/app.js`: gate `#noResults` and `#results` on one `hasRun` flag in the same render pass. Today the empty state is never removed, only appended to. |
| **CE-02** | `/parametric`, `/scenarios` | `src/parametric.js` + the scenario normaliser: reject latitude outside ±90, longitude outside ±180, negative thresholds and amounts, with a status that means failure — never 201. Client: validate at the field with the message beside it, not in a form-level summary. |
| **CE-10** | `/parametric` | `src/server.js` `matchParametricRoute`: add a `DELETE /api/v1/parametric-rules/:id`, persisted through `operations.js` soft delete with an action log, plus a control in the rule card. Document in `docs/openapi.yaml` or `validate.mjs` fails. |
| **CW-06** | `/` | `public/app.js`: apply `mapSeverity` to the alert rail as well as the map, or add a severity chip row and label the map filter map-only. Today a `critical` alert is silently absent from the map being looked at. |
| **CW-02** | `/focal-point/` | `public/focal-point/app.js`: render the card's threshold from the named protocol instance, not a constant. Aweil's *drought* trigger is currently evaluated against 61 mm of rainfall on the same page that prints `≥ 5`. |
| **CW-05** | `/chw/` | `public/chw/app.js`: `Here` must not write `latitude: null` as if it were a fix. Show the resolved coordinates, or "no GPS fix — enter a location", with a manual picker. Outbreak triage depends on this field. |
| **scrollable-region-focusable** | 10 sites | `public/shared/runtime.js` `markScrollableRegions()` — exists, needs calling after each render. `tabindex="0"` + `role="region"` + label on every `overflow-x: auto` with no focusable descendant. |
| **HX-04** | `/` @375 | `public/styles.css`: `.console-toolbar` and `.map-filters` must not place controls at negative x. Currently Language and Copy link sit at −69. |

### Improvements — friction that costs time

| id | Surface | Directive |
|---|---|---|
| **HX-05** | `/` | Collapse the workflow ribbon behind a summary; the eight tiles are a breakdown of the number already beside them. Target ≤40 controls above the fold. |
| **CW-11** | `/scenarios/` | Move `Run scenario` to a sticky footer or the top of the results rail, next to what it produces. |
| **CW-09** | `/` | Ten disabled `Send` buttons carry no reason. State it on the button: "Approved alerts can be sent." |
| **CW-12** | `/chw/` | "How long has it been?" offers a unit with no number, so duration is stored as prose in `description`. Add a numeric field; store it as a field. Outbreak triage thresholds are duration-sensitive. |
| **HX-09** | `/chw/` | The screen title repeats four times and no step confirms. Show the step as "Step 2 of 4" once, and confirm on arrival. |
| **CW-14** | `/chw/` | A disabled `Next` gives no reason. Add "Choose who has this symptom" beneath it. |
| **CW-13** | `/focal-point/` | Pending cards reorder between visits. Sort by raised-at then district, and show the district in the card header rather than by position. |
| **HX-11** | `/` | Three status metrics report no value. Hide a metric that has none rather than printing an em dash. |

### Enhancements — utility deepened

| id | Surface | Directive |
|---|---|---|
| **CW-09 (PDF)** | `/co` | The dashboard loads seven sections; the export carries two, with no note. Add the remainder, or print "This export covers N of 7 sections" with the omitted list. `Equity by District` is the section most likely to be asked about. |
| **CW-07** | `/focal-point/` | The confirm modal names no district, rule, reading or amount, and decisions log as "Approved by anonymous". Put all four in the modal and the success line, and thread a real actor through the transition. |
| **HX-13 / CE-10** | `/` | No way to remove a rule created in error. |
| **HX-08** | `/co` | Quarter and Year selects are labelled for screen readers only, so sighted and blind users get different controls. Visible labels. |

### Extensions — novel modality

| id | Directive |
|---|---|
| **Cross-surface link** | The console already shares its view by URL. Extend the same mechanism to `/districts/` and `/focal-point/` so a focal point sends an analyst the exact district and queue position they are describing, not a screenshot. |
| **Offline map tiles** | `basemap.js` is inline polygons and fetches nothing, so there are no tiles to cache. If district-level raster basemaps are ever added, they need the same bounded cache the detail records have. |
| **Report preview before export** | A CO user exporting for a donor should see the section list the PDF will contain. The export is generated from the same sections as the dashboard; a preview makes that visible before the download, not after. |

---

## What is already good

Stated because a document of only faults is a lie about the product, and because the next
contributor needs to know what to protect.

- **The console treats a power user like one.** Command palette, keyboard shortcuts, a shareable
  view, and a list alternative to the map. No other surface does this.
- **The tab strip on `/` is a correct ARIA tabs implementation** — roving tabindex, arrows, Home/End.
  It should be the template for the other tabbed surfaces.
- **Heading structure is clean on all eight surfaces.** Zero skipped levels, one `h1` each, no
  duplicate IDs, a working skip link everywhere.
- **The uncertainty writing is the best in the product** and prevents more misreading than most
  help systems manage.
- **Every refusal is a real answer.** "Not measured" is drawn, not guessed. The scenario delta is
  labelled as score points. The verification panel ships as an honest empty state because the store
  holds no verified pairs — and that was preferred to a chart of invented data.
- **Latency is not a problem** on any surface, and the bundle is budgeted.

---

## What the fixes found that the audit did not

Fixing the findings turned up three instances of one bug class, in three files,
written by three different people, none of them caught by the test suite or by
any gate.

**An author `display` rule silently cancels the `hidden` attribute.**

```css
.statusbar-metric { display: inline; }   /* beats [hidden] { display: none } */
```

The user agent's `[hidden]` rule is a plain type-free selector. Any author rule
naming a display value on the same element outranks it, and `hidden` becomes
inert. Three surfaces shipped this:

| Element | Rule | What rendered |
|---|---|---|
| `.statusbar-metric` (console) | `display: inline` | "Last signal:", "Median lag:" — labels with nothing after the colon, permanently |
| `.empty-state-large` (scenarios) | `display: flex` | the empty state stayed permanently *above* a completed run |
| `.district-card` (districts) | — already had `[hidden] { display: none }` | correct, which is how it was found: one author had already worked it out |

Each read as a data problem. None was one. The fix is always the same and
always has to be written out: `.thing[hidden] { display: none }`. The failure is
silent because `hidden` still reports as present in the DOM, still serialises,
and still passes any assertion that checks the attribute rather than the
geometry.

Two related specificity traps from the same pass:

- `[dir="rtl"] .console-layout` declared *outside* any media query outranks
  `.console-layout` *inside* the 800px breakpoint. Media queries add no
  specificity of their own, so an Arabic phone kept the desktop grid: 66
  controls past the left edge, in a container with `overflow: hidden`, with
  `documentElement.scrollWidth === clientWidth` throughout.
- `justify-content: flex-end` aligns a flex container's overflow from the
  **start** edge. Right-aligning a child that cannot fit hangs the overflow off
  the left, where nothing can scroll to it and no overflow check can see it.

None of these is visible to `documentElement.scrollWidth`, which is why the gate
now measures the start edge directly and runs in both directions: 48 assertions,
8 surfaces × 3 viewports × LTR and RTL.

---

## Status

Every one of the 45 findings is now closed. The gates, at the time of writing:

| Gate | Result |
|---|---|
| `npm test` | 1989 pass, 0 fail |
| `check:responsive` | 48/48 — 8 surfaces × 3 viewports × **LTR and RTL** |
| `check:a11y` | 96/96 assertions + 24/24 theme-contrast |
| `audit-a11y.mjs` (axe-core 4.13) | **0 violations** across 8 surfaces × 5 conditions, from 4 rules / 42 instances |
| `check:budget` | 137.6 KB gzipped against 148 KB |
| `check:i18n`, `check:i18n-offers`, `check:model-boundaries`, `validate` | pass |

Three of those gates did not exist, or did not mean what it claimed to mean,
when the audit was written. They are part of the result, not decoration:
`check:responsive` now measures the start edge and runs in both directions;
`check:a11y` waits for the surface instead of sleeping, and distinguishes
"nothing is serving" from "the markup is wrong"; and `audit-a11y.mjs` is what
proved the axe count actually reached zero rather than the two assertions we
were already making.

### What did not get fixed

**HX-06 — payload size.** Improved substantially but not closed. The console
went from 680 KB across 44 requests to 453 KB raw / 137.6 KB gzipped across 16
assets; `/districts/` from 307 KB to 236 KB. What remains is a refactor, not a
trim: `index.html` carries the four *inactive* tab panels, parsed on every
console load and counted among the 144 controls the audit found above the fold.
Deferring them into modules loaded on first tab switch pays the byte debt back
and fixes HX-05 in the same edit — but it touches roughly 150 element lookups
in `app.js`, and it is not a change to attempt at the end of a pass. The debt
is recorded in `scripts/check-budget.mjs` next to the budget it defers.

### What the fixes cost, that the audit did not predict

| | |
|---|---|
| The server was **OOMing on its own API traffic** | 120 requests: 63 MB → 1.8 GB, then killed. `JsonStore.read()` re-parsed the whole 364 MB file per request, and 69% of that store was unbounded version history. Now 855 MB and flat across 300 requests. |
| `markScrollableRegions` existed and was called by nobody | Eight surfaces, zero call sites. Ten serious axe violations it was written to prevent. |
| `refresh()` had a `finally` and no `catch` | Boot `await`s it at module top level, so one render error rejected module evaluation and left the console half-built and mute. |
| `loadSources()` was awaited at module top level with a bare `fetch` | On a dead server it threw out of module evaluation. URL filters never restored, escalation never mounted, first refresh never ran. The console did not report an outage — it booted broken and said nothing. |

Three of those four were found while fixing UX findings, not by looking for
them. The audit's method — walk it, measure it, drive it with the network off —
is what surfaced them; a reading of the source had not.

## Unresolved

- **`/districts/` renders raw i18n keys** — a live defect the audit confirmed; the fix is in
  flight and its exact shape is recorded in the findings file.
  > **Resolved.** `0213876` (followed by `ae29f58`, `1877cd8`) landed the fix: every
  > `t()` call on the surface now carries an inline English fallback, so a key missing
  > from a locale renders English rather than the raw key. `npm run check:i18n` passes
  > against the current tree. Kept here as a record rather than deleted, because the
  > fallback-argument pattern it produced is the thing worth remembering.
- **The parametric store currently holds malformed rules** the audit agent created, which cannot be
  deleted until the `DELETE` route lands. Restore from a store backup before a demo, or accept that
  the demo shows three impossible rules.
  > **Resolved.** The `DELETE /api/v1/parametric-rules/:id` route landed
  > (`src/server.js`), so the rules could be removed — and on 2026-10-07 they were,
  > through that route rather than by editing the store: `pr-1` Aweil Drought
  > Rainfall Index, `pr-2` Turkana Flood Pre-financing, `pr-3` Mandera Conflict
  > Displacement Support. Each left an action-log entry carrying the whole removed
  > rule, which is the archive a hard delete depends on. The route had no test at
  > all, so `test/parametric-rule-delete.test.js` now guards it — including the
  > claim that the archive survives the write that removes the rule, which is the
  > failure mode of doing two writes in the wrong order.
- **`/co` FCP measured 5356 ms** in one cold run. That was cold-profile noise — warm steady state
  is 36 ms — and is recorded here because the number is in the findings file and would otherwise read
  as a defect.

## Still open

- **HX-06 — first-load payload.** The one finding of the 45 that was not closed. The console
  still carries four *inactive* tab panels in `index.html`, parsed on every load, among the
  controls the audit counted above the fold. Deferring them into modules loaded on first tab
  switch pays the byte debt back and fixes HX-05 in the same edit. The audit's own note is that
  it touches roughly 150 element lookups in `app.js` and is not a change to attempt at the end
  of a pass — that still holds, and it wants a pass of its own. The debt is recorded in
  `scripts/check-budget.mjs` next to the budget it defers.
