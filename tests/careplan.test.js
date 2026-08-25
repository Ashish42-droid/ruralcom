/**
 * Care plan composition and the formulary safety gates.
 *
 * The gates are the point of this suite. Every one of them exists because
 * failing it would put a wrong dose in front of a health worker who has no
 * way to second-guess it.
 */
import { composeCarePlan } from '../services/careplan/index.js';
import {
  selectMedications,
  evaluateGates,
  FORMULARY,
} from '../services/careplan/formulary.js';

const adult = (over = {}) => ({ ageYears: 34, weightKg: 65, allergies: [], history: [], ...over });

describe('every tier gets first aid and precautions', () => {
  it.each(['low', 'medium', 'high'])('%s tier includes actionable first aid', (tier) => {
    const plan = composeCarePlan({ tier, symptomText: 'small cut on the hand', patient: adult() });
    expect(plan.firstAid.steps.length).toBeGreaterThan(2);
    expect(plan.precautions.length).toBeGreaterThan(0);
  });

  it('falls back to general care rather than returning nothing', () => {
    const plan = composeCarePlan({ tier: 'low', symptomText: 'feels unwell', patient: adult() });
    expect(plan.firstAid.title).toMatch(/general/i);
    expect(plan.precautions.length).toBeGreaterThan(0);
  });

  it('picks the most specific protocol for the presentation', () => {
    const cardiac = composeCarePlan({
      tier: 'high', symptomText: 'crushing chest pain radiating to the left arm', patient: adult(),
    });
    expect(cardiac.firstAid.title).toMatch(/cardiac/i);
    expect(cardiac.firstAid.steps.join(' ')).toMatch(/do not let them walk|sit the patient upright/i);
  });

  it('gives snakebite the right advice, not generic wound care', () => {
    const plan = composeCarePlan({ tier: 'high', symptomText: 'snakebite on the ankle', patient: adult() });
    expect(plan.firstAid.title).toMatch(/snake/i);
    // The dangerous folk remedies must be explicitly ruled out.
    expect(plan.firstAid.steps.join(' ')).toMatch(/do NOT cut, suck, apply ice/i);
  });
});

describe('medication is LOW tier only', () => {
  const feverish = { tier: 'low', symptomText: 'fever for two days', patient: adult() };

  it('LOW suggests medication from the formulary', () => {
    const plan = composeCarePlan(feverish);
    expect(plan.medications.length).toBeGreaterThan(0);
    expect(plan.medications[0].drug).toMatch(/paracetamol/i);
  });

  it.each(['medium', 'high'])('%s suggests NO medication at all', (tier) => {
    // MEDIUM: the doctor prescribes on the call. HIGH: referral only.
    const plan = composeCarePlan({ ...feverish, tier });
    expect(plan.medications).toEqual([]);
  });

  it('every medication carries a formulary source id', () => {
    const plan = composeCarePlan(feverish);
    for (const med of plan.medications) {
      // A row with no rule_source_id is rejected by a DB constraint.
      expect(med.ruleSourceId).toEqual(expect.any(String));
      expect(med.ruleSourceId.length).toBeGreaterThan(0);
      expect(med.source).toEqual(expect.any(String));
    }
  });

  it('marks every suggestion as pending doctor review', () => {
    const plan = composeCarePlan(feverish);
    expect(plan.medications.every((m) => m.status === 'pending_doctor_review')).toBe(true);
    expect(plan.disclaimer).toMatch(/NOT A MEDICAL DECISION/);
  });
});

