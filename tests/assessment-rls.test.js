/**
 * Vitals and assessment persistence — isolation and safety invariants,
 * verified at the database level.
 *
 * The most important assertions here are not about reading: they are that a
 * CLIENT CANNOT AUTHOR AN ASSESSMENT, and that the monotonic-escalation
 * invariant is enforced by Postgres rather than only by application code.
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;
let visitA;
let visitB;
let assessmentA;

beforeAll(async () => {
  fx = await seedTwoFacilities('ASMT');

  const mkVisit = async (patientId, facilityId) => {
    const { rows } = await fx.asOwner(
      `insert into visits (patient_id, facility_id, status)
       values ($1, $2, 'open') returning id`,
      [patientId, facilityId],
    );
    return rows[0].id;
  };

  visitA = await mkVisit(fx.ids.patientA, fx.ids.facA);
  visitB = await mkVisit(fx.ids.patientB, fx.ids.facB);

  await fx.asOwner(
    `insert into vitals (visit_id, patient_id, spo2, pulse_bpm, temperature_c)
     values ($1, $2, 97, 72, 36.8)`,
    [visitA, fx.ids.patientA],
  );
  await fx.asOwner(
    `insert into vitals (visit_id, patient_id, spo2, pulse_bpm)
     values ($1, $2, 88, 120)`,
    [visitB, fx.ids.patientB],
  );

  const { rows } = await fx.asOwner(
    `insert into ai_assessments
       (visit_id, patient_id, rule_tier, model_tier, final_tier,
        escalation_reason, ruleset_version)
     values ($1, $2, 'high', 'low', 'high', 'rule_floor_overrode_model', 'test-1')
     returning id`,
    [visitA, fx.ids.patientA],
  );
  assessmentA = rows[0].id;

  await fx.asOwner(
    `insert into triage_rule_hits (assessment_id, code, tier, source, detail)
     values ($1, 'spo2_critical', 'high', 'NEWS2', '{"value":85,"threshold":92}')`,
    [assessmentA],
  );
}, 90_000);

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('vitals are facility-scoped', () => {
  it('an assistant reads their own facility vitals', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from vitals',
    );
    expect(res.rowCount).toBe(1);
  });

  it('an assistant reads ZERO vitals from another facility', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from vitals where visit_id = $1',
      [visitB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('a doctor reads their district', async () => {
    const res = await fx.as(
      { app_role: 'doctor', district_id: fx.ids.distA },
      'select id from vitals',
    );
    expect(res.rowCount).toBe(1);
  });

  it.each(['super_admin', 'state_admin', 'district_admin', 'auditor'])(
    '%s reads zero vitals',
    async (role) => {
      const res = await fx.as(
        { app_role: role, district_id: fx.ids.distA, state_id: fx.ids.stateA },
        'select id from vitals',
      );
      expect(res.rowCount).toBe(0);
    },
  );

  it('cannot record vitals against another facility visit', async () => {
    await expect(
      fx.as(
        { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
        `insert into vitals (visit_id, patient_id, spo2) values ($1, $2, 95)`,
        [visitB, fx.ids.patientB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('a client cannot author an assessment', () => {
  it.each(['clinical_assistant', 'doctor', 'senior_doctor'])(
    '%s has no INSERT path into ai_assessments',
    async (role) => {
      // The whole safety model depends on this: a client able to write its
      // own assessment could record LOW for a patient the rules escalate.
      await expect(
        fx.as(
          { app_role: role, facility_id: fx.ids.facA, district_id: fx.ids.distA },
          `insert into ai_assessments
             (visit_id, patient_id, rule_tier, final_tier, escalation_reason, ruleset_version)
           values ($1, $2, 'low', 'low', 'forged', 'x')`,
          [visitA, fx.ids.patientA],
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    },
  );

  it('authenticated holds no INSERT grant on ai_assessments', async () => {
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'ai_assessments' and grantee = 'authenticated'
         and privilege_type = 'INSERT'`,
    );
    expect(rows).toHaveLength(0);
  });

  it.each(['ai_assessments', 'triage_rule_hits', 'ai_recommendations', 'vitals'])(
    'authenticated cannot UPDATE or DELETE %s',
    async (table) => {
      const { rows } = await pool.query(
        `select privilege_type from information_schema.role_table_grants
         where table_name = $1 and grantee = 'authenticated'
           and privilege_type in ('UPDATE','DELETE')`,
        [table],
      );
      expect(rows).toHaveLength(0);
    },
  );
});

describe('the monotonic-escalation invariant is enforced by the DATABASE', () => {
  it('rejects a final tier BELOW the rule floor', async () => {
    // Even a service-role write or direct SQL cannot record a de-escalation.
    await expect(
      fx.asOwner(
        `insert into ai_assessments
           (visit_id, patient_id, rule_tier, model_tier, final_tier,
            escalation_reason, ruleset_version)
         values ($1, $2, 'high', 'low', 'low', 'malicious', 'x')`,
        [visitA, fx.ids.patientA],
      ),
    ).rejects.toThrow(/assessment_final_at_least_rule/);
  });

  it('rejects a final tier below the MODEL tier', async () => {
    await expect(
      fx.asOwner(
        `insert into ai_assessments
           (visit_id, patient_id, rule_tier, model_tier, final_tier,
            escalation_reason, ruleset_version)
         values ($1, $2, 'low', 'high', 'low', 'malicious', 'x')`,
        [visitA, fx.ids.patientA],
      ),
    ).rejects.toThrow(/assessment_final_at_least_model/);
  });

  it('accepts a legitimate escalation', async () => {
    const res = await fx.asOwner(
      `insert into ai_assessments
         (visit_id, patient_id, rule_tier, model_tier, final_tier,
          escalation_reason, ruleset_version)
       values ($1, $2, 'medium', 'low', 'medium', 'rule_floor_overrode_model', 'x')
       returning id`,
      [visitA, fx.ids.patientA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('allows a null model tier (the model failed) without weakening the floor', async () => {
    const res = await fx.asOwner(
      `insert into ai_assessments
         (visit_id, patient_id, rule_tier, model_tier, final_tier,
          escalation_reason, ruleset_version)
       values ($1, $2, 'medium', null, 'medium', 'model_unavailable:timeout', 'x')
       returning id`,
      [visitA, fx.ids.patientA],
    );
    expect(res.rowCount).toBe(1);
  });
});

describe('medication can never be stored without citing its source', () => {
  it('rejects a medication recommendation with no rule_source_id', async () => {
    // Medicine comes from the clinician-signed formulary via a rules
    // engine. A row that cannot name its source is a bug, and the database
    // makes it structurally impossible to store.
    await expect(
      fx.asOwner(
        `insert into ai_recommendations (assessment_id, type, content)
         values ($1, 'medication', 'Paracetamol 500mg')`,
        [assessmentA],
      ),
    ).rejects.toThrow(/medication_must_cite_source/);
  });

  it('accepts a medication that cites its formulary entry', async () => {
    const res = await fx.asOwner(
      `insert into ai_recommendations (assessment_id, type, content, rule_source_id)
       values ($1, 'medication', 'Paracetamol 500mg', 'formulary-001') returning id`,
      [assessmentA],
    );
    expect(res.rowCount).toBe(1);
  });

  it.each(['first_aid', 'precaution', 'diet'])(
    'accepts %s without a source, since only medicine needs one',
    async (type) => {
      const res = await fx.asOwner(
        `insert into ai_recommendations (assessment_id, type, content)
         values ($1, $2, 'Some guidance') returning id`,
        [assessmentA, type],
      );
      expect(res.rowCount).toBe(1);
    },
  );
});

describe('assessments and their evidence are readable by the right people', () => {
  it('an assistant reads assessments for their facility', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from ai_assessments where visit_id = $1',
      [visitA],
    );
    expect(res.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('an assistant at another facility reads none', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select id from ai_assessments where visit_id = $1',
      [visitA],
    );
    expect(res.rowCount).toBe(0);
  });

  it('rule hits are readable and carry the value and threshold that fired', async () => {
    const res = await fx.as(
      { app_role: 'doctor', district_id: fx.ids.distA },
      `select code, tier, source, detail from triage_rule_hits where assessment_id = $1`,
      [assessmentA],
    );
    expect(res.rowCount).toBe(1);
    // "Why did it say HIGH?" must have a precise answer.
    expect(res.rows[0]).toMatchObject({ code: 'spo2_critical', tier: 'high', source: 'NEWS2' });
    expect(res.rows[0].detail).toMatchObject({ value: 85, threshold: 92 });
  });

  it('rule hits are NOT readable across facilities', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select id from triage_rule_hits where assessment_id = $1',
      [assessmentA],
    );
    expect(res.rowCount).toBe(0);
  });

  it.each(['super_admin', 'auditor'])('%s reads zero assessments', async (role) => {
    const res = await fx.as(
      { app_role: role, district_id: fx.ids.distA, state_id: fx.ids.stateA },
      'select id from ai_assessments',
    );
    expect(res.rowCount).toBe(0);
  });
});

describe('vitals plausibility is enforced by the database, not only the API', () => {
  it('rejects transposed blood pressure', async () => {
    await expect(
      fx.asOwner(
        `insert into vitals (visit_id, patient_id, systolic, diastolic)
         values ($1, $2, 70, 120)`,
        [visitA, fx.ids.patientA],
      ),
    ).rejects.toThrow(/vitals_bp_ordered/);
  });

  it('rejects a row with no measurements at all', async () => {
    await expect(
      fx.asOwner(`insert into vitals (visit_id, patient_id) values ($1, $2)`, [
        visitA,
        fx.ids.patientA,
      ]),
    ).rejects.toThrow(/vitals_not_empty/);
  });

  it.each([
    ['SpO2 above 100', 'spo2', 130],
    ['an impossible temperature', 'temperature_c', 60],
    ['an impossible pulse', 'pulse_bpm', 500],
  ])('rejects %s', async (_label, column, value) => {
    await expect(
      fx.asOwner(
        `insert into vitals (visit_id, patient_id, ${column}) values ($1, $2, $3)`,
        [visitA, fx.ids.patientA, value],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('accepts a partial set — equipment availability varies by facility', async () => {
    const res = await fx.asOwner(
      `insert into vitals (visit_id, patient_id, temperature_c) values ($1, $2, 37.2) returning id`,
      [visitA, fx.ids.patientA],
    );
    expect(res.rowCount).toBe(1);
  });
});

describe('every new table has RLS', () => {
  it.each(['vitals', 'ai_assessments', 'triage_rule_hits', 'ai_recommendations'])(
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
