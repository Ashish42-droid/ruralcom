/**
 * Vitals capture.
 *
 * Vitals feed the deterministic triage rule layer directly (NEWS2
 * thresholds, PALS age-banded respiratory rates), so what is recorded here
 * decides tiers. Two properties matter more than anything else:
 *
 *  1. A partially-filled set is NORMAL, not an error. A health centre may
 *     have a thermometer but no oximeter. The triage layer treats absent
 *     values as missing data — which escalates the tier — rather than as
 *     normal values.
 *  2. Manual and device readings are distinguishable (`capture_method`).
 *     A typed SpO2 and one off a certified oximeter deserve different
 *     confidence downstream.
 */
import { supabaseAsUser } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import ApiError from '../utils/ApiError.js';

function toApi(row) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    temperatureC: row.temperature_c === null ? null : Number(row.temperature_c),
    spo2: row.spo2,
    systolic: row.systolic,
    diastolic: row.diastolic,
    pulseBpm: row.pulse_bpm,
    respiratoryRate: row.respiratory_rate,
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
    heightCm: row.height_cm === null ? null : Number(row.height_cm),
    captureMethod: row.capture_method,
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

/**
 * Shapes a vitals row into the flat object the triage engine expects.
 * Exported because the assessment service needs exactly this mapping.
 */
export function toEngineVitals(row) {
  if (!row) return {};
  const v = toApi(row);
  const out = {};
  // Only include values that are actually present. An explicit null would
  // still be "not a finite number" to the rules, but omitting keeps the
  // engine input honest about what was measured.
  if (v.temperatureC !== null) out.temperatureC = v.temperatureC;
  if (v.spo2 !== null) out.spo2 = v.spo2;
  if (v.systolic !== null) out.systolic = v.systolic;
  if (v.diastolic !== null) out.diastolic = v.diastolic;
  if (v.pulseBpm !== null) out.pulseBpm = v.pulseBpm;
  if (v.respiratoryRate !== null) out.respiratoryRate = v.respiratoryRate;
  if (v.weightKg !== null) out.weightKg = v.weightKg;
  return out;
}

async function assertVisitWritable(client, visitId) {
  const { data, error } = await client
    .from('visits')
    .select('id, patient_id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Visit not found');
  if (data.status === 'closed') throw ApiError.conflict('This visit is closed');
  return data;
}

export async function recordVitals({ actor, accessToken, visitId, payload, req }) {
  const client = supabaseAsUser(accessToken);
  const visit = await assertVisitWritable(client, visitId);

  const { data, error } = await client
    .from('vitals')
    .insert({
      visit_id: visitId,
      patient_id: visit.patient_id,
      temperature_c: payload.temperatureC ?? null,
      spo2: payload.spo2 ?? null,
      systolic: payload.systolic ?? null,
      diastolic: payload.diastolic ?? null,
      pulse_bpm: payload.pulseBpm ?? null,
      respiratory_rate: payload.respiratoryRate ?? null,
      weight_kg: payload.weightKg ?? null,
      height_cm: payload.heightCm ?? null,
      capture_method: payload.captureMethod ?? 'file_manager',
      device_id: payload.deviceId ?? null,
      recorded_by: actor.id,
    })
    .select('*')
    .single();

  if (error) {
    // Surface the database's own plausibility checks as readable errors
    // rather than a raw constraint name.
    if (error.message?.includes('vitals_bp_ordered')) {
      throw ApiError.badRequest(
        'Systolic must be higher than diastolic — check whether the two were entered the wrong way round',
      );
    }
    if (error.message?.includes('vitals_not_empty')) {
      throw ApiError.badRequest('Record at least one measurement');
    }
    throw ApiError.badRequest(error.message);
  }

  await recordAudit({
    action: 'vitals_recorded',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'vitals',
    entityId: data.id,
    // Which measurements were taken is safe to audit; the VALUES are
    // clinical data and stay out of the audit trail.
    metadata: {
      visitId,
      captureMethod: data.capture_method,
      measured: Object.keys(toEngineVitals(data)),
    },
    req,
  });

  return toApi(data);
}

/** Most recent vitals for a visit — what the triage engine assesses against. */
export async function latestForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('vitals')
    .select('*')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  return data ? toApi(data) : null;
}

/** Full history for a visit, oldest first — a trend, not a snapshot. */
export async function listForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('vitals')
    .select('*')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: true });

  if (error) throw ApiError.badRequest(error.message);
  return data.map(toApi);
}

export default { recordVitals, latestForVisit, listForVisit, toEngineVitals };