describe('safety gates suppress rather than warn', () => {
  it('REFUSES a weight-based paediatric dose with no weight recorded', () => {
    // The classic paediatric overdose: guessing a weight-based dose from
    // an age band. Refuse instead.
    const { suggestions, suppressed } = selectMedications({
      symptomText: 'fever',
      patient: { ageYears: 4, allergies: [], history: [] },
    });

    expect(suggestions.find((s) => /paracetamol/i.test(s.drug))).toBeUndefined();
    expect(suppressed.some((s) => /weight is required/i.test(s.reasons.join(' ')))).toBe(true);
  });

  it('computes a weight-based paediatric dose when weight IS recorded', () => {
    const { suggestions } = selectMedications({
      symptomText: 'fever',
      patient: { ageYears: 4, weightKg: 16, allergies: [], history: [] },
    });

    const para = suggestions.find((s) => /paracetamol/i.test(s.drug));
    expect(para.basis).toBe('weight');
    expect(para.dose).toMatch(/240 mg/); // 15 mg/kg x 16 kg
    expect(para.maxDaily).toMatch(/960 mg/); // 60 mg/kg x 16 kg
  });

  it('refuses everything when age is unknown', () => {
    // Without age, no dosing rule can be checked at all.
    const { suggestions, suppressed } = selectMedications({
      symptomText: 'fever and diarrhoea',
      patient: { allergies: [], history: [] },
    });

    expect(suggestions).toEqual([]);
    expect(suppressed.every((s) => /age is unknown/i.test(s.reasons.join(' ')))).toBe(true);
  });

  it('suppresses on a recorded allergy', () => {
    const { suggestions, suppressed } = selectMedications({
      symptomText: 'fever',
      patient: adult({ allergies: ['paracetamol'] }),
    });

    expect(suggestions.find((s) => /paracetamol/i.test(s.drug))).toBeUndefined();
    expect(suppressed.some((s) => /allergy or condition/i.test(s.reasons.join(' ')))).toBe(true);
  });

  it('suppresses on a contraindicating condition in history', () => {
    const { suggestions } = selectMedications({
      symptomText: 'fever',
      patient: adult({ history: ['chronic liver disease'] }),
    });
    expect(suggestions.find((s) => /paracetamol/i.test(s.drug))).toBeUndefined();
  });

  it('suppresses pregnancy-unsafe medicines in pregnancy', () => {
    const { suggestions } = selectMedications({
      symptomText: 'itchy rash all over',
      patient: adult({ isPregnant: true, sex: 'female' }),
    });
    expect(suggestions.find((s) => /cetirizine/i.test(s.drug))).toBeUndefined();
  });

  it('still allows a pregnancy-safe medicine in pregnancy', () => {
    const { suggestions } = selectMedications({
      symptomText: 'fever',
      patient: adult({ isPregnant: true, sex: 'female' }),
    });
    expect(suggestions.find((s) => /paracetamol/i.test(s.drug))).toBeDefined();
  });

  it('respects an upper age limit', () => {
    // Zinc is indicated for childhood diarrhoea, not adult.
    const { suggestions } = selectMedications({
      symptomText: 'diarrhoea', patient: adult({ ageYears: 30 }),
    });
    expect(suggestions.find((s) => /zinc/i.test(s.drug))).toBeUndefined();

    const child = selectMedications({
      symptomText: 'diarrhoea', patient: { ageYears: 3, allergies: [], history: [] },
    });
    expect(child.suggestions.find((s) => /zinc/i.test(s.drug))).toBeDefined();
  });

  it('records WHY each suggestion was suppressed', () => {
    const { suppressed } = selectMedications({
      symptomText: 'fever', patient: adult({ allergies: ['paracetamol'] }),
    });
    // The assistant must be able to see why nothing was offered.
    expect(suppressed[0].reasons.length).toBeGreaterThan(0);
    expect(suppressed[0].ruleSourceId).toEqual(expect.any(String));
  });
});

describe('formulary integrity', () => {
  it('every entry cites a published source', () => {
    for (const entry of FORMULARY) {
      expect(entry.source).toEqual(expect.any(String));
      expect(entry.source.length).toBeGreaterThan(3);
    }
  });

  it('every entry has a unique id', () => {
    const ids = FORMULARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry carries a duration cap', () => {
    // Nothing is open-ended; an OTC suggestion that never expires is how
    // self-medication starts.
    for (const entry of FORMULARY) {
      expect(entry.maxDurationDays).toBeGreaterThan(0);
      expect(entry.maxDurationDays).toBeLessThanOrEqual(14);
    }
  });

  it('every entry carries a safety warning', () => {
    for (const entry of FORMULARY) {
      expect(entry.warning).toEqual(expect.any(String));
    }
  });

  it('evaluateGates never throws on a sparse patient record', () => {
    for (const entry of FORMULARY) {
      expect(() => evaluateGates(entry, {})).not.toThrow();
      expect(() => evaluateGates(entry, null)).not.toThrow();
    }
  });
});

describe('next step matches the tier', () => {
  it.each([
    ['low', 'doctor_review'],
    ['medium', 'video_consultation'],
    ['high', 'hospital_referral'],
  ])('%s tier routes to %s', (tier, action) => {
    const plan = composeCarePlan({ tier, symptomText: 'fever', patient: adult() });
    expect(plan.nextStep.action).toBe(action);
  });

  it('HIGH explicitly tells the assistant not to medicate', () => {
    const plan = composeCarePlan({ tier: 'high', symptomText: 'chest pain', patient: adult() });
    expect(plan.nextStep.detail).toMatch(/do not give any medication/i);
  });
});

describe('diet guidance is optional', () => {
  it('is provided where a condition table matches', () => {
    const plan = composeCarePlan({ tier: 'low', symptomText: 'diarrhoea', patient: adult() });
    expect(plan.diet.length).toBeGreaterThan(0);
  });

  it('is empty rather than invented when nothing applies', () => {
    const plan = composeCarePlan({ tier: 'low', symptomText: 'small cut on finger', patient: adult() });
    expect(plan.diet).toEqual([]);
  });
});
