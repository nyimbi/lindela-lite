#!/usr/bin/env node
/**
 * The served surface is compared against the published contract, method by
 * method — not path by path.
 *
 * `check-openapi.mjs` compares **paths**, and says so in its own header: "a
 * handler serving GET on the list and POST on the detail is modelled as serving
 * both methods on both paths … a wrong method is a documentation nicety; a wrong
 * path is a client that cannot call the endpoint." That was a defensible scope
 * until the same defect class was found three times, each time by hand:
 *
 *   - **VER-14.** Four read routes with no verb test answered `DELETE` with a
 *     200 and the full listing.
 *   - **VER-17.** `service-assets` gained a by-id read, and the matcher — which
 *     serves a collection, not a verb — also routed PATCH and DELETE into write
 *     branches backed by normalisers that do not know the collection. Both
 *     answered **500**.
 *   - **The sweep that found VER-17's siblings.** Re-run against the whole
 *     surface, it found seven more routes ignoring the verb, plus two working
 *     GETs the contract never declared.
 *
 * A defect class found three times by three ad-hoc sweeps is a class with no
 * gate. This is the gate.
 *
 * **What it asserts.** For every path the OpenAPI document declares, every HTTP
 * verb is driven against a live server, and the answer must be one of:
 *
 *   - the verb is declared in the document and the route answers it;
 *   - the verb is not declared and the route refuses it — any 4xx is a refusal,
 *     because 404, 405 and 400 all say "no" and which one is a separate
 *     question this check does not own;
 *   - the verb is not declared and the route answers 200, and the path is named
 *     in `METHOD_AGNOSTIC` below with the reason. `metrics` is the only entry:
 *     a Prometheus scrape endpoint is method-agnostic by convention and sits in
 *     the inbound limiter's unlimited list for the same reason.
 *
 * The failure it exists to catch is the third case arriving unnamed — a 200 (or,
 * as with VER-17, a 500) on a method the contract does not offer. That is the
 * served surface being wider than the published one, which a client cannot see
 * and cannot defend against.
 *
 * **Why a live server.** The verb gating is not readable from the source. A
 * matcher that ignores the method, a handler whose `GET && id` branch runs
 * before its action branches, and a route that honours the verb all look alike
 * in a regex. The only evidence for what a verb does is a request carrying that
 * verb, which is CLAUDE.md's "probe the live ingress, not the route function".
 *
 * Binds an ephemeral port on 127.0.0.1, so it needs nothing started.
 */

import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = path.join(root, 'docs/openapi.yaml')

/** The verbs driven. HEAD is answered as GET upstream and carries no method of its own. */
export const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/**
 * Paths where an undeclared verb legitimately answers 200.
 *
 * Each needs a reason, because the reason is the thing a reviewer checks — an
 * allowlist without one is how a gate becomes a place to hide a finding.
 */
export const METHOD_AGNOSTIC = new Map([
  ['/api/v1/metrics', 'a Prometheus scrape endpoint is method-agnostic by convention, and it sits in the inbound limiter\'s UNLIMITED list for the same reason'],
])

/**
 * Every path the document declares, and the methods under it.
 *
 * Two-space indentation for a path, four for a method — the shape
 * `check-route-envelopes.mjs` reads, kept identical so the two gates cannot
 * disagree about what the document says.
 */
export function documentedRoutes(spec) {
  const routes = []
  let current = null
  for (const line of spec.split('\n')) {
    const p = /^ {2}(\/[^:]+):$/.exec(line)
    if (p) { current = { path: p[1], methods: [] }; routes.push(current); continue }
    const m = /^ {4}(get|post|put|patch|delete):$/.exec(line)
    if (m && current) current.methods.push(m[1].toUpperCase())
  }
  return routes.filter((r) => r.methods.length)
}

