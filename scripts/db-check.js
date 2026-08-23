/**
 * Connectivity check: `npm run db:check`
 *
 * Verifies Postgres and Supabase Auth from the command line, so a broken
 * environment is diagnosed in seconds rather than by reading server logs.
 */
import { pingDatabase, closePool } from '../config/db.js';
import { pingSupabase } from '../config/supabase.js';
import env from '../config/env.js';

const results = [];

try {
  const db = await pingDatabase();
  results.push(['Postgres', true, `${db.version} (${db.latencyMs}ms)`]);
} catch (err) {
  results.push(['Postgres', false, err.message]);
}

try {
  const sb = await pingSupabase();
  results.push(['Supabase Auth', true, `GoTrue ${sb.version} (${sb.latencyMs}ms)`]);
} catch (err) {
  results.push(['Supabase Auth', false, err.message]);
}

console.log(`\nRuralAI environment check  [${env.NODE_ENV}]`);
console.log('-'.repeat(62));
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(16)} ${detail}`);
}
console.log('-'.repeat(62));

await closePool();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
