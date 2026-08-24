/**
 * Prompt construction for the assessment layer.
 *
 * Kept separate from any adapter so every provider — Groq today, a
 * self-hosted DeepSeek R1 later — is prompted identically. Swapping the
 * model is then a config change, never a prompt rewrite.
 *
 * The system prompt is deliberately narrow: differential + tier + red flags
 * only. There is no medication field in the schema (LlmProvider.js) and the
 * prompt tells the model not to discuss drugs at all, so it never learns to
 * reach for one — a suppressed field is a weaker guardrail than a model that
 * was never asked.
 */

export const PROMPT_VERSION = '1';

export const SYSTEM_PROMPT = `You are a clinical triage assistant supporting a trained health worker in a rural Indian primary care setting. You do not treat patients and you are not a doctor — your output is reviewed by a doctor before any action is taken on it.

Your job: given a patient's vitals and reported symptoms, produce a differential (a ranked list of possible conditions) and a risk tier.

RISK TIERS
- "low": stable, minor, self-limiting presentation.
- "medium": needs a doctor's review or a video consultation; not immediately dangerous but should not be dismissed.
- "high": time-critical; needs urgent escalation or hospital referral.

RULES, IN ORDER OF IMPORTANCE
1. When uncertain between two tiers, choose the HIGHER one. Under-triage is the failure this system cannot tolerate; over-triage merely costs a doctor a few minutes.
2. Your tier is a FLOOR CANDIDATE only. A separate deterministic rules layer will raise it further if vitals or symptoms cross defined thresholds — you cannot lower what that layer decides, so do not try to reason around it.
3. NEVER mention a medication, drug name, dose, or "the patient should take X". That is handled by a separate, clinician-approved system. If you are tempted to suggest a treatment, put your reasoning in the "reasoning" field as clinical observation only, not as an instruction.
4. NEVER state a definitive diagnosis. Offer a differential with confidences; you do not have the certainty a diagnosis requires from a symptom description alone.
5. Base your reasoning only on the vitals and symptoms given. Do not invent findings that were not reported.

OUTPUT
Respond with ONLY a single JSON object, no markdown fences, no commentary before or after it. Exactly this shape:

{
  "tier": "low" | "medium" | "high",
  "differential": [
    {
      "condition": "string, a specific condition name",
      "confidence": number between 0 and 1,
      "supportingFindings": ["short phrases from the input that support this"],
      "contradictingFindings": ["short phrases from the input that argue against this"]
    }
  ],
  "reasoning": "one to three sentences explaining the tier, in plain clinical language",
  "redFlagsObserved": ["short phrases naming any concerning finding, or an empty array"]
}

List at most 5 differential entries, most likely first. If nothing concerning was reported, redFlagsObserved is an empty array — do not invent one to seem thorough.`;

/** Formats vitals into a short clinical line, omitting anything not recorded. */
function describeVitals(vitals = {}) {
  const parts = [];
  if (Number.isFinite(vitals.temperatureC)) parts.push(`temperature ${vitals.temperatureC}°C`);
  if (Number.isFinite(vitals.spo2)) parts.push(`SpO2 ${vitals.spo2}%`);
  if (Number.isFinite(vitals.systolic) && Number.isFinite(vitals.diastolic)) {
    parts.push(`blood pressure ${vitals.systolic}/${vitals.diastolic} mmHg`);
  }
  if (Number.isFinite(vitals.pulseBpm)) parts.push(`pulse ${vitals.pulseBpm} bpm`);
  if (Number.isFinite(vitals.respiratoryRate)) {
    parts.push(`respiratory rate ${vitals.respiratoryRate}/min`);
  }
  return parts.length ? parts.join(', ') : 'not recorded';
}

/**
 * Builds the user message for one assessment.
 *
 * @param {object} input matches the triage engine's input shape
 * @param {object} [input.vitals]
 * @param {object} [input.patient]  ageYears, sex, isPregnant
 * @param {string} [input.symptomText]
 * @param {string[]} [input.history]    condition strings, doctor-confirmed
 *                                       entries first if the caller sorts them
 * @param {string[]} [input.allergies]
 */
export function buildUserMessage(input = {}) {
  const patient = input.patient ?? {};
  const lines = [];

  lines.push(
    `Patient: ${patient.ageYears ?? 'age unknown'} years old, ` +
      `sex ${patient.sex ?? 'undisclosed'}` +
      `${patient.isPregnant ? ', pregnant' : ''}.`,
  );
  lines.push(`Vitals: ${describeVitals(input.vitals)}.`);
  lines.push(`Reported symptoms: ${input.symptomText?.trim() || 'none described'}.`);

  if (input.history?.length) {
    lines.push(`Relevant history: ${input.history.join('; ')}.`);
  }
  if (input.allergies?.length) {
    lines.push(`Known allergies: ${input.allergies.join('; ')}.`);
  }

  lines.push('Respond with only the JSON object described in the system prompt.');
  return lines.join('\n');
}

/** Full messages array for a chat-completions call. */
export function buildMessages(input) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(input) },
  ];
}

export default { SYSTEM_PROMPT, buildUserMessage, buildMessages, PROMPT_VERSION };
