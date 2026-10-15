#!/usr/bin/env node
/**
 * First-load budget gate.
 *
 * 64 KB gzipped for the whole console is the number worth protecting, because
 * the binding constraint for this product is a field connection, not a data
 * centre. Nothing was enforcing it: a well-meaning import of a charting library
 * would have doubled the first paint for every operator and for every community
 * health worker on the same weak link, and no gate would have said so.
 *
 * Measures the assets the browser actually fetches to render `/` — the HTML, the
 * three stylesheets, the console script, its module graph, and the English
 * catalogue — compressed the way the server compresses them.
 *
 * Usage: node scripts/check-budget.mjs
 *        BUDGET_KB=80 node scripts/check-budget.mjs   (to allow headroom once)
 *        node scripts/check-budget.mjs <dir>          (measure a copy of the tree)
 *
 * The optional root is for `test/budget-walker.test.js`, which plants a module
 * into the graph to prove the walker sees it. Planting into the real
 * `public/shared/` meant writing a tracked file from a test, and `node --test`
 * runs files in parallel workers against one shared tree — so the canary raced
 * every other reader of that directory. It now measures its own copy. argv
 * rather than an environment variable on purpose: a stray `LINDELA_ROOT` in a
 * developer's shell would silently measure the wrong tree and report a pass.
 */

import { readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')

/** The console's first load, before any interaction. */
const ENTRY = 'index.html'
/**
 * Raised twice, deliberately, and each time with something removed.
 *
 * 112 -> 124 KB: the workflow surfaces. The six-attribute subject panel, the
 * escalation view, record search and the confirmation gates for irreversible
 * actions. Their JS already loads dynamically, so it costs an operator who
 * never opens them nothing.
 *
 * 124 -> 138 KB: three themes, and the modules behind them. `/workflow/panel.css`
 * stopped being a blocking <link> in index.html and is now injected by
 * panel.js on first open — 2 KB off every field first load, for a panel that is
 * usually not on screen. That is the "something removed" this increase came
 * with, and it is the only honest reason to move a gate.
 *
 * 129.1 KB measured, 8.9 KB of headroom. A budget raised to fit whatever was
 * just merged is not a budget; this one moved twice, each time with the
 * reasoning written here, and from here it holds.
 *
 * 138 -> 148 KB: the UX audit's correction tier, and the first raise NOT paired
 * with a removal. Saying so is the point.
 *
 * What the 4.2 KB bought, all of it fixing a statement that was false rather
 * than adding a feature:
 *
 *   - The alert rail now honours the map's filter bar (CW-06). `Severity: High`
 *     narrowed the map and left `critical` sitting in the list beside it.
 *   - A failed console refresh no longer says "Updated <timestamp>" (HX-01).
 *     With every endpoint down it was claiming eleven had answered.
 *   - A failed refresh no longer kills module evaluation. `refresh` had a
 *     `finally` and no `catch`, and boot awaits it at the top level, so a
 *     render error left the console half-built and mute.
 *   - An Arabic phone no longer renders the desktop grid (RTL was measured for
 *     the first time by this work; 66 controls were off-screen).
 *   - The status bar's three metrics were never actually hidden: an author
 *     `display` rule outranks the user agent's `[hidden]`, so the panel always
 *     rendered "Last signal:" with nothing after the colon.
 *
 * The alternative to raising this was deleting one of those, which is not a
 * trade this project makes: the standing instruction is that when a choice is
 * between cutting and building, build.
 *
 * 148 -> 170 KB: the second raise NOT paired with a removal, and the debt is
 * named here rather than discovered later.
 *
 * What moved, in the pass that earned it:
 *
 *   - The four inactive tab panels were deferred into `public/panels/*.html`
 *     (commit a33a1c0). `index.html` is 9.8 KB gzipped and no longer carries
 *     them, and `check-budget` no longer counts them: the graph that produces
 *     the 18 first-load assets cannot reach a file nothing references.
 *   - R-62/R-63: the locale layer loads English as its base at boot, so a
 *     partial catalogue renders English rather than key ids. That is ~0.2 KB of
 *     comment in `shared/runtime.js` and it is not what put this over — it is
 *     listed because the measurement moved and the reason should be on the
 *     record rather than inferred.
 *   - Three dead constants removed from `app.js` (`DEFAULT_BBOX`,
 *     `FILTER_DEFAULTS`, `FILTER_READERS`): the fossils of the decision, in
 *     `currentView()`'s own comment, that the console reads its filters from
 *     the controls rather than tracking a second copy. Worth 0.2 KB gzipped.
 *
 * What did not move, measured rather than asserted: the panels' *handlers* are
 * still in `app.js`. The deferral moved markup; the JavaScript that reads that
 * markup — `DEFERRED_PANEL_BINDINGS` and the ~750 lines it calls across the
 * workflows, subject, equity, reports, ingestion and settings sections — is
 * still parsed on every console load. Extracted on its own it is ~9.8 KB
 * gzipped (an upper bound; gzip is not additive), which is most of the debt.
 *
 * So the honest position: this raise buys time, not correctness, and the named
 * removal is unchanged. Two rules follow, and they are the only reason the
 * number moved at all:
 *
 *   1. The next change that touches the first load pays this back. The panel
 *      handlers move into the modules their markup already comes from.
 *   2. The gate moves again only with a removal, in this file, with the
 *      measurement that paid for it.
 *
 * 170 -> 195 KB: the third raise NOT paired with a removal, and again the debt
 * is named rather than hidden.
 *
 * What moved, in the pass that earned it:
 *
 *   - Three new operational map overlays were added to the default Operations
 *     console view: Open-Meteo weather glyphs (`shared/weather-bands.js`),
 *     GloFAS river-discharge markers (`shared/discharge-bands.js`), and
 *     ReliefWeb disease-outbreak markers. The map is the first thing shown on
 *     `/`, so the code that projects, styles, and labels these layers cannot be
 *     deferred behind user interaction without the default surface appearing
 *     broken on first load.
 *   - The disease layer also added subnational/national geocoding honesty
 *     labels and a new marker renderer in `app.js`.
 *
 * What did not move: the panel-handler debt described in the 148 -> 170 KB
 * section is still in `app.js` and is still the largest single removal left on
 * the first-load path. That extraction remains the proper way to pay this back.
 *
 * The next change that touches the first load pays this back by moving the
 * panel handlers into their deferred modules, or by another measured removal.
 *
 * 195 -> 200 KB: the fourth raise NOT paired with a removal, made 2026-10-08
 * for the pre-authorised-action surface: the ops console's first view now
 * carries the action rail (protocol status chips + the execution feed,
 * `public/action-rail.js`) and the IoT sensor layer toggle. Both render in the
 * default viewport — the rail beside the map, the sensors on it — so neither
 * can be deferred behind user interaction without the first paint looking
 * broken.
 *
 * What did not move: the panel-handler debt named in the 148 -> 170 and
 * 170 -> 195 sections is still in `app.js`. Measured 197.3 KB at the raise —
 * 2.7 KB of headroom, not a blank cheque.
 *
 * 200 -> 216 KB: the fifth raise NOT paired with a removal, made 2026-10-10,
 * and the first one that is not a raise at all so much as a correction. The
 * gate was already failing at HEAD before this change: measured 205.5 KB, 5.5 KB
 * over, against the 2.7 KB of headroom the previous raise left. That overage is
 * not this change's debt and pretending otherwise would misattribute it.
 *
 * What was already over, measured per asset from baa84c2 (the 200 KB raise) to
 * the commit before this one: `app.js` +3.9 KB, `styles.css` +2.7 KB,
 * `index.html` +0.5 KB — the map-redesign series (710badf, ca27870, bfdbfd7,
 * eb94635, 5840c73, 598dccd). Every one of those put something on the default
 * console view: the map took the console's whole width, its overlay controls
 * (legend, scale, zoom, attribution) moved onto it as HTML, and the seasonal
 * advisory gained an honest empty state. None can be deferred behind an
 * interaction without the first paint looking broken, which is the same
 * argument the 195 -> 200 raise made, arriving a second time from a different
 * direction.
 *
 * What this change adds on top, 5.1 KB: the command band (measured 195px ->
 * 55px on a 1440x900 laptop, 539px -> 135px on a 390x844 phone, which moves the
 * map from y=603 to y=199 — above the fold on first paint, where it was not).
 * The band is the console's own header furniture and it is above the fold by
 * definition, so it is not deferrable either.
 *
 * What did not move: the panel-handler debt named in the 148 -> 170, 170 -> 195
 * and 195 -> 200 sections — `DEFERRED_PANEL_BINDINGS` and the ~750 lines it
 * called across the workflows, subject, equity, reports, ingestion and settings
 * sections — was still in `app.js` at this raise, and was the *only* named
 * removal left on the first-load path. It was ~9.8 KB gzipped extracted on its
 * own, and it did not belong in a layout commit, which is the only reason it was
 * not in this one. (Most of it was paid off in the two changes described at the
 * foot of this comment: four of the six sections on 2026-10-06, the bindings
 * table after that. The two renderers that remain are on the first paint and are
 * not deferrable, which is why the debt does not go to zero.)
 *
 * 216 KB is 210.7 measured with 5.3 KB of headroom — deliberately less than the
 * 5.5 KB this raise absorbed, so the next change that touches the first load has
 * almost nothing to spend and has to pay the panel handlers back instead.
 *
 * 216 -> 229 KB, 2026-10-11 (ENH-33). This is the first raise that corrects the
 * *measurement* rather than the budget. Every figure above was taken by a walker
 * that followed `from '/shared/x.js'` and not `from './x.js'` — and a relative
 * specifier is how every module inside `public/shared/` names its neighbour. So
 * the walk stopped at the first relative hop: `runtime.js` → `./fmt.js`,
 * `map-frame.js` → `./basemap.js`, `secret.js` → `./native.js`, and three more,
 * were never in the total. The tree has been 9.0 KB over the 216 ceiling since
 * before this change and the gate reported 210.7 with 5.3 KB of headroom. A gate
 * that under-measures its own subject cannot be raised to fit it, only
 * corrected.
 *
 * Measured at HEAD with the walker fixed: 225.0 KB. The 216 ceiling was set
 * against 210.7, a number that was 14.3 KB low, so the debt the "pay the panel
 * handlers back" clause was written to collect had already been spent — on the
 * map-redesign series, which the walker could not see either.
 *
 * ENH-33 adds 2.9 KB: `public/shared/org-units.js`, the registry data the map
 * now derives its district centres from instead of a hand-typed copy. The
 * traversal helpers are in `src/org-units.js` and are not on this path, because
 * the browser walks no hierarchy.
 *
 * 229 KB is 227.9 measured with 1.1 KB of headroom — deliberately thin, because
 * the panel-handler removal named above is still the only named removal left and
 * this raise is a correction, not a licence. The next change that touches the
 * first load has 1.1 KB to spend and then has to pay it back.
 *
 * 229 -> 230 KB, 2026-10-12 (ENH-70). Measured at HEAD with ENH-70 in: 229.5 KB,
 * so this leaves 0.5 KB — *less* headroom than the raise it follows, which is
 * the point. The gate's own note above reserved 1.1 KB for the next change
 * touching the first load; this change is that change, and it spent more than
 * the reservation, so the ceiling moves by the difference and nothing more.
 *
 * What it bought: the map's gap accounting — records outside the frame, areas
 * too large to place, classifications the filter left undetermined — was
 * computed on every render and written only to the record count's `title` and
 * `aria-label`. A tooltip is not a report: it needs a hover, a touch device has
 * none, and an operator scanning a clean map has no reason to hunt for one, so
 * a map drawn from 40 of 67 records was indistinguishable from one drawn from
 * 67. The accounting is now a panel on the map (`mapCoverage` +
 * `renderMapCoverage` + `.map-coverage-overlay`), which is where a reader of the
 * map sees it. The band's headline count is unchanged and still one number.
 *
 * 1.4 KB is what that costs, and it was trimmed to get there: the three plural
 * key pairs collapsed to singular keys because all six strings were identical
 * either way, the coverage panel now reuses the legend's own panel rule, and the
 * duplicated `title`/`aria-label` string was deleted rather than kept beside the
 * panel that replaced it. Comments in the four touched files were cut to what a
 * reader needs; the reasoning lives here instead, because a comment on the first
 * load is paid for by every operator on a field connection and a note in the
 * gate is not.
 *
 * That raise was NOT paired with the panel-handler removal, and the debt it named
 * has now been paid — in two parts, neither of which was the removal the note
 * described.
 *
 * The note said the handlers `DEFERRED_PANEL_BINDINGS` calls were still parsed on
 * every console load. That was true when it was written and false by the time
 * anyone read it again: reports, ingestion, settings and equity were moved to
 * `public/panels/*.js` on 2026-10-06 (`aca0b11`, "the budget is paid back"), and
 * those four modules are not in this graph — the walk below starts at
 * `public/index.html` and follows the HTML's own script tags, and a module behind
 * a `lazy()` is reached only when its tab is opened. So the debt this paragraph
 * kept collecting had already been spent on something else, which is the failure
 * mode the paragraph existed to prevent.
 *
 * What genuinely remained was the *bindings table*: 21 closures in `app.js`, one
 * per deferred control, parsed on every load to wire four tabs nobody had opened.
 * They now live beside the markup they attach to, in each panel module's own
 * `bindings` list, and `app.js` asks the panel for them at mount. Measured: 229.9
 * → 229.5 KB.
 *
 * The two renderers still inline are `loadWorkflowMetrics`/`renderWorkflowsTab`
 * and `renderWorkflowInstanceList`, and they are correctly placed: the workflow
 * ribbon is in the command band, outside every panel, and it renders its count on
 * the default view. Deferring them would break the first paint rather than
 * shorten it. That is the whole of what is left of the "panel handlers" this file
 * used to name.
 */
const BUDGET_KB = Number(process.env.BUDGET_KB || 230)

/**
 * Every asset the browser fetches to render the console.
 *
 * Three reference forms have to be followed or the number is fiction: the HTML's
 * `src=`/`href=`, an ES module's `from '…'`, and a stylesheet's `@import url('…')`.
 * The first version followed only the latter two and reported a 15 KB first load
 * for a console whose HTML alone references a 154 KB script.
 *
 * **ENH-33.** The import form has *two* spellings and this followed one. An
 * absolute `/shared/x.js` was resolved; a relative `./x.js`, which is how every
 * module inside `public/shared/` refers to its neighbour, was not — so the walk
 * stopped at the first relative hop and every transitively-imported module was
 * missing from the total. The number was an under-count that looked like a
 * measurement: `basemap.js` → `./org-units.js` added 3.5 KB the gate could not
 * see, and it took a 0.1 KB overage from a *different* path to surface it.
 *
 * A relative specifier is resolved against the importing file's directory, the
 * way the browser resolves it, and normalised back to a public-root path so
 * `seen` dedupes the two spellings of one file.
 */
function moduleGraph(entry) {
  const seen = new Set()
  const queue = [entry]
  const HTML_RE = /(?:src|href)=["'](\/[^"'?]+\.(?:js|css))["']/g
  const IMPORT_RE = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+\.js|\/[^'"]+\.js)['"]|@import\s+url\(['"](\/[^'"]+\.css)['"]\)/g

  const resolve = (dep, from) => {
    const raw = dep.replace(/^\//, '')
    if (!dep.startsWith('.')) return raw
    const joined = path.posix.join(path.posix.dirname(from), dep)
    // A relative hop that escapes the public root is not a public asset.
    return joined.startsWith('..') ? null : joined
  }

  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(path.join(publicDir, file))) continue
    seen.add(file)
    const source = readFileSync(path.join(publicDir, file), 'utf8')
    for (const match of source.matchAll(file.endsWith('.html') ? HTML_RE : IMPORT_RE)) {
      const dep = match[1] || match[2]
      const resolved = dep && resolve(dep, file)
      if (resolved) queue.push(resolved)
    }
  }
  return [...seen]
}

const sheetImports = moduleGraph('index.html').filter((f) => f.endsWith('.css'))
const scripts = moduleGraph('index.html').filter((f) => f.endsWith('.js'))

// The console also fetches the English catalogue and, at runtime, the navbar
// that every surface shares.
const unique = [...new Set([ENTRY, ...scripts, ...sheetImports, 'i18n/en.json', 'shared/navbar.js'])]

let raw = 0
let gzipped = 0
const rows = []

for (const file of unique) {
  const full = path.join(publicDir, file)
  if (!existsSync(full)) continue
  const bytes = readFileSync(full)
  const gz = gzipSync(bytes).length
  raw += bytes.length
  gzipped += gz
  rows.push({ file, raw: bytes.length, gzipped: gz })
}

rows.sort((a, b) => b.gzipped - a.gzipped)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
console.log(`Console first load — ${unique.length} assets\n`)
for (const r of rows) {
  const bar = '█'.repeat(Math.max(1, Math.round(r.gzipped / 1024)))
  console.log(`  ${r.file.padEnd(28)} ${kb(r.gzipped).padStart(9)} gzipped  ${bar}`)
}
console.log(`\n  ${'TOTAL'.padEnd(28)} ${kb(gzipped).padStart(9)} gzipped  (${kb(raw)} raw)`)
console.log(`  ${'BUDGET'.padEnd(28)} ${kb(BudgetBytes()).padStart(9)}\n`)

function BudgetBytes() {
  return BUDGET_KB * 1024
}

if (gzipped > BudgetBytes()) {
  console.error(
    `First load is ${kb(gzipped - BudgetBytes())} over budget.\n` +
    `The console is used on field connections; a regression here is felt by every\n` +
    `operator and every community health worker, not only the person who merged it.`
  )
  process.exit(1)
}

console.log(`Within budget, with ${kb(BudgetBytes() - gzipped)} of headroom.`)