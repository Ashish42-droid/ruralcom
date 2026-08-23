/**
 * TASK 0 — closes the gap noted against D-017.
 *
 * Every other RLS test injects JWT claims directly with `set_config`, which
 * proves the POLICIES are right but says nothing about whether a real login
 * actually produces those claims. If the custom access token hook is
 * disabled in the Supabase dashboard, all of those tests still pass while
 * the live application can read nothing at all.
 *
 * This suite closes that hole: it signs in for real, takes the genuine JWT,
 * and drives PostgREST with it. It goes RED the moment the hook is off.
 */
import { seedLiveAuth } from './helpers/liveAuthFixture.js';
import { supabaseAsUser } from '../config/supabase.js';
import { closePool } from '../config/db.js';

let fx;
let setupError = null;

beforeAll(async () => {
  try {
    fx = await seedLiveAuth();
  } catch (err) {
    setupError = err;
  }
}, 90_000);

afterAll(async () => {
  if (fx) await fx.teardown();
  await closePool();
});

describe('the access token hook is enabled', () => {
  it('seeded a live session without error', () => {
    expect(setupError).toBeNull();
  });

  /**
   * THE CANARY.
   *
   * If this fails, the access token hook is not enabled. It is not a code
   * bug, and no amount of policy editing will fix it.
   */
  it('issues a JWT carrying the app_role claim', () => {
    const hookRan = 'app_role' in fx.claims;

    if (!hookRan) {
      throw new Error(
        [
          '',
          'The Supabase access token hook is NOT ENABLED.',
          '',
          'The JWT contains no `app_role` claim, so every role-checking RLS',
          'policy evaluates to null and DENIES. A valid login can read',
          'nothing. Every other test in this repo still passes, because they',
          'inject claims directly with set_config — which is exactly the gap',
          'this suite exists to catch.',
          '',
          'Fix (dashboard only — it cannot be done from a migration):',
          '  Authentication -> Hooks -> "Customize Access Token (JWT) Claims"',
          '  -> select public.custom_access_token_hook',
          '',
          `Claims actually received: ${Object.keys(fx.claims).sort().join(', ')}`,
          '',
        ].join('\n'),
      );
    }

    expect(fx.claims.app_role).toBe('clinical_assistant');
  });

  it('issues a JWT carrying the facility scope', () => {
    expect(fx.claims.facility_id).toBe(fx.ids.facA);
  });

  it('marks the account active in the token', () => {
    expect(fx.claims.account_active).toBe(true);
  });
});

describe('a real session reads exactly what policy allows', () => {
  it('reads a patient at its own facility', async () => {
    const client = supabaseAsUser(fx.accessToken);
    const { data, error } = await client
      .from('patients')
      .select('id')
      .eq('id', fx.ids.patientA);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('reads ZERO rows for a patient at another facility', async () => {
    const client = supabaseAsUser(fx.accessToken);
    const { data, error } = await client
      .from('patients')
      .select('id')
      .eq('id', fx.ids.patientB);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an unscoped select returns only its own facility', async () => {
    const client = supabaseAsUser(fx.accessToken);
    const { data } = await client.from('patients').select('id, facility_id');

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row.facility_id).toBe(fx.ids.facA);
    }
  });

  it('cannot insert a patient into another facility', async () => {
    const client = supabaseAsUser(fx.accessToken);
    const { error } = await client.from('patients').insert({
      rhid: '123456789012',
      full_name: 'Smuggled',
      age_years: 20,
      facility_id: fx.ids.facB,
    });

    expect(error).not.toBeNull();
  });

  it('cannot escalate its own role', async () => {
    const client = supabaseAsUser(fx.accessToken);
    const { error } = await client
      .from('profiles')
      .update({ role: 'super_admin' })
      .eq('id', fx.profileId);

    expect(error).not.toBeNull();
  });
});
