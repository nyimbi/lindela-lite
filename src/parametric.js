import crypto from 'node:crypto'
import { stableId, nowIso } from './utils.js'

export const PARAMETRIC_CHAINS = Object.freeze(['ethereum-sepolia', 'polygon-mumbai', 'celo-alfajores'])

const MAINNET_PATTERNS = ['mainnet', 'ethereum\x24', 'polygon\x24', 'celo\x24', 'homestead']

function isMainnet(chain) {
  const c = chain.toLowerCase()
  if (c.includes('mainnet') || c.includes('homestead')) return true
  // bare canonical names without a testnet qualifier
  if (c === 'ethereum' || c === 'polygon' || c === 'celo') return true
  return false
}

export function normalizeParametricRule(input, existing = null) {
  const now = nowIso()
  const chain = input.chain || existing?.chain
  if (!chain) throw Object.assign(new Error('chain is required'), { statusCode: 400 })

  if (isMainnet(chain)) {
    throw Object.assign(
      new Error(`Chain '${chain}' is not allowed: testnet-only per pilot commitment`),
      { statusCode: 400 }
    )
  }

  if (!PARAMETRIC_CHAINS.includes(chain)) {
    throw Object.assign(
      new Error(`chain must be one of: ${PARAMETRIC_CHAINS.join(', ')}`),
      { statusCode: 400 }
    )
  }

  const VALID_STATUSES = ['draft', 'active', 'paused', 'archived']
  const status = input.status || existing?.status || 'draft'
  if (!VALID_STATUSES.includes(status)) {
    throw Object.assign(new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`), { statusCode: 400 })
  }

  return {
    id: input.id || existing?.id || stableId('parametric_rule', [input.name, chain, now]),
    name: input.name || existing?.name || 'Unnamed rule',
    chain,
    contract_address: input.contract_address ?? existing?.contract_address ?? null,
    trigger_metric: input.trigger_metric ?? existing?.trigger_metric ?? null,
    trigger_threshold: input.trigger_threshold ?? existing?.trigger_threshold ?? null,
    disbursement_amount_local_currency: input.disbursement_amount_local_currency ?? existing?.disbursement_amount_local_currency ?? null,
    currency: input.currency || existing?.currency || 'USD',
    recipient_group_id: input.recipient_group_id ?? existing?.recipient_group_id ?? null,
    requires_focal_point_approval: Boolean(input.requires_focal_point_approval ?? existing?.requires_focal_point_approval ?? false),
    status,
    created_at: existing?.created_at || input.created_at || now,
    updated_at: now,
    metadata: input.metadata || existing?.metadata || {},
  }
}

export function simulateDisbursement(rule, { actor, focal_point_approved, sanctions } = {}) {
  if (rule.requires_focal_point_approval && !focal_point_approved) {
    throw Object.assign(
      new Error('Focal point approval required before simulation can proceed'),
      { statusCode: 409 }
    )
  }
  if (sanctions?.blocked) {
    throw Object.assign(
      new Error('Sanctions screening match blocks this disbursement; compliance review required'),
      { statusCode: 409, sanctions }
    )
  }
  const tx_hash = 'sim_' + crypto.createHash('sha256').update(rule.id + Date.now()).digest('hex').slice(0, 20)
  return {
    simulated: true,
    disbursement_id: stableId('disbursement', [rule.id, tx_hash]),
    chain: rule.chain,
    contract_address: rule.contract_address || null,
    tx_hash,
    amount: rule.disbursement_amount_local_currency,
    currency: rule.currency || 'USD',
    recipient_group_id: rule.recipient_group_id || null,
    rule_id: rule.id,
    actor: actor || null,
    status: 'simulated',
    // Three states, not two. `sanctions_screened: false` was true both when
    // nothing was screened because no recipient was supplied and when the SDN
    // list could not be reached; only the first is a deliberate choice by the
    // caller and the second is an outage. A compliance reader must be able to
    // tell those apart, so the state is a word rather than a boolean.
    // 'blocked' is not reachable here: a blocked disbursement throws above and
    // produces no record at all, which is the correct outcome.
    sanctions_status: sanctions?.screened ? 'clear' : 'not_screened',
    sanctions_screened: Boolean(sanctions?.screened),
    sanctions_matches: sanctions?.matches?.length || 0,
    sanctions_error: sanctions?.error || null,
    sanctions_reason: sanctions?.reason || null,
    simulated_at: nowIso(),
  }
}
