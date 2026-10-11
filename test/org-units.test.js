import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ORG_UNITS, ORG_UNIT_SYNONYMS, orgUnitByCode, orgUnitFor, parentOf, childrenOf,
  ancestorsOf, descendantsOf, rollupSlugsFor, orgUnitTree,
} from '../src/org-units.js'
import { KNOWN_DISTRICTS } from '../src/districts.js'
import { DEFAULT_REGIONS } from '../src/schema.js'

describe('administrative hierarchy (CAP-03)', () => {
  it('gives every unit a code, a level and a parent that resolves', () => {
    const codes = new Set(ORG_UNITS.map((u) => u.code))
    for (const unit of ORG_UNITS) {
      assert.ok(unit.code, `${unit.name} has no code`)
      assert.ok(Number.isInteger(unit.level), `${unit.code} has no level`)
      if (unit.parent_code !== null) {
        assert.ok(codes.has(unit.parent_code), `${unit.code} names a parent that does not exist: ${unit.parent_code}`)
        assert.ok(unit.level > ORG_UNITS.find((u) => u.code === unit.parent_code).level, `${unit.code} is not below its parent`)
      }
    }
  })

  it('states that a boundary is a centre and a radius, not a polygon', () => {
    // A reader who takes a 200 km circle for an administrative edge will
    // aggregate the wrong records, so the resolution is a field rather than an
    // assumption.
    for (const unit of ORG_UNITS.filter((u) => u.kind === 'district')) {
      assert.equal(unit.boundary_kind, 'center_radius', `${unit.code} does not say what its boundary is`)
      assert.ok(Number.isFinite(unit.radius_km) && unit.radius_km > 0, `${unit.code} has no radius`)
    }
  })

  it('resolves a code exactly and free text case-insensitively', () => {
    assert.equal(orgUnitByCode('KE-TURKANA').name, 'Turkana')
    assert.equal(orgUnitByCode('ke-turkana').name, 'Turkana', 'a code should not be case-sensitive')
    assert.equal(orgUnitByCode('not-a-code'), null)
    assert.equal(orgUnitFor('Turkana').code, 'KE-TURKANA')
    assert.equal(orgUnitFor('TURKANA').code, 'KE-TURKANA')
    assert.equal(orgUnitFor('turkana').code, 'KE-TURKANA')
    assert.equal(orgUnitFor('nowhere'), null)
    assert.equal(orgUnitFor(null), null)
  })

  it('resolves the synonym through the one table', () => {
    assert.equal(ORG_UNIT_SYNONYMS.moroto, 'UG-KARAMOJA')
    assert.equal(orgUnitFor('moroto').code, 'UG-KARAMOJA')
  })

  it('walks the hierarchy in both directions', () => {
    assert.equal(parentOf('KE-TURKANA').code, 'KE')
    assert.equal(parentOf('KE'), null)
    assert.deepEqual(childrenOf('KE').map((u) => u.code).sort(), ['KE-MANDERA', 'KE-TURKANA'])
    assert.deepEqual(ancestorsOf('KE-TURKANA').map((u) => u.code), ['KE', 'KE-TURKANA'])
    assert.deepEqual(childrenOf('nowhere'), [])
  })

  it('rolls a parent up over everything beneath it', () => {
    // The property the defect named as missing: a district split is an entry,
    // and a caller aggregating the parent picks up the new child without a code
    // change. `descendantsOf` is what makes that true.
    assert.deepEqual(descendantsOf('KE').map((u) => u.code), ['KE', 'KE-TURKANA', 'KE-MANDERA'])
    assert.deepEqual(rollupSlugsFor('KE').sort(), ['mandera', 'turkana'])
    // A leaf rolls up to itself, so a caller need not special-case the depth.
    assert.deepEqual(rollupSlugsFor('SS-BOR'), ['bor'])
    assert.deepEqual(rollupSlugsFor('nowhere'), [])
  })

  it('rolls up a newly added child with no other change', () => {
    // Simulates the split by checking the walk is structural rather than a
    // hard-coded list: the children of a code are whatever names it as parent.
    const kenya = childrenOf('KE').map((u) => u.code)
    assert.ok(kenya.includes('KE-TURKANA'))
    // Every unit that names KE as parent is in KE's rollup, by construction.
    const rollup = new Set(rollupSlugsFor('KE'))
    for (const unit of ORG_UNITS.filter((u) => u.parent_code === 'KE' && u.slug)) {
      assert.ok(rollup.has(unit.slug), `${unit.slug} is a child of KE but not in its rollup`)
    }
  })

  it('builds a tree whose roots are the countries', () => {
    const tree = orgUnitTree()
    assert.deepEqual(tree.map((n) => n.code).sort(), ['KE', 'SO', 'SS', 'UG'])
    const kenya = tree.find((n) => n.code === 'KE')
    assert.deepEqual(kenya.children.map((c) => c.code).sort(), ['KE-MANDERA', 'KE-TURKANA'])
    assert.deepEqual(kenya.children[0].children, [])
  })

  it('derives KNOWN_DISTRICTS from the registry without changing the published list', () => {
    // The page count is pinned by the API test; this asserts the projection is
    // the same five in the same order, so deriving did not reorder a list the
    // console reads.
    assert.deepEqual(KNOWN_DISTRICTS.map((d) => d.slug), ['turkana', 'aweil', 'bor', 'karamoja', 'mandera'])
    assert.equal(KNOWN_DISTRICTS.length, 5)
    assert.deepEqual(KNOWN_DISTRICTS[0], {
      slug: 'turkana', name: 'Turkana', country: 'KE', center: { lat: 3.1167, lon: 35.6 }, radius_km: 200,
      code: 'KE-TURKANA', parent_code: 'KE',
    })
  })

  it('derives DEFAULT_REGIONS from the registry without changing the pull list', () => {
    assert.deepEqual(DEFAULT_REGIONS, [
      { name: 'Turkana', country: 'KE', lat: 3.1167, lon: 35.6 },
      { name: 'Mogadishu', country: 'SO', lat: 2.0469, lon: 45.3182 },
      { name: 'Juba', country: 'SS', lat: 4.8594, lon: 31.5713 },
    ])
  })

  it('scopes a filter of a parent to every district beneath it', async () => {
    const { resolveDistrictFilter, recordInDistrict } = await import('../src/utils.js')
    const kenya = resolveDistrictFilter('Kenya')
    assert.equal(kenya.rollup, true)
    assert.deepEqual(kenya.slugs.sort(), ['mandera', 'turkana'])
    // The rollup reaches a record in either child, which is the payoff: a new
    // district under Kenya is covered without touching this function.
    assert.equal(recordInDistrict({ district: 'Turkana' }, kenya), true)
    assert.equal(recordInDistrict({ district: 'Mandera' }, kenya), true)
    assert.equal(recordInDistrict({ district: 'Bor' }, kenya), false, 'South Sudan is not in Kenya')
    // A leaf is unchanged, and still resolves its synonym.
    assert.equal(resolveDistrictFilter('turkana').rollup, undefined)
    assert.equal(resolveDistrictFilter('moroto').slug, 'karamoja')
    // A miss is still a miss: nothing is returned, not everything.
    assert.equal(resolveDistrictFilter('nowhere').unknown, true)
    assert.equal(recordInDistrict({ district: 'Turkana' }, resolveDistrictFilter('nowhere')), false)
  })

  it('does not publish a page for a unit the platform has never had one for', () => {
    // Juba and Mogadishu are known to the hierarchy and pulled for by the
    // weather connectors; neither has a district page, and deriving the list
    // must not have created one.
    assert.equal(orgUnitByCode('SS-JUBA').publishes_page, false)
    assert.equal(orgUnitFor('juba').publishes_page, false)
    assert.equal(KNOWN_DISTRICTS.some((d) => d.slug === 'juba'), false)
  })
})

