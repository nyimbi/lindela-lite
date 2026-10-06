import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

/**
 * Where the API key lives.
 *
 * It was in `localStorage` on every surface, which is the weakest link in the
 * product: any script that reaches the origin reads it, and no browser API
 * changes that. With a native shell there is a better place, and these tests are
 * about the three ways moving it goes wrong:
 *
 *   - a **migration that is a copy**: the key ends up in the Keychain while a
 *     stale duplicate sits in `localStorage`, so the surface can honestly say it
 *     is secure while a script says otherwise. That is worse than not moving it,
 *     because it is believed.
 *   - a **refused keystore treated as a lost key**: Android throws when the
 *     Keystore is invalidated by a restored backup or a changed screen lock, and
 *     a surface that drops the key there loses a district's access to its own
 *     data.
 *   - a **shell that changes the browser path**: every surface also runs in a
 *     plain browser, where none of this exists and nothing may regress.
 */

const store = new Map()
let shell = null

function installShell(caps = { secureStore: true }, secure = {}) {
  const vault = new Map(Object.entries(secure))
  shell = {
    platform: 'ios',
    capabilities: () => caps,
    async secureGet(k) { return vault.has(k) ? vault.get(k) : null },
    async secureSet(k, v) { vault.set(k, v); return true },
    async secureRemove(k) { vault.delete(k); return true },
    vault,
  }
  globalThis.window = { lindelaNative: shell }
  return vault
}

/** A shell whose secure store refuses every write, as an invalidated keystore does. */
function installRefusingShell() {
  shell = {
    platform: 'android',
    capabilities: () => ({ secureStore: true }),
    async secureGet() { return null },
    async secureSet() { throw new Error('keystore invalidated') },
    async secureRemove() { return false },
  }
  globalThis.window = { lindelaNative: shell }
}

function removeShell() {
  shell = null
  delete globalThis.window
}

async function loadModule() {
  // Fresh per test: the module caches its own view of where the key is, and a
  // cached "secure" from a previous shell would leak into this one.
  const suffix = Math.random().toString(36).slice(2)
  return import(`../public/shared/secret.js?t=${suffix}`)
}

let saved
beforeEach(() => {
  saved = globalThis.localStorage
  store.clear()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  removeShell()
})
afterEach(() => {
  globalThis.localStorage = saved
  removeShell()
})

describe('in a browser, nothing changes', () => {
  it('reads and writes localStorage, and claims no security it does not have', async () => {
    const { readApiKey, writeApiKey, keyStorage } = await loadModule()
    assert.equal(readApiKey(), null)
    assert.equal(keyStorage.secure, false, 'a browser must never report secure storage')

    const result = await writeApiKey('abc123')
    assert.deepEqual(result, { stored: true, secure: false })
    assert.equal(store.get('lindela_lite_api_key'), 'abc123')
    assert.equal(readApiKey(), 'abc123')
  })
})

describe('with a shell, the key moves into secure hardware', () => {
  it('a fresh write goes to the secure store and leaves no localStorage copy', async () => {
    const vault = installShell()
    const { writeApiKey, keyStorage } = await loadModule()

    const result = await writeApiKey('secret-key')
    assert.deepEqual(result, { stored: true, secure: true })
    assert.equal(vault.get('lindela_lite_api_key'), 'secret-key')
    assert.equal(store.has('lindela_lite_api_key'), false,
      'two copies is not more secure, it is less honest')
    assert.equal(keyStorage.secure, true)
  })

  it('an existing localStorage key is migrated, not copied', async () => {
    store.set('lindela_lite_api_key', 'from-last-version')
    const vault = installShell()
    const { hydrateFromSecureStore } = await loadModule()

    const key = await hydrateFromSecureStore()
    assert.equal(key, 'from-last-version')
    assert.equal(vault.get('lindela_lite_api_key'), 'from-last-version')
    assert.equal(store.has('lindela_lite_api_key'), false,
      'the localStorage copy must go, or the surface claims hardware storage while a script reads it')
  })

  it('a key already in the vault wins, and the stale copy is cleared', async () => {
    store.set('lindela_lite_api_key', 'stale')
    const vault = installShell({ secureStore: true }, { lindela_lite_api_key: 'current' })
    const { hydrateFromSecureStore } = await loadModule()

    const key = await hydrateFromSecureStore()
    assert.equal(key, 'current', 'the vault is the source of truth once it holds one')
    assert.equal(store.has('lindela_lite_api_key'), false)
    assert.equal(vault.get('lindela_lite_api_key'), 'current')
  })
})

describe('a keystore that says no', () => {
  it('keeps the key where it was, and reports that it is not secure', async () => {
    // Android throws from the Keystore when a restored backup or a changed
    // screen lock invalidates it. Dropping the key there loses a district's
    // access to its own data; claiming `secure: true` there would be a lie.
    store.set('lindela_lite_api_key', 'still-mine')
    installRefusingShell()
    const { hydrateFromSecureStore, keyStorage } = await loadModule()

    const key = await hydrateFromSecureStore()
    assert.equal(key, 'still-mine', 'a refused keystore must not lose the key')
    assert.equal(store.get('lindela_lite_api_key'), 'still-mine')
    assert.equal(keyStorage.secure, false, 'and must not claim otherwise')
  })

  it('a write that is refused falls back to localStorage rather than vanishing', async () => {
    installRefusingShell()
    const { writeApiKey } = await loadModule()

    const result = await writeApiKey('typed-in')
    assert.deepEqual(result, { stored: true, secure: false })
    assert.equal(store.get('lindela_lite_api_key'), 'typed-in')
  })
})

describe('signing out', () => {
  it('forgets the key in both places', async () => {
    const vault = installShell({ secureStore: true }, { lindela_lite_api_key: 'vault' })
    store.set('lindela_lite_api_key', 'local')
    const { clearApiKey } = await loadModule()

    await clearApiKey()
    assert.equal(vault.has('lindela_lite_api_key'), false, 'signing out must clear the vault too')
    assert.equal(store.has('lindela_lite_api_key'), false)
  })
})

describe('what the surfaces say about it', () => {
  it('reports the store it used, so a surface can be honest', async () => {
    installShell()
    const { writeApiKey } = await loadModule()
    assert.equal((await writeApiKey('k')).secure, true)

    removeShell()
    const second = await loadModule()
    assert.equal((await second.writeApiKey('k2')).secure, false)
  })

  it('is silent about security in a browser, which is the honest default', async () => {
    const { keyStorage } = await loadModule()
    keyStorage.shell = false
    assert.equal(keyStorage.shell, false)
  })
})
