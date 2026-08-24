/**
 * Socket.IO authentication and delivery — against a REAL server.
 *
 * Boots the actual HTTP server with the real socket layer, connects real
 * clients over the wire, and asserts two things no unit test can:
 *   1. An unauthenticated or forged token is REJECTED at the handshake.
 *   2. An event emitted for user A reaches A and NOT user B.
 *
 * The second is the one that matters: room isolation is what stops one
 * clinician's notifications appearing on another's screen, and it depends
 * on the server joining rooms from the verified profile rather than from
 * anything the client sent.
 */
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';

import app from '../app.js';
import { initSockets, closeSockets, emitToUser, EVENTS } from '../sockets/index.js';
import { seedLiveAuth } from './helpers/liveAuthFixture.js';
import { closePool } from '../config/db.js';

let server;
let port;
let fxA;
let fxB;
let setupError = null;

beforeAll(async () => {
  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
    await initSockets(server);

    // Two independent real accounts, each with a genuine access token.
    fxA = await seedLiveAuth();
    fxB = await seedLiveAuth();
  } catch (err) {
    setupError = err;
  }
}, 120_000);

afterAll(async () => {
  await closeSockets().catch(() => {});
  await new Promise((resolve) => server?.close(resolve));
  await fxA?.teardown().catch(() => {});
  await fxB?.teardown().catch(() => {});
  await closePool();
}, 60_000);

/** Connects a client and resolves once connected, or rejects on error. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 15_000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

describe('setup', () => {
  it('booted the server and seeded two real accounts', () => {
    expect(setupError).toBeNull();
    expect(fxA.accessToken).toEqual(expect.any(String));
    expect(fxB.accessToken).toEqual(expect.any(String));
  });
});

describe('handshake authentication', () => {
  it('REJECTS a connection with no token', async () => {
    await expect(connect(null)).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('REJECTS a garbage token', async () => {
    await expect(connect('not-a-real-jwt')).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('REJECTS a structurally valid but unsigned JWT', async () => {
    // Header/payload that look right but carry no valid signature — the
    // shape alone must not be enough to get in.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(JSON.stringify({ sub: fxA.profileId, role: 'authenticated' })).toString(
        'base64url',
      ) +
      '.forged';
    await expect(connect(forged)).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('ACCEPTS a real access token', async () => {
    const socket = await connect(fxA.accessToken);
    expect(socket.connected).toBe(true);
    socket.close();
  });
});

describe('room isolation', () => {
  let socketA;
  let socketB;

  beforeAll(async () => {
    socketA = await connect(fxA.accessToken);
    socketB = await connect(fxB.accessToken);
  }, 60_000);

  afterAll(() => {
    socketA?.close();
    socketB?.close();
  });

  it('delivers an event to its intended recipient', async () => {
    const received = new Promise((resolve) => {
      socketA.once(EVENTS.NOTIFICATION, resolve);
    });

    emitToUser(fxA.profileId, EVENTS.NOTIFICATION, { id: 'n-1', type: 'assessment_ready' });

    await expect(received).resolves.toMatchObject({ id: 'n-1' });
  });

  it('does NOT deliver one user\'s event to another user', async () => {
    let leaked = null;
    socketB.once(EVENTS.NOTIFICATION, (payload) => {
      leaked = payload;
    });

    emitToUser(fxA.profileId, EVENTS.NOTIFICATION, { id: 'n-2', type: 'assessment_ready' });

    // Give the event ample time to arrive if isolation were broken.
    await new Promise((r) => setTimeout(r, 1500));
    expect(leaked).toBeNull();
  });

  it('a client cannot subscribe to a visit it cannot reach', async () => {
    const result = await new Promise((resolve) => {
      // fxB's assistant belongs to a different facility entirely.
      socketB.emit('visit:subscribe', fxA.ids.patientA, resolve);
    });

    expect(result.ok).toBe(false);
  });
});
