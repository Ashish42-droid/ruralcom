/**
 * Shared database fixture for RLS policy tests.
 *
 * WHY THIS EXISTS: the first version of these tests re-seeded geography and
 * patients inside every single test case. Against a REMOTE Postgres that is
 * ~8 network round trips per test, so a 22-test file made ~180 round trips
 * and the suite went from slow to genuinely flaky to hanging outright.
 *
 * The fix is structural, not a bigger timeout: seed ONCE per file inside one
 * transaction on one connection, give each test a SAVEPOINT for isolation,
 * and roll the whole thing back at the end. Round trips drop by ~20x and the
 * database is left untouched either way.
 */
import { pool } from '../../config/db.js';
import { generateRhid } from '../../utils/rhid.js';

/**
 * Opens a transaction, seeds two states / districts / facilities and a
 * patient in each, and returns handles for the tests to use.
 *
 * Call in `beforeAll`; call the returned `teardown` in `afterAll`.
 */
export async function seedTwoFacilities(prefix = 'FX') {
  const client = await pool.connect();
  await client.query('BEGIN');

  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const tag = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

  const stateA = await one(
    `insert into states (name, code) values ($1, $2) returning id`,
    [`${tag} State A`, `${tag}-A`],
  );
  const stateB = await one(
    `insert into states (name, code) values ($1, $2) returning id`,
    [`${tag} State B`, `${tag}-B`],
  );
  const distA = await one(
    `insert into districts (state_id, name, code) values ($1,$2,$3) returning id`,
    [stateA.id, `${tag} Dist A`, `${tag}-DA`],
  );
  const distB = await one(
    `insert into districts (state_id, name, code) values ($1,$2,$3) returning id`,
    [stateB.id, `${tag} Dist B`, `${tag}-DB`],
  );
  const facA = await one(
    `insert into facilities (district_id, name, type)
     values ($1,$2,'village_health_centre') returning id`,
    [distA.id, `${tag} Facility A`],
  );
  const facB = await one(
    `insert into facilities (district_id, name, type)
     values ($1,$2,'village_health_centre') returning id`,
    [distB.id, `${tag} Facility B`],
  );
  const patientA = await one(
    `insert into patients (rhid, full_name, age_years, facility_id)
     values ($1,'Patient At A',30,$2) returning id, rhid`,
    [generateRhid(), facA.id],
  );
  const patientB = await one(
    `insert into patients (rhid, full_name, age_years, facility_id)
     values ($1,'Patient At B',40,$2) returning id, rhid`,
    [generateRhid(), facB.id],
  );

  let seq = 0;

  /**
   * Runs one query as the `authenticated` Postgres role with the given JWT
   * claims, exactly as PostgREST would.
   *
   * The SAVEPOINT matters: a policy rejection aborts the enclosing
   * transaction, and without it every later statement fails with "current
   * transaction is aborted", masking the real result.
   */
  async function as(claims, sql, params) {
    const sp = `sp_${(seq += 1)}`;
    await client.query(`savepoint ${sp}`);
    await client.query(`select set_config('role','authenticated',true)`);
    await client.query(`select set_config('request.jwt.claims',$1,true)`, [
      JSON.stringify(claims),
    ]);
    try {
      const result = await client.query(sql, params);
      await client.query(`release savepoint ${sp}`);
      return result;
    } catch (err) {
      await client.query(`rollback to savepoint ${sp}`);
      throw err;
    } finally {
      await client.query(`select set_config('role','postgres',true)`);
      await client.query(`select set_config('request.jwt.claims','',true)`);
    }
  }

  /** Runs a query as the owner (no RLS), inside its own savepoint. */
  async function asOwner(sql, params) {
    const sp = `sp_${(seq += 1)}`;
    await client.query(`savepoint ${sp}`);
    try {
      const result = await client.query(sql, params);
      await client.query(`release savepoint ${sp}`);
      return result;
    } catch (err) {
      await client.query(`rollback to savepoint ${sp}`);
      throw err;
    }
  }

  async function teardown() {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  return {
    as,
    asOwner,
    teardown,
    ids: {
      stateA: stateA.id,
      stateB: stateB.id,
      distA: distA.id,
      distB: distB.id,
      facA: facA.id,
      facB: facB.id,
      patientA: patientA.id,
      patientB: patientB.id,
      rhidA: patientA.rhid,
    },
  };
}

export default { seedTwoFacilities };
