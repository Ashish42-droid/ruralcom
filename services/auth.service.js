/**
 * Authentication service — login, refresh, logout, invitation acceptance.
 *
 * Supabase Auth is the identity provider. This layer adds the things a
 * clinical system needs on top: audit trail, deactivation checks, and a
 * uniform session shape for clients.
 */
import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import { invalidateToken } from '../middlewares/authenticate.js';
import { hashInvitationToken } from './provisioning.service.js';
import ApiError from '../utils/ApiError.js';

/** Shapes a Supabase session for API consumers. */
function toSession(session, profile) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    tokenType: session.token_type,
    user: {
      id: profile.id,
      email: session.user?.email,
      role: profile.role,
      fullName: profile.full_name,
      preferredLanguage: profile.preferred_language,
    },
  };
}

export async function login({ email, password, req }) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error || !data?.session) {
    await recordAudit({
      action: 'login_failed',
      entityType: 'auth',
      metadata: { email, reason: error?.message ?? 'unknown' },
      severity: 'warning',
      req,
    });
    // Deliberately generic: distinguishing "no such account" from "wrong
    // password" tells an attacker which emails are valid staff accounts.
    throw ApiError.unauthorized('Invalid email or password');
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_active, preferred_language')
    .eq('id', data.user.id)
    .single();

  if (!profile) {
    await supabaseAnon.auth.signOut();
    throw ApiError.forbidden('No staff profile is linked to this account');
  }

  if (!profile.is_active) {
    await supabaseAnon.auth.signOut();
    await recordAudit({
      action: 'login_failed',
      actorId: profile.id,
      actorRole: profile.role,
      metadata: { reason: 'account_deactivated' },
      severity: 'warning',
      req,
    });
    throw ApiError.forbidden('This account has been deactivated');
  }

  await supabaseAdmin
    .from('profiles')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', profile.id);

  await recordAudit({
    action: 'login',
    actorId: profile.id,
    actorRole: profile.role,
    entityType: 'auth',
    entityId: profile.id,
    // An admin login is worth alerting on — see the secret-login design.
    severity: ['super_admin', 'state_admin', 'district_admin'].includes(profile.role)
      ? 'warning'
      : 'info',
    req,
  });

  return toSession(data.session, profile);
}

export async function refresh({ refreshToken }) {
  const { data, error } = await supabaseAnon.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data?.session) {
    throw ApiError.unauthorized('Session could not be refreshed');
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_active, preferred_language')
    .eq('id', data.user.id)
    .single();

  if (!profile?.is_active) {
    throw ApiError.forbidden('This account has been deactivated');
  }

  return toSession(data.session, profile);
}

export async function logout({ accessToken, user, req }) {
  invalidateToken(accessToken);
  await supabaseAdmin.auth.admin.signOut(accessToken).catch(() => {
    // Already-expired tokens throw; the session is gone either way.
  });

  await recordAudit({
    action: 'logout',
    actorId: user.id,
    actorRole: user.role,
    entityType: 'auth',
    entityId: user.id,
    req,
  });
}

/**
 * Accepts an invitation: the staff member sets their own password.
 *
 * The admin who provisioned the account never learns the credential, so
 * "who could have logged in as that doctor?" has exactly one answer.
 */
export async function acceptInvitation({ token, password, req }) {
  const tokenHash = hashInvitationToken(token);

  const { data: invitation } = await supabaseAdmin
    .from('staff_invitations')
    .select('id, email, role, profile_id, expires_at, accepted_at, revoked_at')
    .eq('token_hash', tokenHash)
    .single();

  if (!invitation) throw ApiError.notFound('Invitation not found');
  if (invitation.revoked_at) throw ApiError.forbidden('This invitation was revoked');
  if (invitation.accepted_at) throw ApiError.conflict('This invitation was already used');
  if (new Date(invitation.expires_at) < new Date()) {
    throw ApiError.forbidden('This invitation has expired');
  }

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
    invitation.profile_id,
    { password, email_confirm: true },
  );
  if (updateError) {
    throw ApiError.internal(`Could not set password: ${updateError.message}`);
  }

  await supabaseAdmin
    .from('staff_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invitation.id);

  await recordAudit({
    action: 'invitation_accepted',
    actorId: invitation.profile_id,
    actorRole: invitation.role,
    entityType: 'staff_invitation',
    entityId: invitation.id,
    req,
  });

  return { email: invitation.email, role: invitation.role };
}

export default { login, refresh, logout, acceptInvitation };
