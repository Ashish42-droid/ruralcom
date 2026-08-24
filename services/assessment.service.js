/**
 * Assessment orchestration: gather -> run the triage engine -> persist.
 *
 * SERVICE-ROLE USE IS DELIBERATE AND NARROW HERE.
 *
 * Reads go through the caller's JWT so RLS decides what they may see. The
 * WRITE goes through the service role, because `ai_assessments` has no
 * INSERT policy for `authenticated` at all — by design. A client able to
 * author its own assessment could fabricate a LOW tier for a patient the
 * rules would have escalated. The server runs the engine; the client only
 * asks it to.
 *
 * Per the project's service-role rule, that write is (a) preceded by an
 * explicit authorisation check — the visit is read through the caller's own
 * JWT first, so RLS gates access — and (b) audited.
 */
import { supabaseAsUser, supabaseAdmin } from '../config/supabase.js';
import { runAssessment } from './triage/engine.js';
import { createLlmService } from './llm/index.js';
import { toEngineVitals } from './vitals.service.js';
import { recordAudit } from './audit.service.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import env from '../config/env.js';

/** Built once — provider construction is cheap but pointless to repeat. */
let llmService;
function getLlmService() {
  if (llmService === undefined) llmService = createLlmService(env);
  return llmService;
}

/**
 * Collects everything the engine needs for one visit.
 *
 * All reads use the caller's token, so a caller who cannot see the visit
 * cannot assemble input for it either.
 */
