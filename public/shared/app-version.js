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
 */
export async function fillAppVersion() {
  const nodes = document.querySelectorAll('[data-app-version]')
  if (!nodes.length) return null
  let version = null
  try {
    const res = await fetch('/api/v1/health', { cache: 'no-store' })
    if (res.ok) {
      const body = await res.json()
      // Only accept something shaped like a version. A malformed payload must
      // not replace the fallback with something worse than a stale number.
      if (typeof body?.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) {
        version = body.version
      }
    }
  } catch {
    // Offline or unreachable: keep the fallback.
  }
  if (version) {
    for (const n of nodes) n.textContent = `v${version}`
  }
  return version
}
