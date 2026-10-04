# Heuristic evaluation — Nielsen's ten heuristics across eight surfaces

**Date:** 2026-10-04
**Method:** Every finding below was observed by driving the running product over CDP (Chrome `:9333`) against the live server on `:4177`. Nothing is inferred from source. Screenshots were captured with `Page.captureScreenshot` at 1440×900 and 375×812; numbers come from probes injected with `Page.addScriptToEvaluateOnNewDocument` and from `Network.*` events.
**Surfaces:** `/`, `/portal/`, `/chw/`, `/co/`, `/districts/`, `/focal-point/`, `/parametric/`, `/scenarios/`
**Scope note:** This file covers Nielsen's heuristics. Cross-surface consistency, error handling and empty/loading/failure states are in `consistency-and-errors.md`. Automated axe findings (`region`, `scrollable-region-focusable`, `landmark-one-main`, `color-contrast` — 42 instances in `a11y.json`) are **not** repeated here.

## Where the product is genuinely good

Stated plainly, because most heuristic evaluations only list faults:

- **#7 Flexibility and efficiency — the ops console is the best surface in the product.** `/` ships a command palette (`Command palette`), `Copy link to this view` with a shareable hash, a `Keyboard shortcuts` section, and a `Show as list` alternative to the map. It is the only surface that treats a power user as a power user. Every other surface is strictly click-driven.
- **#4 Consistency — the tab strip on `/` implements the ARIA tabs pattern correctly.** Roving `tabindex` (`tab-alerts` at 0, the rest at −1) with working arrow-key navigation: `ArrowRight` moved focus `tab-alerts → tab-reports`, `End` moved it to `tab-settings`. This is the correct implementation and should be the template for the other tabbed surfaces.
- **#10 Help — the uncertainty disclaimer on `/scenarios/` is exemplary.** "Delta is the change in the mean of an uncalibrated 0–100 sensitivity score, in score points. It is not a percentage, not a probability, and not a forecast: the underlying score reflects data coverage as well as conditions." That single block prevents more misreading than most products manage in their entire help system. (`HX-19` notes the one flaw inside it.)
- **Heading hierarchy is clean on all eight surfaces.** Measured sequences — `1,2,3,2,2,2,3,3,2,3,3` (`/`), `1,2,2,2,2,2` (`/portal/`), `1,2,2,2,2,2,2` (`/co/`), `1,2,3,3,2` (`/districts/`), `1,2,2,2` (`/parametric/`), `1,2,2,2,2,3,3` (`/scenarios/`). **Zero skipped levels anywhere.**
- **No duplicate element IDs on any surface.** Checked every `[id]` on all eight.
- **Skip links are present, correctly off-screen, and uniquely targeted on all eight surfaces:** "Skip to alerts and panels", "Skip to alerts and tables", "Skip to report form", "Skip to dashboard content", "Skip to district content", "Skip to pending review", "Skip to page content", "Skip to scenario builder".
- **#3 User control and freedom — repeated activation is properly guarded.** Firing `/scenarios/` "Run scenario" three times in one tick produced exactly one `POST /api/v1/scenarios` (201). No duplicate scenario runs.
- **Perceived latency is not a problem anywhere.** Cold-cache FCP across all eight surfaces is 32–80 ms, `load` never exceeds 78 ms, TTFB is 1–5 ms. This is a same-host build; on a real field link the 680 KB that `/` pulls becomes the problem, not the server (`HX-06`).
- **`#4` theme selection persists across surfaces** and all four themes apply, including high contrast (`background-color: oklch(0 0 0)`, `color: oklch(1 0 0)`).

---

## Blockers

### HX-01 — `/scenarios/` keeps telling the user to do the thing they just did
- **Surface:** `/scenarios/`
- **Pillar:** Cognitive ergonomics · Error tolerance
- **Heuristics:** #1 Visibility of system status, #9 Help users recover from errors
- **Observed:** After a preset is chosen and "Run scenario" is clicked, the server returns `201` and a full Results panel renders — `+20.9 Flood risk score change`, `+9.1 Conflict risk score change`, `+11.2 Service impact score change`, a populated "Most affected service assets" table, and a "Share this scenario" block. The empty state **remains visible at full prominence directly above it**, reading:

  > **No scenario run yet**
  > Choose a scenario on the left, adjust it if you like, then run it. The results show how the model responds — not a forecast.
  > The right-hand numbers come back as soon as you run one.

  Probe: `[...document.querySelectorAll('.empty-state-large')].map(e => [text, e.getClientRects().length > 0])` returns `true` — still rendered, not merely present in the DOM. Screenshot `scen-run.png` shows both blocks on screen simultaneously.
