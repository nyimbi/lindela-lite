# Lindela Lite — UI/UX Audit and World-Class Plan

Status: proposed · Scope: `public/` (8 surfaces, ~10,800 lines) · Date: 2026-10-02

---

## Context

Lindela Lite ships **eight separate user-facing applications** from one repository — an operations console
(`/`), partner portal, CHW field app, country-office dashboard, district view, focal-point approval
console, parametric disbursement console, and scenario workbench. For a humanitarian early-warning
platform whose users are community health workers in Turkana and duty officers making anticipatory
trigger decisions, UI quality is not cosmetic: it is the difference between a trigger being approved
with evidence and approved blind.

This audit was produced by reading every HTML, CSS and JS file in `public/`, by rendering all eight
surfaces in headless Chrome at desktop, phone and 4,000px-tall viewports, and by cross-referencing
`docs/`, the automated checks in `scripts/`, and the repo's own commit history (which shows a
disciplined habit of recording *what the UI claimed versus what it computed*).

**The headline finding is structural, not cosmetic.** There is no design system. `public/tokens.css`
defines a clean 73-line OKLCH token layer, and **only 3 of the 8 applications load it.** The other
five carry 236–326-line inline `<style>` blocks that re-declare the reset, body, header, footer,
buttons, tables, inputs and dialogs from scratch. Every divergence documented below is a downstream
consequence of that one fact.

---

## Method and evidence base

| Evidence | How it was gathered |
|---|---|
| Source read | All 8 `index.html`, `styles.css`, `tokens.css`, `app.js` (dashboard, 2,385 lines), 7 sub-app `app.js`, 8 `shared/*.js`, `sw.js` |
| Rendered output | Headless Chrome at 1440×2400, 414×1500, 1280×4000 for every surface |
| Static analysis | Repo-wide greps for hardcoded colour, breakpoints, `aria-*`, `focus-visible`, `outline`, media queries, `innerHTML` escaping |
| Context | `docs/dashboard.md`, `platform.md`, `i18n.md`, `demo-guide.md`, `demo-audit-2026-10-02.md`, `scripts/check-dashboard-browser.mjs`, `scripts/check-i18n.mjs` |
| Product intent | `docs/plans/world-class-roadmap.md`, JTBD catalogue, UNICEF traceability matrix |

Screenshots were decisive: several defects below are invisible in source review and obvious on screen.

---

## Part 1 — Audit findings

### Tier 0 — Blocking. The product does not work in these states.

**T0.1 The dashboard cannot boot offline.** `public/sw.js:5` precaches `['/', '/app.js', '/styles.css',
'/manifest.webmanifest', '/i18n/en.json']`. But `app.js:4–8` imports six modules from `/shared/`
(`basemap`, `flood-bands`, `map-frame`, `seasonal`, `app-version`) and `index.html:618,622` imports
`navbar.js` and `demo.js`. **Seven modules are imported and zero are precached.** A missing ES module
is a hard module-resolution error, so the entire console fails to boot offline rather than degrading —
precisely the case the offline work was built for. The `install` handler's `.catch(() => Promise.resolve())`
(`sw.js:10–13`) swallows the failure, so it is silent. *(Verified by inspection and by rendering.)*

**T0.2 Two tables are unreachable.** `styles.css:22` sets `body { overflow: hidden }` and there is **no
`main` rule anywhere in `styles.css`** (0 matches). The console survives only because its content lives
in `.rail-content { overflow-y: auto }`. `parametric` and `scenarios` link `styles.css` with no such
wrapper. Rendered at 1280×4000, the parametric **Disbursement History** table is clipped mid-column —
the final `Status` column is cut mid-character with no scrollbar. Confirmed visually.

**T0.3 The offline queue on the console is a promise the code never keeps.** `app.js:803–817` posts
`{type: 'queueRequest'}` to the service worker, but `sw.js:82–86` only handles `type === 'flushQueue'`.
The message is discarded. `app.js` never writes to IndexedDB at all, so `replayQueue()` (`sw.js:102–131`)
reads a store nothing populates. The `_pending` counter increments forever and the status bar reports
"N queued" that will never send. **`shared/runtime.js` contains a correct `initOfflineQueue` implementation
that `app.js` does not import.**

**T0.4 No error surface anywhere.** `fetchJson` (`app.js:765–777`) never checks `res.ok`. A 503 from the
service worker returns `{error:'Offline'}` and flows into `body.success === undefined` — a silent no-op.
`refresh()` (`app.js:1270–1326`) wraps twelve endpoints in a `Promise.all` with **no `try/catch`**, driven
by `setInterval(refresh, 30_000)` (`app.js:2374`). One failing endpoint produces an unhandled rejection,
`setStatus("Updated …")` at line 1325 never fires, and the status bar freezes on a stale timestamp
indefinitely. There is **no spinner, no skeleton, and no error state in any view** except flood-sim and
route-plan (which handle it exemplarily). Errors collapse into one status line that the next 30-second
refresh overwrites.

**T0.5 The field app overflows its phone viewport.** At 414px, `/chw/` renders with content clipped at the
right edge — buttons run off screen, the header controls are cut — and roughly 60% of the screen is empty
void with three buttons vertically centred. There are **only three media queries in the entire product**
(`styles.css:1249` @900px, `:1485` reduced-motion, `:1500` @800px). Nothing addresses 375/414px.
`index.html`, `co` and `districts` contain **zero** media queries of their own.

**T0.6 Unstyled controls render as raw UA defaults.** `.btn-primary` (`styles.css:174`) supplies only
colour and weight; padding, border and `cursor` live on `.btn` (`styles.css:148`). Three buttons use
`class="btn-primary"` without the base (`parametric:135,174`, `scenarios:141`) and render as default grey
browser buttons — visible in the rendered parametric console as "Add rule", "Create rule" and
"Simulate a disbursement". **`.btn-secondary` does not exist in `styles.css` at all** (0 matches) yet is
used at `index.html:482,483` and `scenarios:111,136,190`.

**T0.7 A broken checkbox, systemically.** `styles.css` styles checkboxes only as a single ID,
`#coldChainToggle` (`:1446–1470`). Every other checkbox renders as an unstyled native control, and in the
rendered dashboard, scenarios and parametric pages the box visually detaches and floats above its label.

---

### Tier 1 — Correctness and security

**T1.1 XSS in `co` and `districts`.** Unlike `app.js` (55 uses of one `escapeHtml`, `safeClass` guarding
class interpolation), `co/app.js` interpolates raw API strings into `innerHTML` at lines 78–99, 133, 188
with no escaping function in the file at all. `districts/app.js` is structurally incapable of escaping —
every render path is `innerHTML` with interpolated data (`:109,110,194,217,298`). Worse,
`districts/app.js:5–8` interpolates severity **unquoted into a class attribute**
(`` `<span class="chip chip-${s}">` ``) — a severity containing a quote injects markup.

**T1.2 `escapeHtml(str || '')` silently drops `0` and `false`** (`portal:193–201`, `focal-point:259–267`),
so a legitimate zero renders as empty. `parametric` and `scenarios` correctly use `??`.

**T1.3 `sw.js:66` calls `cache.put` on non-GET requests.** Cache Storage only accepts GET; the spec
rejects with `TypeError`. The rejection is unhandled, producing an unhandled promise rejection in the
service worker on **every POST**.

**T1.4 No compression and no security headers.** `src/server.js` contains **zero** occurrences of
`gzip`/`brotli`/`content-encoding`. The dashboard's 17 assets total **232 KB raw** against 64 KB gzipped
— a 3.6× penalty on exactly the connections where bandwidth binds. There is also **no CSP, no
`X-Content-Type-Options`, no `Referrer-Policy`** — material given the `innerHTML` usage above.

**T1.5 `static` serving is ~15 copy-pasted branches with no cache headers and no ETag**
(`server.js:2348–2548`), each independently `readFile`-ing the same way. A deploy is not cacheable.

**T1.6 Service worker updates never reach a live console.** `sw.js` has **no `skipWaiting()` and no
`clients.claim()`**. A new SW installs and waits while the old one keeps serving until *every* tab for
the origin closes. On a long-lived ops console that is effectively never. The comment at `sw.js:1–3`
already identifies the fixed cache name as the cause of "a deployed fix never reaching an operator".

