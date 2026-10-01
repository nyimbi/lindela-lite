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

## Sanctions screening

Autonomous disbursement triggers move money without a human in the loop, so the
simulate endpoint accepts an optional `recipient_name` and screens it against
the published OFAC SDN list before simulating.

```json
{
  "focal_point_approved": true,
  "actor": "ops-lead",
  "recipient_name": "Banco Nacional De Cuba"
}
```

The list is fetched once and cached for 24 hours (`OFAC_SDN_CACHE_TTL_MS`).

**A match returns HTTP 409 and records nothing.** The response includes the
matched SDN entries so a reviewer can act:

```json
{
  "success": false,
  "error": "Sanctions screening match blocks this disbursement; compliance review required",
  "sanctions": {
    "screened": true,
    "blocked": true,
    "matches": [{ "name": "Banco Nacional De Cuba", "entry": { "id": "306", "name": "BANCO NACIONAL DE CUBA", "type": "-0-" } }]
  }
}
```

A clean screen returns 201 with `sanctions_screened: true` and the match count
recorded on the disbursement, so a later audit can tell screened disbursements
from unscreened ones.

### Limits

This is a name screen, not a compliance product. It does not:

- resolve blockchain addresses or transaction history
- do fuzzy, phonetic, or transliteration-tolerant matching
- screen against non-SDN lists (EU, UN, HMT)

Corporate suffixes and punctuation are normalized, so `Aerocaribbean Airlines,
Inc.` matches `AEROCARIBBEAN AIRLINES`, and names shorter than four characters
are skipped to avoid noisy matches. **A match means "a human must review this",
never "this is a criminal"** — treat the result as a review queue, not a verdict.

If the SDN list cannot be fetched, screening reports `screened: false` with the
underlying error and the simulation still proceeds. That is deliberate: an
outage at OFAC should not halt humanitarian payments. In a regulated
deployment, invert that default.

## Transition to real disbursement (post-pilot)

When a real pilot is approved:
1. Replace the `simulateDisbursement` function in `src/parametric.js` with a real on-chain transaction via a wallet provider (e.g. ethers.js or viem).
2. Remove the testnet-chain guard or expand `PARAMETRIC_CHAINS` to include mainnet chains.
3. Add a credential store (environment-based or Vault) for contract signing keys.
4. Wire `matched_signal_id` from hazard events into the trigger evaluation.
5. Replace the name screen with address-level screening before real funds move.
   Name matching cannot detect a sanctioned wallet behind an innocuous
   recipient name; before mainnet, screen addresses against the OFAC
   digital-currency address list and add EU/UN/HMT lists.