- **Who it hurts:** An analyst who has just run a model is told, in the largest type on the page, that they have not run one. It reads as a rendering failure and undermines confidence in the numbers directly beneath it.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** Hide `.empty-state-large` in the same render pass that populates Results; gate both on one explicit `hasRun` flag.

### HX-02 — `/districts/` renders its entire primary navigation as untranslated i18n keys, permanently
- **Surface:** `/districts/`
- **Pillar:** Isomorphic consistency · Contextual adaptability
- **Heuristics:** #4 Consistency and standards, #2 Match between system and the real world, #6 Recognition rather than recall
- **Observed:** Screenshot `districts-1440.png` shows the top bar reading `nav.ops  nav.focal_point  nav.chw  nav.portal  nav.co  nav.scenarios  nav.parametric  nav.districts`, and the locale control labelled `districts.locale_label`. The off-screen skip link reads `districts.skip_link`.

  Sampled at 500 ms, 2 s, 5 s and 9 s after navigation: **8 raw keys present at every sample, never resolved.** Every other surface renders "Ops", "Focal Point", "CHW", "Portal", "CO", "Scenarios", "Parametric", "Districts". `/districts/` is the only surface that renders its navbar keys unresolved. Firing a `change` event on `#locale-select` does resolve them, which is why the bug is intermittent in manual testing and survives automated snapshot checks.
- **Who it hurts:** Every user on that surface, sighted or not. It also means the surface can never be translated at all — the raw keys are what a translator would receive.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** `/districts/` renders its own navbar instead of `public/shared/navbar.js`; route it through the shared component, or ensure the i18n pass runs after first paint rather than only on `change`.

### HX-03 — Four surfaces report a dead server as an ordinary empty state
- **Surface:** `/`, `/portal/`, `/chw/`, `/focal-point/` (silent) · `/parametric/` and `/scenarios/` (misleading)
- **Pillar:** Error tolerance
- **Heuristics:** #1 Visibility of system status, #9 Help users recover from errors
- **Observed:** With every `/api/` request failed via CDP `Fetch.failRequest` (`ConnectionFailed`), then a 6 s settle:

  | Surface | What the user sees |
  |---|---|
  | `/` | No error. Status bar reads `0 queued  Last signal:  Last action:  Median lag:` |
  | `/portal/` | No error. Body reads "Authentication is not configured" |
  | `/chw/` | No error. Health Report form renders normally |
  | `/focal-point/` | No error. "No pending workflows." |
  | `/parametric/` | **"No rules defined yet. Add one below to start simulating."** |
  | `/scenarios/` | "No scenario run yet Choose a scenario on the left…" |

  The parametric and scenario messages are not merely silent — they are false. They assert a fact about the world ("you have no rules") that the client never verified.
- **Who it hurts:** A country-office analyst whose link dropped will conclude their partners have filed nothing, and will act on that. A focal point will see an empty approval queue and believe there is nothing to approve.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** Distinguish "fetch failed" from "fetch returned zero rows" at every render site; on failure show an explicit error with a Retry control rather than the empty state.

### HX-04 — The ops console filter bar overflows the phone viewport and clips its own controls
- **Surface:** `/` at 375×812
- **Pillar:** Contextual adaptability
- **Heuristics:** #4 Consistency and standards, #6 Recognition rather than recall
- **Observed:** `DIV.workflow-tray` reports `scrollWidth: 1200`, `clientWidth: 375`, `scrollLeft: 12` — **3.2× the viewport**, inside a horizontally scrollable container with no visible affordance. Four of its controls are physically off-screen at rest:

  | Control | `getBoundingClientRect().left` |
  |---|---|
  | Language select | −69 |
  | "Copy link to this view" | −69 |
  | Severity select ("All / Critical / High…") | −13 |
  | Source select (17 sources) | −20 |

  Screenshot `root-375.png` confirms: the toolbar is cut mid-word at the left edge, and "Show as list" is reduced to a `]`. `documentElement.scrollWidth === clientWidth === 375`, so no page-level horizontal scrollbar exists to signal that anything is hidden — the reflow failure is silent. This also breaches WCAG 2.2 §1.4.10 Reflow, which `check-a11y.mjs` does not test.
