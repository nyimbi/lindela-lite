/**
 * ENH-71 — intent-driven progressive disclosure.
 *
 * HX-05 counted 144 interactive controls above the fold on the ops console; the
 * command band reclaimed the pixels, but the count was never the disease. The
 * console offers every control to every operator at once because it has no idea
 * what the operator came to do. This module gives it that: a (role, intent)
 * pair decides which controls a surface should show, and — the half that is
 * easy to skip — *why* each hidden one is hidden. An operator who cannot find a
 * control needs a reason and a way back, not a dead end.
 *
 * **Why a registry rather than a filter.** The set of controls a task needs is
 * a property of the task, not of controls in general. A predicate that inferred
 * "does triage need this" from the control's own shape would be a second
 * description of the console, and the two would drift the moment either changed.
 * So the controls are enumerated once, from `public/index.html`, and each intent
 * names the groups it shows. The enumeration is the console's real control set,
 * not an invented one: a control that exists in the markup and not here is a
 * control this model silently cannot reach.
 *
 * **The safety property, and why it is structural.** The failure mode of any
 * disclosure model is "the control is unreachable for everyone" — a bug wearing
 * the feature's clothes. So a control that is the *only* route to a capability
 * is marked `onlyRoute`, and `reachability()` proves over the whole matrix that
 * every control, and every only-route control in particular, is shown by some
 * intent some role can select. `manage` is the total intent, and it is not
 * role-gated, so the property holds by construction rather than by convention.
 *
 * **Refuse to guess.** An unknown role or an unknown intent shows *everything*
 * and says so in the header. Hiding on an unrecognised input is exactly how a
 * control disappears for the one operator whose role was spelled differently.
 * An *absent* intent — the console's state before anyone has chosen one — is
 * the same refusal, and deliberately not the role's `defaultIntent`: see
 * `absentIntentHeader`.
 *
 * Pure, DOM-free, no imports: importable by the console and by Node alike.
 */

/**
 * Every control the console actually has, keyed by its `id` in
 * `public/index.html`. `group` is the axis an intent selects on; `onlyRoute`
 * marks a control whose capability has no other in-product route; `hiddenBecause`
 * is what is lost when the control is not shown.
 *
 * `onlyRoute` is deliberately not "important". A filter is important and is not
 * only-route, because the map still draws without it. The tabs are only-route:
 * hide all five and the four panels behind them are unreachable.
 */
