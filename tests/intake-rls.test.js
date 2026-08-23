/**
 * Attachment and symptom-entry isolation, verified at the database level.
 *
 * Uses the seed-once fixture (D-017).
 */
import { pool, closePool } from '../config/db.js';
import { seedTwoFacilities } from './helpers/dbFixture.js';

let fx;
let visitA;
let visitB;

beforeAll(async () => {
  fx = await seedTwoFacilities('INTK');

  const mk = async (patientId, facilityId) => {
    const { rows } = await fx.asOwner(
      `insert into visits (patient_id, facility_id, status)
       values ($1, $2, 'open') returning id`,
      [patientId, facilityId],
    );
    return rows[0].id;
  };

  visitA = await mk(fx.ids.patientA, fx.ids.facA);
  visitB = await mk(fx.ids.patientB, fx.ids.facB);

  await fx.asOwner(
    `insert into attachments
       (visit_id, patient_id, type, bucket, storage_path, mime, size_bytes)
     values ($1, $2, 'wound_image', 'wound-images', $3, 'image/jpeg', 1024)`,
    [visitA, fx.ids.patientA, `${fx.ids.facA}/${visitA}/a.jpg`],
  );
  await fx.asOwner(
    `insert into attachments
       (visit_id, patient_id, type, bucket, storage_path, mime, size_bytes)
     values ($1, $2, 'wound_image', 'wound-images', $3, 'image/jpeg', 1024)`,
    [visitB, fx.ids.patientB, `${fx.ids.facB}/${visitB}/b.jpg`],
  );
  await fx.asOwner(
    `insert into symptom_entries (visit_id, patient_id, raw_text, language)
     values ($1, $2, 'बुखार', 'hi')`,
    [visitA, fx.ids.patientA],
  );
  await fx.asOwner(
    `insert into symptom_entries (visit_id, patient_id, raw_text, language)
     values ($1, $2, 'জ্বর', 'bn')`,
    [visitB, fx.ids.patientB],
  );
}, 90_000);

afterAll(async () => {
  await fx.teardown();
  await closePool();
});

describe('attachments are facility-scoped', () => {
  it('an assistant sees their own facility\'s attachments', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from attachments',
    );
    expect(res.rowCount).toBe(1);
  });

  it('an assistant sees ZERO attachments from another facility', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select id from attachments where visit_id = $1',
      [visitB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('a doctor sees their district', async () => {
    const res = await fx.as(
      { app_role: 'doctor', district_id: fx.ids.distA },
      'select id from attachments',
    );
    expect(res.rowCount).toBe(1);
  });

  it.each(['super_admin', 'state_admin', 'district_admin', 'auditor'])(
    '%s sees zero attachments',
    async (role) => {
      const res = await fx.as(
        { app_role: role, district_id: fx.ids.distA, state_id: fx.ids.stateA },
        'select id from attachments',
      );
      expect(res.rowCount).toBe(0);
    },
  );

  it('cannot attach a file to another facility\'s visit', async () => {
    await expect(
      fx.as(
        { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
        `insert into attachments
           (visit_id, patient_id, type, bucket, storage_path, mime, size_bytes)
         values ($1, $2, 'wound_image', 'wound-images', 'x/y/z.jpg', 'image/jpeg', 10)`,
        [visitB, fx.ids.patientB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('symptom entries are facility-scoped', () => {
  it('an assistant reads only their own facility', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
      'select raw_text from symptom_entries',
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].raw_text).toBe('बुखार');
  });

  it('keeps the original text in its own language and script', async () => {
    const res = await fx.as(
      { app_role: 'clinical_assistant', facility_id: fx.ids.facB },
      'select raw_text, language from symptom_entries',
    );
    // The original is the primary clinical record; a translation never
    // overwrites it.
    expect(res.rows[0]).toMatchObject({ raw_text: 'জ্বর', language: 'bn' });
  });

  it('cannot record a symptom against another facility\'s visit', async () => {
    await expect(
      fx.as(
        { app_role: 'clinical_assistant', facility_id: fx.ids.facA },
        `insert into symptom_entries (visit_id, patient_id, raw_text, language)
         values ($1, $2, 'smuggled', 'en')`,
        [visitB, fx.ids.patientB],
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('clinical evidence is immutable', () => {
  it.each(['attachments', 'symptom_entries'])(
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

  it('authenticated cannot update a symptom entry at all', async () => {
    const { rows } = await pool.query(`
      select 1 from information_schema.role_table_grants
      where table_name = 'symptom_entries' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    expect(rows).toHaveLength(0);
  });

  it('authenticated cannot rewrite OCR results or the storage path', async () => {
    const { rows } = await pool.query(`
      select column_name from information_schema.column_privileges
      where table_name = 'attachments' and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
    `);
    const updatable = rows.map((r) => r.column_name);
    // OCR output feeds clinical decisions; only the pipeline writes it.
    expect(updatable).not.toContain('ocr_text');
    expect(updatable).not.toContain('ocr_status');
    expect(updatable).not.toContain('needs_human_review');
    expect(updatable).not.toContain('storage_path');
    expect(updatable).toEqual(['original_name']);
  });
});

describe('storage buckets are private', () => {
  it('none of the clinical buckets is public', async () => {
    const { rows } = await pool.query(
      `select id, public from storage.buckets
       where id in ('prescriptions','wound-images','lab-reports')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.public).toBe(false);
    }
  });

  it('buckets cap file size and restrict MIME types', async () => {
    const { rows } = await pool.query(
      `select id, file_size_limit, allowed_mime_types from storage.buckets
       where id in ('prescriptions','wound-images','lab-reports')`,
    );
    for (const row of rows) {
      // Postgres returns bigint as a string to avoid precision loss in JS.
      expect(Number(row.file_size_limit)).toBeLessThanOrEqual(10 * 1024 * 1024);
      expect(row.allowed_mime_types.length).toBeGreaterThan(0);
      expect(row.allowed_mime_types).not.toContain('image/svg+xml');
    }
  });

  it('wound-images does not accept PDFs', async () => {
    const { rows } = await pool.query(
      `select allowed_mime_types from storage.buckets where id = 'wound-images'`,
    );
    expect(rows[0].allowed_mime_types).not.toContain('application/pdf');
  });

  it('there is no update or delete policy on clinical storage objects', async () => {
    const { rows } = await pool.query(`
      select policyname, cmd from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'storage_clinical%'
    `);
    const commands = rows.map((r) => r.cmd).sort();
    expect(commands).toEqual(['INSERT', 'SELECT']);
  });
});

describe('every new table has RLS', () => {
  it.each(['attachments', 'symptom_entries'])('%s has RLS enabled', async (table) => {
    const { rows } = await pool.query(
      `select relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = $1`,
      [table],
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it.each(['attachments', 'symptom_entries'])('%s has at least one policy', async (table) => {
    const { rows } = await pool.query(
      `select policyname from pg_policies where tablename = $1`,
      [table],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
