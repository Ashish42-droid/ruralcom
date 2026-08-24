/**
 * LLM orchestration for the assessment layer.
 *
 * Implemented and tested. Only the adapters are stubs.
 *
 * Failover differs from STT in one important way: a schema-invalid response
 * is NOT retried against the same provider. If a model returns malformed
 * clinical output once, retrying it is more likely to burn twenty seconds
 * than to fix anything — and the engine's fail-safe to MEDIUM is a
 * perfectly safe outcome. Latency matters here because a health worker is
 * standing in front of a patient waiting.
 */
import logger from '../../config/logger.js';
import { GroqLlmAdapter, SelfHostedLlmAdapter } from './adapters.js';

export class AllLlmProvidersFailedError extends Error {
  constructor(attempts) {
    super('No LLM provider produced a valid assessment');
    this.name = 'AllLlmProvidersFailedError';
    this.attempts = attempts;
  }
}

export class LlmService {
  /** @param {import('./LlmProvider.js').LlmProvider[]} providers priority order */
  constructor(providers) {
    if (!providers?.length) throw new TypeError('At least one provider is required');
    this.providers = providers;
  }

  /**
   * Produces a validated assessment, or throws.
   *
   * Shaped to satisfy the `model` contract the triage engine expects, so it
   * can be handed straight to `runAssessment({ model })`.
   */
  async assess(input, context = {}) {
    const attempts = [];

    for (const provider of this.providers) {
      const startedAt = Date.now();
      try {
        const result = await provider.assess(input);
        const latencyMs = Date.now() - startedAt;

        attempts.push({ provider: provider.name, ok: true, latencyMs });

        logger.info(
          {
            provider: provider.name,
            modelId: provider.modelId,
            tier: result.tier,
            differentialCount: result.differential.length,
            latencyMs,
            requestId: context.requestId,
          },
          // Reasoning text and symptom detail are PHI and are never logged.
          'LLM assessment succeeded',
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
            latencyMs,
            error: err.name,
            reason: err.message,
            // Schema issues describe the SHAPE that was wrong, not the
            // content, so they are safe to log and are the most useful
            // thing here when a prompt regresses.
            issues: err.issues ?? undefined,
            requestId: context.requestId,
          },
          'LLM provider failed — trying next',
        );
      }
    }

    logger.error(
      { attempts, requestId: context.requestId },
      'All LLM providers failed — triage will fail safe to MEDIUM',
    );
    throw new AllLlmProvidersFailedError(attempts);
  }
}

/**
 * Builds the chain from configuration.
 *
 * Returns null when nothing is configured, which the triage engine reads as
 * "no model" and floors every case at MEDIUM. That is deliberate: silently
 * running rules-only and calling something LOW would be the unsafe option.
 */
export function createLlmService(env = process.env) {
  const providers = [];

  if (env.GROQ_API_KEY) {
    providers.push(
      new GroqLlmAdapter({
        apiKey: env.GROQ_API_KEY,
        modelId: env.GROQ_MODEL_ID || undefined,
      }),
    );
  }

  if (env.SELF_HOSTED_LLM_BASE_URL) {
    providers.push(
      new SelfHostedLlmAdapter({
        baseUrl: env.SELF_HOSTED_LLM_BASE_URL,
        modelId: env.SELF_HOSTED_LLM_MODEL_ID ?? 'deepseek-r1',
      }),
    );
  }

  if (!providers.length) return null;
  return new LlmService(providers);
}

export default { LlmService, createLlmService, AllLlmProvidersFailedError };
