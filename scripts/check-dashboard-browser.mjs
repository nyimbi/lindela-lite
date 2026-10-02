#!/usr/bin/env node
/**
 * Drives the running dashboard in a real browser over the Chrome DevTools
 * Protocol and reports what the UI actually does.
 *
 * Why this exists: three of this project's bugs were invisible to the test
 * suite — connectors reporting success while ingesting nothing, and a map
 * frame that squeezed the entire pilot region to a few pixels. Fixtures and
 * unit tests could not have caught either. This script clicks the real controls
 * and reads the real DOM.
 *
 * It verifies, against a live server on http://127.0.0.1:4177:
 *   - the flood simulation button produces shaded cells in the SVG layer
 *   - the depth bands carry distinct computed fills (not invisible fill)
 *   - the road-status toggle produces markers
 *   - an invalid water level is rejected without a request
 *   - the legend reports the model limitation
 *
 * Requires Chrome listening on --remote-debugging-port. Exits non-zero if any
 * check fails, so it can gate a deployment check.
 */

const ENDPOINT = process.env.LINDELA_LITE_URL || 'http://127.0.0.1:4177/'
// Base for constructing sibling surface URLs (the dashboard root has a trailing slash).
const BASE = ENDPOINT.replace(/\/$/, '')

/** The viewport a panel sees. Desktop, not headless Chrome's default. */
const LAYOUT_VIEWPORT = Object.freeze({ width: 1440, height: 900 })
const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'

