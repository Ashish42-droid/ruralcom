/**
 * Rate limiters.
 *
 * Phase 0 uses the in-memory store, which is per-instance. That is a known
 * gap: behind the load balancer described in SYSTEM_ARCHITECTURE.md, N
 * instances means N times the effective limit. Phase 1 swaps in the Redis
 * store so limits are global — tracked in docs/DECISIONS.md.
 */
import rateLimit from 'express-rate-limit';
import ApiError from '../utils/ApiError.js';

function handler(_req, _res, next) {
  next(ApiError.tooManyRequests());
}

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
};

/** Broad limiter for the whole API surface. */
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
});

/**
 * Login and account endpoints. Deliberately strict: credential stuffing
 * against a system with no public signup is the main auth threat here.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** AI assessment runs — each one costs real money, so cap per user. */
export const assessmentLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
});

/**
 * Patient lookup by health ID. Rate-limited to make enumeration of the
 * 12-digit ID space detectable and impractical (see SYSTEM_ARCHITECTURE.md
 * §Patient identity).
 */
export const patientLookupLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
});