- **Who it hurts:** The on-duty operator on a phone — the person most likely to be away from a desk and most likely to be filtering by severity or source.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** Replace the horizontal tray with a wrapping flex/grid at ≤480 px; never rely on an undecorated `overflow-x` scroller for primary filters.

---

## Major

### HX-05 — 144 interactive controls sit above the fold on the ops console
- **Surface:** `/`
- **Pillar:** Cognitive ergonomics · Perceptual performance
- **Heuristics:** #8 Aesthetic and minimalist design, #6 Recognition rather than recall
- **Observed:** `document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[tabindex]')` returns **233 visible controls, 144 of them above the fold at 1440×900**. Before the map is visible the user must pass: navbar (9), theme + locale (2), connection badge, "json", refresh, "Copy link to this view", command palette, Time, Severity, Source, cold-chain toggle — then eight workflow-type cards, then "Open instances", then the map, then a second five-tab rail. The primary task (approve or reject an alert) is at the far right, below the fold.
- **Who it hurts:** Everyone, disproportionately under time pressure. An operator triaging an active flood event pays this cost on every visit.
- **Severity:** major
- **Classification:** improvement
- **Fix:** Collapse the eight workflow-type cards into a filter row; demote "json", refresh and command palette behind the palette; move approval into the primary column.

### HX-06 — `/` ships 680 KB across 44 requests; `/districts/` 307 KB to render five cards
- **Surface:** `/`, `/districts/`
- **Pillar:** Perceptual performance · Contextual adaptability
- **Heuristics:** #4 Consistency and standards
- **Observed:** Cold cache, `Network` accounting (`transferSize` summed over resource timing):

  | Surface | Transfer | Requests |
  |---|---|---|
  | `/` | **680 KB** | 44 |
  | `/districts/` | **307 KB** | 18 |
  | `/co/` | 113 KB | 18 |
  | `/focal-point/` | 93 KB | 16 |
  | `/scenarios/` | 79 KB | 12 |
  | `/portal/` | 78 KB | 16 |
  | `/chw/` | 75 KB | 14 |
  | `/parametric/` | 70 KB | 13 |

  On the same host these land in under 80 ms, which is why `latency` looks fine. On a 2G field link 680 KB is the dominant cost. The worst offenders on `/` are `api/v1/climate?limit=200` (114 KB), `api/v1/rapidpro/dispatches?limit=200` (15.6 KB) and `api/v1/workflows?limit=200` (10.4 KB). `/districts/` eagerly fetches every district's full detail — `bor` 57 KB, `turkana` 56 KB, `karamoja` 38 KB, `mandera` 32 KB — to draw five summary cards.
- **Who it hurts:** Field users on metered or 2G connections; partner organisations behind institutional proxies.
- **Severity:** major
- **Classification:** improvement
- **Fix:** Make `/districts/` cards lazy — fetch a summary endpoint, load detail on card activation. Paginate or cap the `limit=200` series behind the map.

### HX-07 — The same severity concept is styled four different ways
- **Surface:** `/districts/` vs `/`
- **Pillar:** Isomorphic consistency
- **Heuristics:** #4 Consistency and standards, #1 Visibility of system status
- **Observed:** Computed styles for severity chips:

  | Property | `/districts/` | `/` |
  |---|---|---|
  | `text-transform` | `uppercase` → `CRITICAL` | `none` → `critical` |
  | `border-radius` | `3px` (square chip) | `999px` (pill) |
  | `color` | `oklch(0.24 0.015 260)` — neutral grey | `oklch(0.44 0.12 155)` — hue-matched |
  | `background` | `oklch(0.42 0.2 25 / 0.2)` (critical) | `oklch(0.44 0.12 155 / 0.14)` (green) |
  | `border-top-width` | `1px` grey | `0px` |

  On `/districts/` the chip background carries the severity hue but the text is neutral grey — the colour signal is washed out, and `CRITICAL`/`HIGH` are distinguished by case rather than by anything stronger than two nearly identical tints. On `/` the same concepts are lowercase pills.
