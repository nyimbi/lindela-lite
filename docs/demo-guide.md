# Demo Guide

Lindela Lite ships with a demo-data pipeline aligned to the UNICEF Climate and Health 2026 pilot regions: Turkana (KE), Bor (SS), Aweil (SS), Moroto (UG), Mandera (KE).

## Preconditions

- Node 20+
- `npm install` complete
- Server optional for script seeding; required for endpoint seeding

## Seeding

### Option A: script

```
npm run demo:seed
```

Prints a JSON counts object to stdout. Errors go to stderr per source.

Five sources are ingested by default: `open_meteo`, `gdacs`, `chirps`,
`usgs_earthquake`, `noaa_enso`. Two are skipped because they are genuinely
unavailable rather than unconfigured — `glofas` (its RSS URL serves a web app)
and `nasa_firms` (requires a MAP_KEY requested by email). Ask for them
explicitly to see the failure reported:

```
node -e "import('./scripts/seed-demo.mjs').then(async m=>{
  const { JsonStore } = await import('./src/store.js');
  console.log(await m.ingestPublicSources(new JsonStore('/tmp/probe.json'),
    { sources: ['glofas','nasa_firms'] }));
})"
```

Both report `degraded`, and the run records the reason. A source that returns
nothing and reports success is a failure this project treats as a bug — see
"Minimum Records" in `docs/ingestion.md`.

### Option B: HTTP endpoint

```
curl -X POST http://127.0.0.1:4177/api/v1/demo/seed
```

Returns `{"success": true, "counts": {...}}`. Runs the full pipeline in-process: public-source ingestion, operational data, analytics refresh.

### Idempotency

Both methods are safe to run multiple times. Records deduplicate by stable ID derived from content. Running twice merges cleanly.

### Reset

Point to a fresh store file before seeding:

```
LINDELA_LITE_STORE=/tmp/fresh-store.json npm run demo:seed
LINDELA_LITE_STORE=/tmp/fresh-store.json npm start
```

## 5-minute walkthrough

### 1. Dashboard (/)

Open `http://127.0.0.1:4177`. The overview tiles should show:

- **People reached**: derived from rapidpro_dispatches recipients_count. Expect 10,000+ across 20 dispatches.
- **Active incidents**: 6 open or responding across 5 regions.
- **Risk scores**: 12 entries covering flood and climate-conflict dimensions.
- **Source health**: open_meteo (green), gdacs (green). GloFAS, CHIRPS, FIRMS may show zero records depending on network state.

### 2. Alerts surface

Navigate to Alerts. You should see:

- 5 active alert rules: flood watch, drought alert, heat stress, disease outbreak, conflict proximity.
- 10 alert events spanning past 30 days. Mix of open, acknowledged, resolved.
- 10 trigger protocols with backtest precision/recall populated (e.g. Turkana Flood: precision 0.72, recall 0.68).

Click an open alert event to see the approval panel. The Bor flood event (severity: critical) is in approved state with reviewer "Peter Deng".

### 3. Operations surface

Navigate to Operations:

- 8 incidents covering flood, drought, disease outbreak, conflict, cold chain, school feeding.
- 10 interventions linked to incidents. Three are completed; five active.
- 15 tasks. Two are blocked: "Aweil MUAC compilation" is blocked pending CHW data.
- 40 field reports with demographics populated (age_band, gender, pwd).

Filter field reports by category: diarrhea or fever shows disease-cluster pattern around Bor.

### 4. Workflows surface

Navigate to Workflows:

- 13 workflow instances across all 8 types.
- One anticipatory_alert in `focal_point_review` state (Turkana, owner: Achola Wanjiru): click to see the pending review panel.
- One anticipatory_alert fully traversed to `closed` (Aweil): inspect the transitions log to see the full lifecycle.
- Two community_feedback_loop instances: one closed, one awaiting review.

### 5. Reports surface

Navigate to Reports:

