/**
 * Admin route handlers — staff provisioning and region-wise management.
 *
 * Admins manage staff. Admins never touch patient clinical data; that is
 * enforced by RLS, a database trigger, and `denyAdminClinicalWrite`.
 */
import * as provisioning from '../services/provisioning.service.js';
import { supabaseAsUser, supabaseAdmin } from '../config/supabase.js';
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

/**
 * GET /api/v1/admin/regions/summary
 *
 * The state -> district drill-down the admin console is built around:
 * every district with its facility count and its doctor roster split by
 * availability, in one round trip.
 *
 * Counts come from the SERVICE ROLE deliberately. Admins have no clinical
 * read (patients, visits, assessments are all invisible to them), but they
 * do need aggregate operational figures for the regions they manage —
 * "how many doctors are online in Kanpur Nagar" is a management question,
 * not a clinical one. Nothing here identifies a patient.
 */
export const regionSummary = asyncHandler(async (req, res) => {
  const [statesRes, districtsRes, facilitiesRes, doctorsRes, assistantsRes] =
    await Promise.all([
      supabaseAdmin.from('states').select('id, name, code, data_source').order('name'),
      supabaseAdmin.from('districts').select('id, name, code, state_id, data_source').order('name'),
      supabaseAdmin.from('facilities').select('id, district_id, type, is_active'),
      supabaseAdmin
        .from('doctors')
        .select('profile_id, district_id, availability_status, specialities'),
      supabaseAdmin.from('clinical_assistants').select('profile_id, facility_id'),
    ]);

  const firstError = [statesRes, districtsRes, facilitiesRes, doctorsRes, assistantsRes]
    .map((r) => r.error)
    .find(Boolean);
  if (firstError) throw ApiError.badRequest(firstError.message);

  const facilityDistrict = new Map(
    (facilitiesRes.data ?? []).map((f) => [f.id, f.district_id]),
  );

  const assistantsByDistrict = new Map();
  for (const a of assistantsRes.data ?? []) {
    const districtId = facilityDistrict.get(a.facility_id);
    if (!districtId) continue;
    assistantsByDistrict.set(districtId, (assistantsByDistrict.get(districtId) ?? 0) + 1);
  }

  const summary = (statesRes.data ?? []).map((state) => {
    const districts = (districtsRes.data ?? [])
      .filter((d) => d.state_id === state.id)
      .map((d) => {
        const facilities = (facilitiesRes.data ?? []).filter((f) => f.district_id === d.id);
        const doctors = (doctorsRes.data ?? []).filter((doc) => doc.district_id === d.id);

        const facilitiesByType = facilities.reduce((acc, f) => {
          acc[f.type] = (acc[f.type] ?? 0) + 1;
          return acc;
        }, {});

        const specialities = [...new Set(doctors.flatMap((doc) => doc.specialities ?? []))].sort();

        return {
          id: d.id,
          name: d.name,
          code: d.code,
          dataSource: d.data_source,
          facilities: { total: facilities.length, byType: facilitiesByType },
          doctors: {
            total: doctors.length,
            available: doctors.filter((doc) => doc.availability_status === 'available').length,
            busy: doctors.filter((doc) => doc.availability_status === 'busy').length,
            offline: doctors.filter((doc) => doc.availability_status === 'offline').length,
            specialities,
          },
          clinicalAssistants: assistantsByDistrict.get(d.id) ?? 0,
        };
      });

    return {
      id: state.id,
      name: state.name,
      code: state.code,
      dataSource: state.data_source,
      districts,
      totals: {
        districts: districts.length,
        facilities: districts.reduce((n, d) => n + d.facilities.total, 0),
        doctors: districts.reduce((n, d) => n + d.doctors.total, 0),
        doctorsAvailable: districts.reduce((n, d) => n + d.doctors.available, 0),
        clinicalAssistants: districts.reduce((n, d) => n + d.clinicalAssistants, 0),
      },
    };
  });

  const anyDemo = summary.some(
    (s) => s.dataSource === 'PLACEHOLDER_DEMO' || s.districts.some((d) => d.dataSource === 'PLACEHOLDER_DEMO'),
  );

  return ok(res, summary, {
    meta: {
      containsDemoData: anyDemo,
      warning: anyDemo
        ? 'Some rows are PLACEHOLDER_DEMO seed data, not an authoritative government source.'
        : undefined,
    },
  });
});
