# Changelog

## Unreleased

Flood, access-risk, seasonal-signal, food-security, and outbreak-context capability.
All additions are additive; no existing endpoint changed shape.

### Added

- `GET /api/v1/flood-depth`. Static inundation from an operator-supplied water
  surface elevation, using keyless AWS Terrarium (SRTM) terrain — no API key and
  no data licence to obtain. Returns point depth, a level profile, an area grid,
  `extent_geojson`, and terrain context.
- `GET /api/v1/road-access` and `/api/v1/road-access/summary`. Flood and landslide
  events matched against road segments by bounding box rather than centre
  distance, so a large hazard polygon cuts the roads it actually contains. Reports
  passable / restricted / impassable with reasons.
- `POST /api/v1/routing/plan`. Dijkstra over imported road assets, returning the
  route, severed-segment diagnostics, and restricted-route penalties. Separates
  foot and vehicle classification, and reports infeasibility rather than returning
  a straight line.
- Flood-depth and road-status overlays on the operations map, with depth-banded
  shading and a legend. The water level is an operator input, not a forecast; the
  UI labels it a simulation.
- `noaa_enso` connector. NOAA CPC **monthly** Niño 3.4 SST anomaly from a keyless
  fixed-width ASCII feed, verified live on 2026-10-01. The overlapping three-month
  means are derived from it and are what the CPC episode rule is applied to. The
  monthly value is reported as a monthly anomaly and is **not** labelled the ONI,
  which is by definition the three-month running mean of those numbers. Emits
  `climate_observations` with coordinates deliberately null, because a
  basin-wide Pacific index must not be attributed to a district by proximity.
- `ipc_hdx` connector → `food_security_records`, plus `GET /api/v1/food-security`
  and `/api/v1/food-security/summary`. IPC Acute Food Insecurity classifications
  (phases 1-5 and the Phase 3+ aggregate, national and subnational) via the
  Humanitarian Data Exchange — keyless, CC0 / public domain, verified live
  2026-10-02. This supersedes the scoping conclusion that IPC needed a FAO/WFP
  licence: the HDX channel carries the same classifications, subnational, with
  no licence needed. Records are grouped one per area and validity window with
  every phase's published figure, relayed verbatim and never re-derived. The
  source `Percentage` column is a fraction of the analysed population (0.2 means
  20%), stated on every record. Geometry is bounding boxes only, joined from
  per-country GeoJSON where the area name matched; coordinates stay null. The
  summary rolls up the latest `current` window per country and the ten worst
  areas by Phase 3+ fraction. Default ingestion scope: all Sub-Saharan Africa.
- `who_gho` connector → `disease_observations`, plus
  `GET /api/v1/disease-observations`. WHO Global Health Observatory
  outbreak-relevant indicators (cholera cases/deaths/CFR, meningitis cases and
  epidemic districts, measles, yellow fever, plague) from keyless OData,
  verified live 2026-10-02. URL construction omits `$filter`, `$orderby`, and
  `$top` deliberately, after probing that the endpoint silently empties or
  ignores each of them — the full series is fetched and windowed in-process,
  where the failure mode is visible. National-annual aggregates only, with
  `coordinates: null` and a policy note per record (decision-support context
  with attribution; not district evidence; not an alert trigger), because
  outbreak figures can move funding flows and stigmatise areas. The summary
  marks each indicator series `current`/`aging`/`stale` against the calendar:
  a series that stopped publishing (cholera ends 2016, verified) is labelled,
  not hidden.
- IPC area bbox overlay and food-security/outbreak surfaces on the dashboard.

Flood probability, on an agreed empirical basis (the operator's directive:
implement the most functional defensible option, never invented coefficients):

- `open_meteo_archive` connector → `climate_observations`: one record per pilot
  district carrying the whole ERA5 daily precipitation series (1981 onward)
  from the keyless Open-Meteo archive, verified live 2026-10-02. Null days
  stay null; the record states that this is reanalysis, not gauge data, at a
  single point.
