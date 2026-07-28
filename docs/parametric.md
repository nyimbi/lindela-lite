# Parametric Disbursement Simulator

**Testnet only.** No real funds move. All chains in this module are testnets per the UNICEF Venture Fund pilot commitment (bid §10).

## Commitment

The Lindela pilot scopes parametric disbursement to testnets. The UI prominently displays a warning banner on every page load. Any attempt to configure a mainnet chain is rejected by the backend with an explicit error message.

## Supported testnet chains

- `ethereum-sepolia` — Ethereum Sepolia testnet
- `polygon-mumbai` — Polygon Mumbai testnet
- `celo-alfajores` — Celo Alfajores testnet

## Parametric rule schema

| Field | Type | Description |
|---|---|---|
| id | string | Stable ID (auto-generated) |
| name | string | Human-readable rule name |
| chain | string | One of the supported testnet chains |
| contract_address | string | Target smart contract address (testnet) |
| trigger_metric | string | Climate metric key (e.g. `precipitation_mm`) |
| trigger_threshold | number | Value that triggers disbursement |
| disbursement_amount_local_currency | number | Amount in local currency |
| currency | string | Currency code (e.g. `USD`) |
| recipient_group_id | string | RapidPro group or internal group identifier |
| requires_focal_point_approval | boolean | Whether focal-point sign-off is required before simulation |
| status | string | `draft` / `active` / `paused` / `archived` |

## Simulation

`POST /api/v1/parametric-rules/:id/simulate` runs a simulated disbursement. The returned `tx_hash` always starts with `sim_` followed by 20 hex characters derived from a SHA-256 hash. No network call to any blockchain is made.

When `requires_focal_point_approval` is `true` and `focal_point_approved` is `false`, the endpoint returns HTTP 409.

## Transition to real disbursement (post-pilot)

When a real pilot is approved:
1. Replace the `simulateDisbursement` function in `src/parametric.js` with a real on-chain transaction via a wallet provider (e.g. ethers.js or viem).
2. Remove the testnet-chain guard or expand `PARAMETRIC_CHAINS` to include mainnet chains.
3. Add a credential store (environment-based or Vault) for contract signing keys.
4. Wire `matched_signal_id` from hazard events into the trigger evaluation.
