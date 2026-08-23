import ApiError from '../utils/ApiError.js';

/** Terminal 404 handler — mounted after all routes. */
export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

export default notFound;