- `gdacs_archive` connector → `hazard_events`: GDACS historical floods (1985
  onward, Sub-Saharan Africa) via quarter-by-quarter archive walk, verified
  live. The upstream `eventtype` filter is accepted and ignored, so floods are
  filtered in-process; flood `severitydata` is a fill-in zero upstream and is
  stored as null. Both connectors run on demand (`regular: false`) so a
  default ingestion run never issues a 40-year crawl.
- `open_meteo_flood` connector → `climate_observations`: GloFAS v4 modelled
  daily river discharge per pilot district with a river reach, verified live
  2026-10-02 (Turkana non-null from 1997; Mogadishu/Juba have no reach and
  are refused as errors). `regular: false` backfill like the others.
- Discharge label variant for training: `POST
  /api/v1/flood-probability/train` accepts `label_source: 'glofas_discharge'`,
  labelling months where GloFAS discharge at the district's river cell is
  above its 95th-percentile of monthly maxima. The label percentile is a
  fixed definition, not a fitted parameter; the model card carries a
  `label_caveat` stating that the label is model-conditioned hydrology and
  the fit measures anticipation skill.
- `src/flood-probability.js` + `POST /api/v1/flood-probability/train` and
  `GET /api/v1/flood-probability/score`. Empirical rainfall–flood
  co-occurrence: month-grain contingency counts (Wilson intervals, lift over
  base rate) plus an L2-regularised logistic fit (full-matrix Newton with
  step-halving on collinear standardized rainfall features), validated
  leave-one-year-out (Brier vs always-base-rate skill). Hard refusals are part
  of the model: under 60 valid months, under 5 flood months, or all-one-class
  data return no probability. Every model and score carries its basis, sample
  counts, and the reporting condition — the label is *GDACS-reported*, so the
  probability is for a flood entering the archive, not for water reaching a
  given elevation. Basis and the rejected MERIT-Hydro/GEV route are documented
  in `docs/flood-probability-model-basis.md` (Status: agreed and implemented).
- Trained-model strip on the dashboard: per district, the base rate/skill card
  or the refusal text — a district with 34 months shows why it has no model.
- `docs/flood-probability-model-basis.md` rewritten from proposal to the
  implemented record; the validator's status check updated in the same change.
- `docs/outbreak-and-food-security-scoping.md` amended 2026-10-02: its "no
  keyless IPC feed" conclusion never checked HDX; the original verification
  record is kept, with the supersession stated.

### Known limitations

- Flood depth is a static water-surface calculation: **no flow routing, channel
  geometry, or storage is modelled.** A water surface at *L* shades everything
  below *L* that is hydraulically connected, which in reality is only some of it —
  a closed basin below *L* does not become a lake. Every response carries this
  statement and the vertical resolution (±15 m, inherited from SRTM) so a caller
  can judge whether the question is answerable at their margin.
- ENSO output is **advisory strength, not a declared event.** CPC declares an
  episode only after ±0.5 °C holds for five consecutive overlapping three-month
  seasons; the connector reports how many consecutive seasons currently qualify
  and never asserts an episode from fewer.
- The ENSO connector reads the **ONI**. Per NWS Public Information Statement
  26-05, CPC now uses RONI for official ENSO monitoring, but RONI is not published
  as a stable keyless monthly feed, so reading ONI and labelling it RONI would be
  a fabricated capability. Recorded in each record's `index_used` and `index_note`.
- Rainfall intensity and duration to flood probability now **is** implemented,
  but only as the **empirical co-occurrence model** agreed in
  `docs/flood-probability-model-basis.md`, with hard sample-size refusals and
  reporting-conditioned labels. It is not a hydrological model: no return
  periods, no depth, no water-surface mapping. The Merit-Hydro/GEV route that
  would produce those remains blocked (MERIT unreachable and EULA-gated; no
  validated 36-year gauge discharge for the pilot basins).
- Landslide clearance is a **fixed 5 km radius** around the reported location,
  not a run-out model. It is a screening radius chosen to reflect that debris
  travels further than standing water, not a slope-stability or volume estimate.
  Treat it as "this road needs checking", not "this road is safe".

### Fixed

