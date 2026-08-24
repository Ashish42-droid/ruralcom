/**
 * Realtime event names and room naming.
 *
 * Centralised so the server and any client agree on the exact strings, and
 * so a rename is one edit rather than a grep.
 */

/** Server -> client events. */
export const EVENTS = Object.freeze({
  // Consultations
  CONSULTATION_SCHEDULED: 'consultation:scheduled',
  CONSULTATION_RINGING: 'consultation:ringing',
  CONSULTATION_JOINED: 'consultation:joined',
  CONSULTATION_MISSED: 'consultation:missed',
  CONSULTATION_REASSIGNED: 'consultation:reassigned',
  CONSULTATION_COMPLETED: 'consultation:completed',

  // Assessments and review
  ASSESSMENT_READY: 'assessment:ready',
  REVIEW_FLAGGED: 'review:flagged',
  REVIEW_APPROVED: 'review:approved',

  // Queue / dashboard hints
  QUEUE_UPDATED: 'queue:updated',

  // Generic durable notification
  NOTIFICATION: 'notification',
});

/**
 * Room names.
 *
 * `user` is the workhorse: notifications are per-recipient, and a room
 * scoped to one profile means a socket cannot subscribe to someone else's
 * events even by guessing a name — joining is server-side, driven by the
 * verified JWT, never by a client-supplied string.
 */
export const rooms = Object.freeze({
  user: (profileId) => `user:${profileId}`,
  facility: (facilityId) => `facility:${facilityId}`,
  district: (districtId) => `district:${districtId}`,
  visit: (visitId) => `visit:${visitId}`,
});

export default { EVENTS, rooms };
