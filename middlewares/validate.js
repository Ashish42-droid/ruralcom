/**
 * Zod request validation.
 *
 * With plain JavaScript there is no compile-time type checking, so runtime
 * validation is the only thing standing between a malformed payload and the
 * triage engine. Every route that accepts input must use this — treat an
 * unvalidated body on a clinical endpoint as a defect.
 *
 * Usage:
 *   router.post('/', validate({ body: createPatientSchema }), handler)
 */
export function validate(schemas) {
  return function validateRequest(req, _res, next) {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err); // ZodError is normalised by errorHandler
    }
  };
}

export default validate;
