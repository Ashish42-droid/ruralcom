/**
 * Admin route handlers — staff provisioning and region-wise management.
 *
 * Admins manage staff. Admins never touch patient clinical data; that is
 * enforced by RLS, a database trigger, and `denyAdminClinicalWrite`.
 */
import * as provisioning from '../services/provisioning.service.js';
import { supabaseAsUser } from '../config/supabase.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

/** POST /api/v1/admin/staff */
export const provisionStaff = asyncHandler(async (req, res) => {
  const result = await provisioning.provisionAccount({
    actor: req.user,
    payload: req.body,
    req,
  });

  return created(res, {
    ...result,
    notice:
      'The invitation token is shown once and cannot be retrieved again. ' +
      'No email/SMS provider is configured yet, so deliver it manually.',
  });
});

/** PATCH /api/v1/admin/staff/:profileId/status */
export const setStaffStatus = asyncHandler(async (req, res) => {
  const result = await provisioning.setAccountActive({
    actor: req.user,
    profileId: req.params.profileId,
    isActive: req.body.isActive,
    reason: req.body.reason,
    req,
  });
  return ok(res, result);
});

/**
 * GET /api/v1/admin/staff
 *
 * Read through the caller's JWT so RLS scopes the result. A district admin
 * physically cannot see another district's staff, even if this handler had
 * a filtering bug.
 */
export const listStaff = asyncHandler(async (req, res) => {
  const { role, isActive, limit, offset } = req.validatedQuery;
  const client = supabaseAsUser(req.accessToken);

  let query = client
    .from('profiles')
    .select('id, role, full_name, phone, is_active, last_login_at, created_at', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (role) query = query.eq('role', role);
  if (isActive !== undefined) query = query.eq('is_active', isActive === 'true');

  const { data, error, count } = await query;
  if (error) throw ApiError.badRequest(error.message);

  return ok(
    res,
    data.map((p) => ({
      id: p.id,
      role: p.role,
      fullName: p.full_name,
      phone: p.phone,
      isActive: p.is_active,
      lastLoginAt: p.last_login_at,
      createdAt: p.created_at,
    })),
    { meta: { total: count, limit, offset } },
  );
});

/** GET /api/v1/admin/regions — state -> district tree, RLS-scoped. */
export const listRegions = asyncHandler(async (req, res) => {
  const client = supabaseAsUser(req.accessToken);

  const { data: states, error } = await client
    .from('states')
    .select('id, name, code, data_source, districts(id, name, code, data_source)')
    .order('name');

  if (error) throw ApiError.badRequest(error.message);

  return ok(res, states, {
    meta: {
      // Never let seed data be mistaken for an authoritative source.
      warning:
        'Rows marked data_source=PLACEHOLDER_DEMO are seed data, not an ' +
        'authoritative government source.',
    },
  });
});
