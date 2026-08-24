/**
 * Consultation scheduling and the 5-minute tolerance window.
 *
 * Doctor selection is load-balanced: among doctors who are available, in
 * the right district, and match the disease category where one is known,
 * pick the one with the FEWEST calls in progress. Ties break randomly so a
 * cold start does not always hit the same doctor.
 *
 * Scheduling is server-owned (service role) because it involves assignment
 * and a timer a client must not be able to forge — `consultations` has no
 * INSERT policy for `authenticated` at all.
 */
import { supabaseAdmin, supabaseAsUser } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import { scheduleToleranceExpiry, cancelToleranceExpiry } from '../jobs/consultationQueue.js';
import { roomNameForVisit } from './video/livekit.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** The spec's tolerance window. */
export const TOLERANCE_MINUTES = 5;

/** Give up after this many hand-offs rather than looping forever. */
const MAX_REASSIGNMENTS = 3;

const IN_PROGRESS = ['ringing', 'active'];

function toApi(row) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    assessmentId: row.assessment_id,
    doctorId: row.doctor_id,
    assistantId: row.assistant_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    toleranceExpiresAt: row.tolerance_expires_at,
    joinedAt: row.joined_at,
    endedAt: row.ended_at,
    reassignCount: row.reassign_count,
    provider: row.provider,
    providerRoom: row.provider_room,
    createdAt: row.created_at,
  };
}

/**
 * Picks the least-loaded eligible doctor.
 *
 * @param {object} params
 * @param {string} params.districtId
 * @param {string[]} [params.categories] disease categories from the assessment
 * @param {string[]} [params.excludeDoctorIds] doctors who already missed this call
 */
export async function selectDoctor({ districtId, categories = [], excludeDoctorIds = [] }) {
  let query = supabaseAdmin
    .from('doctors')
    .select('profile_id, specialities, max_concurrent_cases')
    .eq('district_id', districtId)
    .eq('availability_status', 'available');

  if (excludeDoctorIds.length) {
    query = query.not('profile_id', 'in', `(${excludeDoctorIds.join(',')})`);
  }

  const { data: candidates, error } = await query;
  if (error) throw ApiError.badRequest(error.message);
  if (!candidates?.length) return null;

  // Prefer a category match, but never let specialisation starve a patient:
  // if nobody matches, fall back to the whole available pool. A doctor with
  // no declared specialities is general and eligible for anything.
  let pool = candidates;
  if (categories.length) {
    const matching = candidates.filter(
      (d) =>
        d.specialities.length === 0 ||
        d.specialities.some((s) => categories.includes(s)),
    );
    if (matching.length) pool = matching;
  }

  const doctorIds = pool.map((d) => d.profile_id);
  const { data: active } = await supabaseAdmin
    .from('consultations')
    .select('doctor_id')
    .in('doctor_id', doctorIds)
    .in('status', IN_PROGRESS);

  const load = new Map(doctorIds.map((id) => [id, 0]));
  for (const row of active ?? []) {
    load.set(row.doctor_id, (load.get(row.doctor_id) ?? 0) + 1);
  }

  const free = pool.filter((d) => load.get(d.profile_id) < d.max_concurrent_cases);
  if (!free.length) return null;

  const minLoad = Math.min(...free.map((d) => load.get(d.profile_id)));
  const leastLoaded = free.filter((d) => load.get(d.profile_id) === minLoad);

  // Random tie-break: with an all-idle pool, always picking the first would
  // funnel every case to the same doctor.
  return leastLoaded[Math.floor(Math.random() * leastLoaded.length)].profile_id;
}

/** Disease categories implied by an assessment's differential. */
function categoriesFrom(assessment) {
  if (!Array.isArray(assessment?.differential)) return [];
  return assessment.differential
    .map((d) => d.category)
    .filter((c) => typeof c === 'string' && c.length > 0);
}

/**
 * Schedules a consultation for a visit and starts its tolerance timer.
 */
