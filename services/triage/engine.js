/**
 * Triage engine.
 *
 * ================== THE ONE INVARIANT THAT MATTERS ==================
 *
 *     final_tier = MAX(rule_tier, model_tier)
 *
 * The deterministic red-flag layer sets the FLOOR. A model may raise the
 * tier; it may NEVER lower it. This single constraint is what makes the
 * system defensible in a room containing doctors, and it is enforced here
 * in one place rather than trusted to every caller.
 * ====================================================================
 *
 * Fail-safe behaviour, in order of how badly they would otherwise go wrong:
 *   - Model times out, throws, or returns unparseable output -> MEDIUM.
 *     A degraded AI must never mean "send them home".
 *   - Model returns a tier below the rule floor -> floor wins, and the
 *     disagreement is recorded as a safety event.
 *   - No model configured at all -> rules alone, minimum MEDIUM, because
 *     rules cannot see anything the vitals and red-flag phrases miss.
 */
import { evaluateRules, maxTier, tierRank, TIER, RULESET_VERSION } from './rules.js';
import logger from '../../config/logger.js';

export { TIER };

/** Tier the engine falls back to whenever it cannot trust the model. */
const FAILSAFE_TIER = TIER.MEDIUM;

/** How long a model may take before we stop waiting and fail safe. */
const MODEL_TIMEOUT_MS = 20_000;

function isValidTier(value) {
  return value === TIER.LOW || value === TIER.MEDIUM || value === TIER.HIGH;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('model timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs an assessment.
 *
 * @param {object} params
 * @param {object} params.input      { vitals, patient, symptomText }
 * @param {object} [params.model]    optional model with
 *                                   `assess(input) -> { tier, differential, reasoning }`
 * @param {string} [params.requestId]
 * @returns {Promise<object>} assessment record, ready to persist
 */
export async function runAssessment({ input, model, requestId } = {}) {
  const startedAt = Date.now();

  // 1. Deterministic floor. This never fails and never calls out.
  const rules = evaluateRules(input);

  let modelTier = null;
  let modelOutput = null;
  let modelError = null;

  // 2. Model layer, if one is wired.
  if (model) {
    try {
      const raw = await withTimeout(model.assess(input), MODEL_TIMEOUT_MS);

      if (!raw || !isValidTier(raw.tier)) {
        // Unparseable output is treated exactly like a failure. A partially
        // understood clinical assessment is not better than none.
        modelError = 'invalid_model_output';
        logger.warn(
          { requestId, received: raw?.tier ?? null },
          'Model returned an invalid tier — failing safe',
        );
      } else {
        modelTier = raw.tier;
        modelOutput = {
          differential: raw.differential ?? [],
          reasoning: raw.reasoning ?? null,
          confidence: raw.confidence ?? null,
          modelVersion: raw.modelVersion ?? null,
          promptVersion: raw.promptVersion ?? null,
        };
      }
    } catch (err) {
      modelError = err.message === 'model timeout' ? 'timeout' : 'model_error';
      logger.warn(
        { requestId, error: err.name, reason: err.message },
        'Model assessment failed — failing safe to MEDIUM',
      );
    }
  }

  // 3. Compose. The floor always wins ties and always wins downward.
  let finalTier;
  let escalationReason;

  if (modelTier === null) {
    // No usable model output: rules alone are not enough to justify LOW,
    // because they only see vitals and a red-flag phrase list.
    finalTier = maxTier(rules.tier, FAILSAFE_TIER);
    escalationReason = model
      ? `model_unavailable:${modelError}`
      : 'no_model_configured';
  } else {
    finalTier = maxTier(rules.tier, modelTier);
    escalationReason =
      finalTier === rules.tier && rules.tier !== modelTier
        ? 'rule_floor_overrode_model'
        : 'model_and_rules_agree';
  }

  // A model trying to de-escalate below the floor is a safety event worth
  // seeing in aggregate — it is the signal that the model is miscalibrated
  // in the one direction that harms patients.
  const modelAttemptedDeEscalation =
    modelTier !== null && tierRank(modelTier) < tierRank(rules.tier);

  if (modelAttemptedDeEscalation) {
    logger.warn(
      { requestId, ruleTier: rules.tier, modelTier, finalTier },
      'SAFETY: model tier was below the rule floor — floor applied',
    );
  }

  return {
    finalTier,
    ruleTier: rules.tier,
    modelTier,
    escalationReason,
    modelAttemptedDeEscalation,
    modelError,
    ruleHits: rules.hits,
    rulesetVersion: rules.version,
    differential: modelOutput?.differential ?? [],
    reasoning: modelOutput?.reasoning ?? null,
    modelVersion: modelOutput?.modelVersion ?? null,
    promptVersion: modelOutput?.promptVersion ?? null,
    latencyMs: Date.now() - startedAt,
  };
}

export { RULESET_VERSION, maxTier, tierRank };
export default { runAssessment, TIER, RULESET_VERSION };
