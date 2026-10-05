/**
 * The native bridge, from the web side.
 *
 * Every method here has to work in a plain browser, because the same code runs
 * in one: the CHW app is served to a phone with no shell installed as often as
 * to one with the shell, and a surface that throws because a native symbol is
 * absent is a surface that breaks on the *first* load for everyone.
 *
 * So this module never assumes a native object exists, never calls a method it
 * has not been told about, and never lets a rejection escape into a click
 * handler. `capabilities()` is the only negotiation: the shell says what it can
 * do, and the web asks before it does.
 *
 * The contract both platforms implement is in
 * `apps/mobile/shared/bridge-contract.md`.
 */

/** The capabilities a plain browser has, which is none of the native ones. */
const NONE = Object.freeze({
  secureStore: false,
  backgroundSync: false,
  camera: false,
  location: false,
  notifications: false,
})

function shell() {
  const candidate = typeof window === 'undefined' ? undefined : window.lindelaNative
  return candidate && typeof candidate === 'object' ? candidate : null
}

/**
 * Resolve the shell's capabilities, defensively.
 *
 * `capabilities()` crosses the bridge, so it can fail on an older shell that
 * does not implement it — which is the normal state for a phone that has not
 * taken an update. Treated as "no native capabilities", because every use below
 * has a browser path anyway.
 */
export function capabilities() {
  const native = shell()
  if (!native || typeof native.capabilities !== 'function') return { ...NONE }
  try {
    const reported = native.capabilities()
    return {
      secureStore: Boolean(reported?.secureStore),
      backgroundSync: Boolean(reported?.backgroundSync),
      camera: Boolean(reported?.camera),
      location: Boolean(reported?.location),
      notifications: Boolean(reported?.notifications),
    }
  } catch {
    return { ...NONE }
  }
}

export function isNative() {
  return shell() !== null
}

export function platform() {
  const native = shell()
  return typeof native?.platform === 'string' ? native.platform : null
}

/** Call a bridge method if it exists, resolving `fallback` when it does not. */
async function call(name, args, fallback) {
  const native = shell()
  if (!native || typeof native[name] !== 'function') return fallback
  try {
    const value = await native[name](...(args || []))
    return value === undefined ? fallback : value
  } catch (error) {
    // Swallowed on purpose and reported: a bridge that throws must not take the
    // surface down with it, and the caller still needs to know it got nothing.
    if (typeof console !== 'undefined') {
      console.warn(`native bridge: ${name} failed`, error)
    }
    return fallback
  }
}

/* --------------------------------------------------------------- secure store */

/**
 * The API key, from the Keychain or the Keystore when there is one.
 *
 * This is the single most valuable thing the shell adds: the key currently
 * lives in `localStorage`, readable by any script that reaches the origin. A
 * device that is stolen is a device that is publishing someone else's data.
 *
 * Resolves `null` in a browser, and the caller falls back to localStorage rather
 * than losing the session.
 */
export async function readSecret(key) {
  return call('secureGet', [key], null)
}

export async function writeSecret(key, value) {
  const written = await call('secureSet', [key, value], false)
  return written === true
}

export async function forgetSecret(key) {
  return (await call('secureRemove', [key], false)) === true
}

/* ----------------------------------------------------------- background sync */

/**
 * Ask the OS to drain the queue when it decides the network is back.
 *
 * `Background Sync` in a browser is Chrome-only and best-effort; a shell can ask
 * the platform scheduler, which is what actually runs the job when the app has
 * not been opened for a week. Returns whether the request was *accepted*, not
 * whether the drain happened: the OS may decline, and the caller keeps the
 * in-page `online` listener and the 30-second poll either way.
 */
export async function requestBackgroundSync(tag = 'lindela-queue') {
  if (!capabilities().backgroundSync) return false
  return (await call('backgroundSyncRegister', [tag], false)) === true
}

/**
 * Drain now, through the OS, and report what it sent.
 *
 * Used by the shell's own scheduled job, and by the app's own "send now" action
 * so that a person does not have to wait for a scheduler to decide.
 */
export async function flushViaNative(tag = 'lindela-queue') {
  return call('backgroundSyncFlush', [tag], { sent: 0, failed: 0 })
}

/* -------------------------------------------------------------- camera, place */

export async function capturePhoto() {
  if (!capabilities().camera) return null
  return call('cameraCapture', [], null)
}

/**
 * One position fix.
 *
 * `null` when the person declines, and never a fabricated `0,0` — that pair is
 * Null Island in the Gulf of Guinea, and a symptom report pointing at open water
 * reads as a disease signal that is not there. The browser's own
 * `location_source: "not_answered"` is the honest answer when this is absent.
 */
export async function currentPosition() {
  if (!capabilities().location) return null
  const fix = await call('locationOnce', [], null)
  if (!fix) return null
  const latitude = Number(fix.latitude)
  const longitude = Number(fix.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude, accuracy: Number(fix.accuracy) || null }
}

/* ------------------------------------------------------------- notifications */

export async function askForNotifications() {
  if (!capabilities().notifications) return 'denied'
  return (await call('notificationsRequest', [], 'denied')) || 'denied'
}

export async function registerForPush(deviceToken) {
  if (!capabilities().notifications || !deviceToken) return false
  return (await call('notificationsRegister', [deviceToken], false)) === true
}

/**
 * Ask the OS to wake the app when a queued report is ready to go.
 *
 * Also registers background sync in the same call, because the two are the same
 * request from the product's point of view: "get this report there without me
 * opening the app".
 */
export async function prepareForBackgroundDelivery() {
  const sync = await requestBackgroundSync()
  return { backgroundSync: sync, capabilities: capabilities() }
}