export async function scheduleConsultation({ actor, accessToken, visitId, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: visit, error: visitError } = await client
    .from('visits')
    .select('id, patient_id, facility_id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (visitError) throw ApiError.badRequest(visitError.message);
  if (!visit) throw ApiError.notFound('Visit not found');
  if (visit.status === 'closed') throw ApiError.conflict('This visit is closed');

  const { data: existing } = await client
    .from('consultations')
    .select('id, status')
    .eq('visit_id', visitId)
    .in('status', ['scheduled', ...IN_PROGRESS])
    .maybeSingle();

  if (existing) {
    throw ApiError.conflict('This visit already has a consultation in progress');
  }

  const { data: facility } = await supabaseAdmin
    .from('facilities')
    .select('district_id')
    .eq('id', visit.facility_id)
    .single();

  const { data: assessment } = await supabaseAdmin
    .from('ai_assessments')
    .select('id, differential')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const doctorId = await selectDoctor({
    districtId: facility.district_id,
    categories: categoriesFrom(assessment),
  });

  if (!doctorId) {
    // Deliberately a 503, not a 404: the request was valid and should be
    // retried. The caller needs to know to escalate by another route.
    throw ApiError.serviceUnavailable(
      'No doctor is currently available in this district',
      { code: 'NO_DOCTOR_AVAILABLE' },
    );
  }

  return createAndArm({
    visit,
    assessmentId: assessment?.id ?? null,
    doctorId,
    actor,
    req,
  });
}

/** Writes the row, arms the timer, and audits. Shared by schedule and reassign. */
async function createAndArm({ visit, assessmentId, doctorId, actor, req, reassignedFrom = null, reassignCount = 0 }) {
  const scheduledAt = new Date();
  const toleranceExpiresAt = new Date(scheduledAt.getTime() + TOLERANCE_MINUTES * 60_000);

  const { data, error } = await supabaseAdmin
    .from('consultations')
    .insert({
      visit_id: visit.id,
      patient_id: visit.patient_id,
      assessment_id: assessmentId,
      doctor_id: doctorId,
      assistant_id: actor?.id ?? null,
      status: 'ringing',
      scheduled_at: scheduledAt.toISOString(),
      tolerance_expires_at: toleranceExpiresAt.toISOString(),
      provider: 'livekit',
      provider_room: roomNameForVisit(visit.id),
      reassigned_from: reassignedFrom,
      reassign_count: reassignCount,
    })
    .select('*')
    .single();

  if (error) {
    // The partial unique index fired: this doctor picked up another call
    // between selection and insert. A real race, not a bug.
    if (error.code === '23505') {
      throw ApiError.conflict(
        'That doctor just started another call — please try again',
        { code: 'DOCTOR_BECAME_BUSY' },
      );
    }
    throw ApiError.badRequest(error.message);
  }

  await scheduleToleranceExpiry({
    consultationId: data.id,
    delayMs: TOLERANCE_MINUTES * 60_000,
  });

  await recordAudit({
    action: 'consultation_scheduled',
    actorId: actor?.id,
    actorRole: actor?.role,
    entityType: 'consultation',
    entityId: data.id,
    metadata: {
      visitId: visit.id,
      doctorId,
      toleranceMinutes: TOLERANCE_MINUTES,
      reassignCount,
    },
    req,
  });

  return toApi(data);
}

/** Doctor joins — stops the tolerance timer. */
export async function joinConsultation({ actor, consultationId, req }) {
  const { data: consultation, error } = await supabaseAdmin
    .from('consultations')
    .select('*')
    .eq('id', consultationId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!consultation) throw ApiError.notFound('Consultation not found');

  if (consultation.doctor_id !== actor.id) {
    throw ApiError.forbidden('This consultation is assigned to another doctor');
  }

  if (['missed', 'reassigned', 'cancelled', 'completed'].includes(consultation.status)) {
    throw ApiError.conflict(`This consultation is already ${consultation.status}`);
  }

  const { data, error: updateError } = await supabaseAdmin
    .from('consultations')
    .update({ status: 'active', joined_at: new Date().toISOString() })
    .eq('id', consultationId)
    .select('*')
    .single();

  if (updateError) throw ApiError.badRequest(updateError.message);

  await cancelToleranceExpiry(consultationId);

  await recordAudit({
    action: 'consultation_joined',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'consultation',
    entityId: consultationId,
    metadata: { visitId: consultation.visit_id },
    req,
  });

  return toApi(data);
}

export async function completeConsultation({ actor, consultationId, req }) {
  const { data, error } = await supabaseAdmin
    .from('consultations')
    .update({ status: 'completed', ended_at: new Date().toISOString() })
    .eq('id', consultationId)
    .eq('doctor_id', actor.id)
    .select('*')
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Consultation not found or not yours');

  await cancelToleranceExpiry(consultationId);
  await recordAudit({
    action: 'consultation_joined',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'consultation',
    entityId: consultationId,
    metadata: { visitId: data.visit_id, completed: true },
    req,
  });

  return toApi(data);
}

/**
 * Called by the job runner when a tolerance window expires.
 *
 * Marks the call missed and hands it to the next-least-loaded doctor. This
 * is the whole point of the window: a doctor who does not pick up must not
 * silently strand a waiting patient.
 */
export async function handleToleranceExpiry(consultationId) {
  const { data: consultation } = await supabaseAdmin
    .from('consultations')
    .select('*')
    .eq('id', consultationId)
    .maybeSingle();

  if (!consultation) {
    logger.warn({ consultationId }, 'Tolerance expiry for an unknown consultation');
    return { outcome: 'not_found' };
  }

  // The doctor joined in time — the timer simply lost the race.
  if (['active', 'completed'].includes(consultation.status)) {
    return { outcome: 'already_joined' };
  }

  if (!['scheduled', 'ringing'].includes(consultation.status)) {
    return { outcome: `no_action_${consultation.status}` };
  }

  await supabaseAdmin
    .from('consultations')
    .update({ status: 'missed' })
    .eq('id', consultationId);

  await recordAudit({
    action: 'consultation_missed',
    actorId: null,
    entityType: 'consultation',
    entityId: consultationId,
    metadata: {
      visitId: consultation.visit_id,
      doctorId: consultation.doctor_id,
      reassignCount: consultation.reassign_count,
    },
    severity: 'warning',
  });

  if (consultation.reassign_count >= MAX_REASSIGNMENTS) {
    logger.error(
      { consultationId, visitId: consultation.visit_id },
      'Consultation exhausted reassignment attempts — needs manual escalation',
    );
    return { outcome: 'exhausted' };
  }

  const { data: visit } = await supabaseAdmin
    .from('visits')
    .select('id, patient_id, facility_id')
    .eq('id', consultation.visit_id)
    .single();

  const { data: facility } = await supabaseAdmin
    .from('facilities')
    .select('district_id')
    .eq('id', visit.facility_id)
    .single();

  // Exclude every doctor who has already missed this chain.
  const { data: chain } = await supabaseAdmin
    .from('consultations')
    .select('doctor_id')
    .eq('visit_id', consultation.visit_id)
    .eq('status', 'missed');

  const exclude = [...new Set((chain ?? []).map((c) => c.doctor_id))];

  const nextDoctorId = await selectDoctor({
    districtId: facility.district_id,
    excludeDoctorIds: exclude,
  });

  if (!nextDoctorId) {
    logger.error(
      { consultationId, visitId: consultation.visit_id },
      'No doctor available to take over a missed consultation',
    );
    return { outcome: 'no_doctor_available' };
  }

  const replacement = await createAndArm({
    visit,
    assessmentId: consultation.assessment_id,
    doctorId: nextDoctorId,
    actor: null,
    reassignedFrom: consultationId,
    reassignCount: consultation.reassign_count + 1,
  });

  await supabaseAdmin
    .from('consultations')
    .update({ status: 'reassigned' })
    .eq('id', consultationId);

  await recordAudit({
    action: 'consultation_reassigned',
    entityType: 'consultation',
    entityId: replacement.id,
    metadata: {
      from: consultationId,
      previousDoctorId: consultation.doctor_id,
      newDoctorId: nextDoctorId,
      attempt: consultation.reassign_count + 1,
    },
    severity: 'warning',
  });

  return { outcome: 'reassigned', consultationId: replacement.id, doctorId: nextDoctorId };
}

/** A doctor's queue: their in-progress and upcoming calls. */
export async function listForDoctor({ accessToken, actorId }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('consultations')
    .select('*')
    .eq('doctor_id', actorId)
    .in('status', ['scheduled', 'ringing', 'active'])
    .order('scheduled_at', { ascending: true });

  if (error) throw ApiError.badRequest(error.message);
  return data.map(toApi);
}

export async function listForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('consultations')
    .select('*')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false });

  if (error) throw ApiError.badRequest(error.message);
  return data.map(toApi);
}

export default {
  scheduleConsultation,
  joinConsultation,
  completeConsultation,
  handleToleranceExpiry,
  selectDoctor,
  listForDoctor,
  listForVisit,
  TOLERANCE_MINUTES,
};
