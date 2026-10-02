import fs from 'node:fs'
import path from 'node:path'

/**
 * Flood-probability guard.
 *
 * The project rule is that rainfall intensity/duration to flood probability is
 * implemented ONLY against the explicit, documented, agreed model basis in
 * docs/flood-probability-model-basis.md — empirical rainfall-flood
 * co-occurrence with hard sample-size refusals, agreed 2026-10-02. Until that
 * agreement existed this file scanned the shipped surface and refused the word
 * "flood_probability" outright; that scan is now lifted by setting
 * AGREED_MODEL_BASIS below, exactly the legitimate path this file documented.
 *
 * What is still scanned, even with the basis agreed: the vocabulary of the
 * BLOCKED routes — return periods, GEV fits, IDF curves, rational method,
 * design floods. Those were rejected on data grounds (no validated discharge
 * record; MERIT unreachable) and stay forbidden anywhere outside the basis
 * document, which records why. A return-period capability silently appearing
 * in a README would pass every functional test; it must not pass the build.
 */

const AGREED_MODEL_BASIS = 'docs/flood-probability-model-basis.md'

/**
 * Where a claim can hide.
 *
 * Originally only .js files. That is where the code lives but not where the
 * *claim* lives: a flood probability asserted in the OpenAPI contract, in a
 * dashboard label, or in the README is the thing a panel would act on, and all
 * three are outside a .js file. Documentation is the surface most likely to drift
 * ahead of the code, so it is scanned too.
 */
const SURFACE_GLOBS = ['src', 'public', 'scripts', 'test', 'docs']
const SURFACE_FILES = ['README.md', 'CHANGELOG.md', 'connectors.registry.json']

const SURFACE_EXTS = /\.(js|mjs|ts|md|yaml|yml|html|json)$/

/**
 * Documents whose job is to discuss this constraint, so they may name the terms.
 * Listed explicitly rather than pattern-matched so that adding a new document
 * cannot quietly join the exemption.
 */
const MAY_NAME_TERMS = new Set([
  'docs/flood-probability-model-basis.md',
  'docs/developer-guide.md',
])

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
  // The vocabulary a contributor would actually reach for. 'return_period_years'
  // above is one spelling of "return period"; these are the others, plus the
  // design-flood terms that read as authoritative without ever using the word
  // "probability".
  'return_period',
  'returnperiod',
  'probability_of_flood',
  'probability_of_inundation',
  'recurrence_interval',
  'design_flood',
  'design_flood_',
  'hundred_year_flood',
  '100_year_flood',
  '1_in_100',
  '1in100',
  'annual_chance',
  'aep_',
  '_aep',
  'exceedance_',
  'hazard_curve',
  'discharge_frequency',
  'discharge_frequency',
]

/**
 * Phrasings that cannot be caught as substrings because the number and the
 * word are separated, or the whole expression varies. Enumerating "1 in 100"
 * alone would miss "1 in 100 year", "1-in-100-year" and "1in1000", which is
 * precisely how these are written in prose and in UI copy.
 */
const FORBIDDEN_PATTERNS = [
  /\b1\s*[- ]?in\s*\d+\s*[- ]?year/i,
  /\b\d+\s*[- ]?year\s*[- ]?return\s*period/i,
  /\b\d+\s*[- ]?year\s*(?:flood|return\s*level|event)/i,
  /\b(?:once|every)\s+(?:in|per)\s*\d+\s*years?\b/i,
  /\breturn\s*period\b/i,
  /\bdesign\s+flood\b/i,
]


/** Recursively list surface files under a directory. */
function filesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (SURFACE_EXTS.test(entry.name)) out.push(full)
  }
  return out
}

/** Every file the guard reads, as repo-relative paths for exemption checks. */
function surfaceFiles() {
  const files = []
  for (const dir of SURFACE_GLOBS) {
    if (fs.existsSync(dir)) files.push(...filesUnder(dir))
  }
  for (const file of SURFACE_FILES) {
    if (fs.existsSync(file)) files.push(file)
  }
  return files
}

/**
 * Terms of the BLOCKED hydrological routes. Every one of these implies a fit
 * against a discharge record we do not have. Scanned always, agreement or no
 * agreement.
 */
const BLOCKED_ROUTES = [
  'return_period',
  'returnperiod',
  'recurrence_interval',
  'exceedance_probability',
  'annual_exceedance',
  'exceedance_',
  'annual_chance',
  'aep_',
  '_aep',
  'design_flood',
  'design_flood_',
  'hundred_year_flood',
  '100_year_flood',
  'hazard_curve',
  'discharge_frequency',
  'gevfitted',
  'gev_fitted',
  'idf_curve',
  'rational_method',
]

if (AGREED_MODEL_BASIS) {
  if (!fs.existsSync(AGREED_MODEL_BASIS)) {
    throw new Error(`AGREED_MODEL_BASIS points at a missing document: ${AGREED_MODEL_BASIS}`)
  }
  const offenders = []
  const self = path.resolve(new URL(import.meta.url).pathname)
  for (const file of surfaceFiles()) {
    if (path.resolve(file) === self) continue
    if (MAY_NAME_TERMS.has(file.split(path.sep).join('/'))) continue
    const lower = fs.readFileSync(file, 'utf8').toLowerCase()
    for (const term of BLOCKED_ROUTES) {
      if (lower.includes(term)) {
        offenders.push(`${file}: '${term}'`)
      }
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      const hit = lower.match(pattern)
      if (hit) offenders.push(`${file}: matches /${pattern.source}/i ('${hit[0]}')`)
    }
  }
  if (offenders.length) {
    throw new Error(
      'Blocked hydrological-route surface present outside the basis document.\n'
      + `  ${offenders.join('\n  ')}\n`
      + 'Return periods, GEV/IDF/rational-method fits are rejected by the agreed basis —\n'
      + 'no validated discharge record backs them. Name them only when recording why\n'
      + 'they are blocked, in docs/flood-probability-model-basis.md.',
    )
  }
} else {
  const offenders = []
  const self = path.resolve(new URL(import.meta.url).pathname)
  for (const file of surfaceFiles()) {
    // This file necessarily contains every term it searches for.
    if (path.resolve(file) === self) continue
    if (MAY_NAME_TERMS.has(file.split(path.sep).join('/'))) continue
    const text = fs.readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    for (const term of FORBIDDEN) {
      if (lower.includes(term)) {
        offenders.push(`${file}: '${term}'`)
      }
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      const hit = text.match(pattern)
      if (hit) offenders.push(`${file}: matches /${pattern.source}/ ('${hit[0]}')`)
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
