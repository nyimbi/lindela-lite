import { apiFetch } from '/shared/runtime.js'

/**
 * Fill the build version into every `[data-app-version]` element.
 *
 * The version is a build fact, not a translatable string, so it does not belong
 * in the locale files — and when it was there it drifted, staying on an older
 * release while the package moved on. A panel asking "which build is this?"
 * would have been told the wrong one.
 *
 * The value comes from the health endpoint, which reads it from package.json.
 * The markup keeps a static fallback so the version still shows for a field user
 * who is offline and has never loaded this bundle.
 *
 * The `cache: 'no-store'` this call used to pass is not forwarded: `apiFetch`
 * destructures a fixed option list and drops anything else, so the request
 * inherits whatever caching the browser chooses. That is fine for a version
 * number — a cached one is stale by at most one deploy — but it is worth
 * recording, because the first version of this module needed the header for a
 * different reason and a reader will assume it is still load-bearing.
 */
export async function fillAppVersion() {
  const nodes = document.querySelectorAll('[data-app-version]')
  if (!nodes.length) return null
  let version = null
  try {
    // `apiFetch` rather than a bare `fetch`. This call already checked `res.ok`
    // — the shape guard below is load-bearing and worth keeping — but it had no
    // timeout, which is the half that mattered on the link this product runs
    // on: a health endpoint that hangs never settles, and `fillAppVersion` is
    // awaited during boot on several surfaces, so a hung request stalls the
    // page rather than merely missing a version number.
    const body = await apiFetch('/api/v1/health')
    // Only accept something shaped like a version. A malformed payload must
    // not replace the fallback with something worse than a stale number.
    if (typeof body?.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) {
      version = body.version
    }
  } catch {
    // Offline or unreachable: keep the fallback. This is a build fact, not a
    // live reading — a stale version is a worse answer than none only if it is
    // wrong, and the markup's fallback is right for the build that shipped it.
  }
  if (version) {
    for (const n of nodes) n.textContent = `v${version}`
  }
  return version
}