- **The flood risk model was scoring against an invented uncertainty band.**
  The Open-Meteo connector reads a *deterministic* forecast and has no ensemble
  members to report. It used to manufacture them: a spread of
  `0.25 + (1 - probability/100) * 0.75` was applied to the single point value to
  produce `p10`/`p50`/`p90`, published under exactly the field names a real
  probabilistic forecast uses. At a reported probability of 10% that made `p90`
  about **1.9x the observed precipitation**.

  The risk scorer preferred `ensemble_p90` over the point value, so every flood
  score was computed against an inflated number before being multiplied by
  `precipitation * 1.5`. 82 of 130 climate observations carried a synthesized
  band and 8 of 16 risk scores reported `ensemble_used`. Invented uncertainty is
  worse than none: it is indistinguishable from a calibrated ensemble downstream
  and it moves a number someone dispatches resources on.

  The connector no longer produces percentiles. Each observation states
  `model_limit: "Deterministic point forecast only; no ensemble members are
  produced."` and carries null percentiles. The scorer only prefers a percentile
  when `ensemble_source` identifies a genuine probabilistic forecast, and
  `drivers.ensemble_used` can no longer be raised by a synthesized value.
  GloFAS, which carries neither an extent nor an ensemble, published
  `ensemble_p10/p50/p90` of `0` — a certain forecast of zero rather than the
  absence of one; those are now null with their own stated limit.

- **233 of 280 hazard events were published to STAC at Null Island.** The STAC and
  OGC Features catalogues are what GIS tooling loads — QGIS, Earth Engine,
  planetary-computing clients — and `stacItem` guarded its coordinates with
  `Number.isFinite(Number(record.latitude))`. `Number(null)` is `0`, so every
  record that explicitly had *no* location passed the guard and was published with
  `geometry: Point [0, 0]` and `bbox: [0,0,0,0]`. 233 hazard events carry
  `latitude: null`; each was placed in the Gulf of Guinea. A FIRMS forest-fire
  notification for Indonesia with no coordinates became a point at 0,0.

  Coordinates are now read through a helper that treats null, blank and
  whitespace-only values as absent, the same way `toNumber` does after the
  field-report fix. A location-less record is published with `geometry: null`,
  `bbox: null`, `location_basis: "none"` and a `location_status` saying the source
  reported no coordinates — STAC permits a null geometry, and an honest absent one
  beats an invented point. Real points carry `location_basis: "point"` so a client
  can tell a measured position from a derived one.

  `computeBbox` returned `[0, 0, 1, 1]` for a collection with no coordinates —
  an extent in the Gulf of Guinea that no record occupied. The `spatial` extent
  key is now omitted rather than filled in.

- **District filtering reported no activity for collections that carry no
  location.** Interventions, their tasks and alert dispatches have no
  coordinates and no district field. Filtered directly they matched nothing, so
  `?district=Bor` returned 0 interventions while `/api/v1/districts/Bor` reported
  3 — the same district, two different answers, depending on the endpoint. A
  partner building a district view would have shown partners and responders an
  empty list next to a populated summary.

  They are now attributed through the record that does carry a location:
  interventions through their incident, tasks through the intervention, dispatches
  through the alert event. Every filterable list endpoint now agrees with the
  district overview it sits beside — Bor returns 2 incidents, 3 interventions, 5
  tasks, 6 service assets, 3 flood-risk and 3 conflict-risk scores, 10 field
  reports and 3 alerts, matching `/api/v1/districts/Bor` exactly. Note that
  `/risk-scores` is a STAC/OGC catalogue rather than a filterable list; the
  filterable risk endpoints are `/flood-risk` and `/conflict-risk`.

- **`?district=` on every list endpoint was a no-op that returned everything.**
  `filterRecords` ignores parameters it does not understand, and `district` and
  `region` were not among the ones it understood. `GET /api/v1/incidents?district=Bor`
  was byte-for-byte the same as no filter: all 8 records, including Aweil and
  Turkana. A caller that asked to be scoped to one district received every
  district's data with nothing to indicate the filter had been dropped.

  Both are now real filters. A record matches on an explicit district label where
  it has one — including multi-value labels such as `"Turkana, Bor"` — and
  otherwise on its position within the district extent. A record with neither is
  not in the district, which is the same rule report scoping uses, so the API and
  a report cannot disagree about what is in Turkana. A misspelt district now
  returns nothing rather than everything.

  This was the API half of the report scoping bug, still live after the report
  fix: the reports now count Bor's 2 incidents and Turkana's 3, and the endpoints
  return the same 2 and 3.

