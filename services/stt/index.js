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

/** Default chain: Bhashini primary, Google fallback. */
export function createSttService() {
  return new SttService([new BhashiniAdapter(), new GoogleSttAdapter()]);
}

export { SUPPORTED_LANGUAGES };
export default { SttService, createSttService, AllProvidersFailedError };
