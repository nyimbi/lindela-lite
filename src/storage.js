import { Pg0Manager } from './pg0.js'
import { PostgresStore } from './postgres-store.js'
import { JsonStore } from './store.js'

export async function createStoreFromEnv(env = process.env) {
  const mode = (env.LINDELA_LITE_DB_MODE || 'auto').toLowerCase()
  const databaseUrl = env.LINDELA_LITE_DATABASE_URL || env.DATABASE_URL

  if (mode === 'json') {
    return annotate(new JsonStore(env.LINDELA_LITE_STORE), 'json')
  }

  if (mode === 'postgres') {
    if (!databaseUrl) throw new Error('LINDELA_LITE_DATABASE_URL or DATABASE_URL is required when LINDELA_LITE_DB_MODE=postgres')
    const store = new PostgresStore({ databaseUrl })
    await store.ensureSchema()
    return annotate(store, 'postgres')
  }

  if (mode === 'pg0') {
    const pg0 = new Pg0Manager({ databaseUrl })
    const started = await pg0.start()
    const store = new PostgresStore({ databaseUrl: started.databaseUrl })
    await store.ensureSchema()
    return annotate(store, 'pg0')
  }

  if (mode !== 'auto') throw new Error(`Unknown LINDELA_LITE_DB_MODE: ${mode}`)

  if (databaseUrl) {
    const store = new PostgresStore({ databaseUrl })
    await store.ensureSchema()
    return annotate(store, 'postgres')
  }

  const pg0 = new Pg0Manager()
  if (await pg0.available()) {
    const started = await pg0.start()
    const store = new PostgresStore({ databaseUrl: started.databaseUrl })
    await store.ensureSchema()
    return annotate(store, 'pg0')
  }

  return annotate(new JsonStore(env.LINDELA_LITE_STORE), 'json')
}

function annotate(store, mode) {
  store.mode = mode
  return store
}
