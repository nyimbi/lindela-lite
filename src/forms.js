/**
 * CAP-01 — a form definition is a versioned artifact, not a hard-coded wizard.
 *
 * The CHW wizard's questions lived in `public/chw/app.js` and its five symptom
 * buttons in `public/chw/index.html`. Three things followed, and each is a
 * defect on its own:
 *
 *   - A district could not change a question without a redeploy. The form was
 *     source code, so the person who owns the question and the person who can
 *     merge to `main` had to be the same person.
 *   - A submission carried no statement of what it was filled against. When a
 *     question changed, the records already collected could not be told apart
 *     from the ones collected under the new wording — the same column held
 *     answers to two different questions and nothing said so.
 *   - The web wizard and any mobile client shared no schema. Each had its own
 *     copy of the question set, and the copies drifted.
 *
 * **A form is `{id, version, fields}` and the version is the identity.** Not
 * `{id, fields}` with a version number beside it: two versions of one form are
 * two different questions, so they are two artifacts. A submission names the
 * exact `(form_id, form_version)` it was filled against, which is what makes a
 * record interpretable a year later and what makes two versions in the field
 * reconcilable rather than merely co-existing.
 *
 * **Versions are immutable.** Publishing an edit to a live form writes version
 * `n+1`; version `n` stays readable forever, because submissions name it and a
 * submission that names a version nobody can read is a record nobody can
 * interpret. Editing a published version in place is the same defect as
 * rewriting an applied migration: the artifact keeps its name and changes its
 * meaning, and everything already stamped with that name is silently wrong.
 *
 * ENH-38 moved the field vocabulary, the skip grammar and the answer coercion
 * into `public/shared/forms.js`, which the browser loads and this file
 * re-exports. They were here and the wizard could not reach them, so the wizard
 * hard-coded the questions and filed a version it guessed. What stays here is
 * what only a server does: the built-in definition a fresh deployment serves,
 * and the merge of published versions over it.
 */

import {
  BUILTIN_FORMS, CHW_SYMPTOM_FORM, FIELD_TYPES, INVALID, applicableFields, coerce,
  fieldHook, isRelevant, isVersion, readField, renderField, renderForm,
  validateAnswers, validateFormDefinition,
} from '../public/shared/forms.js'

export {
  BUILTIN_FORMS, CHW_SYMPTOM_FORM, FIELD_TYPES, INVALID, applicableFields, coerce,
  fieldHook, isRelevant, isVersion, readField, renderField, renderForm,
  validateAnswers, validateFormDefinition,
}

/**
 * The forms a deployment serves, newest version of each, plus every published
 * version a submission may name.
 *
 * Built-ins are version 1 of their id. A deployment's published versions are
 * merged over them the same way the taxonomy merges its extension: a published
 * `(id, version)` replaces the built-in with that pair, and a higher version is
 * an addition rather than a replacement, because both stay readable.
 */
export function mergeForms(published = []) {
  const byKey = new Map(BUILTIN_FORMS.map((form) => [`${form.id}@${form.version}`, form]))
  for (const form of Array.isArray(published) ? published : []) {
    if (!form || typeof form !== 'object') continue
    if (validateFormDefinition(form).length) continue
    byKey.set(`${form.id}@${form.version}`, Object.freeze({ ...form, deployment: true }))
  }
  return [...byKey.values()].sort((a, b) => (a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id)))
}

/** The exact `(id, version)` a submission names, or null. */
export function formFor(forms, id, version) {
  return forms.find((form) => form.id === id && form.version === version) || null
}

/** The newest version of a form id, which is what a client renders by default. */
export function latestForm(forms, id) {
  const versions = forms.filter((form) => form.id === id)
  return versions.length ? versions[versions.length - 1] : null
}

/**
 * The catalogue as a client would present it: one entry per id, naming the
 * newest version and listing every version still readable.
 */
export function formCatalogue(forms) {
  const byId = new Map()
  for (const form of forms) {
    if (!byId.has(form.id)) byId.set(form.id, { id: form.id, title: form.title, latest_version: form.version, versions: [] })
    const entry = byId.get(form.id)
    entry.latest_version = Math.max(entry.latest_version, form.version)
    entry.versions.push(form.version)
  }
  return [...byId.values()].map((entry) => ({ ...entry, versions: entry.versions.sort((a, b) => a - b) }))
}
