# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the district response operator.** A district officer or coordinator
running one district end to end through the console — ingesting public sources,
reading risk, approving dispatch, closing the field loop. They work at a desk
with intermittent connectivity and intermittent power, on the same laptop that
does everything else. Their job is to hold one honest picture of a district and
act on it before the situation moves.

Secondary audiences, served by their own surfaces rather than by the console
(`docs/architecture/decisions/ADR-012-eight-separate-surfaces.md`):

| Surface | Who | Context |
|---|---|---|
| `/chw` | community health worker | shared phone, one hand, often no network — the offline last mile |
| `/focal-point` | duty officer | deciding what to escalate |
| `/co` | programme manager | cross-programme review, good network |
| `/portal` | external partner (donor, county government, NGO) | no platform access otherwise |
| `/districts`, `/scenarios`, `/parametric` | analyst, district officer, finance | drill-down, what-if, exposure pricing |

Institutional context: the platform is deployed operationally with **IGAD** and
the **Eastern Africa Standby Force (EASF)**; the Lite edition is the subject of
a UNICEF Venture Fund bid.

## Product Purpose

Lindela Lite is an open-source coordination engine for climate-health and
climate-conflict response. It turns climate, health, conflict and field signals
into pre-authorised district action: when a threshold crosses, the alert is
already approved by a protocol the district signed, and the playbook executes.

It exists because the risk compounds and the tooling does not. A flood cutting
the Lodwar corridor is a weather event that is operationally a health-supply-chain
event in a conflict-affected region; each link in that chain lives in a different
silo. The information is public and the joint picture exists nowhere.

Success means a district office can install one process, keep its own data
sovereign, and get an auditable answer it is willing to act on and a third party
is willing to verify.

## Positioning

**Best-in-class standalone, held to its own merits — and the one property a
neighbouring product could not truthfully copy is that it refuses to state what
it cannot substantiate.**

This is a deliberate change of emphasis. The incumbent framing
(`docs/vision.md`) treats the open/commercial boundary as the strategic asset
and Lite as the transparent complement to full Lindela. That framing stays true
as a business fact, but it is not the claim this product is designed against.
Lite is judged as a product: it may grow calibrated models where the data
genuinely supports them, and it does not need the withheld half to justify
itself.

What no single-domain feed, generic dashboard, field-data tool, institutional
process or commercial fusion system combines: multi-domain correlation, honest
uncertainty, an offline last mile, two-way SMS, audited distribution, and a
one-process zero-licence deployment.

The durable constraint that survives the reframing: **a confident wrong number
is the failure mode that kills trust, and it is prevented structurally rather
than by policy.** Growing capability is allowed; growing past the evidence is
not.

## Operating Context

- **Five pilot districts:** Turkana (KE), Bor and Aweil (SS), Moroto (UG),
  Mandera (KE). The canonical failures the product is designed to survive are a
  flood cutting the Lodwar corridor and a landslide across the Turkana supply
  route.
- **Environment:** one Node process, one port, one Postgres table (`lite_records`)
  or one JSON file. No build step, no framework, one runtime dependency (`pg`),
  CSP'd same-origin. The deployment model is the infrastructure reality of a
  district office.
- **Upstreams are free and mostly unauthenticated by design.** The only
  credential in the system is `NASA_FIRMS_MAP_KEY`, a free key. The rationale is
  stated in `src/terrain.js`: an unauthenticated public bucket will not fail
  because someone's key expired mid-crisis.
- **The last mile is SMS/USSD/voice-shaped** and often offline. Field staff are
  on shared phones with intermittent network.
- **The money is anticipatory.** IFRC/START-style pre-arranged financing
  releases only on documented trigger histories with false-positive and miss
  rates, so reproducible auditable numbers — not forecasts — are the bottleneck
  infrastructure.

## Capabilities and Constraints

Shipped: public-source ingestion through a connector registry with declared rate
limits, retries and timeouts; multi-signal correlation and alert prioritisation;
threshold rules and trigger protocols with point-in-time backtests; pre-authorised
playbook execution with a full audit chain naming protocol version and approvers;
incident/intervention/task/field-report tracking; donor-grade reporting with
refusal semantics; distribution by download, webhook and RapidPro SMS, each
recorded as a run; real-road-network routing that refuses impassable segments;
static flood-depth simulation from a forecast water level against a DEM; per-district
equity measurement; JSON/GeoJSON/CSV over `/api/v1/*`; offline-first delivery
through a service-worker outbox with exactly-once semantics.

