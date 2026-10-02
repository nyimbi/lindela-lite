# Demo audit, 2026-10-02

A claim-by-claim audit of what a UNICEF Venture Fund panel would see, run against
a live seeded store and a screenshot of the running dashboard. Recorded because
the pattern matters more than the individual fixes: **almost every defect found
here looked entirely correct.**

Every item below was confirmed by reverting the fix and watching the relevant
check fail. Commit hashes are the fixes.

## How the defects were found

Three methods, in increasing order of yield:

1. **Comparing a documented number against the seeded store.** Found four false
   claims in the demo guide and three in the README.
2. **Screenshotting the dashboard.** Found four defects that every DOM assertion
   passed, because the content was present in the document and absent from the
   screen.
3. **Comparing a computed value against its own output.** Found the payload-hash
   bug, which is the most consequential of the lot and was invisible to every
   check in the suite.
4. **Extracting the artefact.** Reading the text out of the quarterly PDF found a
   headline KPI mislabelled against a UNICEF bid target. Every dashboard check
   passed, because the label is correct on the screen and wrong in the document
   that leaves the building.
5. **Extracting the other artefacts.** The quarterly PDF found a mislabelled KPI
   against a UNICEF bid target; the CAP feed — the format external alerting
   systems consume — turned out to be placeholder text with every alert placed at
   Null Island. Both are valid documents. Neither was wrong in any field a
   dashboard check would read.
6. **Reading the report artefacts.** Opening a report marked `distributed` gave a
   title and four metadata lines; its SMS summary claimed zero incidents and zero
   alerts. The fix that made reports non-empty then exposed the scope bug — the
   regenerated Turkana SITREP reported all 280 events in the store, which is the
   global total, not Turkana's. An absent document and a wrongly-scoped document
   are the same failure wearing different clothes.
7. **Using the feature.** Walking a surface end to end found the scenario
   workbench was entirely dead and the offline queue never replayed. Neither
   produced a console error, because both caught their own failures and printed
   them as text — the one class of breakage that is invisible to every assertion
   that checks for errors.

Method 3 was only reached because a visible number disagreed with the code that
produced it. Two green suites had been passing for the wrong reason.

## Defects found and fixed

| # | Defect | Found by | Fix |
|---|---|---|---|
| 1 | `.hazard-landslide` declared in CSS, never applied. Landslides drew as generic markers and were absent from the legend, despite road-access modelling them differently from flood. | code read | `20eff5d` |
| 2 | The map fetched `?limit=50` by recency, so the seeded flood and landslide were paged out and never drawn. The operational area looked hazard-free while the map showed 33 Pacific earthquakes. | screenshot | `20eff5d` |
| 3 | `?bbox=` matched on point only, so an event reported by the source as an *area* was excluded from every bbox query — exactly the regional GDACS events the connector deliberately leaves point-less. | code read | `20eff5d` |
| 4 | Seeded landslide placed 16 km from the nearest road (blocked nothing), then 12 km from the seeded flood (two hazards under two pixels apart). | screenshot | `6c9bdd8` |
| 5 | The map rendered at 195×122 on a 1440×900 laptop with 2.4px legend text, because the SVG shares a flex column with every panel below it. | screenshot | `26f775f` |
| 6 | Flood status read "40.38% of the area", which invites reading 40% of Turkana as underwater. | screenshot | `26f775f` |
| 7 | Planning a route did not frame the map on it, so the reroute — the point of the feature — was an unreadable cluster. | screenshot | `54fb0d8` |
| 8 | The equity table overflowed the 360px rail behind `overflow-x: hidden`, clipping "Not acknowledged" — the column that says who was not reached. | screenshot | `2e607a4` |
| 9 | The browser check inherited headless Chrome's 756×469 default: the mobile breakpoint. Every layout assertion ran against a layout no panel will see. | investigating a fix that appeared not to work | `2e607a4` |
| 10 | Build version drifted across four copies, including one in a translation file, while package.json said 0.2.0. | screenshot, then DOM | `a970e17` |
| 11 | README listed 8 of 11 sources and claimed report distribution was absent — a capability the app has. | doc read | `53a7ce7` |
| 12 | OpenAPI contract covered 63 of 89 endpoints; equity, parametric rules, webhooks, KPI, lineage, scenarios and CHW routes were missing. 26 real, reachable endpoints. | doc read | `493a743` |
| 13 | `canonicalHash` was blind to metadata, so no connector metadata correction could ever reach stored data. | a UI number disagreeing with its own computation | `393ec55` |
| 14 | A CHW field report with no GPS fix was stored at (0, 0) — Null Island. The client used (0, 0) as its "no location" sentinel and the server wrote `latitude || 0`. | walking the CHW wizard on a phone | `cf0dfeb` |
| 15 | The offline queue never replayed. `lindelaQueue.flush()` was called from nowhere, so a report queued without signal sat in IndexedDB while the UI promised it would send. | the same walk, offline | see changelog |
| 16 | The CHW app offered nine languages and had CHW strings for three, so a health worker read `chw.symptom_fever` as a button label. | reading the rendered text | see changelog |
| 17 | `loadLocale` replaced the catalogue, so a partially translated locale printed raw keys — and the equity table overflowed its rail again, because a key name is longer than a word. | checking a fix that appeared to regress | see changelog |
| 18 | The offline queue never replayed — `flush()` was called from nowhere, so a report queued without signal was lost while the UI promised it would send. | walking the CHW flow offline | see changelog |
| 19 | OFAC sanctions screening worked but the UI never sent the field that reaches it, and never mentioned screening. A green "Simulation complete" for 5,000 USD implied a check that had not run. | walking the parametric surface | see changelog |
| 20 | The CO dashboard's "false alert rate" was a regex over free-text notes divided by all alerts: 0%, meaning nothing. | asking what the headline KPI measured | see changelog |
| 21 | The scenario workbench did not run at all: `json.data` on a top-level response, then a `null` element id. Errors were caught and shown as text, so every check passed. | exercising the last unexamined surface | `see changelog` |
| 22 | Scenario deltas labelled "(mean %)" and coloured red, from an uncalibrated score. Every asset showed a fabricated +75 change because no baseline was ever attached. | reading the rendered result | see changelog |
| 23 | "Warning-to-action median" was the platform's own SMS dispatch latency, labelled against the UNICEF <24h bid target — 0.16 h next to a humanitarian outcome the system never measures. | extracting text from the quarterly PDF | see changelog |
| 24 | The CAP alert feed was placeholder text with a 50 km circle at (0,0) for every alert, because it read fields alert events do not carry. Valid XML, wrong location. | extracting the interchange artefact | `see changelog` |
| 25 | Every report was an empty document — `section_ids` set, `sections` empty — so exports had no content and SMS summaries announced "0 incidents, 0 open alerts". Two were marked `distributed`. | opening a distributed report | `see changelog` |
| 26 | `filterRecords` ignores unknown parameters, so a `district`-scoped report applied no filter at all: the Turkana SITREP reported all 280 hazard events from 50+ countries as district figures. | comparing report scope against the store | `see changelog` |
| 27 | The same ignored-parameter behaviour on the API: `?district=Bor` returned every incident in the collection, identical to sending no filter at all. | querying the list endpoints directly | `see changelog` |

