/**
 * Patient-data isolation, verified at the database level.
 *
 * These prove the property the whole system rests on: a clinical assistant
 * at one facility physically cannot read another facility's patients, and no
 * admin can read or write clinical data at all.
 *
 * Seeded ONCE for the whole file (see tests/helpers/dbFixture.js) and rolled
 * back at the end. Per-test seeding against a remote database made this
 * suite flaky to the point of hanging.
 */
import { pool, closePool } from '../config/db.js';
import { generateRhid } from '../utils/rhid.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;

beforeAll(async () => {
  fx = await seedTwoFacilities('PRLS');
}, 60_000);

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('clinical assistant sees only their own facility', () => {
  it('reads their own facility\'s patient', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'clinical_assistant', facility_id: ids.facA },
        'select id from patients where id = $1',
        [ids.patientA],
      );
      expect(res.rowCount).toBe(1);
    }
  });

  it('gets ZERO rows for another facility\'s patient', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'clinical_assistant', facility_id: ids.facA },
        'select id from patients where id = $1',
        [ids.patientB],
      );
      expect(res.rowCount).toBe(0);
    }
  });

  it('cannot find another facility\'s patient even with the exact RHID', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'clinical_assistant', facility_id: ids.facB },
        'select id from patients where rhid = $1',
        [ids.rhidA],
      );
      // Knowing the identifier confers no access. This is what makes the
      // 12-digit ID safe to read aloud.
      expect(res.rowCount).toBe(0);
    }
  });

  it('an unscoped select returns only their own facility', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'clinical_assistant', facility_id: ids.facA },
        'select id from patients',
      );
      expect(res.rows.map((r) => r.id)).toEqual([ids.patientA]);
    }
  });

  it('cannot register a patient into another facility', async () => {
    {
      const { as, ids } = fx;
      await expect(
        as(
          { app_role: 'clinical_assistant', facility_id: ids.facA },
          `insert into patients (rhid, full_name, age_years, facility_id)
           values ($1,'Smuggled', 20, $2)`,
          [generateRhid(), ids.facB],
        ),
      ).rejects.toThrow(/row-level security/i);
    }
  });
});

describe('doctors see their district', () => {
  it('reads a patient at a facility in their district', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'doctor', district_id: ids.distA },
        'select id from patients where id = $1',
        [ids.patientA],
      );
      expect(res.rowCount).toBe(1);
    }
  });

  it('gets zero rows outside their district', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'doctor', district_id: ids.distA },
        'select id from patients where id = $1',
        [ids.patientB],
      );
      expect(res.rowCount).toBe(0);
    }
  });

  it('cannot register a patient — that is the assistant\'s role', async () => {
    {
      const { as, ids } = fx;
      await expect(
        as(
          { app_role: 'doctor', district_id: ids.distA },
          `insert into patients (rhid, full_name, age_years, facility_id)
           values ($1,'By Doctor', 20, $2)`,
          [generateRhid(), ids.facA],
        ),
      ).rejects.toThrow(/row-level security/i);
    }
  });
});

describe('admins have no clinical access whatsoever', () => {
  it.each(['super_admin', 'state_admin', 'district_admin'])(
    '%s reads zero patients',
    async (role) => {
      {
      const { as, ids } = fx;
        const res = await as(
          { app_role: role, district_id: ids.distA, state_id: ids.stateA },
          'select id from patients',
        );
        expect(res.rowCount).toBe(0);
      }
    },
  );

  it('super_admin cannot update a patient', async () => {
    {
      const { as, ids } = fx;
      const res = await as(
        { app_role: 'super_admin' },
        `update patients set full_name = 'Tampered' where id = $1`,
        [ids.patientA],
      );
      // RLS makes the row invisible, so the update matches nothing.
      expect(res.rowCount).toBe(0);
    }
  });

  it('auditor reads zero patients — audit access is not clinical access', async () => {
    {
      const runAs = fx.as;
      const res = await runAs({ app_role: 'auditor' }, 'select id from patients');
      expect(res.rowCount).toBe(0);
    }
  });
});

describe('clinical records are never deleted', () => {
  it.each(['patients', 'visits', 'allergies', 'patient_history'])(
    'authenticated has no DELETE grant on %s',
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

  it('no DELETE policy exists on patients', async () => {
    const { rows } = await pool.query(
      `select policyname from pg_policies
       where tablename = 'patients' and cmd in ('DELETE','ALL')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('triage fields cannot be written by a client', () => {
  it('authenticated cannot update visits.final_tier', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'visits' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name);
    // A client that could set its own tier could downgrade a HIGH-risk case.
    expect(updatable).not.toContain('final_tier');
    expect(updatable).toEqual(expect.arrayContaining(['status', 'chief_complaint']));
  });

  it('authenticated cannot change a patient\'s facility or rhid', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'patients' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name);
    expect(updatable).not.toContain('facility_id');
    expect(updatable).not.toContain('rhid');
    expect(updatable).not.toContain('emergency_registration');
  });
});

describe('data integrity constraints', () => {
  it('rejects an RHID that is not 12 digits', async () => {
    {
      const { as, ids } = fx;
      await expect(
        as(
          { app_role: 'clinical_assistant', facility_id: ids.facA },
          `insert into patients (rhid, full_name, age_years, facility_id)
           values ('123', 'Bad Id', 20, $1)`,
          [ids.facA],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    }
  });

  it('rejects a patient with neither date of birth nor age', async () => {
    // Uses the transaction's own connection via `as()` rather than opening a
    // nested one — nesting a second pool connection inside an open
    // transaction is how the suite used to starve and time out.
    {
      const { as, ids } = fx;
      await expect(
        as(
          { app_role: 'clinical_assistant', facility_id: ids.facA },
          `insert into patients (rhid, full_name, facility_id)
           values ($1, 'No Age', $2)`,
          [generateRhid(), ids.facA],
        ),
      ).rejects.toThrow(/patient_age_known|check constraint/i);
    }
  });
});