let socket
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }
    }, 30000)
  })
}

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw')
  }
  return res.result.value
}

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target available')

  socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  await send('Page.enable')
  await send('Runtime.enable')

  // Retire any service worker and drop its caches before testing.
  //
  // public/sw.js serves app.js cache-first, so a previously cached bundle is
  // what the page under test actually loads. Without this, the check silently
  // validates stale code: a deliberate break in app.js still reported PASS.
  // Verified after this guard was added.
  await send('Page.navigate', { url: ENDPOINT })
  await new Promise((r) => setTimeout(r, 1500))
  await evaluate(`(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    return true;
  })()`).catch(() => {})

  // Collect page errors: an unhandled rejection in app.js would otherwise be
  // invisible while the buttons silently do nothing.
  await send('Log.enable')
  const pageErrors = []
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      pageErrors.push(msg.params.entry.text)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description || 'exception')
    }
  })

  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  // Pin a laptop viewport. Without this the suite inherited headless Chrome's
  // default of about 756x469, which is the mobile breakpoint: the console is a
  // single column and the rail is full width. Every layout check therefore ran
  // against a layout no panel will ever see — and a table 29px wider than the
  // 360px rail passed, because at 756px wide there was nothing to overflow.
  await send('Emulation.setDeviceMetricsOverride', {
    width: LAYOUT_VIEWPORT.width, height: LAYOUT_VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  })
  await send('Page.navigate', { url: `${ENDPOINT}${ENDPOINT.includes('?') ? '&' : '?'}cachebust=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 4500))

  const boot = await evaluate(`(() => ({
    mapPresent: !!document.getElementById('situationMap'),
    floodArea: !!document.getElementById('floodArea'),
    floodInput: !!document.getElementById('floodLevelInput'),
    simulateBtn: !!document.getElementById('floodSimulate'),
    floodClear: !!document.getElementById('floodClear'),
    roadToggle: !!document.getElementById('roadOverlayToggle'),
    legend: !!document.getElementById('floodLegend'),
    status: (document.getElementById('floodStatus')||{}).textContent || '',
    hazardCount: document.querySelectorAll('#mapHazards *').length,
  }))()`)

  const missing = Object.entries({
    situationMap: boot.mapPresent,
    floodArea: boot.floodArea,
    floodLevelInput: boot.floodInput,
    floodSimulate: boot.simulateBtn,
    floodClear: boot.floodClear,
    roadOverlayToggle: boot.roadToggle,
  }).filter(([, present]) => !present).map(([id]) => id)

  check('dashboard boots with every flood control present',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `hazards drawn: ${boot.hazardCount}`)
  check('flood status starts as an instruction, not a result',
    /water surface elevation/i.test(boot.status), JSON.stringify(boot.status.trim().slice(0, 60)))

  // Hazard classes must match what road-access actually models. A landslide
  // falling through to the default class did not break anything visible: it just
  // looked generic, so no check failed and the gap sat there. These assert the
  // taxonomy is wired to the map, not just declared in the schema.
  await new Promise((r) => setTimeout(r, 1500))
  const hazardTaxonomy = await evaluate(`(() => {
    const classes = new Set([...document.querySelectorAll('#mapHazards *')]
      .map((n) => n.getAttribute('class') || '')
      .filter((c) => c.includes('hazard-')))
    return {
      classes: [...classes].sort(),
      legendText: (document.getElementById('mapLegend')||{}).textContent || '',
      slideMarkers: document.querySelectorAll('#mapHazards .hazard-marker.hazard-landslide').length,
      floodMarkers: document.querySelectorAll('#mapHazards .hazard-marker.hazard-flood').length,
      footprints: document.querySelectorAll('#mapHazards .hazard-footprint').length,
    }
  })()`)
  check('landslide hazards are drawn as landslides, not as a generic marker',
    hazardTaxonomy.slideMarkers > 0,
    `landslide markers: ${hazardTaxonomy.slideMarkers}`)
  check('flood hazards are still drawn as flood',
    hazardTaxonomy.floodMarkers > 0,
    `flood markers: ${hazardTaxonomy.floodMarkers}`)
  check('map legend names landslide, which road-access models separately',
    /Landslide/i.test(hazardTaxonomy.legendText),
    hazardTaxonomy.legendText.replace(/\s+/g, ' ').trim().slice(0, 60))
  check('map legend explains a reported area is not a located point',
    /Area \(box\)/i.test(hazardTaxonomy.legendText),
    hazardTaxonomy.legendText.replace(/\s+/g, ' ').trim().slice(0, 60))

  // An empty field must not be read as sea level.
  await evaluate(`document.getElementById('floodLevelInput').value = '';
    document.getElementById('floodSimulate').click(); true`)
  await new Promise((r) => setTimeout(r, 1200))
  const emptyResult = await evaluate(`(() => ({
    status: document.getElementById('floodStatus').textContent,
    cells: document.querySelectorAll('#mapFlood rect').length,
  }))()`)
  check('empty water level is rejected without simulating',
    emptyResult.cells === 0 && /enter a water surface elevation/i.test(emptyResult.status),
    emptyResult.status.trim().slice(0, 60))

  // A plausible level for the Lodwar area (~500 m).
  await evaluate(`document.getElementById('floodLevelInput').value = '500';
    document.getElementById('floodSimulate').click(); true`)
  await new Promise((r) => setTimeout(r, 12000))

  // The map must actually be usable on screen, not merely present in the DOM.
  // It once rendered at 195x122 on a 1440x900 laptop because the SVG shares a
  // flex column with every panel below it, which put the legend text at 2.4px.
  // No assertion caught that: the cells existed, they were simply invisible.
  const mapBox = await evaluate(`(() => {
    const s = document.getElementById('situationMap')
    const r = s.getBoundingClientRect()
    const vb = s.getAttribute('viewBox').split(' ').map(Number)
    const scale = Math.min(r.width / vb[2], r.height / vb[3])
    const label = document.querySelector('#mapLegend .legend-label')
    return {
      w: r.width, h: r.height, scale,
      legendPx: label ? parseFloat(getComputedStyle(label).fontSize) * scale : null,
    }
  })()`)
  check('map renders large enough to read on a laptop',
    mapBox.h >= 300 && mapBox.w >= 600,
    `map ${Math.round(mapBox.w)}x${Math.round(mapBox.h)}`)
  check('map legend text stays legible after viewBox scaling',
    mapBox.legendPx !== null && mapBox.legendPx >= 7,
    `legend text ~${Math.round(mapBox.legendPx * 10) / 10}px on screen`)

  const sim = await evaluate(`(() => {
    const rects = [...document.querySelectorAll('#mapFlood rect')];
    const fills = new Map();
    for (const r of rects) {
      const cls = r.getAttribute('class').split(' ')[1];
      if (!fills.has(cls)) fills.set(cls, getComputedStyle(r).fill);
    }
    return {
      cells: rects.length,
      status: document.getElementById('floodStatus').textContent,
      legendVisible: !document.getElementById('floodLegend').hidden,
      legendText: document.getElementById('floodLegend').textContent,
      bands: [...fills.entries()],
      positiveGeometry: rects.every(r => parseFloat(r.getAttribute('width')) > 0 && parseFloat(r.getAttribute('height')) > 0),
    };
  })()`)

  check('simulation shades the map', sim.cells > 0, `${sim.cells} cells`)
  check('status line reports the model and resolution',
    /static water-surface|no flow routing/i.test(sim.status) && /±?\s*15\s*m|15 m/i.test(sim.status),
    sim.status.trim().slice(0, 110))
  // A share of surveyed grid cells presented as a share of a district is a
  // much larger and wrong claim: "40% of Turkana underwater" against a flooded
  // footprint of a few thousand km2. The sentence has to name what it is a
  // share of, and say so explicitly.
  check('flood share names the surveyed box, not the district',
    /surveyed/i.test(sim.status) && !/% of the area\b/i.test(sim.status),
    sim.status.trim().slice(0, 120))
  check('flood share states it is not a share of the district',
    /not a share of the district/i.test(sim.status),
    sim.status.trim().slice(0, 120))
  check('legend becomes visible and names the depth bands',
    sim.legendVisible && /0\s*[–-]\s*0\.3 m/.test(sim.legendText.replace(/\s+/g, ' ')),
    sim.legendVisible ? 'visible' : 'still hidden')
  check('every drawn cell has positive geometry', sim.positiveGeometry)
  check('distinct depth bands render distinct fills',
    new Set(sim.bands.map(([, f]) => f)).size >= Math.min(2, sim.bands.length),
    sim.bands.map(([k, f]) => `${k}:${f}`).join(' '))

  // Road status overlay.
  await evaluate(`const t = document.getElementById('roadOverlayToggle');
    t.checked = true; t.dispatchEvent(new Event('change')); true`)
  await new Promise((r) => setTimeout(r, 4000))
  const roads = await evaluate(`(() => ({
    markers: document.querySelectorAll('#mapRoads circle').length,
    impassable: document.querySelectorAll('#mapRoads .road-impassable').length,
    status: (document.getElementById('roadStatus')||{}).textContent || '',
  }))()`)
  check('road overlay draws markers', roads.markers > 0, `${roads.markers} markers`)
  check('a cut-off road is marked impassable',
    roads.impassable > 0, `${roads.impassable} impassable; status: ${roads.status.trim().slice(0, 60)}`)

  // Overlays must survive a filter re-render.
  await evaluate(`const s = document.getElementById('mapSeverity');
    s.value = 'critical'; s.dispatchEvent(new Event('change')); true`)
  await new Promise((r) => setTimeout(r, 2500))
  const after = await evaluate(`(() => ({
    floodCells: document.querySelectorAll('#mapFlood rect').length,
    roadMarkers: document.querySelectorAll('#mapRoads circle').length,
  }))()`)
  check('overlays survive a map filter change',
    after.floodCells === sim.cells && after.roadMarkers === roads.markers,
    `flood ${after.floodCells}/${sim.cells}, roads ${after.roadMarkers}/${roads.markers}`)

  // Clearing must remove the shading, not just hide the legend.
  await evaluate(`document.getElementById('floodClear').click(); true`)
  await new Promise((r) => setTimeout(r, 1500))
  const cleared = await evaluate(`(() => ({
    cells: document.querySelectorAll('#mapFlood rect').length,
    legendHidden: document.getElementById('floodLegend').hidden,
    status: document.getElementById('floodStatus').textContent,
  }))()`)
  check('clear removes the shading and the legend',
    cleared.cells === 0 && cleared.legendHidden, cleared.status.trim().slice(0, 50))

  // Route planning. This was API-only: a panel had no way to see a route
  // without curl, so the check drives the real controls.
  const routeReady = await evaluate(`(() => ({
    from: !!document.getElementById('routeFrom'),
    to: !!document.getElementById('routeTo'),
    options: (document.getElementById('routeFrom')||{}).options?.length || 0,
  }))()`)
  check('route endpoint selects are populated from road assets',
    routeReady.from && routeReady.to && routeReady.options >= 2,
    `${routeReady.options} roads`)

  // Depot -> clinic should detour via the bypass; depot -> flooded road must fail.
  await evaluate(`(() => {
    const from = document.getElementById('routeFrom');
    const to = document.getElementById('routeTo');
    const pick = (el, re) => { const o = [...el.options].find(x => re.test(x.textContent)); if (o) el.value = o.value; };
    pick(from, /depot/i);
    pick(to, /clinic approach/i);
    from.dispatchEvent(new Event('change'));
    to.dispatchEvent(new Event('change'));
    document.getElementById('routePlan').click();
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 5000))

  const route = await evaluate(`(() => {
    const pts = [...document.querySelectorAll('#mapRoute .route-hop-order')]
      .map(n => [parseFloat(n.getAttribute('x')), parseFloat(n.getAttribute('y'))])
    let spanX = 0, spanY = 0
    if (pts.length >= 2) {
      spanX = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))
      spanY = Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]))
    }
    return {
      status: document.getElementById('routeStatus').textContent,
      hops: [...document.querySelectorAll('#routeHops li')].map(li => li.querySelector('.route-hop-name')?.textContent),
      markers: document.querySelectorAll('#mapRoute .route-hop').length,
      numbered: document.querySelectorAll('#mapRoute .route-hop-order').length,
      // How much of the viewBox the hops occupy. Planning a route has to frame
      // on it: the Lodwar corridor is four roads inside six kilometres, so on a
      // region-wide frame the reroute that is the whole point of the feature
      // collapsed into one unreadable cluster.
      spread: Math.max(spanX, spanY),
      viewBox: (document.getElementById('situationMap').getAttribute('viewBox') || '').split(' ').map(Number),
    }
  })()`)

  check('route plan produces an ordered hop list',
    route.hops.length >= 2, route.hops.join(' → '))
  check('route markers are numbered to match the hop order',
    route.markers === route.hops.length && route.numbered === route.hops.length,
    `${route.markers} markers, ${route.numbered} numbers`)
  check('the route avoids the flooded segment',
    !route.hops.some((h) => /floodplain/i.test(h)), route.hops.join(' → '))
  const routeRefW = route.viewBox[2] || 800
  check('planning a route frames the map on that route',
    route.spread > routeRefW * 0.2,
    `hops span ${Math.round(route.spread)} of ${routeRefW} viewBox units`)
  check('route status reports distance, mode, and the impassable-segment rule',
    /km/.test(route.status) && /(vehicle|foot)/.test(route.status) && /not penalised/i.test(route.status),
    route.status.trim().slice(0, 130))

  // The failure mode must be explicit, not an empty success.
  await evaluate(`(() => {
    const from = document.getElementById('routeFrom');
    const to = document.getElementById('routeTo');
    const pick = (el, re) => { const o = [...el.options].find(x => re.test(x.textContent)); if (o) el.value = o.value; };
    pick(from, /depot/i);
    pick(to, /floodplain/i);
    from.dispatchEvent(new Event('change'));
    to.dispatchEvent(new Event('change'));
    document.getElementById('routePlan').click();
    return true;
  })()`)
  await new Promise((r) => setTimeout(r, 5000))
  const blocked = await evaluate(`(() => ({
    status: document.getElementById('routeStatus').textContent,
    hops: document.querySelectorAll('#routeHops li').length,
  }))()`)
  check('an unreachable destination fails loudly and names the cause',
    /no feasible road route/i.test(blocked.status) && blocked.hops === 0,
    blocked.status.trim().slice(0, 120))

  await evaluate(`document.getElementById('routeClear').click(); true`)
  await new Promise((r) => setTimeout(r, 1200))
  const routeCleared = await evaluate(`(() => ({
    markers: document.querySelectorAll('#mapRoute .route-hop').length,
    hops: document.querySelectorAll('#routeHops li').length,
    // Clearing must also give the region frame back, not leave the map stuck
    // on a corridor the operator is no longer planning through. The graticule
    // is the honest signal: it is drawn every 5 degrees, so a region-wide frame
    // has labelled lines and a 0.08-degree corridor frame has none.
    graticuleLines: document.querySelectorAll('#mapGraticule line').length,
    graticuleLabels: document.querySelectorAll('#mapGraticule text').length,
  }))()`)
  check('clearing the route removes the overlay',
    routeCleared.markers === 0 && routeCleared.hops === 0)
  check('clearing the route returns the map to the region frame',
    routeCleared.graticuleLabels > 0,
    `${routeCleared.graticuleLines} graticule lines, ${routeCleared.graticuleLabels} labels after clear`)

  // Seasonal context. The wording is the assertion: a bare "El Nino" would
  // assert a declared event the connector deliberately refuses to declare.
  const seasonal = await evaluate(`(() => ({
    phase: (document.getElementById('seasonalPhase')||{}).textContent || '',
    anomaly: (document.getElementById('seasonalAnomaly')||{}).textContent || '',
    period: (document.getElementById('seasonalPeriod')||{}).textContent || '',
    pips: document.querySelectorAll('#seasonalPips .seasonal-pip').length,
    met: document.querySelectorAll('#seasonalPips .seasonal-pip.is-met').length,
    note: (document.getElementById('seasonalNote')||{}).textContent || '',
    index: (document.getElementById('seasonalIndex')||{}).textContent || '',
  }))()`)

  check('seasonal strip reports the Nino 3.4 state',
    /°C/.test(seasonal.anomaly) && /^\d{4}-\d{2}$/.test(seasonal.period),
    `${seasonal.period} ${seasonal.anomaly} ${seasonal.phase}`)
  check('the phase label is qualified as an advisory',
    seasonal.phase === 'Neutral' || seasonal.phase.endsWith('advisory'),
    seasonal.phase)
  check('five season pips are shown, with the qualifying ones filled',
    seasonal.pips === 5 && seasonal.met <= 5, `${seasonal.met} of 5 filled`)
  check('the note states how close it is to a declared episode',
    /of 5 consecutive overlapping seasons|episode criterion is met/i.test(seasonal.note),
    seasonal.note.slice(0, 130))
  check('the note says what the index is not',
    /not a rainfall forecast/i.test(seasonal.note))
  check('the index identity is preserved rather than relabelled',
    /monthly nino34 sst anomaly/i.test(seasonal.index), seasonal.index)

  // Every top-level surface must render. The navbar exposes eight pages and only
  // Ops had ever been opened in a browser; the district drill-down was found
  // reporting zero interventions and zero people reached because it filtered
  // coordinate-less records by proximity.
  const PAGES = ['/', '/focal-point', '/chw', '/portal', '/co', '/scenarios', '/parametric', '/districts']
  for (const path of PAGES) {
    const before = pageErrors.length
    await send('Page.navigate', { url: `${BASE}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}` })
    await new Promise((r) => setTimeout(r, 3000))
    const page = await evaluate(`(() => ({
      chars: document.body.innerText.trim().length,
      nav: (document.querySelector('.l-navbar-links a[aria-current=page]') || {}).textContent || '',
      suspect: /NaN|\\[object Object\\]|undefined/.test(document.body.innerText),
    }))()`)
    check(`surface "${path}" renders content and marks itself current`,
      page.chars > 100 && page.nav.length > 0 && !page.suspect,
      `${page.chars} chars, nav "${page.nav}"`)
    check(`surface "${path}" produces no console errors`,
      pageErrors.length === before, (pageErrors[pageErrors.length - 1] || '').slice(0, 60))
  }

  // No locale may render an i18n key as user-visible text. The catalogue was
  // replaced outright at boot, so a partially translated locale printed
  // `equity.acknowledged` as a column header. English is now the base layer, so
  // a gap degrades to English — which is a translation gap, reported by
  // scripts/check-i18n.mjs, rather than a broken screen.
  await send('Page.navigate', { url: `${BASE}/?cb=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 2800))
  const offeredUi = await evaluate(`(() => {
    // The dashboard's own control lives in the topbar as #locale-select; the
    // navbar renders a separate switcher only when a surface asks for one.
    const s = document.getElementById('locale-select');
    return s ? [...s.options].map((o) => o.value) : [];
  })()`)
  check('the dashboard offers more than one language', offeredUi.length >= 2, offeredUi.join(', '))

  for (const locale of offeredUi) {
    await evaluate(`localStorage.setItem('lindela_lite_locale', '${locale}')`)
    await send('Page.navigate', { url: `${BASE}/?cb=${Date.now()}` })
    await new Promise((r) => setTimeout(r, 2600))
    await evaluate(`(() => { const s = document.getElementById('locale-select');
      if (s) { s.value = '${locale}'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true })()`)
    await new Promise((r) => setTimeout(r, 1200))
    const shown = await evaluate(`(() => {
      const text = document.body.innerText;
      // Keys look like namespace.token; exclude real filenames and URLs.
      const keys = (text.match(/\\b[a-z]{2,6}\\.[a-z_]{3,}\\b/g) || [])
        .filter((k) => !/\\.(md|css|js|json|com|org|html|svg|png)\\b/.test(k));
      return { lang: document.documentElement.lang, keys: [...new Set(keys)].slice(0, 5), chars: text.trim().length };
    })()`)
    check(`dashboard renders no raw i18n keys in "${locale}"`,
      shown.keys.length === 0 && shown.chars > 100,
      shown.keys.length ? `raw: ${shown.keys.join(', ')}` : `lang=${shown.lang}, ${shown.chars} chars`)
  }
  await evaluate(`localStorage.removeItem('lindela_lite_locale'); true`)

  // Every language the CHW app offers must actually render. It previously
  // offered nine and had CHW strings for three, so a health worker selecting
  // Karimojong or Français read `chw.symptom_fever` as a button label. The
  // element existed, the text was non-empty and there were no console errors —
  // only reading the screen showed the app was unreadable in the field.
  await send('Page.navigate', { url: `${BASE}/chw?cb=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 2800))
  const offeredLocales = await evaluate(`[...document.getElementById('locale-select').options].map(o => o.value)`)
  check('the CHW app offers at least one language', offeredLocales.length >= 1, offeredLocales.join(', '))

  for (const locale of offeredLocales) {
    await evaluate(`(async () => {
      const s = document.getElementById('locale-select');
      s.value = '${locale}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 1000))
    const rendered = await evaluate(`(() => {
      const text = document.body.innerText;
      const rawKeys = (text.match(/\\b[a-z]+\\.[a-z_]+\\b/g) || []).filter((k) => k.startsWith('chw.'));
      const buttons = [...document.querySelectorAll('#homeScreen button')].map((b) => b.textContent.trim());
      return { rawKeys: [...new Set(rawKeys)].slice(0, 5), buttons, emptyButtons: buttons.filter((b) => !b).length };
    })()`)
    check(`CHW renders fully in "${locale}" with no raw keys`,
      rendered.rawKeys.length === 0 && rendered.emptyButtons === 0 && rendered.buttons.length === 3,
      rendered.rawKeys.length ? `raw keys: ${rendered.rawKeys.join(', ')}` : rendered.buttons.join(' / '))
  }

  // The CHW reporting flow, walked the way a health worker walks it. Loading
  // /chw and finding no console errors is not the same as the flow working: the
  // wizard is five screens with a submit at the end, and nothing else in the
  // suite touched it.
  //
  // This is where a fabricated coordinate was found. The client used (0, 0) as
  // its "no location" sentinel and the server wrote `latitude || 0`, so a phone
  // with no GPS fix produced a field report at Null Island — a disease signal
  // that looks located while pointing at open water.
  await send('Page.navigate', { url: `${BASE}/chw?cb=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 3000))
  const beforeReports = await (await fetch(`${BASE}/api/v1/field-reports?limit=5000`)).json().then((b) => b.data.length)
  await evaluate(`document.getElementById('reportSymptomBtn').click(); true`)
  await new Promise((r) => setTimeout(r, 600))

  const WIZARD = [
    { pick: '[data-symptom-who]', next: 'symptomNextBtn' },
    { pick: '[data-symptom-type]', next: 'symptomTypeNextBtn' },
    { pick: '[data-symptom-duration]', next: 'symptomDurationNextBtn' },
    { pick: '[data-symptom-location]', next: 'symptomLocationNextBtn' },
  ]
  let wizardStuck = null
  for (const step of WIZARD) {
    const picked = await evaluate(`(() => { const b = document.querySelector('${step.pick}');
      if (!b) return false; b.click(); return true; })()`)
    const hasNext = await evaluate(`!!document.getElementById('${step.next}')`)
    if (!picked || !hasNext) { wizardStuck = `${step.pick} -> ${step.next}`; break }
    await evaluate(`document.getElementById('${step.next}').click(); true`)
    await new Promise((r) => setTimeout(r, 500))
  }
  check('the CHW symptom wizard advances through every screen',
    wizardStuck === null, wizardStuck || 'all steps advanced')

  await evaluate(`document.getElementById('symptomSubmitBtn').click(); true`)
  await new Promise((r) => setTimeout(r, 2000))
  const reports = await (await fetch(`${BASE}/api/v1/field-reports?limit=5000`)).json().then((b) => b.data)
  const created = reports.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  check('a CHW report is actually created',
    reports.length === beforeReports + 1 && created?.source === 'chw_web',
    `${beforeReports} -> ${reports.length}, source ${created?.source}`)
  check('a CHW report with no GPS fix carries no coordinate',
    !(created?.latitude === 0 && created?.longitude === 0),
    `lat ${created?.latitude}, lon ${created?.longitude}`)
  check('a CHW report states how its location was determined',
    typeof created?.location_source === 'string' && created.location_source.length > 0,
    `location_source ${created?.location_source}`)

  // Remove it, so the check leaves the store as it found it.
  if (created?.id) {
    await fetch(`${BASE}/api/v1/field-reports/${created.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'browser-check' }),
    }).catch(() => {})
  }

  // District drill-down, reached the way a panel would.
  await send('Page.navigate', { url: `${BASE}/districts?cb=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 3000))
  const district = await evaluate(`(async () => {
    const card = document.querySelector('a[href^="/districts#/"]');
    if (!card) return { noCard: true };
    card.click();
    await new Promise(r => setTimeout(r, 2500));
    const text = document.body.innerText;
    return {
      hash: location.hash,
      chars: text.length,
      interventions: (text.match(/Interventions \\((\\d+)\\)/) || [])[1],
      tasks: (text.match(/Tasks \\((\\d+)\\)/) || [])[1],
      reached: (text.match(/People reached\\s*\\n?\\s*([\\d,]+)/) || [])[1],
      blankDate: /Hazard[\\s\\S]{0,80}\\n\\s*\\n\\s*\\n/.test(text),
    };
  })()`)
  check('district drill-down opens from a card', !district.noCard && district.hash.startsWith('#/'),
    district.hash || 'no card')
  check('district shows non-zero interventions and tasks',
    Number(district.interventions) > 0 && Number(district.tasks) > 0,
    `interventions ${district.interventions}, tasks ${district.tasks}`)
  check('district shows a non-zero people-reached figure',
    Number(String(district.reached || '').replace(/,/g, '')) > 0,
    `${district.reached} people`)
  check('hazard rows render a date', district.blankDate === false)

  await send('Page.navigate', { url: `${BASE}/?cb=${Date.now()}` })
  await new Promise((r) => setTimeout(r, 3500))

  // Every rail tab must render content, produce no console errors, and keep its
  // table inside the panel. Two
  // defects were found this way: the equity panel read dispatch status from
  // alert_events (which carry no such field) so "dispatched" was always 0 and
  // the rate column showed "—" everywhere; and unavailable sources rendered as
  // a bare "never_run" with no explanation.
  const railTabs = await evaluate(`[...document.querySelectorAll('.rail-tab')].map(b => b.dataset.tab)`)
  check('every rail tab is present', railTabs.length >= 5, railTabs.join(', '))

  for (const tab of railTabs) {
    const errorsBefore = pageErrors.length
    await evaluate(`document.querySelector('.rail-tab[data-tab="${tab}"]').click(); true`)
    await new Promise((r) => setTimeout(r, 1800))
    const panel = await evaluate(`(() => {
      const el = document.getElementById('panel-${tab}');
      if (!el) return { exists: false, chars: 0, visible: false };
      const text = el.innerText.trim();
      return { exists: true, chars: text.length, visible: !el.hidden && el.classList.contains('active') };
    })()`)
    check(`rail tab "${tab}" renders visible content`,
      panel.exists && panel.visible && panel.chars > 0,
      `${panel.chars} chars`)
    check(`rail tab "${tab}" produces no console errors`,
      pageErrors.length === errorsBefore,
      (pageErrors[pageErrors.length - 1] || '').slice(0, 70))

    // Content that renders outside its container is invisible, not wrong, so no
    // amount of "the element exists and has text" catches it. The equity table
    // overflowed the rail by 29px behind overflow-x: hidden, cutting off the
    // "Not acknowledged" column entirely — the column that says who was not
    // reached, on the surface whose whole purpose is that.
    const clipped = await evaluate(`(() => {
      const panel = document.getElementById('panel-${tab}')
      if (!panel) return { count: 0, sample: '' }
      const pr = panel.getBoundingClientRect()
      const bad = []
      for (const n of panel.querySelectorAll('table, thead, tbody, tr, th, td')) {
        const r = n.getBoundingClientRect()
        if (r.width > 1 && r.right > pr.right + 1) {
          bad.push((n.tagName + ':' + (n.textContent || '').trim().slice(0, 24)))
        }
      }
      return { count: bad.length, sample: bad.slice(0, 3).join(' | ') }
    })()`)
    check(`rail tab "${tab}" keeps its table inside the panel`,
      clipped.count === 0,
      clipped.count ? `${clipped.count} clipped: ${clipped.sample}` : 'no clipped cells')
  }

  // Back to the equity tab for the specific assertions.
  await evaluate(`document.querySelector('.rail-tab[data-tab="equity"]').click(); true`)
  await new Promise((r) => setTimeout(r, 1800))
  const equity = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#equityTable tbody tr')].map(tr =>
      [...tr.children].map(td => td.textContent.trim()));
    const header = [...document.querySelectorAll('#equityTable thead th')].map(th => th.textContent.trim());
    return { rows, header, note: (document.getElementById('equityMethodNote')||{}).textContent || '' };
  })()`)

  const dispatchedTotal = equity.rows.reduce((sum, r) => sum + Number(r[1] || 0), 0)
  check('equity counts real dispatches, not zero everywhere',
    dispatchedTotal > 0,
    `${dispatchedTotal} dispatched across ${equity.rows.length} districts`)
  check('equity does not label an unactioned rate as false positives',
    !equity.header.some((h) => /false positive/i.test(h)),
    equity.header.join(' | '))
  check('equity states what the rate does and does not measure',
    /not a false-positive rate/i.test(equity.note))

  await evaluate(`document.querySelector('.rail-tab[data-tab="ingestion"]').click(); true`)
  await new Promise((r) => setTimeout(r, 1800))
  const unavailable = await evaluate(`[...document.querySelectorAll('#sourceStatusList .source-card.is-unavailable')]
    .map(c => ({
      name: (c.querySelector('.source-name')||{}).textContent || '',
      reason: ((c.querySelector('.source-reason')||{}).textContent || '').trim(),
    }))`)
  check('sources unavailable by design explain themselves',
    unavailable.length > 0 && unavailable.every((s) => s.reason.length > 10),
    unavailable.map((s) => `${s.name.split(' ')[0]}`).join(', ') || 'none flagged')
  check('unavailable sources name the actual cause',
    unavailable.some((s) => /NASA_FIRMS_MAP_KEY/.test(s.reason))
    && unavailable.some((s) => /glofas|feed/i.test(s.reason)),
    unavailable.map((s) => s.reason.slice(0, 40)).join(' / '))

  const fatal = pageErrors.filter((e) => !/favicon|ERR_FAILED.*favicon/i.test(e))
  check('no unhandled page errors', fatal.length === 0, fatal.slice(0, 2).join(' | ') || 'none')

  // The build version a panel reads must be the released one. It used to be a
  // literal in three places that drifted behind package.json, so "which build is
  // this?" had a wrong answer. Sourced from the health endpoint, which reads
  // package.json, so this cannot drift without the health endpoint changing.
  const shownVersion = await evaluate(`(() => {
    const n = document.querySelector('[data-app-version]');
    return n ? n.textContent.trim() : null;
  })()`)
  const healthVersion = await (await fetch(`${BASE}/api/v1/health`)).json().then((b) => b.version)
  check('the displayed build version is the released version',
    Boolean(shownVersion) && healthVersion && shownVersion === `v${healthVersion}`,
    `shown ${shownVersion || 'nothing'}, released v${healthVersion || 'unknown'}`)

  const failed = checks.filter((c) => !c.passed)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error('browser check failed:', error.message)
  process.exitCode = 1
}).finally(() => {
  try { socket?.close() } catch { /* already closed */ }
})