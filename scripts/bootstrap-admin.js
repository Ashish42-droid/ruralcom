/**
 * One-time bootstrap of the super_admin account.
 *
 *   node scripts/bootstrap-admin.js --email you@example.com
 *
 * This is the only account that is not provisioned by another admin — the
 * `profiles_enforce_provisioning` trigger permits a null `created_by` only
 * when the profiles table is empty, and only for role `super_admin`.
 *
 * The password is NOT set here. The script prints a single-use invitation
 * token; you set your own password through the accept-invitation endpoint,
 * so the credential never appears in a shell history or a log.
 */
import { randomBytes, createHash } from 'node:crypto';

import { supabaseAdmin } from '../config/supabase.js';
import { closePool } from '../config/db.js';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : null;
const nameIndex = args.indexOf('--name');
const fullName = nameIndex >= 0 ? args[nameIndex + 1] : 'RuralAI Super Admin';

if (!email) {
  console.error('Usage: node scripts/bootstrap-admin.js --email <email> [--name "Full Name"]');
  process.exit(1);
}

const { count } = await supabaseAdmin
  .from('profiles')
  .select('id', { count: 'exact', head: true });

if (count > 0) {
  console.error(
    `\nRefusing to run: ${count} profile(s) already exist.\n` +
      `The bootstrap account can only be created on an empty system.\n` +
      `Use an existing admin to provision further accounts.\n`,
  );
  await closePool();
  process.exit(1);
}

const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
  email,
  email_confirm: false,
  user_metadata: { full_name: fullName, bootstrap: true },
});

if (authError) {
  console.error(`Could not create auth user: ${authError.message}`);
  await closePool();
  process.exit(1);
}

const userId = authUser.user.id;

const { error: profileError } = await supabaseAdmin.from('profiles').insert({
  id: userId,
  role: 'super_admin',
  full_name: fullName,
  created_by: null, // permitted only for the bootstrap account
  is_active: true,
});

if (profileError) {
  console.error(`Could not create profile: ${profileError.message}`);
  await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
  await closePool();
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const expiresAt = new Date(Date.now() + 72 * 3600_000);

const { error: inviteError } = await supabaseAdmin.from('staff_invitations').insert({
  email,
  // The invitation table rejects super_admin, so the bootstrap invite is
  // recorded as state_admin purely for bookkeeping. The profile role above
  // is what actually governs access.
  role: 'state_admin',
  profile_id: userId,
  invited_by: userId,
  token_hash: tokenHash,
  expires_at: expiresAt.toISOString(),
});

if (inviteError) {
  console.error(`Could not create invitation: ${inviteError.message}`);
  await closePool();
  process.exit(1);
}

console.log(`
Super admin bootstrapped.

  email       ${email}
  profile id  ${userId}
  expires     ${expiresAt.toISOString()}

Set your password by POSTing to /api/v1/auth/accept-invitation:

  { "token": "${token}", "password": "<your password>" }

This token is shown once and is not recoverable. Enable MFA on this account
before the demo — a super_admin without MFA is the whole system's single
point of failure.
`);

await closePool();
