/**
 * Supabase clients.
 *
 * THE RULE (SYSTEM_ARCHITECTURE.md §Security):
 *   - `supabaseAsUser(jwt)`  -> anon key + the caller's JWT. Row-level
 *     security applies. This is the DEFAULT for anything acting on behalf of
 *     a logged-in user.
 *   - `supabaseAdmin`        -> service-role key. BYPASSES ALL RLS. Only for
 *     trusted server-side computation (assessment results, tier assignment,
 *     admin provisioning, audit writes). Every call site must have an explicit
 *     authorisation check AND write an audit-log row.
 *
 * If you are reaching for `supabaseAdmin` to "just make the query work",
 * that is the bug. Use `supabaseAsUser` and fix the policy instead.
 */
import { createClient } from '@supabase/supabase-js';
import env from './env.js';

const commonOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
};

/**
 * Service-role client. Bypasses row-level security.
 * Guarded usage only — see the rule above.
 */
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  commonOptions,
);

/**
 * Client scoped to a caller's JWT. All queries are subject to RLS.
 * @param {string} accessToken - the user's Supabase access token
 */
export function supabaseAsUser(accessToken) {
  if (!accessToken) {
    throw new Error('supabaseAsUser requires an access token');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...commonOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Anonymous client. Pre-auth flows only (e.g. password reset). */
export const supabaseAnon = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  commonOptions,
);

/** Liveness probe used by the health endpoint. */
export async function pingSupabase() {
  const started = Date.now();
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/health`, {
    headers: { apikey: env.SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Supabase auth health returned ${res.status}`);
  }
  const body = await res.json();
  return { ok: true, latencyMs: Date.now() - started, version: body.version };
}
