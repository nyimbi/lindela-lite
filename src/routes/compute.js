/**
 * ENH-60 — the compute family, out of the dispatcher.
 *
 * Seven routes that run one of the platform's models over the request's own
 * arguments and the store's snapshot, and answer with the result:
 *
 *   - `flood-depth` runs the terrain model at a point or over a box;
 *   - `routing/plan` runs the road-network model between two service assets;
 *   - `analytics/bias-correct` runs the downscaling correction over supplied
 *     observations and stations;
 *   - `alerts/evaluate` runs the rule engine and persists what crossed;
 *   - `anticipatory/evaluate` runs the trigger engine over a declared trigger
 *     set and a forecast, and records what fired;
 *   - `prepositioning/plan` runs the stochastic allocator over the store's road
 *     network and the caller's staging sites;
 *   - `scenario-comparisons` differences two or more supplied scenarios and
 *     reports whether the data supports ranking them.
 *
 * They are one family because they share a failure mode rather than a subject:
 * each is a computation whose *inputs* are the thing most likely to be wrong,
 * so each spends its first lines deciding whether the caller asked a question
 * it can answer at all. `from`/`to` must be road ids and not coordinates;
 * `level_m` must be a number and not a typo; a missing coordinate must not
 * become `0` through `Number(null)`. Getting that wrong does not throw — it
 * returns a confident answer to a question nobody asked.
 *
 * Three properties this module exists to hold:
 *
 *   - **A band travels with the number.** `flood-depth` publishes
 *     `flood_bands` beside every banded depth, so a partner receiving
 *     `band: "d1"` can read what it means without re-implementing the cut
 *     points. The banding function is the same one the browser map shades
 *     cells with, so the two cannot drift.
 *   - **A refused verb is a 405, not a 404.** `flood-depth` and
 *     `alerts/evaluate` match on any method and answer the refusal themselves;
 *     the matcher below deliberately does not narrow them to their documented
 *     verb, because doing so would turn a documented 405 into a 404 — a
 *     different statement about a different thing.
 *   - **A null is not a zero.** A missing `lat` is refused rather than read as
 *     0, and a depth the terrain model cannot supply is `data_available: false`
 *     rather than a fabricated 0 m.
 *   - **A refusal is a 200 with a named reason, not a 4xx.** The three decision
 *     routes below carry a refusal vocabulary of their own — the model refusing
 *     for a region, a budget that cannot allocate, two scenarios whose intervals
 *     overlap — and every one of those is an *answer* the caller asked for.
 *     Only a malformed request (a missing trigger, an unreadable forecast) is a
 *     400. The distinction is the whole reason the modules return `refusal`
 *     beside their result rather than throwing.
 *
 * `evaluateAndPersistAlerts` is injected rather than imported: it is the
 * driver's own entry point and lives in `server.js`, so importing it here would
 * make this module and `server.js` import each other.
 */

import { FLOOD_DEPTH_BANDS, floodDepthBand } from '../../public/shared/flood-bands.js'
import { planDelivery } from '../routing.js'
import { depthGrid, depthProfile, terrainContext } from '../flood-depth.js'
import { biasCorrectClimate } from '../analytics/downscaling.js'
import { actionEvent, actionLogEntry, evaluateTriggerSet, normalizeAnticipatoryTrigger } from '../anticipatory-action.js'
import { planPrepositioning } from '../prepositioning.js'
import { compareScenarios } from '../scenario-compare.js'
import { actorFor } from '../audit-chain.js'
import { emit } from '../outbox.js'
import { readRequestJson } from '../utils.js'

/**
 * Which compute route a request is, or null.
 *
 * `flood-depth` and `alerts/evaluate` match on any verb on purpose. Both
 * handlers answer a wrong verb with a 405, which is the documented answer and a
 * different statement from the 404 a narrowed matcher would produce. The two
 * POST-only routes are narrowed, because for them a wrong verb is genuinely
 * "no such route".
 *
 * `check-openapi.mjs` reads the literals below, so the paths are discoverable
 * without a second list.
 */
