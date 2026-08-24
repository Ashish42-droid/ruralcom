/**
 * Redis connections.
 *
 * Serves two distinct purposes, deliberately kept separate:
 *   1. BullMQ — the job queue behind the 5-minute consultation tolerance
 *      window and any other delayed/background work.
 *   2. (Later) the Socket.IO adapter, so realtime events fan out across
 *      load-balanced instances.
 *
 * SCHEME MATTERS: Upstash requires TLS. The dashboard's `redis-cli` example
 * passes `--tls` as a separate flag alongside a `redis://` URL, but ioredis
 * negotiates TLS from the scheme alone — so the stored URL must be
 * `rediss://`. With plain `redis://` the connection fails in a way that
 * looks like a network problem rather than a configuration one.
 *
 * COST NOTE: Upstash bills per command. BullMQ workers poll, so an
 * always-on worker consumes commands continuously even with no jobs
 * queued. `POLL_INTERVAL_MS` below trades tolerance-window precision for
 * command volume — see docs/DECISIONS.md D-043.
 */
import Redis from 'ioredis';

import env from './env.js';
import logger from './logger.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` — with a finite value it
 * aborts blocking commands mid-wait and jobs are silently dropped.
 */
const BULLMQ_OPTIONS = Object.freeze({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const isRedisConfigured = Boolean(env.REDIS_URL);

/**
 * Creates a NEW connection.
 *
 * BullMQ requires a dedicated connection per Queue and per Worker — sharing
 * one causes blocking commands to starve each other. Callers should not
 * cache the result.
 */
export function createRedisConnection(label = 'generic') {
  if (!isRedisConfigured) {
    throw new Error('REDIS_URL is not configured');
  }

  const client = new Redis(env.REDIS_URL, BULLMQ_OPTIONS);

  client.on('error', (err) => {
    // Logged, not thrown: ioredis reconnects on its own, and an unhandled
    // error event would take the process down over a transient blip.
    logger.error({ err, label }, 'Redis connection error');
  });

  client.on('reconnecting', () => {
    logger.warn({ label }, 'Redis reconnecting');
  });

  return client;
}

/** Liveness probe for the health endpoint. */
export async function pingRedis() {
  if (!isRedisConfigured) {
    return { ok: false, error: 'REDIS_URL is not configured' };
  }

  const client = createRedisConnection('healthcheck');
  const started = Date.now();
  try {
    await client.ping();
    return { ok: true, latencyMs: Date.now() - started };
  } finally {
    await client.quit().catch(() => {});
  }
}

export default { createRedisConnection, pingRedis, isRedisConfigured };
