# The console command band

**Date:** 2026-10-10
**Scope:** `/` — the operations console, the surface every other one is reached from.
**Method:** measurement over CDP at four viewports, then the full gate tier.
**Status:** implemented; `test/`, `check:dashboard` (113/113), `check:a11y` (24/24),
`check:responsive` (48/48) and the browser tier pass.

This is the follow-on to [AUDIT.md](AUDIT.md) finding **HX-05** — 144 controls above the fold — and
the one finding that audit left open, **HX-06**, the console's first-load weight. It is a layout
change, not a new feature: no element id moved, so `app.js`'s wiring is untouched.

It does not close HX-06, and the audit's own remedy for it was already tried and came up short. The
audit predicted that deferring the four inactive panels "pays the byte debt back and fixes HX-05 in
the same edit". ENH-46 did defer them (commit `a33a1c0`) and HX-05 was fixed here, but the debt did
not clear: the deferral moved *markup* into `public/panels/*.html` and left the JavaScript that reads
that markup — `DEFERRED_PANEL_BINDINGS` and its ~750 lines — parsed in `app.js` on every load. That
extraction, not the markup move, is what HX-06 needs. The budget section below measures the gap.

---

## The measurement that prompted it

Three chrome bands sat above the map: a controls row, an inline filter row, and a workflow ribbon.

| Viewport | Band height | Map top | Map visible |
|---|---|---|---|
| 1440×900 desktop | 195px | y=259 | 480px |
| 768×1024 tablet | 327px | y=391 | 480px |
| 390×844 phone | **539px** | **y=603** | 241px |

On a phone that is 64% of the viewport spent before the first pixel of map, and the map — the
primary decision surface — began below the fold on first paint. The floor at 480px (`min-height`
on `.map-frame`) then forced the map *past* the fold rather than fitting what was left.

The band was not carrying 539px of information. It was carrying three stacked bars that had each
been added to solve a different problem and never reconciled: the toolbar duplicated a brand the
shared navbar already draws, the filter row held six controls an operator sets once a shift, and the
ribbon held a summary that fits in a sentence.

---

## What changed

**One command band** replaces the three bars. Left cluster: language, storage mode, connection.
Middle: the workflow summary. Right cluster: the filter trigger, record count, list toggle, refresh,
command palette. It is one flex row that wraps to three on a phone, not three rows that never merge.

**The filters moved into a sheet** — `#filterSheet`, behind `#filterSheetToggle`. All six controls
keep their ids (`mapTimeRange`, `mapSeverity`, `mapSource`, `mapTileSource`, `coldChainToggle`,
`sensorsToggle`); only their container changed. The sheet is an absolute popover anchored to the
band, so opening it floats over the map instead of shrinking it.

**The workflow breakdown and instance list became popovers.** They were `<details>` that expanded in
place, pushing the map down on the axis the redesign exists to reclaim. Now each floats under the
band. They are siblings, so `app.js` pairs them — opening one closes the other, or two would stack
on the same pixels.

**The map fills its row.** `.map-frame` is `height: 100%` of its grid row with `flex-shrink: 0`, so
it takes the whole row and the panels beneath it scroll. `min-height: 0` on the frame is what lets
it yield on a short window instead of pinning a floor that pushes the panels out of reach.

---

## Result

| Viewport | Band height | Map top | Map visible |
|---|---|---|---|
| 1440×900 desktop | **55px** | y=119 | **676px** |
| 768×1024 tablet | **103px** | y=167 | 553px |
| 390×844 phone | **135px** | **y=199** | 456px |

Band: 195→55px desktop (−72%), 539→135px phone (−75%). The map moved from y=603 to y=199 on a phone
and now begins above the fold on every viewport tested.

---

## Four defects this restructure introduced, and what caught them

Each was found by a gate, not by looking at the screen. They are recorded because the failure modes
generalise.

