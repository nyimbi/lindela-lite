import { ACCESS_BLOCKING_HAZARDS } from './schema.js'
import { clamp, haversineKm, stableId } from './utils.js'

/**
 * Routing over the road network, respecting current access status.
 *
 * Answers the operational question "the road to this clinic is under water —
 * how do we actually get there?". This is deliberately a routing problem over
 * an explicit asset graph, not a general-purpose network engine: Lindela Lite
 * knows roads only where the operator has imported them, and inventing a
 * network that does not exist would produce confident nonsense.
 *
 * Cost model
 * ----------
 * Edge cost is travel time, inflated by access condition:
 *
 *   impassable -> edge removed entirely (no finite penalty is a barrier)
 *   restricted -> time multiplied by a penalty that scales with road class,
 *                 because a truck route detouring onto an unclassified track
 *                 is a different proposition from a bicycle on a cycleway
 *   passable   -> baseline cost
 *
 * Class weights reflect what each road is for: a trunk route is fast and
 * heavily depended upon; an unpaved track is slow and has no alternatives.
 *
 * What this does not do: it does not know about bridges, culverts, ferry
 * crossings, seasonal causeways, or load limits. If the operator has not
 * imported that as an asset, the router cannot reason about it. Every result
 * therefore reports the road classes it relied on, so a caller can judge
 * whether the answer is worth trusting.
 */

const CLASS_BASE_KMH = {
  trunk: 60,
  primary: 50,
  secondary: 40,
  tertiary: 30,
  unpaved: 20,
  track: 10,
}

// A restricted trunk road is still better than a clear dirt track, so the
// penalty is a multiplier on time rather than an additive cost.
const RESTRICTED_PENALTY = {
  trunk: 1.8,
  primary: 2.2,
  secondary: 3.0,
  tertiary: 4.0,
  unpaved: 5.0,
  track: 7.0,
}

// Above this, a convoy is a liability on the road. The fastest
// truck-reachable class is 'unpaved' at 20 km/h; tracks and unclassified
// routes sit below it, meaning no vehicle can be assumed. A motorcycle or
// tractor can still manage them — this is a statement about what the operator
// may safely send down the route, not a claim about what is physically
// possible.
const VEHICLE_MIN_KMH = 15

/**
 * Builds a routable graph from imported road assets.
 * Nodes are roads; edges connect roads within `linkRadiusKm` of each other.
 */
export function buildRoadGraph(data, options = {}) {
  const linkRadiusKm = options.linkRadiusKm ?? 5
  const roads = (data.service_assets || []).filter((asset) => asset.service_type === 'road')

  const statusById = new Map()
  for (const record of data.road_access || []) {
    statusById.set(record.road_id, record)
  }

  const nodes = new Map()
  for (const road of roads) {
    if (!Number.isFinite(road.latitude) || !Number.isFinite(road.longitude)) continue
    const access = statusById.get(road.id)
    nodes.set(road.id, {
      id: road.id,
      name: road.name,
      road_class: road.road_class || 'unpaved',
      latitude: road.latitude,
      longitude: road.longitude,
      access_status: access?.access_status || (road.passability === 'impassable' ? 'impassable' : 'passable'),
      access_reason: access?.access_reason || null,
      blocked_by: access?.primary_hazard_type || null,
    })
  }

  const adjacency = new Map()
  for (const id of nodes.keys()) adjacency.set(id, [])

  const all = [...nodes.values()]
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]
      const b = all[j]
      const distanceKm = haversineKm(a, b)
      if (distanceKm > linkRadiusKm) continue

      // An impassable node severs every link touching it. Deriving cost from
      // the better of the two roads must not resurrect a severed segment:
      // driving from A to B requires B to be reachable in the first place.
      if (a.access_status === 'impassable' || b.access_status === 'impassable') continue

      // Cost uses the *better* of the two roads: driving from a trunk route
      // onto a track does not make the track faster.
      const best = fasterOf(a, b)

      const baseKmh = CLASS_BASE_KMH[best.road_class] ?? 20
      let minutes = (distanceKm / baseKmh) * 60
      if (best.access_status === 'restricted') {
        minutes *= RESTRICTED_PENALTY[best.road_class] ?? 3
      }
      // Clear roads are preferred when times are similar.
      const preference = best.access_status === 'restricted' ? 1.25 : 1
      const cost = minutes * preference

      adjacency.get(a.id).push({ to: b.id, cost, distanceKm, via: best.id, viaClass: best.road_class })
      adjacency.get(b.id).push({ to: a.id, cost, distanceKm, via: best.id, viaClass: best.road_class })
    }
  }

  return { nodes, adjacency, linkRadiusKm }
}

function fasterOf(a, b) {
  if (a.access_status === 'restricted' && b.access_status !== 'restricted') return b
  if (b.access_status === 'restricted' && a.access_status !== 'restricted') return a
  return (CLASS_BASE_KMH[a.road_class] ?? 20) >= (CLASS_BASE_KMH[b.road_class] ?? 20) ? a : b
}

