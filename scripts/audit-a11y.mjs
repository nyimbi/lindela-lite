#!/usr/bin/env node
/**
 * Programmatic accessibility audit — axe-core 4.13 against every surface, in
 * every theme, at phone and desktop widths.
 *
 * `scripts/check-a11y.mjs` asserts the structural invariants this project
 * chose to hold itself to. This asks a different question: what does axe-core,
 * which knows WCAG 2.0/2.1/2.2 as published, find that our own assertions do
 * not cover?
 *
 * Findings are written to `docs/ux-improvements/findings/a11y.json` so the
 * audit is reproducible rather than a claim in prose. Exit code is zero even
 * with violations — this is a measurement, not a gate. Use
 * `npm run check:a11y` to fail the build.
 *
 * Usage: node scripts/audit-a11y.mjs            (Chrome on :9222 or LINDELA_LITE_CDP)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CDP = process.env.LINDELA_LITE_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.LINDELA_LITE_BASE || 'http://127.0.0.1:4177'
const AXE_PATH = path.join(root, 'node_modules/axe-core/axe.min.js')

const SURFACES = [
  ['dashboard', '/'], ['portal', '/portal/'], ['chw', '/chw/'], ['co', '/co/'],
  ['districts', '/districts/'], ['focal-point', '/focal-point/'],
  ['parametric', '/parametric/'], ['scenarios', '/scenarios/'],
]

/** Themes x widths. Contrast and reflow both depend on the media query. */
const CONDITIONS = [
  { theme: 'dark', scheme: 'dark', width: 1440, height: 900, tag: 'dark@1440' },
  { theme: 'dark', scheme: 'dark', width: 375, height: 812, tag: 'dark@375' },
  { theme: 'light', scheme: 'light', width: 1440, height: 900, tag: 'light@1440' },
  { theme: 'light', scheme: 'light', width: 375, height: 812, tag: 'light@375' },
  { theme: 'contrast', scheme: 'dark', width: 1440, height: 900, tag: 'contrast@1440' },
]

/** Tag set: WCAG 2.0 A/AA, 2.1 AA, and the 2.2 additions axe knows about. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

class Session {
  #ws
  #id = 0
  #pending = new Map()

  static async open() {
    const targets = await (await fetch(`${CDP}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error(`no page target at ${CDP}`)
    const s = new Session()
    s.#ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      s.#ws.addEventListener('open', res, { once: true })
      s.#ws.addEventListener('error', rej, { once: true })
    })
    s.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const waiter = s.#pending.get(msg.id)
      if (!waiter) return
      s.#pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    })
    return s
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() { this.#ws.close() }
}

const evalIn = async (session, expression) => {
  const r = await session.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed')
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const axeSource = await readFile(AXE_PATH, 'utf8')
  const session = await Session.open()
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Network.enable')

  const results = []

  for (const [name, urlPath] of SURFACES) {
    for (const cond of CONDITIONS) {
      await session.send('Network.setCacheDisabled', { cacheDisabled: true })
      await session.send('Network.clearBrowserCache')
      await session.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: cond.scheme },
          { name: 'prefers-contrast', value: cond.theme === 'contrast' ? 'more' : 'no-preference' },
        ],
      })
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: cond.width, height: cond.height, deviceScaleFactor: 1, mobile: cond.width < 700,
      })
      await session.send('Page.navigate', { url: BASE + urlPath })
      await sleep(2600)

      // Theme is applied by the page's own script from the media query, so the
      // emulated scheme is what axe measures against. Recorded for the report.
      const applied = await evalIn(session, `(() => {
        const cs = getComputedStyle(document.documentElement)
        return JSON.stringify({
          theme: document.documentElement.getAttribute('data-theme'),
          bg: cs.getPropertyValue('--bg').trim(),
          stored: localStorage.getItem('lindela-theme'),
        })
      })()`)

      await evalIn(session, axeSource)
      const raw = await evalIn(session, `axe.run(document, {
        runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} },
        resultTypes: ['violations'],
      }).then(r => JSON.stringify(r.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes.slice(0, 5).map(n => ({
          target: n.target,
          failureSummary: (n.failureSummary || '').split('\\n').slice(0, 3).join(' '),
          html: (n.html || '').slice(0, 240),
        })),
        nodeCount: v.nodes.length,
      }))))`)

      const violations = JSON.parse(raw)
      results.push({
        surface: name,
        path: urlPath,
        condition: cond.tag,
        applied: JSON.parse(applied),
        violations,
      })

      const impactCount = violations.reduce((acc, v) => {
        acc[v.impact || 'unknown'] = (acc[v.impact || 'unknown'] || 0) + 1
        return acc
      }, {})
      const summary = Object.entries(impactCount).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'
      process.stdout.write(
        `${violations.length ? 'FAIL' : 'ok  '}  ${name.padEnd(13)} ${cond.tag.padEnd(14)} ${summary}\n`,
      )
    }
  }

  session.close()

  const outDir = path.join(root, 'docs/ux-improvements/findings')
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'a11y.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    engine: `axe-core 4.13.0, tags ${TAGS.join(',')}`,
    conditions: CONDITIONS.map((c) => c.tag),
    results,
  }, null, 2))

  // A flat roll-up for the audit document.
  const byId = new Map()
  for (const r of results) {
    for (const v of r.violations) {
      if (!byId.has(v.id)) {
        byId.set(v.id, { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags, where: new Set(), nodes: v.nodes })
      }
      const entry = byId.get(v.id)
      entry.where.add(`${r.surface} ${r.condition}`)
      if (v.impact === 'critical' || v.impact === 'serious') entry.nodes = entry.nodes.concat(v.nodes.slice(0, 2))
    }
  }
  const rollup = [...byId.values()]
    .map((v) => ({ ...v, where: [...v.where] }))
    .sort((a, b) => {
      const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 }
      return (rank[a.impact] ?? 9) - (rank[b.impact] ?? 9)
    })

  await writeFile(path.join(outDir, 'a11y-rollup.json'), JSON.stringify(rollup, null, 2))

  console.log(`\n${rollup.length} distinct rules violated across 8 surfaces × ${CONDITIONS.length} conditions.`)
  for (const v of rollup) console.log(`  [${(v.impact || '?').padEnd(8)}] ${v.id.padEnd(28)} ${v.where.length} occurrence(s)`)
  console.log(`\nWritten to docs/ux-improvements/findings/a11y{,-rollup}.json`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