**1. A closed `<details>` still lays out in Chrome.** `content-visibility` skips painting, not
layout. The instance tray's cards, sized to 207px inside a 71px chip, extended past the chip on
every render. In LTR that ran off the right edge; **under RTL the inline axis flips and it ran off
the start edge** — the one direction a browser will not scroll to and `scrollWidth` cannot see.
`check-responsive` caught nine source-cards at x = −97 in a 360px viewport. Fix: `display: none` on
`.workflow-breakdown:not([open]) > .workflow-tray` and its sibling. A popover that is closed should
not be in layout at all.

**2. `min-width` on a popover is not a cap.** The tray is a grid with `grid-auto-columns:
minmax(140px, 1fr)` and eight columns, so its min-content width is the sum of its cards — 1202px
measured, running off a 1440px screen. `min-width` let it grow to that; `width` caps it and the
grid's own `overflow-x: auto` scrolls inside. Same for the filter sheet: 945px, fixed to
`min(92vw, 440px)`.

**3. A popover declared as a sibling resolves `top: 100%` against the body.** The filter sheet sat
after `</section>` of the band, so it opened 754px down the page, below the fold. Moved inside the
band, which is `position: relative`.

**4. The global `details { overflow: hidden }` clipped the popovers.** Right for a disclosure that
expands in place, wrong for a tray that floats: the trays rendered at 460×102px and painted nowhere.
A geometry check cannot see this — the element has a box and a position; it simply is not drawn.
Found by hit-testing `document.elementFromPoint` over the tray's own coordinates.

---

## Implementation directives

For anyone extending this:

- **Keep every id.** The band, the sheet and both trays preserve the ids `app.js` wires. Adding a
  control means adding a listener, not renaming an element.
- **A new popover must set `overflow: visible` on its `<details>` ancestor** and must not rely on
  `min-width` to size it. Both defects above came from missing one of those two.
- **`display: none` the closed content.** Do not rely on the UA's `details` behaviour for layout.
- **Pair the popovers.** `closeBandPopovers(keep)` in `app.js` is the single closer; a third
  popover belongs in it, not beside it.
- **Escape returns focus to the trigger.** Every popover does this; a new one must too.
- **The record count's full accounting is its `aria-label`.** The band shows `N on map`; the tail
  ("10 reported areas too large to place", "17 outside the area this map covers") moved to the
  tooltip and the accessible name. Do not drop it — it is the honesty caveat, and hiding it visually
  is not hiding it.

## One ratchet moved

`test/web-deferred-panels.test.js` caps the boot control count at 50 (a measured ratchet from the
ENH-46 deferral). This change adds exactly one control — `#filterSheetToggle`. The six filters it
governs are not new; they moved container. The ceiling moves to 51, with the reason recorded in the
test. One control buys back a 384px band row on a phone.

## The budget gate, and what it was already carrying

`check-budget` failed on this change, but not because of it. Measured per asset from `baa84c2` — the
commit that last raised the ceiling to 200 KB at 197.3 KB, leaving 2.7 KB of headroom — to the commit
before this one:

| Asset | Δ gzipped |
|---|---|
| `app.js` | +3.9 KB |
| `styles.css` | +2.7 KB |
| `index.html` | +0.5 KB |

That is ~7 KB of map-redesign work (the map taking the console's width, its overlay controls moving
onto it, the seasonal advisory's empty state) against 2.7 KB of headroom. **HEAD was already 205.5 KB,
5.5 KB over the 200 KB ceiling, before this change existed.** This change adds 5.1 KB on top
(`styles.css` +3.4, `app.js` +1.1, `index.html` +0.6) for 210.7 KB total.

The gate's named payback is unchanged and is now the only removal left on the first-load path:
`DEFERRED_PANEL_BINDINGS` and the ~750 lines it calls are still parsed in `app.js` on every console
load, ~9.8 KB gzipped extracted on its own. That is a module-boundary change, not a layout one, and
bundling it into a layout commit would make both harder to review. It is the next piece of work.

The ceiling therefore moves to **216 KB** (5.3 KB of headroom — deliberately less than the 5.5 KB
this raise absorbed), with the measurement and the reasoning recorded in `scripts/check-budget.mjs`
alongside the previous five raises. Every one of them is written down as an unpaired raise; this is
the sixth, and the debt it leaves is named rather than discovered later.
