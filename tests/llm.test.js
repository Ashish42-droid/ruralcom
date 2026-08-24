/**
 * LLM assessment layer — output validation and failover.
 *
 * GroqLlmAdapter is real code (D-035), so it is tested here with an
 * INJECTED fake `fetch` — the suite never makes a real network call. No
 * automated test may spend the owner's Groq quota or depend on the network
 * being up; that is what tests/../scripts/llm-smoke.js is for instead.
 *
 * SelfHostedLlmAdapter remains a stub that throws; that is asserted, so
 * nobody can quietly "fix" the suite by returning a canned assessment.
 */
import { LlmService, createLlmService, AllLlmProvidersFailedError } from '../services/llm/index.js';
import {
  LlmProvider,
  assessmentOutputSchema,
  LlmNotImplementedError,
  InvalidModelOutputError,
} from '../services/llm/LlmProvider.js';
import { GroqLlmAdapter, SelfHostedLlmAdapter } from '../services/llm/adapters.js';
import { runAssessment, TIER } from '../services/triage/engine.js';

const INPUT = {
  vitals: { spo2: 97, pulseBpm: 72, temperatureC: 37 },
  patient: { ageYears: 30, registrationComplete: true },
  symptomText: 'mild cough',
};

const VALID_OUTPUT = {
  tier: 'low',
  differential: [{ condition: 'Upper respiratory infection', confidence: 0.7 }],
  reasoning: 'Mild symptoms, normal vitals.',
  redFlagsObserved: [],
};

/** A provider returning whatever raw payload the test supplies. */
class FakeLlm extends LlmProvider {
  constructor(raw, name = 'fake') {
    super(name, { modelId: 'fake-1', promptVersion: '1' });
    this.raw = raw;
  }
  async _complete() {
    if (this.raw instanceof Error) throw this.raw;
    return this.raw;
  }
}

/** Builds a fake `fetch` that returns one JSON body without any network call. */
function fakeFetchReturning(content, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => (typeof content === 'string' ? content : JSON.stringify(content)),
  });
}

/** A fake `fetch` that rejects, simulating a network failure. */
function fakeFetchRejecting(message) {
  return async () => {
    throw new Error(message);
  };
}

describe('GroqLlmAdapter requires configuration', () => {
  it('refuses to construct without an API key', () => {
    expect(() => new GroqLlmAdapter({})).toThrow(TypeError);
  });

  it('defaults to a currently-available Groq model', () => {
    const adapter = new GroqLlmAdapter({ apiKey: 'x' });
    expect(adapter.modelId).toBe('openai/gpt-oss-120b');
  });
});

