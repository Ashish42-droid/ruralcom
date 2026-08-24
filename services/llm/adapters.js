/**
 * LLM adapters.
 *
 * GroqLlmAdapter is REAL — wired per owner instruction (docs/DECISIONS.md
 * D-035). SelfHostedLlmAdapter remains a stub: the DeepSeek R1 pod does not
 * exist yet, and per the project's ask-don't-assume rule a fabricated
 * endpoint is worse than an honest failure — the triage engine fails safe
 * to MEDIUM either way.
 */
import { LlmProvider, LlmNotImplementedError } from './LlmProvider.js';
import { buildMessages, PROMPT_VERSION } from './prompt.js';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 18_000; // under the triage engine's 20s model timeout

/**
 * Groq — hosted inference, OpenAI-compatible chat completions API.
 *
 * NEEDS: `GROQ_API_KEY`. Optionally `GROQ_MODEL_ID`
 * (default "llama-3.3-70b-versatile").
 *
 * `fetchImpl` is injectable so tests never make a real network call — see
 * tests/llm.test.js. Production code never passes it; it defaults to the
 * global `fetch`.
 */
export class GroqLlmAdapter extends LlmProvider {
  constructor({
    apiKey,
    modelId = DEFAULT_GROQ_MODEL,
    fetchImpl = fetch,
    baseUrl = GROQ_CHAT_COMPLETIONS_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super('groq', { modelId, promptVersion: PROMPT_VERSION });

    if (!apiKey) {
      throw new TypeError('GroqLlmAdapter requires an apiKey');
    }

    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async _complete(input) {
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelId,
          messages: buildMessages(input),
          temperature: 0,
          // Groq's JSON mode — the model is constrained to emit valid JSON,
          // which removes the most common failure mode (markdown fences,
          // leading commentary) before validation even runs.
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network failure, DNS failure, or our own timeout firing.
      throw new Error(`Groq request failed: ${err.message}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `Groq returned HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
      );
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('Groq response had no message content');
    }

    try {
      return JSON.parse(content);
    } catch {
      // The base class treats this exactly like a validation failure and
      // fails over. A malformed response is not retried against Groq
      // itself — see services/llm/index.js for why.
      throw new Error('Groq response content was not valid JSON');
    }
  }
}

/**
 * Self-hosted DeepSeek R1 — POST-INCUBATION target (owner decision, D-030).
 *
 * Served behind vLLM / SGLang, both of which expose an OpenAI-compatible
 * `/v1/chat/completions` endpoint — the same shape GroqLlmAdapter already
 * speaks. Implementing this adapter later is expected to be close to a copy
 * of GroqLlmAdapter with a different base URL, PLUS one extra step: R1 is a
 * reasoning model and emits a `<think>...</think>` block before its answer.
 * That block must be stripped before JSON parsing, and it must NEVER be
 * logged or persisted — it restates patient details at length, so it is PHI.
 *
 * NEEDS: `SELF_HOSTED_LLM_BASE_URL` (e.g. http://pod-internal:8000/v1),
 *        `SELF_HOSTED_LLM_MODEL_ID`, and optionally `SELF_HOSTED_LLM_API_KEY`.
 */
export class SelfHostedLlmAdapter extends LlmProvider {
  constructor({ baseUrl = null, modelId = 'deepseek-r1' } = {}) {
    super('self-hosted', { modelId, promptVersion: PROMPT_VERSION });
    this.baseUrl = baseUrl;
  }

  async _complete() {
    throw new LlmNotImplementedError(
      'self-hosted',
      'awaiting SELF_HOSTED_LLM_BASE_URL — planned for post-incubation pod deployment',
    );
  }
}

export default { GroqLlmAdapter, SelfHostedLlmAdapter };
