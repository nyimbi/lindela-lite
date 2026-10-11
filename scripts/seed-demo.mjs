#!/usr/bin/env node
/**
 * The demo seed, run from a terminal.
 *
 * ARC-03. The implementation moved to `src/demo-seed.js` so that the API route
 * serving it does not import from `scripts/`. This file keeps the command
 * `node scripts/seed-demo.mjs` working — `package.json`, `run.sh` and the demo
 * guide all name it — and re-exports the library so nothing else has to move.
 */
import { createStoreFromEnv } from '../src/storage.js'
import { refreshAnalytics } from '../src/analytics.js'
import { ingestPublicSources, seedAll, summary } from '../src/demo-seed.js'

export { ingestPublicSources, seedAll, summary }

async function main() {
  const store = await createStoreFromEnv()
  console.error('[seed] ingesting public sources...')
  const ingestionResults = await ingestPublicSources(store)
  console.error('[seed] ingestion results:', JSON.stringify(ingestionResults))
  console.error('[seed] seeding operational data...')
  await seedAll(store)
  console.error('[seed] refreshing analytics...')
  await refreshAnalytics(store)
  const counts = await summary(store)
  console.log(JSON.stringify(counts, null, 2))
  console.error('[seed] done.')
}

if (process.argv[1] && process.argv[1].endsWith('seed-demo.mjs')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
