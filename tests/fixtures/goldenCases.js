/**
 * Golden triage cases.
 *
 * ======================== READ BEFORE EDITING ========================
 * This is the single most valuable safety artifact in the repository.
 *
 * Every case states the MINIMUM acceptable tier. A change to the rules,
 * prompts, or model version that lowers any case below its expected tier
 * FAILS THE BUILD. That is the point — under-triage is the failure mode
 * this system cannot accept.
 *
 * Raising a tier above expectation is allowed (over-triage is safe), except
 * where `exact: true` says otherwise.
 *
 * These cases are CONSTRUCTED, not real patient data, and they have NOT been
 * reviewed by a clinician yet. Physician sign-off is required before this
 * suite means anything clinically. See docs/DECISIONS.md D-027.
 * ====================================================================
 */

/** Vitals that trip nothing, so a case tests only what it intends to. */
const NORMAL_VITALS = {
  temperatureC: 37.0,
  spo2: 98,
  systolic: 120,
  diastolic: 78,
  pulseBpm: 76,
  respiratoryRate: 16,
};

const adult = (over = {}) => ({
  ageYears: 34,
  sex: 'male',
  registrationComplete: true,
  ...over,
});

export const GOLDEN_CASES = [
  // ---------------------------------------------------------------
  // LOW — genuinely minor, everything measured and normal
  // ---------------------------------------------------------------
  {
    id: 'low-minor-cut',
    description: 'Small clean cut on the hand, all vitals normal',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult(),
      symptomText: 'small cut on hand from a knife while cooking, bleeding stopped',
    },
    expectedMinimum: 'low',
    exact: true,
  },
  {
    id: 'low-mild-headache',
    description: 'Mild headache, two days, normal vitals',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 28 }),
      symptomText: 'mild headache for two days, no fever',
    },
    expectedMinimum: 'low',
    exact: true,
  },

  // ---------------------------------------------------------------
  // HIGH — vitals alone must escalate, regardless of the narrative
  // ---------------------------------------------------------------
  {
    id: 'high-hypoxia',
    description: 'SpO2 88% — hypoxic, whatever else is going on',
    input: {
      vitals: { ...NORMAL_VITALS, spo2: 88 },
      patient: adult(),
      symptomText: 'feeling a bit tired',
    },
    expectedMinimum: 'high',
    mustHitRule: 'spo2_critical',
  },
  {
    id: 'high-hypotension',
    description: 'Systolic 82 — shock territory',
    input: {
      vitals: { ...NORMAL_VITALS, systolic: 82 },
      patient: adult(),
      symptomText: 'feeling weak',
    },
    expectedMinimum: 'high',
    mustHitRule: 'systolic_critical',
  },
  {
    id: 'high-hyperpyrexia',
    description: 'Temperature 40.1C',
    input: {
      vitals: { ...NORMAL_VITALS, temperatureC: 40.1 },
      patient: adult(),
      symptomText: 'fever since yesterday',
    },
    expectedMinimum: 'high',
    mustHitRule: 'temperature_critical',
  },
  {
    id: 'high-hypothermia',
    description: 'Temperature 34.5C — hypothermia is as dangerous as fever',
    input: {
      vitals: { ...NORMAL_VITALS, temperatureC: 34.5 },
      patient: adult({ ageYears: 70 }),
      symptomText: 'found confused outside',
    },
    expectedMinimum: 'high',
    mustHitRule: 'temperature_critical',
  },
  {
    id: 'high-bradycardia',
    description: 'Pulse 38 — symptomatic bradycardia in an older adult',
    input: {
      vitals: { ...NORMAL_VITALS, pulseBpm: 38 },
      patient: adult({ ageYears: 68 }),
      symptomText: 'dizzy when standing',
    },
    expectedMinimum: 'high',
    mustHitRule: 'pulse_critical',
  },

  // ---------------------------------------------------------------
  // HIGH — symptom red flags with entirely normal vitals.
  // These are the cases a vitals-only system misses.
  // ---------------------------------------------------------------
  {
    id: 'high-chest-pain-normal-vitals',
    description: 'Crushing chest pain, vitals still normal',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 52 }),
      symptomText: 'crushing chest pain radiating to left arm for one hour',
    },
    expectedMinimum: 'high',
    mustHitRule: 'chest_pain',
  },
  {
    id: 'high-altered-consciousness',
    description: 'Unresponsive, vitals not yet deranged',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult(),
      symptomText: 'patient is unconscious and not waking up',
    },
    expectedMinimum: 'high',
    mustHitRule: 'altered_consciousness',
  },
  {
    id: 'high-uncontrolled-bleeding',
    description: 'Heavy bleeding, compensating vitals',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult(),
      symptomText: 'bleeding heavily from leg wound, cannot stop it',
    },
    expectedMinimum: 'high',
    mustHitRule: 'uncontrolled_bleeding',
  },
  {
    id: 'high-suicidal-ideation',
    description: 'Suicidal ideation — a mental health emergency',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 22 }),
      symptomText: 'says he wants to kill himself',
    },
    expectedMinimum: 'high',
    mustHitRule: 'suicidal_ideation',
  },
  {
    id: 'high-snakebite',
    description: 'Snake bite — realistic and time-critical in a village setting',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 41 }),
      symptomText: 'snakebite on ankle while working in the field an hour ago',
    },
    expectedMinimum: 'high',
    mustHitRule: 'toxic_exposure',
  },

  // ---------------------------------------------------------------
  // HIGH — IMCI danger signs in under-5s
  // ---------------------------------------------------------------
  {
    id: 'high-imci-lethargy',
    description: 'Three-year-old, lethargic and hard to wake',
    input: {
      vitals: { ...NORMAL_VITALS, respiratoryRate: 28 },
      patient: { ageYears: 3, sex: 'female', registrationComplete: true },
      symptomText: 'child is very sleepy and difficult to wake',
    },
    expectedMinimum: 'high',
    mustHitRule: 'imci_lethargy',
  },
  {
    id: 'high-imci-unable-to-drink',
    description: 'Two-year-old refusing to feed',
    input: {
      vitals: { ...NORMAL_VITALS, respiratoryRate: 30 },
      patient: { ageYears: 2, sex: 'male', registrationComplete: true },
      symptomText: 'child is not drinking and refuses to breastfeed',
    },
    expectedMinimum: 'high',
    mustHitRule: 'imci_unable_to_drink',
  },
  {
    id: 'high-neonate-any-presentation',
    description: 'Three-week-old with mild fever — neonates decompensate silently',
    input: {
      vitals: { ...NORMAL_VITALS, temperatureC: 37.8, respiratoryRate: 45 },
      patient: { ageYears: 0.06, sex: 'female', registrationComplete: true },
      symptomText: 'baby feels warm',
    },
    expectedMinimum: 'high',
    mustHitRule: 'neonate',
  },
  {
    id: 'high-paediatric-tachypnoea',
    description: 'Four-year-old breathing 44/min',
    input: {
      vitals: { ...NORMAL_VITALS, respiratoryRate: 44 },
      patient: { ageYears: 4, sex: 'male', registrationComplete: true },
      symptomText: 'coughing and breathing fast',
    },
    expectedMinimum: 'high',
    mustHitRule: 'respiratory_rate_critical',
  },

  // ---------------------------------------------------------------
  // MEDIUM — needs a doctor, not a hospital
  // ---------------------------------------------------------------
  {
    id: 'medium-fever',
    description: 'Fever 38.4C, otherwise stable',
    input: {
      vitals: { ...NORMAL_VITALS, temperatureC: 38.4 },
      patient: adult(),
      symptomText: 'fever and body ache for three days',
    },
    expectedMinimum: 'medium',
  },
  {
    id: 'medium-pregnancy',
    description: 'Pregnant patient with a minor complaint',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 26, sex: 'female', isPregnant: true }),
      symptomText: 'mild back pain',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'pregnancy',
  },
  {
    id: 'medium-elderly',
    description: 'Elderly patient, minor complaint, normal vitals',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 72 }),
      symptomText: 'mild knee pain when walking',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'elderly',
  },
  {
    id: 'medium-tb-screening-pattern',
    description: 'Weight loss plus night sweats — TB screening pathway',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ ageYears: 45 }),
      symptomText: 'cough for three weeks with weight loss and night sweats',
    },
    expectedMinimum: 'medium',
  },

  // ---------------------------------------------------------------
  // MISSING DATA — absence of evidence is not evidence of absence
  // ---------------------------------------------------------------
  {
    id: 'medium-no-vitals-at-all',
    description: 'Nothing measured — cannot be called low risk',
    input: {
      vitals: {},
      patient: adult(),
      symptomText: 'not feeling well',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'no_vitals_recorded',
  },
  {
    id: 'medium-partial-vitals',
    description: 'Only temperature measured',
    input: {
      vitals: { temperatureC: 37.2 },
      patient: adult(),
      symptomText: 'mild sore throat',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'incomplete_vitals',
  },
  {
    id: 'medium-age-unknown',
    description: 'Age unknown — dosing and danger signs both depend on it',
    input: {
      vitals: NORMAL_VITALS,
      patient: { sex: 'undisclosed', registrationComplete: true },
      symptomText: 'stomach pain',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'age_unknown',
  },
  {
    id: 'medium-emergency-registration',
    description: 'Emergency bypass record, incomplete',
    input: {
      vitals: NORMAL_VITALS,
      patient: adult({ registrationComplete: false }),
      symptomText: 'injured arm',
    },
    expectedMinimum: 'medium',
    mustHitRule: 'registration_incomplete',
  },
];

export default GOLDEN_CASES;
