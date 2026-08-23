/**
 * Row-level security policy tests.
 *
 * These are the tests that matter most in this repo. They connect to the
 * real database, impersonate the `authenticated` role with a synthetic JWT
 * claim set, and assert that Postgres itself refuses to return rows the
 * caller is not entitled to.
 *
 * Asserting "a district admin gets zero rows for another district" is worth
 * more than any amount of clicking around as a super admin.
 *
 * Everything runs inside a transaction that is always rolled back, so the
 * database is left untouched.
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

/**
 * Runs `fn` with a client impersonating the `authenticated` Postgres role
 * and the given JWT claims, exactly as PostgREST would. Always rolled back.
 */
async function asUser(claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('role', 'authenticated', true)");
    await client.query(
      "select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify(claims)],
    );
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Geography is seeded ONCE for the whole file (tests/helpers/dbFixture.js).
 * Per-test seeding against a remote database made this suite slow and flaky.
 */
let fx;

beforeAll(async () => {
  fx = await seedTwoFacilities('RLS');
}, 60_000);

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('RLS is enabled on every application table', () => {
  it('has row level security on all public tables', async () => {
    const { rows } = await pool.query(`
      select relname from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind = 'r'
        and relrowsecurity = false
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('claim accessor functions', () => {
  it('reads app_role from the JWT claims', async () => {
    const role = await asUser({ app_role: 'doctor' }, async (c) => {
      const { rows } = await c.query('select public.jwt_role() as role');
      return rows[0].role;
    });
    expect(role).toBe('doctor');
  });

  it('returns null when no claims are present, so policies deny', async () => {
    const role = await asUser({}, async (c) => {
      const { rows } = await c.query('select public.jwt_role() as role');
      return rows[0].role;
    });
    expect(role).toBeNull();
  });

  it('treats an unknown/blank role as null rather than erroring', async () => {
    const role = await asUser({ app_role: '' }, async (c) => {
      const { rows } = await c.query('select public.jwt_role() as role');
      return rows[0].role;
    });
    expect(role).toBeNull();
  });
});

describe('admin_covers_district', () => {
  it('super_admin covers any district', async () => {
    {
      const ids = fx.ids;
      const covered = await asUser({ app_role: 'super_admin' }, async (c) => {
        const { rows } = await c.query(
          'select public.admin_covers_district($1) as ok',
          [ids.distA],
        );
        return rows[0].ok;
      });
      expect(covered).toBe(true);
    }
  });

  it('district_admin does NOT cover another district', async () => {
    {
      const ids = fx.ids;
      const covered = await asUser(
        { app_role: 'district_admin', district_id: ids.distA },
        async (c) => {
          const { rows } = await c.query(
            'select public.admin_covers_district($1) as ok',
            [ids.distB],
          );
          return rows[0].ok;
        },
      );
      expect(covered).toBe(false);
    }
  });

  it('a doctor never covers a district — not an admin role', async () => {
    {
      const ids = fx.ids;
      const covered = await asUser(
        { app_role: 'doctor', district_id: ids.distA },
        async (c) => {
          const { rows } = await c.query(
            'select public.admin_covers_district($1) as ok',
            [ids.distA],
          );
          return rows[0].ok;
        },
      );
      expect(covered).toBe(false);
    }
  });
});

describe('profiles: no client may insert an account', () => {
  it('grants authenticated no INSERT privilege at all', async () => {
    const { rows } = await pool.query(`
      select 1 from information_schema.role_table_grants
      where table_name = 'profiles'
        and grantee = 'authenticated'
        and privilege_type = 'INSERT'
    `);
    expect(rows).toHaveLength(0);
  });

  it('defines no INSERT policy on profiles, so RLS defaults to deny', async () => {
    const { rows } = await pool.query(`
      select policyname from pg_policies
      where tablename = 'profiles' and cmd in ('INSERT','ALL')
    `);
    expect(rows).toEqual([]);
  });

  it('rejects an INSERT from an authenticated caller', async () => {
    await expect(
      asUser({ app_role: 'super_admin' }, (c) =>
        c.query(
          `insert into profiles (id, role, full_name, created_by)
           values (gen_random_uuid(), 'doctor', 'Should Fail', gen_random_uuid())`,
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied|non-existent profile/i);
  });

  it('rejects an account whose provisioner does not exist', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = (await client.query('select gen_random_uuid() as id')).rows[0].id;
      await expect(
        client.query(
          `insert into profiles (id, role, full_name, created_by)
           values ($1, 'doctor', 'Self Provisioner', $1)`,
          [id],
        ),
      ).rejects.toThrow(/non-existent profile|self-provisioning|foreign key/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('rejects a bootstrap account that is not a super_admin', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `insert into profiles (id, role, full_name)
           values (gen_random_uuid(), 'doctor', 'Sneaky Bootstrap')`,
        ),
      ).rejects.toThrow(/bootstrap account must be a super_admin|created_by is required/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('profiles: privilege escalation is blocked at column level', () => {
  /**
   * Guards against the exact bug fixed in migration 0006: a TABLE-level
   * UPDATE grant covers every column and makes column-level revokes silently
   * useless. Assert there is no table-level grant, then check the columns.
   */
  it('has no table-level UPDATE grant on profiles for authenticated', async () => {
    const { rows } = await pool.query(`
      select 1 from information_schema.role_table_grants
      where table_name = 'profiles'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    expect(rows).toHaveLength(0);
  });

  it('authenticated cannot update role, is_active or created_by', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'profiles'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
      order by column_name
    `);
    const updatable = rows.map((r) => r.column_name);
    expect(updatable).not.toContain('role');
    expect(updatable).not.toContain('is_active');
    expect(updatable).not.toContain('created_by');
  });

  it('authenticated may still update its own contact fields', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'profiles'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name);
    expect(updatable).toEqual(
      expect.arrayContaining(['full_name', 'phone', 'preferred_language']),
    );
  });

  it('a doctor cannot escalate their own role via a direct UPDATE', async () => {
    await expect(
      asUser({ app_role: 'doctor' }, (c) =>
        c.query(`update profiles set role = 'super_admin' where id = id`),
      ),
    ).rejects.toThrow(/permission denied|column .* of relation/i);
  });
});

describe('audit_log is append-only', () => {
  it('rejects UPDATE', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `insert into audit_log (action, entity_type) values ('login', 'test')`,
      );
      await expect(
        client.query(`update audit_log set entity_type = 'tampered'`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('rejects DELETE', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `insert into audit_log (action, entity_type) values ('login', 'test')`,
      );
      await expect(client.query('delete from audit_log')).rejects.toThrow(/append-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('is readable by auditor but not by a doctor', async () => {
    const canRead = await asUser({ app_role: 'auditor' }, async (c) => {
      const { rows } = await c.query('select public.can_read_audit() as ok');
      return rows[0].ok;
    });
    const doctorCanRead = await asUser({ app_role: 'doctor' }, async (c) => {
      const { rows } = await c.query('select public.can_read_audit() as ok');
      return rows[0].ok;
    });
    expect(canRead).toBe(true);
    expect(doctorCanRead).toBe(false);
  });
});

describe('geography writes are scoped', () => {
  it('a doctor cannot create a state', async () => {
    await expect(
      asUser({ app_role: 'doctor' }, (c) =>
        c.query(`insert into states (name, code) values ('Rogue State','RGE')`),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a district_admin cannot create a facility in another district', async () => {
    {
      const ids = fx.ids;
      await expect(
        asUser(
          { app_role: 'district_admin', district_id: ids.distA },
          (c) =>
            c.query(
              `insert into facilities (district_id, name, type)
               values ($1, 'Rogue Clinic', 'phc')`,
              [ids.distB],
            ),
        ),
      ).rejects.toThrow(/row-level security/i);
    }
  });
});
