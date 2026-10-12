/**
 * ENH-60 — the taxonomy-and-forms family, out of the dispatcher.
 *
 * Four routes over the vocabulary a client renders and the form definitions it
 * validates against. They are one family because they are the *configuration*
 * surface: everything else in the platform reads these, and the rules that keep
 * them trustworthy are the same rule three times.
 *
 *   - **A version is immutable once published.** `POST /forms` answers `409` for
 *     a version that exists, rather than overwriting it. Submissions name a
 *     version, so editing one in place leaves every record stamped with it
 *     silently wrong — the same defect as rewriting an applied migration.
 *   - **A built-in is not replaceable by a deployment.** A published `(id,
 *     version)` may replace a built-in *only* by publishing a higher version; the
 *     built-in row is refused by name, so the catalogue's own entries cannot be
 *     shadowed in place.
 *   - **A version the deployment does not hold is a `404` naming what it does
 *     hold**, not a fallback to the newest. Answering a request for version 3
 *     with version 4's fields is how two versions in the field stop being
 *     reconcilable.
 *
 * The taxonomy is the same merge with a different failure mode: a malformed
 * extension is reported in `problems` rather than thrown, so a bad config is
 * visible instead of stopping the process.
 *
 * `activeForms` lives here rather than in `server.js` because it is this
 * family's read and nothing else in the dispatcher calls it. `src/routes/chw.js`
 * carries its own copy, which is a duplication this move records rather than
 * fixes — deduplicating it would touch the CHW family in the same commit, and a
 * move that also refactors is a move nobody can review.
 */

import { formCatalogue, formFor, latestForm, mergeForms, validateFormDefinition } from '../forms.js'
import { taxonomyDocument } from '../taxonomy.js'
import { actionLog } from '../operations.js'
import { readRequestJson } from '../utils.js'

/**
 * CAP-01. Every form version this deployment can serve: the built-ins merged
 * with whatever has been published to the store.
 *
 * A function of `data` rather than a module-level cache, because a published
 * version must be servable on the next request rather than after a restart —
 * and because two replicas reading one store must agree, which a per-process
 * cache would only do until one of them published.
 */
export function activeForms(data) {
  return mergeForms(data?.form_definitions || [])
}

/**
 * Which taxonomy-or-forms route a request is, or null.
 *
 * Method-aware: three reads and one publish. The detail route is matched rather
 * than compared because the id is a path segment, and the pattern is anchored at
 * both ends so `/forms/a/b` does not resolve to the form `a`. `check-openapi.mjs`
 * reads this body, so the paths are discoverable without a second list.
 */
export function matchFormsRoute(pathname, method = 'GET') {
  if (method === 'GET') {
    if (pathname === '/api/v1/taxonomy') return { kind: 'taxonomy' }
    if (pathname === '/api/v1/forms') return { kind: 'forms-catalogue' }
    const detail = pathname.match(/^\/api\/v1\/forms\/([^/]+)$/)
    if (detail) return { kind: 'form', id: decodeURIComponent(detail[1]) }
    return null
  }
  if (method === 'POST') {
    if (pathname === '/api/v1/forms') return { kind: 'forms-publish' }
    return null
  }
  return null
}

/**
 * Handle one taxonomy-or-forms route. Returns true when it handled the request.
 */
export async function handleFormsRoute(route, { store, data, req, res, url, jsonResponse }) {
  const { kind } = route

  if (kind === 'taxonomy') {
    // CAP-05. The vocabulary a client renders and a validator enforces, from one
    // source. A partner adds a category through `LINDELA_LITE_TAXONOMY` or
    // `data/taxonomy.json` and it appears here without a code change; a
    // malformed extension is reported in `problems` rather than thrown.
    jsonResponse(res, 200, { success: true, data: taxonomyDocument() })
    return true
  }

  if (kind === 'forms-catalogue') {
    // CAP-01. One entry per form id, naming the newest version and every version
    // still readable. Built-ins come from `src/forms.js` and a deployment's
    // published versions from the store, merged the same way the taxonomy merges
    // its extension — a published `(id, version)` replaces the built-in with that
    // pair, and a higher version is an addition.
    jsonResponse(res, 200, {
      success: true,
      data: { forms: formCatalogue(activeForms(data)), published: (data.form_definitions || []).length },
    })
    return true
  }

  if (kind === 'form') {
    const requested = url.searchParams.get('version')
    const forms = activeForms(data)
    const form = requested === null
      ? latestForm(forms, route.id)
      : formFor(forms, route.id, Number(requested))
    if (!form) {
      const known = forms.filter((f) => f.id === route.id).map((f) => f.version)
      jsonResponse(res, 404, {
        success: false,
        error: known.length
          ? `${route.id} has no version ${requested}; this deployment holds ${known.join(', ')}`
          : `no form with id ${route.id}`,
      })
      return true
    }
    jsonResponse(res, 200, { success: true, data: form })
    return true
  }

  if (kind === 'forms-publish') {
    // Publishing is a write through the API, which is the whole point of the row:
    // the person who owns the question does not have to be the person who can
    // merge to main.
    const body = await readRequestJson(req)
    const definition = body.form || body
    const problems = validateFormDefinition(definition)
    if (problems.length) {
      jsonResponse(res, 400, { success: false, error: problems.join('; '), problems })
      return true
    }
    const forms = activeForms(data)
    const existing = formFor(forms, definition.id, definition.version)
    // Publishing a version that already exists is a 409, not an overwrite.
    // Versions are immutable: submissions name them, so editing a published
    // version in place leaves every record stamped with it silently wrong — the
    // same defect as rewriting an applied migration.
    if (existing && existing.deployment !== true) {
      jsonResponse(res, 409, {
        success: false,
        error: `${definition.id} v${definition.version} is a built-in and cannot be replaced; publish v${definition.version + 1}`,
      })
      return true
    }
    if (existing) {
      jsonResponse(res, 409, {
        success: false,
        error: `${definition.id} v${definition.version} is already published and a published version is immutable; publish v${definition.version + 1}`,
      })
      return true
    }
    const stored = {
      ...definition,
      fields: definition.fields.map((field) => ({ ...field })),
      published_at: new Date().toISOString(),
      published_by: req.__auth?.subject || null,
    }
    const log = actionLog('form_definitions', 'published', stored, 'api', req.__auth?.subject)
    await store.merge({ form_definitions: [stored], action_logs: [log] })
    jsonResponse(res, 201, { success: true, data: stored })
    return true
  }

  return false
}
