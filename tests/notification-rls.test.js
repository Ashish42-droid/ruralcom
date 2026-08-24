/**
 * Notifications — isolation and the no-PHI rule.
 *
 * The property that matters most: a notification is visible ONLY to its
 * recipient. Not their facility, not their district — them.
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;
let userA;
let userB;

beforeAll(async () => {
  fx = await seedTwoFacilities('NOTIF');

  const { rows: adminRows } = await fx.asOwner(
    `select id from profiles where role = 'super_admin' limit 1`,
  );
  const adminId = adminRows[0].id;

  const mkUser = async (label) => {
    const { rows } = await fx.asOwner(
      `insert into auth.users (id, email, instance_id, aud, role)
       values (gen_random_uuid(), $1, '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated')
       returning id`,
      [`notif-${label}-${Math.random().toString(36).slice(2, 8)}@t.invalid`],
    );
    await fx.asOwner(
      `insert into profiles (id, role, full_name, created_by)
       values ($1, 'clinical_assistant', $2, $3)`,
      [rows[0].id, `Notif ${label}`, adminId],
    );
    return rows[0].id;
  };

  userA = await mkUser('A');
  userB = await mkUser('B');
}, 90_000);

beforeEach(async () => {
  await fx.asOwner('delete from notifications where recipient_id in ($1, $2)', [userA, userB]);
});

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('a notification is visible only to its recipient', () => {
  beforeEach(async () => {
    await fx.asOwner(
      `insert into notifications (recipient_id, type, payload)
       values ($1, 'consultation_ringing', '{"consultationId":"abc"}')`,
      [userA],
    );
  });

  it('the recipient sees their own', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', sub: userA, facility_id: fx.ids.facA },
      'select id from notifications',
    );
    expect(res.rowCount).toBe(1);
  });

  it('a DIFFERENT user at the same facility sees none', async () => {
    // Facility scope is not enough — notifications are strictly per-person.
    const res = await fx.as(
      { app_role: 'clinical_assistant', sub: userB, facility_id: fx.ids.facA },
      'select id from notifications',
    );
    expect(res.rowCount).toBe(0);
  });

  it.each(['super_admin', 'auditor', 'doctor'])(
    '%s sees none of another user\'s notifications',
    async (role) => {
      const res = await fx.as(
        { app_role: role, sub: userB, district_id: fx.ids.distA },
        'select id from notifications',
      );
      expect(res.rowCount).toBe(0);
    },
  );
});

describe('clients cannot forge or destroy notifications', () => {
  it('authenticated has no INSERT grant', async () => {
    // A client able to author one could forge a "consultation scheduled"
    // that no scheduler ever created.
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'notifications' and grantee = 'authenticated'
         and privilege_type = 'INSERT'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('authenticated has no DELETE grant', async () => {
    const { rows } = await pool.query(
      `select 1 from information_schema.role_table_grants
       where table_name = 'notifications' and grantee = 'authenticated'
         and privilege_type = 'DELETE'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('the ONLY updatable column is read_at', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'notifications' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    expect(rows.map((r) => r.column_name)).toEqual(['read_at']);
  });

  it('a recipient can mark their own as read', async () => {
    await fx.asOwner(
      `insert into notifications (recipient_id, type) values ($1, 'assessment_ready')`,
      [userA],
    );
    const res = await fx.as(
      { app_role: 'clinical_assistant', sub: userA, facility_id: fx.ids.facA },
      `update notifications set read_at = now() where read_at is null returning id`,
    );
    expect(res.rowCount).toBeGreaterThan(0);
  });

  it('a different user cannot mark it read', async () => {
    await fx.asOwner(
      `insert into notifications (recipient_id, type) values ($1, 'assessment_ready')`,
      [userA],
    );
    const res = await fx.as(
      { app_role: 'clinical_assistant', sub: userB, facility_id: fx.ids.facA },
      `update notifications set read_at = now() where read_at is null returning id`,
    );
    // RLS hides the row, so the update matches nothing.
    expect(res.rowCount).toBe(0);
  });
});

describe('RLS is enabled', () => {
  it('notifications has RLS and at least one policy', async () => {
    const { rows: rls } = await pool.query(
      `select relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = 'notifications'`,
    );
    expect(rls[0].relrowsecurity).toBe(true);

    const { rows: policies } = await pool.query(
      `select policyname from pg_policies where tablename = 'notifications'`,
    );
    expect(policies.length).toBeGreaterThan(0);
  });
});
