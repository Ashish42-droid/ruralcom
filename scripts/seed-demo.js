/**
 * Kanpur demo seed runner.
 *
 * `npm run seed:demo`      apply
 * `npm run seed:demo -- --purge`  remove everything this script created
 *
 * ALL DATA IS CLEARLY MARKED DEMO DATA — see db/seeds/kanpur-demo.js for
 * exactly what is real (the geography) and what is fabricated (every
 * person, every phone number, every facility name).
 *
 * Idempotent: re-running updates rather than duplicating, so it is safe to
 * run repeatedly while preparing a demo.
 *
 * REQUIRES `SEED_DEMO_PASSWORD` in .env. There is deliberately no default:
 * baking a weak shared password into a public repository, for accounts
 * that can read patient records, is not something to leave to chance.
 */
import { supabaseAdmin } from '../config/supabase.js';
import { closePool } from '../config/db.js';
import env from '../config/env.js';
import {
  DATA_SOURCE,
  STATE,
  DISTRICTS,
  FACILITIES,
  buildDoctors,
  buildAssistants,
  demoPhone,
} from '../db/seeds/kanpur-demo.js';

const purge = process.argv.includes('--purge');
const DOCTORS_PER_DISTRICT = 10;

const counts = { states: 0, districts: 0, facilities: 0, capacity: 0, doctors: 0, assistants: 0 };

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Upsert by a natural key, returning the row id. */
async function upsert(table, match, row, columns = 'id') {
  const { data: existing } = await supabaseAdmin
    .from(table)
    .select(columns)
    .match(match)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .update(row)
      .match(match)
      .select(columns)
      .single();
    if (error) throw new Error(`${table} update: ${error.message}`);
    return { row: data, created: false };
  }

  const { data, error } = await supabaseAdmin
    .from(table)
    .insert({ ...match, ...row })
    .select(columns)
    .single();
  if (error) throw new Error(`${table} insert: ${error.message}`);
  return { row: data, created: true };
}

async function seedGeography() {
  const { row: state } = await upsert('states', { code: STATE.code }, { name: STATE.name, data_source: DATA_SOURCE });
  counts.states += 1;

  const districtIds = new Map();
  for (const d of DISTRICTS) {
    const { row } = await upsert(
      'districts',
      { code: d.code },
      { state_id: state.id, name: d.name, data_source: DATA_SOURCE },
    );
    districtIds.set(d.code, row.id);
    counts.districts += 1;
  }

  const facilityIds = new Map();
  for (const f of FACILITIES) {
    const districtId = districtIds.get(f.district);
    const { row } = await upsert(
      'facilities',
      { name: f.name },
      {
        district_id: districtId,
        type: f.type,
        latitude: f.lat,
        longitude: f.lng,
        contact: demoPhone(900 + facilityIds.size),
        is_active: true,
        data_source: DATA_SOURCE,
      },
    );
    facilityIds.set(f.name, row.id);
    counts.facilities += 1;

    if (f.beds > 0) {
      // Roughly a third free, so referral matching has real variation to
      // work with rather than every hospital looking identical.
      const available = Math.floor(f.beds * 0.3);
      await supabaseAdmin.from('hospital_capacity').upsert(
        {
          facility_id: row.id,
          total_beds: f.beds,
          available_beds: available,
          icu_total: f.type === 'district_hospital' ? Math.floor(f.beds * 0.1) : 0,
          icu_available: f.type === 'district_hospital' ? Math.floor(f.beds * 0.03) : 0,
          has_emergency: ['district_hospital', 'chc'].includes(f.type),
          has_ambulance: f.type === 'district_hospital',
          data_source: DATA_SOURCE,
          last_updated_at: new Date().toISOString(),
        },
        { onConflict: 'facility_id' },
      );
      counts.capacity += 1;
    }
  }

  return { stateId: state.id, districtIds, facilityIds };
}

/** Creates (or finds) an auth user and its profile. */
async function ensureStaff({ email, fullName, role, phone, adminId }) {
  const { data: existingProfiles } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('full_name', fullName)
    .eq('role', role)
    .limit(1);

  if (existingProfiles?.length) return existingProfiles[0].id;

  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: env.SEED_DEMO_PASSWORD,
    email_confirm: true,
  });

  let userId = created?.user?.id;

  if (error) {
    // Already registered from a previous partial run — recover the id.
    const { data: list } = await supabaseAdmin.auth.admin.listUsers();
    userId = list?.users?.find((u) => u.email === email)?.id;
    if (!userId) throw new Error(`auth user ${email}: ${error.message}`);
  }

  const { error: profileError } = await supabaseAdmin.from('profiles').upsert(
    { id: userId, role, full_name: fullName, phone, created_by: adminId, is_active: true },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`profile ${email}: ${profileError.message}`);

  return userId;
}