**T1.7 API responses are cached unbounded and unscoped.** Every successful `/api/v1/` GET is written to
the same cache bucket as the app shell, with no size bound, no TTL, no quota handling, and no scoping to
a session — including incident and alert records. Nothing prunes by age; only a version bump purges.
A console polling 12 endpoints every 30s accumulates entries indefinitely.

**T1.8 `districts/app.js:127` swallows a rejection with `.catch(() => {})`** — a 500 strands the literal
text "Loading counts..." on screen forever.

**T1.9 `focal-point/app.js:172` is a tautology** — `p.mode === 'live' || p.mode !== 'shadow'` is always
true; the `.filter()` is a no-op, so the shadow/live mode toggle the UI implies does nothing.

---

### Tier 2 — The design system that isn't

**T2.1 No light theme, and the residue proves one was expected.** `tokens.css` has a single `:root` block
with every value dark. `styles.css` contains **zero** `prefers-color-scheme` and **zero** `data-theme`
occurrences. Yet 22 hardcoded hex values sit across the role pages, and they are *light-theme residue*:
`focal-point:124–127` renders severity chips as pastel `#fecaca`/`#7f1d1d` on a `oklch(15%)` background,
and `focal-point`, `parametric` and `scenarios` manifests all set `"background_color": "#ffffff"` while
rendering dark. The parametric and scenarios manifests additionally set `"theme_color": "#2563eb"` against
every other app's `#0e1520`. **The decision "dark-only or light-capable" has never been made in writing.**

**T2.2 Four classes are used but never defined.**

| Class | Used at | Result |
|---|---|---|
| `.btn-secondary` | `index.html:482,483`, `scenarios:111,136,190` | bare UA button |
| `.dialog-body` | `index.html:568,590`, `focal-point:396` | unstyled |
| `.dialog-close` | `index.html:532,546,569,606`, `focal-point:393` | unstyled |
| `.visually-hidden` | `co/index.html:287,294,299` | **renders visibly** |

The `.visually-hidden` case is confirmed in the rendered CO dashboard: "Quarter", "Year" and "Locale"
appear as visible text beside their selects.

**T2.3 A phantom token.** `index.html:476,478` and `chw/index.html:474,484` use
`var(--color-border, #e5e7eb)`. `--color-border` **does not exist** in `tokens.css` (canonical is
`--stroke`), so five fields render a hardcoded *light* grey border on a dark surface.

**T2.4 Six competing severity systems.** `styles.css:294–300` hardcodes bespoke fill/stroke pairs for six
hazard classes (two of which duplicate `asset-water`). `districts:134–137` uses `var(--sev-*)` correctly.
`focal-point:124–127` uses pastel light-mode chips. `co` has three different spellings of danger red
(`#e05252` bare at `:184`, `var(--danger, …)` at `:137,179`). `chw` uses raw Tailwind `#10b981`/`#ef4444`
where `--ok`/`--danger` exist.

**T2.5 A wrong-but-invisible colour bug.** `co/index.html` resolves `var(--accent, …)` to
`oklch(78% 0.15 90)` — amber. The CO dashboard's histogram bars, KPI annotations and primary button are
**yellow**, where the console's primary is cyan. The `var(--x, #hex)` fallback chain hides it, because
the tokens always resolve so the fallbacks never fire.

**T2.6 Missing primitives.** No skeleton, no spinner/loading indicator (three `@keyframes` exist; none is
a loader), no toast component in the console (`--z-toast` exists; only `chw` has one, hand-rolled), no
tooltip, no pagination, no breadcrumb, no shared `.card` base (five unrelated ad-hoc card classes) and no
shared `.table` base (two).

**T2.7 Duplication and dead weight.** `styles.css` is 1,744 lines with **33 class selectors appearing
more than once**; `.equity-table` alone spans 12 selectors across 60 lines with padding set at `:1309,1317`
and then overridden at `:1339`, leaving the first two dead. Seven tokens are dead (`--accent`,
`--z-dropdown`, `--z-dialog`, `--z-dialog-backdrop`, plus the three back-compat aliases `--border`,
`--border-strong`, `--bg-hover` at 0 uses each). `--sp-6` is defined and used zero times; `--sp-7` does not
exist. There is no `--size-*` layer (raw `48px`, `30px`, `480px`, `15px`, `14×10px`, `360px`), no shadow
token (one `box-shadow` in the whole file), and no icon-size token (`width="14"` repeated 12×).

**T2.8 Three disjoint z-index tiers.** All six `z-index` declarations in `styles.css` correctly use
tokens (1–70). The role pages use raw `z-index: 100`. `shared/navbar.js` injects `z-index: 999`. No shared
contract. `--z-topbar` and `--z-statusbar` both equal 30 — the scale cannot express a tie.

**T2.9 Five different locale lists.** parametric/scenarios 10 (with `ar`), index 10 (with `ar`),
focal-point 9 (**missing `ar`**), portal 8, co 6, chw 3. `chw/index.html:327–340` carries a comment
explaining that it offers only languages with complete strings — **the other five violate that stated rule.**

---

### Tier 3 — Accessibility

**T3.1 `:focus-visible` does not exist — zero occurrences repo-wide.** The only focus styling is
`input:focus, select:focus, textarea:focus` (`styles.css:886`), which fires on mouse click and covers
*no* interactive component: not `.btn`, `.chip`, `.rail-tab`, `a`, `summary`, or dialog buttons.

**T3.2 Two `outline: none` declarations, both on the command-palette search field**
(`styles.css:1150,1159`) — the one control the user is guaranteed to be typing into has **no focus
indicator of any kind**, and it also inherits the generic `input:focus` outline that `:1159` then cancels.

**T3.3 `prefers-reduced-motion` reaches 3 of 8 pages.** The block at `styles.css:1485` is structurally
correct (it catches pseudo-elements), but only pages linking `styles.css` get it. All seven role pages
have **zero** occurrences, so `item-enter`, `dialog-enter` and chw's `slideUp` all run for users who
asked them not to.

**T3.4 Per-app ARIA coverage is close to zero outside the console.**

| Surface | `aria-*` | `role=` | `<label>` |
|---|---|---|---|
| dashboard | 56 | 33 | 43 |
| portal | 2 | 0 | 0 |
| districts | **0** | **0** | **0** |
| focal-point | 4 | 0 | 1 |
| co | 5 | 0 | 3 |
| parametric | 1 | 0 | 11 |
| scenarios | 1 | 0 | 14 |
| chw | 1 | 0 | 12 |

**T3.5 No `<main>`, no skip link, anywhere.** `index.html` has no `<main>` (0 matches) and no `.skip-link`
class exists in the codebase. `div.console-layout` is the de-facto main region with no role and no label.
A keyboard user tabs through ~30 controls before reaching content.

**T3.6 Landmarks are broken.** `index.html:505` uses `<footer role="status">`, which suppresses the
implicit `contentinfo` landmark. `focal-point`'s footer has no `role="status"`/`aria-live`, and its
`#connectionStatus` is a bare `●` glyph with no text. `parametric` and `scenarios` have no footer at all
and an unlabelled `<nav>`.

**T3.7 Heading structure is broken.** `index.html` has **zero `<h1>`** and no `<h2>` before the rail tabs.
`focal-point` runs `h2 → h3 → h3` with no `h1` and a brand `<span>`. `parametric` and `scenarios` have
section titles as `<div class="panel-title">` — `parametric`'s sole `<h1>` is `1.1rem`, *smaller than the
body text on other pages*.

**T3.8 Dialogs.** Native `<dialog>` + `showModal()` is used throughout the console, which correctly buys
focus trap, Esc, `::backdrop` and inert background. But: the redundant Esc handler at `app.js:2204–2207`
fights native behaviour; focus is **not restored** after `detailDialog`/`dispatchGateDialog` close (the
previously focused element is an SVG `<circle>`, not focusable, so focus drops to `<body>`);
`focal-point`'s dialog has `aria-labelledby` pointing at an `<h2>` that is **empty in markup**, so it has
no accessible name if JS fails, and its confirm button has no text and no `aria-label`; and
`focal-point` never handles the `close` event, leaving `state.currentWorkflowId` stale.

