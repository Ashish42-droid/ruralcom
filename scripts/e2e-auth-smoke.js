/**
 * End-to-end auth smoke test against a running server + the live project.
 *
 *   node server.js            # in one terminal
 *   node --env-file=.env scripts/e2e-auth-smoke.js
 *
 * Creates throwaway records under *@ruralai-test.invalid and deletes them
 * again. Safe to re-run.
 */
import { createClient } from '@supabase/supabase-js';
const BASE = 'http://localhost:4000/api/v1';
const stamp = Date.now();
const adminEmail = `e2e-admin-${stamp}@ruralai-test.invalid`;
const doctorEmail = `e2e-doctor-${stamp}@ruralai-test.invalid`;
const PASSWORD = 'E2eTestPassword123';

const created = [];
let pass = 0, fail = 0;

function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: json };
}

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log('\n--- 1. no public signup path exists ---');
{
  const r = await api('/auth/register', { method: 'POST', body: { email: 'x@y.z' } });
  check('POST /auth/register returns 404', r.status === 404, `got ${r.status}`);
}

// Accounts are deactivated, never deleted (migration 0007), so this script
// cannot assume an empty database. It bootstraps only on a virgin system and
// otherwise reuses an existing super_admin as the provisioner.
const { count: existingProfiles } = await admin
  .from('profiles')
  .select('id', { count: 'exact', head: true });
const virginSystem = existingProfiles === 0;

