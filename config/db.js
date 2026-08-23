/**
 * Postgres connection pool.
 *
 * Used for migrations, health checks, and any server-side query that needs
 * raw SQL. Application data access normally goes through the Supabase client
 * so that row-level security is applied — see config/supabase.js and the
 * service-role rule in SYSTEM_ARCHITECTURE.md.
 */
import pg from 'pg';
import env from './env.js';
import logger from './logger.js';

const { Pool } = pg;

// Supabase terminates TLS with a certificate chain Node does not ship a root
// for. The connection is still encrypted; we are not verifying the chain.
// Revisit if we move to a self-hosted Postgres with our own CA.
const ssl = { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: env.DATABASE_POOLER_URL || env.DATABASE_URL,
  ssl,
  // Tests hold long-lived transactions (RLS policy tests) and occasionally
  // nest a second connection, so a tight cap starves them into timeouts
  // against a remote database. There is no reason to constrain it.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  application_name: 'ruralai-core-api',
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

/** Run a query. Returns the pg result. */
export function query(text, params) {
  return pool.query(text, params);
}

/** Run a set of queries inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe used by the health endpoint. */
export async function pingDatabase() {
  const started = Date.now();
  const { rows } = await pool.query('select version() as version');
  return {
    ok: true,
    latencyMs: Date.now() - started,
    version: rows[0].version.split(' ').slice(0, 2).join(' '),
  };
}

export async function closePool() {
  await pool.end();
}

export default pool;
