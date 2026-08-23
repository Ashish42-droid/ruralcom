/**
 * Test bootstrap. Runs before each test file.
 *
 * Loads .env so integration tests hit the real Supabase project, then forces
 * NODE_ENV=test (smaller pool, no pretty logging, quieter output).
 */
import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
