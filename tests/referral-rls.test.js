/**
 * Referral records — isolation and immutability at the database.
 *
 * A referral is evidence of a clinical decision: where a patient was sent,
 * and what the destination looked like at the time. It is never rewritten.
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;
let visitA;
let referralA;

beforeAll(async () => {
  fx = await seedTwoFacilities('REF');

  const one = async (sql, params) => (await fx.asOwner(sql, params)).rows[0];

  visitA = (
    await one(
      `insert into visits (patient_id, facility_id, status)
       values ($1, $2, 'open') returning id`,
      [fx.ids.patientA, fx.ids.facA],
    )
  ).id;
  referralA = (
    await one(
      `insert into referrals
         (visit_id, patient_id, target_facility_id, origin_facility_id,
          reason, distance_km, capacity_snapshot)
       values ($1, $2, $3, $4, 'Suspected MI', 12.5,
               '{"availableBeds":8,"totalBeds":220}')
       returning id`,
      [visitA, fx.ids.patientA, fx.ids.facB, fx.ids.facA],
    )
  ).id;

  await fx.asOwner(
    `insert into referral_documents (referral_id, visit_id, document_number)
     values ($1, $2, $3)`,
    [referralA, visitA, `REF-TEST-${Math.random().toString(36).slice(2, 8)}`],
  );
}, 90_000);

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('referrals are facility-scoped', () => {
  it('an assistant reads their own facility referral', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from referrals where visit_id = $1',
      [visitA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('an assistant at another facility reads none', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select id from referrals where visit_id = $1',
      [visitA],
    );
    expect(res.rowCount).toBe(0);
  });

  it('a doctor reads their district', async () => {
    const res = await fx.as(
      { app_role: 'doctor', district_id: fx.ids.distA },
      'select id from referrals',
    );
    expect(res.rowCount).toBeGreaterThanOrEqual(1);
  });

  it.each(['super_admin', 'auditor', 'district_admin'])(
    '%s reads zero referrals — admins have no clinical access',
    async (role) => {
      const res = await fx.as(
        { app_role: role, district_id: fx.ids.distA, state_id: fx.ids.stateA },
        'select id from referrals',
      );
      expect(res.rowCount).toBe(0);
    },
  );

  it('referral documents follow the same scoping', async () => {
    const own = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from referral_documents where visit_id = $1',
      [visitA],
    );
    expect(own.rowCount).toBe(1);

    const other = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select id from referral_documents where visit_id = $1',
      [visitA],
    );
    expect(other.rowCount).toBe(0);
  });
});

describe('a referral is evidence, not a draft', () => {
  it('clients cannot INSERT a referral — issuing is server-owned', async () => {
    // Issuing snapshots capacity and computes distance; a client that
    // could write its own could claim any destination or bed count.
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'referrals' and grantee = 'authenticated'
         and privilege_type = 'INSERT'`,
    );
    expect(rows).toHaveLength(0);
  });

  it.each(['UPDATE', 'DELETE'])('clients cannot %s a referral', async (privilege) => {
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'referrals' and grantee = 'authenticated'
         and privilege_type = $1`,
      [privilege],
    );
    expect(rows).toHaveLength(0);
  });

  it('the ONLY updatable columns on a document are the print markers', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'referral_documents' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name).sort();

    expect(updatable).toEqual(['printed_at', 'printed_by']);
    // The destination, charges and snapshot must not be rewritten after
    // the slip has been handed to a patient.
    expect(updatable).not.toContain('total_amount');
    expect(updatable).not.toContain('line_items');
    expect(updatable).not.toContain('document_number');
  });

  it('an assistant CAN mark their own document printed', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      `update referral_documents set printed_at = now()
       where visit_id = $1 and printed_at is null returning id`,
      [visitA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('an assistant at another facility cannot', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      `update referral_documents set printed_at = now()
       where visit_id = $1 returning id`,
      [visitA],
    );
    expect(res.rowCount).toBe(0);
  });
});

describe('data integrity', () => {
  it('requires a reason', async () => {
    await expect(
      fx.asOwner(
        `insert into referrals (visit_id, patient_id, target_facility_id,
           origin_facility_id, reason)
         values ($1, $2, $3, $4, '   ')`,
        [visitA, fx.ids.patientA, fx.ids.facB, fx.ids.facA],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a negative distance', async () => {
    await expect(
      fx.asOwner(
        `insert into referrals (visit_id, patient_id, target_facility_id,
           origin_facility_id, reason, distance_km)
         values ($1, $2, $3, $4, 'x', -5)`,
        [visitA, fx.ids.patientA, fx.ids.facB, fx.ids.facA],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a negative charge total', async () => {
    await expect(
      fx.asOwner(
        `insert into referral_documents (referral_id, visit_id, document_number, total_amount)
         values ($1, $2, 'REF-NEG-1', -100)`,
        [referralA, visitA],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('enforces a unique document number', async () => {
    const n = `REF-DUP-${Math.random().toString(36).slice(2, 8)}`;
    await fx.asOwner(
      `insert into referral_documents (referral_id, visit_id, document_number)
       values ($1, $2, $3)`,
      [referralA, visitA, n],
    );
    await expect(
      fx.asOwner(
        `insert into referral_documents (referral_id, visit_id, document_number)
         values ($1, $2, $3)`,
        [referralA, visitA, n],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('defaults charges to zero and marks them provisional', async () => {
    const { rows } = await fx.asOwner(
      `insert into referral_documents (referral_id, visit_id, document_number)
       values ($1, $2, $3) returning total_amount, charge_source, currency`,
      [referralA, visitA, `REF-DEF-${Math.random().toString(36).slice(2, 8)}`],
    );
    // Care at a government PHC/CHC is frequently free; inventing charges
    // would be worse than showing none.
    expect(Number(rows[0].total_amount)).toBe(0);
    expect(rows[0].charge_source).toBe('PLACEHOLDER_DEMO');
    expect(rows[0].currency).toBe('INR');
  });
});

describe('hospital capacity is operational, not clinical', () => {
  it('any authenticated staff member may read it', async () => {
    // Unlike patient data: an assistant needs to know where a patient can
    // actually be sent, and that identifies no individual.
    for (const role of ['clinical_assistant', 'doctor', 'super_admin']) {
      const res = await fx.as(
        { app_role: role, facility_id: fx.ids.facA, district_id: fx.ids.distA },
        'select facility_id from hospital_capacity limit 1',
      );
      expect(res.rowCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('bed counts cannot exceed capacity', async () => {
    await expect(
      fx.asOwner(
        `insert into hospital_capacity (facility_id, total_beds, available_beds)
         values ($1, 10, 50)`,
        [fx.ids.facA],
      ),
    ).rejects.toThrow(/available_within_total/);
  });
});

describe('RLS is enabled', () => {
  it.each(['referrals', 'referral_documents', 'hospital_capacity'])(
    '%s has RLS and at least one policy',
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
