/**
 * OTC formulary — a deterministic rules table, never a model output.
 *
 * ==================== READ THIS BEFORE EDITING ====================
 * >>> NOT CLINICALLY VALIDATED FOR THIS DEPLOYMENT. <<<
 *
 * Every dose below is taken from a PUBLISHED standard source, cited per
 * entry — WHO IMCI, WHO ORS/zinc guidance, and India's National List of
 * Essential Medicines. Nothing here is invented. But "the numbers are
 * standard" is not the same as "a clinician has signed off that THIS
 * SYSTEM applies them correctly to THIS population", and only the second
 * makes it safe to act on. Until that sign-off exists, every medication
 * this table produces is presented as an AI SUGGESTION PENDING DOCTOR
 * REVIEW and is queued for a doctor, never handed over as an instruction.
 *
 * WHY A TABLE AND NOT A MODEL: a generative model that emits drug names
 * and doses is an unbounded liability surface — hallucinated doses, missed
 * contraindications, paediatric weight errors. The LLM may retrieve and
 * explain an entry from this table; it may never author one. A medication
 * row with no `ruleSourceId` is rejected by a database constraint.
 *
 * SCOPE: LOW tier only. MEDIUM produces a doctor-issued prescription after
 * a video consultation; HIGH produces a referral and no medication at all.
 * =================================================================
 */

/** Stamped onto every suggestion so a historical decision is reproducible. */
export const FORMULARY_VERSION = '2026.08.1-unvalidated';

/**
 * Age bands, in years. Fractions are used for infants (0.5 = 6 months).
 * Paediatric dosing is weight-based wherever a weight is available; the
 * age band is a fallback and a safety gate, not a substitute.
 */
export const FORMULARY = [
  {
    id: 'para-001',
    drug: 'Paracetamol (Acetaminophen)',
    form: 'Oral tablet / syrup',
    indications: [/fever/i, /\bpain\b/i, /headache/i, /body ache/i, /myalgia/i],
    source: 'WHO IMCI; NLEM India',
    minAgeYears: 0.25,
    adult: {
      minAgeYears: 12,
      dose: '500–1000 mg',
      frequency: 'every 6 hours as needed',
      maxDaily: '4 g in 24 hours',
    },
    paediatric: {
      // The single most important number on this page: paediatric
      // paracetamol is weight-based, and a weight-less guess is how
      // children are overdosed.
      mgPerKg: 15,
      frequency: 'every 6 hours as needed',
      maxMgPerKgDaily: 60,
      requiresWeight: true,
    },
    contraindications: [/liver/i, /hepat/i, /jaundice/i, /paracetamol/i, /acetaminophen/i],
    pregnancySafe: true,
    maxDurationDays: 3,
    warning:
      'Do not exceed the stated daily maximum. Check that no other product being taken already contains paracetamol.',
  },
  {
    id: 'ors-001',
    drug: 'Oral Rehydration Salts (WHO formula)',
    form: 'Oral solution',
    indications: [/diarrh/i, /loose motion/i, /dehydrat/i, /vomit/i],
    source: 'WHO/UNICEF ORS guidance',
    minAgeYears: 0,
    adult: {
      minAgeYears: 12,
      dose: '200–400 mL',
      frequency: 'after each loose stool',
      maxDaily: 'As required to maintain hydration',
    },
    paediatric: {
      dose: '50–100 mL',
      frequency: 'after each loose stool',
      requiresWeight: false,
    },
    contraindications: [],
    pregnancySafe: true,
    maxDurationDays: 7,
    warning:
      'ORS treats dehydration, not the cause. If the child cannot drink, is lethargic, or has blood in the stool, escalate immediately.',
  },
  {
    id: 'zinc-001',
    drug: 'Zinc sulphate',
    form: 'Oral tablet / syrup',
    indications: [/diarrh/i, /loose motion/i],
    source: 'WHO/UNICEF zinc in childhood diarrhoea',
    minAgeYears: 0,
    maxAgeYears: 5,
    paediatric: {
      dose: '20 mg daily (10 mg daily if under 6 months)',
      frequency: 'once daily for 10–14 days',
      requiresWeight: false,
    },
    contraindications: [],
    pregnancySafe: true,
    maxDurationDays: 14,
    warning: 'Give for the full 10–14 days even after the diarrhoea stops.',
  },
  {
    id: 'cetiri-001',
    drug: 'Cetirizine',
    form: 'Oral tablet / syrup',
    indications: [/allerg/i, /itch/i, /rash/i, /urticaria/i, /sneez/i, /runny nose/i],
    source: 'NLEM India',
    minAgeYears: 2,
    adult: {
      minAgeYears: 12,
      dose: '10 mg',
      frequency: 'once daily',
      maxDaily: '10 mg in 24 hours',
    },
    paediatric: {
      dose: '5 mg (ages 6–11); 2.5 mg (ages 2–5)',
      frequency: 'once daily',
      requiresWeight: false,
    },
    contraindications: [/cetirizine/i, /antihistamine/i, /kidney/i, /renal/i],
    pregnancySafe: false,
    maxDurationDays: 5,
    warning: 'May cause drowsiness. Avoid in pregnancy unless a doctor advises otherwise.',
  },
  {
    id: 'povidone-001',
    drug: 'Povidone-iodine 5% solution',
    form: 'Topical antiseptic',
    indications: [/wound/i, /\bcut\b/i, /abrasion/i, /graze/i, /laceration/i],
    source: 'NLEM India; standard wound-care protocol',
    minAgeYears: 2,
    topical: {
      dose: 'Apply to the cleaned wound',
      frequency: 'once or twice daily',
    },
    // Iodine is absorbed through broken skin and affects thyroid function;
    // neonates and thyroid disease are genuine exclusions, not caution.
    contraindications: [/thyroid/i, /iodine/i],
    pregnancySafe: false,
    maxDurationDays: 5,
    warning:
      'For external use only. Do not use on large burns or deep wounds. Avoid in thyroid disease and in pregnancy.',
  },
];

