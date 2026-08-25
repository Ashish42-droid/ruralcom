/**
 * Care plan composer — turns a triage tier into the exact output the spec
 * defines for that tier.
 *
 * §3.6 of the brief:
 *   LOW    first aid · patient details · medication (queued for doctor
 *          review) · point-wise precautions · optional diet
 *   MEDIUM first aid · patient details · video consultation · precautions
 *          · optional diet.  NO medication — the doctor prescribes.
 *   HIGH   first aid · patient details · danger-zone state · referral and
 *          printable slip · precautions.  NO medication.
 *
 * Everything here is DETERMINISTIC. First aid and precautions come from
 * protocol tables, medication from the signed formulary, and diet from a
 * condition table. The model contributes the differential and the
 * reasoning; it does not author care instructions.
 *
 * >>> PROTOCOL CONTENT IS UNVALIDATED pending physician sign-off, same
 *     status as the triage thresholds. <<<
 */
import { selectMedications, FORMULARY_VERSION } from './formulary.js';

export const PROTOCOL_VERSION = '2026.08.1-unvalidated';

/**
 * First-aid protocols, matched against the presentation.
 *
 * Ordered most-specific first: the first match wins, so "crushing chest
 * pain" gets the cardiac protocol rather than the generic one.
 */
const FIRST_AID = [
  {
    match: /chest pain|crushing.*chest|pain.*radiat.*arm/i,
    title: 'Suspected cardiac event',
    steps: [
      'Sit the patient upright and keep them still. Do not let them walk.',
      'Loosen tight clothing and keep the area around them clear.',
      'Give oxygen if available.',
      'Do NOT give food or water.',
      'Arrange urgent transfer. Stay with the patient throughout.',
      'If they become unresponsive and are not breathing normally, begin CPR.',
    ],
    source: 'Standard emergency first-aid protocol',
  },
  {
    match: /uncontrolled bleeding|bleeding heavily|h[ae]morrhage/i,
    title: 'Severe bleeding',
    steps: [
      'Apply firm, direct pressure to the wound with a clean cloth or sterile pad.',
      'Do not remove a soaked dressing — add another layer on top and keep pressing.',
      'Raise the injured part above heart level if no fracture is suspected.',
      'Keep the patient warm and lying down.',
      'Do not apply a tourniquet unless trained and bleeding is life-threatening.',
      'Arrange urgent transfer.',
    ],
    source: 'Standard emergency first-aid protocol',
  },
  {
    match: /unconscious|unresponsive|altered consciousness|not waking/i,
    title: 'Reduced consciousness',
    steps: [
      'Check for breathing. If absent or abnormal, begin CPR immediately.',
      'If breathing, place in the recovery position on their side.',
      'Keep the airway clear; loosen anything tight around the neck.',
      'Do not give anything by mouth.',
      'Monitor breathing continuously and arrange urgent transfer.',
    ],
    source: 'Standard emergency first-aid protocol',
  },
  {
    match: /snake ?bite/i,
    title: 'Snake bite',
    steps: [
      'Keep the patient still and calm. Movement spreads venom faster.',
      'Immobilise the bitten limb and keep it BELOW heart level.',
      'Remove rings, bangles and anything tight before swelling begins.',
      'Do NOT cut, suck, apply ice, or use a tight tourniquet.',
      'Note the time of the bite and the appearance of the snake if seen safely.',
      'Transfer urgently to a facility with antivenom.',
    ],
    source: 'WHO snakebite management guidance',
  },
  {
    match: /burn|scald/i,
    title: 'Burn',
    steps: [
      'Cool the burn under clean running water for at least 20 minutes.',
      'Remove clothing and jewellery near the burn unless stuck to the skin.',
      'Cover loosely with a clean non-fluffy cloth or cling film.',
      'Do NOT apply ice, oil, toothpaste or any home remedy.',
      'Do not burst blisters.',
    ],
    source: 'Standard burn first-aid protocol',
  },
  {
    match: /wound|\bcut\b|laceration|abrasion|graze/i,
    title: 'Minor wound care',
    steps: [
      'Wash your hands and wear gloves if available.',
      'Irrigate the wound with clean running water or sterile saline.',
      'Remove visible dirt gently; do not scrub.',
      'Pat dry with a clean cloth and apply antiseptic to the surrounding skin.',
      'Cover with a sterile dressing.',
      'Check tetanus immunisation status and advise accordingly.',
    ],
    source: 'Standard wound-care protocol',
  },
  {
    match: /diarrh|loose motion|vomit|dehydrat/i,
    title: 'Diarrhoea and dehydration',
    steps: [
      'Start oral rehydration solution immediately and give it slowly and often.',
      'Continue normal feeding — including breastfeeding for infants.',
      'Watch for danger signs: sunken eyes, no urine, lethargy, inability to drink.',
      'If the patient cannot keep fluids down, escalate.',
    ],
    source: 'WHO IMCI',
  },
  {
    match: /fever|temperature/i,
    title: 'Fever',
    steps: [
      'Keep the patient cool and lightly clothed; avoid heavy blankets.',
      'Encourage frequent small amounts of fluid.',
      'Sponge with room-temperature water if the fever is high. Do not use cold water or ice.',
      'Recheck the temperature every few hours and record it.',
    ],
    source: 'WHO IMCI',
  },
  {
    match: /breath|dyspn|wheez|asthma/i,
    title: 'Breathing difficulty',
    steps: [
      'Sit the patient upright, leaning slightly forward.',
      'Loosen tight clothing and ensure fresh air.',
      'Give oxygen if available and trained to do so.',
      'Keep them calm — anxiety worsens breathlessness.',
      'Escalate urgently if lips or fingertips look blue.',
    ],
    source: 'Standard emergency first-aid protocol',
  },
];

