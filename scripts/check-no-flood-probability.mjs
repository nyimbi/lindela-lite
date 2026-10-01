import fs from 'node:fs'
import path from 'node:path'

/**
 * Flood-probability guard.
 *
 * The project rule is that rainfall intensity/duration to flood probability is
 * NOT implemented, and may only be implemented against an explicit, documented,
 * agreed model basis. Until that agreement exists, nothing in the shipped
 * surface may claim a flood probability or a return period.
 *
 * This turns that rule from a comment into a build gate. Without it the rule
 * survives only as author discipline, and the exact failure it exists to
 * prevent — a number shaped like a probability that no model supports — could
 * be added by anyone and would pass every test.
 *
 * To lift the guard legitimately: agree the model basis first, record it in
 * docs/flood-probability-model-basis.md (which validate.mjs already requires to
 * declare its status), and set AGREED_MODEL_BASIS below to that document. Do
 * not lift it by deleting this file.
 */

const AGREED_MODEL_BASIS = null

const SURFACE_GLOBS = ['src', 'public', 'scripts', 'test']

// Terms that assert a probability or a return level. Deliberately specific:
// "risk", "score" and "probability" alone are too broad, and "precipitation_probability_pct"
// is a forecast field from Open-Meteo, not a flood return period.
const FORBIDDEN = [
  'flood_probability',
  'floodprobability',
  'flood_return_period',
  'annual_exceedance',
  'exceedance_probability',
  'return_period_years',
  'inundation_probability',
  'flood_frequency',
  'gevfitted',
  'gev_fitted',
  'idf_curve',
  'rational_method',
]

/** Recursively list source files under a directory. */
function filesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (/\.(js|mjs|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

if (AGREED_MODEL_BASIS) {
  if (!fs.existsSync(AGREED_MODEL_BASIS)) {
    throw new Error(`AGREED_MODEL_BASIS points at a missing document: ${AGREED_MODEL_BASIS}`)
  }
} else {
  const offenders = []
  for (const dir of SURFACE_GLOBS) {
    if (!fs.existsSync(dir)) continue
    for (const file of filesUnder(dir)) {
      // This file necessarily contains every term it searches for.
      if (path.resolve(file) === path.resolve(new URL(import.meta.url).pathname)) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const term of FORBIDDEN) {
        if (text.toLowerCase().includes(term)) {
          offenders.push(`${file}: '${term}'`)
        }
      }
    }
  }
  if (offenders.length) {
    throw new Error(
      'Flood-probability surface present with no agreed model basis.\n'
      + `  ${offenders.join('\n  ')}\n`
      + 'Rainfall intensity/duration to flood probability requires an explicit documented\n'
      + 'model basis agreed in advance. Invented coefficients that look authoritative are\n'
      + 'worse than no output. See docs/flood-probability-model-basis.md.',
    )
  }
}
