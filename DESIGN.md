---
name: Lindela Lite
description: An open-source coordination engine for climate-health and climate-conflict response — dark-first, measured, and built to say what it does not know.
colors:
  brand: "oklch(70% 0.16 205)"
  brand-hover: "oklch(74% 0.16 205)"
  accent: "oklch(78% 0.15 90)"
  on-brand: "oklch(14% 0.02 205)"
  bg: "oklch(15% 0.02 260)"
  bg-elevated: "oklch(19% 0.02 260)"
  surface: "oklch(22% 0.02 260)"
  surface-hover: "oklch(26% 0.02 260)"
  ink: "oklch(96% 0.005 260)"
  ink-muted: "oklch(75% 0.02 260)"
  ink-faint: "oklch(72% 0.02 260)"
  stroke: "oklch(30% 0.01 260)"
  stroke-strong: "oklch(40% 0.015 260)"
  focus-ring: "oklch(85% 0.14 205)"
  ok: "oklch(72% 0.16 155)"
  warn: "oklch(78% 0.15 75)"
  danger: "oklch(65% 0.22 25)"
  danger-ink: "oklch(74% 0.20 25)"
  sev-critical: "oklch(65% 0.22 25)"
  sev-high: "oklch(72% 0.18 45)"
  sev-medium: "oklch(80% 0.15 85)"
  sev-low: "oklch(75% 0.10 190)"
  cold: "oklch(68% 0.13 265)"
  warm: "oklch(72% 0.13 38)"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.5rem, 1.3rem + 1vw, 2rem)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, 'JetBrains Mono', Consolas, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.5
rounded:
  sm: "3px"
  md: "6px"
  lg: "10px"
  pill: "999px"
spacing:
  sp-1: "0.25rem"
  sp-2: "0.5rem"
  sp-3: "0.75rem"
  sp-4: "1rem"
  sp-5: "1.25rem"
  sp-6: "1.5rem"
  sp-8: "2rem"
  sp-10: "2.5rem"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.35rem 0.7rem"
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    padding: "0.35rem 0.7rem"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "0.35rem 0.7rem"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.sp-3} {spacing.sp-4}"
  panel:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.sp-4}"
---

# Design System: Lindela Lite

## Overview

**Creative North Star: "The Situation Room"**

A room where a decision gets made and recorded. The picture is shared, so
nothing is private about how a number was reached — every figure on screen
carries where it came from and when. Surfaces stay calm because the content is
not: this is a screen an operator reads while deciding whether to move
resources, and a screen that competes for attention is a screen that loses the
argument for attention when it matters.

The system is **dark by decision, not by fashion**, and that decision is
load-bearing rather than aesthetic. A district office runs this on the laptop it
does everything else on, in rooms where power is a contingency; a dark ground
holds legibility when the panel is dim and does not blind the operator who has
been reading it for six hours. Light and high-contrast sit beside it as
first-class themes, each one measured rather than derived.

What distinguishes the system is that **it treats honesty as a visual
property.** The states an operator most needs to read — "not ingested",
"never run", "not determined" — are the ones a light treatment erases first, so
`--ink-faint` was raised twice until it cleared 4.5:1 on the surfaces it
actually lands on. Severity never rests on colour alone. Where the platform
cannot compute a number it prints the reason instead, and the interface renders
that reason as content rather than as an error.

**Key Characteristics:**

- Dark-first, with light and high-contrast as measured equals, not afterthoughts.
- Flat at rest. Depth is tonal — a four-step ground ramp — not shadowed.
- Every colour pair is verified by arithmetic in `test/theme-tokens.test.js`.
- Severity is encoded three times over: word, glyph shape, hatch density.
- Dense and quiet. This is an instrument surface, not a marketing surface.
- Tabular numerals and monospace where figures must align and compare.

## Colors

The palette is a cool neutral ground in OKLCH with a single cyan-teal brand and
a single amber accent; every value is measured against the surfaces it lands on,
never picked by eye.

### Primary