/** Fallback so every case gets something actionable. */
const GENERAL_FIRST_AID = {
  title: 'General supportive care',
  steps: [
    'Make the patient comfortable and record their vital signs.',
    'Keep them hydrated unless they are drowsy or unable to swallow.',
    'Observe for any change in breathing, alertness or colour.',
    'Record anything that changes and when it changed.',
  ],
  source: 'General supportive care',
};

/** Precautions by presentation, always returned point-wise. */
const PRECAUTIONS = [
  {
    match: /fever/i,
    points: [
      'Return immediately if the fever lasts more than three days.',
      'Return immediately if a rash, neck stiffness or confusion develops.',
      'Complete any course of medicine the doctor prescribes.',
    ],
  },
  {
    match: /wound|\bcut\b|laceration/i,
    points: [
      'Keep the dressing clean and dry; change it daily.',
      'Return if the wound becomes red, swollen, warm, or starts discharging.',
      'Return if a red streak spreads from the wound or fever develops.',
      'Confirm tetanus vaccination is up to date.',
    ],
  },
  {
    match: /diarrh|loose motion|vomit/i,
    points: [
      'Drink ORS after every loose stool.',
      'Wash hands with soap before eating and after using the toilet.',
      'Use only boiled or treated drinking water.',
      'Return immediately if there is blood in the stool or the patient cannot drink.',
    ],
  },
  {
    match: /chest pain|breath|dyspn/i,
    points: [
      'Avoid all physical exertion until reviewed by a doctor.',
      'Do not travel alone.',
      'Return or call immediately if the pain returns, worsens, or spreads.',
    ],
  },
  {
    match: /allerg|rash|itch/i,
    points: [
      'Avoid the suspected trigger until reviewed.',
      'Do not scratch — it worsens the rash and risks infection.',
      'Return immediately if the lips, tongue or face swell, or breathing becomes difficult.',
    ],
  },
];

const GENERAL_PRECAUTIONS = [
  'Rest and maintain adequate fluid intake.',
  'Return to the health centre if symptoms worsen or do not improve.',
  'Do not take any medicine that has not been advised here or by a doctor.',
];

