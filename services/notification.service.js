/**
 * Notification dispatch — durable row first, realtime push second.
 *
 * ORDER MATTERS. The database write happens BEFORE the socket emit, so a
 * crash between the two loses the push (recoverable on reconnect) rather
 * than the record (not recoverable at all). A doctor who was offline for
 * thirty seconds still sees the consultation waiting when they come back.
 *
 * NO PHI IN PAYLOADS. Notifications travel over websockets and may be
 * cached client-side, so they carry ids and enum values only — never a
 * patient name, symptom text, or clinical finding. The client fetches the
 * record through the normal RLS-protected endpoints once it knows
 * something happened. `assertNoPhi` below enforces this in development.
 */
import { supabaseAdmin, supabaseAsUser } from '../config/supabase.js';
import { emitToUser, EVENTS } from '../sockets/index.js';
import logger from '../config/logger.js';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

/** Notification type -> the socket event it also fires. */
const EVENT_FOR_TYPE = Object.freeze({
  consultation_scheduled: EVENTS.CONSULTATION_SCHEDULED,
  consultation_ringing: EVENTS.CONSULTATION_RINGING,
  consultation_missed: EVENTS.CONSULTATION_MISSED,
  consultation_reassigned: EVENTS.CONSULTATION_REASSIGNED,
  consultation_joined: EVENTS.CONSULTATION_JOINED,
  consultation_completed: EVENTS.CONSULTATION_COMPLETED,
  assessment_ready: EVENTS.ASSESSMENT_READY,
  review_flagged_to_assistant: EVENTS.REVIEW_FLAGGED,
  review_approved: EVENTS.REVIEW_APPROVED,
  high_risk_referral: EVENTS.NOTIFICATION,
});

/**
 * Keys that must never appear in a notification payload.
 *
 * Throws in development and test so the mistake is caught while writing
 * the code; warns in production rather than dropping a notification a
 * clinician is waiting on.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  'fullName', 'full_name', 'name',
  'rawText', 'raw_text', 'symptomText', 'symptom_text',
  'reasoning', 'differential', 'clinicalNote', 'clinical_note',
  'rhid', 'abhaId', 'abha_id', 'phone', 'village',
];

function assertNoPhi(payload, type) {
  const offending = Object.keys(payload ?? {}).filter((k) =>
    FORBIDDEN_PAYLOAD_KEYS.includes(k),
  );
  if (!offending.length) return;

  const message =
    `Notification payload for "${type}" contains PHI-shaped keys: ` +
    `${offending.join(', ')}. Send ids only.`;

  if (env.isProduction) {
    logger.error({ type, offending }, message);
  } else {
    throw new Error(message);
  }
}

/**
 * Persists a notification and pushes it to the recipient if connected.
 *
 * Never throws on delivery failure: a notification is a side effect of a
 * clinical action, and failing the action because a socket was unavailable
 * would be strictly worse than a late notification.
 *
 * @param {object} params
 * @param {string} params.recipientId
 * @param {string} params.type            notification_type enum value
 * @param {object} [params.payload]       ids and enums ONLY
 * @param {string} [params.visitId]
 * @param {string} [params.consultationId]
 */
export async function notify({ recipientId, type, payload = {}, visitId, consultationId }) {
  if (!recipientId) return null;

  try {
    assertNoPhi(payload, type);

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert({
        recipient_id: recipientId,
        type,
        payload,
        visit_id: visitId ?? null,
        consultation_id: consultationId ?? null,
      })
      .select('*')
      .single();

    if (error) {
      logger.error({ err: error, type, recipientId }, 'Notification insert failed');
      return null;
    }

    const event = EVENT_FOR_TYPE[type] ?? EVENTS.NOTIFICATION;
    const body = {
      id: data.id,
      type,
      payload,
      visitId: visitId ?? null,
      consultationId: consultationId ?? null,
      createdAt: data.created_at,
    };

    const pushed = emitToUser(recipientId, event, body);
    // Also fire the generic channel so a client can keep one listener for
    // its notification tray without enumerating every specific event.
    if (event !== EVENTS.NOTIFICATION) emitToUser(recipientId, EVENTS.NOTIFICATION, body);

    if (pushed) {
      await supabaseAdmin
        .from('notifications')
        .update({ delivered_via: ['socket'] })
        .eq('id', data.id);
    }

    logger.info({ type, recipientId, notificationId: data.id, pushed }, 'Notification dispatched');
    return data.id;
  } catch (err) {
    logger.error({ err, type, recipientId }, 'Notification dispatch threw');
    return null;
  }
}

/** Fire-and-forget for hot clinical paths where awaiting adds latency. */
export function notifyAsync(params) {
  notify(params).catch((err) =>
    logger.error({ err, type: params?.type }, 'Async notification threw'),
  );
}

/** The caller's own notifications. RLS restricts this to the recipient. */
export async function listForUser({ accessToken, unreadOnly = false, limit = 50 }) {
  const client = supabaseAsUser(accessToken);

  let query = client
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.is('read_at', null);

  const { data, error } = await query;
  if (error) throw ApiError.badRequest(error.message);

  return (data ?? []).map((n) => ({
    id: n.id,
    type: n.type,
    payload: n.payload,
    visitId: n.visit_id,
    consultationId: n.consultation_id,
    readAt: n.read_at,
    createdAt: n.created_at,
  }));
}

/** Marks one notification read. RLS ensures it is the caller's own. */
export async function markRead({ accessToken, notificationId }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .is('read_at', null)
    .select('id, read_at')
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Notification not found, or already read');

  return { id: data.id, readAt: data.read_at };
}

/** Marks every unread notification read. */
export async function markAllRead({ accessToken }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)
    .select('id');

  if (error) throw ApiError.badRequest(error.message);
  return { markedRead: (data ?? []).length };
}

export default { notify, notifyAsync, listForUser, markRead, markAllRead };
