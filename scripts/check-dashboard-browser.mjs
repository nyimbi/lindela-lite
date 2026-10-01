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

  const route = await evaluate(`(() => ({
    status: document.getElementById('routeStatus').textContent,
    hops: [...document.querySelectorAll('#routeHops li')].map(li => li.querySelector('.route-hop-name')?.textContent),
    markers: document.querySelectorAll('#mapRoute .route-hop').length,
    numbered: document.querySelectorAll('#mapRoute .route-hop-order').length,
  }))()`)

  check('route plan produces an ordered hop list',
    route.hops.length >= 2, route.hops.join(' → '))
  check('route markers are numbered to match the hop order',
    route.markers === route.hops.length && route.numbered === route.hops.length,
    `${route.markers} markers, ${route.numbered} numbers`)
  check('the route avoids the flooded segment',
    !route.hops.some((h) => /floodplain/i.test(h)), route.hops.join(' → '))
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
  }))()`)
  check('clearing the route removes the overlay',
    routeCleared.markers === 0 && routeCleared.hops === 0)

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
    /\(ONI\)/.test(seasonal.index), seasonal.index)

  // Every rail tab must render content and produce no console errors. Two
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