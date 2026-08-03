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

## Key demo watchpoints

| Surface | What to highlight |
|---|---|
| Dashboard | People reached counter; ingestion source health badges |
| Alerts | Approval flow on critical severity events; backtest metrics on trigger protocols |
| Operations | Blocked task "Aweil MUAC"; field report demographics distribution |
| Workflows | Anticipatory alert in focal_point_review; full lifecycle on closed Aweil workflow |
| Reports | Distributed SITREP with all sections rendered; failed distribution run (503) |
| Equity | Per-district accuracy table; auto-created audit workflow if breach detected |
