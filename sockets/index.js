/**
 * Socket.IO realtime layer.
 *
 * AUTH: every connection must present a valid Supabase access token in the
 * handshake. The token is verified against Supabase (same path as the HTTP
 * `authenticate` middleware), and the socket is then joined to rooms
 * derived from the VERIFIED profile — never from anything the client sent.
 * A client cannot subscribe to another user's events by guessing a room
 * name, because it never gets to name a room at all.
 *
 * MULTI-INSTANCE: the Redis adapter is what makes this work behind a load
 * balancer. Without it, an event emitted on instance A never reaches a
 * doctor whose socket is held by instance B — and the failure is silent
 * and load-dependent, so it looks fine in development and breaks in
 * production exactly when it matters.
 *
 * NO PHI OVER THE WIRE: payloads carry ids and enum values only. Clients
 * fetch the record itself through the normal RLS-protected endpoints.
 */
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

import { supabaseAdmin } from '../config/supabase.js';
import { createRedisConnection, isRedisConfigured } from '../config/redis.js';
import env from '../config/env.js';
import logger from '../config/logger.js';
import { EVENTS, rooms } from './events.js';

let io = null;
// Held so shutdown can close them. Without this the adapter's Redis
// connections keep the event loop alive and every graceful shutdown hits
// server.js's force-exit timer instead of exiting cleanly.
let adapterClients = [];

/**
 * Resolves a token to a profile plus the scope its rooms derive from.
 * Mirrors middlewares/authenticate.js, including the deactivated check.
 */
async function authenticateSocket(token) {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_active')
    .eq('id', data.user.id)
    .single();

  if (!profile || !profile.is_active) return null;

  // Scope lookup mirrors the JWT claims hook: an assistant is bound to a
  // facility, a doctor to a district.
  let facilityId = null;
  let districtId = null;

  if (profile.role === 'clinical_assistant') {
    const { data: ca } = await supabaseAdmin
      .from('clinical_assistants')
      .select('facility_id, facilities(district_id)')
      .eq('profile_id', profile.id)
      .maybeSingle();
    facilityId = ca?.facility_id ?? null;
    districtId = ca?.facilities?.district_id ?? null;
  } else if (['doctor', 'senior_doctor'].includes(profile.role)) {
    const { data: doc } = await supabaseAdmin
      .from('doctors')
      .select('district_id')
      .eq('profile_id', profile.id)
      .maybeSingle();
    districtId = doc?.district_id ?? null;
  }

  return { id: profile.id, role: profile.role, fullName: profile.full_name, facilityId, districtId };
}

/**
 * Attaches Socket.IO to an existing HTTP server.
 * @param {import('node:http').Server} httpServer
 */
export async function initSockets(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.corsOrigins, credentials: true },
    // Rural connections drop and resume constantly; be patient before
    // declaring a client gone.
    pingTimeout: 30_000,
    pingInterval: 25_000,
  });

  if (isRedisConfigured) {
    const pubClient = createRedisConnection('socket-pub');
    const subClient = createRedisConnection('socket-sub');
    adapterClients = [pubClient, subClient];
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO Redis adapter attached — events fan out across instances');
  } else {
    logger.warn(
      'REDIS_URL is not configured — Socket.IO is running WITHOUT the Redis ' +
        'adapter. With more than one API instance, realtime events will only ' +
        'reach clients connected to the instance that emitted them.',
    );
  }

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer /, '');

      if (!token) return next(new Error('UNAUTHENTICATED'));

      const user = await authenticateSocket(token);
      if (!user) return next(new Error('UNAUTHENTICATED'));

      socket.data.user = user;
      return next();
    } catch (err) {
      logger.error({ err }, 'Socket authentication threw');
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;

    // Rooms are joined from the VERIFIED profile. The client never names a
    // room, so it cannot subscribe to another user's stream.
    socket.join(rooms.user(user.id));
    if (user.facilityId) socket.join(rooms.facility(user.facilityId));
    if (user.districtId) socket.join(rooms.district(user.districtId));

    logger.info(
      { profileId: user.id, role: user.role, socketId: socket.id },
      'Socket connected',
    );

    // A client may follow a specific visit, but only one it can already
    // reach — checked server-side against RLS-equivalent scope.
    socket.on('visit:subscribe', async (visitId, ack) => {
      try {
        const { data: visit } = await supabaseAdmin
          .from('visits')
          .select('id, facility_id, facilities(district_id)')
          .eq('id', visitId)
          .maybeSingle();

        if (!visit) return ack?.({ ok: false, error: 'NOT_FOUND' });

        const permitted =
          (user.role === 'clinical_assistant' && visit.facility_id === user.facilityId) ||
          (['doctor', 'senior_doctor'].includes(user.role) &&
            visit.facilities?.district_id === user.districtId);

        if (!permitted) return ack?.({ ok: false, error: 'FORBIDDEN' });

        socket.join(rooms.visit(visitId));
        return ack?.({ ok: true });
      } catch (err) {
        logger.error({ err, visitId }, 'visit:subscribe failed');
        return ack?.({ ok: false, error: 'ERROR' });
      }
    });

    socket.on('visit:unsubscribe', (visitId, ack) => {
      socket.leave(rooms.visit(visitId));
      ack?.({ ok: true });
    });

    socket.on('disconnect', (reason) => {
      logger.info({ profileId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  logger.info('Socket.IO initialised');
  return io;
}

/** Emits to one user's room. No-op when sockets are not initialised. */
export function emitToUser(profileId, event, payload) {
  if (!io || !profileId) return false;
  io.to(rooms.user(profileId)).emit(event, payload);
  return true;
}

export function emitToFacility(facilityId, event, payload) {
  if (!io || !facilityId) return false;
  io.to(rooms.facility(facilityId)).emit(event, payload);
  return true;
}

export function emitToVisit(visitId, event, payload) {
  if (!io || !visitId) return false;
  io.to(rooms.visit(visitId)).emit(event, payload);
  return true;
}

/** True when at least one socket is in a user's room, on ANY instance. */
export async function isUserConnected(profileId) {
  if (!io) return false;
  const sockets = await io.in(rooms.user(profileId)).fetchSockets();
  return sockets.length > 0;
}

export async function closeSockets() {
  await io?.close();

  // Close the adapter's Redis connections too — `io.close()` does not own
  // them, and leaving them open keeps the process alive after shutdown.
  await Promise.all(adapterClients.map((c) => c.quit().catch(() => {})));

  adapterClients = [];
  io = null;
}

export { EVENTS, rooms };
export default { initSockets, emitToUser, emitToFacility, emitToVisit, closeSockets };