describe('GroqLlmAdapter — real code, network fully mocked', () => {
  it('parses a well-formed JSON response into a valid assessment', async () => {
    const adapter = new GroqLlmAdapter({
      apiKey: 'test-key',
      fetchImpl: fakeFetchReturning(JSON.stringify(VALID_OUTPUT)),
    });

    const result = await adapter.assess(INPUT);
    expect(result.tier).toBe('low');
    expect(result.provider).toBe('groq');
  });

  it('sends the API key as a Bearer token and asks for JSON mode', async () => {
    let capturedInit;
    const fetchImpl = async (_url, init) => {
      capturedInit = init;
      return fakeFetchReturning(JSON.stringify(VALID_OUTPUT))();
    };

    await new GroqLlmAdapter({ apiKey: 'secret-key', fetchImpl }).assess(INPUT);

    expect(capturedInit.headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(capturedInit.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
  });

  it('throws (does not crash) when Groq returns a non-2xx status', async () => {
    const adapter = new GroqLlmAdapter({
      apiKey: 'x',
      fetchImpl: fakeFetchReturning('rate limited', { ok: false, status: 429 }),
    });
    await expect(adapter.assess(INPUT)).rejects.toThrow(/HTTP 429/);
  });

  it('throws when the response body is not valid JSON', async () => {
    const adapter = new GroqLlmAdapter({
      apiKey: 'x',
      fetchImpl: fakeFetchReturning('```json\n{"tier":"low"}\n```'),
    });
    // Groq's JSON mode should prevent markdown fences, but if a model slips
    // one through anyway, JSON.parse fails inside _complete() — before the
    // schema-validation boundary in the base class ever runs. Still a plain
    // Error, and the LlmService treats it exactly like any other provider
    // failure: log it and try the next provider (services/llm/index.js).
    await expect(adapter.assess(INPUT)).rejects.toThrow(/not valid JSON/);
  });

  it('throws on a network failure rather than hanging', async () => {
    const adapter = new GroqLlmAdapter({
      apiKey: 'x',
      fetchImpl: fakeFetchRejecting('getaddrinfo ENOTFOUND api.groq.com'),
    });
    await expect(adapter.assess(INPUT)).rejects.toThrow(/Groq request failed/);
  });

  it('still runs its output through schema validation, not just JSON.parse', async () => {
    const adapter = new GroqLlmAdapter({
      apiKey: 'x',
      fetchImpl: fakeFetchReturning(JSON.stringify({ tier: 'catastrophic' })),
    });
    await expect(adapter.assess(INPUT)).rejects.toThrow(InvalidModelOutputError);
  });
});

describe('the self-hosted adapter is deliberately NOT implemented', () => {
  it('SelfHostedLlmAdapter throws and names what it needs', async () => {
    await expect(new SelfHostedLlmAdapter().assess(INPUT)).rejects.toThrow(
      LlmNotImplementedError,
    );
    await expect(new SelfHostedLlmAdapter().assess(INPUT)).rejects.toThrow(
      /SELF_HOSTED_LLM_BASE_URL/,
    );
  });

  it('createLlmService returns null when nothing is configured', () => {
    // The engine reads null as "no model" and floors at MEDIUM, which is
    // the safe reading of an unconfigured system.
    expect(createLlmService({})).toBeNull();
  });

  it('builds a chain from GROQ_API_KEY and SELF_HOSTED_LLM_BASE_URL', () => {
    const service = createLlmService({
      GROQ_API_KEY: 'x',
      SELF_HOSTED_LLM_BASE_URL: 'http://pod:8000/v1',
    });
    expect(service.providers.map((p) => p.name)).toEqual(['groq', 'self-hosted']);
  });

  it('builds a Groq-only chain when only GROQ_API_KEY is set', () => {
    const service = createLlmService({ GROQ_API_KEY: 'x' });
    expect(service.providers.map((p) => p.name)).toEqual(['groq']);
  });
});

describe('output validation is the boundary', () => {
  it('accepts a well-formed assessment', async () => {
    const result = await new FakeLlm(VALID_OUTPUT).assess(INPUT);
    expect(result.tier).toBe('low');
    expect(result.modelVersion).toBe('fake-1');
    expect(result.provider).toBe('fake');
  });

  it.each([
    ['an invented tier', { ...VALID_OUTPUT, tier: 'critical' }],
    ['an uppercase tier', { ...VALID_OUTPUT, tier: 'LOW' }],
    ['a numeric tier', { ...VALID_OUTPUT, tier: 1 }],
    ['a missing tier', { differential: [] }],
    ['confidence above 1', { ...VALID_OUTPUT, differential: [{ condition: 'X', confidence: 1.4 }] }],
    ['negative confidence', { ...VALID_OUTPUT, differential: [{ condition: 'X', confidence: -0.2 }] }],
    ['a null response', null],
    ['a string response', 'the patient seems fine'],
  ])('rejects %s', async (_label, raw) => {
    await expect(new FakeLlm(raw).assess(INPUT)).rejects.toThrow(InvalidModelOutputError);
  });

  it('reports which field failed, so a prompt regression is diagnosable', async () => {
    try {
      await new FakeLlm({ ...VALID_OUTPUT, tier: 'critical' }).assess(INPUT);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.issues[0].path).toContain('tier');
    }
  });

  it('the schema has NO field for medication', () => {
    // Medicine comes from the signed formulary via a rules engine, never
    // from a model. There is deliberately nowhere for a model to put a drug
    // name, dose or frequency.
    const shape = assessmentOutputSchema.shape;
    const keys = Object.keys(shape).join(' ').toLowerCase();
    expect(keys).not.toMatch(/medicat|drug|dose|dosage|prescri/);
  });

  it('caps the differential so a runaway response cannot flood the record', async () => {
    const huge = {
      ...VALID_OUTPUT,
      differential: Array.from({ length: 30 }, (_, i) => ({
        condition: `Condition ${i}`,
        confidence: 0.5,
      })),
    };
    await expect(new FakeLlm(huge).assess(INPUT)).rejects.toThrow(InvalidModelOutputError);
  });
});

describe('failover', () => {
  it('uses the first provider that returns valid output', async () => {
    const service = new LlmService([
      new FakeLlm(new Error('upstream 503'), 'a'),
      new FakeLlm(VALID_OUTPUT, 'b'),
    ]);

    const result = await service.assess(INPUT);
    expect(result.provider).toBe('b');
    expect(result.attempts).toHaveLength(2);
  });

  it('treats schema-invalid output as a provider failure and moves on', async () => {
    const service = new LlmService([
      new FakeLlm({ tier: 'nonsense' }, 'a'),
      new FakeLlm(VALID_OUTPUT, 'b'),
    ]);

    expect((await service.assess(INPUT)).provider).toBe('b');
  });

  it('throws when every provider fails', async () => {
    const service = new LlmService([new FakeLlm(new Error('x'), 'a')]);
    await expect(service.assess(INPUT)).rejects.toThrow(AllLlmProvidersFailedError);
  });

  it('cannot be built with no providers', () => {
    expect(() => new LlmService([])).toThrow(TypeError);
  });
});

describe('integration with the triage engine', () => {
  it('a valid LOW assessment plus a LOW rule floor yields LOW', async () => {
    const service = new LlmService([new FakeLlm(VALID_OUTPUT)]);
    const result = await runAssessment({ input: INPUT, model: service });

    expect(result.finalTier).toBe(TIER.LOW);
    expect(result.modelTier).toBe(TIER.LOW);
  });

  it('a model saying LOW cannot override a HIGH rule floor', async () => {
    const service = new LlmService([new FakeLlm(VALID_OUTPUT)]);
    const hypoxic = { ...INPUT, vitals: { ...INPUT.vitals, spo2: 84 } };

    const result = await runAssessment({ input: hypoxic, model: service });

    expect(result.finalTier).toBe(TIER.HIGH);
    expect(result.modelAttemptedDeEscalation).toBe(true);
  });

  it('a totally failed LLM chain falls back to MEDIUM, never LOW', async () => {
    const service = new LlmService([new FakeLlm(new Error('down'))]);
    const result = await runAssessment({ input: INPUT, model: service });

    expect(result.finalTier).toBe(TIER.MEDIUM);
  });

  it('a real Groq network failure also falls back to MEDIUM, never LOW', async () => {
    // The genuinely important end-to-end case: even a fully real GroqLlmAdapter
    // whose network call fails must still leave the engine failing safe.
    const service = new LlmService([
      new GroqLlmAdapter({ apiKey: 'x', fetchImpl: fakeFetchRejecting('down') }),
    ]);
    const result = await runAssessment({ input: INPUT, model: service });

    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.modelError).toBe('model_error');
  });
});
