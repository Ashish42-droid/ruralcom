/**
 * Triage engine and golden case suite.
 *
 * This is the build gate. Any change that lowers a golden case below its
 * expected tier fails here, deliberately.
 */
import { runAssessment, TIER } from '../services/triage/engine.js';
import { evaluateRules, maxTier, tierRank } from '../services/triage/rules.js';
import { GOLDEN_CASES } from './fixtures/goldenCases.js';

const NORMAL_VITALS = {
  temperatureC: 37.0,
  spo2: 98,
  systolic: 120,
  diastolic: 78,
  pulseBpm: 76,
  respiratoryRate: 16,
};

const healthyAdult = {
  vitals: NORMAL_VITALS,
  patient: { ageYears: 34, sex: 'male', registrationComplete: true },
  symptomText: 'small cut on hand',
};

/** A model that returns whatever tier the test wants. */
const fakeModel = (tier, extra = {}) => ({
  assess: async () => ({ tier, differential: [{ condition: 'x', confidence: 0.5 }], ...extra }),
});

describe('GOLDEN CASES — the build gate', () => {
  /**
   * Golden cases run against a model that ALWAYS says LOW.
   *
   * That is deliberate and makes the test stronger: every escalation below
   * has to come from the deterministic rule floor, against a model actively
   * insisting the patient is fine. Running with no model at all would let
   * the engine's "no model configured -> MEDIUM" fallback mask whether the
   * rules actually fired.
   */
  const alwaysLowModel = { assess: async () => ({ tier: 'low', differential: [] }) };

  it.each(GOLDEN_CASES.map((c) => [c.id, c]))(
    '%s',
    async (_id, testCase) => {
      const result = await runAssessment({ input: testCase.input, model: alwaysLowModel });

      const actual = tierRank(result.finalTier);
      const expected = tierRank(testCase.expectedMinimum);

      if (testCase.exact) {
        expect(result.finalTier).toBe(testCase.expectedMinimum);
      } else {
        // Over-triage is safe; under-triage is the failure this catches.
        expect(actual).toBeGreaterThanOrEqual(expected);
      }

      if (testCase.mustHitRule) {
        const codes = result.ruleHits.map((h) => h.code);
        expect(codes).toContain(testCase.mustHitRule);
      }
    },
  );

  it('covers all three tiers', () => {
    const tiers = new Set(GOLDEN_CASES.map((c) => c.expectedMinimum));
    expect(tiers).toEqual(new Set(['low', 'medium', 'high']));
  });

  it('every case explains itself', () => {
    for (const c of GOLDEN_CASES) {
      expect(c.description.length).toBeGreaterThan(10);
    }
  });
});

describe('THE INVARIANT — final_tier = max(rule_tier, model_tier)', () => {
  it('a model may RAISE the tier', async () => {
    const result = await runAssessment({
      input: healthyAdult,
      model: fakeModel(TIER.HIGH),
    });

    expect(result.ruleTier).toBe(TIER.LOW);
    expect(result.modelTier).toBe(TIER.HIGH);
    expect(result.finalTier).toBe(TIER.HIGH);
  });

  it('a model may NEVER lower the tier below the rule floor', async () => {
    const hypoxic = {
      ...healthyAdult,
      vitals: { ...NORMAL_VITALS, spo2: 85 },
    };

    // The dangerous case: a confident model says this is fine.
    const result = await runAssessment({ input: hypoxic, model: fakeModel(TIER.LOW) });

    expect(result.ruleTier).toBe(TIER.HIGH);
    expect(result.modelTier).toBe(TIER.LOW);
    expect(result.finalTier).toBe(TIER.HIGH);
    expect(result.modelAttemptedDeEscalation).toBe(true);
    expect(result.escalationReason).toBe('rule_floor_overrode_model');
  });

  it('holds for every rule/model tier combination', async () => {
    const tiers = [TIER.LOW, TIER.MEDIUM, TIER.HIGH];
    const inputFor = {
      [TIER.LOW]: healthyAdult,
      [TIER.MEDIUM]: { ...healthyAdult, vitals: { ...NORMAL_VITALS, temperatureC: 38.4 } },
      [TIER.HIGH]: { ...healthyAdult, vitals: { ...NORMAL_VITALS, spo2: 85 } },
    };

    for (const ruleTier of tiers) {
      for (const modelTier of tiers) {
        const result = await runAssessment({
          input: inputFor[ruleTier],
          model: fakeModel(modelTier),
        });
        expect(result.finalTier).toBe(maxTier(ruleTier, modelTier));
      }
    }
  });
});

