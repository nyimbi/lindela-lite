import fs from 'node:fs'

const items = []
for (const g of ['a', 'b', 'c', 'de']) {
  items.push(...JSON.parse(fs.readFileSync(`docs/improvements/_status-${g}.json`, 'utf8')).items)
}
const num = (id) => Number(id.replace('ENH-', ''))
items.sort((x, y) => num(x.id) - num(y.id))

const MARK = { shipped: 'shipped', partial: 'partial', 'not started': '**not started**' }
/** A pipe inside a cell ends the cell. ENH-06's title contains three of them. */
const cell = (text) => String(text).replace(/\|/g, '\\|')
const groupOf = (id) => {
  const n = num(id)
  return n <= 5 ? 'A' : n <= 15 ? 'B' : n <= 24 ? 'C' : n <= 28 ? 'D' : 'E'
}
const TITLES = {
  A: 'Trust: make the honesty reach the payload',
  B: 'Ingestion fidelity, quality, timeliness',
  C: 'Visualization depth',
  D: 'Response and delivery',
  E: 'Platform foundations',
}

const out = []
const counts = { shipped: 0, partial: 0, 'not started': 0 }
for (const g of ['A', 'B', 'C', 'D', 'E']) {
  out.push(`## Group ${g} — ${TITLES[g]}`, '')
  out.push('| | Enhancement | Status | Guarded by |')
  out.push('|---|---|---|---|')
  for (const i of items.filter((x) => groupOf(x.id) === g)) {
    counts[i.status] += 1
    const guard = i.guarded_by ? i.guarded_by.split(', ').map((t) => `\`${t}\``).join(', ') : '—'
    out.push(`| ${i.id} | ${cell(i.title)} | ${MARK[i.status]} | ${guard} |`)
  }
  out.push('')
}

out.push('---', '', '## What each partial is missing', '')
for (const i of items.filter((x) => x.status !== 'shipped')) {
  out.push(`### ${i.id} — ${i.title}`, '')
  out.push(`**${i.status}.** ${i.detail}`, '')
  if (i.evidence.length) {
    out.push('Evidence:', '')
    for (const e of i.evidence) out.push(`- \`${e}\``)
    out.push('')
  }
}

out.push('---', '', '## The patterns', '')
out.push(
  'Three shapes recur, and each one is this repository\'s own defect class rather than a',
  'coincidence of what happened to get built.',
  '',
  '**The most recent wave reproduced the first pattern while trying to fix it.** Group B was',
  'the outlier — nine of ten items untouched — so eight modules were built in parallel with',
  'tests, and four of them were then wired into `runIngestion`: quarantine (`ENH-07`), the',
  'circuit gate (`ENH-10`), the freshness verdict on the status route (`ENH-06`) and record',
  'provenance (`ENH-15`). The other four — watermarks (`ENH-08`), agreement (`ENH-09`),',
  'capture (`ENH-12`) and completeness (`ENH-14`) — are still exported, tested and called by',
  'nothing, which is exactly the defect below, now four instances wider and written by the',
  'same effort that was fixing it. The ledger counts them partial for that reason and not',
  'because their logic is unfinished.',
  '',
  '**A capability landed where one call site existed and nowhere else.** The chart library',
  '(`ENH-16`) is 640 lines with 50 tests and is imported by 2 of 8 surfaces; `lineChart`,',
  '`stackedBar` and `heatmap` are exported, tested, and called by nothing in the product.',
  '`ENH-17`, `ENH-20` and `ENH-21` all need one of those three, so three items are blocked',
  'behind call sites that do not exist. Same shape in `ENH-04`: sampling uncertainty reached',
  '`/api/v1/flood-probability/score` and no other route.',
  '',
  '**Uncertainty stopped at one boundary.** `ENH-02` (the envelope), `ENH-04` (three tiers),',
  '`ENH-17` (uncertainty as geometry) and `ENH-21` (forecast verification) are four items',
  'about the same idea. One tier, on one route, in prose in the docs and a Wilson interval in',
  'one response field. Every one of them says the same thing: the caveat has to travel with the',
  'number, and it currently travels with about one number.',
  '',
  '**A list written once and checked nowhere.** `ENH-01` is the shape this class takes, and',
  'fixing it found the defect: deny-by-default shipped as *behaviour* with its route→scope table',
  'module-private, so nothing could iterate it. Exporting the table found seven mutating routes no',
  'prefix covered - each already failing closed, each a 403 to a caller holding the documented',
  'scope. `ENH-29` still has it: a conformance suite that covers Postgres only when a CI job nobody',
  'sets provides a database, so CI exercises one adapter and reports both. `ENH-24` has no test at',
  'all.',
  '',
  'Group B was the outlier and now is not, but it is not done either: four of ten shipped and',
  'six are partial, and in five of those six the missing half is the same half — a module that',
  'works, tested, and has no caller. The rate limiter is the sharpest case: the token bucket and',
  'the `Retry-After` handling are written, and the `perMinute 20` declared beside an unbounded',
  '`Promise.all` in the IPC connector is still documentation.',
)

const header = [
  '# Enhancement status',
  '',
  'What has actually shipped, verified against the tree rather than against the commit log.',
  'Regenerate with `node docs/improvements/_build-status.mjs` after editing any',
  '`_status-*.json`.',
  '',
  `**${counts.shipped} shipped, ${counts.partial} partial, ${counts['not started']} not started,** of 30.`,
  'The two that shipped before this round were the two the project was built to make possible',
  'anyway: the API substrate a caller can integrate against (`ENH-30`) and a way to get your',
  'own data in (`ENH-25`). The five since are the ones where a claim had become load-bearing —',
  'a quarantine collection that had to exist for the store not to drop condemned batches on the',
  'floor (`ENH-07`), a history that had to exist before the next overwrite destroyed the only',
  'record of the previous value (`ENH-13`), and three that had stopped being honest.',
  '',
  'A status is **partial** when some of the described change is in the tree and the rest is',
  'not, and the detail says which is which. An exported function with no call site is not',
  'shipped: three of the chart library\'s six primitives are exported, tested, and called by',
  'nothing in the product.',
  '',
  '---',
  '',
]
fs.writeFileSync('docs/improvements/status.md', `${header.join('\n')}${out.join('\n')}\n`)
console.log(counts)
