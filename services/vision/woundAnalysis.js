/**
 * Wound image analysis — Gemini vision, constrained to a clinical rubric.
 *
 * ==================== WHY A RUBRIC, NOT A DESCRIPTION ====================
 * A free-form "describe this wound" answer is not clinically usable and
 * must never be shown to a health worker as an assessment — it reads as
 * authoritative while being unfalsifiable. Instead the model scores a
 * fixed set of axes (size, depth, tissue, infection signs, bleeding,
 * foreign body), and those SCORES feed the deterministic rule layer. The
 * model contributes observation; the rules decide the tier.
 *
 * ====================== THE SKIN-TONE PROBLEM =======================
 * Erythema — redness around a wound — is one of the main signals of
 * infection, and it is documented to be HARDER TO DETECT ON BROWN AND
 * BLACK SKIN. Most public wound and dermatology training data is heavily
 * Western and light-skinned, so a model's confidence about "no redness"
 * is systematically less trustworthy on exactly the population this
 * system serves.
 *
 * This is not hedging. It is a known failure mode with a real clinical
 * consequence: a missed early cellulitis. Two concrete responses here:
 *   1. Absence of erythema NEVER lowers the tier. Only its presence can
 *      raise one.
 *   2. Every analysis carries an explicit `limitations` entry saying so,
 *      which the UI surfaces rather than hides.
 * ====================================================================
 *
 * WOUND FINDINGS CAN ONLY ESCALATE. There is no image finding that
 * downgrades a case — the photograph is one input among several, and it
 * is the one most easily degraded by bad light, motion blur, or a phone
 * camera's aggressive processing.
 */
import { z } from 'zod';

import logger from '../../config/logger.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * `gemini-2.5-flash` is refused for new API keys — Google's own error
 * names 3.6-flash as the replacement. Verified working against the live
 * API before this was written.
 */
const DEFAULT_MODEL = 'gemini-3.6-flash';
// Generous because this runs as a BACKGROUND job after upload, not inline
// in the assessment request — nobody is waiting at a spinner for it, and a
// timeout here loses the finding entirely. Observed latency on real calls
// is 6-10s, with occasional outliers past 25s.
const TIMEOUT_MS = 45_000;

export const RUBRIC_VERSION = '2026.08.1-unvalidated';

/** The only shape accepted from the model. */
export const woundRubricSchema = z.object({
  isWoundVisible: z.boolean(),
  imageQuality: z.enum(['good', 'acceptable', 'poor']),
  approximateSizeCm: z.number().min(0).max(100).nullable().default(null),
  depth: z.enum(['superficial', 'partial_thickness', 'full_thickness', 'unclear']),
  tissueAppearance: z
    .array(z.enum(['clean', 'granulating', 'sloughy', 'necrotic', 'unclear']))
    .max(5)
    .default([]),
  infectionSigns: z
    .array(z.enum(['erythema', 'swelling', 'purulent_discharge', 'spreading_redness', 'none_seen']))
    .max(5)
    .default([]),
  activeBleeding: z.enum(['none', 'minor', 'heavy', 'unclear']).default('unclear'),
  foreignBodyVisible: z.boolean().default(false),
  observations: z.string().max(600).nullable().default(null),
});

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isWoundVisible: { type: 'BOOLEAN' },
    imageQuality: { type: 'STRING', enum: ['good', 'acceptable', 'poor'] },
    approximateSizeCm: { type: 'NUMBER', nullable: true },
    depth: { type: 'STRING', enum: ['superficial', 'partial_thickness', 'full_thickness', 'unclear'] },
    tissueAppearance: {
      type: 'ARRAY',
      items: { type: 'STRING', enum: ['clean', 'granulating', 'sloughy', 'necrotic', 'unclear'] },
    },
    infectionSigns: {
      type: 'ARRAY',
      items: {
        type: 'STRING',
        enum: ['erythema', 'swelling', 'purulent_discharge', 'spreading_redness', 'none_seen'],
      },
    },
    activeBleeding: { type: 'STRING', enum: ['none', 'minor', 'heavy', 'unclear'] },
    foreignBodyVisible: { type: 'BOOLEAN' },
    observations: { type: 'STRING', nullable: true },
  },
  required: ['isWoundVisible', 'imageQuality', 'depth', 'infectionSigns', 'activeBleeding'],
};

const PROMPT = `You are assisting a trained rural health worker by scoring a photograph of a wound. You are not diagnosing and not prescribing.

Score ONLY what is visibly present. Rules, in order of importance:

1. If the image is blurred, badly lit, or the wound is not clearly visible, set imageQuality to "poor" and prefer "unclear" over a guess. An honest "unclear" is far more useful than a confident wrong answer.
2. Do NOT infer anything you cannot see. No diagnosis, no cause, no treatment, no medication.
3. Report infection signs only where visible. If you cannot tell, use "none_seen" — which means "not observed", NOT "absent".
4. approximateSizeCm is a rough estimate only, and null if there is no reference for scale.
5. observations is one short factual sentence about what is visible. No advice.

Return the JSON object only.`;

