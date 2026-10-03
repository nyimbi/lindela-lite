# ADR-012: Eight separate applications rather than one routed application

**Status:** Accepted
**Applies to:** `public/*/index.html`, `public/shared/`
**Deciders:** whoever adds a feature and wonders which screen it belongs on

## Context

The product serves audiences with almost nothing in common:

| Surface | User | Device | Network | Literacy need |
|---|---|---|---|---|
| `/chw` | community health worker | shared phone, one hand | often none | low — icon-led wizard |
| `/` | operator | desk | intermittent | normal |
| `/focal-point` | duty officer | desk or phone | intermittent | normal |
| `/co` | programme manager | desk | good | normal |
| `/portal` | external partner | desk | good | normal |
| `/districts`, `/scenarios`, `/parametric` | analyst, district officer, finance | desk | good | normal |

The obvious architecture is one application with a router and a role switch — eight routes, one
bundle, one set of components, one place to fix a bug. That is what most teams would build, and it is
the right default for most products.

It is wrong here for one reason: **the CHW app is the product's reason to exist, and it is not a
smaller version of the console.** It is offline-first, icon-led, 44px-tap-targeted, offered in three
languages chosen because those are the only ones with complete CHW strings, and it writes to IndexedDB
through a queue the other seven surfaces do not need. Feature parity with the console would make it
worse at its one job.

## Decision

Eight separate applications under `public/`, sharing:

- **a token layer** — `tokens.css`, OKLCH, dark-only;
- **a primitive layer** — `styles.css` for console components, `components.css` for the rest;
- **a runtime library** — `shared/runtime.js` (`apiFetch`, `apiSettled`, `submitOrQueue`, `initI18n`,
  `initOfflineQueue`, `initServiceWorker`), `shared/fmt.js` (escaping, numbers, time, locale metadata),
  `shared/labels.js` (API field names to language), `shared/navbar.js`.

They diverge deliberately. CHW has its own 44px tap targets and no cross-application navigation. The
console has a command palette, keyboard shortcuts and a fixed app-shell layout. The CO dashboard has
quarter selectors and a PDF export.

## Options considered

### One application with a router

| Dimension | Assessment |
|---|---|
| Component reuse | Total |
| Bundle cost on a field phone | Every route's code on first load |
| Offline | One precache or eight; a route the worker never cached breaks every other route with it |
| CHW usability | Feature parity is the enemy of a focused tool |
| Blast radius of a regression | Every surface |

**Rejected.** The offline consequence is the decisive one: with one application, a stale or missing
module is a total outage for every user including the ones who do not need that route. The current
arrangement means a bug in the parametric console cannot stop a health worker filing a report.

### Eight applications with no shared layer

**Rejected.** This was the state until recently: five of the eight did not load the token file at
all, carried 236–326 lines of inline CSS each, and had three different spellings of danger red.
Duplication did not buy isolation; it bought three primaries and one product.

### One application per audience group (three, not eight)

**Considered.** Group the seven desk surfaces and keep CHW separate.

**Rejected for now.** The desk surfaces have genuinely different data-access shapes — partner is
read-only with CSV/JSON export, finance is testnet-only, analyst is read-only scenario. Merging them
would need a role model before it needs a bundle. It is the obvious next consolidation if the eight
ever get hard to maintain, and the shared layer already makes it cheap.

## Consequences

**Easier**

- **A failure is contained.** The console's runtime cannot stop the CHW app from submitting a report.
- Each surface carries only what it needs. The CHW first load is a fraction of the console's.
- A field surface can be designed for a field device without arguing with a desk surface's layout.
- The shared layer means a fix to a button or a date format lands everywhere at once.

**Harder**

- **Eight places to forget.** The audit found `.visually-hidden` used three times and defined nowhere;
  `escapeHtml(str || '')` in two surfaces dropping legitimate zeros; a `#btn-secondary` used in five
  places and defined in none; and two surfaces each mounting the shared navbar, leaving two
  `#locale-select` elements in one document.
- **Class names collide.** The console's ribbon tile and the focal-point approval card were both
  `.workflow-card` with different layouts. Linking the shared stylesheet made the console's grid win on
  the approval screen. The console's is now `.workflow-metric`, which is what it is — but the collision
  is a property of the arrangement, not a one-off.
- **Shared modules can be aspirational.** `map-frame.js`, `basemap.js`, `seasonal.js` and
  `flood-bands.js` live in `shared/` and each has exactly one consumer. The directory name overstates
  the sharing, and a newcomer will reasonably assume otherwise.

**Revisit when**

- Eight surfaces become hard to change consistently, at which point the consolidation in the rejected
  option above is worth the role model.
- A second field surface appears. Two field apps sharing a real framework is a stronger argument than
  one.

## What makes this decision hold

The shared layer is what turns eight applications from eight products into one product. It is thin
today — a token file, two stylesheets, four modules — and that thinness is the risk: a convention
held by four files is a convention, not a contract.

Two gates now hold it:

- `scripts/check-i18n-offers.mjs` derives each surface's locale picker from its own translation
  coverage, so a surface cannot offer a language it cannot render.
- `scripts/check-responsive.mjs` and `scripts/check-a11y.mjs` assert the same structural invariants
  across all eight — one `<h1>`, a `<main>`, a skip link that is the first tab stop, heading order,
  form naming, header scope, measured contrast, target size, and no overflow at 360/414/768px.

A shared layer with no gate is eight conventions. With one, it is a system.

Related: [ADR-001](ADR-001-zero-frontend-dependencies.md)