**T3.9 Tabs lack the APG keyboard model.** The rail declares `aria-selected`/`aria-controls`/
`aria-labelledby` but has **no roving `tabindex`** and no `tabindex="0"` on panels, so all five tabs sit in
the Tab order instead of one and arrow keys do nothing; the only alternate path is the number keys
`1`–`4` (`app.js:2214–2217`). The widget therefore announces as a tab list that does not behave like one.
`portal`'s four `.tab-bar` buttons have **no `role="tablist"/"tab"`, no `aria-selected`, no
`aria-controls` at all.** (The command palette, at `app.js:2163–2169`, *does* handle ArrowUp/Down/Enter —
it is the one widget in the product that gets this right.)

**T3.10 Zero `tabindex` exists in the entire codebase, so the map is pointer-only.** `index.html:69`
declares `<svg id="situationMap" role="img" aria-label="Situation map">`, which collapses every marker
into one atomic image. Pan is `pointerdown` (`app.js:1189`, with `touch-action: none`), zoom is `wheel`
(`:1182`), reset is `dblclick` (`:1206`), and **every drill-down is click-only** — hazards (`:1090`, `:1106`),
assets (`:1122`), IPC areas (`:288`). **A keyboard or screen-reader user cannot open a single hazard,
asset, or IPC area.** Worse, there is no tabular equivalent: nothing anywhere lists hazards, assets,
flood extents, road-access state or routes. The only count exposed is `#mapRecordCount`, a bare span
reading "33 records". On the two surfaces built for district officers and focal points, the primary
decision surface is a picture with no text alternative.

**T3.11 Severity contrast fails in the two places it matters most.** `.sev-chip` renders severity text at
`font-size: 0.625rem` (10px) on an 18% tint — `.sev-critical` lands at **~4.3:1 against a 4.5:1
requirement**. The districts surface is materially worse (`districts/index.html:134–139`): **white text on
the raw severity hue at 0.68rem**, giving white on `--sev-high` ≈ **2.5:1**, `--sev-low` ≈ **2.2:1**,
`--sev-critical` ≈ **3.2:1** — three of four fail outright. The `#c0392b`/`#e67e22`/`#27ae60` fallbacks
in that rule are accessible values that can never fire, because `tokens.css` shadows them with the light
OKLCH equivalents. `--ink-faint` fails on all three of its surfaces (3.6–4.1:1) and it carries the
**"never run" and "unknown"** statuses — the two states an operator most needs to read. This is the
primary encoding of the most operationally urgent attribute in the product.

**T3.12 The field app's completion feedback is invisible to assistive tech.** `/chw` has **zero
`aria-live` regions in the entire codebase's seven non-console surfaces**. `showToast()`
(`chw/app.js:105–109`) sets `textContent` and clears after 3s — **a screen-reader user receives nothing.**
`showScreen()` (`:98–103`) toggles a class and **never moves focus**, so a user pressing "Next" gets no
announcement and focus stays on the now-hidden button. The progress dots are pure colour with no text
alternative. This is the one surface whose entire job is submitting a report from a phone with no
connectivity and confirming it was queued.

**T3.13 Two surfaces are untranslated despite offering language selection.** `scenarios/index.html` has
**12 inputs, 10 with placeholder-only accessible names** (the bare `<label>` elements at `:81–135` have no
`for`), hard-codes English in all 14 label strings, and carries **0 `data-i18n` attributes** — beneath a
10-language selector. `districts/index.html` likewise has **0 `data-i18n`**, **0 ARIA of any kind**
(258-line HTML + 354-line JS, four tables, a map, a card grid), and its table headers are hard-coded English
in `districts/app.js:196–201`. A district officer in Bor or Aweil gets English.

**T3.14 Tables.** **58 `<th>` elements across all eight surfaces and zero `scope=` attributes.** No
`<caption>` anywhere. `index.html`'s `#equityTable` has one `<th>` (`:296`) carrying its only explanation
in a `title` attribute. `.shortcut-table` has **no header cells at all**. `parametric`'s empty-state row
uses `colspan="7"` on an **8-column** table. `co`'s equity table has an empty `<th></th>` at `:353`, and
its feedback table **half-translates**: `:387–395` has English-only headers with no `data-i18n` while its
siblings do. No table has a caption or pagination.

**T3.15 No chart anywhere has a text alternative.** `co`'s histogram (`co/index.html:381`) has an
`aria-label` but **no `role`**, so it announces as a labelled empty div, with no table fallback or summary
sentence. Its sparklines (`co/app.js:234–237`) are unlabelled `<svg>` — no `role`, no `<title>`, not even
`aria-hidden`. The card does render the latest value and a delta, so the number is available, but the
delta is colour + arrow glyph and **the twelve-month series behind it is unavailable in any form**. The
dashboard's seasonal bar (`index.html:109`) is the one chart done correctly.

**T3.16 Content is announced before it exists.** `index.html:44–45` ships literal `"json"`/`"online"` in
`#storageMode`/`#connectionStatus` — pre-hydration a screen reader hears a false connectivity claim.
`#dhis2TestResult` is `display:none` (`:485`), putting a test *result* where AT can never reach it.
Placeholder `—` glyphs (`:102,125,139,511,514,517,577`) are not live regions, so a data load is silent.
There is **no `role="alert"` anywhere.**

**T3.17 No print stylesheet.** Zero `@media print` in the product — for a tool where dispatch decisions
get printed and filed, this is a real gap.

---

### Tier 4 — Ergonomics and content design

**T4.1 Raw field names are the user interface.** Across the rendered surfaces users read
`precipitation_mm`, `conflict_events_count_7d`, `fever_case_rate_per_1000`, `temperature_max_c`,
`conflict_displacement_events_2e > 1`. The focal-point screen — where a human approves a trigger that
releases money — renders `Metric  precipitation_mm` as one of five fields. **This is the single most
damning content defect in the product.** It should read "Rainfall (mm, 24h)".

**T4.2 The focal-point screen approves blind.** Five fields: rule, metric, threshold, district, time.
**No evidence, no map, no affected population, no facilities at risk, no comparison to the last
trigger, no consequence statement.** No confirmation dialog, no reason capture, no undo, no queue
position ("3 of 12"), no bulk action. Approve and Reject are equally saturated green and red at equal
size, so a safe action and a destructive action carry identical visual weight. Given that roadmap item 3
(impact-based forecasting) and item 7 (human-in-the-loop approval) are already written down, this screen
is where the product either earns trust or loses it.

**T4.3 The scenario workbench is a dead end.** The right 70% of a 1280px screen is permanently empty.
The empty state is one centred sentence. The only CTA ("Run scenario") sits at the **bottom of an 850px
left rail**, below eight raw text inputs — the primary action is the last thing a user sees. Lat/Lon are
hand-typed as `3.12`/`35.6` with no WGS84 hint. There are **no presets**, no validation, no example. A
planner wants "drought −30% rainfall", not a form.

**T4.4 The districts view is a stub.** Five cards on an 1800px page — ~83% empty. Nothing is clickable,
there is no map, no detail route, no drill-down.

**T4.5 The dashboard's map is mostly void.** Roughly 890×1290px of map of which the interesting content
occupies the lower-left quarter; data clusters around Turkana/Bor/Awel while the frame renders open
ocean. The seasonal-context block is an 8px unreadable wall of CPC advisory prose; "FOOD SECURITY (IPC)"
and "OUTBREAK CONTEXT (WHO GHO)" are two large panels showing `—` and "not ingested". The KPI strip's
eight tiles are alert-*rule names* ("Anticipatory Alert", "Cold Chain Protection"), not metrics, and mix
`closed: 1` / `closed: 0` inconsistently. The status bar shows "Last signal: —", "Median lag: —" — dead
telemetry — alongside a stray `action :` with a space before the colon.

**T4.6 Four different date formats across five apps** — `toLocaleString()` (`app.js:103`),
`toLocaleDateString()` (`portal:190`), raw `.slice(0,10)` (`districts:196`), `.slice(0,16)` (`co:346`).
Users see `02/18/2026, 06:55:29`, `9/28/2026, 6:55:29 AM`, and `2026-10-02`. None carries a timezone —
on a screen that approves disaster triggers across East Africa, this is not acceptable. Seconds are
displayed everywhere and are never useful.

