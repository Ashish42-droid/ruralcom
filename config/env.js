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
  // Whisper for voice intake — same key, no extra credential needed.
  GROQ_WHISPER_MODEL_ID: z.string().min(1).optional(),
  SELF_HOSTED_LLM_BASE_URL: z.string().url().optional(),
  SELF_HOSTED_LLM_MODEL_ID: z.string().min(1).optional(),

  // ---- Vision: wound image analysis (D-066) ----
  // Mixed-case because that is the name this project's .env actually uses.
  // The conventional SCREAMING_SNAKE spelling is accepted too, so a later
  // rename cannot silently disable wound analysis.
  Gemini_API_Key: z.string().min(10).optional(),
  GEMINI_API_KEY: z.string().min(10).optional(),
  GEMINI_VISION_MODEL: z.string().min(1).optional(),

  // ---- Video (D-039) ----
  // All three optional together: without them, video routes return 503
  // LIVEKIT_NOT_CONFIGURED rather than crashing the server at boot.
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),

  // ---- Redis / BullMQ (D-043) ----
  // Must be rediss:// for Upstash — ioredis negotiates TLS from the scheme,
  // and a plain redis:// URL fails in a way that looks like a network fault.
  REDIS_URL: z
    .string()
    .startsWith('redis')
    .refine(
      (v) => !v.includes('upstash.io') || v.startsWith('rediss://'),
      'Upstash requires TLS: use the rediss:// scheme, not redis://',
    )
    .optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),

  // ---- Demo seed ----
  // Required by scripts/seed-demo.js. Deliberately no default: these
  // accounts can read patient records, so a weak shared password must not
  // be bakeable into the repository by omission.
  SEED_DEMO_PASSWORD: z.string().min(12).optional(),
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
  // The API also serves the demo UI (app.js), so requests originate from
  // the API's OWN origin. Without it in the allowlist the browser's Origin
  // header is rejected and every call from the UI fails CORS — which
  // surfaces to the client as an opaque 500, not an obvious CORS error.
  corsOrigins: [
    ...new Set(
      [...raw.CORS_ORIGINS.split(','), raw.API_BASE_URL]
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  ],
});

export default env;