- 4 templates: SITREP, Incident Brief, Intervention Update, Alert Digest.
- 6 reports: one distributed (Turkana Flood SITREP W37), one approved (Bor), one draft (Mandera).
- 3 schedules: weekly SITREP, weekly Alert Digest, monthly Intervention Update.
- 10 distribution runs across markdown_download, webhook, rapidpro_sms channels.

Click the distributed Turkana SITREP to see the full report view.

### 6. Equity and parametric

Navigate to Equity:

- Dispatch accuracy computed per district from the 20 rapidpro_dispatches.
- If any district accuracy falls below 80% with 5+ dispatches, an equity_audit_action workflow was auto-created.

Navigate to Parametric:

- 3 rules on testnet chains (celo-alfajores, ethereum-sepolia, polygon-mumbai).
- 5 simulated disbursements with tx_hash prefixed `sim_`.

### 7. Community feedback

- 15 feedback items linked to alert events. Sentiment distribution: ~60% positive, ~27% negative, ~13% unclear.
- The Bor AWD alert event has the highest feedback volume.

## Flood, access, and routing walkthrough

These are the newest capabilities and the ones a panel is most likely to probe.
Road access and routing run entirely on seeded assets; only the flood-depth call
needs outbound network access.

### Seeded road corridor

The seed includes a connected corridor on the Lodwar approaches so the router
has a real network rather than four isolated district roads:

| Segment | Class | Status |
|---|---|---|
| Lodwar Distribution Depot Access | primary | passable |
| Lowland B4 Floodplain Segment | primary | **impassable** (seeded flood) |
| Kibish Plateau Bypass | unpaved | passable |
| Lodwar Clinic Approach | tertiary | passable |

One flood event is seeded, labelled `source: demo_seed` with
`metadata.demo_data: true`. It is authored demo data, not a live observation —
say so if asked where it came from.

### Road access

```
curl -s http://127.0.0.1:4177/api/v1/road-access/summary
```

Expect `total_roads: 8`, `impassable: 1`, `blocked_by_hazard_type.flood: 1`.
The lowland segment is blocked, everything else is passable. Open
`/api/v1/road-access` for per-road `access_reason`.

Note on live GDACS data: if ingestion ran, real global alerts are also in the
store. Only a hazard-scale bounding box may block a road on containment alone,
so a country- or multi-country-level green alert does not mark distant roads as
restricted. A box wider than ~5° falls back to proximity matching around its
reported centre.

### Routing over the severed segment

**In the dashboard**, under the map: pick a **From** and **To** road and press
Plan route. The selects are populated from the imported road assets, and the
demo corridor is the interesting pair:

- From `Lodwar Distribution Depot Access` → To `Lodwar Clinic Approach`
  succeeds: 1 Depot Access → 2 Kibish Plateau Bypass → 3 Clinic Approach,
  6.8 km, about 10 minutes by vehicle. The flooded lowland segment is skipped.
- From Depot Access → To `Lowland B4 Floodplain Segment` fails explicitly:
  *"No feasible road route: Destination road 'Lowland B4 Floodplain Segment' is
  impassable: Blocked by flood (critical)"*, followed by what that would
  require instead.

The point to make: the router does not treat the flooded road as usable
because a faster neighbour exists. An impassable segment is removed from the
network entirely rather than penalised, because no finite cost is a barrier.

**Over HTTP**, `from` and `to` are road **asset ids**, not coordinates. List
them first with `GET /api/v1/service-assets?service_type=road`. Coordinate
objects are rejected with an error naming the problem rather than reported as
an unknown road.

The map shows numbered markers rather than a drawn line. Road assets are
points, so a polyline between hops would invent geometry the router does not
know; the numbered hop list carries the sequence instead.

### Seasonal context

**In the dashboard**, a strip sits above the map filters. It reads, as of
2026-10-01: `+2.17 °C`, badge `El Niño advisory`, three of five season pips
filled, and the period.