**T4.7 Number formatting is inconsistent and sometimes absurd.** `203.0 people`, `0.0 %` children,
`100.0 %` PwD, `Accuracy 100.0%` for every district — spurious decimals on counts and percentages.
Nine inline formatters across the sub-apps with three different severity-class defaults.

**T4.8 Raw blockchain internals dominate the parametric console.** The Disbursement History shows
`disbursement_7e5b8a4ca0e91ee`, `0x53961be91373ac7`, `payouts_ada_t6f5afac3e6c8fdadf5af8d` as primary
column content. The user needs `…ca0e91ee`, `0x5396…3ac7`, and a human contract name. There is no
pagination — 13+ rows and growing.

**T4.9 ~178 lines of duplicated utilities** across the seven sub-apps: 4 copies of `escapeHtml`
(`co` and `districts` have none), 3 hand-rolled i18n runtimes plus 3 apps with zero i18n, 3
byte-identical 8-line locale-switch handlers, 4 severity→class helpers with 3 different defaults,
19 literal empty-state strings (7 in `districts` alone), 3 verbatim copies of the offline-queue submit,
and `parametric:5–10` as a verbatim clone of `runtime.js`'s `apiFetch` under the same name.

**T4.10 `shared/` overstates its sharing.** `navbar.js`, `demo.js` and `runtime.js` are genuinely
cross-cutting. `map-frame.js`, `basemap.js`, `seasonal.js`, `flood-bands.js` and `app-version.js` are
**single-consumer modules** that exist for testability, not reuse. `runtime.js`'s `apiFetch` — the
highest-value abstraction in the repo — is used by 4 apps and bypassed by 4.

**T4.11 The offline banner and dialog backdrops have three different colours** — `oklch(10% … / 0.65)`,
`rgba(0,0,0,0.5)`, `oklch(0% 0 0 / 0.6)` — and one page redefines `.offline-banner` as in-flow
(`portal:218`), directly contradicting `styles.css:57`.

**T4.12 Dead code and no-op handlers.** `parametric:68` hides the add-rule form whenever any rule exists,
so the app silently becomes read-only after the first rule with no explanation. `scenarios:178`
`clipboard.writeText().catch(() => {})` discards failure — on a non-secure origin the user gets no share
URL and no indication. `scenarios:113–117` and `:147–152` are ~11 lines of post-mortem comment describing
already-fixed bugs, referencing fields that no longer exist. `app.js:824` `DEFAULT_BBOX` is declared and
never used. `districts:233–238` `taskGroups` is computed then never used.

**T4.13 The global `label { display: flex; flex-direction: column }` (`styles.css:855`) is fighting the
role pages.** It is the direct cause of **22 inline `style="margin-top:0"` overrides** — 14 in `parametric`,
8 in `scenarios`. The fix is one CSS rule, not 22 attributes.

**T4.14 No compression or cache headers means the first paint is 232 KB** (T1.4/T1.5).

---

### Tier 5 — Process gaps

**T5.1 The automated UI gate checks the happy path only.** `scripts/check-dashboard-browser.mjs` asserts
elements exist and data renders. **Nothing checks** horizontal overflow at 375px, `:focus-visible` presence,
contrast ratios, unstyled-class usage, offline boot, or the SW precache list. Every Tier 0 defect above
would pass the current gate.

**T5.2 `scripts/check-i18n.mjs` has a coverage hole.** `en.json` has 193 keys; measured coverage is
`sw` 179, `so` 101, `din` 58, `nk`/`km` 55, `ar` 54, `fr`/`pt`/`am` 38. **French, Portuguese and Amharic
are 20% translated** — the roadmap's item 20 claims six languages, but three of them are mostly English
fallbacks. `din`/`nk`/`km` carry one orphan key each.

**T5.3 Arabic cannot actually work.** `ar.json` has 54 translated keys and every app hardcodes
`lang="en"` and `dir="ltr"` in markup. `styles.css:1472–1482` contains a full RTL block that markup can
never reach, and `navbar.js` handles RTL via `flex-direction: row-reverse` rather than logical properties.

**T5.4 The existing gate is structurally blind to accessibility.** `scripts/check-dashboard-browser.mjs`
is 891 lines and unusually good at information integrity — but counted exhaustively:

| Concern | Assertions |
|---|---|
| `focus` / `focus-visible` / focus management | **0** occurrences of the word |
| `role=`, `tabindex`, `scope=` | **0** each |
| Accessible names, `alt` text | **0** |
| Colour contrast | **0** — `getComputedStyle` reads only `.fill` and `font-size` |
| `prefers-reduced-motion` | **0** |
| Zoom / text resize (200%, 400%) | **0** — one viewport, 1440×900 |
| Touch-target size (WCAG 2.5.8) | **0** |
| axe / pa11y / WCAG tooling | **0**, and none installed |
| Screenshots | **0** |

All interaction is `element.click()` from `Runtime.evaluate`, which **bypasses the entire keyboard path**
— the harness is architecturally incapable of seeing it. `/focal-point` and `/portal` receive only generic
smoke checks; the approval gate, the highest-consequence screen in the product, is asserted to contain
`>100` characters of text. Meanwhile `check-i18n.mjs` covers **only** the CHW app, **only** the `chw.*`
namespace, and **only** static `data-i18n` attributes — so JS-injected keys are invisible and every other
surface is unchecked.

**T5.5 The audit's own method is not in the gate.** `docs/demo-audit-2026-10-02.md:5` states *"almost every
defect found here looked entirely correct"*, and its highest-yield method was **screenshot the surface**
(`:18–20`) — which found four defects that every DOM assertion passed, *"because the content was present in
the document and absent from the screen."* The programmatic residue of that method in the gate is good
(map geometry at `:226`, legend font-size at `:229`, the rail-clipping guard at `:812–827`) but covers only
three known cases. A new one will slip through. The same doc's closing rule belongs here: **"a passing
check is evidence about the *check*, not about the code."**

**T5.6 The UI is failing requirements it is contractually held to.**
`docs/platform-jtbd-catalogue.md`'s Definition of Done contains the only concrete UI requirements in the
docs, and **both are unmet by construction**:

- `:598` — *"UI shows current state, owner, next action, blockers, deadline, and history. Dashboard panel
  for the subject shows all of these without requiring the operator to navigate multiple screens."* No
  single panel in any surface shows those six attributes.
- `:600` — *"no transition is API-only without a corresponding dashboard affordance."*
  `jtbd:423–428` lists **six routes with a backend and no UI at all**: `/trigger-protocols/:id/backtest`,
  `/shadow-run`, `/analytics/bias-correct`, `/outbox/dispatch`, `/maintenance/apply-retention`, `/connectors`.
- `:476` — alerts past deadline must appear in a **"needs escalation" view**. That view does not exist.
- JTBD-089 — *"No URL-persistent filter state; refreshing resets filters."* Operators lose their view on
  every accidental reload — and this plan is about to add many more filters.
- JTBD-034, 039, 056, 060 — no work-queue view, no triage actions from the summary, no distribution health.
- JTBD-002 and 007 — **no UI confirmation or diff preview** before defaults are written, and no UI
  confirmation for the ACLED licence gate.

**T5.7 `docs/unicef-requirements-traceability.md` has no UI row anywhere.** Every evidence cell names a
file, endpoint, commit or PDF. Two consequences: §1.5 marks the UNICEF bid indicators (people reached,
% U18, % women and girls, % PWD, warning-to-action latency, API uptime) **Met against `src/kpi.js` — a
KPI function with no stated rendering surface**, and §2.8 records that `tx_hash` is a SHA-256 digest
prefixed `sim_`, not a transaction — *"the risk is that the T2 answer drifts from what the doc says."*
The parametric history table renders `tx_hash` as a column with **no indication it is a local digest**,
which is exactly that drift, made visible.

