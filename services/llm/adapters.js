/**
 * LLM adapter stubs.
 *
 * BOTH THROW ON PURPOSE. No key has been supplied, and per the project's
 * ask-don't-assume rule a fabricated key or a canned assessment is worse
 * than an honest failure — the triage engine fails safe to MEDIUM, which is
 * the correct behaviour for "we cannot assess this".
 */
import { LlmProvider, LlmNotImplementedError } from './LlmProvider.js';

/**
 * Hosted API provider — DEMO / near term.
 *
 * NEEDS: an API key in `LLM_API_KEY`, plus `LLM_MODEL_ID`.
 *
 * The owner intends to create this account separately. Whichever hosted
 * provider is chosen, the wire format goes here and nothing above this file
 * changes.
 */
export class HostedLlmAdapter extends LlmProvider {
  constructor({ modelId = null } = {}) {
    super('hosted', { modelId, promptVersion: '1' });
  }

  async _complete() {
    throw new LlmNotImplementedError(
      'hosted',
      'awaiting LLM_API_KEY and LLM_MODEL_ID — owner is provisioning the account',
    );
  }
}

/**
 * Self-hosted DeepSeek R1 — POST-INCUBATION target (owner decision, D-030).
 *
 * Served behind vLLM / SGLang, both of which expose an OpenAI-compatible
 * `/v1/chat/completions` endpoint. That is why this adapter is written
 * against the OpenAI wire format rather than a DeepSeek-specific one: the
 * same adapter then serves any self-hosted open-weight model, so swapping
 * R1 for something newer is a config change.
 *
 * NEEDS: `SELF_HOSTED_LLM_BASE_URL` (e.g. http://pod-internal:8000/v1),
 *        `SELF_HOSTED_LLM_MODEL_ID`, and optionally `SELF_HOSTED_LLM_API_KEY`.
 *
 * NOTE FOR WHOEVER IMPLEMENTS THIS: R1 is a reasoning model and emits a
 * <think> block before its answer. That block must be stripped before JSON
 * parsing, and it must NEVER be persisted or logged — it restates patient
 * details at length, so it is PHI.
 */
export class SelfHostedLlmAdapter extends LlmProvider {
  constructor({ baseUrl = null, modelId = 'deepseek-r1' } = {}) {
    super('self-hosted', { modelId, promptVersion: '1' });
    this.baseUrl = baseUrl;
  }

  async _complete() {
    throw new LlmNotImplementedError(
      'self-hosted',
      'awaiting SELF_HOSTED_LLM_BASE_URL — planned for post-incubation pod deployment',
    );
  }
}

export default { HostedLlmAdapter, SelfHostedLlmAdapter };