/** Diet guidance. Optional per the spec, so this may legitimately be empty. */
const DIET = [
  {
    match: /diarrh|loose motion|dehydrat/i,
    points: [
      'Continue normal feeding; do not stop breastfeeding an infant.',
      'Offer small, frequent meals — rice, khichdi, curd, banana.',
      'Avoid very sugary drinks and carbonated soft drinks.',
    ],
  },
  {
    match: /fever/i,
    points: [
      'Offer light, easily digested food such as dal, khichdi or soup.',
      'Increase fluid intake — water, nimbu paani, coconut water.',
    ],
  },
  {
    match: /an[ae]mia|haemoglobin|weak|tired|fatigue/i,
    points: [
      'Include iron-rich foods: green leafy vegetables, jaggery, dates, pulses.',
      'Take vitamin-C-rich food alongside iron-rich food to aid absorption.',
      'Avoid tea or coffee immediately after meals — they reduce iron absorption.',
    ],
  },
  {
    match: /glucose|diabet|sugar/i,
    points: [
      'Avoid sweets, sugary drinks and refined flour.',
      'Prefer whole grains, pulses and vegetables.',
      'Keep meal timings regular.',
    ],
  },
];

function matchAll(table, text) {
  return table.filter((row) => row.match.test(text)).flatMap((row) => row.points);
}

/**
 * Composes the tier-specific care plan.
 *
 * @param {object} params
 * @param {'low'|'medium'|'high'} params.tier
 * @param {string} params.symptomText
 * @param {object} params.patient
 * @returns {object} care plan
 */
export function composeCarePlan({ tier, symptomText = '', patient = {} }) {
  const text = symptomText || '';

  // First aid applies to EVERY tier — the assistant acts now, whatever
  // happens next.
  const firstAid = FIRST_AID.find((p) => p.match.test(text)) ?? GENERAL_FIRST_AID;

  const precautions = [...new Set(matchAll(PRECAUTIONS, text))];
  const diet = [...new Set(matchAll(DIET, text))];

  const plan = {
    tier,
    firstAid: {
      title: firstAid.title,
      steps: firstAid.steps,
      source: firstAid.source,
    },
    precautions: precautions.length ? precautions : GENERAL_PRECAUTIONS,
    diet, // May be empty — the spec marks diet optional.
    medications: [],
    suppressedMedications: [],
    nextStep: null,
    protocolVersion: PROTOCOL_VERSION,
    formularyVersion: FORMULARY_VERSION,
    disclaimer:
      'AI SUGGESTION — NOT A MEDICAL DECISION. Protocols and dosing are ' +
      'derived from published sources but are not clinically validated for ' +
      'this deployment. A doctor reviews every medication before it stands.',
  };

  if (tier === 'low') {
    const { suggestions, suppressed } = selectMedications({ symptomText: text, patient });
    plan.medications = suggestions;
    plan.suppressedMedications = suppressed;
    plan.nextStep = {
      action: 'doctor_review',
      label: 'Queued for daily doctor review',
      detail:
        'The doctor will approve this, or flag it back to you with a correction. ' +
        'Do not dispense any medication until it has been reviewed.',
    };
  } else if (tier === 'medium') {
    // No medication by design: the doctor prescribes during the call.
    plan.nextStep = {
      action: 'video_consultation',
      label: 'Video consultation required',
      detail:
        'A doctor is being assigned. Perform the first aid above while waiting. ' +
        'The doctor will issue any prescription directly.',
    };
  } else {
    plan.nextStep = {
      action: 'hospital_referral',
      label: 'Urgent hospital referral',
      detail:
        'Perform the first aid above and arrange transfer immediately. ' +
        'Do not give any medication.',
    };
  }

  return plan;
}

export { FORMULARY_VERSION };
export default { composeCarePlan, PROTOCOL_VERSION };
