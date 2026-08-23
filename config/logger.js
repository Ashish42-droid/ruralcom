/**
 * Structured logging.
 *
 * Redaction is not optional here. This system handles patient data, session
 * tokens, and a Supabase service-role key that bypasses row-level security.
 * Anything on the redact list must never reach a log sink, a log aggregator,
 * or a support ticket.
 */
import pino from 'pino';
import env from './env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.apikey',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.serviceRoleKey',
  '*.SUPABASE_SERVICE_ROLE_KEY',
  '*.DATABASE_URL',
  // Patient identifiers — never log the health ID in plaintext.
  '*.rhid',
  '*.abha_id',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'ruralai-core-api', env: env.NODE_ENV },
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

export default logger;