- **Every report was an empty document, and every district report contained the
  whole store.** `scripts/seed-demo.mjs` built reports with `normalizeReport`
  alone, which sets `section_ids` from the template and leaves `sections` empty.
  All six demo reports therefore rendered as a title and four metadata lines with
  no summary, no figures and no findings; their CSV and GeoJSON provenance
  appendix exported zero records; and `formatReportSmsSummary` found no metrics to
  read, so every SMS read *"0 incidents, 0 open alerts"* — a positive claim that a
  district was quiet, sent to the people meant to act on it. Two of these were
  marked `distributed` and one `approved`.

  Reports are now generated before their lifecycle status is applied, so they
  carry sections, source refs and warnings. A report with no sections cannot be
  approved or distributed: `approveReport` already refused, but POST and PATCH set
  `status` through `normalizeReport`, so a client could declare one `distributed`
  with no content and no warnings. The SMS summary now says a report is not
  generated instead of asserting zero, and an empty report renders a visible
  warning that it must not be used as a situation picture.

- **A district-scoped report reported global data as district figures.** `district`
  is not a key `filterRecords` understands, and it ignores unknown parameters
  silently, so a report scoped to `district=Turkana` fell through to *no filtering
  at all*: the Turkana Flood SITREP presented all 280 hazard events in the store —
  Indonesia, Brazil, Australia, Chad — as though they were Turkana's. Most
  collections carry no district label, so a district cannot be read off a record
  the way a country can. A district report now counts only records attributable to
  that district, using the district extent for geo-located records and its label
  otherwise, and reports how many records it excluded and why. Scope keys that are
  not supported filters are named in the report's warnings rather than ignored.

  Making the reports non-empty made this visible: the first regenerated Turkana
  SITREP confidently reported 280 events, which is the global total. It now reports
  what is attributable and states that 490 records carry no location or district
  label. Source freshness could not be assessed for any district either — all nine
  data-quality records are unattributed — and the reports say so instead of
  implying the sources are fine.

- **The CAP alert feed was placeholder content with a fabricated location.** CAP is
  the interchange format external alerting systems, EWS gateways and SMS providers
  consume. The generator read `headline`, `description`, `event_type`,
  `latitude`, `longitude`, `radius_km` and `lead_time_days`; an alert event
  carries none of them, so every field fell through to a default. Every alert
  published as *"Hazard Alert / A hazard alert has been issued"*, every urgency was
  `Immediate`, and the area was emitted as **`<circle>0,0 50</circle>`** — a 50 km
  circle at Null Island in the Gulf of Guinea, for an alert about Bor. It was valid
  XML in the correct namespace, so nothing failed: a downstream system would have
  placed every humanitarian alert this product can produce in open water.

  The feed now carries the real alert: headline and description from the alert's
  own message, the rule and the trigger (`metric value operator threshold`), the
  reviewed outcome where one exists, and a provenance line saying it is not an
  official forecast. The area is resolved from the alert's district to that
  district's real centroid and radius and labelled as a district extent; where no
  district exists no circle is emitted and the feed says the extent is not
  established. Urgency is derived from severity, a resolved alert is published as
  a `Cancel` so downstream systems retire it, and the null-island circle is
  impossible. Verified across all seeded alerts: 0 at (0,0), 0 placeholder texts.

