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
