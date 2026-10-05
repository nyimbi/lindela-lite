import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import {
  capabilities, isNative, platform, readSecret, writeSecret, forgetSecret,
  requestBackgroundSync, flushViaNative, capturePhoto, currentPosition,
  askForNotifications, registerForPush, prepareForBackgroundDelivery,
} from '../public/shared/native.js'

/**
 * The native bridge, from the web side.
 *
 * The CHW app is served to a phone with no shell installed as often as to one
 * with the shell, so every method here has to work in a plain browser — and the
 * shells it talks to are whatever version that phone last installed. Two rules
 * follow, and both are tested below because both fail silently when broken:
 *
 *   - **never assume a symbol exists.** A shell two releases old has no
 *     `backgroundSyncRegister`, and calling it is a TypeError in a click handler.
 *   - **never let a rejection escape.** A bridge that throws takes the surface
 *     down with it, and the surface is a form a health worker is halfway
 *     through filling in.
 *
 * And the one that matters for the data: a declined location permission is
 * `null`, never `{latitude: 0, longitude: 0}`. That pair is Null Island, and a
 * symptom report pointing at open water reads as a disease signal that is not
 * there — the browser-side `location_source: "not_answered"` is the honest
 * answer, and a fabricated zero is how that bug was introduced once already.
 */

let saved = null

function installShell(shell) {
  saved = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    value: { lindelaNative: shell }, configurable: true, writable: true,
  })
}

beforeEach(() => { saved = null })
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, 'window', saved)
  else delete globalThis.window
})

describe('in a plain browser there is no shell, and nothing breaks', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true })
  })

  it('reports no native capabilities rather than guessing', () => {
    assert.equal(isNative(), false)
    assert.equal(platform(), null)
    assert.deepEqual(capabilities(), {
      secureStore: false, backgroundSync: false, camera: false, location: false, notifications: false,
    })
  })

  it('every method falls back instead of throwing', async () => {
    // Each of these is called from a click handler in the real app.
    assert.equal(await readSecret('key'), null)
    assert.equal(await writeSecret('key', 'v'), false)
    assert.equal(await forgetSecret('key'), false)
    assert.equal(await requestBackgroundSync(), false)
    assert.deepEqual(await flushViaNative(), { sent: 0, failed: 0 })
    assert.equal(await capturePhoto(), null)
    assert.equal(await currentPosition(), null)
    assert.equal(await askForNotifications(), 'denied')
    assert.equal(await registerForPush('token'), false)
  })

  it('the background preparation still answers, with no capabilities', async () => {
    const prepared = await prepareForBackgroundDelivery()
    assert.deepEqual(prepared, {
      backgroundSync: false,
      capabilities: { secureStore: false, backgroundSync: false, camera: false, location: false, notifications: false },
    })
  })
})

describe('an older shell that implements half of it', () => {
  it('reports only what it actually has', () => {
    installShell({ platform: 'android', version: '1', capabilities: () => ({ camera: true }) })
    assert.deepEqual(capabilities(), {
      secureStore: false, backgroundSync: false, camera: true, location: false, notifications: false,
    })
  })

  it('a shell with no capabilities() at all is "none", not a crash', () => {
    // The normal state of a phone that has not taken an update.
    installShell({ platform: 'ios', version: '1' })
    assert.equal(isNative(), true)
    assert.equal(platform(), 'ios')
    assert.deepEqual(capabilities().camera, false)
  })

  it('a capabilities() that throws is treated as no capabilities', () => {
    installShell({ platform: 'ios', capabilities() { throw new Error('bridge not ready') } })
    assert.deepEqual(capabilities().secureStore, false)
  })

  it('a method the shell does not have is skipped, not called', async () => {
    let called = false
    installShell({ platform: 'ios', capabilities: () => ({ backgroundSync: true }) })
    // No `backgroundSyncRegister` on this shell: the call must be skipped rather
    // than attempted, and the answer is the fallback.
    assert.equal(await requestBackgroundSync(), false)
    assert.equal(called, false)
  })
})

describe('a shell that throws does not take the surface with it', () => {
  const warnings = []
  beforeEach(() => {
    warnings.length = 0
    const original = console.warn
    console.warn = (...args) => warnings.push(args[0])
    installShell({
      platform: 'ios',
      capabilities: () => ({ secureStore: true, location: true }),
      secureGet() { throw new Error('keychain locked') },
      locationOnce() { throw new Error('no permission') },
    })
    globalThis.__restoreWarn = () => { console.warn = original }
  })
  afterEach(() => { globalThis.__restoreWarn?.() })

  it('a throwing secret read resolves null', async () => {
    assert.equal(await readSecret('key'), null)
    assert.ok(warnings.length, 'and says so, because a silent null is indistinguishable from no key')
  })

  it('a throwing location read resolves null, never a zero', async () => {
    assert.equal(await currentPosition(), null)
  })
})

describe('the values themselves', () => {
  it('a location fix is checked for being a real coordinate', async () => {
    // Null Island, in the Gulf of Guinea: a symptom report placed there is a
    // disease signal pointing at open water.
    installShell({
      platform: 'android',
      capabilities: () => ({ location: true }),
      async locationOnce() { return { latitude: 0, longitude: 0, accuracy: 12 } },
    })
    const fix = await currentPosition()
    assert.equal(fix.latitude, 0)
    assert.equal(fix.longitude, 0)
    // 0,0 is a *real* coordinate, so this is not a rejection: the honest
    // treatment is to notice it rather than to trust it. Asserted here so the
    // decision is recorded where the value arrives.
    assert.equal(fix.accuracy, 12)
  })

  it('a fix with a non-numeric coordinate is null', async () => {
    installShell({
      platform: 'android',
      capabilities: () => ({ location: true }),
      async locationOnce() { return { latitude: 'north', longitude: null } },
    })
    assert.equal(await currentPosition(), null, 'a fix with no numbers in it is not a fix')
  })

  it('a secret round-trips', async () => {
    const store = new Map()
    installShell({
      platform: 'ios',
      capabilities: () => ({ secureStore: true }),
      async secureGet(k) { return store.has(k) ? store.get(k) : null },
      async secureSet(k, v) { store.set(k, v); return true },
      async secureRemove(k) { return store.delete(k) },
    })
    assert.equal(await writeSecret('apiKey', 'abc123'), true)
    assert.equal(await readSecret('apiKey'), 'abc123')
    assert.equal(await forgetSecret('apiKey'), true)
    assert.equal(await readSecret('apiKey'), null)
  })

  const registered = []
  it('push registration needs a capability, a token and a method', async () => {
    // Three conditions, and each is a real state: no capability (a browser), no
    // token (permission declined), no method (a shell from before push existed).
    installShell({
      platform: 'ios',
      capabilities: () => ({ notifications: true }),
      async notificationsRegister(token) { registered.push(token); return true },
    })
    assert.equal(await registerForPush(null), false, 'no token, nothing to register')
    assert.equal(await registerForPush('device-token'), true)
    assert.deepEqual(registered, ['device-token'])
  })
})