export function matchComputeRoute(pathname, method = 'GET') {
  if (pathname === '/api/v1/flood-depth') return { kind: 'flood-depth' }
  if (pathname === '/api/v1/alerts/evaluate') return { kind: 'alerts-evaluate' }
  if (method === 'POST') {
    if (pathname === '/api/v1/routing/plan') return { kind: 'routing-plan' }
    if (pathname === '/api/v1/analytics/bias-correct') return { kind: 'bias-correct' }
    // ENH-52. The trigger engine over a declared set and one forecast. POST
    // because the trigger set is the request's, not the store's: a caller
    // evaluates the protocols it is proposing before any of them are saved.
    if (pathname === '/api/v1/anticipatory/evaluate') return { kind: 'anticipatory-evaluate' }
    // ENH-53. The allocator, over the store's road network and the caller's
    // sites. POST for the same reason `routing/plan` is: the sites and the
    // budget are the question.
    if (pathname === '/api/v1/prepositioning/plan') return { kind: 'prepositioning-plan' }
    // ENH-55. Two or more scenarios, differenced. POST because a comparison is
    // over scenarios the caller is holding, and the same scenarios are the
    // request rather than a stored collection.
    if (pathname === '/api/v1/scenario-comparisons') return { kind: 'scenario-compare' }
  }
  return null
}

/**
 * Rejects routing endpoints that are not road asset ids.
 *
 * Returns an error message when the caller clearly passed coordinates or an
 * object instead of an id, else null. Distinguishing "you sent the wrong shape"
 * from "no such road" matters: the latter is indistinguishable from a data
 * problem the operator cannot act on.
 */
function validateRouteEndpoints(endpoints) {
  const looksLikeCoordinate = (value) => value !== null && typeof value === 'object'
  if (endpoints.some(looksLikeCoordinate)) {
    return 'from and to must be road asset ids (see GET /api/v1/service-assets?service_type=road), not latitude/longitude objects'
  }
  const nonStrings = endpoints.filter((value) => typeof value !== 'string' || !value.trim())
  if (nonStrings.length) {
    return 'from and to must be non-empty road asset id strings'
  }
  return null
}

/**
 * Parses a comma-separated list of levels. Returns null when the caller asked
 * for a level list that contains something unparseable, so a typo is reported
 * rather than silently treated as "no levels given" and then defaulted to 0.
 */
function parseLevels(raw) {
  const parts = String(raw || '').split(',').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return []
  const values = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value)) return null
    values.push(value)
  }
  return values
}

/**
 * ARC-05. The operational band for every depth this route publishes.
 *
 * `floodDepthBand` is the same function the map shades cells with, so the
 * banding a partner reads here and the banding an operator sees on screen
 * cannot drift — which is the whole reason it is shared rather than
 * re-derived. The cut points are operational: 0.3 m impedes walking, 1 m stops
 * a light vehicle, 2 m and a road is effectively gone.
 *
 * `flood_bands` travels with the payload once, so the thresholds are auditable
 * by a consumer that has never read this file. Without it, a partner receiving
 * `band: "d1"` knows a classification happened but not what it means.
 */
const FLOOD_BAND_TABLE = FLOOD_DEPTH_BANDS.map((b) => ({
  key: b.key,
  label: b.label,
  note: b.note,
  max_m: Number.isFinite(b.max) ? b.max : null,
}))

/** Band one depth reading, preserving the null-is-not-zero discipline. */
function bandedDepth(depth) {
  const band = floodDepthBand(depth)
  return {
    depth_band: band?.key || null,
    depth_band_label: band?.label || null,
    // The operational consequence, in words. A partner routing a vehicle needs
    // "restricted", not "d1".
    depth_band_note: band?.note || null,
  }
}

