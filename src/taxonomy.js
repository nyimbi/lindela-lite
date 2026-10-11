/**
 * CAP-05 — the impact/needs taxonomy, as a registry rather than a free string.
 *
 * `field_reports.category` and `community_feedback` were flat records with a
 * `category` string and no vocabulary behind it. Nothing validated the value,
 * nothing listed the options, and the CHW form's five choices lived only in
 * `public/chw/index.html` — so a partner could not add a question to a field
 * report without a code change, and the export carried whatever string a
 * reporter's client happened to send.
 *
 * **The registry is three things.**
 *
 *   1. A **closed vocabulary** for the built-in categories, each with a stable
 *      code, a label, and the group it belongs to. A category is a code now, not
 *      free text, so two spellings of the same thing cannot both exist.
 *   2. A **deployment extension point**. `LINDELA_LITE_TAXONOMY` (env, JSON) or
 *      `data/taxonomy.json` adds categories to a deployment without a code
 *      change. That is the property the defect named as missing.
 *   3. **Aliases**, so the values already in stores and already sent by clients
 *      keep resolving — `diarrhea` and `diarrhoea`, `fever` and `fever_illness`.
 *      A vocabulary that refuses the data it already holds is a migration, not a
 *      taxonomy.
 *
 * **What it refuses.** A category that is not in the vocabulary and has no alias
 * is not silently accepted as a new one: `resolveCategory` returns null with the
 * reason, and `assertCategory` throws. Free text in a categorical field is how a
 * taxonomy rots — the field looks enumerated and is not.
 */

/**
 * The built-in categories, grouped.
 *
 * `group` is what a report counts by when the specific category is too fine: a
 * health coordinator wants the disease count, not the fever/cough/diarrhoea
 * split, and a group is a stable thing to aggregate over in a way a code is not.
 */
export const CATEGORY_GROUPS = Object.freeze({
  hazard: 'A physical hazard event',
  health: 'A human health signal',
  needs: 'A stated need, rather than an observation',
  other: 'Recorded, and not classified',
})

export const BUILTIN_CATEGORIES = Object.freeze([
  // Hazard — the CHW incident form's own five, kept as codes.
  Object.freeze({ code: 'flood', label: 'Flood', group: 'hazard' }),
  Object.freeze({ code: 'drought', label: 'Drought', group: 'hazard' }),
  Object.freeze({ code: 'disease', label: 'Disease outbreak', group: 'hazard' }),
  Object.freeze({ code: 'conflict', label: 'Conflict', group: 'hazard' }),
  // Health — the symptom-level signals the seed and the CHW wizard both write.
  Object.freeze({ code: 'fever', label: 'Fever', group: 'health' }),
  Object.freeze({ code: 'cough', label: 'Cough', group: 'health' }),
  Object.freeze({ code: 'diarrhoea', label: 'Diarrhoea', group: 'health' }),
  Object.freeze({ code: 'cholera', label: 'Suspected cholera', group: 'health' }),
  Object.freeze({ code: 'malaria', label: 'Suspected malaria', group: 'health' }),
  Object.freeze({ code: 'measles', label: 'Suspected measles', group: 'health' }),
  // `rash` is what the CHW symptom wizard posts (`data-symptom-type`), and the
  // wizard is the highest-volume writer of this field. A vocabulary that omits
  // the client's own fifth button is a vocabulary the client cannot use.
  Object.freeze({ code: 'rash', label: 'Rash', group: 'health' }),
  Object.freeze({ code: 'malnutrition', label: 'Malnutrition', group: 'health' }),
  // Needs.
  Object.freeze({ code: 'water', label: 'Water', group: 'needs' }),
  Object.freeze({ code: 'shelter', label: 'Shelter', group: 'needs' }),
  Object.freeze({ code: 'food', label: 'Food', group: 'needs' }),
  Object.freeze({ code: 'healthcare', label: 'Healthcare access', group: 'needs' }),
  Object.freeze({ code: 'sanitation', label: 'Sanitation', group: 'needs' }),
  // Other.
  Object.freeze({ code: 'other', label: 'Other', group: 'other' }),
])

/**
 * Spellings the data already uses that are not the canonical code.
 *
 * `diarrhea` is the American spelling and appears in the demo seed; `diarrhoea`
 * is the code. Both must resolve, or the taxonomy refuses the store's own
 * records. Aliases map to a code, and a deployment's own alias table merges over
 * these rather than replacing them.
 */
export const CATEGORY_ALIASES = Object.freeze({
  diarrhea: 'diarrhoea',
  fever_illness: 'fever',
  feverish: 'fever',
  outbreak: 'disease',
  violence: 'conflict',
  hunger: 'food',
  wash: 'water',
  latrine: 'sanitation',
})

/** A code must be a slug: lowercase, digits, underscores. */
const CODE_SHAPE = /^[a-z][a-z0-9_]*$/

