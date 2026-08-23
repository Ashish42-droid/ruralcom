/**
 * Authentication middleware.
 *
 * Verifies the bearer token with Supabase Auth and attaches the caller's
 * profile to `req.user`. Also keeps the raw token on `req.accessToken` so
 * handlers can build an RLS-scoped client via `supabaseAsUser()`.
 *
 * Verification goes through Supabase rather than local signature checking so
 * that revocation and sign-out take effect immediately. That is a network
 * call per request, so results are cached briefly — see CACHE_TTL_MS. The
 * cache is keyed on a hash of the token, never the token itself.
 */
import { createHash } from 'node:crypto';

import { supabaseAdmin } from '../config/supabase.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { recordAuditAsync } from '../services/audit.service.js';

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;
const cache = new Map();

function tokenKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Cheap eviction: drop the oldest inserted entry.
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Drops a token from the cache — called on logout and deactivation. */
export function invalidateToken(token) {
  cache.delete(tokenKey(token));
}

/** Clears the whole cache. Used by tests. */
export function clearAuthCache() {
  cache.clear();
}

function extractToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // Browser clients use an httpOnly cookie rather than localStorage, so an
  // XSS in a page rendering OCR'd document text cannot exfiltrate a session.
  if (req.cookies?.['ruralai-access-token']) return req.cookies['ruralai-access-token'];
  return null;
}

export const authenticate = async (req, _res, next) => {
  try {
    const token = extractToken(req);
    if (!token) throw ApiError.unauthorized('Missing authentication token');

    const key = tokenKey(token);
    let user = cacheGet(key);

    if (!user) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data?.user) {
        throw ApiError.unauthorized('Invalid or expired session');
      }

      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id, role, full_name, is_active, preferred_language, deactivated_at')
        .eq('id', data.user.id)
        .single();

      if (profileError || !profile) {
        // An auth user with no staff profile. Never legitimate here, since
        // accounts are admin-provisioned only.
        logger.warn(
          { userId: data.user.id, requestId: req.id },
          'Authenticated user has no profile',
        );
        throw ApiError.forbidden('No staff profile is linked to this account');
      }

      if (!profile.is_active) {
        recordAuditAsync({
          action: 'permission_denied',
          actorId: profile.id,
          actorRole: profile.role,
          metadata: { reason: 'deactivated_account_attempted_access' },
          severity: 'warning',
          req,
        });
        throw ApiError.forbidden('This account has been deactivated');
      }

      user = {
        id: profile.id,
        email: data.user.email,
        role: profile.role,
        fullName: profile.full_name,
        preferredLanguage: profile.preferred_language,
      };

      cacheSet(key, user);
    }

    req.user = user;
    req.accessToken = token;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Attaches `req.user` when a valid token is present, but does not require
 * one. For endpoints that vary their response for signed-in callers.
 */
export const optionalAuthenticate = async (req, res, next) => {
  if (!extractToken(req)) return next();
  return authenticate(req, res, (err) => next(err instanceof ApiError ? null : err));
};

export default authenticate;