- **Who it hurts:** A user moving between the district list and the console has to re-learn what severity looks like on every hop.
- **Severity:** major
- **Classification:** correction
- **Fix:** One severity token set — case, radius, and hue-matched foreground — applied everywhere.

### HX-08 — `/co/` labels its Quarter and Year selects for screen readers only
- **Surface:** `/co/`
- **Pillar:** Inclusive accessibility · Cognitive ergonomics
- **Heuristics:** #6 Recognition rather than recall
- **Observed:** `#quarter-select`, `#year-select` and `#locale-select` each have a real `<label>`, but the labels are computed as `position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden`. Screenshot `co-1440.png` shows three stacked dropdowns reading `Q4`, `2026`, `English` with no visible labels — a sighted user cannot tell whether the first is a quarter or a scenario.
- **Who it hurts:** Every sighted user of the CO dashboard; the report's most-used control pair is unlabelled.
- **Severity:** major
- **Classification:** correction
- **Fix:** Show the labels visually; they cost one line each and remove all ambiguity.

### HX-09 — The CHW surface repeats one heading four times and offers no confirmation
- **Surface:** `/chw/`
- **Pillar:** Cognitive ergonomics · Error tolerance
- **Heuristics:** #2 Match between system and the real world, #3 User control and freedom
- **Observed:** Heading sequence is `h1 "Health Report"` then four consecutive `h2`s all with the identical text "Report symptom", followed by `h2 "About the patient"`, `h2 "Report incident"`, `h2 "Reply to alert"`. Four identical headings give a screen-reader user no way to tell the sections apart. The visible form inventory is small — a single `includeNameToggle` checkbox labelled "Include my name — Your identity stays private." (correctly translated when the surface is in Swahili: "Weka jina langu — Utambulisho wako utabaki w…") and three submit buttons.
- **Who it hurts:** A screen-reader user navigating by heading; a low-literacy user scanning for the right section.
- **Severity:** major
- **Classification:** correction
- **Fix:** Give each section a distinct heading naming what is submitted.

---

## Minor

### HX-10 — Touch targets fall below 24 px on every surface
- **Surface:** all eight, worst on `/`
- **Pillar:** Inclusive accessibility · Contextual adaptability
- **Heuristics:** #4 Consistency and standards
- **Observed:** Sub-24 px in-viewport hit areas at 1440×900:

  | Surface | Count | Examples |
  |---|---|---|
  | `/` | **91** | 8 map markers at `18×18`; `coldChainToggle` `17×17`; "Copy link to this view" `127×17`; "Show as list" `78×17` |
  | `/scenarios/` | 6 | 17 asset checkboxes at `17×17` |
  | `/parametric/` | 3 | `ruleFocalPoint`, `simFocalApproved` at `17×17` |
  | `/chw/` | 2 | `includeNameToggle` `17×17` |
  | `/co/`, `/portal/`, `/districts/`, `/focal-point/` | 1 | the "Lindela" wordmark `72×20` |

  A native checkbox rendered at 17 px is below the 24×24 CSS-pixel minimum in WCAG 2.2 §2.5.8, and this is the primary field surface for community health workers on phones. The map markers at 18×18 are the worse case: they are the only way to reach a hazard record.
- **Who it hurts:** Field users with imprecise touch; users with motor impairments; anyone on a small phone in a moving vehicle.
- **Severity:** major
- **Classification:** correction
- **Fix:** Enforce a 24 px minimum via padding or a pseudo-element hit expander, on checkboxes and map markers first.

### HX-11 — `/` reports three status metrics with no values
- **Surface:** `/`
- **Pillar:** Perceptual performance · Error tolerance
- **Heuristics:** #1 Visibility of system status
- **Observed:** The status bar renders three `.statusbar-metric` elements. Measured content: `"Last signal:"`, `"Last action: 2 days ago"`, `"Median lag:"`. Two of the three carry a label with nothing after the colon — visible in `root-1440.png` at bottom-right as `Last signal:` and `Median lag:` with blank space where a value belongs. Under total API failure all three collapse to `0 queued  Last signal:  Last action:  Median lag:`.
- **Who it hurts:** An operator scanning for freshness cannot distinguish "no signal yet" from "the metric failed to compute" from "the panel is broken".
- **Severity:** minor
- **Classification:** correction
- **Fix:** Render an explicit placeholder ("—", "no signal in 7 d") rather than an empty value.

