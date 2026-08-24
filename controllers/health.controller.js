/**
 * Health checks.
 *
 * Three endpoints, because they answer different questions:
 *   /live   — is the process up?            (never touches dependencies)
 *   /ready  — can it actually serve traffic? (checks Postgres + Supabase)
 *   /       — human-readable summary for the demo-day status dashboard
 *
 * The distinction matters behind a load balancer: a liveness probe that
 * checks the database will restart every instance during a brief DB blip,
 * turning a small problem into an outage.
 */
import { pingDatabase } from '../config/db.js';
import { pingSupabase } from '../config/supabase.js';
import { pingRedis, isRedisConfigured } from '../config/redis.js';
import { ok } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import env from '../config/env.js';

const startedAt = Date.now();

/** GET /api/v1/health/live */
export const live = (req, res) =>
  ok(res, { status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });

/** GET /api/v1/health/ready */
export const ready = asyncHandler(async (req, res) => {
  const checks = await runChecks();
  const healthy = Object.values(checks).every((c) => c.ok);
  return ok(res, { status: healthy ? 'ready' : 'degraded', checks }, {
    status: healthy ? 200 : 503,
  });
});

/** GET /api/v1/health */
export const summary = asyncHandler(async (req, res) => {
  const checks = await runChecks();
  const healthy = Object.values(checks).every((c) => c.ok);
  return ok(
    res,
    {
      service: 'ruralai-core-api',
      status: healthy ? 'ok' : 'degraded',
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // Identifies which instance answered — essential when verifying the
      // multi-instance load-balanced setup actually works.
      instance: process.env.HOSTNAME || process.pid,
      checks,
    },
    { status: healthy ? 200 : 503 },
  );
});

async function runChecks() {
  const [database, supabase, redis] = await Promise.allSettled([
    pingDatabase(),
    pingSupabase(),
    // Reported but NOT part of readiness: without Redis the API still
    // serves every clinical route, it just cannot auto-reassign a missed
    // consultation. Failing readiness would pull a working instance out of
    // the load balancer over a degraded background feature.
    isRedisConfigured ? pingRedis() : Promise.resolve({ ok: true, skipped: 'not configured' }),
  ]);
  return {
    database: settledToCheck(database),
    supabaseAuth: settledToCheck(supabase),
    redis: settledToCheck(redis),
  };
}

function settledToCheck(result) {
  if (result.status === 'fulfilled') return result.value;
  return { ok: false, error: result.reason?.message ?? 'unknown error' };
}
