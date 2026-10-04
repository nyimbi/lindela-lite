# Cross-surface consistency, error handling, and state coverage

**Date:** 2026-10-04
**Method:** All eight surfaces driven live over CDP against `:4177`. Consistency claims come from computed styles, accessible-name resolution and DOM queries, not from reading CSS. Error tolerance was exercised by failing every `/api/` request via CDP `Fetch.failRequest` (`ConnectionFailed`), by submitting malformed and extreme values, and by firing repeated activations. Screenshots at 1440×900 and 375×812.
**Companion:** `heuristic-evaluation.md` (Nielsen's ten heuristics).
**Scope note:** axe violations already catalogued in `a11y.json` are not repeated.

---

## Part 1 — Consistency table

Each row compares one concept across all eight surfaces. "Agrees" means the surfaces are indistinguishable to a user; "Diverges" names the outliers.

| Concept | Agrees | Diverges | Evidence |
|---|---|---|---|
| **Locale coverage** | — | `/` offers **10** languages, `/focal-point/` **7**, `/chw/` **3**, `/co/` **2**, and `/portal/`, `/districts/`, `/parametric/`, `/scenarios/` offer **1** (English only) | `#locale-select` option count per surface, reset to `en` before counting. The product markets "seven languages" on `/chw/`; only `/` and `/focal-point/` can deliver it. |
| **Locale control label** | "Language" on 6 | `/co/` and `/parametric/` say **"Locale"** | label text of `#locale-select` |
| **Rendered nav labels** | 7 surfaces render "Ops", "Focal Point", "CHW"… | `/districts/` renders **`nav.ops`, `nav.focal_point`, `nav.chw`, `nav.portal`, `nav.co`, `nav.scenarios`, `nav.parametric`, `nav.districts`** | 8 raw keys at 500 ms, 2 s, 5 s **and** 9 s — never resolved. Screenshot `districts-1440.png`. |
| **Severity chip case** | — | `/districts/` `uppercase` ("CRITICAL"); `/` `none` ("critical") | `getComputedStyle().textTransform` |
| **Severity chip shape** | — | `/districts/` `border-radius: 3px`; `/` `border-radius: 999px` | computed `borderTopLeftRadius` |
| **Severity chip foreground** | — | `/districts/` `oklch(0.24 0.015 260)` (neutral); `/` hue-matched `oklch(0.44 0.12 155)` | computed `color` |
| **Date format** | "4 Oct 2026" on `/`, `/districts/`, `/parametric/` | `/` and `/co/` also emit raw ISO (`2026-10-04T13:06:26.036Z`); `/districts/` cards use relative ("3 days ago") | regex sweep of `document.body.innerText` per surface |
| **Number format** | `/` uses separators: `61,054`, `1,000`, `5,000` | `/co/` uses **none** — `4621`, `4073`, `5082`, `1420`, `2155`, `1333`; a separator sweep of `/co/` returned **zero** matches | `innerText` regex + per-node scan |
| **`<header>` landmark** | present on 4 | **absent** on `/`, `/districts/`, `/parametric/`, `/scenarios/` | landmark query per surface |
| **`<footer>` landmark** | present on 5 | **absent** on `/districts/`, `/parametric/`, `/scenarios/` | landmark query per surface |
| **Skip link** | all 8 have one, off-screen, uniquely targeted | — (clean) | text per surface, e.g. "Skip to report form" |
| **Heading levels** | all 8, **zero skipped levels** | — (clean) | heading sequences captured per surface |
| **Duplicate element IDs** | none on any surface | — (clean) | `[id]` frequency sweep |
| **Theme control** | all 8, 4 options, persists across surfaces | — (clean) | `data-theme` retained on navigation |
| **Build version reported** | `/portal/` and `/chw/` report `v0.2.0` | **`/` reports `v0.1.0`** — "v0.1.0 — open-source climate-conflict monitoring toolkit." | `innerText` match on a live page. `package.json` is at `0.2.0`; three HTML files hardcode a `v0.1.0` fallback that `fillAppVersion()` only overwrites when `/api/v1/health` answers. |
| **Select sizing** | 7 surfaces: control-width selects | `/scenarios/` locale select renders **1408 px wide** at 1440; `/` locale select 128 px | bounding rect |
| **Select labelling** | 6 surfaces show labels ("Time", "Severity", "Source") | `/co/` Quarter / Year / Locale labels are `clip-path: inset(50%)`, 1×1 px — **invisible to sighted users** | computed style + screenshot `co-1440.png` |

---

## Part 2 — Error handling

### CE-01 — A dead server is indistinguishable from an empty one
- **Surface:** `/`, `/portal/`, `/chw/`, `/focal-point/` · actively misleading on `/parametric/`, `/scenarios/`
- **Pillar:** Error tolerance
- **Observed:** Every `/api/` request failed. After 6 s:

  | Surface | Visible error element | What the user is shown |
  |---|---|---|
  | `/co/` | `.error-panel` | "This dashboard did not load — None of the quarterly figures could be loaded. Reload the page to try again." |
  | `/districts/` | `.error-panel` | "Could not load districts. The district data could not be loaded. Check the connection and try again." |
  | `/` | **none** | `0 queued  Last signal:  Last action:  Median lag:` |
  | `/portal/` | **none** | "Authentication is not configured" |
  | `/chw/` | **none** | The report form, fully interactive |
  | `/focal-point/` | **none** | "No pending workflows." |
  | `/parametric/` | **none** | "No rules defined yet. Add one below to start simulating." |
  | `/scenarios/` | **none** | "No scenario run yet" |

  The two surfaces that do report failure both name a recovery action in prose. The six that do not are silent, and two of them assert a false conclusion.
- **Who it hurts:** Anyone working from a degraded link — precisely the condition the product's offline-first messaging (`/`: "Offline. Changes will sync when you reconnect.") invites users to expect to be handled.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** One shared `renderLoadFailure(scope, err)` used by every surface; never fall through to the empty state on a rejected fetch.

### CE-02 — The client validates nothing; the server accepts out-of-range and negative values
- **Surface:** `/parametric/`, `/scenarios/`
- **Pillar:** Error tolerance
- **Heuristics:** #5 Error prevention
- **Observed:** Values were set through the native value setter (so the app's own listeners fired) and submitted.

  | Surface | Input | Client response | Server |
  |---|---|---|---|
  | `/parametric/` | all fields empty, "Create rule" clicked | `addRuleError` text `""`, element not visible | — |
  | `/parametric/` | threshold `-5`, amount `-999999`, currency `@@@@`, 300-char recipient group, 200-char metric | `addRuleError` text `""` | **rule persisted and appears in the list** |
  | `/parametric/` | 500-character rule name | `addRuleError` text `""` | persisted; renders as a 4301 px-wide element |
  | `/scenarios/` | latitude `999`, longitude `999` | `scenarioError` text `""`, element not visible | **`201 Created`** |
  | `/scenarios/` | latitude/longitude empty | `""` | **`201 Created`** |
  | `/scenarios/` | latitude `-91`, longitude `abc` | `""` | **`201 Created`** |

  Two validation strings exist in `public/scenarios/app.js` — "Latitude must be between −90 and 90, longitude between −180 and 180." and "Scenario events need both a latitude and a longitude." — but neither path reached them. Out-of-range and non-numeric coordinates are stored as 201.
- **Who it hurts:** The analyst, who believes a malformed scenario is a valid one; and whoever later reads the stored record.
- **Severity:** blocker
- **Classification:** correction
- **Fix:** Wire the existing validators to the submit path, add `min`/`max`/`step`/`pattern` attributes, and reject server-side as well.

### CE-03 — `/districts/` shows an error and "Loading." simultaneously, forever
- **Surface:** `/districts/`
- **Pillar:** Error tolerance
- **Heuristics:** #1 Visibility of system status
- **Observed:** Under API failure the page shows `.error-panel` — "Could not load districts. The district data could not be loaded. Check the connection and try again." — while `#app-status` still reads **"Loading."** at 6 s. The status line never resolves to a terminal state. `/co/` by contrast resolves its status to "Could not load the dashboard for 2026 Q4."
- **Who it hurts:** A user who reads the status line first — the one place designed to be the source of truth — is told the load is still in progress.
- **Severity:** major
- **Classification:** correction
- **Fix:** Drive the status line from the same terminal state as the error panel.

### CE-04 — Six different error sentence shapes for the same class of failure
- **Surface:** codebase-wide
- **Pillar:** Isomorphic consistency · Error tolerance
- **Observed:** Harvested verbatim from the built surfaces:

  - "Could not load districts." *(period)*
  - "Could not load the dashboard for {period}." *(parameterised)*
  - "Could not load this district."
  - "Could not load alert"
  - "Alert evaluation failed"
  - "Alert rule creation failed"
  - "Failed to load signal-to-action metrics:" *(trailing colon, then a cause)*
  - "Failed to load workflow metrics:"
  - "Operations controls failed to load:"
  - "Escalation view failed to load:"
  - "Record search failed to load:"
  - "Error: ${err.message}" *(raw interpolation)*
  - "Dispatch failed: " *(trailing space, no noun)*
  - "Ingestion failed"
  - "Distribute failed"
  - "Distribution failed"
  - "Counts unavailable"
  - "No data available"

  Eight verbs and four punctuation conventions for what is, to the user, one event.
- **Who it hurts:** A user who has learned one phrasing cannot scan for it elsewhere; support cannot grep for a class of failure.
- **Severity:** minor
- **Classification:** improvement
- **Fix:** One template — `Could not load <thing>. <reason>. <next action>.` — with `<thing>` supplied by the caller.

### CE-05 — Empty-state wording diverges, and two surfaces hide their own failure
- **Surface:** all
- **Pillar:** Isomorphic consistency · Error tolerance
- **Observed:** Six distinct empty-state voices:

  | Surface | Wording |
  |---|---|
  | `/portal/` ×4 | "No data available" — identical text in all four panels, naming nothing |
  | `/` (map list) | "No records match the current filters." |
  | `/` (equity) | "No equity data yet. Alerts must be dispatched and reviewed." |
  | `/parametric/` ×3 | "No rules defined yet. Add one below to start simulating." · "Create a rule first, then simulate here." · "No simulations yet." |
  | `/scenarios/` | "No scenario run yet" |
  | `/focal-point/` | "No pending workflows." |

  The `/` equity message is the only one that explains what would fill the gap. The four `/portal/` panels say the same four words four times, so a partner user cannot tell which of Risk Overview / Hazard Events / Service Assets / Alerts Sent to Me is empty. Under API failure `/parametric/` and `/focal-point/` serve these as fact (`CE-01`).
- **Who it hurts:** A partner-org user on `/portal/` gets four identical, contextless panels; an operator on `/focal-point/` sees "No pending workflows." and cannot tell whether the queue is genuinely clear or the fetch failed.
- **Severity:** major
- **Classification:** correction
- **Fix:** Name the thing that is empty and, where one exists, the action that fills it.

### CE-06 — A machine token is exposed inside user-facing explanatory prose
- **Surface:** `/scenarios/`
- **Pillar:** Affective resonance
- **Observed:** The otherwise excellent disclaimer reads:

  > Delta is the change in the mean of an uncalibrated 0–100 sensitivity score, in score points. It is not a percentage, not a probability, and not a forecast: the underlying score reflects data coverage as well as conditions, and carries **`calibrated_uncertainty: false`**. Averaged over 16 region scores.

  `calibrated_uncertainty` is a field name from the data model, rendered mid-sentence in a paragraph written for humans.
- **Who it hurts:** Every reader. It reads as a debug artefact left in production copy and undercuts a paragraph whose entire purpose is to establish trust.
- **Severity:** minor
- **Classification:** correction
- **Fix:** "and has not been calibrated for uncertainty."

---

## Part 3 — Empty, loading and failure states

### Coverage by surface

| Surface | Loading indicator | Empty state | Failure state | Retry affordance |
|---|---|---|---|---|
| `/` | statusbar + "online"/"Offline" badge | per-panel notes | **none** | none |
| `/portal/` | none | 4 × "No data available" | **none** | none |
| `/chw/` | none | none | **none** | none |
| `/co/` | `#loading-banner` | per-section | `#load-error` `.error-panel` | prose only ("Reload the page to try again") |
| `/districts/` | `#loading-msg`, `#app-status` "Loading." | none | `.error-panel` | prose only |
| `/focal-point/` | none | "No pending workflows." | **none** | none |
| `/parametric/` | none | 3 × notes | **none** | none |
| `/scenarios/` | none | "No scenario run yet" | **none** | none |

No surface offers a **button**-level retry. Two offer a sentence telling the user to reload, which discards their filter and period state.

### CE-07 — Six surfaces have no loading state at all
- **Surface:** `/portal/`, `/chw/`, `/focal-point/`, `/parametric/`, `/scenarios/`, and `/`
- **Pillar:** Perceptual performance
- **Observed:** Measured status-line transitions after navigation start: the status element's text **never leaves its initial state** on `/portal/`, `/chw/`, `/focal-point/`, `/parametric/` or `/scenarios/` (probe returned no transition at 1440 or 375). Only `/co/` and `/districts/` resolve their status line ("Loaded 7 sections for 2026 Q4." at 18 ms; "5 of 5 districts listed." at 23 ms). The transition is also invisible: on those two surfaces the status changes from empty to its final text with no intermediate "Loading…" state.
- **Who it hurts:** A user on a slow link sees an unchanging page and cannot tell work is in progress.
- **Severity:** minor
- **Classification:** improvement
- **Fix:** A shared three-state status component — working / done / failed — rendered on all eight.

### CE-08 — Rapid double-click is correctly guarded
- **Surface:** `/scenarios/`
- **Pillar:** Interaction fidelity
- **Observed:** Three `.click()` calls dispatched synchronously on "Run scenario"/"Run again" produced exactly **one** `POST /api/v1/scenarios` (201). No duplicate submission.
- **Severity:** n/a — **no finding.** Recorded because the brief asked for it and the result is clean.
- **Classification:** correction (nothing to correct)

---

## Part 4 — Latency (measured, cold cache, cache disabled)

`FCP` and `load` from `PerformanceNavigationTiming`; `shell` = first paint with a non-empty body, sampled at 6 ms.

| Surface | FCP 1440 | FCP 375 | load 1440 | load 375 | Transfer | Requests |
|---|---|---|---|---|---|---|
| `/` | 64 ms | 80 ms | 71 ms | 78 ms | 680 KB | 44 |
| `/portal/` | 36 ms | 32 ms | 37 ms | 35 ms | 78 KB | 16 |
| `/chw/` | 44 ms | 44 ms | 46 ms | 38 ms | 75 KB | 14 |
| `/co/` | 36 ms | 36 ms | 34 ms | 31 ms | 113 KB | 18 |
| `/districts/` | 36 ms | 36 ms | 30 ms | 29 ms | 307 KB | 18 |
| `/focal-point/` | 56 ms | 44 ms | 50 ms | 36 ms | 93 KB | 16 |
| `/parametric/` | 52 ms | 44 ms | 37 ms | 32 ms | 70 KB | 13 |
| `/scenarios/` | 40 ms | 40 ms | 36 ms | 35 ms | 79 KB | 12 |

TTFB is 1–5 ms everywhere. `/` is consistently the slowest first paint at both widths, tracking its 680 KB payload. A first-visit run in a fresh profile produced outliers up to FCP 5356 ms on `/co/`; a warm second run returned to the figures above, so treat the cold-profile worst case as the honest bound for an unprimed field device.

**Interaction determinism summary** (all eight surfaces, every visible control):

| Surface | Visible controls | Above fold | No accessible name | Not keyboard-reachable | Disabled with no stated reason | Sub-24 px above fold |
|---|---|---|---|---|---|---|
| `/` | 233 | 144 | 0 | 0 (tablist uses roving tabindex — correct) | **10** | 91 |
| `/portal/` | 14 | 14 | 0 | 0 | 0 | 1 |
| `/chw/` | 17 | 17 | 0 | 0 | 0 | 2 |
| `/co/` | 21 | 16 | 0 | 0 | 0 | 1 |
| `/districts/` | 20 | 20 | 0 | 0 | 0 | 1 |
| `/focal-point/` | 21 | 17 | 0 | 0 | 0 | 1 |
| `/parametric/` | 26 | 26 | 0 | 0 | 0 | 3 |
| `/scenarios/` | 52 | 24 | 0 | 0 | 0 | 6 |

Accessible names resolve on **every** control on every surface — the skip link, nav, theme, locale, filters, form fields and checkboxes all resolve via label, aria-label or text. The one systematic gap is **enabled-state truthfulness**, below.

### CE-09 — Ten disabled "Send" buttons with no stated reason
- **Surface:** `/`
- **Pillar:** Interaction fidelity · Error tolerance
- **Observed:** Ten `<button disabled>` labelled "Send" sit inside alert review rows whose sibling controls read "Approve Reject Send Details". None carries a `title`, an `aria-describedby`, or any adjacent explanation — `title: ""`, `aria-describedby: ""` on all ten. A further disabled control, "Jump to peak" inside the Frame chart, is likewise unexplained. The page does ship good disabled-state precedent: the offline banner states "Offline. Changes will sync when you reconnect." — so the pattern is known and simply not applied here.
- **Who it hurts:** An operator triaging alerts learns nothing about why dispatch is unavailable; the plausible inference (already sent? awaiting approval? offline?) is wrong about half the time.
- **Severity:** major
- **Classification:** correction
- **Fix:** Give each disabled control an adjacent explanation, or use the pattern already established by the offline banner.

---

## Severity ranking

1. **CE-01** — a dead server reads as an empty one on six surfaces; two assert falsehoods — blocker
2. **CE-02** — no client validation, server accepts `201` for latitude 999 and `-91/abc` — blocker
3. **CE-05** — empty-state wording diverges across six voices; four panels on `/portal/` are identical and contextless — major
4. **CE-03** — `/districts/` reports an error and "Loading." at the same time — major
5. **CE-09** — ten disabled "Send" buttons, no stated reason — major
6. **CE-04** — eight verb/punctuation variants for one failure class — minor
7. **CE-06** — `calibrated_uncertainty: false` in human-facing prose — minor
8. **CE-07** — six surfaces have no loading state — minor
9. **CE-08** — double-click guard — clean, no action

## Pillar tally (this file)

| Pillar | Count |
|---|---|
| Cognitive ergonomics | 0 |
| Interaction fidelity | 2 |
| Perceptual performance | 1 |
| Inclusive accessibility | 1 |
| Isomorphic consistency | 2 |
| Error tolerance | 4 |
| Affective resonance | 1 |
| Contextual adaptability | 1 |

## Classification tally

| Classification | Count |
|---|---|
| correction | 7 |
| improvement | 2 |
| enhancement | 0 |
| extension | 0 |

---

## Note on state changed during this audit

Testing error tolerance required submitting deliberately invalid data. The following persisted to `data/lindela-lite-store.json` and **could not be removed** — there is no `DELETE` route for parametric rules (see `CE-10`/`HX-13`):

- `parametric_rule_e10039e083f59275` — "AAAA…", currency `ZZZZZZZZZZZZ`
- `parametric_rule_5c734682552e530b` — "xxxx…", currency `@@@@`
- `parametric_rule_5d7c991948aa9369` — "NEGATIVE TEST", currency `@@@@`

Three workflow instances on `/focal-point/` were also approved during the double-activation test, which is why `/focal-point/` now reports "No pending workflows." They need restoring from the store backup before any demo or screenshot run.

### CE-10 — Invalid test data cannot be removed through the API or the UI
- **Surface:** `/parametric/`
- **Pillar:** Error tolerance
- **Observed:** `matchParametricRoute` in `src/server.js` exposes `rules-list`, `rule-detail` and `simulate`. There is no delete verb, and no UI affordance. The three malformed rules created during this audit are still listed in `/api/v1/parametric-rules` and render as 4301 px-wide elements.
- **Who it hurts:** Anyone who creates a rule in error — a plausible outcome for a form that accepts negative thresholds and unlimited string lengths.
- **Severity:** major
- **Classification:** extension
- **Fix:** `DELETE /api/v1/parametric-rules/:id` plus a UI affordance; prefer archive over delete so the audit chain survives.