describe('FAIL-SAFE behaviour', () => {
  it('a model that throws falls back to MEDIUM, never LOW', async () => {
    const model = { assess: async () => { throw new Error('upstream 500'); } };
    const result = await runAssessment({ input: healthyAdult, model });

    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.modelError).toBe('model_error');
  });

  it('a model that times out falls back to MEDIUM', async () => {
    const model = { assess: () => new Promise(() => {}) }; // never resolves
    const result = await runAssessment({ input: healthyAdult, model });

    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.modelError).toBe('timeout');
  }, 30_000);

  it.each([
    ['null', null],
    ['undefined tier', {}],
    ['garbage tier', { tier: 'catastrophic' }],
    ['numeric tier', { tier: 2 }],
    ['uppercase tier', { tier: 'LOW' }],
  ])('unparseable model output (%s) falls back to MEDIUM', async (_label, raw) => {
    const model = { assess: async () => raw };
    const result = await runAssessment({ input: healthyAdult, model });

    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.modelError).toBe('invalid_model_output');
  });

  it('a failing model still cannot lower a HIGH rule floor', async () => {
    const model = { assess: async () => { throw new Error('boom'); } };
    const result = await runAssessment({
      input: { ...healthyAdult, vitals: { ...NORMAL_VITALS, spo2: 85 } },
      model,
    });

    expect(result.finalTier).toBe(TIER.HIGH);
  });

  it('with no model configured at all, the floor is MEDIUM', async () => {
    // Rules alone cannot justify LOW: they see only vitals and a red-flag
    // phrase list, so anything they miss would go home unreviewed.
    const result = await runAssessment({ input: healthyAdult });

    expect(result.ruleTier).toBe(TIER.LOW);
    expect(result.finalTier).toBe(TIER.MEDIUM);
    expect(result.escalationReason).toBe('no_model_configured');
  });
});

describe('explainability', () => {
  it('records every rule that fired, with its value and source', async () => {
    const result = await runAssessment({
      input: { ...healthyAdult, vitals: { ...NORMAL_VITALS, spo2: 85 } },
    });

    const hit = result.ruleHits.find((h) => h.code === 'spo2_critical');
    // "Why did it say HIGH?" must always have a precise answer.
    expect(hit).toMatchObject({
      tier: TIER.HIGH,
      value: 85,
      threshold: 92,
      source: 'NEWS2',
    });
  });

  it('stamps the ruleset version so historical decisions can be replayed', async () => {
    const result = await runAssessment({ input: healthyAdult });
    expect(result.rulesetVersion).toMatch(/^\d{4}\.\d{2}\.\d/);
  });

  it('records latency', async () => {
    const result = await runAssessment({ input: healthyAdult });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('rule evaluation edge cases', () => {
  it('handles a completely empty input without throwing', () => {
    const result = evaluateRules({});
    expect(result.tier).toBe(TIER.MEDIUM); // missing data escalates
  });

  it('ignores non-numeric vitals rather than misreading them', () => {
    const result = evaluateRules({
      vitals: { spo2: 'ninety', temperatureC: null, pulseBpm: undefined },
      patient: { ageYears: 30, registrationComplete: true },
      symptomText: 'cough',
    });
    expect(result.hits.map((h) => h.code)).toContain('no_vitals_recorded');
    expect(result.hits.map((h) => h.code)).not.toContain('spo2_critical');
  });

  it('does not apply IMCI danger signs to adults', () => {
    const result = evaluateRules({
      vitals: NORMAL_VITALS,
      patient: { ageYears: 40, registrationComplete: true },
      symptomText: 'not drinking much water today',
    });
    expect(result.hits.map((h) => h.code)).not.toContain('imci_unable_to_drink');
  });

  it('applies IMCI danger signs to under-5s', () => {
    const result = evaluateRules({
      vitals: NORMAL_VITALS,
      patient: { ageYears: 4, registrationComplete: true },
      symptomText: 'child is not drinking',
    });
    expect(result.hits.map((h) => h.code)).toContain('imci_unable_to_drink');
  });

  it('is case-insensitive on symptom text', () => {
    const result = evaluateRules({
      vitals: NORMAL_VITALS,
      patient: { ageYears: 50, registrationComplete: true },
      symptomText: 'CRUSHING CHEST PAIN',
    });
    expect(result.tier).toBe(TIER.HIGH);
  });
});

describe('maxTier is a total order', () => {
  it.each([
    ['low', 'low', 'low'],
    ['low', 'medium', 'medium'],
    ['low', 'high', 'high'],
    ['medium', 'low', 'medium'],
    ['medium', 'high', 'high'],
    ['high', 'low', 'high'],
    ['high', 'medium', 'high'],
    ['high', 'high', 'high'],
  ])('maxTier(%s, %s) = %s', (a, b, expected) => {
    expect(maxTier(a, b)).toBe(expected);
  });
});
