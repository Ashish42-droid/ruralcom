/**
 * Manual, real-network smoke test for LiveKit.
 *
 * `npm run livekit:check`
 *
 * Confirms the credentials actually authenticate against LiveKit Cloud and
 * that room create/list/delete works — token generation itself needs no
 * network (it is local JWT signing, tested for real in tests/livekit.test.js),
 * so this is specifically about the RoomServiceClient half.
 */
import { randomUUID } from 'node:crypto';
import * as livekit from '../services/video/livekit.js';
import env from '../config/env.js';

async function main() {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error(
      '\nLIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not all set in .env.\n' +
        'Nothing to test. Copy the values from the LiveKit Cloud dashboard.\n',
    );
    process.exit(1);
  }

  const visitId = `smoke-${randomUUID()}`;
  console.log(`\nLiveKit smoke test — ${env.LIVEKIT_URL}\n`);

  try {
    process.stdout.write('Authenticating and listing rooms ... ');
    const ping = await livekit.pingLiveKit();
    console.log(`ok (${ping.latencyMs}ms)`);

    process.stdout.write('Creating a room ... ');
    const room = await livekit.ensureRoom(visitId);
    console.log(`ok (name=${room.name})`);

    process.stdout.write('Minting a join token ... ');
    const token = await livekit.createJoinToken({
      visitId,
      identity: 'smoke-test-user',
      displayName: 'Smoke Test',
      role: 'doctor',
    });
    console.log(`ok (${token.token.length} chars, expires in ${token.expiresInSeconds}s)`);

    process.stdout.write('Cleaning up the test room ... ');
    await livekit.closeRoom(visitId);
    console.log('ok');

    console.log('\nAll checks passed.\n');
  } catch (err) {
    console.error(`\nFAILED: ${err.message}\n`);
    process.exit(1);
  }
}

main();