- **Instrument Cyan** (`oklch(70% 0.16 205)`): the brand and the one interactive
  accent. It marks the active rail tab, primary button fills, the focus
  boundary, and links. In the light theme it drops to `oklch(42% 0.10 210)` —
  the same hue at a lightness that clears 4.5:1 on paper white.
- **Instrument Cyan, Lifted** (`oklch(74% 0.16 205)`): the hover state of any
  cyan fill. The lift is lightness only; the hue never moves.

### Secondary

- **Signal Amber** (`oklch(78% 0.15 90)`): the accent, used sparingly for the
  second-order emphasis the cyan should not carry. Its rarity is the point.

### Neutral

- **Deep Field** (`oklch(15% 0.02 260)`): the page ground. Everything sits on it.
- **Raised Field** (`oklch(19% 0.02 260)`): panels, cards, the topbar — the
  first tonal step. Depth is this, not a shadow.
- **Surface** (`oklch(22% 0.02 260)`): the resting fill of interactive chrome —
  buttons, chips, table headers.
- **Surface, Hovered** (`oklch(26% 0.02 260)`): one step further, on hover.
- **Reading Ink** (`oklch(96% 0.005 260)`): body text and headings.
- **Muted Ink** (`oklch(75% 0.02 260)`): labels, secondary text, inactive tabs.
- **Faint Ink** (`oklch(72% 0.02 260)`): the weakest legible step. It carries
  "not ingested" and "never run" — states an operator most needs to read, and
  the ones a light treatment erases first. It sits close to muted ink on
  purpose: three lightnesses that read as a hierarchy is one more than a status
  bar needs.
- **Hairline** (`oklch(30% 0.01 260)`) and **Hairline, Strong**
  (`oklch(40% 0.015 260)`): borders and dividers. The strong variant is the
  boundary of anything a user can click.

### Status and Severity

- **Ok** (`oklch(72% 0.16 155)`), **Warn** (`oklch(78% 0.15 75)`),
  **Danger** (`oklch(65% 0.22 25)`): outcome states.
- **Danger as Text** (`oklch(74% 0.20 25)`): the danger hue lightened until it
  clears 4.5:1 as *text* on a danger-tinted surface. The 65% fill colour measured
  4.07:1 there — under the floor at 12px — which is why fill and ink are
  separate tokens.
- **Severity Ramp** — critical `oklch(65% 0.22 25)`, high `oklch(72% 0.18 45)`,
  medium `oklch(80% 0.15 85)`, low `oklch(75% 0.10 190)`: four hues spanning
  25°–190°, a red-orange-yellow band that collapses under deuteranopia and
  protanopia. The ramp is therefore never the only signal.
- **Cold** (`oklch(68% 0.13 265)`) and **Warm** (`oklch(72% 0.13 38)`): the two
  poles of a diverging heatmap, matched at equal lightness so equal distances
  from the pivot read as equally far out. `--ok` is deliberately not reused for
  the cold pole: that would say "good" about a cold anomaly, a value judgement
  the data does not support.

**The Measured-Not-Chosen Rule.** No colour enters this system by eye. Every
text/surface pair is verified by `test/theme-tokens.test.js`, which re-runs the
gate's own OKLCH→sRGB arithmetic across every combination the three themes can
paint. A value that has not been through that arithmetic is a proposal.

**The One Channel Allowed to Fail Rule.** Severity colour may fail — under
colour vision deficiency, in greyscale print, on a projector with no colour
left. It is permitted to fail because two other channels carry the same
information, and those do not.

## Typography

**Display Font:** system UI sans (`ui-sans-serif, system-ui, -apple-system,
'Segoe UI', Roboto, sans-serif`)
**Body Font:** the same stack
**Mono Font:** system monospace (`ui-monospace, SFMono-Regular, 'JetBrains
Mono', Consolas, monospace`)

**Character:** there is no webfont, and that is a constraint turned into a
principle. The browser receives the authored bytes — no build step, no font
request, nothing to fail when the network does. The system stack renders
natively on the operator's own machine, which is the right typeface for a tool
that must work in a building where the DNS is the most likely thing to be
broken. Hierarchy is carried by size, weight and colour rather than by a
distinctive face.

