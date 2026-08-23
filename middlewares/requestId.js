import { randomUUID } from 'node:crypto';

/**
 * Assigns a request id, echoed back as `X-Request-Id`.
 *
 * Every log line and error response carries it, so a report of "the
 * assessment failed at 14:32" can be traced to exact log lines. On a live
 * demo stage this is the difference between diagnosing in 30 seconds and
 * not diagnosing at all.
 */
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.locals.requestId = id;
  res.set('X-Request-Id', id);
  next();
}

export default requestId;