export const CONTROLS = Object.freeze({
  'locale-select': Object.freeze({ group: 'console', onlyRoute: true, label: 'Language picker', hiddenBecause: 'the language picker, and an operator reading Swahili would be shown English labels' }),
  refreshButton: Object.freeze({ group: 'console', onlyRoute: false, label: 'Refresh', hiddenBecause: 'a manual refresh; the 30-second poll and the R key still refresh' }),
  cmdPaletteButton: Object.freeze({ group: 'console', onlyRoute: false, label: 'Command palette', hiddenBecause: 'the command-palette button; Cmd+K still opens it' }),
  shareViewBtn: Object.freeze({ group: 'console', onlyRoute: true, label: 'Copy link', hiddenBecause: 'copy-link, so the view cannot be passed to a colleague' }),
  filterSheetToggle: Object.freeze({ group: 'console', onlyRoute: true, label: 'Filters', hiddenBecause: 'the filter sheet, and every map filter is behind it' }),

  mapListToggle: Object.freeze({ group: 'map', onlyRoute: true, label: 'Show as list', hiddenBecause: "the map's text alternative — the only non-visual route to what is on the map" }),
  mapTimeRange: Object.freeze({ group: 'map', onlyRoute: false, label: 'Time', hiddenBecause: 'the map time window; the map keeps its default 7 days' }),
  mapSeverity: Object.freeze({ group: 'map', onlyRoute: false, label: 'Severity', hiddenBecause: 'the map severity filter; every severity stays drawn' }),
  mapSource: Object.freeze({ group: 'map', onlyRoute: false, label: 'Source', hiddenBecause: 'the map source filter' }),
  mapTileSource: Object.freeze({ group: 'map', onlyRoute: false, label: 'Basemap', hiddenBecause: 'the basemap picker; the last basemap stays selected' }),
  coldChainToggle: Object.freeze({ group: 'map', onlyRoute: false, label: 'Cold-chain nodes', hiddenBecause: 'the cold-chain layer; those nodes stay off the map' }),
  sensorsToggle: Object.freeze({ group: 'map', onlyRoute: false, label: 'Sensors', hiddenBecause: 'the sensor layer; sensors stay off the map' }),
  zoomInBtn: Object.freeze({ group: 'map', onlyRoute: false, label: 'Zoom in', hiddenBecause: 'the zoom-in button; + still zooms the map' }),
  zoomOutBtn: Object.freeze({ group: 'map', onlyRoute: false, label: 'Zoom out', hiddenBecause: 'the zoom-out button; − still zooms the map' }),
  zoomResetBtn: Object.freeze({ group: 'map', onlyRoute: false, label: 'Reset view', hiddenBecause: 'the reset-view button; 0 still resets the map' }),
  mapLegendOverlay: Object.freeze({ group: 'map', onlyRoute: true, label: 'Legend', hiddenBecause: 'the map legend, and nothing else names what the colours mean' }),
  mapCoverageOverlay: Object.freeze({ group: 'map', onlyRoute: true, label: 'Coverage', hiddenBecause: 'the coverage panel — what the map does not show' }),

  floodArea: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Flood area', hiddenBecause: 'the flood simulation area' }),
  floodLevelInput: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Water level', hiddenBecause: 'the flood water level' }),
  floodSimulate: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Simulate', hiddenBecause: 'running a flood simulation' }),
  floodClear: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Clear simulation', hiddenBecause: 'clearing a flood simulation' }),
  roadOverlayToggle: Object.freeze({ group: 'simulation', onlyRoute: false, label: 'Road status', hiddenBecause: 'the road-status layer' }),
  ipcOverlayToggle: Object.freeze({ group: 'simulation', onlyRoute: false, label: 'IPC areas', hiddenBecause: 'the IPC areas layer' }),
  playbackStep: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Playback frame', hiddenBecause: 'the hazard-playback frame slider' }),
  playbackPeak: Object.freeze({ group: 'simulation', onlyRoute: true, label: 'Jump to peak', hiddenBecause: 'jump-to-peak on the hazard playback' }),

  routeFrom: Object.freeze({ group: 'routing', onlyRoute: true, label: 'Route from', hiddenBecause: 'the route origin' }),
  routeTo: Object.freeze({ group: 'routing', onlyRoute: true, label: 'Route to', hiddenBecause: 'the route destination' }),
  routePlan: Object.freeze({ group: 'routing', onlyRoute: true, label: 'Plan route', hiddenBecause: 'planning a route' }),
  routeClear: Object.freeze({ group: 'routing', onlyRoute: true, label: 'Clear route', hiddenBecause: 'clearing a planned route' }),

  'tab-alerts': Object.freeze({ group: 'rail', onlyRoute: true, label: 'Alerts tab', hiddenBecause: 'the Alerts tab' }),
  'tab-reports': Object.freeze({ group: 'rail', onlyRoute: true, label: 'Reports tab', hiddenBecause: 'the Reports tab' }),
  'tab-equity': Object.freeze({ group: 'rail', onlyRoute: true, label: 'Equity tab', hiddenBecause: 'the Equity tab' }),
  'tab-ingestion': Object.freeze({ group: 'rail', onlyRoute: true, label: 'Ingestion tab', hiddenBecause: 'the Ingestion tab' }),
  'tab-settings': Object.freeze({ group: 'rail', onlyRoute: true, label: 'Settings tab', hiddenBecause: 'the Settings tab, and the API token lives there' }),
  railRefresh: Object.freeze({ group: 'rail', onlyRoute: true, label: 'Refresh rail', hiddenBecause: 'refreshing the pre-authorised-action rail' }),
  workflowInstances: Object.freeze({ group: 'rail', onlyRoute: true, label: 'Open instances', hiddenBecause: 'the open-instances list' }),

  paletteInput: Object.freeze({ group: 'palette', onlyRoute: true, label: 'Palette search', hiddenBecause: 'the palette search box, so the palette opens with nothing to type into' }),

  dispatchFocalPoint: Object.freeze({ group: 'dialog', onlyRoute: true, label: 'Dispatch focal point', hiddenBecause: 'the dispatch focal point — the approval cannot be scoped without it' }),
  dispatchReason: Object.freeze({ group: 'dialog', onlyRoute: true, label: 'Dispatch reason', hiddenBecause: 'the dispatch reason — the approval cannot be justified without it' }),
})

/** Every group an intent may select on, in the order they read on the page. */
export const GROUPS = Object.freeze(['console', 'map', 'simulation', 'routing', 'rail', 'palette', 'dialog'])

