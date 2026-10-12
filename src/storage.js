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
    const pg0 = new Pg0Manager({ databaseUrl, command: env.PG0_BIN, name: env.PG0_NAME || env.LINDELA_LITE_PG0_NAME, port: env.PG0_PORT || env.LINDELA_LITE_PG0_PORT, dataDir: env.PG0_DATA_DIR || env.LINDELA_LITE_PG0_DATA_DIR })
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

  const pg0 = new Pg0Manager({ command: env.PG0_BIN, name: env.PG0_NAME || env.LINDELA_LITE_PG0_NAME, port: env.PG0_PORT || env.LINDELA_LITE_PG0_PORT, dataDir: env.PG0_DATA_DIR || env.LINDELA_LITE_PG0_DATA_DIR })
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

/**
 * ENH-67. The read replica, if this deployment has one.
 *
 * `LINDELA_LITE_REPLICA_URL` names a streaming replica; unset, this returns
 * `null` and `readReplicaStore` hands back the primary *itself*, so a
 * deployment without a replica runs exactly the code it ran before this
 * existed — no wrapper, no indirection, no second pool.
 *
 * `ensureSchema()` is deliberately not called. A replica is read-only and its
 * schema arrives by streaming from the primary; running migrations against it
 * would be a write to a database that exists to be read, and the failure would
 * be silent until the replica diverged. The pool is lazy, so an unreachable
 * replica costs nothing here — the first read falls back and counts itself.
 */
export function createReplicaFromEnv(env = process.env) {
  const url = env.LINDELA_LITE_REPLICA_URL
  if (!url) return null
  return new PostgresStore({ databaseUrl: url })
}