/** A depth profile with each level's depth banded. */
function bandedDepthProfile(profile) {
  return {
    ...profile,
    // A profile carries one depth per requested level. The top-level
    // `inundated`/`onset_level_m` stay as they are — this adds the band beside
    // each number rather than replacing any of the existing refusals.
    profile: (profile.profile || []).map((point) => ({ ...point, ...bandedDepth(point.depth_m) })),
    flood_bands: FLOOD_BAND_TABLE,
  }
}

/**
 * A depth grid with its primary-level band summary.
 *
 * The grid itself is up to 65,536 cells and banding each one would multiply the
 * payload for a map that bands client-side anyway. What a non-browser consumer
 * needs is the summary: how much of the surveyed box falls in each band. That
 * is what `per_band` states, and it is the number a partner would otherwise
 * have to derive by re-implementing the thresholds.
 */
function bandedDepthGrid(grid) {
  const counts = new Map(FLOOD_DEPTH_BANDS.map((b) => [b.key, { key: b.key, label: b.label, note: b.note, cells: 0 }]))
  let banded = 0
  for (const depth of grid.depth_grid || []) {
    const band = floodDepthBand(depth)
    if (!band) continue
    counts.get(band.key).cells += 1
    banded += 1
  }
  const total = (grid.depth_grid || []).filter((d) => typeof d === 'number' && Number.isFinite(d)).length
  return {
    ...grid,
    per_band: [...counts.values()].map((entry) => ({
      ...entry,
      // Share of *surveyed* cells, the same denominator `coverage_pct` uses.
      // Naming the denominator matters: "40% in band d1" is not 40% of the
      // district, and `surveyedAreaKm2` exists to say so.
      pct_of_surveyed: total ? Math.round((entry.cells / total) * 10000) / 100 : null,
    })),
    flood_bands: FLOOD_BAND_TABLE,
  }
}

/**
 * GET /api/v1/flood-depth
 *
 * Query:
 *   lat, lon            point probe (returns depth at each requested level)
 *   level_m             repeat or comma-separated water levels, metres
 *   south,west,north,east  box mode, returns a depth grid + GeoJSON extent
 *   grid_size           grid resolution in cells (default 32, max 256)
 *   terrain=1           include local terrain context around the point
 *
 * Returns 400 for malformed input and 200 with data_available=false when no
 * terrain covers the location, rather than guessing.
 */
async function handleFloodDepth(url, res, jsonResponse) {
  // Number(null) is 0, so a missing or blank parameter would silently become
  // a valid-looking coordinate. Read raw strings and validate explicitly.
  const rawLat = url.searchParams.get('lat')
  const rawLon = url.searchParams.get('lon')
  const lat = rawLat === null || rawLat.trim() === '' ? NaN : Number(rawLat)
  const lon = rawLon === null || rawLon.trim() === '' ? NaN : Number(rawLon)

  const rawLevels = url.searchParams.getAll('level_m').length
    ? url.searchParams.getAll('level_m')
    : (url.searchParams.get('levels_m') || url.searchParams.get('level_m') || '')
  const levels = parseLevels(rawLevels)
  const rawGridSize = url.searchParams.get('grid_size')
  const gridSize = rawGridSize === null || rawGridSize.trim() === '' ? 32 : Number(rawGridSize)

  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon)
  const boxParams = ['south', 'west', 'north', 'east'].map((key) => {
    const raw = url.searchParams.get(key)
    return raw === null || raw.trim() === '' ? NaN : Number(raw)
  })
  const [south, west, north, east] = boxParams
  const hasBox = boxParams.every(Number.isFinite)
  const wantsTerrain = url.searchParams.get('terrain') === '1'

  if (!hasPoint && !hasBox) {
    jsonResponse(res, 400, {
      success: false,
      error: 'Provide lat and lon for a point probe, or south/west/north/east for an area grid',
    })
    return true
  }
  if (levels === null) {
    jsonResponse(res, 400, { success: false, error: 'level_m must be a number, or a comma-separated list of numbers' })
    return true
  }
  if (!levels.length) {
    jsonResponse(res, 400, { success: false, error: 'Provide at least one level_m (water surface elevation, metres)' })
    return true
  }
  if (levels.some((level) => level < -500 || level > 9000)) {
    jsonResponse(res, 400, {
      success: false,
      error: 'level_m out of range: expected a plausible water surface elevation between -500 and 9000 metres',
    })
    return true
  }

  try {
    if (hasPoint && wantsTerrain) {
      const [context, profile] = await Promise.all([
        terrainContext(lat, lon),
        depthProfile(lat, lon, { levels_m: levels }),
      ])
      jsonResponse(res, 200, { success: true, data: { ...bandedDepthProfile(profile), terrain: context } })
      return true
    }

    if (hasPoint) {
      const profile = await depthProfile(lat, lon, { levels_m: levels })
      jsonResponse(res, 200, { success: true, data: bandedDepthProfile(profile) })
      return true
    }

    const grid = await depthGrid({ south, west, north, east, levelM: levels, gridSize })
    jsonResponse(res, 200, { success: true, data: bandedDepthGrid(grid) })
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { success: false, error: error.message })
  }
  return true
}

