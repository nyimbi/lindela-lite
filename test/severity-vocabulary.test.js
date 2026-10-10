import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeSeverity, severityWeight } from '../src/schema.js'
import { normalizeAlertRule } from '../src/alerts.js'
import { computeRoadAccess } from '../src/road-access.js'

/**
 * ARC-04 — one severity vocabulary, or the same record scores differently on
 * every path that reads it.
 *
 * The audit found `normalizeSeverity`/`severityWeight` implemented three times
 * with three mappings: `src/schema.js` (the canonical one), a local copy in
 * `src/alerts.js` that validates against `PRIORITY_LEVELS`, and a
 * `severityWeight` in `src/road-access.js` returning 3/2/1 and folding
 * `medium` with `green`. A fourth transcription lives in the browser
 * (`public/shared/viz-explain.js`), guarded by a test that reads the schema's
 * numbers back — which is the right shape for a module that cannot import from
 * `src/`, and is left alone here.
 *
 * The two server-side copies were both wrong in the same direction and neither
 * wrongness was visible, because each was internally consistent with its own
 * table:
 *
 * - `alerts.js` — `'red'`, `'orange'` and `'green'` are not members of
 *   `PRIORITY_LEVELS`, so every one of them fell to the `'medium'` default. An
 *   alert rule declared `severity: 'red'` was stored as `'medium'`, which is a
 *   published severity that is not the one anybody asked for.
 * - `road-access.js` — `'severe'`, `'extreme'`, `'minor'` and a bare `'low'`
 *   matched no case and returned **0**, below a green advisory. The blocking
 *   rule is `severity_weight >= 2`, so a GDACS `'severe'` flood was admitted to
 *   the obstruction list and then could not block a road on severity, while a
 *   `'medium'` flood could.
 *
 * Both now call the schema's function. These tests are the ones that fail on
 * the old code.
 */
describe('ARC-04 — the alert rule keeps the severity it was given', () => {
  it('does not downgrade a red alert rule to medium', () => {
    // The defect, directly: `'red'` is the schema's spelling for critical and
    // was stored as `'medium'` — one rung from the bottom of a four-rung scale.
    const rule = normalizeAlertRule({ name: 'Red', metric: 'flood_risk_score', threshold: 70, severity: 'red' })
    assert.equal(rule.severity, 'critical',
      "'red' is critical; the local normaliser did not know the word and defaulted it to medium")
  })

  it('reads every severity word the schema reads', () => {
    for (const [input, expected] of [
      ['red', 'critical'], ['extreme', 'critical'], ['critical', 'critical'],
      ['orange', 'high'], ['severe', 'high'], ['high', 'high'],
      ['yellow', 'medium'], ['moderate', 'medium'], ['medium', 'medium'],
      ['green', 'low'], ['minor', 'low'], ['low', 'low'],
    ]) {
      const rule = normalizeAlertRule({ name: input, metric: 'flood_risk_score', threshold: 1, severity: input })
      assert.equal(rule.severity, expected, `severity ${input}`)
    }
  })

  it('keeps the default when no severity was supplied at all', () => {
    // The default is the rule's, not the normaliser's: an absent severity is
    // `medium` because `normalizeAlertRule` says so, and that has to keep
    // working when the normaliser is the schema's — which returns `'unknown'`
    // for an empty value.
    const rule = normalizeAlertRule({ name: 'Default', metric: 'flood_risk_score', threshold: 1 })
    assert.equal(rule.severity, 'medium')
  })
})

describe('ARC-04 — road access ranks severity on the same scale as everything else', () => {
  const ROAD = {
    id: 'r1', name: 'A109', road_class: 'trunk', country: 'KE',
    service_type: 'road', latitude: -1.28, longitude: 36.81,
  }
  const hazard = (over) => ({
    id: 'h1', event_type: 'flood', title: 'Flood', latitude: -1.28, longitude: 36.81,
    occurred_at: '2026-10-10T00:00:00.000Z', ...over,
  })
  const access = (hazards) => computeRoadAccess(
    { service_assets: [ROAD], hazard_events: hazards },
    { now: new Date('2026-10-11T00:00:00.000Z') },
  )[0]

  it('lets a severe flood block a road on severity, not only on distance', () => {
    // `'severe'` is the schema's spelling for high, and the old table returned 0
    // for it — below `'medium'` — so the blocking rule `severity_weight >= 2`
    // refused it. The hazard is ~1.7 km out, past the 1 km proximity rule, so
    // severity is the only thing that can block it.
    const road = access([hazard({ severity: 'severe', longitude: 36.825 })])
    assert.equal(road.obstructions[0].blocking, true,
      "'severe' is high severity; a high-severity flood near a road blocks it")
    assert.equal(road.access_status, 'impassable')
  })

  it('ranks a critical hazard above a high one, and both above a green advisory', () => {
    // Placed ~1.7 km out, past the 1 km proximity rule, so colour is the only
    // thing that can block — a hazard on top of the road blocks whatever its
    // colour, which is the module's stated rule and not what this tests.
    const rank = (severity) => access([hazard({ severity, longitude: 36.825 })]).obstructions[0]
    assert.ok(rank('critical').blocking, 'critical blocks')
    assert.ok(rank('red').blocking, "'red' is critical")
    assert.ok(rank('high').blocking, 'high blocks')
    assert.equal(rank('green').blocking, false, 'a green advisory does not block')
  })

  it('scores a hazard the same way on every path that reads its severity', () => {
    // The property the defect broke: the number road-access computes for a
    // hazard and the number the schema assigns it must be the same function.
    // Not the same scale — the same *ordering*, which is what the blocking
    // threshold and the sort both depend on.
    const order = ['unknown', 'low', 'medium', 'high', 'critical']
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(severityWeight(order[i]) > severityWeight(order[i - 1]),
        `${order[i]} must outweigh ${order[i - 1]}`)
    }
  })
})
