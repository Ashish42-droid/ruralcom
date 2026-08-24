/**
 * LLM provider interface for the assessment layer.
 *
 * Adapters are NOT implemented — no key has been supplied. Same pattern as
 * services/stt: the interface, failover chain, and — critically — the
 * OUTPUT VALIDATION are complete and tested, so wiring a real provider is a
 * drop-in.
 *
 * ===================== WHY VALIDATION LIVES HERE =====================
 * An LLM will happily return a tier of "critical", a dosage in the reasoning
 * text, or a differential with a confidence of 1.4. None of that may reach
 * the triage engine. This layer is the boundary: anything that does not
 * parse against the schema is rejected as a failure, and the engine then
 * fails safe to MEDIUM.
 *
 * A partially-understood clinical assessment is not better than none.
 * =====================================================================
 */
import { z } from 'zod';

/** The only shape the triage engine will accept. */
export const assessmentOutputSchema = z.object({
  tier: z.enum(['low', 'medium', 'high']),

  differential: z
    .array(
      z.object({
        condition: z.string().trim().min(2).max(200),
        confidence: z.number().min(0).max(1),
        supportingFindings: z.array(z.string().max(300)).max(10).default([]),
        contradictingFindings: z.array(z.string().max(300)).max(10).default([]),
      }),
    )
    .max(10)
    .default([]),

  reasoning: z.string().trim().max(4000).nullable().default(null),

  redFlagsObserved: z.array(z.string().max(200)).max(20).default([]),

  // Deliberately NOT part of this schema: any medication name, dose or
  // frequency. Medicine comes from the signed formulary via a rules engine,
  // never from a model. See docs/DECISIONS.md.
});

export class LlmNotImplementedError extends Error {
  constructor(provider, detail) {
    super(`${provider} is not implemented: ${detail}`);
    this.name = 'LlmNotImplementedError';
    this.provider = provider;
    this.isNotImplemented = true;
  }
}

export class InvalidModelOutputError extends Error {
  constructor(provider, issues) {
    super(`${provider} returned output that failed schema validation`);
    this.name = 'InvalidModelOutputError';
    this.provider = provider;
    this.issues = issues;
  }
}

/**
 * Base class. Adapters implement `_complete`, which returns the raw parsed
 * JSON from the model; `assess` validates it. An adapter therefore cannot
 * skip validation even by accident.
 */
export class LlmProvider {
  constructor(name, { modelId = null, promptVersion = '1' } = {}) {
    if (new.target === LlmProvider) {
      throw new TypeError('LlmProvider is abstract');
    }
    this.name = name;
    this.modelId = modelId;
    this.promptVersion = promptVersion;
  }

  /**
   * @param {object} input { vitals, patient, symptomText, history, allergies }
   * @returns {Promise<object>} validated assessment
   */
  async assess(input) {
    const raw = await this._complete(input);

    const parsed = assessmentOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidModelOutputError(this.name, parsed.error.issues);
    }

    return {
      ...parsed.data,
      modelVersion: this.modelId,
      promptVersion: this.promptVersion,
      provider: this.name,
    };
  }

  /* eslint-disable-next-line no-unused-vars */
  async _complete(input) {
    throw new LlmNotImplementedError(this.name, '_complete must be overridden');
  }
}

export default LlmProvider;
