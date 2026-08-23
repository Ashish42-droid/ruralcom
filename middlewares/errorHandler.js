import { ZodError } from 'zod';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../config/logger.js';

/**
 * Central error handler.
 *
 * Anticipated errors return their message. Unanticipated ones return a
 * generic message plus the request id — internal details never reach the
 * client, because an error string can leak schema names, file paths, or
 * patient data.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(err, req, res, _next) {
  let error = err;

  if (err instanceof ZodError) {
    error = ApiError.badRequest('Request validation failed', {
      code: 'VALIDATION_ERROR',
      details: err.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
      cause: err,
    });
  } else if (!(err instanceof ApiError)) {
    error = ApiError.internal(err.message, { cause: err });
  }

  const level = error.statusCode >= 500 ? 'error' : 'warn';
  logger[level](
    { err, requestId: req.id, method: req.method, url: req.originalUrl, statusCode: error.statusCode },
    error.message,
  );

  const body = {
    success: false,
    error: {
      code: error.code,
      message: error.isOperational ? error.message : 'Internal server error',
      requestId: req.id,
    },
  };

  if (error.details) body.error.details = error.details;
  if (!env.isProduction && !error.isOperational) body.error.stack = err.stack;

  res.status(error.statusCode).json(body);
}

export default errorHandler;
