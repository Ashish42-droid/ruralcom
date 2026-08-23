/**
 * Audit logging.
 *
 * Every service-role write and every security-relevant event lands here.
 * The table is append-only at the database level (0002), so this module is
 * the only sanctioned way in.
 *
 * Failures are logged but never thrown: a broken audit sink must not break
 * patient care. It does raise a `critical` log line, because silently
 * losing audit trail is itself an incident.
 */
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../config/logger.js';

/** Keys scrubbed from before/after snapshots before they reach the table. */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'tokenHash',
  'token_hash',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'apikey',
  'authorization',
  'rhid',
  'abha_id',
]);

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

/**
 * Write one audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action        - audit_action enum value
 * @param {string} [entry.actorId]     - profile id of whoever acted
 * @param {string} [entry.actorRole]
 * @param {string} [entry.entityType]
 * @param {string} [entry.entityId]
 * @param {object} [entry.before]
 * @param {object} [entry.after]
 * @param {object} [entry.metadata]
 * @param {'info'|'warning'|'critical'} [entry.severity]
 * @param {import('express').Request} [entry.req] - source of ip/ua/request id
 */
export async function recordAudit(entry) {
  const { req } = entry;

  const row = {
    actor_id: entry.actorId ?? null,
    actor_role: entry.actorRole ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ? String(entry.entityId) : null,
    before_state: entry.before ? redact(entry.before) : null,
    after_state: entry.after ? redact(entry.after) : null,
    metadata: redact(entry.metadata ?? {}),
    severity: entry.severity ?? 'info',
    ip_address: req?.ip ?? null,
    user_agent: req?.get?.('user-agent') ?? null,
    request_id: req?.id ?? null,
  };

  const { error } = await supabaseAdmin.from('audit_log').insert(row);

  if (error) {
    logger.error(
      { err: error, action: entry.action, requestId: req?.id },
      'AUDIT WRITE FAILED — security event was not persisted',
    );
  }
}

/**
 * Fire-and-forget variant for hot paths where awaiting the write would add
 * latency to a clinical action. Still logs failures.
 */
export function recordAuditAsync(entry) {
  recordAudit(entry).catch((err) =>
    logger.error({ err, action: entry.action }, 'Async audit write threw'),
  );
}

export default { recordAudit, recordAuditAsync };
