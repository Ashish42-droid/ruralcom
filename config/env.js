/**
 * Environment loading and validation.
 *
 * Fails fast and loudly at boot if anything required is missing or malformed.
 * A clinical system must never start half-configured — a server that boots
 * without a database URL and only discovers it on the first patient write is
 * worse than one that refuses to start.
 */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  // ---- Application ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // 'silent' is a valid pino level and is what the test bootstrap uses.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ---- Supabase ----
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  // Bypasses ALL row-level security. Server-only. See docs/SECURITY.md.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // ---- Postgres ----
  DATABASE_URL: z.string().startsWith('postgres'),
  DATABASE_POOLER_URL: z.string().startsWith('postgres').optional(),

  // ---- Secrets ----
  // Optional until Phase 1 (auth) needs it; validated as strong when present.
  APP_SECRET: z.string().min(32).optional(),

  // ---- LLM (assessment layer, D-035) ----
  // Optional: with neither set, createLlmService() returns null and the
  // triage engine floors every case at MEDIUM — the safe default.
  GROQ_API_KEY: z.string().min(10).optional(),
  GROQ_MODEL_ID: z.string().min(1).optional(),
  SELF_HOSTED_LLM_BASE_URL: z.string().url().optional(),
  SELF_HOSTED_LLM_MODEL_ID: z.string().min(1).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(
    `\nInvalid environment configuration:\n${issues}\n\n` +
      `Copy .env.example to .env and fill in the missing values.\n`,
  );
  process.exit(1);
}

const raw = parsed.data;

export const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
});

export default env;
