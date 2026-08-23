/**
 * Verifies that the custom access token hook is enabled.
 *
 *   node --env-file=.env scripts/check-jwt-claims.js <email> <password>
 *
 * Without the hook (Supabase dashboard → Authentication → Hooks → Customize
 * Access Token), JWTs carry no `app_role` claim, every role-checking RLS
 * policy evaluates to null and DENIES, and a perfectly valid login can read
 * nothing at all. It presents as a broken database; it is a missing checkbox.
 *
 * This script tells you in one second which of the two it is.
 */
import { createClient } from '@supabase/supabase-js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node --env-file=.env scripts/check-jwt-claims.js <email> <password>');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if (error) {
  console.error(`Login failed: ${error.message}`);
  process.exit(1);
}

const [, payload] = data.session.access_token.split('.');
const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

const required = ['app_role'];
const optional = ['facility_id', 'district_id', 'state_id', 'account_active'];

console.log('\nJWT claims\n' + '-'.repeat(48));
for (const key of [...required, ...optional]) {
  const present = key in claims;
  const value = present ? JSON.stringify(claims[key]) : '(absent)';
  console.log(`  ${present ? 'OK  ' : 'MISS'}  ${key.padEnd(16)} ${value}`);
}
console.log('-'.repeat(48));

const hookWorking = 'app_role' in claims && claims.app_role !== null;

if (hookWorking) {
  console.log(`\nAccess token hook is ENABLED. Role-based RLS will work.\n`);
} else {
  console.log(
    `\nAccess token hook is NOT enabled (or the user has no profile).\n\n` +
      `Fix: Supabase dashboard -> Authentication -> Hooks ->\n` +
      `     "Customize Access Token (JWT) Claims" ->\n` +
      `     select public.custom_access_token_hook\n\n` +
      `Until then every role-scoped query returns zero rows.\n`,
  );
}

await supabase.auth.signOut();
process.exit(hookWorking ? 0 : 1);
