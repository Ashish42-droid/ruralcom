/**
 * Consultations and the doctor review loop — enforced at the database.
 *
 * The assertions that matter most here encode spec rules as constraints
 * rather than intentions: one active call per doctor, and a flag-back that
 * cannot exist without an explanation.
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;
let visitA;
let assessmentA;
let doctorA;
let doctorB;

beforeAll(async () => {
  fx = await seedTwoFacilities('CONS');

  const one = async (sql, params) => (await fx.asOwner(sql, params)).rows[0];

  const { rows: adminRows } = await fx.asOwner(
    `select id from profiles where role = 'super_admin' limit 1`,
  );
  const adminId = adminRows[0].id;

  const mkDoctor = async (label, districtId) => {
    const user = await one(
      `insert into auth.users (id, email, instance_id, aud, role)
       values (gen_random_uuid(), $1, '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated')
       returning id`,
      [`cons-${label}-${Math.random().toString(36).slice(2, 8)}@t.invalid`],
    );
    await one(
      `insert into profiles (id, role, full_name, created_by)
       values ($1, 'doctor', $2, $3) returning id`,
      [user.id, `Doctor ${label}`, adminId],
    );
    await fx.asOwner(
      `insert into doctors (profile_id, registration_no, district_id, availability_status)
       values ($1, $2, $3, 'available')`,
      [user.id, `REG-${label}-${Math.random().toString(36).slice(2, 8)}`, districtId],
    );
    return user.id;
  };

  doctorA = await mkDoctor('A', fx.ids.distA);
  doctorB = await mkDoctor('B', fx.ids.distA);

  visitA = (
    await one(
      `insert into visits (patient_id, facility_id, status)
       values ($1, $2, 'open') returning id`,
      [fx.ids.patientA, fx.ids.facA],
    )
  ).id;

  assessmentA = (
    await one(
      `insert into ai_assessments
         (visit_id, patient_id, rule_tier, final_tier, escalation_reason, ruleset_version)
       values ($1, $2, 'low', 'low', 'model_and_rules_agree', 'test-1')
       returning id`,
      [visitA, fx.ids.patientA],
    )
  ).id;
}, 90_000);

/**
 * The shared fixture releases savepoints on success, so a successful write
 * persists for the rest of the FILE. These tests each assume a clean slate
 * (notably the one-active-call-per-doctor index), so clear the tables they
 * write to between cases.
 */
beforeEach(async () => {
  await fx.asOwner('delete from doctor_reviews where visit_id = $1', [visitA]);
  await fx.asOwner('delete from consultations where visit_id = $1', [visitA]);
});

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();

describe('one active call per doctor', () => {
  it('allows a first ringing consultation', async () => {
    const res = await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4) returning id`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );
    expect(res.rowCount).toBe(1);
  });

  it('REJECTS a second in-progress call for the same doctor', async () => {
    await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4)`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );

    // UI state and application checks both race under load; the partial
    // unique index cannot.
    await expect(
      fx.asOwner(
        `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
         values ($1, $2, $3, 'active', $4)`,
        [visitA, fx.ids.patientA, doctorA, future()],
      ),
    ).rejects.toThrow(/consultations_one_active_per_doctor/);
  });

  it('allows a completed call alongside an active one', async () => {
    await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4)`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );
    const res = await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'completed', $4) returning id`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );
    expect(res.rowCount).toBe(1);
  });

  it('allows two different doctors to be busy at once', async () => {
    await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4)`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );
    const res = await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4) returning id`,
      [visitA, fx.ids.patientA, doctorB, future()],
    );
    expect(res.rowCount).toBe(1);
  });
});

describe('the tolerance window is coherent', () => {
  it('rejects a window that expires before it starts', async () => {
    await expect(
      fx.asOwner(
        `insert into consultations
           (visit_id, patient_id, doctor_id, status, scheduled_at, tolerance_expires_at)
         values ($1, $2, $3, 'scheduled', now(), now() - interval '1 minute')`,
        [visitA, fx.ids.patientA, doctorA],
      ),
    ).rejects.toThrow(/tolerance_after_scheduled/);
  });
});