- **"Warning-to-action median" was this platform's own SMS latency, presented
  against an external response-time target.** The figure is the median hours from a dispatch
  matching a signal to that dispatch being sent — how fast our own API enqueued an
  SMS. Warning-to-action in the field-response sense runs from a warning reaching a household to a
  field action being completed and reported, which this system does not observe at
  all. It was labelled "Warning-to-action median", annotated "target: <24h", showed
  0.16 h, and the quarterly PDF printed "warning-to-action < 24h"
  directly beneath the number. Read quickly, that is a system asserting it meets a
  humanitarian outcome target.

  Renamed to "Signal-to-dispatch median" everywhere — payload, dashboard tile,
  trend card, PDF row — with `warning_to_action_measure`,
  `warning_to_action_limit` and `warning_to_action_is_field_outcome: false`. The
  bid target is kept in the PDF as reference, explicitly separated, with a caveat
  that a low value does not mean the response was fast.

  The quarterly figure also carried a silent fallback: when no dispatch had
  `matched_signal_at` it switched to measuring hazard-observed to sent, so the
  same number could quietly change meaning depending on the data, and the monthly
  series had no such fallback. Both paths now use one helper and one interval; where
  the interval is unavailable the figure is null and says so, rather than becoming
  a different measurement under the same name.

- **The scenario workbench did not work at all.** "Run scenario" read `json.data`
  from a response that carries the scenario at the top level, so it threw on every
  run, rendered nothing and left all three delta cards on em dashes. A second
  mismatch — the markup had `impactBars` where the script looked for `impactsBars`
  — threw again partway through rendering and took the affected-assets table with
  it. Nothing caught either: the errors were caught and shown as text, so the page
  reported no console error and every check passed. The surface looked loaded and
  was entirely dead.

- **Scenario deltas were labelled "(mean %)" and coloured red.** They are score
  points, not percentages, and not modelled outcomes: the response carried no unit,
  no method and no limitation, so "+19.13%" read as a prediction that doubling
  rainfall raises flood risk by nineteen percent. The payload now carries `unit`,
  both means, the number of regions compared and a `model_limit`; the cards say
  "score change (mean points)" and the colour is dropped, because a higher
  sensitivity score is not by itself a worse outcome.

- **Every asset in the scenario table showed a fabricated +75 impact change.** The
  API never returned `baseline_impact_score`, and the UI computed
  `scenario - (baseline ?? 0)`. Assessments are now paired with their real baseline
  by asset, so the table reads e.g. "Aweil East Primary, school, Aweil, 48 → 75,
  +27", and rows are ranked by how far the scenario moved them rather than by an
  identical score. Type and Region were reading `asset_type` and `region_name`,
  which impact assessments do not carry, so both columns showed em dashes.

- **The CO dashboard reported a 0% false alert rate that meant nothing.** It was a
  keyword scan of free-text resolution notes (`/false|invalid|noop/i`) divided by
  the alert count. On the demo data that returned 0%, which reads as "no false
  alerts occurred" when it means "nobody wrote the word false" — none of the
  seeded resolutions ("situation stabilised", "temperature normalised") says
  whether the alert was warranted at all. A note reading "not a false alarm: wind
  damage" would have been counted as one.

  Alert events now carry an explicit `false_alert` determination (`true` / `false`
  / `null` for not determined, refusing anything else rather than coercing it to
  `false`). The rate is measured only over determined alerts, is `null` rather than
  `0` when none are, reports the reason as a data gap, and states its denominator
  and method. The seed records one genuine false alarm — an auto-approved heat
  alert that turned out to be a faulty sensor — and leaves one resolution
  deliberately undetermined.

- **The same metric contradicted itself on one screen.** The monthly series kept
  its own copy of the old scan, so the trend card showed a flat 0% while the KPI
  tile above it correctly showed a gap. Both paths now agree.

- **Sparklines filled gaps with zero**, so a month with no recorded outcome drew
  as a flat line sitting on the axis — visually identical to a month in which
  nothing happened. Months without a value are no longer plotted, and a lone
  value is a dot rather than a trend line.

- **Sanctions screening was invisible in the parametric UI.** The screening
  capability worked — a match blocks the disbursement — but the simulate form
  never sent the field that reaches it, so every simulation started from the
  dashboard was unscreened while the result panel showed a green "Simulation
  complete" for a 5,000 USD disbursement and mentioned screening nowhere. A
  reader could reasonably conclude the OFAC check had run. The form now collects a
  recipient name, the result panel states the screening outcome whatever it is,
  and the disbursements table has a screening column.
