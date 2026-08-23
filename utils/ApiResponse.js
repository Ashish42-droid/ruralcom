/**
 * Uniform success envelope, so every client parses one shape.
 *
 * { success: true, data: <payload>, meta: { requestId, ... } }
 */
export class ApiResponse {
  constructor(data, meta = {}) {
    this.success = true;
    this.data = data;
    this.meta = meta;
  }
}

/** Send a success response. */
export function ok(res, data, { status = 200, meta = {} } = {}) {
  return res.status(status).json(
    new ApiResponse(data, { requestId: res.locals.requestId, ...meta }),
  );
}

/** Send a 201 with the created resource. */
export function created(res, data, meta) {
  return ok(res, data, { status: 201, meta });
}

export default ApiResponse;