**T5.8 Accessibility appears in no requirement document.** No WCAG reference, no contrast floor, no
keyboard, screen-reader, target-size or plain-language requirement exists in either doc. The gap is not
documented debt — it is **undocumented debt**, which is why it has survived. Given that the field
population reaches this platform through SMS on low-end Android, this is the single largest absence
across both documents.

---

## What is already right — do not regress these

An audit that only lists defects misrepresents the codebase. These are genuine strengths and the plan
preserves them:

- **No `<div>` or `<span>` acting as a button anywhere in `public/`.** Zero `onclick` on a non-interactive
  element. Every action is a real `<button>` or a natively-focusable `<summary>`. This is the clearest,
  most consistent accessibility strength in the product.
- **All five dialogs use native `<dialog>` + `showModal()`**, buying focus containment, Esc, inert
  background and `::backdrop` for free — rather than the hand-rolled `role="dialog"` div pattern the rest
  of the industry still gets wrong.
- **The OKLCH discipline is real.** `styles.css` contains 49 `oklch()` literals and **zero** hex/rgb/hsl.
  Every SVG paint attribute in `index.html` uses `currentColor`. The problem is that the values were never
  lifted into tokens, not that the discipline is absent.
- **64 KB gzipped for the entire console**, with zero third-party runtime dependencies and no CDN or
  webfont. For a product targeting low-bandwidth field use, this is excellent and should be protected as
  a budget.
- **The CO dashboard is a genuinely good surface** — KPI cards, sparklines, deltas, `data gap` badges that
  explain *why* a number is absent. It is the pattern the rest of the product should be rebuilt from.
- **The honesty engineering is exceptional.** `seasonal.js` computes `episodeDeclared` from the evidence
  rather than reading it, and its label function cannot say "El Niño" without "advisory". `app.js` draws
  bbox-only hazards as dashed footprints rather than inventing centre points, labels IPC boxes
  "Bounding box, not the mapped polygon", and rings route hops rather than drawing a fabricated polyline.
  `shared/flood-bands.js` documents why its ramp is sequential rather than a rainbow. **The product does
  not lie. The UI simply fails to surface that discipline to the user** — which is what Phase 3 fixes.

---

## Part 2 — The plan

Ten phases, sequenced so each is independently shippable and independently verifiable. Phases 0–2 are
correctness and cannot be skipped. Phases 3–5 build the system the remaining work depends on.

---

### Phase 0 — Stop the bleeding (half a day)

Correctness defects that make the product wrong or unusable. No new abstractions.

| # | Fix | File |
|---|---|---|
| 0.1 | Add all `/shared/*.js`, `icon.svg`, `/tokens.css` to `APP_SHELL`; add `skipWaiting()` + `clients.claim()` + an update prompt | `public/sw.js:5,10,18` |
| 0.2 | Route the offline queue through the existing `initOfflineQueue` in `shared/runtime.js`; delete `app.js`'s broken reimplementation | `public/app.js:798–817` |
| 0.3 | `cache.put` only when `event.request.method === 'GET'` | `public/sw.js:66` |
| 0.4 | Add `main { flex: 1; overflow-y: auto; min-width: 0; }`; drop `overflow: hidden` from `body` in favour of an explicit `.console-layout` height | `public/styles.css:22` |
| 0.5 | Add `:focus-visible` globally; delete both `outline: none` | `public/styles.css:886,1150,1159` |
| 0.6 | Define `.btn-secondary`, `.dialog-body`, `.dialog-close`, `.visually-hidden`; add `.btn` base to the 3 offenders | `public/styles.css`, `parametric:135,174`, `scenarios:141` |
| 0.7 | A real checkbox class — `appearance: none` + `:checked` + `:focus-visible` — and replace `#coldChainToggle` with it | `public/styles.css:1446` |
| 0.8 | `try/catch` + `AbortSignal.timeout(15_000)` + in-flight guard + `document.hidden` check around `refresh()`; surface failures in the status bar instead of freezing it | `public/app.js:1270–1326,2374` |
| 0.9 | Adopt `apiFetch` in `co`, `districts`, `scenarios`, `app.js`; delete `parametric:5–10` clone | `public/*/app.js` |
| 0.10 | Route every interpolated API value in `co` and `districts` through `escapeHtml`; allowlist the severity→class mapping | `co/app.js:78,133,188`, `districts/app.js:5,109,194,217,298` |
| 0.11 | Fix `escapeHtml(str \|\| '')` → `str ?? ''` | `portal:193`, `focal-point:259` |
| 0.12 | Remove the `.catch(() => {})` swallow | `districts/app.js:127` |

---

### Phase 1 — Serve it properly (one day)

| # | Fix | File |
|---|---|---|
| 1.1 | gzip/brotli when `Accept-Encoding` allows; store pre-compressed variants or compress per response | `src/server.js` |
| 1.2 | Send `Cache-Control` (immutable + hashed filenames for assets, `no-cache` for `sw.js` and HTML), plus `ETag`/`Last-Modified` | `src/server.js:2348–2548` |
| 1.3 | Collapse the ~15 copy-pasted static branches into one `serveFile(res, relPath)` with a path-traversal guard (keep the existing `safeJoin`) | `src/server.js:2348–2548` |
| 1.4 | Add CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. CSP needs `unsafe-inline` for the current inline styles/scripts — budget that down as Phase 3 removes them | `src/server.js` |
| 1.5 | Bound the SW API cache: TTL sweep on `activate`, cap entries, and namespace per session | `public/sw.js:34–55` |

---

### Phase 2 — One design system, adopted by all eight (the core of the work)

This is the phase that pays for itself. Everything after it is cheaper.

**2.1 Decide and document the theme.** Dark-only is the honest answer — every token, every
`color-mix` tint and the entire product are dark. Write that into `docs/` and *delete the 22 light-theme
hex residues* rather than migrating them. If light is genuinely wanted, it is a second `:root` block and a
rewrite of every `color-mix`; decide before Phase 3, not during.

**2.2 Settle the stylesheet strategy: all 8 pages link `tokens.css` + `styles.css`.** Delete the five
per-page `<style>` blocks' reset/body/button/input/table/dialog sections and keep only genuine page layout.
Net −300 lines and one cascade. This immediately kills T2.4 (six severity systems — they all resolve to
`--sev-*`), T3.3 (reduced-motion reaches all 8), and T4.13 (delete 22 `margin-top:0` overrides once
`label` has one definition).

**2.3 Extend `tokens.css`.** Add: `--size-*` (topbar, statusbar, rail width, control heights, map min-height),
one shadow scale, `--on-brand`/`--on-accent`/`--on-warn`/`--on-danger` (replacing 8 hardcoded ink literals),
`--sp-7`, and an icon size. Delete the 7 dead tokens. Split the ~30 legitimate data-visualisation literals
(severity ramps, flood-depth ramp, IPC ramp) into a separate `tokens.data.css` so the UI layer stays clean.

**2.4 Add the missing primitives** to `styles.css`: skeleton, spinner, toast, tooltip, pagination, and
shared `.card` / `.table` bases to replace the five and two ad-hoc variants. Adopt `.toast` from
`chw/app.js:105–109` (it is the only one in the repo) as the canonical implementation.

**2.5 Define the responsive system.** One breakpoint set, replacing six: `480px` (phone), `768px`
(tablet), `1024px` (small console), `1280px` (console). Every surface gets a phone layout; the CHW and
focal-point apps get a 44px-minimum tap-target audit via the existing `--tap-target-min`. Add
container queries for the rail and card grids rather than viewport breakpoints.

**2.6 Consolidate the JS layer.** Create `shared/fmt.js` (`esc`, `num`, `pct`, `signed`, `fmtDate`, `sevClass`,
`sevChip`, `yesNo`), `shared/http.js` (fold `apiFetch` in), `shared/ui.js` (`toast`, `emptyRow`, `kpiTile`,
`statusDot`, `openDialog` — the last handling the `close` event that focal-point currently leaks), plus
`bindLocaleSelect` and `bindConnectionStatus` in `runtime.js`. Adopting these removes ~178 lines of
duplication and closes the `co`/`districts` XSS gap as a side effect. Make `initServiceWorker` idempotent
and delete focal-point's duplicate registration.

---

### Phase 3 — Content design: make the machine legible (three days)