- `sanctions_screened` was a boolean, which made "nothing was screened because no
  recipient was supplied" and "the SDN list was unreachable" look identical to
  someone deciding whether a disbursement had been checked. It is now
  `sanctions_status`: `clear` or `not_screened`, with a reason on the unscreened
  case so it cannot read as a clean result.
- **Workflow transitions recorded every actor as "anonymous".** The handler read
  `req.__auth?.subject || 'anonymous'` and discarded the actor the caller supplied,
  so on an unauthenticated deployment nobody could tell who approved an
  anticipatory alert. Preferring the verified subject is still correct — a caller
  must not be able to claim an identity — but the claim is now kept and labelled:
  each transition records `actor_source` of `authenticated`, `claimed` or
  `unattributed`, matching the `actor`/`subject` split `actionLog` already used.
- **A CHW field report with no GPS fix was stored at (0, 0) — Null Island.** The
  CHW client used `{latitude: 0, longitude: 0}` as its "no location" sentinel in
  six places, including for the "here" button, so auto-detect and manual were
  indistinguishable whenever the fix failed. The server then wrote
  `body.location?.latitude || 0`, which turned a missing fix, an explicit null and
  a real zero alike into latitude 0, longitude 0. A disease signal that looks
  located while pointing at open water is worse than one with no coordinate:
  cluster detection and any "facilities near this report" join both treat it as
  real. Location is now nullable and self-describing: `location_source` says
  whether a fix was obtained, refused, timed out, or self-reported, and
  `location_accuracy_m` survives when there is one.

- **`toNumber(null)` returned 0.** `Number(null)`, `Number('')` and `Number([])`
  are all 0, so absence coerced to a real zero. Harmless for a threshold;
  not harmless for a coordinate — it meant the CHW fix above reappeared the moment
  anything updated or soft-deleted the report through the operational API, since
  the normaliser read those nulls and wrote 0. Null is now an absence and 0 is a
  value, with numeric strings still coercing.

- **A field report raised through `/api/v1/chw/report` could be listed but never
  updated or withdrawn.** It has no incident linkage by design — a health worker
  reporting a symptom does not know which incident it belongs to — and the
  normaliser re-checked that linkage on every mutation, so DELETE returned 400.
  A duplicate or mistaken disease signal could not be taken back. Linkage is now
  required at creation and not re-required afterwards. `normalizeFieldReport` also
  carries `category`, `status`, `source` and the location fields explicitly rather
  than relying on the store's shallow merge to preserve them.

- The browser check now walks the CHW symptom wizard end to end (82 checks, from
  78) and asserts the created report carries no fabricated coordinate and says how
  its location was determined. It cleans up after itself.

- **Payload hashing ignored record metadata, so connector corrections could never
  reach stored data.** `canonicalHash` passed `Object.keys(record)` as
  `JSON.stringify`'s second argument, which is a property *allowlist applied at
  every nesting level*: `metadata` survived as a key with every key inside it
  stripped, so a record's hash was identical no matter what its metadata said.
  `mergeById` skips an incoming record whose hash already exists, so any change
  confined to metadata was silently discarded on re-ingest. Connector metadata is
  where the qualifications live — `model_limit`, `episode_declared`,
  `geolocation_note`, `index_note` — so the one thing that must be able to change
  was the one thing that could not.

  Found because the seasonal strip reported "0 of 5 overlapping seasons" while
  `classifyNino34` computed 3 on the live feed and the connector emitted it: the
  field had never reached the stored record. Now canonical JSON with keys sorted
  at every depth, stable under reordering at any depth. The strip reads
  "3 of 5 seasons" with three pips filled, matching the computation, and
  `episode_declared` stays false because three is not five.

### Changed

- `?bbox=` now returns events the source reported as an **area** overlapping the
  box, not only events with a point inside it. GDACS reports most events as a box
  and the connector withholds a point when that box is regional, so a point-only
  filter told a caller asking about a district that nothing was there for hazards
  the source had explicitly placed there.