### Hierarchy

- **Display** (600, `clamp(1.5rem, 1.3rem + 1vw, 2rem)`, 1.2, −0.02em):
  page titles. Tight tracking at size, one per view.
- **Title** (600, `1.125rem`, 1.35): panel and dialog headings.
- **Body** (400, `0.9375rem`, 1.5): the default. Ledger prose caps at 60ch
  (`.page-lede`) and empty-state copy at 45ch.
- **Label** (500, `0.75rem`, 1.4): field labels, tab text, chips, badges.
- **Mono** (`0.8125rem`, 1.5): identifiers, coordinates, raw values, code. Any
  figure that is read character by character rather than compared as a quantity.
- **Numeric cells** (`font-variant-numeric: tabular-nums`, right-aligned):
  every number in a table column. Digits must align vertically or the column
  cannot be scanned.

### Named Rules

**The No-Webfont Rule.** No font is fetched. If a surface needs a weight or
width the system stack does not have, the answer is a different composition,
not a different download.

**The Tabular Figures Rule.** Any figure appearing in a column, or compared
against a neighbouring figure, uses `tabular-nums`. Proportional digits are for
prose.

## Layout

A fixed app shell: a 48px sticky topbar, a flexible main region, a 360px right
rail, and a 30px status bar — a four-row grid (`body.app-shell`) with the rail
spanning the full height. The console's main region splits
`minmax(0, 3fr) minmax(0, 2fr)` where two panes share it.

Spacing is a nine-step scale, `--sp-1` (0.25rem) through `--sp-10` (2.5rem), on
a 4px base. Density is deliberate: control heights are 28px and 36px
(`--size-control`, `--size-control-lg`), not the 44px a touch-first system
would use — except on the CHW surface, where `--tap-target-min: 44px` and
`--chw-font-size-base: 1.125rem` raise both, because that surface is used
one-handed on a shared phone.

**Breakpoints are content-driven, not device-named:** 900px, 800px, 768px,
640px, 480px. Below 800px the page itself becomes the scroller and the rail
moves into normal flow — `body.app-shell` releases its fixed height rather than
compressing, because a fixed-height shell on a short viewport hides content
with no way to reach it. RTL is handled by explicit mirroring
(`[dir="rtl"] .console-layout`) rather than by logical properties throughout.

**The Shell-Is-The-Scroller Rule.** On a viewport too short for the fixed
shell, the page scrolls. Content is never trapped inside a region the viewport
cannot reach.

## Elevation & Depth

**Flat, by tonal layering.** There is essentially no shadow vocabulary:
`styles.css` carried exactly one `box-shadow` in 1,700 lines. Depth is
communicated by a four-step ground ramp — `--bg` → `--bg-elevated` →
`--surface` → `--surface-hover` — so a panel reads as raised because it is
lighter, not because it is casting anything.

This is the correct choice for the surface. A shadow is a claim about a light
source, and a situation room has no consistent one; a tonal step is a claim
about grouping, which is what the operator actually needs to see.

### Shadow Vocabulary

Three tokens exist and are used rarely, structurally, and for things that
genuinely float above the page:

- **Ambient low** (`0 1px 2px oklch(5% 0.02 260 / 0.35)`): the lightest
  separation, for a control that detaches slightly from its row.
- **Raised** (`0 4px 8px oklch(5% 0.02 260 / 0.4)`): dropdowns and popovers.
- **Floating** (`0 16px 48px oklch(5% 0.02 260 / 0.6)`): dialogs and toasts —
  the only elements that are unambiguously above the plane of the page.

In the light theme the same scale runs at roughly a quarter opacity, because a
black wash that reads as depth on a dark ground reads as dirt on paper white.
In the high-contrast theme shadows are replaced entirely by hard rings
(`0 0 0 1px`), because a soft shadow carries no information when the user has
asked for maximum separation.