/**
 * One finding, in the shape the CLI prints and the canaries assert on.
 *
 * **The jurisdiction is the undeclared verb, and nothing else.** A declared verb
 * that answers 5xx is a real thing to know, but it is not this check's question,
 * and including it was the first thing this gate did — it flagged four routes on
 * a clean tree: `GET /api/v1/health` answering 503 (documented in the spec),
 * `POST /api/v1/rapidpro/{reply,field-report}` answering 503 because
 * `RAPIDPRO_WEBHOOK_SECRET` is unset (a deliberate refusal that names the
 * variable to set), and `GET /api/v1/alert-events/{id}.cap` answering 500 on an
 * unrecognised alert status (the refusal `check-route-envelopes.mjs` names in
 * its own header). All four are correct behaviour. A gate that fails on correct
 * behaviour is a gate that gets disabled, so the rule is gone rather than
 * allowlisted — an allowlist of four would be four places to hide the next one.
 *
 * What remains is the one question the contract cannot answer for itself: is a
 * verb the document does not declare refused?
 */
export function judge({ path: routePath, verb, declared, status }) {
  if (declared.includes(verb)) return null
  if (status === 404) return null
  if (status >= 400 && status < 500) return null
  if (status === 200 && METHOD_AGNOSTIC.has(routePath)) return null
  if (status >= 500) {
    return {
      rule: 'undeclared-crash', route: routePath, verb, status,
      detail: `the contract does not declare ${verb} and the route answered ${status}; an over-wide surface reached a code path that crashed, so the caller is told the deployment is broken rather than that the verb is not offered`,
    }
  }
  return {
    rule: 'undeclared-served', route: routePath, verb, status,
    detail: `the contract does not declare ${verb} and the route answered ${status}; a client reading the document has no reason to send this verb, and one that does is served a response the contract never promised`,
  }
}

/** Drive the whole surface and collect the findings. */
export async function scanRoutes() {
  process.env.LINDELA_LITE_LOG_LEVEL ||= 'fatal'
  const { createServer } = await import('../src/server.js')
  const { JsonStore } = await import('../src/store.js')
  const { emptyStore } = await import('../src/schema.js')
  const routes = documentedRoutes(readFileSync(SPEC, 'utf8'))

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lindela-methods-'))
  const store = new JsonStore(path.join(dir, 'store.json'))
  // A probe record per collection, so a by-id branch reaches its record rather
  // than its 404 — a 404 would be read as a refusal and hide the branch.
  const seeded = {}
  for (const [collection, records] of Object.entries(emptyStore())) {
    if (!Array.isArray(records) || records.length) continue
    seeded[collection] = [{
      id: 'probe-id', type: collection, name: 'Probe', title: 'Probe', description: 'Probe',
      status: 'active', state: 'closed', severity: 'high', source: 'open_meteo',
      district: 'Turkana', country: 'KE', latitude: 3.1, longitude: 36.5,
      observed_at: '2024-03-01T00:00:00Z', created_at: '2024-03-01T00:00:00Z',
    }]
  }
  await store.merge(seeded)
  const unlimited = { charge: () => ({ allowed: true, release: () => {} }) }
  const listener = createServer({ store, inboundLimiter: unlimited }).listen(0)
  const base = `http://127.0.0.1:${listener.address().port}`

  const findings = []
  let checked = 0
  try {
    for (const route of routes) {
      const concrete = route.path.replace(/\{[^}]+\}/g, 'probe-id')
      for (const verb of VERBS) {
        let status
        try {
          const res = await fetch(`${base}${concrete}`, {
            method: verb,
            headers: { 'content-type': 'application/json' },
            body: ['POST', 'PUT', 'PATCH'].includes(verb) ? '{}' : undefined,
            signal: AbortSignal.timeout(4000),
          })
          status = res.status
        } catch {
          continue
        }
        checked += 1
        const finding = judge({ path: route.path, verb, declared: route.methods, status })
        if (finding) findings.push(finding)
      }
    }
  } finally {
    listener.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
  return { findings, checked, paths: routes.length }
}

/**
 * Canaries, driven through `judge` with text rather than through a server — the
 * same reason `check-route-envelopes.mjs` drives `checkEnvelope`: a canary that
 * boots a server to test a rule can fail for a reason the rule does not name.
 *
 * Both directions are covered, because a check that flags everything and a check
 * that flags nothing are the same bug wearing different clothes.
 */