export class WoundAnalysisError extends Error {
  constructor(message, code, issues) {
    super(message);
    this.name = 'WoundAnalysisError';
    this.code = code;
    // Which FIELD failed, not just that something did. A validation error
    // that cannot say what went wrong is close to useless when the other
    // side is a model whose output varies between calls.
    this.issues = issues;
  }
}

export const isVisionConfigured = () =>
  Boolean(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);

/**
 * Reads the key.
 *
 * Accepts both the mixed-case name the project actually uses and the
 * conventional SCREAMING_SNAKE form, so a later rename to the conventional
 * spelling does not silently disable wound analysis.
 */
function apiKey() {
  return process.env.Gemini_API_Key || process.env.GEMINI_API_KEY || null;
}

/**
 * Analyses one wound image.
 *
 * @param {Buffer} image
 * @param {string} mime
 * @param {{fetchImpl?: Function, model?: string, apiKey?: string}} [opts]
 *        fetchImpl and apiKey are injected by tests, so no test touches the
 *        network or depends on ambient environment.
 */
export async function analyseWound(image, mime = 'image/jpeg', opts = {}) {
  // An empty buffer is a caller error regardless of configuration, so it
  // is checked first.
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new TypeError('image must be a non-empty Buffer');
  }

  // Injectable so tests never depend on ambient process.env — under Jest
  // ESM a value set from a test file does not reliably reach the module.
  const key = opts.apiKey || apiKey();
  if (!key) throw new WoundAnalysisError('Gemini key is not configured', 'NOT_CONFIGURED');

  const model = opts.model || process.env.GEMINI_VISION_MODEL || DEFAULT_MODEL;
  const doFetch = opts.fetchImpl || fetch;
  const startedAt = Date.now();

  let response;
  try {
    response = await doFetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime, data: image.toString('base64') } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new WoundAnalysisError(`Vision request failed: ${err.message}`, 'REQUEST_FAILED');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new WoundAnalysisError(
      `Vision API returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      'HTTP_ERROR',
    );
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new WoundAnalysisError('Vision response had no content', 'EMPTY');

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WoundAnalysisError('Vision response was not valid JSON', 'BAD_JSON');
  }

  const parsed = woundRubricSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    logger.warn({ issues }, 'Wound rubric failed schema validation');
    throw new WoundAnalysisError(
      `Vision output failed schema validation: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`,
      'INVALID_SHAPE',
      issues,
    );
  }

  const rubric = parsed.data;
  const latencyMs = Date.now() - startedAt;

  logger.info(
    {
      model,
      latencyMs,
      woundVisible: rubric.isWoundVisible,
      imageQuality: rubric.imageQuality,
      // The observation text may describe a body part, so it is not logged.
      infectionSignCount: rubric.infectionSigns.filter((s) => s !== 'none_seen').length,
    },
    'Wound image analysed',
  );

  return {
    ...rubric,
    model,
    latencyMs,
    rubricVersion: RUBRIC_VERSION,
    limitations: buildLimitations(rubric),
  };
}

/** Caveats that must travel with every result. */
function buildLimitations(rubric) {
  const limits = [];

  if (rubric.imageQuality === 'poor') {
    limits.push('Image quality is poor. Re-photograph in better light before relying on this.');
  }

  // Always stated when redness is the deciding signal, whichever way it went.
  if (rubric.infectionSigns.includes('none_seen') || rubric.infectionSigns.includes('erythema')) {
    limits.push(
      'Redness is harder to see on brown and black skin, and most training data ' +
        'under-represents both. "No redness seen" does not mean no infection — ' +
        'judge by warmth, swelling, pain and the patient\'s own account.',
    );
  }

  limits.push('An image assessment can raise the risk tier. It never lowers one.');
  return limits;
}

/**
 * Converts the rubric into text the deterministic triage rules match on.
 *
 * Deliberately routed through the SAME rule layer as vitals and labs
 * rather than escalating on its own — one place decides tiers, and a
 * second would drift out of step with it.
 */
export function toTriageText(analysis) {
  if (!analysis?.isWoundVisible) return '';

  const parts = [];
  const signs = analysis.infectionSigns.filter((s) => s !== 'none_seen');

  if (signs.includes('spreading_redness')) parts.push('wound with spreading redness');
  if (signs.includes('purulent_discharge')) parts.push('wound with purulent discharge');
  if (signs.length && !signs.includes('spreading_redness') && !signs.includes('purulent_discharge')) {
    parts.push('wound with local signs of infection');
  }
  if (analysis.tissueAppearance?.includes('necrotic')) parts.push('wound with necrotic tissue');
  if (analysis.depth === 'full_thickness') parts.push('full thickness wound');
  if (analysis.activeBleeding === 'heavy') parts.push('wound with heavy active bleeding');
  if (analysis.foreignBodyVisible) parts.push('wound with visible foreign body');
  if (Number.isFinite(analysis.approximateSizeCm) && analysis.approximateSizeCm >= 10) {
    parts.push('large wound over 10 cm');
  }

  return parts.join('. ');
}

export default { analyseWound, toTriageText, isVisionConfigured, RUBRIC_VERSION };
