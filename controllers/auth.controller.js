/**
 * Auth route handlers.
 */
import * as authService from '../services/auth.service.js';
import { supabaseAsUser } from '../config/supabase.js';
import { ok } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';

/** Cookie options for the browser session. */
function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,          // not readable by JS, so XSS cannot steal it
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  };
}

/** POST /api/v1/auth/login */
export const login = asyncHandler(async (req, res) => {
  const session = await authService.login({ ...req.body, req });

  res.cookie('ruralai-access-token', session.accessToken, cookieOptions(3600_000));
  res.cookie('ruralai-refresh-token', session.refreshToken, cookieOptions(30 * 86_400_000));

  return ok(res, session);
});

/** POST /api/v1/auth/refresh */
export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies?.['ruralai-refresh-token'];
  if (!refreshToken) throw ApiError.unauthorized('No refresh token supplied');

  const session = await authService.refresh({ refreshToken });

  res.cookie('ruralai-access-token', session.accessToken, cookieOptions(3600_000));
  res.cookie('ruralai-refresh-token', session.refreshToken, cookieOptions(30 * 86_400_000));

  return ok(res, session);
});

/** POST /api/v1/auth/logout */
export const logout = asyncHandler(async (req, res) => {
  await authService.logout({
    accessToken: req.accessToken,
    user: req.user,
    req,
  });

  res.clearCookie('ruralai-access-token', { path: '/' });
  res.clearCookie('ruralai-refresh-token', { path: '/' });

  return ok(res, { loggedOut: true });
});

/** POST /api/v1/auth/accept-invitation */
export const acceptInvitation = asyncHandler(async (req, res) => {
  const result = await authService.acceptInvitation({ ...req.body, req });
  return ok(res, {
    ...result,
    message: 'Password set. You can now sign in.',
  });
});

/** GET /api/v1/auth/me */
export const me = asyncHandler(async (req, res) => {
  // Read through the caller's own JWT so RLS applies. If a policy is wrong,
  // this returns nothing rather than another user's row.
  const client = supabaseAsUser(req.accessToken);

  const { data, error } = await client
    .from('profiles')
    .select('id, role, full_name, phone, preferred_language, last_login_at, created_at')
    .eq('id', req.user.id)
    .single();

  if (error || !data) throw ApiError.notFound('Profile not found');

  return ok(res, {
    id: data.id,
    email: req.user.email,
    role: data.role,
    fullName: data.full_name,
    phone: data.phone,
    preferredLanguage: data.preferred_language,
    lastLoginAt: data.last_login_at,
    createdAt: data.created_at,
  });
});

/** PATCH /api/v1/auth/me */
export const updateMe = asyncHandler(async (req, res) => {
  const client = supabaseAsUser(req.accessToken);

  const patch = {};
  if (req.body.fullName !== undefined) patch.full_name = req.body.fullName;
  if (req.body.phone !== undefined) patch.phone = req.body.phone;
  if (req.body.preferredLanguage !== undefined) {
    patch.preferred_language = req.body.preferredLanguage;
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest('No updatable fields supplied');
  }

  // Column-level grants (migration 0004) mean role/is_active cannot be
  // written here even if this handler were tricked into trying.
  const { data, error } = await client
    .from('profiles')
    .update(patch)
    .eq('id', req.user.id)
    .select('id, full_name, phone, preferred_language')
    .single();

  if (error) throw ApiError.badRequest(error.message);

  return ok(res, data);
});
