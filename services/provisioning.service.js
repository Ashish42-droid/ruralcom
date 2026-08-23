/**
 * Admin-only account provisioning.
 *
 * Doctors and Clinical Assistants can NEVER self-register. This models a
 * government-assigned-role system: only an admin creates accounts, and the
 * staff member sets their own password from a single-use invitation.
 *
 * Four independent layers enforce this:
 *   1. Supabase public signup disabled at project level (dashboard)
 *   2. This service, reachable only behind requireAdmin
 *   3. The `profiles_enforce_provisioning` trigger (migration 0001)
 *   4. RLS: `authenticated` has no INSERT policy on profiles
 */
import { randomBytes, createHash } from 'node:crypto';

import { supabaseAdmin } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

const INVITATION_TTL_HOURS = 72;

/** Invitation tokens are stored hashed; a DB read yields nothing usable. */
export function hashInvitationToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function generateInvitationToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Is `actor` allowed to provision into `districtId`?
 * Mirrors the `admin_covers_district` SQL function.
 */
async function assertScope(actor, { districtId, stateId }) {
  if (actor.role === 'super_admin') return;

  const { data: scope } = await supabaseAdmin
    .from('admin_scopes')
    .select('scope_level, state_id, district_id')
    .eq('profile_id', actor.id)
    .single();

  if (!scope) throw ApiError.forbidden('Your admin scope is not configured');

  if (actor.role === 'district_admin') {
    if (!districtId || districtId !== scope.district_id) {
      throw ApiError.forbidden('You may only provision within your own district');
    }
    return;
  }

  if (actor.role === 'state_admin') {
    if (stateId && stateId !== scope.state_id) {
      throw ApiError.forbidden('You may only provision within your own state');
    }
    if (districtId) {
      const { data: district } = await supabaseAdmin
        .from('districts')
        .select('state_id')
        .eq('id', districtId)
        .single();
      if (!district || district.state_id !== scope.state_id) {
        throw ApiError.forbidden('That district is outside your state');
      }
    }
  }
}

/**
 * Creates an auth user, a profile, the role-specific detail row, and an
 * invitation. Returns the invitation token ONCE — it is never retrievable
 * again, because only its hash is stored.
 */
export async function provisionAccount({ actor, payload, req }) {
  await assertScope(actor, {
    districtId: payload.districtId,
    stateId: payload.stateId,
  });

  // 1. Auth user, with no password. Only the invitation can set one.
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: payload.email,
    email_confirm: false,
    user_metadata: { full_name: payload.fullName, provisioned_by: actor.id },
  });

  if (authError) {
    if (/already/i.test(authError.message)) {
      throw ApiError.conflict('An account with that email already exists');
    }
    throw ApiError.internal(`Could not create auth user: ${authError.message}`);
  }

  const userId = authUser.user.id;

  try {
    // 2. Profile.
    const { error: profileError } = await supabaseAdmin.from('profiles').insert({
      id: userId,
      role: payload.role,
      full_name: payload.fullName,
      phone: payload.phone ?? null,
      preferred_language: payload.preferredLanguage ?? 'en',
      created_by: actor.id,
      is_active: true,
    });
    if (profileError) throw new Error(profileError.message);

    // 3. Role-specific detail.
    await insertRoleDetail(userId, payload);

    // 4. Invitation.
    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);

    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('staff_invitations')
      .insert({
        email: payload.email,
        role: payload.role,
        profile_id: userId,
        invited_by: actor.id,
        token_hash: hashInvitationToken(token),
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();
    if (inviteError) throw new Error(inviteError.message);

    await recordAudit({
      action: 'account_provisioned',
      actorId: actor.id,
      actorRole: actor.role,
      entityType: 'profile',
      entityId: userId,
      after: {
        role: payload.role,
        email: payload.email,
        districtId: payload.districtId,
        facilityId: payload.facilityId,
      },
      severity: 'warning',
      req,
    });

    return {
      profileId: userId,
      email: payload.email,
      role: payload.role,
      invitation: {
        id: invitation.id,
        // Returned once. Delivery over email/SMS is a later phase — see
        // docs/DECISIONS.md; no provider is configured yet.
        token,
        expiresAt: expiresAt.toISOString(),
      },
    };
  } catch (err) {
    // Roll back the auth user so a failed provision leaves nothing behind.
    await supabaseAdmin.auth.admin.deleteUser(userId).catch((cleanupErr) =>
      logger.error(
        { err: cleanupErr, userId },
        'Orphaned auth user after failed provisioning — needs manual cleanup',
      ),
    );
    throw ApiError.internal(`Provisioning failed: ${err.message}`);
  }
}

async function insertRoleDetail(userId, payload) {
  if (['doctor', 'senior_doctor'].includes(payload.role)) {
    const { error } = await supabaseAdmin.from('doctors').insert({
      profile_id: userId,
      registration_no: payload.registrationNo,
      specialities: payload.specialities ?? [],
      district_id: payload.districtId,
      facility_id: payload.facilityId ?? null,
      data_source: 'PLACEHOLDER_DEMO',
    });
    if (error) throw new Error(error.message);
    return;
  }

  if (payload.role === 'clinical_assistant') {
    const { error } = await supabaseAdmin.from('clinical_assistants').insert({
      profile_id: userId,
      certification_ref: payload.certificationRef ?? null,
      facility_id: payload.facilityId,
    });
    if (error) throw new Error(error.message);
    return;
  }

  if (['state_admin', 'district_admin'].includes(payload.role)) {
    const { error } = await supabaseAdmin.from('admin_scopes').insert({
      profile_id: userId,
      scope_level: payload.role === 'state_admin' ? 'state' : 'district',
      state_id: payload.stateId ?? null,
      district_id: payload.districtId ?? null,
    });
    if (error) throw new Error(error.message);
  }
  // `auditor` needs no detail row.
}

/** Deactivate or reactivate an account. Never a hard delete — audit trail. */
export async function setAccountActive({ actor, profileId, isActive, reason, req }) {
  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_active')
    .eq('id', profileId)
    .single();

  if (!target) throw ApiError.notFound('Staff account not found');

  if (target.id === actor.id) {
    throw ApiError.badRequest('You cannot change your own account status');
  }
  if (target.role === 'super_admin' && actor.role !== 'super_admin') {
    throw ApiError.forbidden('Only a super admin may modify a super admin account');
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ is_active: isActive })
    .eq('id', profileId);

  if (error) throw ApiError.internal(`Could not update account: ${error.message}`);

  await recordAudit({
    action: isActive ? 'account_reactivated' : 'account_deactivated',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'profile',
    entityId: profileId,
    before: { is_active: target.is_active },
    after: { is_active: isActive },
    metadata: { reason },
    severity: 'warning',
    req,
  });

  return { profileId, isActive };
}

export default { provisionAccount, setAccountActive, hashInvitationToken };
