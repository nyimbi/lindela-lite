# Vision

What Lindela Lite is for, who it is for, and what it deliberately is not. This
document is the synthesis; the sources it cites are normative where they differ.

The one-liner:

> A standalone, open-source climate-conflict and flood-impact toolkit that
> ingests public data, normalizes it into simple schemas, computes transparent
> baseline risk scores, and serves them over an HTTP API with a no-build
> frontend — for a district office whose internet, power, and staff availability
> are all contingencies, not givens ([README](../README.md), [llms.txt](../llms.txt)).

## The three layers of the vision

### 1. What it is: a public-good decision surface

One Node process, one port ([deployment](deployment.md)), one store table or one
JSON file ([data model](data-model.md)) — shaped so
[`deploy/one-click.sh`](../deploy/one-click.sh) works from a building where *the
thing most likely to be broken is not the laptop's DNS*
([ADR-008](architecture/decisions/ADR-008-hand-rolled-svg-map.md)). It closes one
loop: public-source ingestion → transparency (data quality, freshness,
confidence) → baseline risk scoring → auditable alert events → RapidPro SMS
dispatch → field reports coming back (inbound webhooks, offline queues) →
reports distributed to partners, each distribution recorded as a run
([operations](operations.md), [RapidPro](rapidpro.md), [reporting PRD](reporting-prd.md)).

It is decision support, explicitly **not** an automated command system: high
severity alerts get human gates, and the platform never claims a certainty it
does not hold.

### 2. What it deliberately is not: Lindela's commercial half

[Open-Source Boundary](open-source-boundary.md) is the load-bearing split. Lite
releases exactly the layer where publicness creates value — public connectors,
neutral schemas, transparent heuristics, a light dashboard — and withholds the
layer (calibrated prediction, source-reputation fusion, wargaming, classified
workflows) where release would destroy commercial value. No GDELT
([ADR-006](architecture/decisions/ADR-006-exclude-gdelt.md): it does not survive
the honesty bar), no client data, no trained artifacts.

### 3. What it is becoming: three orthogonal roadmaps

- [enhancements.md](improvements/enhancements.md) (ENH-01..30) — *can this be
  trusted*: deny by default, honesty envelopes on every number, staleness
  verdicts, offline truth-telling.
