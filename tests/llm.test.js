/**
 * LLM assessment layer — output validation and failover.
 *
 * The adapters are stubs that throw; that is asserted, so nobody can
 * quietly "fix" the suite by returning a canned assessment.
 */
import { LlmService, createLlmService, AllLlmProvidersFailedError } from '../services/llm/index.js';
import {
  LlmProvider,
  assessmentOutputSchema,
  LlmNotImplementedError,
  InvalidModelOutputError,
} from '../services/llm/LlmProvider.js';
import { HostedLlmAdapter, SelfHostedLlmAdapter } from '../services/llm/adapters.js';
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

describe('the adapters are deliberately NOT implemented', () => {
  it('HostedLlmAdapter throws and names what it needs', async () => {
    await expect(new HostedLlmAdapter().assess(INPUT)).rejects.toThrow(LlmNotImplementedError);
    await expect(new HostedLlmAdapter().assess(INPUT)).rejects.toThrow(/LLM_API_KEY/);
  });

  it('SelfHostedLlmAdapter throws and names what it needs', async () => {
    await expect(new SelfHostedLlmAdapter().assess(INPUT)).rejects.toThrow(
      /SELF_HOSTED_LLM_BASE_URL/,
    );
  });

  it('createLlmService returns null when nothing is configured', () => {
    // The engine reads null as "no model" and floors at MEDIUM, which is
    // the safe reading of an unconfigured system.
    expect(createLlmService({})).toBeNull();
  });

  it('builds a chain when config is present', () => {
    const service = createLlmService({
      LLM_API_KEY: 'x',
      SELF_HOSTED_LLM_BASE_URL: 'http://pod:8000/v1',
    });
    expect(service.providers.map((p) => p.name)).toEqual(['hosted', 'self-hosted']);
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

  it('the real (unimplemented) chain therefore also falls back to MEDIUM', async () => {
    const service = createLlmService({ LLM_API_KEY: 'placeholder' });
    const result = await runAssessment({ input: INPUT, model: service });

    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.modelError).toBe('model_error');
  });
});