This is what separates "a dashboard" from "a product a duty officer trusts".

**3.1 A domain label layer.** `shared/labels.js` mapping every API field to human text with units —
`precipitation_mm` → "Rainfall (mm, 24h)", `conflict_events_count_7d` → "Conflict events (7d)",
`fever_case_rate_per_1000` → "Fever cases per 1,000", `temperature_max_c` → "Peak temperature (°C)" —
plus rule-name and status-label maps. Add keys to `en.json` and run every rendered surface through it.
**No raw field name reaches a user.** Severity and status keep their text labels *and* their colour, so
meaning never depends on hue alone.

**3.2 One time format, everywhere.** `fmtDate(iso, locale, 'datetime')` in `shared/fmt.js`, backed by
`Intl.DateTimeFormat` with an explicit time zone and `Intl.RelativeTimeFormat` for "6h ago". Drop seconds.
Show the zone. Replace `toLocaleString`, `toLocaleDateString`, `.slice(0,10)` and `.slice(0,16)` — the four
current idioms — with the one helper. The status bar's "Updated 02/10/2026, 14:18:11" becomes
"Updated 12 min ago · EAT".

**3.3 Fix number semantics.** Integers for counts, one decimal for percentages, `—` **with** a
reason ("no alert outcomes recorded yet", "not ingested") rather than a bare dash. Adopt the CO
dashboard's existing `data gap` badge as the canonical no-data treatment — **it is the best idea in the
current UI** and should be lifted to a shared component and used everywhere.

**3.4 Lift the CO pattern into the console.** The CO dashboard is the only well-designed surface in the
product (KPI cards, sparklines, trend deltas, data-gap badges). Promote its `.kpi-grid`, `.spark-tile` and
`.spark-delta` into `styles.css`, then rebuild the console's eight rule-name "KPI tiles" as real metrics.

**3.5 Redesign the two highest-stakes screens.**

