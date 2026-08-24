/**
 * STT orchestration — failover chain and per-request provider logging.
 *
 * This layer IS implemented and tested (against fakes). Only the adapters
 * that call a real API are stubs.
 *
 * Failover rules, in order of importance:
 *   1. A provider that does not support the requested language is SKIPPED,
 *      never silently substituted. Transcribing Bhojpuri with a Hindi model
 *      would produce plausible, wrong symptom text — a clinical risk.
 *   2. Every attempt is logged with provider, outcome and latency, so a
 *      degraded provider is visible rather than merely slow.
 *   3. Total failure throws. It never returns an empty or guessed
 *      transcript, because downstream triage cannot tell a bad transcript
 *      from a real one.
 */
import logger from '../../config/logger.js';
import { BhashiniAdapter, GoogleSttAdapter } from './adapters.js';
import { GroqWhisperAdapter } from './groqWhisper.js';
import { SUPPORTED_LANGUAGES, UnsupportedLanguageError } from './SttProvider.js';

export class AllProvidersFailedError extends Error {
  constructor(language, attempts) {
    super(`No STT provider could transcribe "${language}"`);
    this.name = 'AllProvidersFailedError';
    this.language = language;
    this.attempts = attempts;
  }
}

export class SttService {
  /** @param {import('./SttProvider.js').SttProvider[]} providers in priority order */
  constructor(providers) {
    if (!providers?.length) throw new TypeError('At least one provider is required');
    this.providers = providers;
  }

  /** Providers that can actually handle this language, in priority order. */
  candidatesFor(language) {
    return this.providers.filter((p) => p.supports(language));
  }

  /**
   * Transcribes, failing over down the chain.
   *
   * @param {Buffer} audio
   * @param {string} language ISO code
   * @param {{requestId?: string}} [context] for correlating log lines
   */
  async transcribe(audio, language, context = {}) {
    if (!SUPPORTED_LANGUAGES[language]) {
      throw new UnsupportedLanguageError('stt-service', language);
    }

    // Validate the input BEFORE the failover loop. Empty audio is a caller
    // error, not a provider outage — retrying it down the whole chain would
    // burn latency and quota on every provider to reach the same answer,
    // and would misreport a client bug as a provider failure in the logs.
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new TypeError('audio must be a non-empty Buffer');
    }

    const candidates = this.candidatesFor(language);
    const attempts = [];

    if (!candidates.length) {
      logger.error(
        { language, requestId: context.requestId },
        'No STT provider supports this language',
      );
      throw new AllProvidersFailedError(language, attempts);
    }

    for (const provider of candidates) {
      const startedAt = Date.now();
      try {
        const result = await provider.transcribe(audio, language);

        attempts.push({ provider: provider.name, ok: true, latencyMs: result.latencyMs });

        logger.info(
          {
            provider: provider.name,
            language,
            latencyMs: result.latencyMs,
            confidence: result.confidence,
            attempt: attempts.length,
            requestId: context.requestId,
          },
          // The transcript itself is PHI and is never logged.
          'STT transcription succeeded',
        );

        return { ...result, attempts };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        attempts.push({
          provider: provider.name,
          ok: false,
          latencyMs,
          error: err.name,
          notImplemented: Boolean(err.isNotImplemented),
        });

        logger.warn(
          {
            provider: provider.name,
            language,
            latencyMs,
            error: err.name,
            reason: err.message,
            requestId: context.requestId,
          },
          'STT provider failed — trying next',
        );
      }
    }

    logger.error(
      { language, attempts, requestId: context.requestId },
      'All STT providers failed',
    );
    throw new AllProvidersFailedError(language, attempts);
  }
}

/**
 * Builds the provider chain from configuration.
 *
 * Groq Whisper leads because it is the only one actually implemented and
 * needs no credentials beyond the GROQ_API_KEY already in use. Bhashini
 * and Google remain in the chain as stubs: when either is given
 * credentials it will be tried in turn, and until then they simply fail
 * over immediately.
 *
 * Returns null when nothing is configured, which the intake layer reads as
 * "voice unavailable" and reports honestly rather than silently storing an
 * untranscribed entry.
 */
export function createSttService(env = process.env) {
  const providers = [];

  if (env.GROQ_API_KEY) {
    providers.push(
      new GroqWhisperAdapter({
        apiKey: env.GROQ_API_KEY,
        modelId: env.GROQ_WHISPER_MODEL_ID || undefined,
      }),
    );
  }

  // Stubs — included so a credentialed provider is picked up automatically.
  if (env.BHASHINI_API_KEY) providers.push(new BhashiniAdapter());
  if (env.GOOGLE_PROJECT_ID) providers.push(new GoogleSttAdapter());

  if (!providers.length) return null;
  return new SttService(providers);
}

export { SUPPORTED_LANGUAGES };
export default { SttService, createSttService, AllProvidersFailedError };