/**
 * The roles the console serves. The vocabulary is `shared/view-state.js`'s
 * `ROLE_DEFAULTS` — the same seven audiences — so a shared link and this model
 * cannot disagree about who an operator is.
 *
 * `extras` are controls a role needs on top of any intent it selects, because
 * the role's job reaches a panel the intent does not name.
 */
export const ROLES = Object.freeze({
  operator: Object.freeze({ label: 'Operations', defaultIntent: 'triage', extras: Object.freeze([]) }),
  analyst: Object.freeze({ label: 'Analyst', defaultIntent: 'monitor', extras: Object.freeze(['tab-equity']) }),
  district: Object.freeze({ label: 'District officer', defaultIntent: 'monitor', extras: Object.freeze(['tab-reports']) }),
  partner: Object.freeze({ label: 'Partner', defaultIntent: 'monitor', extras: Object.freeze([]) }),
  chw: Object.freeze({ label: 'Community health worker', defaultIntent: 'monitor', extras: Object.freeze([]) }),
})

/**
 * The tasks an operator comes to the console to do.
 *
 * `show` names groups, `also` adds individual controls, `except` removes them.
 * `manage` is the total intent — every group — and is the reason no control is
 * ever hidden for every role.
 */
export const INTENTS = Object.freeze({
  triage: Object.freeze({
    label: 'Triage incoming alerts',
    show: Object.freeze(['rail']),
    also: Object.freeze(['mapListToggle', 'refreshButton']),
    except: Object.freeze([]),
    why: 'the alert rail is the decision surface; the map is context for it, not the task',
  }),
  approve: Object.freeze({
    label: 'Approve or reject a dispatch',
    show: Object.freeze(['dialog']),
    also: Object.freeze(['tab-alerts', 'railRefresh', 'mapListToggle']),
    except: Object.freeze([]),
    why: 'approval happens in the dialog the rail opens; nothing else is on the path',
  }),
  monitor: Object.freeze({
    label: 'Monitor the situation',
    show: Object.freeze(['console', 'map']),
    also: Object.freeze([]),
    except: Object.freeze([]),
    why: 'watching the situation is the map and the controls that change what it draws',
  }),
  simulate: Object.freeze({
    label: 'Run a flood simulation',
    show: Object.freeze(['simulation', 'console']),
    also: Object.freeze(['mapListToggle']),
    except: Object.freeze([]),
    why: 'a simulation is run from its own strip and read on the map',
  }),
  route: Object.freeze({
    label: 'Plan a route',
    show: Object.freeze(['routing', 'console']),
    also: Object.freeze(['mapListToggle']),
    except: Object.freeze([]),
    why: 'route planning is the routing strip and the map it draws onto',
  }),
  ingest: Object.freeze({
    label: 'Check what was ingested',
    show: Object.freeze(['rail']),
    also: Object.freeze(['tab-ingestion', 'tab-reports', 'railRefresh', 'refreshButton']),
    except: Object.freeze([]),
    why: 'ingestion is a rail tab; the record counts and source tiles are there',
  }),
  manage: Object.freeze({
    label: 'Show everything',
    show: Object.freeze(['console', 'map', 'simulation', 'routing', 'rail', 'palette', 'dialog']),
    also: Object.freeze([]),
    except: Object.freeze([]),
    why: 'the escape hatch: every control, for the operator whose task is not in this list',
  }),
})

export const ROLE_KEYS = Object.freeze(Object.keys(ROLES))
export const INTENT_KEYS = Object.freeze(Object.keys(INTENTS))

/**
 * The intents a picker offers, in the order they read: every declared intent.
 *
 * Exported rather than left to the console to enumerate, because a picker built
 * from its own list is a second description of the intent set, and the two drift
 * the moment either changes — the exact drift this module's registry exists to
 * avoid one level down. The console renders this; it does not decide it.
 */
export const INTENT_OPTIONS = Object.freeze(INTENT_KEYS.map((key) => Object.freeze({ key, label: INTENTS[key].label })))

const ALL_CONTROLS = Object.freeze(Object.keys(CONTROLS))

function idsInGroups(groups) {
  const wanted = new Set(groups)
  return ALL_CONTROLS.filter((id) => wanted.has(CONTROLS[id].group))
}

/** The header an unrecognised input carries: refuse to guess, show everything. */
function fallbackHeader(kind, value) {
  return `Unrecognised ${kind} "${String(value)}" — showing every control rather than hiding by default. `
    + 'Hiding on an unrecognised input is how a control disappears for the one operator who needed it.'
}