describe('ENH-33 — one registry, so the map and the district page cannot disagree', () => {
  it('derives the map districts from the registry rather than typing them beside it', async () => {
    // `public/shared/basemap.js` carried `PILOT_DISTRICTS`, a hand-typed list of
    // the same five districts whose only guarantee was a comment reading
    // "matching src/districts.js". The map frame, the outbreak geocoder and the
    // district overlay all place units by it, so a centre corrected on the
    // server and not here put a district in two places depending on the surface.
    // The list is now the registry's own answer to `publishes_page`.
    const { PILOT_DISTRICTS } = await import('../public/shared/basemap.js')
    const published = ORG_UNITS.filter((unit) => unit.publishes_page)
    assert.equal(PILOT_DISTRICTS.length, published.length)
    for (const unit of published) {
      const mapped = PILOT_DISTRICTS.find((d) => d.slug === unit.slug)
      assert.ok(mapped, `${unit.slug} is published but the map does not carry it`)
      // The map reads `center` as [lon, lat]; the registry stores { lat, lon }.
      // Asserted rather than assumed, because a silent swap draws a district in
      // the ocean and no test would notice.
      assert.equal(mapped.center[0], unit.center.lon, `${unit.slug} longitude`)
      assert.equal(mapped.center[1], unit.center.lat, `${unit.slug} latitude`)
      assert.equal(mapped.radius_km, unit.radius_km, `${unit.slug} radius`)
      assert.equal(mapped.name, unit.name)
      assert.equal(mapped.country, unit.country)
    }
  })

  it('serves the registry the browser reads from the same file the server reads', async () => {
    // The whole point of the split: `src/org-units.js` re-exports
    // `public/shared/org-units.js` rather than restating it. If these ever
    // diverge, the module is a second copy and the defect is back.
    const shared = await import('../public/shared/org-units.js')
    const server = await import('../src/org-units.js')
    assert.equal(server.ORG_UNITS, shared.ORG_UNITS, 'the two registry modules are not one object')
  })

  it('still resolves the hierarchy through the re-export', () => {
    // A re-export that dropped a name would break a caller at import time, not
    // here, so the walk is exercised to prove the names arrive working.
    assert.equal(orgUnitByCode('KE').name, 'Kenya')
    assert.deepEqual(rollupSlugsFor('KE').sort(), ['mandera', 'turkana'])
    assert.equal(descendantsOf('KE').length, 3)
    assert.equal(ancestorsOf('KE-TURKANA').map((u) => u.code).join('>'), 'KE>KE-TURKANA')
    assert.equal(parentOf('KE-TURKANA').code, 'KE')
    assert.equal(orgUnitTree().length, 4)
  })
})