/**
 * Evaluates the hard safety gates for one formulary entry.
 *
 * A failed gate SUPPRESSES the suggestion; it does not downgrade to a
 * warning. Every rejection carries a reason, both so the assistant
 * understands why nothing was offered and so the behaviour is auditable.
 *
 * @returns {{allowed: boolean, reasons: string[]}}
 */
export function evaluateGates(entry, patient) {
  const reasons = [];
  const age = Number.isFinite(patient?.ageYears) ? patient.ageYears : null;

  // Age is not optional. Without it, paediatric dosing cannot be checked
  // and the entry is refused rather than guessed.
  if (age === null) {
    reasons.push('Patient age is unknown, so dosing cannot be checked safely');
  } else {
    if (entry.minAgeYears !== undefined && age < entry.minAgeYears) {
      reasons.push(`Not suitable under ${entry.minAgeYears} years of age`);
    }
    if (entry.maxAgeYears !== undefined && age > entry.maxAgeYears) {
      reasons.push(`Indicated only up to ${entry.maxAgeYears} years of age`);
    }
  }

  // Weight-based paediatric dosing without a weight is the classic
  // paediatric overdose. Refuse rather than fall back to an age band.
  const isPaediatric = age !== null && age < 12;
  if (isPaediatric && entry.paediatric?.requiresWeight && !Number.isFinite(patient?.weightKg)) {
    reasons.push('Weight is required to calculate a safe paediatric dose');
  }

  if (patient?.isPregnant && entry.pregnancySafe === false) {
    reasons.push('Not recommended in pregnancy');
  }

  // Allergy and history matching. A stated allergy is enough — the system
  // never weighs a reported allergy against a suggestion's usefulness.
  const haystack = [
    ...(patient?.allergies ?? []),
    ...(patient?.history ?? []),
  ].join(' ; ');

  for (const pattern of entry.contraindications ?? []) {
    if (pattern.test(haystack)) {
      reasons.push('A recorded allergy or condition contraindicates this medicine');
      break;
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Renders the dose line for a patient, or null when it cannot be computed. */
function doseFor(entry, patient) {
  const age = patient?.ageYears;
  const weight = patient?.weightKg;

  if (entry.topical) {
    return { dose: entry.topical.dose, frequency: entry.topical.frequency, basis: 'topical' };
  }

  const isAdult = Number.isFinite(age) && age >= (entry.adult?.minAgeYears ?? 12);

  if (isAdult && entry.adult) {
    return {
      dose: entry.adult.dose,
      frequency: entry.adult.frequency,
      maxDaily: entry.adult.maxDaily,
      basis: 'adult',
    };
  }

  if (entry.paediatric) {
    if (entry.paediatric.mgPerKg && Number.isFinite(weight)) {
      const perDose = Math.round(entry.paediatric.mgPerKg * weight);
      const maxDaily = entry.paediatric.maxMgPerKgDaily
        ? `${Math.round(entry.paediatric.maxMgPerKgDaily * weight)} mg in 24 hours`
        : undefined;
      return {
        dose: `${perDose} mg (${entry.paediatric.mgPerKg} mg/kg × ${weight} kg)`,
        frequency: entry.paediatric.frequency,
        maxDaily,
        basis: 'weight',
      };
    }
    if (entry.paediatric.dose) {
      return {
        dose: entry.paediatric.dose,
        frequency: entry.paediatric.frequency,
        basis: 'age_band',
      };
    }
  }

  return null;
}

/**
 * Selects medication suggestions for a presentation.
 *
 * @param {object} params
 * @param {string} params.symptomText
 * @param {object} params.patient  ageYears, weightKg, isPregnant, allergies[], history[]
 * @returns {{suggestions: Array, suppressed: Array}}
 */
export function selectMedications({ symptomText = '', patient = {} }) {
  const suggestions = [];
  const suppressed = [];

  for (const entry of FORMULARY) {
    const indicated = entry.indications.some((re) => re.test(symptomText));
    if (!indicated) continue;

    const gate = evaluateGates(entry, patient);
    if (!gate.allowed) {
      suppressed.push({ drug: entry.drug, ruleSourceId: entry.id, reasons: gate.reasons });
      continue;
    }

    const dosing = doseFor(entry, patient);
    if (!dosing) {
      suppressed.push({
        drug: entry.drug,
        ruleSourceId: entry.id,
        reasons: ['A safe dose could not be determined for this patient'],
      });
      continue;
    }

    suggestions.push({
      // Never null — a database constraint rejects an unsourced medication.
      ruleSourceId: entry.id,
      drug: entry.drug,
      form: entry.form,
      ...dosing,
      maxDurationDays: entry.maxDurationDays,
      warning: entry.warning,
      source: entry.source,
      formularyVersion: FORMULARY_VERSION,
      status: 'pending_doctor_review',
    });
  }

  return { suggestions, suppressed };
}

export default { FORMULARY, selectMedications, evaluateGates, FORMULARY_VERSION };