export const CANARIES = [
  { name: 'passes a declared verb that answers', input: { path: '/api/v1/x', verb: 'GET', declared: ['GET'], status: 200 }, expect: 0 },
  { name: 'passes a declared verb that refuses with a 4xx', input: { path: '/api/v1/x', verb: 'POST', declared: ['POST'], status: 400 }, expect: 0 },
  { name: 'flags an undeclared verb served a 200 — the VER-14 shape', input: { path: '/api/v1/x', verb: 'DELETE', declared: ['GET'], status: 200 }, expect: 1 },
  { name: 'flags an undeclared verb that crashed — the VER-17 shape', input: { path: '/api/v1/x', verb: 'PATCH', declared: ['GET'], status: 500 }, expect: 1 },
  // The jurisdiction boundary, and the reason this rule is not `declared-crash`.
  // `/api/v1/health` documents a 503; rapidpro's webhook answers 503 when its
  // secret is unset; the CAP renderer answers 500 on an unrecognised status.
  // All three are correct, and a gate that flagged them would fail on a clean
  // tree. This canary is that boundary stated as a test.
  { name: 'does not flag a declared verb that answers 5xx, which is another check\'s question', input: { path: '/api/v1/health', verb: 'GET', declared: ['GET'], status: 503 }, expect: 0 },
  { name: 'passes an undeclared verb refused with 404', input: { path: '/api/v1/x', verb: 'PUT', declared: ['GET'], status: 404 }, expect: 0 },
  { name: 'passes an undeclared verb refused with 405', input: { path: '/api/v1/x', verb: 'PATCH', declared: ['GET'], status: 405 }, expect: 0 },
  { name: 'passes an undeclared verb refused with 400', input: { path: '/api/v1/x', verb: 'POST', declared: ['GET'], status: 400 }, expect: 0 },
  { name: 'exempts a named method-agnostic path', input: { path: '/api/v1/metrics', verb: 'DELETE', declared: ['GET'], status: 200 }, expect: 0 },
  // The exemption must be the path, not the shape: another route serving 200 to
  // an undeclared verb is still a finding.
  { name: 'still flags an unnamed path served a 200', input: { path: '/api/v1/y', verb: 'DELETE', declared: ['GET'], status: 200 }, expect: 1 },
  // The exemption is scoped to 200. A method-agnostic path that *crashed* on an
  // undeclared verb is still a finding, because the reason for the exemption
  // (Prometheus scrapes it) says nothing about a 500.
  { name: 'still flags a crash on a method-agnostic path', input: { path: '/api/v1/metrics', verb: 'DELETE', declared: ['GET'], status: 500 }, expect: 1 },
]

async function selfTest() {
  let failed = 0
  const expectations = new Set(CANARIES.map((c) => c.expect))
  if (expectations.size < 2) {
    console.log('FAIL the canary expectations are uniform, so a constant checker would satisfy them')
    failed += 1
  }
  for (const canary of CANARIES) {
    const got = judge(canary.input) ? 1 : 0
    const ok = got === canary.expect
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${canary.name} — expected ${canary.expect}, got ${got}`)
  }
  console.log(failed === 0 ? '\nall canaries passed' : `\n${failed} canary failure(s)`)
  return failed === 0 ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest())
  const { findings, checked, paths } = await scanRoutes()
  if (findings.length === 0) {
    console.log(`route method check: clean — ${checked} verb(s) across ${paths} documented path(s)`)
    process.exit(0)
  }
  console.error(`route method check: ${findings.length} finding(s) across ${checked} verb(s)\n`)
  for (const f of findings) console.error(`  [${f.rule}] ${f.verb} ${f.route} → ${f.status}\n    ${f.detail}`)
  console.error('\nA method the contract does not declare must be refused. Answering it — with a')
  console.error('200 or, worse, a 500 — makes the served surface wider than the published one,')
  console.error('and a client reading the document has no way to see that. Either gate the verb')
  console.error('at the matcher, or declare it in docs/openapi.yaml. A path that is legitimately')
  console.error('method-agnostic belongs in METHOD_AGNOSTIC with its reason.')
  process.exit(1)
}