/**
 * Merge a deployment's extension over the built-ins.
 *
 * Exported so the merge is testable without the environment. A deployment
 * category whose code collides with a built-in **replaces** it, which is how a
 * deployment relabels "Flood" without forking the list; a category with no group
 * inherits `other` rather than failing, because a partner adding a category
 * should not have to know the group vocabulary to do it.
 */
export function mergeCategories(extra = []) {
  const byCode = new Map(BUILTIN_CATEGORIES.map((c) => [c.code, c]))
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (!entry || typeof entry.code !== 'string') continue
    const code = entry.code.trim().toLowerCase()
    if (!CODE_SHAPE.test(code)) continue
    byCode.set(code, Object.freeze({
      code,
      label: typeof entry.label === 'string' && entry.label ? entry.label : code,
      group: typeof entry.group === 'string' && entry.group in CATEGORY_GROUPS ? entry.group : 'other',
      // Marked so a caller can tell a deployment's addition from a built-in —
      // the export names which vocabulary produced a record's category.
      deployment: true,
    }))
  }
  return [...byCode.values()]
}

/**
 * The active taxonomy: built-ins plus this deployment's extension.
 *
 * Loaded once. `LINDELA_LITE_TAXONOMY` is JSON in the environment;
 * `data/taxonomy.json` is the file form. A malformed extension is **ignored
 * with a reason** rather than throwing at import: a bad config must not stop the
 * process from serving, and the refusal is surfaced on the taxonomy route so it
 * is visible rather than swallowed.
 */
let cached = null

export function loadTaxonomySync({ env = process.env, readFile = null } = {}) {
  const problems = []
  let extra = []
  const raw = env.LINDELA_LITE_TAXONOMY
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      extra = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.categories) ? parsed.categories : [])
      if (!extra.length && parsed && !Array.isArray(parsed)) {
        problems.push('LINDELA_LITE_TAXONOMY parsed but carried no `categories` array; the extension was ignored')
      }
    } catch (error) {
      problems.push(`LINDELA_LITE_TAXONOMY is not valid JSON (${error.message}); the extension was ignored`)
    }
  }
  const categories = mergeCategories(extra)
  return {
    categories,
    aliases: CATEGORY_ALIASES,
    deployment_count: categories.filter((c) => c.deployment).length,
    problems,
  }
}

/** The cached taxonomy, loaded on first use. */
export function taxonomy() {
  if (!cached) cached = loadTaxonomySync()
  return cached
}

/** Reset the cache — for a test that changes the environment. */
export function resetTaxonomy() {
  cached = null
}

/**
 * Resolve a value to a category code, or null.
 *
 * Resolution order: an exact code, then an alias, then a case- and
 * whitespace-insensitive match on a code or label. `null` and `''` resolve to
 * `null` without a problem, because "no category" is a legitimate state — a
 * report that has not been classified is not a report with an invalid one.
 */
export function resolveCategory(value, { taxonomy: tax = taxonomy() } = {}) {
  if (value === null || value === undefined || value === '') return null
  const key = String(value).trim().toLowerCase()
  if (!key) return null
  const codes = new Set(tax.categories.map((c) => c.code))
  if (codes.has(key)) return key
  const alias = tax.aliases[key]
  if (alias && codes.has(alias)) return alias
  const byLabel = tax.categories.find((c) => c.label.toLowerCase() === key)
  return byLabel ? byLabel.code : null
}

/**
 * The category, or a throw naming the vocabulary.
 *
 * A 400, because the value is client-supplied and the fix is at the client. The
 * message lists the valid codes: a validation error that does not say what would
 * have been accepted makes the caller guess, and guessing is what produced free
 * text in the field to begin with.
 */
export function assertCategory(value, { taxonomy: tax = taxonomy() } = {}) {
  if (value === null || value === undefined || value === '') return null
  const resolved = resolveCategory(value, { taxonomy: tax })
  if (resolved) return resolved
  throw Object.assign(
    new Error(`category must be one of ${tax.categories.map((c) => c.code).join(', ')}; received ${JSON.stringify(value)}`),
    { statusCode: 400 },
  )
}

/** The categories in one group, for a form that renders a section at a time. */
export function categoriesInGroup(group, { taxonomy: tax = taxonomy() } = {}) {
  return tax.categories.filter((c) => c.group === group)
}

/**
 * The vocabulary as a form or an export would present it.
 *
 * `aliases` is included so a client can accept the spellings the deployment
 * already holds rather than only the codes — the same reason the resolver has
 * them.
 */
export function taxonomyDocument({ taxonomy: tax = taxonomy() } = {}) {
  return {
    categories: tax.categories,
    groups: CATEGORY_GROUPS,
    aliases: tax.aliases,
    deployment_count: tax.deployment_count,
    problems: tax.problems,
  }
}
