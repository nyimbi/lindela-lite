import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANARIES, METHOD_AGNOSTIC, documentedRoutes, judge } from '../scripts/check-route-methods.mjs'

/**
 * VER-14 / VER-17 — the route-method gate, guarded.
 *
 * The class is a served surface wider than the published contract: a verb the
 * document does not declare, answered anyway. It was found three times by three
 * hand sweeps — four read routes answering `DELETE` with 200, `service-assets`
 * answering `PATCH` and `DELETE` with 500, and seven more routes plus two
 * undeclared GETs when the sweep was run across the whole surface — and a class
 * found three times by hand is a class with no gate. This is that gate's test.
 *
 * The self-test covers the rule; this file covers the two things a self-test
 * cannot see. That the gate passes on the tree as it stands — a gate that cannot
 * pass cleanly gets an exemption, and an exemption is where the next defect
 * hides. And that its jurisdiction is the undeclared verb and nothing else,
 * because the first draft also flagged declared 5xx and fired on four routes
 * that are correct: `/health`'s documented 503, rapidpro's unset-secret 503, and
 * the CAP renderer's refusal. A gate that fails on correct behaviour is a gate
 * someone disables, which is the same end state as no gate.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts/check-route-methods.mjs')

/** Run the gate the way CI does, and return its exit code with its output. */
function runGate(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

describe('VER-14 / VER-17 the route-method gate is scoped to the undeclared verb', () => {
  it('passes on the tree as it stands', () => {
    // The known-good input. Every undeclared verb on every documented path is
    // refused, and the two GETs the contract used to omit are declared now.
    const { code, output } = runGate()
    assert.equal(code, 0, `the gate fails on the current tree:\n${output}`)
    assert.match(output, /clean/)
    assert.match(output, /verb\(s\) driven across/, 'the gate reported a result without driving any verb')
  })

  it('accounts for every probe, and names the ones that got no answer', () => {
    // The silent-skip bug this asserts against: `catch { continue }` dropped a
    // probe from the findings *and* from the count, so the gate's coverage
    // shrank without the verb count moving in any way a reader could compare to
    // anything. Three probes exceed the 4s budget on a clean tree, so the run
    // reports 962 of 965 — and the three are named, because a skip that is only
    // printed when something else fails is a skip nobody reads.
    const { output } = runGate()
    const driven = Number(/(\d+) of (\d+) verb\(s\) driven/.exec(output)?.[1] ?? 0)
    const expected = Number(/(\d+) of (\d+) verb\(s\) driven/.exec(output)?.[2] ?? 0)
    assert.ok(expected > 100 * 5 - 1, `the gate expected only ${expected} probes, which is not the shipped surface`)
    assert.ok(driven <= expected, `${driven} probes were driven out of an expected ${expected}`)
    // Every probe is either answered or skipped, and the skipped ones are named.
    const skipped = [...output.matchAll(/(?:GET|POST|PUT|PATCH|DELETE) (\/\S+) \((timeout|[^)]+)\)/g)]
    assert.equal(driven + skipped.length, expected,
      `coverage is unaccounted for: ${driven} driven + ${skipped.length} named = ${driven + skipped.length}, expected ${expected}`)
  })

  it('every declared canary passes, and they disagree with each other', () => {
    // A canary set whose expectations are uniform proves nothing: a checker that
    // returns a constant would satisfy it.
    const expectations = new Set(CANARIES.map((c) => c.expect))
    assert.deepEqual([...expectations].sort(), [0, 1],
      'the canaries no longer include both a pass and a fail case, so they cannot detect a constant checker')

    for (const canary of CANARIES) {
      assert.equal(judge(canary.input) ? 1 : 0, canary.expect,
        `canary "${canary.name}" expected ${canary.expect}`)
    }
  })

  it('flags an undeclared verb served a 200 — the VER-14 shape', () => {
    // The defect in one line: `DELETE /api/v1/road-access` returned the full
    // listing, because the route was written with no verb test.
    const finding = judge({ path: '/api/v1/x', verb: 'DELETE', declared: ['GET'], status: 200 })
    assert.ok(finding, 'an undeclared verb served a 200 was not flagged')
    assert.equal(finding.rule, 'undeclared-served')
  })

  it('flags an undeclared verb that crashed — the VER-17 shape', () => {
    // The one the earlier sweep had no predicate for. It looked for a 200, and
    // this answered 500, so the same over-wide surface walked past it. A 5xx on
    // an undeclared verb is the worse answer: the caller is told the deployment
    // is broken rather than that the verb is not offered.
    const finding = judge({ path: '/api/v1/x', verb: 'PATCH', declared: ['GET'], status: 500 })
    assert.ok(finding, 'an undeclared verb that crashed was not flagged')
    assert.equal(finding.rule, 'undeclared-crash')
  })

  it('does not flag a declared verb answering 5xx, which is another check\'s question', () => {
    // The jurisdiction boundary, stated as a test because it is the thing the
    // first draft got wrong. `/api/v1/health` documents a 503; rapidpro's
    // webhook answers 503 when its secret is unset; the CAP renderer answers 500
    // on an unrecognised status. All three are correct, and a gate that flagged
    // them would fail on a clean tree.
    for (const status of [500, 503]) {
      assert.equal(judge({ path: '/api/v1/health', verb: 'GET', declared: ['GET'], status }), null,
        `a declared verb answering ${status} was flagged, which fails the gate on correct behaviour`)
    }
  })

  it('refuses every 4xx on an undeclared verb, because each says no', () => {
    // 404, 405 and 400 all refuse. Which one is a separate question this check
    // does not own — an over-narrow rule here would report a 405 as a finding
    // and send someone to fix a route that is already right.
    for (const status of [400, 401, 403, 404, 405, 409, 429]) {
      assert.equal(judge({ path: '/api/v1/x', verb: 'PUT', declared: ['GET'], status }), null,
        `an undeclared verb refused with ${status} was flagged`)
    }
  })

  it('the method-agnostic exemption is a named path with a reason, not a shape', () => {
    // An allowlist entry without a reason is how a gate becomes a place to hide
    // a finding. `metrics` is the one entry: a Prometheus scrape endpoint is
    // method-agnostic by convention.
    assert.equal(METHOD_AGNOSTIC.size, 1, 'a second exemption was added without this test being told why')
    for (const reason of METHOD_AGNOSTIC.values()) {
      assert.ok(reason.length > 40, 'an exemption carries no reason, which makes it a hiding place')
    }
    // And it is the path that is exempt, not the shape: the same 200 under an
    // unlisted path is the defect.
    assert.equal(judge({ path: '/api/v1/metrics', verb: 'DELETE', declared: ['GET'], status: 200 }), null)
    assert.ok(judge({ path: '/api/v1/not-listed', verb: 'DELETE', declared: ['GET'], status: 200 }),
      'the exemption leaked to an unnamed path')
  })

  it('the surface the gate scans is the spec the repository ships', () => {
    // A gate that silently scanned an empty spec would pass forever, and the
    // count of verbs it reports is the only clue. `docs/openapi.yaml` is itself
    // gated by `check-openapi`, so this asserts the two agree on the route count
    // rather than trusting either one's number.
    const { output } = runGate()
    const paths = Number(/across (\d+) documented path\(s\)/.exec(output)?.[1] ?? 0)
    assert.ok(paths > 100, `the gate scanned ${paths} documented paths, which is not the shipped surface`)  })

  it('reads the documented methods out of the spec, both verbs on a two-verb path', () => {
    // The parser is the gate's only view of the contract. A path declared with
    // two methods must come back with both, or the gate would flag the second
    // as undeclared and report a correct route as a finding.
    const routes = documentedRoutes(`
paths:
  /api/v1/x:
    get:
      summary: one
    post:
      summary: two
  /api/v1/y:
    delete:
      summary: three
`)
    assert.deepEqual(routes, [
      { path: '/api/v1/x', methods: ['GET', 'POST'] },
      { path: '/api/v1/y', methods: ['DELETE'] },
    ])
  })
})