The badge says **advisory**, not "El Niño". That is the point worth making to
a panel: CPC declares an ENSO episode only after ±0.5 °C holds for five
consecutive *overlapping three-month seasons*. Three qualifying seasons is an
advisory, not an event. The strip shows how many of the five currently qualify
instead of asserting a phase.

The note also states what the number is not — a monthly SST anomaly index, not a
rainfall forecast and not a flood probability — and that this is the **ONI**,
not the RONI CPC now uses for official monitoring.

To refresh it:

```
curl -s -X POST http://127.0.0.1:4177/api/v1/ingest/run \
  -H 'content-type: application/json' -d '{"sources":["noaa_enso"]}'
curl -s "http://127.0.0.1:4177/api/v1/climate?source=noaa_enso&limit=3"
```

If the connector has never run, the strip reads `not ingested` rather than
`Neutral`. Those are different claims and only one is evidenced.

### Flood-depth simulation

Needs outbound access to AWS Terrarium.

On the dashboard, pick an **area**, enter a water level, and press Simulate.
Areas are the five pilot districts; each offers a plausible starting level,
because Turkana sits around 500 m and Karamoja around 1,000 m, so a level that
floods one is nowhere near flooding the other. Simulating with Turkana at 500 m
shades 26% of the district.

Shading is by depth band (0.3 / 1 / 2 / 5 m) and the legend states the model.
The map frames on the simulated extent, so the shading fills the viewport
rather than sitting as a few pixels in a region-wide view. Clear returns the
frame to the whole pilot region.

Say this before anyone asks: it is a **static water-surface calculation**. No
flow routing, no channel geometry, no storage. A surface at *L* shades ground
below *L* that is hydraulically connected, which is only some of it — a closed
basin below *L* does not become a lake. Vertical resolution is ±15 m, inherited
from SRTM. It answers "the river is forecast to reach 512 m; which facilities
are under water and how deep?", not "where will it flood?".

### Not implemented, and why

Rainfall intensity/duration → flood probability is **not** in the build. It
needs an agreed hydrological model basis and a long validated annual-maxima
record. Inventing coefficients that look authoritative is worse than returning
nothing, so the endpoint does not exist.

If a panel presses on this, the honest answer is in
[flood-probability-model-basis.md](flood-probability-model-basis.md). The short
version: the only long rainfall record reachable without a licence is 36
complete years of ERA5, and published evaluation finds ERA5 underestimates
tropical extreme daily rainfall by roughly 40% — precisely the tail a flood
model depends on. Catchment delineation is additionally blocked on MERIT Hydro,
which is EULA-gated and unreachable.

**Epidemic/outbreak surveillance and food-security (IPC) tracking are also not
in the build**, for different reasons — see
[outbreak-and-food-security-scoping.md](outbreak-and-food-security-scoping.md).
Summary if asked: IPC data requires a licence we do not have and the site blocks
automated access; WHO outbreak data *is* keyless, but what is available is
country-level annual aggregates, which cannot drive district response. The
remainder is a UNICEF policy judgement about publishing disease geography, and
it is not ours to make.

What *is* shipped answers the downstream question honestly: given a forecast
water level, which facilities are under water and how deep. That is the
operational question relief logistics asks first, and it is answerable from a
DEM alone.

## Key demo watchpoints

| Surface | What to highlight |
|---|---|
| Dashboard | People reached counter; ingestion source health badges |
| Alerts | Approval flow on critical severity events; backtest metrics on trigger protocols |
| Operations | Blocked task "Aweil MUAC"; field report demographics distribution |
| Workflows | Anticipatory alert in focal_point_review; full lifecycle on closed Aweil workflow |
| Reports | Distributed SITREP with all sections rendered; failed distribution run (503) |
| Equity | Per-district accuracy table; auto-created audit workflow if breach detected |
| Map | Flood-depth simulation with depth legend; road status overlay |
| Road access | One impassable segment with `access_reason`; `cut_off_rate_pct` |
| Routing | Detour via the plateau bypass; severed-route diagnostics on failure |
| Seasonal | Niño 3.4 advisory with `overlapping_seasons` count, not a declared event |
