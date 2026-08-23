/**
 * STT adapter stubs.
 *
 * BOTH THROW ON PURPOSE. No real speech API is called anywhere in this
 * phase — credentials have not been supplied, and per the project's
 * ask-don't-assume rule a fabricated key or a fake transcript is worse than
 * an honest failure.
 *
 * Each stub documents exactly what it needs so wiring is mechanical later.
 */
import { SttProvider, NotImplementedError } from './SttProvider.js';

/**
 * Bhashini / ULCA — PRIMARY.
 *
 * The Government of India's National Language Translation Mission platform.
 * Chosen as primary for coverage of Indic languages and dialects that
 * Western ASR handles poorly, and because demonstrating a GoI service inside
 * a state-government showcase is worth more than a US cloud vendor.
 *
 * NEEDS:
 *   BHASHINI_USER_ID
 *   BHASHINI_API_KEY
 *   BHASHINI_PIPELINE_ID
 * Onboarding is a registration process at bhashini.gov.in, not instant.
 */
export class BhashiniAdapter extends SttProvider {
  constructor() {
    super('bhashini', ['hi', 'bn', 'ta', 'en']);
  }

  async _transcribe() {
    throw new NotImplementedError(
      'bhashini',
      'awaiting BHASHINI_USER_ID, BHASHINI_API_KEY and BHASHINI_PIPELINE_ID',
    );
  }
}

/**
 * Google Cloud Speech-to-Text — FALLBACK.
 *
 * Higher reliability and latency guarantees, paid. Covers all four demo
 * languages, so with Bhojpuri removed either provider can serve the whole
 * set on its own — see docs/DECISIONS.md D-026 for what that changes.
 *
 * The skip-don't-substitute rule in the failover chain still stands: it is
 * a safety property, not a Bhojpuri workaround.
 *
 * NEEDS:
 *   GOOGLE_APPLICATION_CREDENTIALS (service account JSON path)
 *   GOOGLE_PROJECT_ID
 */
export class GoogleSttAdapter extends SttProvider {
  constructor() {
    super('google', ['hi', 'bn', 'ta', 'en']);
  }

  async _transcribe() {
    throw new NotImplementedError(
      'google',
      'awaiting GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_PROJECT_ID',
    );
  }
}

export default { BhashiniAdapter, GoogleSttAdapter };
