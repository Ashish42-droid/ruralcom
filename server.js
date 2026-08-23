/**
 * HTTP server entry point.
 *
 * Owns the listener and graceful shutdown. Shutdown matters more than usual
 * here: a rolling deploy must not drop a Clinical Assistant mid-upload or
 * cut a doctor out of a consultation, so in-flight requests are allowed to
 * finish before the process exits.
 */
import http from 'node:http';

import app from './app.js';
import env from './config/env.js';
import logger from './config/logger.js';
import { closePool, pingDatabase } from './config/db.js';
import { pingSupabase } from './config/supabase.js';

const server = http.createServer(app);

async function verifyDependencies() {
  const results = await Promise.allSettled([pingDatabase(), pingSupabase()]);
  const [db, sb] = results;

  if (db.status === 'fulfilled') {
    logger.info({ ...db.value }, 'Postgres reachable');
  } else {
    logger.error({ err: db.reason }, 'Postgres unreachable at boot');
  }

  if (sb.status === 'fulfilled') {
    logger.info({ ...sb.value }, 'Supabase Auth reachable');
  } else {
    logger.error({ err: sb.reason }, 'Supabase Auth unreachable at boot');
  }

  // Deliberately non-fatal. A transient dependency blip should not stop the
  // process from starting and serving /health/live — the readiness probe
  // keeps it out of the load balancer until it recovers.
}

server.listen(env.PORT, async () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, pid: process.pid },
    `RuralAI Core API listening on ${env.API_BASE_URL}`,
  );
  await verifyDependencies();
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const force = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);
  force.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'Error closing HTTP server');
    try {
      await closePool();
      logger.info('Postgres pool closed');
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'Error closing Postgres pool');
    }
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});

export default server;