/**
 * The header the console boots with, before any intent is chosen.
 *
 * The console opens with no intent, and the decided default is that it shows
 * everything. The role's `defaultIntent` is *not* applied on boot: `operator`
 * defaults to `triage`, whose `show` list is the alert rail alone, so opening
 * on the role default would hide 30 of 39 controls — every map filter among
 * them — before the operator has said what they came to do. A console that
 * opens with its map filters gone is the failure this feature exists to
 * prevent, so an absent intent is a refusal to guess like any other, and it
 * shows the whole console and says so.
 */
function absentIntentHeader() {
  return 'No intent chosen — showing every control. '
    + 'Pick one from the intent control to narrow the console to the task at hand.'
}

/**
 * The controls to show for a (role, intent) pair, and why each hidden one is.
 *
 * Returns:
 *   `mode`   — `'intent'` when both inputs resolved, `'fallback'` when either
 *              did not and the full set is shown
 *   `header` — a sentence naming the decision, for the surface to render
 *   `shown`  — the control ids to show, sorted
 *   `hidden` — `{ control, onlyRoute, reason }` per hidden control; an
 *              only-route control's reason names how to get it back, because a
 *              hidden control with no route back is the dead end this avoids
 *
 * An unknown role or intent never throws and never hides: it returns every
 * control, which is the only honest answer to a question the model cannot read.
 */
export function decideSurface(role, intent) {
  const roleRule = ROLES[role]
  const intentRule = INTENTS[intent]
  const unknownRole = !roleRule
  const unknownIntent = !intentRule
  // An absent intent is a distinct case from an unknown one, and it is the
  // console's opening state rather than an error: no intent has been chosen
  // yet, so the honest answer is the whole console, not the role's default.
  const absentIntent = intent === null || intent === undefined || intent === ''

  if (unknownRole || unknownIntent || absentIntent) {
    // The header names the first thing wrong, in the order that matters: an
    // unreadable role is a bug worth surfacing even when the intent is also
    // absent, and an absent intent is not an error at all.
    const header = unknownRole
      ? fallbackHeader('role', role)
      : absentIntent
        ? absentIntentHeader()
        : fallbackHeader('intent', intent)
    return {
      role,
      intent,
      known: { role: !unknownRole, intent: !unknownIntent && !absentIntent },
      mode: 'fallback',
      header,
      shown: ALL_CONTROLS.slice(),
      hidden: [],
    }
  }

  const selected = new Set([...idsInGroups(intentRule.show), ...intentRule.also, ...roleRule.extras])
  for (const id of intentRule.except) selected.delete(id)

  const shown = ALL_CONTROLS.filter((id) => selected.has(id))
  const hidden = ALL_CONTROLS.filter((id) => !selected.has(id)).map((id) => {
    const rule = CONTROLS[id]
    const reason = `Hidden for "${intentRule.label}": ${rule.hiddenBecause}.`
    return {
      control: id,
      onlyRoute: rule.onlyRoute,
      // The way back, not just the reason. Every hidden control is one intent
      // switch away, and the only-route ones say so explicitly so the operator
      // is never told "no" without being told "instead".
      reason: rule.onlyRoute
        ? `${reason} This is the only route to it — switch to "Show everything" to reach it.`
        : reason,
    }
  })

  return {
    role,
    intent,
    known: { role: true, intent: true },
    mode: 'intent',
    header: `${roleRule.label} · ${intentRule.label} — ${shown.length} of ${ALL_CONTROLS.length} controls. ${intentRule.why}.`,
    shown,
    hidden,
  }
}

/**
 * Whether every control is reachable for every role across the intent set.
 *
 * The safety property, checked rather than asserted: a control is *unreachable*
 * when some role can select no intent that shows it. A non-empty `unreachable`
 * is a disclosure model that has hidden a capability from a whole audience, and
 * the test fails on it. `onlyRoute` controls are reported separately so a
 * regression names the capability it stranded, not just a control id.
 */
export function reachability() {
  const unreachable = []
  const onlyRouteUnreachable = []
  for (const id of ALL_CONTROLS) {
    for (const role of ROLE_KEYS) {
      const reachable = INTENT_KEYS.some((intent) => decideSurface(role, intent).shown.includes(id))
      if (!reachable) {
        unreachable.push({ control: id, role })
        if (CONTROLS[id].onlyRoute) onlyRouteUnreachable.push({ control: id, role })
      }
    }
  }
  return {
    controls: ALL_CONTROLS.length,
    roles: ROLE_KEYS.length,
    intents: INTENT_KEYS.length,
    unreachable,
    onlyRouteUnreachable,
  }
}