**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow appears only
when an element genuinely leaves the page plane — it is never decoration and
never a hover effect.

## Shapes

Softly squared and quiet. Three radii: **3px** (`--r-sm`) for fields, small
controls and focus rings; **6px** (`--r`) for the default — buttons, cards,
panels, the standard container; **10px** (`--r-lg`) for large surfaces. The one
exception is the **chip**, which is fully rounded (`999px`), because a pill
reads as a token of state rather than as a button to press.

Borders are 1px hairlines in `--stroke`, strengthening to `--stroke-strong` on
anything interactive. The system uses **inset rings** rather than outer borders
for status fills — `box-shadow: inset 0 0 0 1px` — so a tinted chip keeps its
exact outer dimensions when it changes state.

**The Inset-Ring Rule.** A component that changes colour on state changes only
its colour. Geometry that moves when state changes is a layout bug wearing a
style's clothes.

## Components

### Buttons

Quiet by default; only one button on a screen should be cyan.

- **Shape:** 6px radius (`--r`), 1px `--stroke-strong` border, padding
  `0.35rem 0.7rem`.
- **Default:** `--surface` ground, `--ink` text, 500 weight. A visible boundary
  with no fill — the system does not use filled buttons for secondary actions.
- **Primary:** `--brand` fill with `--on-brand` text at 600 weight. One per
  view.
- **Hover / Active:** default lifts to `--surface-hover`, then `--bg-elevated`
  on press. Primary lifts to `--brand-hover`. Transitions are 120ms on the
  standard ease. Disabled is `opacity: 0.38` with `pointer-events: none`.
- **Icon-only:** transparent ground and border, `--ink-muted`, revealing
  `--surface` on hover.
- **Outcome variants** (`approve` / `reject` / `send`): transparent ground with
  a 35%-mixed border and coloured text, filling to a 10% tint on hover. These
  are the dispatch controls, and they are deliberately not solid — an approve
  button that shouts is a button that gets pressed by accident.
- **Sizes:** `btn-sm` and `btn-xs` reduce padding and type; `btn-xs` also drops
  to the 3px radius, because a 6px radius on a 20px-tall control is most of the
  control.

Every variant is standalone: `class="btn-primary"` without `class="btn"` still
renders a complete button. This was a real defect — a variant used without the
base class inherited the UA default `border: 2px outset` and rendered as a
browser-default button.

### Chips

- **Style:** fully rounded, `--surface` ground, `--ink-muted` text at `--text-xs`,
  1px `--stroke` border, `2px 8px` padding.
- **Selected:** a 18% `--brand` wash, `--brand` text, 38% `--brand` border.
- **Severity chips** carry the ramp colour as a 22% wash with an inset ring at
  full strength, and are the one place the three-channel redundancy applies —
  see below.

### Severity Indicators (signature)

The most distinctive component in the system, and the one that most directly
encodes the product's argument.

A severity chip communicates its class through **three independent channels**,
because each fails differently:

1. **The word** — `critical`, `high`, `medium`, `low` — always present.
2. **The glyph**, prepended via `::before`, whose *shape* encodes the class:
   `▲▲` critical, `▲` high, `■` medium, `●` low, `—` unknown. The ladder is
   "more ink is worse", which needs no legend. It survives any colour vision
   deficiency and greyscale printing.
3. **The hatch**, a `repeating-linear-gradient` whose *density* encodes the
   class again: 5px critical, 7px high, 9px medium, none for low. It survives a
   projector with no colour left to project.

The glyph is set at `0.85em` so a 12px chip widens by two characters rather
than four — every character is one the row cannot give up at 320px, and the
reflow probe measures it.

**The Three-Channel Rule.** Severity is word, glyph and hatch, on every
surface, without exception — dense tables and map layers included. `low` takes
no hatch because a texture meaning "slightly less bad" is worse than one meaning
"nothing here".

**The No-Borrowed-Glyph Rule.** Sentiment chips (`.chip-ok`) get no severity
marker. Borrowing low's `●` for "positive" would put two unrelated meanings on
one glyph — the exact collision the ramp exists to prevent.

