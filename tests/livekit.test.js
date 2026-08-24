/**
 * LiveKit token generation.
 *
 * Unlike the Groq adapter, this code needs NO mocking to test for real: an
 * access token is a signed JWT minted entirely with the local secret. Only
 * `ensureRoom` / `closeRoom` / `pingLiveKit` touch the network (via
 * RoomServiceClient), and those are exercised for real by
 * `npm run livekit:check` instead — the same split as the Groq smoke test.
 */
import jwt from 'jsonwebtoken';

// Values are test-only fixtures, not real credentials.
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-api-key';
process.env.LIVEKIT_API_SECRET = 'test-api-secret-at-least-32-bytes-long';

const { createJoinToken, roomNameForVisit, isConfigured } = await import(
  '../services/video/livekit.js'
);

const VISIT_ID = '11111111-1111-1111-1111-111111111111';

describe('roomNameForVisit', () => {
  it('derives a stable, deterministic room name from a visit id', () => {
    expect(roomNameForVisit(VISIT_ID)).toBe(`visit-${VISIT_ID}`);
    // Same visit must always produce the same room, so a doctor and
    // assistant calling this independently land in the same room.
    expect(roomNameForVisit(VISIT_ID)).toBe(roomNameForVisit(VISIT_ID));
  });

  it('throws without a visitId rather than minting a token for an undefined room', () => {
    expect(() => roomNameForVisit()).toThrow(TypeError);
  });
});

describe('createJoinToken', () => {
  it('mints a token containing the room grant', async () => {
    const result = await createJoinToken({
      visitId: VISIT_ID,
      identity: 'profile-abc',
      displayName: 'Asha Devi',
      role: 'clinical_assistant',
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.roomName).toBe(`visit-${VISIT_ID}`);
    expect(result.url).toBe('wss://test.livekit.cloud');
    expect(result.expiresInSeconds).toBeGreaterThan(0);

    const decoded = jwt.verify(result.token, process.env.LIVEKIT_API_SECRET);
    expect(decoded.video.room).toBe(`visit-${VISIT_ID}`);
    expect(decoded.video.roomJoin).toBe(true);
    expect(decoded.sub).toBe('profile-abc');
    expect(decoded.name).toBe('Asha Devi');
  });

  it('is signed with the configured secret, verifiable independently', async () => {
    const result = await createJoinToken({
      visitId: VISIT_ID,
      identity: 'x',
      displayName: 'x',
      role: 'doctor',
    });

    // A token signed with the wrong secret must NOT verify — this is the
    // property that makes it safe to hand to a client.
    expect(() => jwt.verify(result.token, 'wrong-secret')).toThrow();
  });

  it.each(['clinical_assistant', 'doctor', 'senior_doctor'])(
    'grants publish rights to clinical role %s',
    async (role) => {
      const result = await createJoinToken({
        visitId: VISIT_ID, identity: 'x', displayName: 'x', role,
      });
      const decoded = jwt.verify(result.token, process.env.LIVEKIT_API_SECRET);
      expect(decoded.video.canPublish).toBe(true);
    },
  );

  it('denies publish rights to a non-clinical role', async () => {
    const result = await createJoinToken({
      visitId: VISIT_ID, identity: 'x', displayName: 'x', role: 'auditor',
    });
    const decoded = jwt.verify(result.token, process.env.LIVEKIT_API_SECRET);

    // No caller reaches this branch today (the route only allows clinical
    // roles), but the token itself must not grant publish even if some
    // future caller did.
    expect(decoded.video.canPublish).toBe(false);
    expect(decoded.video.canSubscribe).toBe(true);
  });

  it('two participants in the same visit get tokens for the same room', async () => {
    const assistant = await createJoinToken({
      visitId: VISIT_ID, identity: 'assistant-1', displayName: 'A', role: 'clinical_assistant',
    });
    const doctor = await createJoinToken({
      visitId: VISIT_ID, identity: 'doctor-1', displayName: 'D', role: 'doctor',
    });

    expect(assistant.roomName).toBe(doctor.roomName);
  });

  it('rejects a call with no identity', async () => {
    await expect(
      createJoinToken({ visitId: VISIT_ID, displayName: 'x', role: 'doctor' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('isConfigured — the pure guard behind requireConfig', () => {
  it('true only when all three are present', () => {
    expect(isConfigured({ url: 'a', apiKey: 'b', apiSecret: 'c' })).toBe(true);
  });

  it.each([
    ['url', { apiKey: 'b', apiSecret: 'c' }],
    ['apiKey', { url: 'a', apiSecret: 'c' }],
    ['apiSecret', { url: 'a', apiKey: 'b' }],
    ['all three', {}],
  ])('false when %s is missing', (_label, partial) => {
    expect(isConfigured(partial)).toBe(false);
  });

  it('treats an empty string the same as absent', () => {
    expect(isConfigured({ url: '', apiKey: 'b', apiSecret: 'c' })).toBe(false);
  });
});