async function seedStaff({ districtIds, facilityIds }) {
  const { data: admin } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('role', 'super_admin')
    .limit(1)
    .maybeSingle();

  if (!admin) {
    fail('No super_admin exists. Run the bootstrap script first — every account must be admin-provisioned.');
  }

  for (const doc of buildDoctors(DOCTORS_PER_DISTRICT)) {
    const profileId = await ensureStaff({
      email: doc.email,
      fullName: doc.fullName,
      role: 'doctor',
      phone: doc.phone,
      adminId: admin.id,
    });

    await supabaseAdmin.from('doctors').upsert(
      {
        profile_id: profileId,
        registration_no: doc.registrationNo,
        specialities: doc.specialities,
        district_id: districtIds.get(doc.districtCode),
        availability_status: doc.availabilityStatus,
        max_concurrent_cases: 1,
        data_source: DATA_SOURCE,
      },
      { onConflict: 'profile_id' },
    );
    counts.doctors += 1;
    process.stdout.write(`\r  doctors: ${counts.doctors}`);
  }
  process.stdout.write('\n');

  for (const a of buildAssistants()) {
    const profileId = await ensureStaff({
      email: a.email,
      fullName: a.fullName,
      role: 'clinical_assistant',
      phone: a.phone,
      adminId: admin.id,
    });

    await supabaseAdmin.from('clinical_assistants').upsert(
      {
        profile_id: profileId,
        certification_ref: a.certificationRef,
        facility_id: facilityIds.get(a.facilityName),
      },
      { onConflict: 'profile_id' },
    );
    counts.assistants += 1;
    process.stdout.write(`\r  assistants: ${counts.assistants}`);
  }
  process.stdout.write('\n');
}

async function purgeDemo() {
  console.log('\nPurging demo data...\n');

  // Only accounts whose auth email is on the demo domain — never a real one.
  const { data: users } = await supabaseAdmin.auth.admin.listUsers();
  const demoUsers = (users?.users ?? []).filter((u) => u.email?.endsWith('@ruralai-demo.invalid'));

  for (const u of demoUsers) {
    await supabaseAdmin.from('doctors').delete().eq('profile_id', u.id);
    await supabaseAdmin.from('clinical_assistants').delete().eq('profile_id', u.id);
    await supabaseAdmin.from('profiles').delete().eq('id', u.id);
    await supabaseAdmin.auth.admin.deleteUser(u.id).catch(() => {});
  }
  console.log(`  removed ${demoUsers.length} demo staff accounts`);

  const { data: facilities } = await supabaseAdmin
    .from('facilities')
    .select('id')
    .eq('data_source', DATA_SOURCE);

  for (const f of facilities ?? []) {
    await supabaseAdmin.from('hospital_capacity').delete().eq('facility_id', f.id);
    await supabaseAdmin.from('facilities').delete().eq('id', f.id);
  }
  console.log(`  removed ${facilities?.length ?? 0} demo facilities`);

  for (const d of DISTRICTS) {
    await supabaseAdmin.from('districts').delete().eq('code', d.code);
  }
  await supabaseAdmin.from('states').delete().eq('code', STATE.code);
  console.log('  removed demo geography');

  console.log(
    '\nNote: facilities or districts still referenced by real patient ' +
      'records are left in place — clinical data is never cascade-deleted.\n',
  );
}

async function main() {
  if (purge) {
    await purgeDemo();
    return;
  }

  if (!env.SEED_DEMO_PASSWORD) {
    fail(
      'SEED_DEMO_PASSWORD is not set in .env.\n' +
        'These accounts can read patient records, so there is deliberately no\n' +
        'default. Set a strong value, and never reuse it outside the demo.',
    );
  }

  console.log('\nSeeding Kanpur demo data (ALL ROWS MARKED PLACEHOLDER_DEMO)\n');

  const geo = await seedGeography();
  console.log(
    `  geography: ${counts.states} state, ${counts.districts} districts, ` +
      `${counts.facilities} facilities, ${counts.capacity} with bed capacity`,
  );

  await seedStaff(geo);

  console.log(`
Done.
  ${counts.doctors} doctors across ${counts.districts} districts (${DOCTORS_PER_DISTRICT} each)
  ${counts.assistants} clinical assistants, one per village health centre

  Every doctor and assistant is FICTIONAL. Registration numbers are
  DEMO-prefixed and every phone number is non-routable (+91-00000-xxxxx).
  Replace with ABDM HFR/HPR data before any real deployment.

  Log in with any seeded email and SEED_DEMO_PASSWORD, e.g.
    demo.doctor.up-knp.1@ruralai-demo.invalid
    demo.assistant.1@ruralai-demo.invalid
`);
}

try {
  await main();
} catch (err) {
  console.error(`\nSeed failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
