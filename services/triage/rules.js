/**
 * Deterministic red-flag rules.
 *
 * ============================ SAFETY NOTE ============================
 * These thresholds are DERIVED FROM PUBLISHED SOURCES but are NOT YET
 * CLINICALLY VALIDATED for this deployment. They must be reviewed and
 * signed off by a registered physician before any real patient use.
 * See docs/DECISIONS.md D-027.
 *
 * Sources each rule cites:
 *   NEWS2  — RCP National Early Warning Score 2 (adult physiological)
 *   IMCI   — WHO Integrated Management of Childhood Illness danger signs
 *   PALS   — age-banded paediatric vital ranges
 * ====================================================================
 *
 * WHY RULES AND NOT A MODEL:
 * These set the FLOOR of the triage tier. A model may raise the tier; it
 * may never lower it below what these rules say. A learned triage
 * classifier's failure mode — confidently under-triaging an atypical
 * presentation — is the one failure this system cannot accept. These rules
 * are boring, explainable, and testable, which is exactly right here.
 *
 * Every rule returns the values that fired, so "why did it say HIGH?"
 * always has a precise answer.
 */

export const TIER = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

const TIER_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/** Ordering helper — the whole engine depends on this being total. */
export function maxTier(a, b) {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function tierRank(tier) {
  return TIER_RANK[tier];
}

/** Version stamped onto every assessment so historical decisions replay. */
export const RULESET_VERSION = '2026.08.1-unvalidated';

/** Age-banded respiratory rate (PALS). Upper bound only; breaths/min. */
function respiratoryUpperBound(ageYears) {
  if (ageYears < 1) return 60;
  if (ageYears < 3) return 40;
  if (ageYears < 6) return 34;
  if (ageYears < 12) return 30;
  return 24;
}

function respiratoryLowerBound(ageYears) {
  if (ageYears < 1) return 30;
  if (ageYears < 3) return 20;
  if (ageYears < 12) return 16;
  return 10;
}

/**
 * Symptom phrases that are red flags regardless of vitals.
 * Matched against normalised English text; the multilingual layer
 * translates before this runs.
 */
const HIGH_RISK_PHRASES = [
  { match: /chest pain|crushing.*chest|tightness in chest/i, label: 'chest_pain' },
  { match: /cannot breathe|can't breathe|breathless at rest|gasping/i, label: 'dyspnoea_at_rest' },
  { match: /unconscious|unresponsive|not waking|altered consciousness/i, label: 'altered_consciousness' },
  { match: /convulsion|seizure|fitting/i, label: 'convulsions' },
  { match: /bleeding heavily|uncontrolled bleeding|haemorrhage|hemorrhage/i, label: 'uncontrolled_bleeding' },
  { match: /stiff neck|neck stiffness/i, label: 'meningism' },
  { match: /suicidal|kill (myself|himself|herself)|self harm/i, label: 'suicidal_ideation' },
  { match: /blue lips|cyanosis|turning blue/i, label: 'cyanosis' },
  { match: /severe dehydration|sunken eyes.*not drinking/i, label: 'severe_dehydration' },
  { match: /poison|overdose|snake ?bite/i, label: 'toxic_exposure' },
];

const MEDIUM_RISK_PHRASES = [
  { match: /persistent vomiting|vomiting everything/i, label: 'persistent_vomiting' },
  { match: /blood in (stool|urine|vomit|sputum)/i, label: 'occult_bleeding' },
  { match: /severe (pain|headache)/i, label: 'severe_pain' },
  { match: /weight loss|losing weight/i, label: 'unexplained_weight_loss' },
  { match: /night sweats/i, label: 'night_sweats' },
];

/** IMCI general danger signs — under 5 years only. */
const IMCI_DANGER_SIGNS = [
  { match: /unable to drink|not drinking|refuses? (to )?(feed|breastfeed)/i, label: 'imci_unable_to_drink' },
  { match: /vomits everything|vomiting everything/i, label: 'imci_vomits_everything' },
  { match: /convulsion|seizure|fitting/i, label: 'imci_convulsions' },
  { match: /lethargic|unconscious|very sleepy|difficult to wake/i, label: 'imci_lethargy' },
  { match: /chest indrawing|retractions/i, label: 'imci_chest_indrawing' },
  { match: /stridor/i, label: 'imci_stridor' },
];

/**
 * Evaluates all rules.
 *
 * @param {object} input
 * @param {object} [input.vitals]   temperatureC, spo2, systolic, diastolic,
 *                                  pulseBpm, respiratoryRate
 * @param {object} input.patient    ageYears, sex, isPregnant,
 *                                  registrationComplete
 * @param {string} [input.symptomText] normalised English symptom text
 * @returns {{tier: string, hits: Array, version: string}}
 */
export function evaluateRules(input = {}) {
  const hits = [];
  const vitals = input.vitals ?? {};
  const patient = input.patient ?? {};
  const text = input.symptomText ?? '';
  const age = Number.isFinite(patient.ageYears) ? patient.ageYears : null;

  const flag = (tier, code, detail) => hits.push({ tier, code, ...detail });

  // ---- Oxygen saturation (NEWS2) --------------------------------------
  if (Number.isFinite(vitals.spo2)) {
    if (vitals.spo2 < 92) {
      flag(TIER.HIGH, 'spo2_critical', { value: vitals.spo2, threshold: 92, source: 'NEWS2' });
    } else if (vitals.spo2 < 95) {
      flag(TIER.MEDIUM, 'spo2_low', { value: vitals.spo2, threshold: 95, source: 'NEWS2' });
    }
  }

  // ---- Blood pressure (NEWS2) -----------------------------------------
  if (Number.isFinite(vitals.systolic)) {
    if (vitals.systolic < 90 || vitals.systolic > 180) {
      flag(TIER.HIGH, 'systolic_critical', {
        value: vitals.systolic, range: [90, 180], source: 'NEWS2',
      });
    } else if (vitals.systolic < 100 || vitals.systolic > 160) {
      flag(TIER.MEDIUM, 'systolic_abnormal', {
        value: vitals.systolic, range: [100, 160], source: 'NEWS2',
      });
    }
  }

  // ---- Pulse (NEWS2) ---------------------------------------------------
  if (Number.isFinite(vitals.pulseBpm)) {
    if (vitals.pulseBpm < 40 || vitals.pulseBpm > 130) {
      flag(TIER.HIGH, 'pulse_critical', {
        value: vitals.pulseBpm, range: [40, 130], source: 'NEWS2',
      });
    } else if (vitals.pulseBpm < 50 || vitals.pulseBpm > 110) {
      flag(TIER.MEDIUM, 'pulse_abnormal', {
        value: vitals.pulseBpm, range: [50, 110], source: 'NEWS2',
      });
    }
  }

  // ---- Temperature (NEWS2) --------------------------------------------
  if (Number.isFinite(vitals.temperatureC)) {
    if (vitals.temperatureC >= 39.5 || vitals.temperatureC <= 35.0) {
      flag(TIER.HIGH, 'temperature_critical', {
        value: vitals.temperatureC, range: [35.0, 39.5], source: 'NEWS2',
      });
    } else if (vitals.temperatureC >= 38.0 || vitals.temperatureC < 36.0) {
      flag(TIER.MEDIUM, 'temperature_abnormal', {
        value: vitals.temperatureC, range: [36.0, 38.0], source: 'NEWS2',
      });
    }
  }

  // ---- Respiratory rate (age-banded, PALS) ----------------------------
  if (Number.isFinite(vitals.respiratoryRate) && age !== null) {
    const upper = respiratoryUpperBound(age);
    const lower = respiratoryLowerBound(age);
    if (vitals.respiratoryRate > upper || vitals.respiratoryRate < lower) {
      flag(TIER.HIGH, 'respiratory_rate_critical', {
        value: vitals.respiratoryRate, range: [lower, upper], ageYears: age, source: 'PALS',
      });
    }
  }

  // ---- Age extremes ----------------------------------------------------
  // Infants under two months decompensate fast and hide it. Any presentation
  // at this age warrants a doctor, not a protocol.
  if (age !== null && age < 0.17) {
    flag(TIER.HIGH, 'neonate', { ageYears: age, source: 'IMCI' });
  } else if (age !== null && age < 1) {
    flag(TIER.MEDIUM, 'infant', { ageYears: age, source: 'IMCI' });
  }

  if (age !== null && age >= 65) {
    flag(TIER.MEDIUM, 'elderly', { ageYears: age, source: 'NEWS2' });
  }

  // ---- Pregnancy -------------------------------------------------------
  if (patient.isPregnant === true) {
    flag(TIER.MEDIUM, 'pregnancy', { source: 'protocol' });
  }

  // ---- IMCI danger signs (under 5) ------------------------------------
  if (age !== null && age < 5) {
    for (const sign of IMCI_DANGER_SIGNS) {
      if (sign.match.test(text)) {
        flag(TIER.HIGH, sign.label, { source: 'IMCI' });
      }
    }
  }

  // ---- Symptom red flags ----------------------------------------------
  for (const phrase of HIGH_RISK_PHRASES) {
    if (phrase.match.test(text)) flag(TIER.HIGH, phrase.label, { source: 'protocol' });
  }
  for (const phrase of MEDIUM_RISK_PHRASES) {
    if (phrase.match.test(text)) flag(TIER.MEDIUM, phrase.label, { source: 'protocol' });
  }

  // ---- Missing data is NOT normal data --------------------------------
  // Absent vitals do not mean normal vitals. A record with nothing measured
  // cannot be called low risk, so the floor rises and the assistant is
  // prompted to measure.
  const criticalVitals = ['spo2', 'pulseBpm', 'temperatureC'];
  const missing = criticalVitals.filter((k) => !Number.isFinite(vitals[k]));
  if (missing.length === criticalVitals.length) {
    flag(TIER.MEDIUM, 'no_vitals_recorded', { missing, source: 'fail-safe' });
  } else if (missing.length > 0) {
    flag(TIER.MEDIUM, 'incomplete_vitals', { missing, source: 'fail-safe' });
  }

  if (age === null) {
    flag(TIER.MEDIUM, 'age_unknown', { source: 'fail-safe' });
  }

  if (patient.registrationComplete === false) {
    flag(TIER.MEDIUM, 'registration_incomplete', { source: 'fail-safe' });
  }

  const tier = hits.reduce((acc, h) => maxTier(acc, h.tier), TIER.LOW);

  return { tier, hits, version: RULESET_VERSION };
}

export default { evaluateRules, maxTier, tierRank, TIER, RULESET_VERSION };