Deliberately absent: GDELT (`ADR-006`); rainfall-intensity-to-flood-probability,
which needs an agreed hydrological basis and a long validated annual-maxima
record; epidemic/outbreak surveillance and IPC food-security tracking at district
resolution, which need a licence the project does not hold.

Standards at the boundary: STAC catalogue, OGC Features, GeoJSON, CSV, and
CAP 1.2 XML for alert events.

**Undecided:** the exact shape of any future calibrated model, and whether Lite
should ever ingest a source carrying a per-seat or per-request cost. Neither is
settled; neither should be assumed.

## Brand Commitments

- **Name:** Lindela Lite, package `@lindela/lite`. MIT, © Datacraft Ltd.
- **Lineage:** the public edition of the Lindela platform, deployed with IGAD
  and EASF. Live at `lindela.co.ke`.
- **Voice, already established across the documentation:** plain, concrete,
  first-person-plural where a decision is being explained, and candid about
  defects. The repository publishes its own failure modes
  (`docs/improvements/defects.md`, `docs/demo-audit-2026-10-02.md`); being wrong
  in public is treated as the strongest available trust signal.
- **The constitution is binding on data surfaces.** `0` is not `null`; a missing
  forecast is never a 0% chance of rain; a coordinate at 0° is a coordinate.
  Every served figure carries freshness, confidence and an explicit "not
  determined" state. A refusal is an answer, not an error — `POST /api/v1/ask`
  returns a **200 carrying the reason** when a question cannot be grounded.
  Marketing, navigation and documentation prose are not bound by this
  vocabulary; anything that renders or transports a platform-computed value is.
- **No AI attribution** in any commit, document or artefact.

## Evidence on Hand

- **Documentation is unusually deep and is the primary evidence:**
  `README.md` (product), `docs/vision.md` (synthesis and rationale),
  `docs/platform.md` (complete guide), `docs/platform-jtbd-catalogue.md`
  (every job-to-be-done with the route and test that discharges it),
  `docs/ai-ml-usage.md` (the one fitted model, its refusal floors, and the two
  opt-in model surfaces).
- **A real defect record:** `docs/demo-audit-2026-10-02.md` — CAP output with
  every alert on Null Island, a PDF KPI mislabelled against its external target,
  an SMS summary claiming zero incidents, a SITREP reporting all 280 global
  events as Turkana's. The audit's own line — "almost every defect found here
  looked entirely correct" — is the sharpest available argument for the
  product's honesty stance.
- **A seeded demo store** (`npm run demo:seed`) and `artifacts/screens/` visual
  captures.
- **Screenshot fixtures** under `artifacts/` for offline, CHW and dead-server
  states.
- **Absences future work must not fabricate:** no testimonials, no customer
  logos, no named partner quotes, no benchmarks, no pricing, no deployment
  counts beyond the two institutional deployments named above. The UNICEF
  requirements-traceability record exists internally and is deliberately not
  published; do not reconstruct it.

## Product Principles

1. **An honest number beats a confident one.** Where the sample is too small or
   the model basis is absent, the product prints "not measured" with the reason.
   This is the product, not a limitation of it.
2. **Verification must be cheap enough that a third party bothers.** Open source,
   public fixtures, a build that fails on overstated claim vocabulary, and an
   OpenAPI document diffed against the route table in both directions. "Trust me"
   is not a deliverable; "check me" is.
3. **The deployment model is the infrastructure reality.** One process, one port,
   one table or one file, no build step. Anything that requires an engineer to
   install does not reach a district office.
4. **Decision support, not command.** High-severity dispatch carries a human gate.
   The platform never claims a certainty it does not hold.
5. **Every audience gets the surface it needs, not a smaller version of
   another's.** The CHW app is not a compact console; the console is not a
   partner portal.

## Accessibility & Inclusion

Required standard: **WCAG 2.2 AA** — body text at 4.5:1, large text and non-text
indicators at 3:1. Severity is never encoded by colour alone; charts ship an
`aria-hidden` twin and a table sibling so the insight is communicated
accessibly, not just the data.

Product-specific needs already established: the CHW surface targets 44px tap
targets for one-handed use on a shared phone; the low-literacy path is icon-led;
the console is keyboard-navigable with a command palette and shortcuts; i18n
coverage floors are enforced by a gate. Three languages carry complete CHW
strings.
