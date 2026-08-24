/**
 * STT failover and provider logging.
 *
 * The orchestration layer is real and tested here against fakes. The two
 * adapters that would call an external API are stubs that throw — and that
 * is asserted, so nobody can quietly "fix" the suite by returning a fake
 * transcript.
 */
import {
  SttService,
  createSttService,
  AllProvidersFailedError,
} from '../services/stt/index.js';
import {
  SttProvider,
  SUPPORTED_LANGUAGES,
  NotImplementedError,
  UnsupportedLanguageError,
} from '../services/stt/SttProvider.js';
import { BhashiniAdapter, GoogleSttAdapter } from '../services/stt/adapters.js';

const AUDIO = Buffer.from('fake audio bytes');

/** A provider that succeeds. */
class FakeGood extends SttProvider {
  constructor(name = 'fake-good', languages = ['hi', 'bn', 'ta', 'en']) {
    super(name, languages);
  }
  async _transcribe() {
    return { text: 'बुखार और खांसी', confidence: 0.92 };
  }
}

/** A provider that always fails. */
class FakeBad extends SttProvider {
  constructor(name = 'fake-bad', languages = ['hi', 'bn', 'ta', 'en']) {
    super(name, languages);
  }
  async _transcribe() {
    throw new Error('upstream 503');
  }
}

describe('the adapters are deliberately NOT implemented', () => {
  it('BhashiniAdapter throws NotImplemented', async () => {
    await expect(new BhashiniAdapter().transcribe(AUDIO, 'hi')).rejects.toThrow(
      NotImplementedError,
    );
  });

  it('GoogleSttAdapter throws NotImplemented', async () => {
    await expect(new GoogleSttAdapter().transcribe(AUDIO, 'hi')).rejects.toThrow(
      NotImplementedError,
    );
  });

  it('names the credentials each one needs', async () => {
    await expect(new BhashiniAdapter().transcribe(AUDIO, 'hi')).rejects.toThrow(
      /BHASHINI_USER_ID/,
    );
    await expect(new GoogleSttAdapter().transcribe(AUDIO, 'hi')).rejects.toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS/,
    );
  });

  it('a stub-only chain fails for every demo language', async () => {
    const service = createSttService({ BHASHINI_API_KEY: 'x', GOOGLE_PROJECT_ID: 'y' });
    for (const language of Object.keys(SUPPORTED_LANGUAGES)) {
      await expect(service.transcribe(AUDIO, language)).rejects.toThrow(
        AllProvidersFailedError,
      );
    }
  });
});

describe('demo language coverage', () => {
  it('supports Hindi, Bengali, Tamil and English', () => {
    expect(Object.keys(SUPPORTED_LANGUAGES).sort()).toEqual(['bn', 'en', 'hi', 'ta']);
  });

  it('no longer accepts Bhojpuri', async () => {
    const service = createSttService({ GROQ_API_KEY: 'x' });
    expect(SUPPORTED_LANGUAGES.bho).toBeUndefined();
    await expect(service.transcribe(AUDIO, 'bho')).rejects.toThrow(
      UnsupportedLanguageError,
    );
  });

  it('Groq Whisper covers every demo language', () => {
    const service = createSttService({ GROQ_API_KEY: 'x' });
    for (const language of Object.keys(SUPPORTED_LANGUAGES)) {
      expect(service.candidatesFor(language).map((p) => p.name)).toEqual(['groq-whisper']);
    }
  });

  it('builds the chain from configuration, not unconditionally', () => {
    // The stubs are only included once they actually have credentials, so
    // an unconfigured provider never sits in the chain failing on every
    // request just to be skipped.
    expect(createSttService({ GROQ_API_KEY: 'x' }).providers.map((p) => p.name))
      .toEqual(['groq-whisper']);

    expect(
      createSttService({ GROQ_API_KEY: 'x', BHASHINI_API_KEY: 'y', GOOGLE_PROJECT_ID: 'z' })
        .providers.map((p) => p.name),
    ).toEqual(['groq-whisper', 'bhashini', 'google']);
  });

  it('returns null when nothing is configured', () => {
    // The intake layer reads null as "voice unavailable" and says so,
    // rather than storing an untranscribed entry.
    expect(createSttService({})).toBeNull();
  });
});

describe('failover', () => {
  it('uses the primary when it works', async () => {
    const service = new SttService([new FakeGood('primary'), new FakeGood('secondary')]);
    const result = await service.transcribe(AUDIO, 'hi');

    expect(result.provider).toBe('primary');
    expect(result.attempts).toHaveLength(1);
  });

  it('falls through to the secondary when the primary fails', async () => {
    const service = new SttService([new FakeBad('primary'), new FakeGood('secondary')]);
    const result = await service.transcribe(AUDIO, 'hi');

    expect(result.provider).toBe('secondary');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ provider: 'primary', ok: false });
    expect(result.attempts[1]).toMatchObject({ provider: 'secondary', ok: true });
  });

  it('throws rather than returning an empty transcript when all fail', async () => {
    const service = new SttService([new FakeBad('a'), new FakeBad('b')]);

    // Downstream triage cannot distinguish a bad transcript from a real one,
    // so a guessed or empty result would be worse than an error.
    await expect(service.transcribe(AUDIO, 'hi')).rejects.toThrow(AllProvidersFailedError);
  });

  it('SKIPS a provider that lacks the language rather than substituting', async () => {
    const hindiOnly = new FakeGood('hindi-only', ['hi']);
    const tamilCapable = new FakeGood('tamil-capable', ['ta']);
    const service = new SttService([hindiOnly, tamilCapable]);

    const result = await service.transcribe(AUDIO, 'ta');

    // Transcribing one language with another's model produces plausible,
    // wrong symptom text — a clinical risk, not a cosmetic one. This is a
    // safety property of the chain, independent of which languages ship.
    expect(result.provider).toBe('tamil-capable');
    expect(result.attempts).toHaveLength(1);
  });

  it('fails when no provider supports the language at all', async () => {
    const service = new SttService([new FakeGood('english-only', ['en'])]);
    await expect(service.transcribe(AUDIO, 'ta')).rejects.toThrow(AllProvidersFailedError);
  });

  it('rejects a language outside the supported set', async () => {
    const service = new SttService([new FakeGood()]);
    await expect(service.transcribe(AUDIO, 'fr')).rejects.toThrow(UnsupportedLanguageError);
  });
});

describe('result shape', () => {
  it('returns text, confidence, provider, latency and language', async () => {
    const service = new SttService([new FakeGood()]);
    const result = await service.transcribe(AUDIO, 'ta');

    expect(result).toMatchObject({
      text: expect.any(String),
      confidence: expect.any(Number),
      provider: 'fake-good',
      language: 'ta',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects empty audio', async () => {
    const service = new SttService([new FakeGood()]);
    await expect(service.transcribe(Buffer.alloc(0), 'hi')).rejects.toThrow(TypeError);
  });

  it('cannot be constructed with no providers', () => {
    expect(() => new SttService([])).toThrow(TypeError);
  });
});
