# Scenario Workbench

The Scenario Workbench at `/scenarios` lets operators run "what-if" analysis by perturbing the live data and recomputing risk scores and service impacts.

## Builder panel (left)

| Control | Effect |
|---|---|
| Precipitation multiplier (0.5–3.0x) | Scales `precipitation_mm`, `ensemble_p10/50/90` on all climate observations |
| Offline asset IDs | Removes selected service assets before recomputing impact scores |
| Add hazard event | Injects a synthetic hazard event with type, severity, lat/lon, and occurred_at |
| Add conflict event | Injects a synthetic conflict event with the same fields |

All perturbations are client-side selections; the actual computation runs server-side via `POST /api/v1/scenarios`.

## Results panel (right)

Three delta cards show the mean change in flood risk, conflict risk, and service impacts between the baseline and the scenario. A bar chart shows baseline vs. scenario side by side. A table ranks the top 10 most-affected service assets by impact score delta.

## Sharing scenarios

After running a scenario, the URL hash is set to a base64-URL-encoded token of the perturbation object. Sharing the URL with a colleague lets them load and automatically re-run the same scenario.

Example URL: `/scenarios#eyJwcmVjaXBpdGF0...`

The token is decoded server-side by `GET /api/v1/scenarios/:token` which replays the perturbation and returns the result. The token is stateless — no server storage is required.

## Backend

The scenario engine lives in `src/scenarios.js`:

- `runScenario(data, perturbation)` — applies perturbation to a deep clone of the store data and returns risk scores, impact assessments, and diffs
- `encodeScenarioUrl(perturbation)` — base64-URL encodes a perturbation object to a URL-safe token
- `decodeScenarioUrl(token)` — reverses the encoding

No new dependencies. No persistent storage for scenarios (they are ephemeral by design).