### HX-12 — `/focal-point/` header wraps badly and shows a raw locale code
- **Surface:** `/focal-point/`
- **Pillar:** Contextual adaptability · Isomorphic consistency
- **Heuristics:** #2 Match between system and the real world, #4 Consistency and standards
- **Observed:** Screenshot `fp-1440.png`: the role indicator renders as three stacked lines — `focal-` / `point` / `(en)` — and the "Sign out" button breaks to `Sign` / `out` inside a 64×50 box. The `(en)` is a machine locale code shown as if it were a role name. The header also states the product identity three times: the navbar wordmark "Lindela", the active nav item "Focal Point", and the H1 "Lindela Lite | Focal Point".
- **Who it hurts:** A focal point confirming a high-stakes decision on a laptop; the broken role chip undermines confidence at the moment of highest authority.
- **Severity:** minor
- **Classification:** correction
- **Fix:** Render the role name, not the locale code; `white-space: nowrap` on the action button; drop one of the three identity statements.

### HX-13 — `/` offers no way to remove a rule that was created in error
- **Surface:** `/parametric/`
- **Pillar:** Error tolerance
- **Heuristics:** #5 Error prevention, #9 Help users recover from errors
- **Observed:** Creating a rule is a one-way door. `matchParametricRoute` in `src/server.js` exposes `rules-list`, `rule-detail` and `simulate` only — there is no `DELETE`. The UI correspondingly offers Create and Simulate and nothing else. A rule created with a wrong threshold, wrong chain or wrong recipient group cannot be corrected or removed from any surface.
- **Who it hurts:** An operator who mis-enters a disbursement rule has no recourse; the record is permanent and still live.
- **Severity:** major
- **Classification:** extension
- **Fix:** Add an edit and an archive/delete affordance, with the same confirm pattern used for approve/reject.

### HX-14 — A long value is not truncated anywhere
- **Surface:** `/parametric/`
- **Pillar:** Error tolerance · Perceptual performance
- **Heuristics:** #5 Error prevention
- **Observed:** A rule created with a 500-character name renders a `STRONG` element measuring **4301 px wide** inside a 375 px viewport, `white-space: normal`, `overflow` unclipped. Its `.rule-meta` sibling renders at 3371 px. The page-level `scrollWidth` is contained only because an ancestor scrolls.
- **Who it hurts:** Any user on a phone; a wide overflow also pushes the whole card grid out of alignment.
- **Severity:** major
- **Classification:** correction
- **Fix:** Clamp rule names to 2 lines with `text-overflow: ellipsis`, and enforce a server-side max length on the field.

---

## Nielsen coverage summary

| # | Heuristic | Verdict | Findings |
|---|---|---|---|
| 1 | Visibility of system status | **Fails on failure paths** | HX-01, HX-03, HX-11 |
| 2 | Match system ↔ real world | Mostly holds | HX-02, HX-09, HX-12 |
| 3 | User control and freedom | **Holds** | — (double-click guarded; *but* HX-13 has no undo) |
| 4 | Consistency and standards | **Fails** | HX-02, HX-07, HX-10 |
| 5 | Error prevention | **Fails** | HX-13, HX-14 |
| 6 | Recognition rather than recall | Partial | HX-04, HX-08 |
| 7 | Flexibility and efficiency | **Strong on `/`, absent elsewhere** | — |
| 8 | Aesthetic and minimalist design | **Fails on `/`** | HX-05, HX-06 |
| 9 | Recover from errors | **Fails** | HX-03, HX-13 |
| 10 | Help and documentation | **Strong** | HX-19 (deliverable 2) |

## Pillar tally (heuristic evaluation only)

| Pillar | Count |
|---|---|
| Cognitive ergonomics | 5 |
| Interaction fidelity | 2 |
| Perceptual performance | 4 |
| Inclusive accessibility | 3 |
| Isomorphic consistency | 3 |
| Error tolerance | 6 |
| Affective resonance | 2 |
| Contextual adaptability | 4 |

## Classification tally

| Classification | Count |
|---|---|
| correction | 11 |
| improvement | 2 |
| enhancement | 0 |
| extension | 1 |