## Two green suites passing for the wrong reason

Worth separating out, because a passing check is evidence about the *check*, not
about the code.

**The browser suite ran at the wrong viewport** (#9). 756×469 is the mobile
breakpoint: single column, full-width rail. A table too wide for a 360px rail
passes there because there is nothing to overflow. This is why #8 survived. It
surfaced only when I tried to reproduce #8 to validate a new check, and the
reproduction kept failing — the honest signal was that my *diagnosis* was wrong,
not the check.

**The shared-module contract test could not see `export async function`.** No
shared module used one, so the gap had never fired. It surfaced when a new module
did.

## The payload-hash defect (#13)

The most consequential, and worth reading the code for.

```js
// before
JSON.stringify(filtered, Object.keys(filtered).sort())
```

`JSON.stringify`'s second argument is a property **allowlist applied at every
level of nesting**. `metadata` survived as a key with every key inside it
stripped, so a record's hash was:

```json
{"metadata":{},"source":"noaa_enso","source_id":"2026-08","value":2.17}
```

regardless of its contents. `mergeById` skips an incoming record whose hash
already exists, so any change confined to metadata was discarded on every
re-ingest, for every source, permanently.

Connector metadata is where the qualifications live: `model_limit`,
`episode_declared`, `geolocation_note`, `index_note`. The one class of change
that must be able to propagate was the one that could not — so a disclaimer fixed
in code and a disclaimer shown to a user could silently disagree forever.

Found because the seasonal strip read "0 of 5 overlapping seasons" while
`classifyNino34` computed 3 on the live feed and the connector emitted 3.

## Standing constraints, as verified

| Constraint | Evidence |
|---|---|
| Gates green | 289 tests, 82.15% lines / 68.19% branches, 78/78 browser checks, `validate ok`, model-boundary guard ok |
| Model limits in the payload | flood-depth `model`: "static water-surface elevation; no flow routing or storage modelled"; ENSO `model_limit`: "monthly SST anomaly index; not a rainfall forecast and not a flood probability" |
| Unavailable sources stated, not substituted | live check: 5 ok, glofas and FIRMS errored with the cause named in the UI |
| No invented flood coefficients | `check:model-boundaries` scans `src`, `public`, `scripts`, `test`, `docs`, README, CHANGELOG and the contract, matching identifiers and prose |
| Small verified commits | 13 commits this session, each gated and pushed |

## Still gated

**Rainfall intensity/duration to flood probability** — proposal and evidence in
`flood-probability-model-basis.md`; recommendation is observed-record context
only. `AGREED_MODEL_BASIS` remains `null` and the guard enforces it.

**Outbreak and food-security tracking** — scoping in
`outbreak-and-food-security-scoping.md`. Requires UNICEF policy approval and an
IPC/FSIN licence. No connector written.

## What to check first in a panel

Screenshot first. Four of the thirteen defects were invisible to every automated
assertion because the content was in the document and absent from the screen.