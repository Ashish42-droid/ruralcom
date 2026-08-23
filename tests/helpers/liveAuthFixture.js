/**
 * Fixture for tests that must exercise the REAL authentication path.
 *
 * Unlike tests/helpers/dbFixture.js, this one COMMITS. Supabase Auth issues
 * tokens over a separate connection, so it cannot see rows inside an
 * uncommitted transaction. Everything created here is torn down explicitly.
 *
 * Records are tagged `*@ruralai-test.invalid` and named "AUTHFX …" so any
 * leftovers from a crashed run are identifiable.
 */
import { createClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '../../config/supabase.js';
import env from '../../config/env.js';
import { generateRhid } from '../../utils/rhid.js';

const PASSWORD = 'AuthFixturePassword123';

/**
 * Creates two facilities in different districts, a patient in each, and a
 * clinical assistant bound to facility A — then signs that assistant in for
 * real and returns their genuine access token.
 */
export async function seedLiveAuth() {
  const tag = `AUTHFX-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${tag.toLowerCase()}@ruralai-test.invalid`;
  const cleanup = { authUsers: [], profiles: [], patients: [], facilities: [], districts: [], states: [] };

  const insert = async (table, row, columns = 'id') => {
    const { data, error } = await supabaseAdmin.from(table).insert(row).select(columns).single();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data;
  };

  const stateA = await insert('states', { name: `${tag} State A`, code: `${tag}-A` });
  const stateB = await insert('states', { name: `${tag} State B`, code: `${tag}-B` });
  cleanup.states.push(stateA.id, stateB.id);

  const distA = await insert('districts', { state_id: stateA.id, name: `${tag} Dist A`, code: `${tag}-DA` });
  const distB = await insert('districts', { state_id: stateB.id, name: `${tag} Dist B`, code: `${tag}-DB` });
  cleanup.districts.push(distA.id, distB.id);

  const facA = await insert('facilities', { district_id: distA.id, name: `${tag} Fac A`, type: 'village_health_centre' });
  const facB = await insert('facilities', { district_id: distB.id, name: `${tag} Fac B`, type: 'village_health_centre' });
  cleanup.facilities.push(facA.id, facB.id);

  const patientA = await insert('patients',
    { rhid: generateRhid(), full_name: `${tag} Patient A`, age_years: 30, facility_id: facA.id });
  const patientB = await insert('patients',
    { rhid: generateRhid(), full_name: `${tag} Patient B`, age_years: 40, facility_id: facB.id });
  cleanup.patients.push(patientA.id, patientB.id);

  // A provisioner is required unless the profiles table is empty.
  const { data: existingAdmin } = await supabaseAdmin
    .from('profiles').select('id').eq('role', 'super_admin').limit(1).maybeSingle();

  const { count } = await supabaseAdmin
    .from('profiles').select('id', { count: 'exact', head: true });

  let provisioner = existingAdmin?.id ?? null;
  if (!provisioner && count > 0) {
    throw new Error('No super_admin exists to provision the fixture assistant');
  }

  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (authError) throw new Error(`auth user: ${authError.message}`);
  cleanup.authUsers.push(authUser.user.id);

  const { error: profileError } = await supabaseAdmin.from('profiles').insert({
    id: authUser.user.id,
    role: 'clinical_assistant',
    full_name: `${tag} Assistant`,
    created_by: provisioner,
  });
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  cleanup.profiles.push(authUser.user.id);

  const { error: caError } = await supabaseAdmin.from('clinical_assistants').insert({
    profile_id: authUser.user.id,
    facility_id: facA.id,
  });
  if (caError) throw new Error(`clinical_assistant: ${caError.message}`);

  // Sign in for real — this is the whole point of the fixture.
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({
    email, password: PASSWORD,
  });
  if (signInError) throw new Error(`sign in: ${signInError.message}`);

  const accessToken = session.session.access_token;
  const [, payloadB64] = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  async function teardown() {
    for (const id of cleanup.patients) {
      await supabaseAdmin.from('patients').delete().eq('id', id);
    }
    await supabaseAdmin.from('clinical_assistants').delete().in('profile_id', cleanup.profiles);
    for (const id of cleanup.profiles) {
      await supabaseAdmin.from('profiles').delete().eq('id', id);
    }
    for (const id of cleanup.authUsers) {
      await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
    }
    for (const id of cleanup.facilities) {
      await supabaseAdmin.from('facilities').delete().eq('id', id);
    }
    for (const id of cleanup.districts) {
      await supabaseAdmin.from('districts').delete().eq('id', id);
    }
    for (const id of cleanup.states) {
      await supabaseAdmin.from('states').delete().eq('id', id);
    }
  }

  return {
    accessToken,
    claims,
    email,
    password: PASSWORD,
    profileId: authUser.user.id,
    teardown,
    ids: {
      stateA: stateA.id, stateB: stateB.id,
      distA: distA.id, distB: distB.id,
      facA: facA.id, facB: facB.id,
      patientA: patientA.id, patientB: patientB.id,
    },
  };
}

export default { seedLiveAuth };
