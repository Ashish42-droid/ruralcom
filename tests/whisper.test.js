/**
 * Groq Whisper adapter — the anti-hallucination guards.
 *
 * Whisper invents fluent, plausible text when given silence or noise.
 * Everywhere else that is a curiosity; here the output becomes a patient's
 * symptom description and feeds the triage engine, so these guards are the
 * point of the adapter rather than a detail of it.
 *
 * Network is mocked throughout — no test spends the owner's Groq quota.
 */
import {
  GroqWhisperAdapter,
  SttRejectedError,
  confidenceFromLogprob,
  NO_SPEECH_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from '../services/stt/groqWhisper.js';

const AUDIO = Buffer.from('fake wav bytes');

/** Builds a fake fetch returning a Whisper verbose_json body. */
function fakeWhisper(body, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const goodBody = {
  text: ' बुखार और खांसी तीन दिन से',
  language: 'Hindi',
  duration: 4.2,
  segments: [{ avg_logprob: -0.15, no_speech_prob: 0.01 }],
};

describe('confidenceFromLogprob', () => {
  it('maps a strong log-probability to high confidence', () => {
    expect(confidenceFromLogprob(-0.1)).toBeGreaterThan(0.9);
  });

  it('maps a poor log-probability to low confidence', () => {
    expect(confidenceFromLogprob(-2.5)).toBeLessThan(0.15);
  });

  it('returns 0 for a missing value rather than NaN', () => {
    expect(confidenceFromLogprob(undefined)).toBe(0);
    expect(confidenceFromLogprob(null)).toBe(0);
  });

  it('never exceeds 1', () => {
    expect(confidenceFromLogprob(2)).toBe(1);
  });
});

describe('configuration', () => {
  it('refuses to construct without an API key', () => {
    expect(() => new GroqWhisperAdapter({})).toThrow(TypeError);
  });

  it('supports the four demo languages and nothing else', () => {
    const a = new GroqWhisperAdapter({ apiKey: 'x' });
    for (const lang of ['hi', 'bn', 'ta', 'en']) expect(a.supports(lang)).toBe(true);
    expect(a.supports('bho')).toBe(false);
  });
});

describe('a good transcription', () => {
  it('returns the text with a confidence and provenance', async () => {
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(goodBody) });
    const result = await a.transcribe(AUDIO, 'hi');

    expect(result.text).toBe('बुखार और खांसी तीन दिन से');
    expect(result.provider).toBe('groq-whisper');
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.needsHumanConfirmation).toBe(false);
    expect(result.durationSeconds).toBe(4.2);
  });

  it('requests verbose_json — the plain format omits the safety signals', async () => {
    let captured;
    const fetchImpl = async (_url, init) => {
      captured = init;
      return fakeWhisper(goodBody)();
    };

    await new GroqWhisperAdapter({ apiKey: 'secret', fetchImpl }).transcribe(AUDIO, 'hi');

    expect(captured.headers.Authorization).toBe('Bearer secret');
    expect(captured.body.get('response_format')).toBe('verbose_json');
    expect(captured.body.get('language')).toBe('hi');
  });
});

describe('hallucination guards', () => {
  it('REJECTS audio the model says contains no speech', async () => {
    // A pure tone really does return ~0.98 from the live API, alongside a
    // confidently wrong Hindi word. Storing that as a symptom description
    // would invent a complaint the patient never made.
    const body = {
      text: ' प्राप्ति',
      segments: [{ avg_logprob: -0.6, no_speech_prob: 0.977 }],
    };
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(body) });

    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(SttRejectedError);
    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(/No speech detected/);
  });

  it('uses the WORST segment, not the average', async () => {
    // One hallucinated stretch in an otherwise clean recording is still a
    // fabricated symptom, so a good average must not mask it.
    const body = {
      text: 'some real speech and then noise',
      segments: [
        { avg_logprob: -0.1, no_speech_prob: 0.01 },
        { avg_logprob: -0.2, no_speech_prob: 0.95 },
      ],
    };
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(body) });
    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(SttRejectedError);
  });

  it('accepts audio just under the no-speech threshold', async () => {
    const body = {
      text: 'quiet but real speech',
      segments: [{ avg_logprob: -0.3, no_speech_prob: NO_SPEECH_THRESHOLD - 0.01 }],
    };
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(body) });
    await expect(a.transcribe(AUDIO, 'hi')).resolves.toMatchObject({ text: 'quiet but real speech' });
  });

  it('FLAGS a low-confidence transcript instead of trusting it', async () => {
    const body = {
      text: 'mumbled and unclear',
      segments: [{ avg_logprob: -2.0, no_speech_prob: 0.05 }],
    };
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(body) });
    const result = await a.transcribe(AUDIO, 'hi');

    // Returned, not rejected — the health worker reads it back to the
    // patient rather than the system silently discarding real speech.
    expect(result.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    expect(result.needsHumanConfirmation).toBe(true);
  });

  it('rejects an empty transcript', async () => {
    const body = { text: '   ', segments: [{ avg_logprob: -0.1, no_speech_prob: 0.02 }] };
    const a = new GroqWhisperAdapter({ apiKey: 'x', fetchImpl: fakeWhisper(body) });
    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(/no text/);
  });

  it('treats a response with no segments as untrustworthy', async () => {
    // Without segments there are no safety signals at all, so confidence
    // must not default to something reassuring.
    const a = new GroqWhisperAdapter({
      apiKey: 'x',
      fetchImpl: fakeWhisper({ text: 'something', segments: [] }),
    });
    const result = await a.transcribe(AUDIO, 'hi');
    expect(result.needsHumanConfirmation).toBe(true);
  });
});

describe('transport failures', () => {
  it('throws on a non-2xx response', async () => {
    const a = new GroqWhisperAdapter({
      apiKey: 'x',
      fetchImpl: fakeWhisper({ error: 'rate limited' }, { ok: false, status: 429 }),
    });
    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(/HTTP 429/);
  });

  it('throws a clear error on a network failure', async () => {
    const a = new GroqWhisperAdapter({
      apiKey: 'x',
      fetchImpl: async () => { throw new Error('ENOTFOUND api.groq.com'); },
    });
    await expect(a.transcribe(AUDIO, 'hi')).rejects.toThrow(/Groq Whisper request failed/);
  });

  it('rejects empty audio before making any request', async () => {
    let called = false;
    const a = new GroqWhisperAdapter({
      apiKey: 'x',
      fetchImpl: async () => { called = true; return fakeWhisper(goodBody)(); },
    });

    await expect(a.transcribe(Buffer.alloc(0), 'hi')).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });
});