- The map requests the operational area and recent global events as two separate
  queries. It previously requested only the 50 most recent events worldwide, which
  with GDACS and USGS both live is always the same Pacific and Caribbean
  earthquakes: the seeded flood and landslide that the road-access and routing
  walkthrough depends on were paginated out and never drawn.
- The **OpenAPI contract now covers 93 paths / 118 operations**, up from 63. It
  was missing 26 documented endpoints: equity by district and breaches, the
  equity scan, parametric rules and disbursements, webhooks, community feedback
  and its summary, quarterly KPIs, data lineage, the connector catalog,
  scenarios, trigger-protocol backtest and shadow-run, outbox dispatch,
  retention, bias correction, and the CHW report and reply routes. All 26 were
  real and reachable; they simply were not in the contract, so a technical reader
  could not discover them or generate a client. `info.version` also said 0.1.0
  while the package was at 0.2.0.
- The flood-probability build guard now scans **documentation, the OpenAPI
  contract and the dashboard markup**, not just `.js` files, and matches prose
  phrasings as well as identifiers. A flood probability asserted in the contract
  or a UI label is the claim a panel would act on; previously such a claim could
  be added anywhere outside a `.js` file and pass. Two documents that exist to
  discuss the constraint may name the terms, by explicit list.
- `GET /api/v1/health` now reports **`version`**, read from `package.json` at
  startup and fatal if unreadable — a wrong version is worse than a missing one.
  The footers in the partner portal, the CHW app and the Settings panel source it
  from there instead of carrying their own literal, which had drifted: three
  copies of an older release, including one in a translation file, all reporting
  a build that was not the one running.
- The browser check now runs at a **1440x900 laptop viewport**. It previously
  inherited headless Chrome's default of about 756x469, which is the mobile
  breakpoint: the console is a single column and the rail is full width. Every
  layout assertion therefore ran against a layout no panel will see.
- The **equity table overflowed the 360px rail** on a laptop, and the last
  column — "Not acknowledged", the one that says who was not reached, on the
  surface whose purpose is that — was clipped behind `overflow-x: hidden` and
  unreachable. Headers now wrap and cells are right-aligned with tabular figures
  so the table fits. Confirmed to fail without the change.
- Planning a route now **frames the map on that route**, the way a flood
  simulation frames on its extent. The Lodwar corridor is four roads inside six
  kilometres, so a region-wide frame collapsed the reroute into one unreadable
  cluster. The frame is derived from the returned hops, not the requested
  endpoints, because a plan that detours around a cut segment passes through
  neither. Clearing the route returns the region frame.
- The map has a **minimum rendered height**. `.map-container` is a flex column
  that also holds the seasonal strip, filters, flood controls and routing panel,
  so `flex: 1` gave the map only the leftover space: on a 1440x900 laptop it
  rendered at 195x122 with 82% of the width unused and legend text at 2.4px. The
  cells were present in the DOM, so every assertion passed while the map was
  effectively invisible. `.map-section` now scrolls instead of clipping.
- The flood status line reports the inundated area in km² and names the box the
  percentage is a share of, stating that it is not a share of the district. It
  previously read "40% of the area", which invites reading 40% of the district as
  underwater.
- Landslide hazards now render with their own class and appear in the map legend.
  `.hazard-landslide` was declared in CSS but no code path ever applied it, so a
  landslide fell through to the generic marker and looked like any other event
  even though road-access models it differently from flood.
- GDACS parsing reads namespaced RSS tags by local name and extracts event type
  codes, bbox, and country. The previous literal-prefix match returned null for
  all three.
- **Risk score bands renamed to say what they are.** `score_p10` / `score_p50` /
  `score_p90` / `interval_width` are a *sensitivity range driven by input
  coverage*, not quantiles of a predictive distribution. A well-populated region
  returned `p10 == p90` with `interval_width: 0`, which reads as certainty while
  actually meaning inputs were sufficient. Responses now carry
  `sensitivity_low` / `_mid` / `_high` / `_width`, `calibrated_uncertainty: false`,
  and a `limits` string. The old names remain as aliases with identical values,
  so stored records and consumers keep working. No calibrated bands ship with
  this release and no Brier/CRPS calibration report exists.

