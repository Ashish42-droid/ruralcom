/**
 * Groq Whisper — the working STT provider.
 *
 * Chosen because it is genuinely free at demo scale, needs NO new
 * credentials (it uses the `GROQ_API_KEY` already configured for the
 * assessment layer), and whisper-large-v3 covers all four demo languages:
 * Hindi, Bengali, Tamil, English.
 *
 * ==================== THE HALLUCINATION PROBLEM ====================
 * Whisper invents fluent, plausible text when given silence, noise, or a
 * non-speech signal. That is a curiosity in most applications and a real
 * hazard here: the output of this function becomes a patient's SYMPTOM
 * DESCRIPTION, which then feeds the triage engine. An invented "chest
 * pain" would escalate a well patient; an invented mild complaint attached
 * to a silent recording is worse.
 *
 * Two guards, both derived from the model's own signals:
 *   1. `no_speech_prob` above NO_SPEECH_THRESHOLD -> REJECT outright.
 *      Verified against a pure tone, which returns ~0.98 and a confidently
 *      wrong Hindi word.
 *   2. `avg_logprob` -> a real confidence score, surfaced to the caller so
 *      low-confidence transcripts can be confirmed by a human rather than
 *      silently accepted.
 * ===================================================================
 */
import { SttProvider } from './SttProvider.js';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Above this, treat the audio as containing no speech and reject.
 * Deliberately not 0.99: Whisper is confident about silence, and the cost
 * of a false reject (ask the health worker to record again) is trivial
 * next to the cost of a fabricated symptom.
 */
export const NO_SPEECH_THRESHOLD = 0.6;

/**
 * Below this, the transcript is returned but flagged for human
 * confirmation rather than trusted.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export class SttRejectedError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'SttRejectedError';
    this.detail = detail;
  }
}

/**
 * Turns Whisper's average log-probability into a 0..1 confidence.
 *
 * `avg_logprob` is typically about -0.1 (excellent) to about -1.5 (poor).
 * Exponentiating maps that to a usable scale without pretending to be a
 * calibrated probability — it is a relative signal, and is documented as
 * such wherever it surfaces.
 */
export function confidenceFromLogprob(avgLogprob) {
  if (!Number.isFinite(avgLogprob)) return 0;
  return Math.max(0, Math.min(1, Math.exp(avgLogprob)));
}

export class GroqWhisperAdapter extends SttProvider {
  constructor({
    apiKey,
    modelId = DEFAULT_MODEL,
    fetchImpl = fetch,
    baseUrl = GROQ_TRANSCRIPTION_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super('groq-whisper', ['hi', 'bn', 'ta', 'en']);

    if (!apiKey) throw new TypeError('GroqWhisperAdapter requires an apiKey');

    this.apiKey = apiKey;
    this.modelId = modelId;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async _transcribe(audio, language) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.modelId);
    form.append('language', language);
    // verbose_json is required: the plain response omits `no_speech_prob`
    // and `avg_logprob`, which are the only two signals standing between a
    // hallucinated transcript and a patient's clinical record.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');

    let response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Groq Whisper request failed: ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Groq Whisper returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = await response.json();
    const text = (payload?.text ?? '').trim();
    const segments = Array.isArray(payload.segments) ? payload.segments : [];

    // Worst-case across segments: one hallucinated stretch in an otherwise
    // clean recording is still a fabricated symptom.
    const maxNoSpeech = segments.length
      ? Math.max(...segments.map((s) => s.no_speech_prob ?? 0))
      : 0;

    if (maxNoSpeech > NO_SPEECH_THRESHOLD) {
      throw new SttRejectedError(
        'No speech detected in the recording — please record again',
        { reason: 'no_speech', noSpeechProb: maxNoSpeech },
      );
    }

    if (!text) {
      throw new SttRejectedError('Transcription produced no text', { reason: 'empty' });
    }

    const avgLogprob = segments.length
      ? segments.reduce((sum, s) => sum + (s.avg_logprob ?? -5), 0) / segments.length
      : -5;

    const confidence = confidenceFromLogprob(avgLogprob);

    return {
      text,
      confidence,
      // Surfaced so the intake layer can require human confirmation rather
      // than silently trusting a poor transcript.
      needsHumanConfirmation: confidence < LOW_CONFIDENCE_THRESHOLD,
      detectedLanguage: payload.language ?? null,
      durationSeconds: payload.duration ?? null,
    };
  }
}

export default GroqWhisperAdapter;
