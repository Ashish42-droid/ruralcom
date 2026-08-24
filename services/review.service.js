/**
 * The doctor review queue and the flag-back loop.
 *
 * LOW-tier assessments queue for daily doctor review. The doctor either
 * APPROVES the AI output, or FLAGS IT BACK to the Clinical Assistant with a
 * mandatory clinical note.
 *
 * The flag-back is the point of the whole loop. Without it a doctor's
 * disagreement is recorded and forgotten; with it, the correction reaches
 * the person actually treating the patient, and they must acknowledge it
 * before the case can close.
 */
import { supabaseAsUser, supabaseAdmin } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import { notifyAsync } from './notification.service.js';
import ApiError from '../utils/ApiError.js';

function toApi(row) {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    visitId: row.visit_id,
    doctorId: row.doctor_id,
    action: row.action,
    clinicalNote: row.clinical_note,
    correctedInstruction: row.corrected_instruction,
    assistantAcknowledgedAt: row.assistant_acknowledged_at,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * The doctor's daily queue: LOW-tier assessments in their district with no
 * review yet.
 */
export async function listPendingReviews({ accessToken, actorId, limit = 50 }) {
  const client = supabaseAsUser(accessToken);

  // RLS already scopes assessments to the doctor's district, so this needs
  // no explicit district filter — the policy is the filter.
  const { data, error } = await client
    .from('ai_assessments')
    .select(`
      id, visit_id, patient_id, final_tier, differential, reasoning,
      created_at,
      doctor_reviews(id),
      patients(rhid, full_name, age_years, sex, village)
    `)
    .eq('final_tier', 'low')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw ApiError.badRequest(error.message);

  return (data ?? [])
    .filter((a) => (a.doctor_reviews ?? []).length === 0)
    .map((a) => ({
      assessmentId: a.id,
      visitId: a.visit_id,
      patientId: a.patient_id,
      finalTier: a.final_tier,
      differential: a.differential,
      reasoning: a.reasoning,
      createdAt: a.created_at,
      patient: a.patients
        ? {
            rhid: a.patients.rhid,
            fullName: a.patients.full_name,
            ageYears: a.patients.age_years,
            sex: a.patients.sex,
            village: a.patients.village,
          }
        : null,
      waitingForDoctor: actorId ? true : undefined,
    }));
}

/**
 * Records a doctor's decision on an assessment.
 *
 * Written through the caller's own JWT — the RLS insert policy requires
 * `doctor_id = auth.uid()` and a doctor role, so a review cannot be
 * attributed to someone else even by a malicious client.
 */
export async function submitReview({ actor, accessToken, assessmentId, payload, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: assessment, error: assessmentError } = await client
    .from('ai_assessments')
    .select('id, visit_id, final_tier')
    .eq('id', assessmentId)
    .maybeSingle();

  if (assessmentError) throw ApiError.badRequest(assessmentError.message);
  if (!assessment) throw ApiError.notFound('Assessment not found');

  const { data, error } = await client
    .from('doctor_reviews')
    .insert({
      assessment_id: assessmentId,
      visit_id: assessment.visit_id,
      doctor_id: actor.id,
      action: payload.action,
      clinical_note: payload.clinicalNote ?? null,
      corrected_instruction: payload.correctedInstruction ?? null,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw ApiError.conflict('This assessment has already been reviewed');
    }
    if (error.message?.includes('flag_requires_note')) {
      throw ApiError.badRequest(
        'A clinical note is required when flagging a case back to the assistant',
      );
    }
    throw ApiError.badRequest(error.message);
  }

  // Advance the visit. Service role because visit status is not
  // client-writable beyond the narrow grant in migration 0008.
  const nextStatus =
    payload.action === 'flag_to_assistant'
      ? 'awaiting_assistant_action'
      : payload.action === 'refer'
        ? 'referred'
        : 'closed';

  await supabaseAdmin
    .from('visits')
    .update({
      status: nextStatus,
      ...(nextStatus === 'closed' ? { closed_at: new Date().toISOString() } : {}),
    })
    .eq('id', assessment.visit_id);

  // Notify the assistant who opened the visit. A flag-back that nobody
  // sees is the same as no flag at all.
  const { data: visitRow } = await supabaseAdmin
    .from('visits')
    .select('assistant_id')
    .eq('id', assessment.visit_id)
    .maybeSingle();

  if (visitRow?.assistant_id) {
    notifyAsync({
      recipientId: visitRow.assistant_id,
      type: payload.action === 'flag_to_assistant' ? 'review_flagged_to_assistant' : 'review_approved',
      // The note itself is clinical content and stays out of the payload;
      // the client fetches the review through the RLS-protected endpoint.
      payload: { reviewId: data.id, action: payload.action },
      visitId: assessment.visit_id,
    });
  }

  await recordAudit({
    action: payload.action === 'flag_to_assistant' ? 'review_flagged_to_assistant' : 'doctor_review',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'doctor_review',
    entityId: data.id,
    metadata: {
      assessmentId,
      visitId: assessment.visit_id,
      reviewAction: payload.action,
      // The note is clinical content and stays out of the audit trail;
      // that it exists is what matters here.
      hasNote: Boolean(payload.clinicalNote),
    },
    // A flag-back means the AI got something wrong on a real patient. It is
    // the single best quality signal the system produces.
    severity: payload.action === 'flag_to_assistant' ? 'warning' : 'info',
    req,
  });

  return toApi(data);
}

/**
 * The assistant's "doctor feedback" panel: flagged cases awaiting
 * acknowledgement. RLS scopes this to their own facility.
 */
export async function listFlaggedForAssistant({ accessToken }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('doctor_reviews')
    .select(`
      id, assessment_id, visit_id, action, clinical_note,
      corrected_instruction, reviewed_at, assistant_acknowledged_at,
      visits(patient_id, patients(rhid, full_name, age_years))
    `)
    .eq('action', 'flag_to_assistant')
    .is('assistant_acknowledged_at', null)
    .order('reviewed_at', { ascending: true });

  if (error) throw ApiError.badRequest(error.message);

  return (data ?? []).map((r) => ({
    id: r.id,
    assessmentId: r.assessment_id,
    visitId: r.visit_id,
    clinicalNote: r.clinical_note,
    correctedInstruction: r.corrected_instruction,
    reviewedAt: r.reviewed_at,
    patient: r.visits?.patients
      ? {
          rhid: r.visits.patients.rhid,
          fullName: r.visits.patients.full_name,
          ageYears: r.visits.patients.age_years,
        }
      : null,
  }));
}

/**
 * Assistant acknowledges a flagged case.
 *
 * Required before the case can close — a doctor's correction must not be
 * scrollable past.
 */
export async function acknowledgeReview({ actor, accessToken, reviewId, req }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('doctor_reviews')
    .update({
      assistant_acknowledged_at: new Date().toISOString(),
      assistant_acknowledged_by: actor.id,
    })
    .eq('id', reviewId)
    .is('assistant_acknowledged_at', null)
    .select('*')
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) {
    throw ApiError.notFound('Review not found, or it was already acknowledged');
  }

  await recordAudit({
    action: 'review_acknowledged',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'doctor_review',
    entityId: reviewId,
    metadata: { visitId: data.visit_id },
    req,
  });

  return toApi(data);
}

export default {
  listPendingReviews,
  submitReview,
  listFlaggedForAssistant,
  acknowledgeReview,
};