- [roadmap-extension.md](improvements/roadmap-extension.md) — *is what is built
  actually working* (its verdicts: mostly "Partial", "and dead", "Shipped,
  defective").
- [sources-and-decisions-roadmap.md](improvements/sources-and-decisions-roadmap.md)
  (SRC/DEC/OPS/PLT/CC) — *what the platform does not know yet*: facts first,
  then judgements, then the operational states a response team moves through.
- [world-class-roadmap.md](plans/world-class-roadmap.md) — the umbrella:
  calibrated uncertainty, impact-based forecasting ("people-at-risk, not hazard
  intensity"), anticipatory-action trigger protocols with backtests before
  donors release pre-arranged finance.

## The constitution underneath

The vision is less a feature list than a set of contracts:

- **Flood risk here is empirical co-occurrence, not hydrology.** The vocabulary
  itself fails the build (`scripts/check-no-flood-probability.mjs`); the one
  permitted home for it is [flood-probability-model-basis.md](flood-probability-model-basis.md).
- **`0` is not `null`; "not determined" is not zero.** A missing forecast is
  never 0% rain. A coordinate at 0° is a coordinate
  ([llms.txt](../llms.txt), [falsy-zero tests](../test/falsy-zero.test.js)).
- **Honest failure states.** An offline miss says "never fetched", not "no
  data"; a stale source says so; a claim served from cache is a lie and the
  service worker is built to prevent it.
- **Checked, not trusted.** The API document is diffed against the route
  table; documentation links are resolved at validation time; every ADR records
  its rejected options so nobody rediscovers them (see
  [the decisions index](architecture/decisions/README.md)).
- **Zero front-end dependencies, no build step**
  ([ADR-001](architecture/decisions/ADR-001-zero-frontend-dependencies.md)) —
  the browser receives the authored bytes, and the basemap is the one layer
  where fresh imagery earns its complexity
  ([ADR-013](architecture/decisions/ADR-013-osm-raster-basemap.md)).

Even the basemap arc is the vision at work: ADR-008 said "revisit when an
operator asks for a real basemap"; an operator asked; the decision was
revisable rather than a monument.

## Where the data comes from

Two contractual categories ([ingestion](ingestion.md) is normative), plus
two render inputs that are fetched, not records:

**Regular public/open sources — scheduled, one free key at most.**

| Source ID | Delivers | Upstream |
|---|---|---|
| `open_meteo` | weather obs + forecast | `api.open-meteo.com` |
| `gdacs` | multihazard disaster alerts | `gdacs.org` GeoRSS |
| `glofas` | river discharge (Copernicus) | `global-flood.emergency.copernicus.eu` RSS |
| `chirps` | rainfall record | `data.chc.ucsb.edu/products/CHIRPS` |
| `nasa_firms` | fire detections (VIIRS) | `firms.modaps.eosdis.nasa.gov` |
| `usgs_earthquake` | earthquakes | `earthquake.usgs.gov` feeds |
| `noaa_enso` | ENSO indices (seasonal context) | `cpc.ncep.noaa.gov` Niño3.4 |
| `ipc_hdx` | food insecurity (IPC) | `data.humdata.org` HDX |
| `who_gho` | cholera/outbreak context (730-day cadence) | `ghoapi.azureedge.net` WHO GHO |

Three further on-demand backfills (`regular: false`, for history and seasonal
calibration): `gdacs_archive`, `open_meteo_archive`, and `open_meteo_flood` —
the latter the designated GloFAS replacement (SRC-01 in the
[sources roadmap](improvements/sources-and-decisions-roadmap.md)). The only
credential in the system is `NASA_FIRMS_MAP_KEY`, a free key; everything else
is unauthenticated by design — "an unauthenticated public bucket will not fail
because someone's key expired mid-crisis" (`src/terrain.js`).

**User-supplied sources — the ground truth the feeds cannot give.**
`service_assets` (JSON/CSV/GeoJSON upload), `conflict_csv` (Lite schema),
`acled_csv` (ACLED-compatible, behind an explicit license-acceptance gate),
and `dhis2` (health-facility data, off until `LINDELA_LITE_DHIS2_ENABLED=on`).

**Render inputs, not records.** Elevation comes from Terrarium DEM tiles on
the AWS `registry.opendata.aws/terrain-tiles` bucket (`src/terrain.js`), the
basis of the flood-depth grid; basemap imagery comes from OSM/Carto raster
tiles proxied same-origin (`/api/v1/basemap/tiles/…`,
[ADR-013](architecture/decisions/ADR-013-osm-raster-basemap.md)).

**Derived, not ingested.** Flood risk, climate-conflict pressure,
service-delivery impact, population/facilities-at-risk and data-quality
signals are all computed in-process from the ingested records — the API never
resells another provider's scores.

**The honesty machinery around it.** Per-source policies (interval, timeout,
retries, `stale_after_minutes`, minimum records) drive `source_runs` verdicts;
a failing batch is quarantined, not published (`src/assertions.js`); a dead
source trips a circuit breaker; freshness reports `ok | quiet | stale |
broken`. Fixtures are verified against live upstreams: `docs/ingestion.md`
records the three connectors that reported success while ingesting nothing
(`chirps`, `glofas`, `nasa_firms`) until a live-verification pass caught them.
And deliberately absent: GDELT ([ADR-006](architecture/decisions/ADR-006-exclude-gdelt.md)),
any proprietary feed, any client-data feed.

## How it gets communicated out

Four families of channels, each with its own delivery contract —
[reporting PRD](reporting-prd.md) and [RapidPro](rapidpro.md) are normative:

**Pull — open standards, for systems.** REST `/api/v1/*` serves normalized
JSON, with **GeoJSON** and **CSV** variants on geospatial collections.
[ADR-011](architecture/decisions/ADR-011-standard-interchange-formats.md) adds
a **STAC catalogue** (`/stac/catalog.json`, `/stac/collections/…`) and **OGC
Features** (`/ogc/`), optionally opened onto the public paths so external GIS
stacks pull on their own schedule; auditable alert events additionally render
as **CAP 1.2 XML** (`src/cap.js`) for third-party alerting infrastructure —
standards-shaped warnings, not bespoke JSON another system must decipher. Each
report is downloadable as Markdown, a JSON payload, and CSV/GeoJSON data
appendices.

**Push — outbound integrations, for people and pipelines.** RapidPro carries
two distinct products: alert-event dispatch (per-dispatch records with
attempts/status/error, `src/rapidpro.js`) and report summaries as SMS linked
to the full report. Signed webhooks ride a **transactional outbox**: the same
flow that produced the event writes an outbox row; the driver delivers with
HMAC signatures, exponential backoff, idempotent event ids (re-emitting is a
*replay request*, not a double-send), and dead-lettering after five attempts;
`POST /api/v1/outbox/dispatch` is callable by an external scheduler. Scheduled
report runs generate on recurrence (draft-only or auto-distributed).

**Human surfaces.** The eight applications of
[ADR-012](architecture/decisions/ADR-012-eight-separate-surfaces.md):
the console's situation map, panels, charts and alert rail; `/focal-point`
for the duty officer; `/portal` for partners; the analyst surfaces; `/chw`
offline-first for field staff. Charts ship an aria-hidden twin and a table
sibling, so the *insight* is communicated accessibly, not just the data.

**The loop back.** Inbound RapidPro field-report webhooks, uploads, and the
CHW offline queue push field reality into the same store — what goes out is
checked against what comes back.

**The meta-contract: delivery itself is audited.** A distribution is a *run*,
not an action: `report_distribution_runs` record channel, status, response and
retry hints; action-log entries name the actor; report status is a one-way
gate (`draft → ready → approved → distributed`) and approved or distributed
reports cannot be regenerated (409). Outbox degraded state rolls up into
`/api/v1/health`. "Did anyone receive it?" is queryable the same way "is this
number stale?" is — the platform refuses to collapse *sent* into *received —
and nobody heard back* silently. Caveat, same as the risk gates: the
data-quality gate on report approval is advisory, not blocking (JTBD-013 in
the [JTBD catalogue](platform-jtbd-catalogue.md)) — a report can be
distributed while describing data the data officer has flagged stale.

## Why the problem matters, what else exists, and why this is a good solution

### Why this problem matters

**The risk compounds; the tooling doesn't.** In the five pilot districts
(Turkana, Bor, Aweil, Moroto, Mandera) the canonical event is compounding: *a
flood cuts the Lodwar corridor* — a weather event that is, operationally, a
health-supply-chain event in a conflict-affected region. Climate → displacement
→ conflict pressure → service collapse is a causal chain, and each link lives
in a different silo (weather feed, conflict CSV, asset register, SMS flows).
The information is public; the joint picture exists nowhere. Stated
information-theoretically: no existing tool provides channel capacity across
these silos, so an officer's posterior after reading everything available is
barely improved over deciding unaided.

**It is a data desert at exactly the district scale where decisions happen.**
This repository documents its own upstreams' decay: `chirps` moved its product
index while the connector happily ingested zero records, `glofas`'s published
RSS served the wrong application, keyless outbreak data does not match
district-level need
([scoping](outbreak-and-food-security-scoping.md)), and a real deployment has
**no service-asset inventory at all** until someone uploads one (SRC-05 in the
[sources roadmap](improvements/sources-and-decisions-roadmap.md)). Every
"authoritative" source is single-domain, desktop-grade, and silent about its
own staleness.

**The last mile is offline and SMS-shaped.** Field staff are on shared phones
with intermittent network — the premise of
[ADR-012](architecture/decisions/ADR-012-eight-separate-surfaces.md).
Dashboards that blank when the link drops, spreadsheets that cannot say how
stale their facts are, SMS flows that cannot show a map: the honest-state
problem (cached health answers silently served, silent empty maps) is why the
"not determined ≠ zero" constitution exists at all.

**The money is anticipatory, and anticipatory finance is trust-gated.**
IFRC/START-style pre-arranged financing releases only on documented trigger
histories with false-positive and miss rates
([world-class roadmap](plans/world-class-roadmap.md) §6). Mechanism design:
a contingent contract is only enforceable if a third party can cheaply verify
the trigger. Reproducible, auditable numbers — not forecasts — are the
bottleneck infrastructure, and that is the niche this platform builds.

**Dashboards lie in benign-looking ways.** The
[demo audit](demo-audit-2026-10-02.md) is the receipt: CAP output with every
alert placed on Null Island, a PDF KPI mislabelled against its external
target, an SMS summary claiming zero incidents, a SITREP reporting all 280
global events as Turkana's. "Almost every defect found here looked entirely
correct."

### What other solutions exist

| Class | Examples | What they don't do |
|---|---|---|
| Authoritative single-domain feeds | ACLED, GDACS, USGS, GloFAS, FEWS NET, ReliefWeb, HDX | No fusion, no operational ledger, no offline, no last-mile channel |
| Generic dashboards / warehouses | Grafana, Superset, Metabase, Power BI | Render data; no hazard semantics, no uncertainty vocabulary, no offline; need infrastructure and an engineer |
| Field-data and CHW apps | Kobo/ODK, D-tree, DHIS2, RapidPro itself | Messaging and collection only — no risk layer, no multi-hazard picture |
| Institutional processes | OCHA SITREPs, IFRC DREF/FBF tools | Human, episodic, portal-bound; no live ingest or auditable trigger history |
| Full commercial systems | Full Lindela, Palantir-class fusion | Proprietary — Lite is the transparent complement, not a competitor |

The white space: **multi-domain fusion + honest uncertainty + offline last
mile + two-way SMS + audited distribution + one-process deployment at zero
licence cost.** No existing product combines them; buying them separately at
commercial per-seat prices is how organisations get locked in.

### Why this is a good solution

1. **An architecture built for the actual constraints**: one process, one
   port, JSON-or-Postgres, no build step, CSP'd same-origin, service-worker
   offline shell ([one-click deployment](deployment.md)). The deployment model
   *is* the infrastructure reality of a district office.
2. **Information hygiene as a design contract**: provenance, freshness and
   confidence on every number; an explicit "not determined"; quarantine
   before publish; circuit breakers; delivery audited as runs. The platform
   structurally refuses to communicate a claim it cannot substantiate.
3. **Verification-first engineering**: the OpenAPI document is diffed
   against the route table; documentation links resolve at validation time;
   claim vocabulary that would overstate capability fails the build
   ([ADR-010](architecture/decisions/ADR-010-build-time-claim-guard.md));
   artefacts are extracted and checked against the live screen (the demo-audit
   method). Trust here is cheap to verify — the only kind that survives a
   third-party audit.
4. **Standards at the boundary**: STAC/OGC/GeoJSON/CAP out, user-supplied
   formats in — interoperable, zero lock-in; the open/commercial split keeps
   the public good funded without pretending everything can be free.
5. **Decision support, not command**: human approval gates on high-severity
   dispatch; scenarios labelled what-ifs; the honesty envelope is the product.
   The failure mode that kills trust — a confident wrong number — is
   prevented structurally, not by policy.
6. **The right cost curve for a public good**: free upstreams, open source,
   marginal cost per additional district ≈ one row of configuration — versus
   per-seat commercial dashboards.

## The audience: who, why, and for what

### Who

Eight surfaces because the audiences have almost nothing in common
([ADR-012](architecture/decisions/ADR-012-eight-separate-surfaces.md)):

| Surface | Human | Context |
|---|---|---|
| `/chw` | community health worker | shared phone, one hand, often no network — *"the CHW app is the product's reason to exist, and it is not a smaller version of the console"* |
| `/` | operator (the console) | desk, intermittent connectivity |
| `/focal-point` | duty officer | desk or phone, deciding what to escalate |
| `/co` | programme manager | good network, cross-programme review |
| `/portal` | external partner (donor, county government, NGO) | good network, no platform access otherwise |
| `/districts`, `/scenarios`, `/parametric` | analyst, district officer, finance | drill-down, what-if, exposure pricing |

Plus four non-human actors from the
[JTBD catalogue](platform-jtbd-catalogue.md): schedulers hitting
`POST /api/v1/ingest/run-due`, RapidPro SMS flows, webhook consumers on the
outbox, and developers using the [connector SDK](connectors-sdk.md).
Institutional context: UNICEF Innovation Fund
([traceability](unicef-requirements-traceability.md)).

### Why

The alternatives fail the same way for this audience: dashboards that go blank
when the link drops and mean nothing when they do, spreadsheets that cannot say
how stale their facts are, SMS flows that cannot show a situation map. The
pitch is **decision support that tells the truth about its own limits** — every
number carries freshness, confidence, and an explicit "not determined" state;
the console works offline from the service-worker shell; it is one process that
a district office in Turkana can actually install and pay for. And the risk it
addresses is compounding — climate, conflict and service delivery colliding in
the same districts — which no single-feed tool covers.

### For what

The [JTBD clusters](platform-jtbd-catalogue.md), in workflow order:

1. **Keep the picture current** — schedule and run public-source ingestion
   (weather, flood, GDACS, FIRMS), import ACLED-compatible conflict CSVs,
   upload service assets; a data officer watches staleness, failure streaks and
   geocoding coverage.
2. **Read the risk** — flood risk, climate-conflict pressure and
   service-delivery impact scores; facilities- and population-at-risk counts;
   flood-depth what-if simulation; shareable scenario tokens.
3. **Act** — alert rules → auditable alert events (each carrying its rule
   version, exact values and input record ids) → human approval enforced at
   the dispatch route (409 unless approved; `low` severity auto-approves) →
   RapidPro SMS dispatch; incidents, interventions, tasks and action logs as
   the response ledger.
4. **Close the field loop** — health workers report via `/chw` or inbound SMS
   webhooks through an offline queue; coordinators review and acknowledge.
5. **Tell downstream** — report templates → instances → export → distribution
   to partners, each distribution recorded; `/portal` is what an external
   partner sees.

All drawn on five pilot districts — **Turkana (KE), Bor and Aweil (SS), Moroto
(UG), Mandera (KE)** — where the canonical failures the product is designed to
survive are the ones from the framing story: *a flood cutting the Lodwar
corridor, a landslide across the Turkana supply route*. One operator, one map,
one honest number at a time.

## Open source: why this edition is open, why that is good strategy, and how it develops

### Why this is open source

**Because the boundary is a strategic asset, not a licence formality.**
[Open-Source Boundary](open-source-boundary.md) is explicit: Lite is the
public-good climate-conflict edition that *preserves* the commercial value of
full Lindela — open where publicness creates value (public ingestion, neutral
schemas, transparent baseline heuristics, standards, a light dashboard),
closed where release would destroy it (calibrated prediction,
source-reputation fusion, classified workflows). MIT, © Datacraft Ltd — a real
company, not a decoy.

**Because the numbers must be verifiable by parties who owe us nothing.**
These scores sit under contingent financing decisions. Closed source makes
"trust me" the only deliverable; open source converts it to "check me" — a
third party can reproduce every heuristic from the public fixtures and this
repository itself.

**Because institutional funders require it.** The UNICEF Venture Fund bid
([traceability](unicef-requirements-traceability.md)) is the live example:
openness and UNICEF-aligned KPIs (`src/kpi.js` — people reached, children U18,
warning-to-action latency) rendered on `/co` are procurement conditions, not
decoration.

**Because field deployments need permanence without a vendor.** A district
office must be able to run this behind its own firewall forever, keep its data
sovereign, and owe nobody a seat licence.

### Why open source is a good strategy

1. **Commoditize the complement — the open layer grows the paid layer.**
   Every free deployment raises demand for what Lite deliberately withholds
   (calibrated prediction, fusion, reputation). The boundary *creates* the
   market for full Lindela rather than surrendering to it.
2. **Verification cost collapses; trust scales.** The quality mechanism —
   claim vocabulary that fails the build, the OpenAPI document diffed against
   routes, artefact-vs-screenshot audits — is worth its full value only when
   anyone can run it. Cheap verification is what makes third-party trust
   rational.
3. **Public defect records become trust assets.**
   [defects.md](improvements/defects.md) and the
   [demo audit](demo-audit-2026-10-02.md) document failure modes no closed
   vendor would publish; the willingness to be wrong in public is the
   strongest trust signal a data platform can send.
4. **The ecosystem grows at contributors' expense, not ours.** The
   [connector SDK](connectors-sdk.md) and [contribution guide](../CONTRIBUTING.md)
   let others add sources (JTBD-085); every contributed source is free
   capability.
5. **Open formats are the distribution channel.** STAC/OGC/CAP out,
   CSV/GeoJSON out — the platform propagates as infrastructure wherever those
   standards are spoken, without a vendor negotiation.
6. **And the honest caveat: openness alone is not a strategy.** Without the
   boundary discipline it would be commoditizing our own core. The ADR process
   and the CONTRIBUTING boundary rules are what make openness a lever rather
   than a leak.

### How this will develop

- **Near-term, source-by-source**: GloFAS → `open_meteo_flood` (SRC-01),
  CHIRPS fix-or-retire (SRC-02), FIRMS → keyless GIBS fire (SRC-03), OSM
  roads/water via Overpass (SRC-04, partially already covered by ADR-013's
  tile layer), HDX health facilities (SRC-05). Then decision items (DEC),
  operational states (OPS), platform exits (PLT), and the cold-chain vertical
  (CC) — see the [sources roadmap](improvements/sources-and-decisions-roadmap.md).
- **Structural, via extension points**: connector SDK contributions; the
  external scheduler sidecar ([ADR-009](architecture/decisions/ADR-009-external-scheduler.md))
  for production cadences; multi-user RBAC deliberately left to a reverse
  proxy or gateway (JTBD-092) rather than an identity store — the process
  stays single and small.
- **Analytical, along the honesty axis**: the
  [flood-probability model basis](flood-probability-model-basis.md) proposal
  (empirical, guarded by its own claim scanner) as the path toward calibrated
  intervals without importing proprietary machinery; impact-based forecasting
  counts (people/facilities at risk) already live.
- **Governed evolution, not feature sprawl**: ADRs with explicit
  revisit-when clauses (ADR-013 just fired one of ADR-008's), schema changes
  through bitemporal history and the migration ledger, release discipline
  through the changelog and validation gates, per-release service-worker
  cache bumps.
- **The honest unknowns**: funding continuation (the UNICEF bid is
  org-level and pending), contributor onboarding gates that do not yet exist
  as CI (JTBD-085's noted gap), and the standing admission that *is what is
  built actually working?* is a live audit, not a settled claim — the
  [extension-roadmap verdicts](improvements/roadmap-extension.md) are
  mostly "Partial", "and dead", "Shipped, defective".

## What an interrogator will ask, and what counts as an answer

These are the twelve questions a hostile reviewer — a funder's due-diligence
panel, a sceptical reviewer — will ask. Each lists what would count as an
answer, and what the answer is *today*, in the project's own vocabulary: a
status, not a rebuttal. An answer that is a roadmap item is labelled as one.

### 1. "If the UNICEF bid fails, who maintains this?"

**Counts as:** a funded runway, a second maintainer, or both, with dates.
**Today:** the history is one author (355 commits spanning 2026-05 to date,
with two typos of the same name). The
mitigations are real but partial: pure Node with one runtime dependency, no
build step, hermetic tests, and [llms.txt](../llms.txt) written so an agent
or a stranger can navigate 28k lines — a takeover-ready codebase rather than
a takeover-ready team. The honest answer is that maintainer continuity is an
org-level risk in the [UNICEF traceability](unicef-requirements-traceability.md)
sense: not a code question, and the highest-risk item in the pack is the same
one the traceability doc flags for the financial statement (§3.11).

### 2. "What stops a competitor from forking everything — including the complement?"

**Counts as:** a reason the proprietary layer stays ahead that survives its
own public disclosure.
**Today:** the code is not the moat and is not claimed as one —
[the boundary](open-source-boundary.md) withholds live source reputation,
calibrated coefficients, fusion and classified feeds; those depend on data
and operator relationships, which a fork cannot read out of a repository. The
second moat is services: a district that runs Lite needs an SLA, and support
contracts do not travel with MIT. The residual risk is stated rather than
hidden: if calibration ever ships as code, the boundary has to move the
same day — the ADR process is the enforcement, not a policy memo.

### 3. "What are the false-positive and miss rates of the heuristics, in the corridor?"

**Counts as:** a backtest with measured FP/miss rates against retained
history — the same artefact an FBF donor requires.
**Today:** transparency is structural (every alert carries its rule version,
exact input values and input record ids — ENH-24's derivation block) and the
honesty labels are enforced ([ADR-004](architecture/decisions/ADR-004-sensitivity-is-not-a-probability.md),
[ADR-005](architecture/decisions/ADR-005-flood-probability-basis.md)), but
**measured rates do not exist yet**. The raw payload retention (ENH-12) and
bitemporal history are precisely the substrate a backtest needs, and the
backtest is item 6 of the
[world-class roadmap](plans/world-class-roadmap.md): planned, not live.

### 4. "What does a false dispatch cost in Turkana?"

**Counts as:** the loss function the thresholds encode, an approval path, and
an example of an action taken because of an alert.
**Today:** the mechanism is live, not planned: alerts above `low` severity are
born `proposed` and `POST /api/v1/rapidpro/alert-events/:id/send` refuses
anything unapproved with a 409 (`src/server.js`, `src/alerts.js`); every
dispatch is a signed, retry-accounted record. The loss function itself is the
operator's rulebook — the platform expresses severity and threshold, and
refuses to claim a calibration it does not have. What does **not** exist yet:
the documented trigger histories that would let a third party price the loss
function (see item 3), and a public accounting of actions-taken-from-alerts.

### 5. "Your own docs caught connectors reporting success while ingesting nothing. How many still do?"

**Counts as:** a freshness probe that fails CI, per connector, with dates.
**Today:** three lived: `chirps` (index moved, ingesting zero), `glofas`
(RSS served the wrong application), `nasa_firms` (needs the free key). The
platform *surfaces* the state rather than hiding it — freshness verdicts,
`minimum_records`, circuit breakers, quarantine — but a connector that
answers zero is still shipped, and one ("glofas") is scheduled for retirement
by SRC-01 with `open_meteo_flood` the replacement. The standing answer is the
[live verification table](ingestion.md); the missing automation is the SRC-10
live probe. Two are known-broken until that lands; this section exists so
that is said here rather than discovered at a review.

### 6. "The server has been offline for 30 days. What does the console actually show?"

**Counts as:** a per-surface degradation timeline, measured.
**Today:** design-level, and it degrades *truthfully*: the app shell is
permanent (precache, no TTL); the API bucket serves last-good responses for a
day then ages into a self-describing miss (`cached: false`); drill-down
records last 7 days; the map buckets: vector payloads 2 days, raster tiles 7
days and 400 entries; when tiles exhaust, the vector rings show through.
`/api/v1/health` flips to 503 via the heartbeat; the offline/queue banners
are shown, never hidden. The CHW queue keeps writing locally. What is not
measured: a 30-day drill as a named gate (the offline round-trip drill
covers minutes, not weeks) — the honest ceiling of today's claim.

### 7. "PII sits in a JSON file on a 0.0.0.0-bound machine. What is the blast radius of one compromise?"

**Counts as:** a threat model document, and the PII policy enforced at the
write path, not a policy file.
**Today:** enforced: names hashed and phones masked **by default** with
expiry (365 days; community feedback 180) because a privacy control that
ships off is not a control (`src/pii.js`); inbound RapidPro webhooks are
signature-verified and rate-limited; auth is fail-closed on bad token config;
CSP/permissions-policy are strict; the audit chain is verifiable. The honest
limit: single-node deployments have the classic single-store blast radius —
no field-level encryption at rest, and multi-user RBAC is deliberately
delegated to a reverse proxy (JTBD-092). The crown jewels here are field
reports and they are minimised at ingest; the honest gap is that the threat
model lives as deployment guidance, not as a reviewed document.

### 8. "Where is the wall, and what happens at twenty districts?"

**Counts as:** measured ceilings per storage path and a named migration path.
**Today:** the read path is manifest-scoped (`store.read({ collections })`),
which removed the ~143 MB whole-store read for one-page requests; record
versions — 60% of store bytes — are capped (5 per record, 50k total, pruned);
Postgres/JSONB is the same single-table contract, so the wall is process-level
(write contention, memory on wide manifests), not schema-level. The measured
data point in the source: 46 collections, ~39.7k rows, linear scans measured
before the Set. Beyond node scale the answer is honestly "full Lindela" —
event buses and job queues per service, the architecture Lite refuses to
prematurely adopt. Lite's ceiling is high for its audience; it is not claimed
to be unbounded.

### 9. "Which of the UNICEF KPIs would fail an honest-measurement audit?"

**Counts as:** the inventory printed on the surface, with the unknowables
named.
**Today:** one is already flagged in the
[traceability doc](unicef-requirements-traceability.md): warning-to-action
latency is rendered as *signal-to-dispatch median*, with the divergence
explained in the interface, because the platform observes its own SMS
latency and not the field action that follows (§1.5). "People reached" is a
dispatch count — an exercise proxy, labelled as data, not outcome. What the
platform cannot know (completed field actions, outcomes attributed) is
stated where the number is shown rather than silently aggregated; the
quarterly PDF gate exists because one mislabelled KPI left the building
before ([demo audit](demo-audit-2026-10-02.md), item 5).

### 10. "Where is the AI?"

**Counts as:** a reason its absence is a design decision — survive a reviewer
who wants a demo.
**Today:** there is no model in the decision path, on purpose: rules fire
with versioned derivations; risk is transparent co-occurrence
([ADR-005](architecture/decisions/ADR-005-flood-probability-basis.md)); report
narratives are human-authored and travel with the numbers they interpret
(ENH-27) rather than generated beside them. Where ML belongs here is already
drawn: calibration as an *additive* module behind its own guardrail
([flood-probability model basis](flood-probability-model-basis.md)), never as
an undocumented conclusion. And the build fails on probabilistic vocabulary
outside the one permitted document — a demo that overstated capability would
not compile. The demo answer to "where is the AI": *the same place it is in
a blood-pressure cuff — in the measurement discipline, not a claim.*

### 11. "A fleet of district offices hammering OpenStreetMap through your proxy is the bulk-download their policy forbids. What makes it legitimate, and what happens when you are rate-limited?"

**Counts as:** the request arithmetic, the mitigations, and the fallback.
**Today:** one console view is ~15 tiles at z6; the in-process LRU caps at
600 tiles, re-fetches dedupe in flight, and the client repainting debounces
and keys on grid identity so a pan issues nothing; the service worker caches
400 tiles for a week. A district office is one human-sized client; the
arithmetically honest statement is that this is modest *by construction*,
not by policy — and there is a descriptive User-Agent and a zoom cap (15)
the proxy enforces. On an upstream 429: the fetch fails, the route answers
502, the tile does not paint, the vector rings show — no retry storm (one
attempt, no per-minute burst) and no cache poisoning. What would be nice and
does not exist: a shared, persistent disk cache across restarts — the LRU is
in-process by design.

### 12. "What is your kill criterion?"

**Counts as:** pre-committed evidence that would end the project rather than
extend it.
**Today:** stated here for the first time, as policy to hold:
1. The connectors cannot sustain one fresh source per hazard domain through
   quarterly live verification, and retirement does not fix it — the project
   would then be a UI over stale data, which violates the constitution.
2. A dispatch path causes harm the approval gate could not have prevented —
   the safety model is falsified, and it stops until redesigned.
3. Maintenance funding ends with no second maintainer within one release
   cycle — a stale version of an emergency tool is a dangerous artefact.
4. The honest-state guarantees break in a way tests cannot see (a cache that
   lies undetectably) — the platform's only irreplaceable property is gone.

Each has a measurable signature, which is what makes it a kill criterion
rather than a resignation note.