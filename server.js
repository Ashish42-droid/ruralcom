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
import { pingRedis, isRedisConfigured } from './config/redis.js';
import { startToleranceWorker, closeConsultationQueue } from './jobs/consultationQueue.js';
import { initSockets, closeSockets } from './sockets/index.js';
import { shutdownOcr } from './services/ocr/index.js';
import { handleToleranceExpiry } from './services/consultation.service.js';

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

  if (isRedisConfigured) {
    try {
      const redis = await pingRedis();
      logger.info({ ...redis }, 'Redis reachable');
    } catch (err) {
      logger.error({ err }, 'Redis unreachable at boot');
    }
  } else {
    // Not fatal, but a real loss of safety: missed consultations will not
    // be reassigned automatically.
    logger.warn('REDIS_URL is not configured — consultation tolerance windows are DISABLED');
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

  // Injected rather than imported inside the queue module, so jobs/ does
  // not take a circular dependency on services/consultation.service.js.
  startToleranceWorker(handleToleranceExpiry);
  await initSockets(server);
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
      // Sockets first: stop accepting new realtime work before tearing
      // down the queue and pool it depends on.
      await closeSockets();
      logger.info('Socket.IO closed');
    } catch (socketErr) {
      logger.error({ err: socketErr }, 'Error closing Socket.IO');
    }

    try {
      // Then the queue, so an in-flight tolerance expiry can finish before
      // the database connection it needs disappears.
      await closeConsultationQueue();
      logger.info('Consultation queue closed');
    } catch (queueErr) {
      logger.error({ err: queueErr }, 'Error closing consultation queue');
    }

    try {
      await shutdownOcr();
      logger.info('OCR worker terminated');
    } catch (ocrErr) {
      logger.error({ err: ocrErr }, 'Error terminating the OCR worker');
    }

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
