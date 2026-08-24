/**
 * BullMQ queue for the consultation tolerance window.
 *
 * WHY A JOB QUEUE AND NOT setTimeout: the API runs multiple instances
 * behind a load balancer. A `setTimeout` lives in one process's memory and
 * dies with a deploy, a crash, or a scale-down — silently, taking the
 * patient's escalation with it. A delayed job survives all three and fires
 * on whichever instance is alive.
 *
 * DEGRADED MODE: if `REDIS_URL` is unset, scheduling still works and calls
 * still connect — only the automatic miss-and-reassign is unavailable. That
 * is a real loss of safety, so it is logged loudly rather than passed over
 * in silence, but it is better than refusing to schedule at all.
 */
import { Queue, Worker } from 'bullmq';

import { createRedisConnection, isRedisConfigured } from '../config/redis.js';
import logger from '../config/logger.js';

export const QUEUE_NAME = 'consultation-tolerance';
const JOB_NAME = 'tolerance-expiry';

/**
 * Deterministic job id, so cancelling on join is a direct lookup rather
 * than a queue scan.
 *
 * NOTE the hyphen: BullMQ REJECTS a colon in a custom job id (it uses ':'
 * as its own Redis key separator) with "Custom Id cannot contain :". That
 * failure surfaces only at enqueue time, so with a colon here every single
 * tolerance window would silently fail to arm in production.
 */
const jobIdFor = (consultationId) => `tolerance-${consultationId}`;

let queue = null;
let worker = null;

function getQueue() {
  if (!isRedisConfigured) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: createRedisConnection('tolerance-queue'),
      defaultJobOptions: {
        // Keep the queue small: Upstash bills per command, and completed
        // tolerance jobs have no diagnostic value once the audit log has
        // recorded the outcome.
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    });
  }
  return queue;
}

/** Arms the tolerance timer for a consultation. */
export async function scheduleToleranceExpiry({ consultationId, delayMs }) {
  const q = getQueue();

  if (!q) {
    logger.error(
      { consultationId },
      'REDIS_URL is not configured — tolerance window NOT armed. A missed ' +
        'call will not auto-reassign and the patient may wait indefinitely.',
    );
    return null;
  }

  const job = await q.add(
    JOB_NAME,
    { consultationId },
    { delay: delayMs, jobId: jobIdFor(consultationId) },
  );

  logger.info({ consultationId, delayMs }, 'Tolerance window armed');
  return job.id;
}

/** Disarms the timer — called when the doctor joins in time. */
export async function cancelToleranceExpiry(consultationId) {
  const q = getQueue();
  if (!q) return false;

  const job = await q.getJob(jobIdFor(consultationId));
  if (!job) return false;

  // A job already in progress cannot be removed; that race is harmless
  // because handleToleranceExpiry() re-reads status and no-ops on 'active'.
  await job.remove().catch(() => {});
  logger.info({ consultationId }, 'Tolerance window disarmed');
  return true;
}

/**
 * Starts the worker. Called from server.js.
 *
 * The handler is injected rather than imported so this module stays free of
 * a circular dependency on consultation.service.js, which imports it.
 */
export function startToleranceWorker(handler) {
  if (!isRedisConfigured) {
    logger.warn(
      'REDIS_URL is not configured — the consultation tolerance worker is ' +
        'NOT running. Missed calls will not be reassigned automatically.',
    );
    return null;
  }

  if (worker) return worker;

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { consultationId } = job.data;
      const result = await handler(consultationId);
      logger.info({ consultationId, ...result }, 'Tolerance window expired');
      return result;
    },
    {
      connection: createRedisConnection('tolerance-worker'),
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { err, consultationId: job?.data?.consultationId, attempt: job?.attemptsMade },
      'Tolerance expiry handler failed',
    );
  });

  logger.info({ queue: QUEUE_NAME }, 'Consultation tolerance worker started');
  return worker;
}

/** Graceful shutdown — lets an in-flight expiry finish before exiting. */
export async function closeConsultationQueue() {
  await worker?.close().catch(() => {});
  await queue?.close().catch(() => {});
  worker = null;
  queue = null;
}

export default {
  scheduleToleranceExpiry,
  cancelToleranceExpiry,
  startToleranceWorker,
  closeConsultationQueue,
  QUEUE_NAME,
};
