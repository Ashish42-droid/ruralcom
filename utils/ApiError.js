/**
 * Operational API error.
 *
 * `isOperational` distinguishes errors we anticipated (bad input, forbidden,
 * not found) from genuine bugs. The error handler leaks details for the
 * former and hides them for the latter.
 */
export class ApiError extends Error {
  constructor(statusCode, message, { code, details, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || httpCodeFor(statusCode);
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', opts) {
    return new ApiError(400, message, opts);
  }

  static unauthorized(message = 'Authentication required', opts) {
    return new ApiError(401, message, opts);
  }

  static forbidden(message = 'You do not have access to this resource', opts) {
    return new ApiError(403, message, opts);
  }

  static notFound(message = 'Resource not found', opts) {
    return new ApiError(404, message, opts);
  }

  static conflict(message = 'Conflict', opts) {
    return new ApiError(409, message, opts);
  }

  static unprocessable(message = 'Unprocessable entity', opts) {
    return new ApiError(422, message, opts);
  }

  static tooManyRequests(message = 'Too many requests', opts) {
    return new ApiError(429, message, opts);
  }

  static internal(message = 'Internal server error', opts) {
    const err = new ApiError(500, message, opts);
    err.isOperational = false;
    return err;
  }

  static serviceUnavailable(message = 'Service unavailable', opts) {
    return new ApiError(503, message, opts);
  }
}

function httpCodeFor(status) {
  const map = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };
  return map[status] || 'ERROR';
}

export default ApiError;
