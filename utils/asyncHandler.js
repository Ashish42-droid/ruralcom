/**
 * Wraps an async route handler so rejected promises reach the error
 * middleware instead of becoming an unhandled rejection.
 *
 * Express 5 forwards rejected promises automatically, but wrapping keeps the
 * intent explicit and keeps handlers identical if we ever move off Express.
 */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