### Cards / Containers

- **Corner:** 6px (`--r`). **Ground:** `--bg-elevated`. **Border:** 1px
  `--stroke`. **Padding:** `--sp-3 --sp-4` for cards, `--sp-4` for panels.
- **Interactive cards** reveal `--surface` on hover and shift the border to
  `--brand` on `:focus-within`, so a keyboard user sees the same affordance a
  pointer user does.
- **Shadow:** none. See Elevation.

### Inputs / Fields

- **Style:** `--bg` ground, `--ink` text, 1px `--stroke-strong`, 3px radius,
  `0.35rem 0.5rem` padding, `min-height: 30px`. Placeholders in `--ink-faint`.
- **Focus:** a `--focus-ring` outline drawn *inside* the control
  (`outline-offset: -1px`) plus a `--brand` border shift. The inset offset is
  deliberate: a dense filter bar must not shift its layout when a field takes
  focus.
- **Textareas** switch to monospace — they carry raw JSON and pasted data.

### Focus, everywhere

Every focusable element — `a`, `button`, `input`, `select`, `textarea`,
`summary`, `[tabindex]` — takes a `--focus-ring` outline at
`--focus-ring-width` (2px, 3px in high contrast) with a 2px offset. This was
previously absent entirely: the only focus styling was `input:focus`, which
fires on mouse click and covered no interactive component at all.

**The Focus-Is-Not-Optional Rule.** Every focusable element has a visible focus
state. A surface without one is not shippable, and `scripts/check-a11y.mjs`
walks all eight surfaces in all three themes to prove it.

### Navigation

- **Topbar:** 48px, sticky, `--bg-elevated` ground, 1px bottom hairline.
  Brand at left, controls at right.
- **Rail tabs:** equal-width flex items on a hairline baseline, `--ink-muted` at
  rest, shifting to `--brand` text with a 2px `--brand` bottom border when
  active. Hover reveals `--ink` on `--surface-hover`. The tab strip scrolls
  horizontally rather than wrapping.

## Do's and Don'ts

### Do:

- **Do** verify every new colour pair with the OKLCH→sRGB arithmetic in
  `test/theme-tokens.test.js` before it ships. An unmeasured value is a
  proposal, not a token.
- **Do** carry word, glyph and hatch on every severity surface, dense tables
  included.
- **Do** reach for a tonal step (`--bg-elevated`, `--surface`) before a shadow.
- **Do** give every focusable element a `--focus-ring` outline, drawn inside the
  control when it sits in a dense row.
- **Do** use `tabular-nums` for any figure in a column.
- **Do** render a refusal as content. When the platform cannot ground a number,
  it prints the reason — and the interface shows that reason in the same voice
  as any other answer, not as an error state.
- **Do** declare a token in every theme block, including both
  `prefers-color-scheme` mirrors. A token present in one and not another
  resolves to nothing, and `fill: var(--undefined)` is invalid — which is how
  the map's landmass once fell back to black.
- **Do** make each button variant standalone, so `class="btn-primary"` alone
  renders a complete control.

### Don't:

- **Don't** pick a colour by eye, or by what looks right on your monitor in one
  theme.
- **Don't** encode severity in colour alone, on any surface, ever.
- **Don't** add a webfont. The no-build, no-request constraint is the product's
  deployment model, not a preference.
- **Don't** use a shadow as a hover effect or as decoration. Shadows are for
  elements that leave the page plane.
- **Don't** reuse `--ok` for a cold or negative-reading data pole. It asserts a
  value judgement the data does not support.
- **Don't** change a component's geometry when its state changes. Fill, ink and
  ring may move; box size may not.
- **Don't** compress the shell to fit a short viewport. Release the fixed height
  and let the page scroll.
- **Don't** use proportional digits in a numeric column.
- **Don't** apply the CHW surface's 44px tap targets or 1.125rem base to the
  console. Density is the console's job; reach is the CHW surface's.