/**
 * Recomputes edge costs against current node states.
 *
 * Dijkstra reads `cost` from the adjacency list, but that cost was derived
 * from node access at build time. Counting restricted hops by comparing edge
 * cost against the current node state keeps the two consistent, so a route
 * through a restricted segment is reported as degraded rather than as if it
 * were clear.
 */
function edgeIsRestricted(graph, edge, fromId) {
  const from = graph.nodes.get(fromId)
  const to = graph.nodes.get(edge.to)
  if (from?.access_status === 'restricted' || to?.access_status === 'restricted') return true
  const via = graph.nodes.get(edge.via)
  return via?.access_status === 'restricted'
}

/**
 * Dijkstra over the road graph.
 *
 * Returns the cheapest feasible path, or null when none exists because the
 * destination is cut off. Uses a binary heap rather than a linear scan so a
 * national network with tens of thousands of segments stays tractable.
 */
export function shortestPath(graph, fromId, toId, options = {}) {
  const maxMinutes = options.maxMinutes ?? Number.POSITIVE_INFINITY
  const dest = graph.nodes.get(toId)
  const origin = graph.nodes.get(fromId)
  if (!dest || !origin) return { feasible: false, reason: 'Unknown origin or destination road' }

  if (dest.access_status === 'impassable') {
    return {
      feasible: false,
      reason: `Destination road "${dest.name}" is impassable: ${dest.access_reason || 'access restricted'}`,
      blocked_by: dest.blocked_by,
      destination: publicNode(dest),
    }
  }
  if (origin.access_status === 'impassable') {
    return {
      feasible: false,
      reason: `Origin road "${origin.name}" is impassable: ${origin.access_reason || 'access restricted'}`,
      blocked_by: origin.blocked_by,
      origin: publicNode(origin),
    }
  }
  if (fromId === toId) {
    return {
      feasible: true,
      mode: modeFor(dest.road_class),
      total_minutes: 0,
      total_distance_km: 0,
      hops: [publicNode(dest)],
      road_classes: [dest.road_class],
      restricted_hops: 0,
      degraded: false,
      note: 'Origin and destination are the same road segment',
    }
  }

  const dist = new Map([[fromId, 0]])
  const previous = new Map()
  const settled = new Set()
  const heap = new MinHeap()
  heap.push({ key: fromId, priority: 0 })

  while (heap.size) {
    const { key: currentId, priority } = heap.pop()
    if (settled.has(currentId)) continue
    settled.add(currentId)
    if (priority > (dist.get(currentId) ?? Infinity)) continue
    if (currentId === toId) break

    for (const edge of graph.adjacency.get(currentId) || []) {
      const next = priority + edge.cost
      if (next > maxMinutes) continue
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next)
        previous.set(edge.to, { from: currentId, edge })
        heap.push({ key: edge.to, priority: next })
      }
    }
  }

  if (!dist.has(toId)) {
    const originReach = reachableWithin(graph, fromId, options.detourRadiusKm ?? 25)
    // Attribute the severance: if a cut-off road lies on the most direct
    // corridor between origin and destination, it is the likeliest cause, and
    // saying so is more useful than reporting an unattributed failure.
    const blockers = [...graph.nodes.values()]
      .filter((node) => node.access_status === 'impassable')
      .filter((node) => {
        const viaOrigin = haversineKm(origin, node) <= (options.detourRadiusKm ?? 25)
        const viaDest = haversineKm(dest, node) <= (options.detourRadiusKm ?? 25)
        return viaOrigin || viaDest
      })
      .map((node) => ({ id: node.id, name: node.name, blocked_by: node.blocked_by }))

    return {
      feasible: false,
      reason: `No feasible road route from "${origin.name}" to "${dest.name}" — the network is severed`,
      blocked_by: blockers.length === 1 ? blockers[0].blocked_by : null,
      severed_by: blockers.length ? blockers : [],
      origin: publicNode(origin),
      destination: publicNode(dest),
      reachable_from_origin: originReach,
      hint: originReach.length
        ? `${originReach.length} other road(s) are reachable from the origin but none connect onward to the destination`
        : 'The origin road is itself isolated in this network',
      suggestion: blockers.length
        ? `Blocked segment${blockers.length > 1 ? 's' : ''}: ${blockers.map((b) => `${b.name}${b.blocked_by ? ` (${b.blocked_by})` : ''}`).join(', ')}`
        : 'No single segment accounts for the severance; the imported network may be incomplete',
    }
  }

  const hops = []
  const classes = new Set()
  let restricted = 0
  let totalDistance = 0
  let cursor = toId
  while (cursor && cursor !== fromId) {
    const step = previous.get(cursor)
    if (!step) break
    hops.unshift(publicNode(graph.nodes.get(cursor)))
    classes.add(step.edge.viaClass)
    totalDistance += step.edge.distanceKm
    if (edgeIsRestricted(graph, step.edge, step.from)) restricted += 1
    cursor = step.from
  }
  hops.unshift(publicNode(origin))
  classes.add(origin.road_class)

  const minutes = Math.round(dist.get(toId) * 10) / 10
  // If every road involved is track-class, no vehicle can be assumed. This is
  // a statement about the route, not a recommendation: a motorcycle or a
  // tractor can manage ground the operator calls a track.
  const classesList = [...classes]
  const slowTracks = classesList.every((c) => (CLASS_BASE_KMH[c] ?? 20) <= VEHICLE_MIN_KMH)

  return {
    feasible: true,
    mode: slowTracks ? 'foot' : 'vehicle',
    total_minutes: minutes,
    total_distance_km: Math.round(totalDistance * 10) / 10,
    restricted_hops: restricted,
    degraded: restricted > 0 || slowTracks,
    road_classes: [...classes],
    hops,
    note: restricted > 0
      ? `Route uses ${restricted} segment(s) reported as restricted; treat travel time as a lower bound`
      : null,
    methodology: 'Dijkstra over imported road assets; costs are travel time adjusted for access status and road class',
  }
}

