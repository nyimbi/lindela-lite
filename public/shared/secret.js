/**
 * Where the API key lives.
 *
 * Today: `localStorage`, on every surface. That is the weakest link in the
 * product — any script that reaches the origin can read it, there is no browser
 * API that changes that, and a handset left in a vehicle publishes somebody
 * else's district for as long as the token is valid.
 *
 * With a native shell there is a better place: the iOS Keychain and the Android
 * Keystore. This module is the one place that knows, so the three surfaces that
 * read a key do not each grow their own migration.
 *
 * Three properties, and each one was a way to get this wrong:
 *
 * 1. **A migration is not a copy.** Reading the key out of the Keychain while a
 *    stale copy sits in `localStorage` means the surface *says* it is secure and
 *    a script says otherwise. So the localStorage copy is removed once the secure
 *    write has succeeded — and kept when it has not.
 * 2. **A refused keystore is not a lost key.** Android throws when the
 *    Keystore has been invalidated (a restored backup, a changed screen lock).
 *    That falls back to `localStorage` and reports `secure: false`, so the
 *    surface can say the key is not in secure hardware rather than implying it.
 * 3. **No shell means today's behaviour, unchanged.** Every method resolves;
 *    a browser gets `localStorage` and nothing else.
 */

import { capabilities, readSecret, writeSecret, forgetSecret, isNative } from './native.js'

export const API_KEY_NAME = 'lindela_lite_api_key'

/**
 * What the last read or write established about where the key is.
 *
 * `secure: true` is a claim about this device's hardware-backed storage and is
 * only ever true after a write the platform confirmed. A surface that shows it
 * is making a checkable promise.
 */
export const keyStorage = {
  secure: false,
  shell: false,
  known: false,
}

function localRead() {
  try {
    return globalThis.localStorage?.getItem(API_KEY_NAME) || null
  } catch {
    // Private mode, or a storage policy that refuses reads. Not a crash: the
    // surface can ask for the key again.
    return null
  }
}

function localWrite(value) {
  try {
    if (value) globalThis.localStorage?.setItem(API_KEY_NAME, value)
    else globalThis.localStorage?.removeItem(API_KEY_NAME)
    return true
  } catch {
    return false
  }
}

/**
 * The key, from the best place available.
 *
 * Synchronous, because every caller wants it inside a request header and an
 * `await` there would change the timing of every authenticated call. So the
 * *migration* is asynchronous and happens in the background; what is synchronous
 * is the answer.
 */
/**
 * Resolved from the vault, once one has answered.
 *
 * `null` means "not hydrated yet", which is different from `''` ("there is no
 * key") — the first is a question not yet asked and the second is an answer,
 * and collapsing them would let a surface read null and conclude the person has
 * no key when in fact the vault holds one.
 */
let hydrated = null

export function readApiKey() {
  keyStorage.shell = isNative()
  if (hydrated !== null) return hydrated || localRead()
  keyStorage.known = false

  const local = localRead()
  if (!keyStorage.shell) {
    keyStorage.known = Boolean(local)
    return local
  }
  // The secure copy is not synchronously reachable on either platform, so the
  // synchronous answer is whatever is in front of us, and the background pass
  // upgrades it. `hydrateFromSecureStore` is what the surfaces call at boot.
  keyStorage.known = Boolean(local)
  return local
}

/**
 * The asynchronous half: move the key into secure hardware, or read it back.
 *
 * Called once per surface at boot. Safe to call repeatedly, and cheap to skip:
 * the migration runs once and the result is cached in `keyStorage`.
 */
export async function hydrateFromSecureStore() {
  if (!isNative() || !capabilities().secureStore) {
    keyStorage.secure = false
    const local = readApiKey()
    hydrated = local || null
    return local
  }
  let stored = null
  try {
    stored = await readSecret(API_KEY_NAME)
  } catch {
    stored = null
  }

  if (stored) {
    // The secure copy wins, and the localStorage copy goes: leaving it would
    // mean the surface claims hardware storage while a script on the origin can
    // still read the key.
    keyStorage.secure = true
    keyStorage.known = true
    hydrated = stored
    if (localRead()) localWrite(null)
    return stored
  }

  const local = localRead()
  if (!local) {
    keyStorage.known = false
    return null
  }
  // `secure`, not truthy: `writeApiKey` returns `{stored: true, secure: false}`
  // when the keystore refused and it fell back to localStorage — and clearing on
  // *that* deletes the only copy the key has. The failure mode is silent, total,
  // and it takes a district's access to its own data with it.
  const where = await writeApiKey(local)
  hydrated = local
  if (where.secure) {
    keyStorage.secure = true
    keyStorage.known = true
    localWrite(null)
    return local
  }
  // The keystore refused. Keep the key where it is and say so — a key that has
  // been lost because the hardware said no is worse than one that is readable.
  keyStorage.secure = false
  keyStorage.known = true
  return local
}

/** Store a key in the best place available. Returns where it went. */
export async function writeApiKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (isNative() && capabilities().secureStore) {
    const written = await writeSecret(API_KEY_NAME, trimmed)
    hydrated = trimmed || null
    if (written) {
      keyStorage.secure = true
      keyStorage.shell = true
      keyStorage.known = true
      // Same reasoning as the migration: two copies is not more secure, it is
      // less honest.
      if (trimmed) localWrite(null)
      return { stored: true, secure: true }
    }
  }
  localWrite(trimmed)
  hydrated = trimmed || null
  keyStorage.secure = false
  keyStorage.shell = isNative()
  keyStorage.known = true
  return { stored: Boolean(trimmed), secure: false }
}

/** Forget the key, everywhere it might be. */
export async function clearApiKey() {
  hydrated = ''
  localWrite(null)
  keyStorage.secure = false
  keyStorage.known = false
  if (isNative() && capabilities().secureStore) {
    await forgetSecret(API_KEY_NAME).catch(() => {})
  }
  return true
}

/**
 * Fill a settings field and keep it in step with the key.
 *
 * Shared because the three surfaces each had their own copy, and the copies are
 * where a "did we forget to save on sign-out?" bug would live — two of them
 * already removed the key on sign-out and the third did not.
 */
export function bindApiKeyField(input, { onStored = null } = {}) {
  if (!input) return null
  if (!input.value) input.value = readApiKey() || ''
  if (input.dataset.lindelaBound === '1') return input
  input.addEventListener('input', () => {
    // Every keystroke persists, as it did before — a person who types a key and
    // closes the app must not find it gone. `writeApiKey` chooses the store and
    // reports which, so a surface can say "that key is in secure hardware" or
    // "this device would not hold it".
    writeApiKey(input.value.trim()).then((where) => onStored?.(where))
  })
  input.dataset.lindelaBound = '1'
  return input
}