async function gatherInput({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);

  const { data: visit, error: visitError } = await client
    .from('visits')
    .select('id, patient_id, facility_id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (visitError) throw ApiError.badRequest(visitError.message);
  if (!visit) throw ApiError.notFound('Visit not found');
  if (visit.status === 'closed') throw ApiError.conflict('This visit is closed');

  const [patientRes, vitalsRes, symptomsRes, historyRes, allergiesRes] = await Promise.all([
    client
      .from('patients')
      .select('id, age_years, date_of_birth, sex, registration_complete')
      .eq('id', visit.patient_id)
      .single(),
    client
      .from('vitals')
      .select('*')
      .eq('visit_id', visitId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from('symptom_entries')
      .select('raw_text, normalized_text, language, duration_days, onset_date')
      .eq('visit_id', visitId)
      .order('created_at', { ascending: true }),
    client
      .from('patient_history')
      .select('condition, since, source')
      .eq('patient_id', visit.patient_id),
    client
      .from('allergies')
      .select('substance, severity')
      .eq('patient_id', visit.patient_id),
  ]);

  if (patientRes.error) throw ApiError.badRequest(patientRes.error.message);
  const patient = patientRes.data;

  // Age drives paediatric dosing, IMCI danger signs and the respiratory-rate
  // bands, so derive it from date_of_birth when that is the field present.
  let ageYears = patient.age_years;
  if (ageYears === null && patient.date_of_birth) {
    const ms = Date.now() - new Date(patient.date_of_birth).getTime();
    ageYears = Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
  }

  const symptoms = symptomsRes.data ?? [];
  // Prefer normalised English text where the translation layer has produced
  // it; the rule layer's red-flag phrases are matched against English.
  const symptomText = symptoms
    .map((s) => s.normalized_text || s.raw_text)
    .join('. ')
    .trim();

  return {
    visit,
    engineInput: {
      vitals: toEngineVitals(vitalsRes.data),
      patient: {
        ageYears: Number.isFinite(ageYears) ? ageYears : null,
        sex: patient.sex,
        registrationComplete: patient.registration_complete,
      },
      symptomText,
      history: (historyRes.data ?? []).map((h) =>
        h.source === 'doctor_confirmed' ? `${h.condition} (doctor-confirmed)` : h.condition,
      ),
      allergies: (allergiesRes.data ?? []).map((a) => a.substance),
    },
    counts: {
      symptomEntries: symptoms.length,
      hasVitals: Boolean(vitalsRes.data),
    },
  };
}

/**
 * Persists the engine result and its rule evidence.
 *
 * The assessment row and its rule hits are written together; if the hits
 * fail to write, the assessment is removed rather than left standing
 * without the evidence that justifies its tier. "Why did it say HIGH?" must
 * never have the answer "we don't know".
 */
async function persist({ result, visit, actor }) {
  const { data: assessment, error } = await supabaseAdmin
    .from('ai_assessments')
    .insert({
      visit_id: visit.id,
      patient_id: visit.patient_id,
      rule_tier: result.ruleTier,
      model_tier: result.modelTier,
      final_tier: result.finalTier,
      escalation_reason: result.escalationReason,
      model_attempted_de_escalation: result.modelAttemptedDeEscalation,
      model_error: result.modelError,
      differential: result.differential,
      reasoning: result.reasoning,
      red_flags_observed: result.redFlagsObserved ?? [],
      ruleset_version: result.rulesetVersion,
      model_version: result.modelVersion,
      prompt_version: result.promptVersion,
      provider: result.provider ?? null,
      latency_ms: result.latencyMs,
      created_by: actor.id,
    })
    .select('*')
    .single();

  if (error) {
    logger.error({ err: error, visitId: visit.id }, 'Failed to persist assessment');
    throw ApiError.internal('Could not save the assessment');
  }

  if (result.ruleHits?.length) {
    const { error: hitsError } = await supabaseAdmin.from('triage_rule_hits').insert(
      result.ruleHits.map(({ code, tier, source, ...detail }) => ({
        assessment_id: assessment.id,
        code,
        tier,
        source: source ?? null,
        detail,
      })),
    );

    if (hitsError) {
      await supabaseAdmin.from('ai_assessments').delete().eq('id', assessment.id);
      logger.error(
        { err: hitsError, visitId: visit.id },
        'Rule hits failed to persist — assessment rolled back',
      );
      throw ApiError.internal('Could not save the assessment evidence');
    }
  }

  return assessment;
}

/** Maps the visit to the status its tier implies. */
function visitStatusForTier(tier) {
  if (tier === 'low') return 'awaiting_doctor_review';
  if (tier === 'medium') return 'awaiting_consultation';
  return 'referred';
}

/**
 * Runs and stores an assessment for a visit.
 */
export async function assessVisit({ actor, accessToken, visitId, req }) {
  const { visit, engineInput, counts } = await gatherInput({ accessToken, visitId });

  const result = await runAssessment({
    input: engineInput,
    model: getLlmService(),
    requestId: req?.id,
  });

  const assessment = await persist({ result, visit, actor });

  // Advance the visit. Written with the service role because `final_tier`
  // is deliberately not client-updatable (migration 0008).
  const nextStatus = visitStatusForTier(result.finalTier);
  const { error: visitError } = await supabaseAdmin
    .from('visits')
    .update({ status: nextStatus, final_tier: result.finalTier })
    .eq('id', visitId);

  if (visitError) {
    // The assessment itself is saved and correct; only the status lagged.
    // Worth an alert but not worth failing the request and prompting a
    // re-run that would cost another model call.
    logger.error(
      { err: visitError, visitId, assessmentId: assessment.id },
      'Assessment saved but visit status update failed',
    );
  }

  await recordAudit({
    action: 'assessment_run',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'ai_assessment',
    entityId: assessment.id,
    metadata: {
      visitId,
      ruleTier: result.ruleTier,
      modelTier: result.modelTier,
      finalTier: result.finalTier,
      escalationReason: result.escalationReason,
      modelAttemptedDeEscalation: result.modelAttemptedDeEscalation,
      ruleHitCodes: result.ruleHits.map((h) => h.code),
      hadVitals: counts.hasVitals,
      symptomEntries: counts.symptomEntries,
    },
    // A model trying to de-escalate below the rule floor is the one signal
    // that matters most in aggregate.
    severity: result.modelAttemptedDeEscalation ? 'warning' : 'info',
    req,
  });

  return toApi(assessment, result.ruleHits);
}

function toApi(row, ruleHits = []) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    ruleTier: row.rule_tier,
    modelTier: row.model_tier,
    finalTier: row.final_tier,
    escalationReason: row.escalation_reason,
    modelAttemptedDeEscalation: row.model_attempted_de_escalation,
    modelError: row.model_error,
    differential: row.differential,
    reasoning: row.reasoning,
    redFlagsObserved: row.red_flags_observed,
    rulesetVersion: row.ruleset_version,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    provider: row.provider,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    ruleHits: ruleHits.map((h) => ({
      code: h.code,
      tier: h.tier,
      source: h.source,
      ...h,
    })),
  };
}

/** Assessment history for a visit, newest first. */
export async function listForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('ai_assessments')
    .select('*, triage_rule_hits(code, tier, source, detail)')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false });

  if (error) throw ApiError.badRequest(error.message);

  return (data ?? []).map((row) => ({
    ...toApi(row),
    ruleHits: (row.triage_rule_hits ?? []).map((h) => ({
      code: h.code,
      tier: h.tier,
      source: h.source,
      ...h.detail,
    })),
  }));
}

/** One assessment with its full evidence. */
export async function getById({ accessToken, assessmentId }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('ai_assessments')
    .select('*, triage_rule_hits(code, tier, source, detail), ai_recommendations(type, display_order, content, rule_source_id)')
    .eq('id', assessmentId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Assessment not found');

  return {
    ...toApi(data),
    ruleHits: (data.triage_rule_hits ?? []).map((h) => ({
      code: h.code,
      tier: h.tier,
      source: h.source,
      ...h.detail,
    })),
    recommendations: data.ai_recommendations ?? [],
  };
}

export default { assessVisit, listForVisit, getById };
