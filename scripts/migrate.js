/**
 * Migration runner: `npm run db:migrate`
 *
 * Applies every unapplied .sql file in db/migrations in filename order, each
 * inside its own transaction. A failed migration rolls back completely — a
 * half-applied schema on a clinical database is worse than no migration.
 *
 * Flags:
 *   --dry    list what would run, change nothing
 *   --force  re-run a migration whose checksum changed (destructive; asks nothing)
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, closePool } from '../config/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'db', 'migrations');

const dryRun = process.argv.includes('--dry');
const force = process.argv.includes('--force');

async function ensureMigrationsTable() {
  await pool.query(`
    create table if not exists public.schema_migrations (
      filename    text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    );
  `);
}

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function main() {
  await ensureMigrationsTable();

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found.');
    return;
  }

  const { rows } = await pool.query(
    'select filename, checksum from public.schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let ran = 0;

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const sum = checksum(sql);
    const previous = applied.get(file);

    if (previous && previous === sum) {
      console.log(`  skip   ${file}`);
      continue;
    }

    if (previous && previous !== sum && !force) {
      console.error(
        `\n  FAIL   ${file}\n` +
          `         Already applied, but the file has changed since.\n` +
          `         Migrations are immutable — add a new one instead.\n` +
          `         Use --force only if you know the change is safe to replay.\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      console.log(`  would  ${file}`);
      ran += 1;
      continue;
    }

    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      const duration = Date.now() - started;
      await client.query(
        `insert into public.schema_migrations (filename, checksum, duration_ms)
         values ($1, $2, $3)
         on conflict (filename) do update
           set checksum = excluded.checksum,
               applied_at = now(),
               duration_ms = excluded.duration_ms`,
        [file, sum, duration],
      );
      await client.query('COMMIT');
      console.log(`  ok     ${file}  (${duration}ms)`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\n  FAIL   ${file}\n         ${err.message}\n`);
      process.exitCode = 1;
      return;
    } finally {
      client.release();
    }
  }

  console.log(
    `\n${dryRun ? 'Dry run' : 'Migrated'}: ${ran} migration(s), ${files.length - ran} already current.\n`,
  );
}

try {
  await main();
} finally {
  await closePool();
}