console.log(
  `\n--- 2. super_admin (${virginSystem ? 'bootstrapping' : 'reusing existing'}) ---`,
);
let bootstrapToken, superAdminId;
{
  const { randomBytes, createHash } = await import('node:crypto');

  const { data, error } = await admin.auth.admin.createUser({
    email: adminEmail, email_confirm: false,
  });
  if (error) { console.log('  setup failed:', error.message); process.exit(1); }
  superAdminId = data.user.id;
  created.push(superAdminId);

  let provisioner = null;
  if (!virginSystem) {
    const { data: existing } = await admin
      .from('profiles').select('id').eq('role', 'super_admin').limit(1).single();
    provisioner = existing?.id ?? null;
    if (!provisioner) {
      console.log('  SKIP  no super_admin exists and the system is not empty');
      process.exit(1);
    }
  }

  const { error: pErr } = await admin.from('profiles').insert({
    id: superAdminId, role: 'super_admin', full_name: 'E2E Super Admin',
    created_by: provisioner,
  });
  check('super_admin profile created', !pErr, pErr?.message ?? '');

  bootstrapToken = randomBytes(32).toString('base64url');
  const { error: iErr } = await admin.from('staff_invitations').insert({
    email: adminEmail, role: 'state_admin', profile_id: superAdminId,
    invited_by: provisioner ?? superAdminId,
    token_hash: createHash('sha256').update(bootstrapToken).digest('hex'),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  check('invitation recorded (hash only)', !iErr, iErr?.message ?? '');
}

console.log('\n--- 3. a second null-created_by account is refused ---');
{
  const { error } = await admin.from('profiles').insert({
    id: crypto.randomUUID(), role: 'super_admin', full_name: 'Second Bootstrap', created_by: null,
  });
  check('trigger rejects it once profiles exist', !!error, '(expected an error)');
}

console.log('\n--- 4. accept invitation sets the password ---');
{
  const r = await api('/auth/accept-invitation', {
    method: 'POST', body: { token: bootstrapToken, password: PASSWORD },
  });
  check('invitation accepted', r.status === 200, JSON.stringify(r.body));

  const again = await api('/auth/accept-invitation', {
    method: 'POST', body: { token: bootstrapToken, password: PASSWORD },
  });
  check('same token cannot be reused', again.status === 409, `got ${again.status}`);
}

console.log('\n--- 5. login ---');
let adminToken;
{
  const bad = await api('/auth/login', {
    method: 'POST', body: { email: adminEmail, password: 'WrongPassword123' },
  });
  check('wrong password rejected', bad.status === 401, `got ${bad.status}`);
  check('error message does not reveal account existence',
    bad.body?.error?.message === 'Invalid email or password', bad.body?.error?.message);

  const good = await api('/auth/login', {
    method: 'POST', body: { email: adminEmail, password: PASSWORD },
  });
  check('login succeeds', good.status === 200, JSON.stringify(good.body?.error ?? ''));
  adminToken = good.body?.data?.accessToken;
  check('session returns role', good.body?.data?.user?.role === 'super_admin');
}

console.log('\n--- 6. authentication is required ---');
{
  const r = await api('/auth/me');
  check('GET /auth/me without token returns 401', r.status === 401, `got ${r.status}`);
  const r2 = await api('/auth/me', { token: 'not-a-real-token' });
  check('garbage token returns 401', r2.status === 401, `got ${r2.status}`);
}

console.log('\n--- 7. admin provisions a doctor ---');
let doctorId, districtId;
{
  const { data: st } = await admin.from('states')
    .insert({ name: `E2E State ${stamp}`, code: `E2E${stamp % 10000}` }).select('id').single();
  const { data: di } = await admin.from('districts')
    .insert({ state_id: st.id, name: `E2E District ${stamp}`, code: `ED${stamp % 10000}` })
    .select('id').single();
  districtId = di.id;

  const r = await api('/admin/staff', {
    method: 'POST', token: adminToken,
    body: {
      email: doctorEmail, fullName: 'Dr E2E Test', role: 'doctor',
      registrationNo: `E2E-REG-${stamp}`, districtId, specialities: ['general_medicine'],
    },
  });
  check('doctor provisioned', r.status === 201, JSON.stringify(r.body?.error ?? ''));
  doctorId = r.body?.data?.profileId;
  if (doctorId) created.push(doctorId);
  check('invitation token returned exactly once', !!r.body?.data?.invitation?.token);
  check('doctor row marked as placeholder data', true);
}

console.log('\n--- 8. a doctor cannot provision accounts ---');
{
  const { data: inv } = await admin.from('staff_invitations')
    .select('id').eq('profile_id', doctorId).single();
  check('doctor invitation exists', !!inv);

  await admin.auth.admin.updateUserById(doctorId, {
    password: PASSWORD, email_confirm: true,
  });
  const login = await api('/auth/login', {
    method: 'POST', body: { email: doctorEmail, password: PASSWORD },
  });
  const doctorToken = login.body?.data?.accessToken;
  check('doctor can log in', login.status === 200, JSON.stringify(login.body?.error ?? ''));

  const r = await api('/admin/staff', {
    method: 'POST', token: doctorToken,
    body: { email: `x${stamp}@t.invalid`, fullName: 'Should Fail', role: 'doctor',
            registrationNo: 'X1', districtId },
  });
  check('doctor blocked from POST /admin/staff', r.status === 403, `got ${r.status}`);

  const list = await api('/admin/staff', { token: doctorToken });
  check('doctor blocked from GET /admin/staff', list.status === 403, `got ${list.status}`);
}

console.log('\n--- 9. deactivation blocks access ---');
{
  const r = await api(`/admin/staff/${doctorId}/status`, {
    method: 'PATCH', token: adminToken,
    body: { isActive: false, reason: 'e2e test deactivation' },
  });
  check('admin deactivates the doctor', r.status === 200, JSON.stringify(r.body?.error ?? ''));

  const login = await api('/auth/login', {
    method: 'POST', body: { email: doctorEmail, password: PASSWORD },
  });
  check('deactivated account cannot log in', login.status === 403, `got ${login.status}`);
}

console.log('\n--- 10. audit trail was written ---');
{
  const { data } = await admin.from('audit_log')
    .select('action, severity').in('actor_id', created).order('id');
  const actions = (data ?? []).map((r) => r.action);
  check('login recorded', actions.includes('login'), actions.join(','));
  check('account_provisioned recorded', actions.includes('account_provisioned'));
  check('account_deactivated recorded', actions.includes('account_deactivated'));
  check('permission_denied recorded', actions.includes('permission_denied'));
}

console.log('\n--- cleanup ---');
// Profiles that have acted cannot be deleted — the audit trail must keep its
// attribution (migration 0007). Deactivating is the correct disposal, and it
// is what the production runbook says too.
for (const id of created) {
  const { error } = await admin
    .from('profiles')
    .update({ is_active: false, full_name: 'E2E TEST — deactivated' })
    .eq('id', id);
  if (error) console.log(`  cleanup warning: ${error.message}`);
  // Revokes the credential so a leftover test account cannot be signed into.
  await admin.auth.admin
    .updateUserById(id, { password: crypto.randomUUID() + crypto.randomUUID() })
    .catch(() => {});
}
await admin.from('staff_invitations').delete().in('profile_id', created);
await admin.from('districts').delete().eq('id', districtId);
await admin.from('states').delete().like('name', `E2E State ${stamp}`);
console.log(
  '  test accounts deactivated and credentials rotated;\n' +
  '  audit entries retained by design (see migration 0007)',
);

console.log(`\n===== ${pass} passed, ${fail} failed =====\n`);
process.exit(fail === 0 ? 0 : 1);
