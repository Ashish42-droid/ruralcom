/**
 * Role-based access guards.
 *
 * These are the SECOND line of defence, not the first. Row-level security in
 * Postgres is the real control — these guards fail requests early with a
 * clean error and produce an audit trail, but a bug here must not become a
 * data leak. If a route guard is the only thing standing between a caller
 * and another facility's patients, the RLS policy is missing.
 *
 * Roles are explicit sets, never inheritance chains.
 */
import ApiError from '../utils/ApiError.js';
import { recordAuditAsync } from '../services/audit.service.js';
import { ADMIN_ROLES } from '../models/auth.schema.js';

function deny(req, next, reason, required) {
  recordAuditAsync({
    action: 'permission_denied',
    actorId: req.user?.id,
    actorRole: req.user?.role,
    metadata: {
      reason,
      required,
      actual: req.user?.role ?? null,
      method: req.method,
      path: req.originalUrl,
    },
    severity: 'warning',
    req,
  });
  next(ApiError.forbidden('You do not have permission to perform this action'));
}

/**
 * Requires the caller to hold one of the given roles.
 * @param {...string} roles
 */
export function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return function roleGuard(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    if (!allowed.has(req.user.role)) {
      return deny(req, next, 'role_not_permitted', [...allowed]);
    }
    return next();
  };
}

/** Any admin-family role. */
export const requireAdmin = requireRole(...ADMIN_ROLES);

/** Only the developer-held bootstrap role. */
export const requireSuperAdmin = requireRole('super_admin');

/** Either doctor role. */
export const requireDoctor = requireRole('doctor', 'senior_doctor');

/** Clinical staff who capture patient data. */
export const requireClinicalAssistant = requireRole('clinical_assistant');

/**
 * Blocks clinical writes by admin roles.
 *
 * "Admin cannot edit patient data" is a requirement, not a UI convention —
 * hiding the button is not a control. This mirrors the RLS policy so the
 * request fails before it reaches the database at all.
 */
export function denyAdminClinicalWrite(req, _res, next) {
  if (req.user && ADMIN_ROLES.includes(req.user.role)) {
    return deny(req, next, 'admin_clinical_write_blocked', ['non-admin clinical role']);
  }
  return next();
}

export default { requireRole, requireAdmin, requireSuperAdmin, requireDoctor };