### Fixed

- **Three connectors reported success while ingesting nothing.** CHIRPS matched
  filenames against a product index that now lists year directories, so the
  pattern matched zero times. GloFAS's published RSS URL serves the EFAS web app,
  so the parse found no items. NASA FIRMS has no keyless access and the
  placeholder key returned HTTP 400 per region while the catalog claimed no
  credentials were needed. Each now reports an error instead of an empty success,
  and their fixtures reproduce the real upstream responses.
- **A source returning zero records can no longer report `success`.**
  `minimum_records` was 0 on four regular sources, so an empty parse passed the
  health check as fresh. Every regular public source now declares a floor of 1,
  verified against live record counts first. User-supplied sources keep a floor
  of 0, since uploading an empty CSV is a legitimate operator action.
- **Country-scale hazard bboxes no longer block distant roads.** A GDACS green
  flood alert for France arrived with a bbox spanning ~40°, and bbox containment
  is authoritative in the road-access matcher — every road in the Horn of Africa
  came back restricted by an alert 2,051 km away. Only hazard-scale boxes
  (≤5°, ~555 km) may block on containment; wider ones fall back to proximity
  matching around the reported centre.
- `POST /api/v1/routing/plan` rejects coordinate objects with an error naming the
  problem. They previously produced "Unknown origin or destination road", which
  is indistinguishable from missing data.
- The demo seed reports a degraded source as degraded. `runIngestion` does not
  throw for one, so every source was labelled "ok".

## v0.2.0 - 2026-10-01

Hardening pass focused on operational integrity and payment compliance. No breaking
API changes; all additions are additive.

### Added

- USGS real-time earthquake ingestion (`usgs_earthquake`), emitting `hazard_events`
  so existing risk scoring and alerting pick it up unchanged. Follows the connector
  spec and is registered in `schema.js`, `ingestion.js`, and `connectors.registry.json`.
  Offline fixture tests cover parsing and upstream failure.
- OFAC SDN sanctions screening on parametric disbursement simulation. A match returns
  HTTP 409 and records nothing; clean screens are stamped on the disbursement so an
  audit can distinguish screened from unscreened payments. Name-based only — see
  Limitations in `docs/parametric.md`.
- `DELETE` on operational collections with soft-delete semantics. Records are stamped
  `deleted_at` / `deleted_by` rather than removed, so action-log history and
  referential links survive. Hidden from lists and `GET` unless `?include_deleted=true`;
  writing to or re-deleting a deleted record returns 409.
- Request body size cap (5 MB default, `LINDELA_LITE_MAX_BODY_BYTES`) returning 413,
  and 400 with a clear message for malformed JSON.

### Changed

- PostgreSQL `merge()` now upserts only the request's records instead of
  `DELETE`-ing and reinserting the whole table. Ten single-record merges against
  5,000 rows: 23,515 ms → 201 ms. `payload_hash` moved to an indexed column and
  backfilled from existing bodies on startup, so upgrades keep dedupe working.
- `operationalSummary()` and `counts()` exclude soft-deleted records, so
  `/api/v1/health` and `/api/v1/operations/summary` agree.

### Fixed

- USGS connector used an endpoint that returns HTML rather than JSON; every live
  ingest failed to parse. Now uses the `feed/v1.0/summary` GeoJSON paths.

## v0.1.0 - 2026-05-18

Initial public release candidate for Lindela Lite.

### Added

- Public climate, hazard, fire, flood, service-asset, and optional conflict CSV ingestion.
- Baseline flood risk, climate-conflict risk, and service-impact scoring.
- JSON, pg0, and external PostgreSQL storage modes.
- REST API, CSV export, GeoJSON export, and static dashboard.
- Service asset import endpoint and dashboard CSV/GeoJSON import controls.
- OpenAPI contract, storage docs, contribution docs, security policy, and trigger protocol examples.
- CI workflow with Node 20/22 and PostgreSQL integration coverage.

### Excluded

- GDELT ingestion.
- WorldMonitor code.
- Proprietary Lindela fusion, calibrated models, report management, wargaming, classified workflows, and source reputation systems.
