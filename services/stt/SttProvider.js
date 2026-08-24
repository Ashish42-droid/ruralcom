/**
 * Speech-to-text provider interface.
 *
 * Adapters are NOT implemented — no real STT API is called anywhere in this
 * phase. The interface, the failover chain and the per-request provider
 * logging are complete and tested against fakes, so wiring a real adapter is
 * a drop-in once credentials exist.
 *
 * Contract:
 *   transcribe(audio, language) -> {
 *     text, confidence, provider, latencyMs, language
 *   }
 */

/** Languages the demo must support. */
export const SUPPORTED_LANGUAGES = Object.freeze({
  hi: { name: 'Hindi', bcp47: 'hi-IN' },
  bn: { name: 'Bengali', bcp47: 'bn-IN' },
  ta: { name: 'Tamil', bcp47: 'ta-IN' },
  en: { name: 'English', bcp47: 'en-IN' },
});

export class NotImplementedError extends Error {
  constructor(provider, detail) {
    super(`${provider} is not implemented: ${detail}`);
    this.name = 'NotImplementedError';
    this.provider = provider;
    this.isNotImplemented = true;
  }
}

export class UnsupportedLanguageError extends Error {
  constructor(provider, language) {
    super(`${provider} does not support language "${language}"`);
    this.name = 'UnsupportedLanguageError';
    this.provider = provider;
    this.language = language;
  }
}

/**
 * Base class. Adapters implement `_transcribe`; `transcribe` handles the
 * shared concerns (language validation, timing, result shaping) so every
 * provider returns an identical shape and no adapter can forget to.
 */
export class SttProvider {
  /** @param {string} name @param {string[]} languages ISO codes supported */
  constructor(name, languages) {
    if (new.target === SttProvider) {
      throw new TypeError('SttProvider is abstract');
    }
    this.name = name;
    this.languages = new Set(languages);
  }

  supports(language) {
    return this.languages.has(language);
  }

  /**
   * @param {Buffer} audio
   * @param {string} language ISO code, e.g. 'hi'
   * @returns {Promise<{text: string, confidence: number, provider: string,
   *   latencyMs: number, language: string}>}
   */
  async transcribe(audio, language) {
    if (!SUPPORTED_LANGUAGES[language]) {
      throw new UnsupportedLanguageError(this.name, language);
    }
    if (!this.supports(language)) {
      throw new UnsupportedLanguageError(this.name, language);
    }
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw new TypeError('audio must be a non-empty Buffer');
    }

    const startedAt = Date.now();
    const result = await this._transcribe(audio, language);

    return {
      text: result.text,
      confidence: result.confidence,
      provider: this.name,
      latencyMs: Date.now() - startedAt,
      language,
      // Optional signals a provider may supply. Whisper sets
      // needsHumanConfirmation from its own log-probabilities; a provider
      // that cannot judge its own output simply omits them.
      needsHumanConfirmation: result.needsHumanConfirmation ?? false,
      detectedLanguage: result.detectedLanguage ?? null,
      durationSeconds: result.durationSeconds ?? null,
    };
  }

  /* eslint-disable-next-line no-unused-vars */
  async _transcribe(audio, language) {
    throw new NotImplementedError(this.name, '_transcribe must be overridden');
  }
}

export default SttProvider;
