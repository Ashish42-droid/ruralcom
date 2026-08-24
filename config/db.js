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
  // In test, Jest runs multiple worker PROCESSES in parallel, each importing
  // this module fresh and opening its own Pool. Worker count × max here is
  // the real concurrent-connection ceiling against Supavisor's session
  // pooler, which caps total connections tightly (D-037). A generous max
  // per worker (this used to be 10 unconditionally) multiplies across
  // workers and can exhaust the pooler well before any single test does
  // anything wrong — see jest.config.js maxWorkers, which bounds the other
  // side of that multiplication.
  max: env.isTest ? 3 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  application_name: 'ruralai-core-api',
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle Postgres client');
});

/**
 * Turns the two confusing Postgres connection failures into actionable ones.
 *
 * `ENOTFOUND` on the direct host is almost never a typo — the direct host
 * `db.<ref>.supabase.co` has ONLY an AAAA record, so the moment the machine
 * loses its IPv6 route the OS resolver returns nothing and Node reports the
 * host as non-existent. `nslookup` still succeeds, which makes it look like
 * a code bug for far longer than it should.
 */
export function explainConnectionError(err) {
  const usingPooler = Boolean(env.DATABASE_POOLER_URL);

  if (err?.code === 'ENOTFOUND' && !usingPooler) {
    return (
      'Could not resolve the direct Postgres host. That host is IPv6-only, ' +
      'so this fails whenever IPv6 is unavailable on this network — even ' +
      'though nslookup still resolves it. Fix: set DATABASE_POOLER_URL to ' +
      'the IPv4 Supavisor pooler string from the Supabase dashboard ' +
      '(Settings -> Database -> Connection string -> Session pooler). ' +
      'See docs/DECISIONS.md D-010.'
    );
  }

  if (err?.message?.includes('Tenant or user not found')) {
    return (
      'The pooler rejected the credentials. The pooler username must be ' +
      '"postgres.<project-ref>", not "postgres", and the region in the ' +
      'hostname must match the project. Copy the exact string from the ' +
      'dashboard rather than constructing it.'
    );
  }

  return null;
}

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