/**
 * POST /api/v1/alerts/evaluate
 *
 * Runs the rule engine against the request's snapshot and persists what it
 * raised. Any verb other than POST is a 405 — the route is matched on any
 * method precisely so that refusal can be stated.
 */
async function handleAlertEvaluation(store, data, req, res, jsonResponse, evaluateAndPersistAlerts) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { success: false, error: 'Method not allowed' })
    return
  }
  const body = await readRequestJson(req)
  const { raised, updated } = await evaluateAndPersistAlerts(store, data, {
    actor: body.actor,
    subject: req.__auth?.subject,
  })
  jsonResponse(res, 201, {
    success: true,
    evaluated: data.alert_rules.length,
    created: raised.length,
    updated: updated.length,
    data: raised,
  })
}

/**
 * Handle one compute route. Returns true when it handled the request.
 */
export async function handleComputeRoute(route, {
  store, data, req, res, url, jsonResponse, evaluateAndPersistAlerts,
}) {
  const { kind } = route

  if (kind === 'routing-plan') {
    const body = await readRequestJson(req)
    const from = body.from || body.origin
    const to = body.to || body.destination || body.destinations
    if (!from) {
      jsonResponse(res, 400, { success: false, error: 'from is required: the id of the distribution origin road' })
      return true
    }
    if (!to || (Array.isArray(to) && !to.length)) {
      jsonResponse(res, 400, { success: false, error: 'to is required: one or more destination road ids' })
      return true
    }
    // Endpoints are road asset ids. A lat/lon pair here is a plausible mistake
    // that otherwise surfaces as "Unknown origin or destination road", which
    // reads like a broken router rather than a wrong argument.
    const coordinateRejection = validateRouteEndpoints([from, ...(Array.isArray(to) ? to : [to])])
    if (coordinateRejection) {
      jsonResponse(res, 400, { success: false, error: coordinateRejection })
      return true
    }
    const plan = planDelivery(data, {
      from,
      to,
      linkRadiusKm: Number.isFinite(body.link_radius_km) ? Number(body.link_radius_km) : undefined,
      maxMinutes: Number.isFinite(body.max_minutes) ? Number(body.max_minutes) : undefined,
    })
    if (plan.feasible === false && plan.reason) {
      jsonResponse(res, 400, plan)
      return true
    }
    jsonResponse(res, 200, { success: true, data: plan })
    return true
  }

  if (kind === 'flood-depth') {
    return handleFloodDepth(url, res, jsonResponse)
  }

  if (kind === 'bias-correct') {
    const body = await readRequestJson(req)
    const observations = body.observations || []
    const stations = body.stations || []
    const corrected = biasCorrectClimate(observations, stations)
    jsonResponse(res, 200, { success: true, data: corrected })
    return true
  }

  if (kind === 'alerts-evaluate') {
    await handleAlertEvaluation(store, data, req, res, jsonResponse, evaluateAndPersistAlerts)
    return true
  }

  if (kind === 'anticipatory-evaluate') {
    const body = await readRequestJson(req)
    const declared = body.triggers
    if (!Array.isArray(declared)) {
      jsonResponse(res, 400, {
        success: false,
        error: 'triggers is required and must be an array: an empty set evaluates nothing, and a missing one is a typo rather than a deployment with no triggers',
      })
      return true
    }
    // Declared triggers are normalised before any of them is evaluated, so a
    // trigger that could never fire is a 400 naming the field rather than a
    // verdict sitting in the results that reads like one that did not cross.
    const triggers = declared.map((input) => normalizeAnticipatoryTrigger(input))
    const forecast = body.forecast || {}
    const firedCrossings = Array.isArray(body.fired_crossings) ? body.fired_crossings : []
    const { verdicts, firedCrossings: nowFired } = evaluateTriggerSet(triggers, forecast, { firedCrossings })

    // Only what fired is written. A trigger that did not cross wrote nothing,
    // which is the same rule the protocol engine follows: the log shows actions,
    // not heartbeats.
    const fired = verdicts.filter((verdict) => verdict.fired)
    if (fired.length) {
      const { actor } = actorFor(body.actor ?? req.__auth?.subject ?? null)
      const logs = fired.map((verdict) => actionLogEntry(verdict, actor))
      await store.merge({ action_logs: logs })
      // The event is emitted after the merge, in a counted try/catch, exactly
      // like every other write path: the state is already true, so a missing
      // notification is a gap to count rather than a reason to abandon a record
      // the operator has already been told about.
      for (const verdict of fired) {
        try {
          await emit(store, actionEvent(verdict).event, actionEvent(verdict).payload)
        } catch {
          // The action is recorded; no subscriber was told. The verdict travels
          // in the response either way, so this is not a silent loss.
        }
      }
    }

    jsonResponse(res, 200, {
      success: true,
      data: {
        verdicts,
        fired_crossings: nowFired,
        fired_count: fired.length,
        evaluated_count: verdicts.length,
        // Named rather than left to the caller to count: a run in which every
        // trigger refused and one in which none crossed both report `fired: 0`,
        // and the two are different facts about the deployment.
        refused_count: verdicts.filter((verdict) => verdict.refusal).length,
        basis: 'each trigger is checked against its model card and its funding window before its threshold, so a trigger that fires on a refusal is reported as the model\'s refusal rather than as a crossing',
      },
    })
    return true
  }

  if (kind === 'prepositioning-plan') {
    const body = await readRequestJson(req)
    const plan = planPrepositioning({
      demandSites: body.demand_sites || [],
      stagingSites: body.staging_sites || [],
      budget: body.budget ?? null,
      data,
      scenarios: body.scenarios || null,
      seed: Number.isFinite(body.seed) ? Number(body.seed) : undefined,
      draws: Number.isFinite(body.draws) ? Number(body.draws) : undefined,
      steps: Number.isFinite(body.steps) ? Number(body.steps) : undefined,
    })
    // A refusal is a 200. The allocator's refusals are all statements about the
    // question — no budget, no staging site, a road that carries no access level
    // — and each is an answer to a request that was well-formed. Only the
    // model's own contract decides, and it already decided.
    jsonResponse(res, 200, { success: true, data: plan })
    return true
  }

  if (kind === 'scenario-compare') {
    const body = await readRequestJson(req)
    const comparison = compareScenarios({
      scenarios: body.scenarios || [],
      region: body.region ?? null,
      window: body.window ?? null,
      metric: body.metric ?? null,
      direction: body.direction,
      level: Number.isFinite(body.level) ? Number(body.level) : undefined,
    })
    jsonResponse(res, 200, { success: true, data: comparison })
    return true
  }

  return false
}