describe('a flag-back must explain itself', () => {
  it.each([
    ['no note at all', null],
    ['a blank note', '   '],
  ])('rejects flag_to_assistant with %s', async (_label, note) => {
    // An unexplained flag cannot be acted on by the assistant, so the
    // database refuses to store one.
    await expect(
      fx.asOwner(
        `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action, clinical_note)
         values ($1, $2, $3, 'flag_to_assistant', $4)`,
        [assessmentA, visitA, doctorA, note],
      ),
    ).rejects.toThrow(/flag_requires_note/);
  });

  it('accepts a flag with a real note', async () => {
    const res = await fx.asOwner(
      `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action, clinical_note)
       values ($1, $2, $3, 'flag_to_assistant', 'Re-check the BP, it looks transposed')
       returning id`,
      [assessmentA, visitA, doctorA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('accepts approve without a note, since only a flag needs one', async () => {
    const res = await fx.asOwner(
      `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action)
       values ($1, $2, $3, 'approve') returning id`,
      [assessmentA, visitA, doctorA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('allows only one review per assessment', async () => {
    await fx.asOwner(
      `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action)
       values ($1, $2, $3, 'approve')`,
      [assessmentA, visitA, doctorA],
    );
    await expect(
      fx.asOwner(
        `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action)
         values ($1, $2, $3, 'refer')`,
        [assessmentA, visitA, doctorB],
      ),
    ).rejects.toThrow(/doctor_reviews_one_per_assessment/);
  });
});

describe('review authorship cannot be forged', () => {
  it('an assistant cannot author a review', async () => {
    await expect(
      fx.as(
        { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
        `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action)
         values ($1, $2, $3, 'approve')`,
        [assessmentA, visitA, doctorA],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a doctor cannot attribute a review to a different doctor', async () => {
    await expect(
      fx.as(
        { app_role: 'doctor', district_id: fx.ids.distA, sub: doctorA },
        `insert into doctor_reviews (assessment_id, visit_id, doctor_id, action)
         values ($1, $2, $3, 'approve')`,
        [assessmentA, visitA, doctorB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('review content is immutable; only acknowledgement moves', () => {
  it('authenticated cannot update the clinical note', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'doctor_reviews' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name).sort();
    expect(updatable).toEqual(['assistant_acknowledged_at', 'assistant_acknowledged_by']);
    expect(updatable).not.toContain('clinical_note');
    expect(updatable).not.toContain('action');
  });

  it('a doctor cannot change the assignment or tolerance window of a consultation', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'consultations' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name).sort();
    expect(updatable).toEqual(['ended_at', 'joined_at', 'status']);
    expect(updatable).not.toContain('doctor_id');
    expect(updatable).not.toContain('tolerance_expires_at');
  });

  it('clients cannot INSERT a consultation — scheduling is server-owned', async () => {
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'consultations' and grantee = 'authenticated'
         and privilege_type = 'INSERT'`,
    );
    expect(rows).toHaveLength(0);
  });

  it.each(['consultations', 'doctor_reviews'])(
    'authenticated cannot DELETE %s',
    async (table) => {
      const { rows } = await pool.query(
        `select 1 from information_schema.role_table_grants
         where table_name = $1 and grantee = 'authenticated'
           and privilege_type = 'DELETE'`,
        [table],
      );
      expect(rows).toHaveLength(0);
    },
  );
});

describe('consultation visibility', () => {
  it('a doctor sees a consultation assigned to them', async () => {
    const { rows } = await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4) returning id`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );

    const res = await fx.as(
      { app_role: 'doctor', district_id: fx.ids.distA, sub: doctorA },
      'select id from consultations where id = $1',
      [rows[0].id],
    );
    expect(res.rowCount).toBe(1);
  });

  it('an assistant at another facility sees none', async () => {
    await fx.asOwner(
      `insert into consultations (visit_id, patient_id, doctor_id, status, tolerance_expires_at)
       values ($1, $2, $3, 'ringing', $4)`,
      [visitA, fx.ids.patientA, doctorA, future()],
    );

    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select id from consultations where visit_id = $1',
      [visitA],
    );
    expect(res.rowCount).toBe(0);
  });
});

describe('every new table has RLS', () => {
  it.each(['consultations', 'doctor_reviews'])(
    '%s has RLS enabled and at least one policy',
    async (table) => {
      const { rows: rls } = await pool.query(
        `select relrowsecurity from pg_class
         where relnamespace = 'public'::regnamespace and relname = $1`,
        [table],
      );
      expect(rls[0].relrowsecurity).toBe(true);

      const { rows: policies } = await pool.query(
        `select policyname from pg_policies where tablename = $1`,
        [table],
      );
      expect(policies.length).toBeGreaterThan(0);
    },
  );
});