/** Roads reachable from an origin within a radius, for explaining a failure. */
function reachableWithin(graph, fromId, radiusKm) {
  const origin = graph.nodes.get(fromId)
  if (!origin) return []
  const reached = new Set()
  for (const [id, node] of graph.nodes) {
    if (id === fromId) continue
    if (node.access_status === 'impassable') continue
    if (haversineKm(origin, node) <= radiusKm) reached.add(id)
  }
  return [...reached]
}

/**
 * Plans delivery from a distribution point to a set of destinations.
 *
 * Returns per-destination routing plus an honest aggregate: if some sites are
 * unreachable, the summary says so rather than reporting a partial delivery as
 * a success rate.
 */
export function planDelivery(data, { from, to, linkRadiusKm, maxMinutes } = {}) {
  const graph = buildRoadGraph(data, { linkRadiusKm })
  const targets = Array.isArray(to) ? to : [to].filter(Boolean)
  if (!from) return { feasible: false, reason: 'A distribution origin is required' }
  if (!targets.length) return { feasible: false, reason: 'At least one destination is required' }

  const legs = targets.map((target) => {
    const result = shortestPath(graph, from, target, { maxMinutes })
    return { to: target, ...result }
  })

  const feasible = legs.filter((leg) => leg.feasible)
  const unreachable = legs.filter((leg) => !leg.feasible)

  return {
    from,
    network: {
      roads: graph.nodes.size,
      links: [...graph.adjacency.values()].reduce((sum, list) => sum + list.length, 0) / 2,
      link_radius_km: graph.linkRadiusKm,
      cut_off_roads: [...graph.nodes.values()].filter((n) => n.access_status === 'impassable').length,
    },
    legs,
    summary: {
      destinations: legs.length,
      reachable: feasible.length,
      unreachable: unreachable.length,
      coverage_pct: legs.length ? Math.round((feasible.length / legs.length) * 10000) / 100 : 0,
      total_minutes: Math.round(feasible.reduce((sum, l) => sum + l.total_minutes, 0) * 10) / 10,
      total_distance_km: Math.round(feasible.reduce((sum, l) => sum + l.total_distance_km, 0) * 10) / 10,
      any_degraded: feasible.some((l) => l.degraded),
      requires_foot: feasible.filter((l) => l.mode === 'foot').length,
      blocked_by: countBy(unreachable.map((l) => l.blocked_by).filter(Boolean)),
    },
    // A plan that cannot reach every site is not a plan. Say so plainly.
    fully_deliverable: unreachable.length === 0,
    caveat: unreachable.length
      ? `${unreachable.length} of ${legs.length} destinations cannot be reached by road under current conditions; they need an alternative modality, a different distribution point, or the obstruction cleared`
      : null,
  }
}

function publicNode(node) {
  if (!node) return null
  return {
    id: node.id,
    name: node.name,
    road_class: node.road_class,
    access_status: node.access_status,
  }
}

function countBy(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] || 0) + 1
  return counts
}

function modeFor(roadClass) {
  return (CLASS_BASE_KMH[roadClass] ?? 20) <= VEHICLE_MIN_KMH ? 'foot' : 'vehicle'
}

/** Minimal binary min-heap; avoids an O(n) scan per node on large networks. */
class MinHeap {
  constructor() {
    this.items = []
  }

  get size() {
    return this.items.length
  }

  push(item) {
    this.items.push(item)
    let index = this.items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.items[parent].priority <= this.items[index].priority) break
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]]
      index = parent
    }
  }

  pop() {
    if (!this.items.length) return null
    const top = this.items[0]
    const last = this.items.pop()
    if (this.items.length) {
      this.items[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.items.length && this.items[left].priority < this.items[smallest].priority) smallest = left
        if (right < this.items.length && this.items[right].priority < this.items[smallest].priority) smallest = right
        if (smallest === index) break
        [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]]
        index = smallest
      }
    }
    return top
  }
}

export { ACCESS_BLOCKING_HAZARDS, stableId, clamp }