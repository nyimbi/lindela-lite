import crypto from 'node:crypto'
import { stableId, nowIso } from './utils.js'
import { OPERATORS, compare, resolveMetric } from './alerts.js'

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

  const triggerOperator = input.trigger_operator ?? existing?.trigger_operator ?? '>='
  if (!OPERATORS.includes(triggerOperator)) {
    throw Object.assign(new Error(`trigger_operator must be one of ${OPERATORS.join(', ')}`), { statusCode: 400 })
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
    // A parametric trigger needs all three to be decidable. A metric with no
    // threshold is a condition nobody can evaluate, and storing it as if it
    // were a rule is how a payout becomes a request.
    trigger_operator: input.trigger_operator ?? existing?.trigger_operator ?? '>=',
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

/**
 * Decide whether the rule's trigger is satisfied.
 *
 * The trigger was previously stored and never read: `simulateDisbursement`
 * copied the static amount regardless of the world. Three outcomes, not two,
 * because "not triggered" and "could not be evaluated" are different facts and
 * a payout workflow must be able to tell them apart.
 *
 * - `met: true` -- the observed value crossed the threshold. Payable.
 * - `met: false` -- it did not. Not payable, and the record says by how much.
 * - `met: null` -- the rule defines no trigger, or the metric did not resolve
 *   to a number against the context supplied. Not payable.
 */
export function evaluateTrigger(rule, context = {}, { value: supplied } = {}) {
  const metric = rule.trigger_metric ?? null
  const operator = rule.trigger_operator || '>='
  const threshold = rule.trigger_threshold ?? null

  if (!metric || threshold === null) {
    return {
      defined: false,
      metric,
      operator,
      threshold,
      value: null,
      source: null,
      met: null,
      note: metric
        ? `trigger metric "${metric}" has no threshold, so no condition exists to evaluate`
        : 'this rule defines no trigger metric, so the payout is a request rather than a parametric payment',
    }
  }

  const observed = supplied !== undefined ? supplied : resolveMetric(context, metric)
  const value = Number.isFinite(Number(observed)) && observed !== null && observed !== ''
    ? Number(observed)
    : null
  if (value === null) {
    return {
      defined: true,
      metric,
      operator,
      threshold,
      value: null,
      met: null,
      note: supplied !== undefined
        ? `supplied trigger value ${JSON.stringify(supplied)} is not a number, so the trigger could not be evaluated -- an unevaluated trigger is not a triggered one`
        : `trigger metric "${metric}" did not resolve to a number, so the trigger could not be evaluated -- an unevaluated trigger is not a triggered one`,
    }
  }

  return {
    defined: true,
    metric,
    operator,
    threshold,
    value,
    source: supplied !== undefined ? 'supplied' : 'context',
    met: compare(value, operator, threshold),
    note: null,
  }
}

export function simulateDisbursement(rule, { actor, focal_point_approved, sanctions, context, triggerValue, approval } = {}) {
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

  const trigger = evaluateTrigger(rule, context, { value: triggerValue })
  // `approval` is the richer form the route builds; the bare boolean is still
  // accepted for direct callers, and is honestly recorded as an assertion
  // rather than upgraded into a verification it did not get.
  const approvalGiven = approval?.approved ?? Boolean(focal_point_approved)
  const approvalSource = approval?.source || (focal_point_approved ? 'request_body' : null)
  // A payout that fires without its trigger being satisfied is the defect this
  // function used to have. An unmet or unevaluable trigger pays nothing and
  // mints no transaction; the record still exists, because "we evaluated and
  // it did not fire" is an audit fact an insurer needs.
  const payable = trigger.met === true

  return {
    simulated: true,
    disbursement_id: stableId('disbursement', [rule.id, trigger.metric, trigger.value, String(trigger.met), String(Date.now())]),
    chain: rule.chain,
    contract_address: rule.contract_address || null,
    // null, not 0, when nothing is owed: zero is a measured payout of
    // nothing, null is "no payout was due".
    amount: payable ? rule.disbursement_amount_local_currency : null,
    currency: rule.currency || 'USD',
    recipient_group_id: rule.recipient_group_id || null,
    rule_id: rule.id,
    actor: actor || null,
    status: trigger.met === null ? 'trigger_not_evaluated' : payable ? 'simulated' : 'trigger_not_met',
    trigger,
    // The gate was a boolean the caller set in the request body, so a payout
    // could be approved by the same request that requested it. The record now
    // says where the approval came from, and says plainly when it was
    // self-asserted -- which is a fact a compliance reader needs, not a
    // failure mode to hide behind a true.
    focal_point_approval: {
      approved: approvalGiven,
      required: Boolean(rule.requires_focal_point_approval),
      source: approvalSource,
      verified: approvalSource === 'workflow',
      workflow_instance_id: approval?.workflow_instance_id || null,
      approved_by: approval?.approved_by || (focal_point_approved ? actor || null : null),
      note: !approvalGiven
        ? 'no approval was presented'
        : approvalSource === 'workflow'
          ? 'confirmed by a parametric_disbursement workflow instance'
          : 'self-asserted in the request body; no workflow instance backs it',
    },
    // No transaction is minted for a payout that is not payable. A tx_hash on
    // a trigger that did not fire is a hash of nothing.
    tx_hash: payable
      ? 'sim_' + crypto.createHash('sha256').update(rule.id + Date.now()).digest('hex').slice(0, 20)
      : null,
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