*Focal-point.* Give the approve/reject screen the evidence a decision requires: a map of the affected
footprint, people-at-risk and facilities-at-risk (roadmap item 3), the comparison against the previous
trigger, and a plain-language consequence statement ("Approving releases pre-agreed finance to X for
district Y"). Weight the actions correctly — filled primary for Approve, outlined for Reject. Require a
reason on Reject. Add a confirmation step, an undo window, queue position, and capture the reviewer
identity (roadmap item 7). Fix the light-pastel severity chips to `--sev-*`.

*Scenarios.* Preset scenarios ("Drought: −30% rainfall", "Flood: road asset offline", "Conflict: +
2 displacement events") so a planner starts from a decision, not a form. Move **Run scenario to the top
right of the results panel** where it belongs. Add inline validation and lat/lon hints. Fill the results
panel with a map diff and a shareable URL, replacing the permanent void.

*Districts.* Make the five cards into links into a real district detail view with a map. A page that is 83%
empty should not exist.

**3.6 Reclaim the console's map.** Auto-fit the frame to the data extent rather than a fixed region box,
so the viewport stops being mostly ocean. Collapse the CPC advisory wall of 8px prose into a readable
summary with a "read more" affordance. Collapse the two `—`/"not ingested" panels into a single
compact strip until their data exists, rather than two large empty panels.

**3.7 Truncate what should be truncated.** Blockchain IDs to `…ca0e91ee`, hashes to `0x5396…3ac7`, long
IDs with a middle-ellipsis helper and a `title` plus a copy button. Paginate every table above 25 rows.

---

### Phase 4 — Accessibility, completed (two days)

**4.1 Landmarks everywhere.** Add `<main>` to all 8 surfaces (the console's `div.console-layout` becomes
`<main>`), a `.skip-link` as the first focusable element, `<footer>` without a redundant `role="status"` on
`index.html` (move it to a child), `role="status" aria-live="polite"` on focal-point's footer, and
`role="contentinfo"`/`role="banner"`/`aria-label` on parametric's and scenarios' chrome.

**4.2 Heading hierarchy.** Exactly one `<h1>` per surface, then a real hierarchy. Replace
`parametric`'s `1.1rem` `<h1>` and every `div.panel-title` with real `<h2>`/`<h3>`.

**4.3 Forms.** Every input gets a `<label for>` or `aria-label`; group labels become
`<fieldset><legend>`; `chw:513,540`'s English-only placeholders become i18n keys. Adopt the CO app's
existing `visually-hidden` pattern once the class exists.

**4.4 Tables.** `<caption>` and `scope="col"` on all 58 `<th>` across the eight surfaces, `scope="row"` on
row labels, a real header row in `.shortcut-table`, correct `colspan` on `parametric`'s empty state, an
empty `<th>` given an accessible name in `co`'s equity table, and `data-i18n` on `co`'s English-only
feedback headers and districts' JS-rendered headers.

**4.5 Dialogs.** Native `<dialog>` everywhere (replace focal-point's bespoke `role="dialog"`), an
accessible name that exists in markup rather than JS-filled, labelled confirm buttons, `close`-event
cleanup, and explicit focus restore to a focusable element rather than an SVG `<circle>` — focal-point
re-renders its list on confirm, so the trigger is often gone and focus currently falls to `<body>`.

**4.6 The map — the highest-value accessibility work in the product.** Zero `tabindex` exists repo-wide
and every marker drill-down is click-only, so a keyboard or screen-reader user can open no hazard, asset
or IPC area. Add: `tabindex="0"` + `role="application"` + a documented keyboard model (arrows pan,
`+/-` zoom, `0` resets) as explicit buttons as well as keys; a focusable overlay list per layer; an
`aria-live` region announcing marker focus; and — the part that actually restores the capability —
**a toggleable data table for hazards, assets, flood extents, road-access state and routes**, which
currently have no text representation anywhere. The existing equity table is a good model to extend.

**4.7 Live regions on the seven surfaces that have none.** One `role="status" aria-live="polite"` per
surface. **CHW is the priority**: give `showToast()` a live region and make `showScreen()` move focus to
the new screen's `<h2 tabindex="-1">`, so submitting a report is actually confirmed. Then districts'
per-card count loads, co's quarter/year reloads, portal's four tabs, and focal-point's approve/reject.
One `role="alert"` per surface for errors. Ship truthful pre-hydration text (`—`, not "online"); make
`#dhis2TestResult` announceable.

**4.8 Tabs.** Roving `tabindex` and the full APG keyboard model on the console rail and portal's tab bar
(the command palette already does this — copy it).

**4.9 Contrast, with measured targets.** Fix in this order: districts' white-on-hue severity chips
(2.2–3.2:1) → `--ink-faint` on all three surfaces (3.6–4.1:1, carrying "never run" and "unknown") →
`.sev-critical` on its tint (4.3:1) → `chw:469`'s `#6b7280` (~3.5:1) → the phantom `#e5e7eb` borders →
focal-point's pastel chips on dark. Delete the dead `#c0392b`/`#e67e22`/`#27ae60` fallbacks that shadow
the failing tokens. Severity chips must not shrink below 12px.

**4.10 Charts.** Give `co`'s histogram `role="img"` plus a summary sentence and a table fallback; give each
sparkline a `<title>` and `aria-label` stating direction and magnitude in words; add the missing series
data. The dashboard's `role="img" aria-labelledby` seasonal bar is the pattern to copy.

**4.11 Motion.** Propagate the existing `prefers-reduced-motion` block to all 8 pages via `styles.css`.

**4.12 Print.** A print stylesheet: hide chrome and controls, expand the main content, force light-on-white,
keep table headers on repeat, and show a URL + timestamp footer on every printed page.

---

### Phase 5 — Internationalisation that works (two days)

**5.0 The stated field-language priority.** `docs/i18n.md:37–39` is explicit: *"The CHW surface is highest
priority for field languages"*, naming **Somali, Dinka, Karimojong, Ngakarimojong**. Phase 5 is therefore
sequenced CHW-first, not English-first. Every other surface is desk-based and can fall back to English
honestly; the CHW surface cannot.

**5.1 Stop offering translation that does not exist.** `scenarios` and `districts` offer a 10-language
selector over pages with **zero** `data-i18n` attributes and hard-coded English (T3.13). Audit defect #16
in `docs/demo-audit-2026-10-02.md:66` is exactly this — the CHW app once offered nine languages with
strings for three, so a health worker read `chw.symptom_fever` as a button label. **It has now been fixed
on CHW and reintroduced on two other surfaces.** Withhold a locale from a surface until its strings exist.

**5.2 Fix RTL.** Set `lang` and `dir` from the selected locale at runtime (`document.documentElement.lang`/
`.dir`) instead of hardcoding them in 8 HTML files. Convert `navbar.js:166–168` from
`flex-direction: row-reverse` to logical properties so RTL is structural, not a patch. Note that `ar.json`
is 28% translated (54/193), so Arabic cannot be honestly offered until 5.3 completes.

**5.3 Reconcile the locale lists.** One generated list, filtered to what each surface actually supports,
respecting `chw/index.html:327–340`'s own stated rule. Today: parametric/scenarios 10, index 10,
focal-point 9 (**missing `ar`**), portal 8, co 6, chw 3.

**5.4 Close the coverage gap honestly.** `fr`, `pt` and `am` are **20% translated** (38/193 keys). Either
finish them or withhold them; offering a French locale that renders 80% English is worse than not offering
it. Add a coverage threshold to `check-i18n.mjs` and fail CI below it.

**5.5 Make missing keys loud, everywhere.** Extend `check-i18n.mjs` beyond the CHW app and the `chw.*`
namespace to all 8 surfaces and all namespaces, and beyond static `data-i18n` to `data-i18n-title`,
`data-i18n-placeholder`, `title=` and `aria-label=` — today keys injected from JS template literals are
invisible to the check. Add a cross-locale consistency check (a key in `fr.json` but not `en.json`).
Record audit defect #17 as a permanent regression test: **translation length broke the equity table
layout**, because a key name is longer than a word.

---

### Phase 6 — Surface completeness: meet the contract (three days)

The UI is currently failing requirements it is explicitly held to (T5.6). This is functional work, not
polish — it is the difference between a demo and a deliverable.

**6.1 The six-attribute panel** (`jtbd:598`): *"current state, owner, next action, blockers, deadline, and
history"* on one panel, without navigating between screens. Build this as a reusable `subject-panel`
component in Phase 8's library and apply it to alerts, incidents and interventions. This single component
satisfies the catalogue's only concrete UI requirement.

**6.2 No API-only transitions** (`jtbd:600`): six routes have a backend and no UI —
`/trigger-protocols/:id/backtest`, `/shadow-run`, `/analytics/bias-correct`, `/outbox/dispatch`,
`/maintenance/apply-retention`, `/connectors`. Each needs a minimal surface. `/shadow-run` in particular
is the operator-facing half of roadmap item 6 (dry-run + backtest), which the README already commits to.

**6.3 The "needs escalation" view** (`jtbd:476`, P0-B) — alerts past deadline, ranked. Currently absent
entirely.

**6.4 URL-persistent filter state** (JTBD-089). Operators lose their view on every accidental reload.
This plan adds many more filters (Phase 3), so this must land with or before them, not after.

**6.5 Confirmation and diff previews** for the destructive and irreversible actions the catalogue flags:
JTBD-002 (defaults written with no confirmation or diff preview) and the retention application, which
`jtbd:540` states is **irreversible**. JTBD-007 — the ACLED licence gate has no UI confirmation step.

**6.6 Search** (JTBD-091, Missing): *"Without search, operators must scan full lists to locate specific
records."* A command-palette-style search already exists on the console; extend it to the other surfaces.

**6.7 The honesty fixes that land in the UI.** Label `tx_hash` in the parametric history as a local
simulation digest, not a blockchain transaction (T5.7) — §2.8 of the traceability matrix warns that the T2
answer will drift, and this table is where it visibly does.

**6.8 Add a UI row to `docs/unicef-requirements-traceability.md`.** §1.5 is marked Met against `src/kpi.js`
with no rendering surface. Either add a UI evidence column, or downgrade the claim. A requirement matrix
that cannot see the UI is how this audit's Tier 0 defects survived.

### Phase 7 — Performance (one day)

**7.1** 64 KB gzipped is already excellent; keep it there as a budget and enforce it in
`check:dashboard-browser.mjs` (T1.4, T4.14).

**7.2** `renderMap` re-projects and rebuilds every DOM node on each 30-second refresh. Memoize layers that
did not change (graticule, basemap, country polygons) and diff the hazard/asset layers.

**7.3** Hoist the per-item `<radialGradient id="rgN">` allocations out of the per-frame path
(`app.js:1047–1064`).

**7.4** Consider clustering once `mergeEventSets` returns its full 450 hit targets.

---

### Phase 8 — Component library (three days)

Once Phases 2 and 3 have stabilised the primitives, extract the repeated compositions:
`alert-card`, `kpi-tile`, `data-table` (sorting, pagination, empty, loading, error), `filter-bar`,
`map-panel`, `form-row`, `empty-state`, `error-panel`, `offline-banner`, and `subject-panel` (the
six-attribute panel from Phase 6.1, which satisfies `jtbd:598`).

`docs/platform.md` already commits to shared components — this delivers on it.

---

### Phase 9 — Automated gate (three days)

Extend `scripts/check-dashboard-browser.mjs` so every Tier 0/Tier 1 defect above **fails CI**:

| Assertion | Catches |
|---|---|
| **Screenshot capture at 1440×900 and 390×844 for all 8 surfaces** | T5.5 — the audit's top-yield method, currently absent |
| **Keyboard-only navigation of every surface** (`dispatchKeyEvent`, not `element.click()`) | T3.10, T3.9 |
| No horizontal overflow at 375/414/768px, on all 8 surfaces | T0.5 |
| Every `class` used in HTML resolves to a defined rule | T0.6, T2.2 |
| SW precache ⊇ the ESM import graph of every surface | T0.1 |
| Every surface boots with the network disabled | T0.1, T0.3 |
| No raw API field name appears in rendered text | T4.1 |
| Every `innerHTML` interpolation passes through `esc` | T1.1 |
| Exactly one `<h1>`; `<main>` present; skip link present | T3.5, T4.2 |
| `:focus-visible` defined; zero `outline: none` | T3.1, T3.2 |
| No colour literal outside `tokens.css` / `tokens.data.css` | T2.3, T2.4 |
| All 8 pages honour `prefers-reduced-motion` | T3.3 |
| **Contrast floor (WCAG AA 4.5:1 / 3:1 large) measured via `getComputedStyle`** | T3.11 |
| **Axe-core pass on all 8 surfaces** | the rest of Tier 3 |
| **Touch targets ≥ 44px** (WCAG 2.5.8) | T0.5 |
| **Text survives 200% and 400% zoom** | T3.17 |
| Every surface offers only locales it has complete strings for | T5.1, T5.2 |
| `lang`/`dir` driven by the selected locale | T5.2 |
| Gzipped first load ≤ budget | T1.4 |
| `check-i18n` covers all 8 surfaces and all namespaces | T5.4 |

Two lessons from the existing script must be carried forward. First, `scripts/check-dashboard-browser.mjs`
already documents a **double-escaping trap** inside template literals (`:517–519`, `:596–599`) where a
lone `\d` collapsed to `d`, so the regex matched nothing and **the check passed vacuously** — every new
regex assertion needs a negative control. Second, the script currently **mutates the store it audits**
(creates then deletes a CHW field report at `:705–748`) and is order-dependent on a single page state, so
it cannot shard across CI runners; fix both when extending it.

**This is the highest-leverage phase.** Every fix above was found by hand; the gate makes them permanent.

---

### Phase 10 — Content and copy pass (two days)

Apply the `humanizer` skill to every user-visible string. Current copy problems visible in the rendered
UI: the eight rule names masquerading as KPIs, `Not acknowledged` clipped off the rail, `action :` with a
stray space, "N queued" that never queues, `Last signal: —`, and the CPC paragraph that reads like a
disclaimer rather than an operator's brief.

---

### Phase 11 — Make the requirements track reality (one day)

Close the documentation gaps this audit exposed, so the next audit inherits fewer unknowns:

- Add a **UI evidence column** and a UI requirement row to `docs/unicef-requirements-traceability.md` (T5.7).
- Add the **first accessibility requirements** — contrast floor, keyboard operability, target size,
  plain-language — to the JTBD catalogue's Definition of Done. They are absent from every document (T5.8).
- Record the **dark-only decision** and its rationale in `docs/`, per Phase 2.1.
- Fix the doc defects found in passing: the `CHANGELOG.md` contradiction
  (`unicef-requirements-traceability.md:161` vs `:55`), 5.11 numbered before 5.10 (`:120` before `:121`),
  six actors used in the table but missing from the glossary (`:23–36`), and `demo-audit-2026-10-02.md`'s
  30-row table whose closing prose still says "thirteen".
- Retire `jtbd:645`'s caveat — *"Dashboard UI completeness was not confirmed by running or rendering the
  frontend"* — by making Phase 9's gate the evidence.

## Part 3 — What "world class" means here, concretely

For this product, the bar is not visual polish. It is:

1. **A CHW with 2 bars and a 5-year Android phone**, reading Somali, can open the field app, see their
   queue state, file a report that syncs when signal returns, and *hear confirmation it was accepted* —
   with no horizontal scrolling, no clipped buttons, no dead whitespace, and no raw translation key.
2. **A duty officer** can tell what changed, since when, in which district, and what it means for people
   — in their language, in their timezone, without reading a field name, and using a keyboard alone.
3. **A focal point** can approve a trigger with the evidence and consequence in front of them, and can
   explain the decision afterwards. Severity is legible without colour vision.
4. **A district officer** can drill into their district, search it, and read it with a screen reader.
5. **A country office** can export a quarterly PDF that survives the printing.
6. **An operator in a dead zone** gets a console that boots, shows the last known state, and clearly says
   what is stale and why.
7. **A donor reviewing the UNICEF traceability matrix** can see a UI evidence column, and can read the
   number behind every tile on screen.

Phases 0–6 deliver 1–6. Phases 7–11 keep them true.

---

## Verification

**Per phase**, in addition to `npm test` and `npm run validate`:

```bash
# 0 — offline boot (the T0.1 regression guard)
npm run demo:seed && npm start &
curl -s localhost:4177/ >/dev/null
# then in DevTools: Network → Offline → hard reload. The console must render.
# Or assert via CDP: fetch /, /app.js and every /shared/*.js with the SW active.

# 1 — headers and compression
curl -sI -H 'Accept-Encoding: gzip' localhost:4177/styles.css \
  | grep -iE 'content-encoding|cache-control|etag'

# 2 — one cascade
# assert no <style> block in public/*/index.html contains: reset, body, button, input, table, dialog

# 3 — no raw field names, no unbounded specificity
npm run check:model-boundaries
node scripts/check-no-raw-fields.mjs      # added in Phase 9

# 4 — accessibility, including contrast
npx @axe-core/cli http://localhost:4177/ http://localhost:4177/chw/ \
  http://localhost:4177/co/ http://localhost:4177/portal/ \
  http://localhost:4177/districts/ http://localhost:4177/focal-point/ \
  http://localhost:4177/parametric/ http://localhost:4177/scenarios/

# 9 — the whole gate
npm run check:dashboard && npm run check:i18n && node scripts/check-responsive.mjs
```

**Visual regression.** Screenshot all 8 surfaces at 375×812, 414×896, 768×1024 and 1440×900 after every
phase and diff. **Seven of the defects in this audit were caught only by looking at the rendered
product** — `.visually-hidden` rendering visibly in CO, the unstyled buttons on parametric, the detached
checkboxes, the clipped Disbursement History table, the light-theme manifests, CHW's horizontal overflow,
and districts' 83% empty page. **None was visible in source review, and none would be caught by the
current test suite.** Follow `docs/demo-audit-2026-10-02.md`'s own rule: screenshot first.

**Verify each fix by reverting it and watching the check fail.** An unverified fix is an assumption.

---

## Sequencing summary

| Phase | Content | Size |
|---|---|---|
| 0 | Correctness and unstyled-control fixes | 0.5 day |
| 1 | Compression, caching, security headers | 1 day |
| 2 | One design system across all 8 surfaces | 3 days |
| 3 | Content design: labels, time, numbers, the three weak screens | 3 days |
| 4 | Accessibility completion | 2 days |
| 5 | i18n and RTL that works, CHW-field-languages first | 2 days |
| 6 | Surface completeness: the JTBD contract | 3 days |
| 7 | Performance | 1 day |
| 8 | Component library | 3 days |
| 9 | Automated gate | 3 days |
| 10 | Copy pass | 2 days |
| 11 | Make the requirements track reality | 1 day |

**~28 days.** Phases 0 and 9 are non-negotiable and have the highest ratio of defects fixed to effort in
the whole plan. Phase 2 is the enabling investment: it is what makes Phases 3–8 cheap rather than eight
separate renegotiations with the same cascade.
---

## Implementation progress

Tracked against the phases above. Each line was verified by a real render or a
failing check, not by reading the diff.

| Phase | State | Evidence |
|---|---|---|
| 0 — correctness | done | offline boot fixed (full module graph precached, `skipWaiting`/`claim`); offline queue routed through `shared/runtime.js`; `refresh()` settles per-panel and names failures; `res.ok` checked via shared `apiFetch`; XSS closed in `co` and `districts`; `escapeHtml` preserves `0`/`false`; four undefined classes defined; checkbox class; `:focus-visible` replaces two `outline: none` |
| 1 — serving | done | 238 KB → 65 KB over the wire (3.7×); ETag revalidation, per-type `cache-control`, `sw.js` `no-cache`; fifteen static branches collapsed into one `sendFile`; CSP + `nosniff` + `frame-ancestors` + `referrer-policy` + `permissions-policy`; SW API cache bounded and TTL-pruned |
| 2 — one design system | done | all 8 surfaces link `tokens.css` + `styles.css` + `components.css`; `shared/fmt.js`, `shared/labels.js` created; `apiFetch`/`apiSettled`/`submitOrQueue` adopted by every surface; duplicated `escapeHtml`, date, number and severity helpers removed (178 LOC); responsive gate enforces the 24px AA target floor |
| 3 — content design | in progress | `labels.js` names every metric; focal-point card states the comparison and the consequence; scenario workbench opens on five named presets; workflow ribbon leads with a total; CO counts are integers; blockchain IDs truncated; `shared/fmt.js` gives one time format with a zone and one duration format |
| 4 — accessibility | in progress | one `<h1>`, `<main>` and skip link on all 8; 38 `<th>` scoped; 0 unlabelled inputs; 0 missing `alt`; severity contrast fixed on two surfaces (was 2.2–4.3:1); `--ink-faint` raised above AA; CHW live regions and focus management; map focusable with keyboard pan/zoom and a textual record list; print stylesheet; focal-point dialog focus + stale-state fix |
| 5 — i18n and RTL | done | per-surface locale reconciliation enforced by `scripts/check-i18n-offers.mjs`; three surfaces were offering languages at 0% coverage; `lang`/`dir` now driven from one locale table |
| 6 — JTBD contract | not started | — |
| 7 — performance | not started | — |
| 8 — component library | not started | — |
| 9 — automated gate | in progress | `scripts/check-responsive.mjs` (layout, overflow, clipping, target size, screenshots through CDP); `scripts/check-i18n-offers.mjs` |
| 10 — copy pass | not started | — |
| 11 — requirements track reality | not started | — |

### Gates added

| Script | Fails on |
|---|---|
| `npm run check:responsive` | horizontal overflow, clipped text, or a control below the WCAG 2.2 SC 2.5.8 24px floor, across 8 surfaces × 3 viewports. Set `LINDELA_LITE_SHOTS=<dir>` to capture screenshots through CDP |
| `npm run check:i18n-offers` | a surface offering a locale it cannot render, or omitting one it can; a picker option labelled with an abbreviation |

Both clear the service worker and the browser cache before measuring. That is
not incidental: several hours of this work went into debugging assertions that
were passing or failing against a cached build rather than the source, and
`chrome --headless --screenshot` sizes the window rather than the layout
viewport, which renders a correct page as one with content running off the edge.
