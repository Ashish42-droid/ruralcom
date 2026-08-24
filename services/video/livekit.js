/**
 * LiveKit video consultation — room and token management.
 *
 * SCOPE OF THIS FILE: the LiveKit integration primitives only — creating a
 * room and minting a join token with role-appropriate permissions. This is
 * what "wire up LiveKit" concretely means at the SDK level.
 *
 * NOT YET BUILT, and deliberately out of scope here (see
 * docs/DECISIONS.md D-039 for the full list):
 *   - The `consultations` DB table and its RLS policies
 *   - Scheduling logic: doctor selection by disease category, load balancing
 *   - The 5-minute tolerance window and auto-reassignment on missed calls
 *   - Realtime notifications to both parties (needs sockets/, not built yet)
 *   - The "one active call per doctor" constraint
 * Those need a `consultations` schema and, for the tolerance window, a job
 * queue (BullMQ + Redis, REDIS_URL not yet configured) — building them now
 * without that foundation would mean redoing them shortly after. This file
 * is the piece that has no such dependency and is fully usable today.
 *
 * WHY TOKEN GENERATION NEEDS NO NETWORK CALL: a LiveKit access token is a
 * self-contained signed JWT — the secret signs it locally, exactly like the
 * app's own session tokens. LiveKit's servers only see it when the client
 * uses it to connect. That is why tests/livekit.test.js requires no mocked
 * fetch, unlike the Groq adapter: this is genuinely offline-testable code,
 * not code that happens to be faked out in tests.
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

import env from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';

/** How long a join token remains valid after being minted. */
const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — a consultation should never run this long

/**
 * Pure check — deliberately takes explicit values rather than reading
 * `env` itself, so it is testable without touching process.env or
 * fighting dotenv's re-population of any key that becomes absent.
 */
export function isConfigured({ url, apiKey, apiSecret }) {
  return Boolean(url && apiKey && apiSecret);
}

function requireConfig() {
  if (!isConfigured({ url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET })) {
    throw ApiError.serviceUnavailable(
      'Video consultation is not configured',
      { code: 'LIVEKIT_NOT_CONFIGURED' },
    );
  }
}

/** Deterministic room name for one visit's consultation. Stable and re-derivable. */
export function roomNameForVisit(visitId) {
  if (!visitId) throw new TypeError('visitId is required');
  return `visit-${visitId}`;
}

/**
 * Mints a signed join token for one participant.
 *
 * Permissions are role-shaped, not just "can join":
 *   - `clinical_assistant` / `doctor` / `senior_doctor`: can publish and
 *     subscribe to audio/video — an active consultation participant.
 *   - anything else: subscribe only, cannot publish. There is no current
 *     caller for this (no observer role exists yet), but the branch exists
 *     so adding one later is a data change, not a new code path.
 *
 * @param {object} params
 * @param {string} params.visitId
 * @param {string} params.identity     stable id for this participant, e.g. profile id
 * @param {string} params.displayName  shown in the LiveKit UI
 * @param {string} params.role         the caller's app role
 * @returns {Promise<{token: string, url: string, roomName: string, expiresInSeconds: number}>}
 */
export async function createJoinToken({ visitId, identity, displayName, role }) {
  requireConfig();

  if (!identity) throw new TypeError('identity is required');

  const roomName = roomNameForVisit(visitId);
  const canPublish = ['clinical_assistant', 'doctor', 'senior_doctor'].includes(role);

  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    name: displayName,
    ttl: TOKEN_TTL_SECONDS,
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    // A health worker's tablet on a poor connection should not need to
    // reconnect with a fresh token mid-call.
    canUpdateOwnMetadata: true,
  });

  const token = await at.toJwt();

  return {
    token,
    url: env.LIVEKIT_URL,
    roomName,
    expiresInSeconds: TOKEN_TTL_SECONDS,
  };
}

let cachedClient = null;

/** Lazily constructed — avoids touching env/config at import time for callers who never need it. */
function roomService() {
  requireConfig();
  if (!cachedClient) {
    cachedClient = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }
  return cachedClient;
}

/**
 * Ensures a room exists for a visit. Idempotent — LiveKit rooms are created
 * implicitly on first join anyway, but creating explicitly lets us set
 * `emptyTimeout` and confirm credentials before a doctor is staring at a
 * blank screen.
 */
export async function ensureRoom(visitId, { emptyTimeoutSeconds = 300 } = {}) {
  const roomName = roomNameForVisit(visitId);
  const client = roomService();

  const rooms = await client.listRooms([roomName]);
  if (rooms.length > 0) return rooms[0];

  return client.createRoom({
    name: roomName,
    emptyTimeout: emptyTimeoutSeconds,
    maxParticipants: 4, // doctor + assistant, headroom for a supervising senior doctor
  });
}

/** Ends a consultation for everyone, e.g. when a visit is force-closed. */
export async function closeRoom(visitId) {
  const roomName = roomNameForVisit(visitId);
  await roomService().deleteRoom(roomName);
}

/** Liveness check: confirms the credentials actually authenticate against LiveKit. */
export async function pingLiveKit() {
  const startedAt = Date.now();
  await roomService().listRooms();
  return { ok: true, latencyMs: Date.now() - startedAt };
}

export default { createJoinToken, ensureRoom, closeRoom, roomNameForVisit, pingLiveKit };
