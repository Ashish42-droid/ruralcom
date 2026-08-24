/**
 * End-to-end smoke test for the assessment pipeline.
 *
 * `npm run assessment:check`
 *
 * Drives the REAL stack: real Supabase, real RLS via a real login, real
 * Groq call, real persistence. This is the one test that proves the whole
 * Phase 3 -> Phase 4 path actually joins up, which no unit test can.
 *
 * Cleans up everything it creates.
 */
import { createClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '../config/supabase.js';
import env from '../config/env.js';
import { closePool } from '../config/db.js';

const PASSWORD = 'AssessmentSmoke123!';
const tag = `SMOKE-${Math.random().toString(36).slice(2, 8)}`;
const cleanup = { authUsers: [], profiles: [], patients: [], facilities: [], districts: [], states: [] };

const ins = async (table, row, cols = 'id') => {
  const { data, error } = await supabaseAdmin.from(table).insert(row).select(cols).single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
};

async function seed() {
  const state = await ins('states', { name: `${tag} State`, code: `${tag}-S` });
  cleanup.states.push(state.id);
  const district = await ins('districts', { state_id: state.id, name: `${tag} District`, code: `${tag}-D` });
  cleanup.districts.push(district.id);
  const facility = await ins('facilities', {
    district_id: district.id, name: `${tag} Facility`, type: 'village_health_centre',
  });
  cleanup.facilities.push(facility.id);

  const { data: admin } = await supabaseAdmin
    .from('profiles').select('id').eq('role', 'super_admin').limit(1).maybeSingle();
  if (!admin) throw new Error('No super_admin exists to provision the smoke-test assistant');

  const email = `${tag.toLowerCase()}@ruralai-test.invalid`;
  const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (authErr) throw new Error(`auth: ${authErr.message}`);
  cleanup.authUsers.push(authUser.user.id);

  await ins('profiles', {
    id: authUser.user.id, role: 'clinical_assistant',
    full_name: `${tag} Assistant`, created_by: admin.id,
  });
  cleanup.profiles.push(authUser.user.id);
  // clinical_assistants is keyed by profile_id, not id — the shared `ins`
  // helper's default `select('id')` would fail on it.
  await ins(
    'clinical_assistants',
    { profile_id: authUser.user.id, facility_id: facility.id },
    'profile_id',
  );

  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInErr) throw new Error(`sign in: ${signInErr.message}`);

  return { facility, accessToken: session.session.access_token };
}

async function api(path, { method = 'GET', body, accessToken } = {}) {
  const res = await fetch(`${env.API_BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error ?? json)}`);
  }
  return json.data;
}

async function teardown() {
  for (const id of cleanup.patients) await supabaseAdmin.from('patients').delete().eq('id', id);
  await supabaseAdmin.from('clinical_assistants').delete().in('profile_id', cleanup.profiles);
  for (const id of cleanup.profiles) await supabaseAdmin.from('profiles').delete().eq('id', id);
  for (const id of cleanup.authUsers) await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
  for (const id of cleanup.facilities) await supabaseAdmin.from('facilities').delete().eq('id', id);
  for (const id of cleanup.districts) await supabaseAdmin.from('districts').delete().eq('id', id);
  for (const id of cleanup.states) await supabaseAdmin.from('states').delete().eq('id', id);
}

async function main() {
  console.log(`\nAssessment pipeline smoke test — ${env.API_BASE_URL}\n`);
  let ok = true;

  try {
    process.stdout.write('Seeding facility + assistant, signing in ... ');
    const { accessToken } = await seed();
    console.log('ok');

    process.stdout.write('Registering a patient ... ');
    const patient = await api('/patients', {
      method: 'POST', accessToken,
      body: { fullName: `${tag} Patient`, ageYears: 54, sex: 'male', preferredLanguage: 'hi' },
    });
    cleanup.patients.push(patient.id);
    console.log(`ok (rhid ${patient.rhidFormatted})`);

    process.stdout.write('Opening a visit ... ');
    const visit = await api(`/patients/${patient.id}/visits`, {
      method: 'POST', accessToken, body: { chiefComplaint: 'chest pain' },
    });
    console.log('ok');

    process.stdout.write('Recording vitals ... ');
    await api(`/clinical/visits/${visit.id}/vitals`, {
      method: 'POST', accessToken,
      body: { temperatureC: 36.9, spo2: 97, systolic: 122, diastolic: 80, pulseBpm: 88 },
    });
    console.log('ok');

    process.stdout.write('Recording a symptom ... ');
    await api(`/intake/visits/${visit.id}/symptoms`, {
      method: 'POST', accessToken,
      body: {
        rawText: 'crushing chest pain radiating to the left arm for the last hour',
        language: 'en',
      },
    });
    console.log('ok');

    process.stdout.write('Running the assessment (real model call) ... ');
    const assessment = await api(`/clinical/visits/${visit.id}/assess`, {
      method: 'POST', accessToken,
    });
    console.log(`ok (${assessment.latencyMs}ms)`);
    console.log(`  ruleTier=${assessment.ruleTier}  modelTier=${assessment.modelTier}  finalTier=${assessment.finalTier}`);
    console.log(`  escalation=${assessment.escalationReason}`);
    console.log(`  ruleHits=${assessment.ruleHits.map((h) => h.code).join(', ') || '(none)'}`);
    if (assessment.differential?.length) {
      console.log(`  top differential: ${assessment.differential[0].condition}`);
    }

    if (assessment.finalTier !== 'high') {
      ok = false;
      console.log('  UNEXPECTED: crushing chest pain should land HIGH');
    }

    process.stdout.write('Reading it back with evidence ... ');
    const fetched = await api(`/clinical/assessments/${assessment.id}`, { accessToken });
    console.log(`ok (${fetched.ruleHits.length} rule hits persisted)`);

    process.stdout.write('Confirming the visit advanced ... ');
    const { data: visitRow } = await supabaseAdmin
      .from('visits').select('status, final_tier').eq('id', visit.id).single();
    console.log(`ok (status=${visitRow.status}, final_tier=${visitRow.final_tier})`);
  } catch (err) {
    ok = false;
    console.error(`\nFAILED: ${err.message}\n`);
  } finally {
    process.stdout.write('\nCleaning up ... ');
    await teardown().then(() => console.log('ok')).catch((e) => console.log(`partial: ${e.message}`));
    await closePool();
  }

  console.log(ok ? '\nAll checks passed.\n' : '\nOne or more checks failed.\n');
  process.exit(ok ? 0 : 1);
}

main();
