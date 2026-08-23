/**
 * Patient registration, lookup and visit management.
 *
 * All reads go through the caller's own JWT so row-level security scopes
 * them. Writes that need generated state (the RHID) or an audit guarantee go
 * through the service role, each with an explicit authorisation check.
 */
import { supabaseAsUser, supabaseAdmin } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import { generateRhid, normaliseRhid, isValidRhid } from '../utils/rhid.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

const RHID_MAX_ATTEMPTS = 5;

/** Fields safe to return. Keeps the RHID out of list responses by default. */
const PATIENT_COLUMNS =
  'id, rhid, abha_id, full_name, date_of_birth, age_years, sex, ' +
  'preferred_language, village, phone, facility_id, emergency_registration, ' +
  'registration_complete, created_at, updated_at';

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    rhid: row.rhid,
    abhaId: row.abha_id ?? null,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth ?? null,
    ageYears: row.age_years ?? null,
    sex: row.sex,
    preferredLanguage: row.preferred_language,
    village: row.village ?? null,
    phone: row.phone ?? null,
    facilityId: row.facility_id,
    emergencyRegistration: row.emergency_registration,
    registrationComplete: row.registration_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The facility a clinical assistant belongs to. */
async function facilityOf(profileId) {
  const { data } = await supabaseAdmin
    .from('clinical_assistants')
    .select('facility_id')
    .eq('profile_id', profileId)
    .single();

  if (!data) {
    throw ApiError.forbidden('Only a clinical assistant may register patients');
  }
  return data.facility_id;
}

/**
 * Allocates an unused RHID.
 *
 * Collisions in a 10^11 space are vanishingly unlikely, but "vanishingly
 * unlikely" is not "impossible" and a collision would silently merge two
 * patients' records. Retry, then fail loudly rather than reuse.
 */
async function allocateRhid() {
  for (let attempt = 0; attempt < RHID_MAX_ATTEMPTS; attempt += 1) {
    const candidate = generateRhid();
    const { data } = await supabaseAdmin
      .from('patients')
      .select('id')
      .eq('rhid', candidate)
      .maybeSingle();

    if (!data) return candidate;
    logger.warn({ attempt }, 'RHID collision — retrying');
  }
  throw ApiError.internal('Could not allocate a unique health ID');
}

/** Full registration. */
export async function registerPatient({ actor, payload, req }) {
  const facilityId = await facilityOf(actor.id);
  const rhid = await allocateRhid();

  const { data: patient, error } = await supabaseAdmin
    .from('patients')
    .insert({
      rhid,
      abha_id: payload.abhaId ?? null,
      full_name: payload.fullName,
      date_of_birth: payload.dateOfBirth
        ? new Date(payload.dateOfBirth).toISOString().slice(0, 10)
        : null,
      age_years: payload.ageYears ?? null,
      sex: payload.sex,
      preferred_language: payload.preferredLanguage,
      village: payload.village ?? null,
      phone: payload.phone ?? null,
      facility_id: facilityId,
      emergency_registration: false,
      registration_complete: true,
      created_by: actor.id,
    })
    .select(PATIENT_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw ApiError.conflict('A patient with that ABHA id already exists');
    }
    throw ApiError.badRequest(error.message);
  }

  if (payload.history?.length) {
    await supabaseAdmin.from('patient_history').insert(
      payload.history.map((h) => ({
        patient_id: patient.id,
        condition: h.condition,
        since: h.since ?? null,
        notes: h.notes ?? null,
        source: h.source,
        recorded_by: actor.id,
      })),
    );
  }

  if (payload.allergies?.length) {
    await supabaseAdmin.from('allergies').insert(
      payload.allergies.map((a) => ({
        patient_id: patient.id,
        substance: a.substance,
        reaction: a.reaction ?? null,
        severity: a.severity,
        source: a.source,
        recorded_by: actor.id,
      })),
    );
  }

  await recordAudit({
    action: 'patient_created',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'patient',
    entityId: patient.id,
    metadata: { facilityId, emergency: false },
    req,
  });

  return toApi(patient);
}

/**
 * Emergency registration bypass.
 *
 * Creates a minimal record and opens a visit in one step, so the assistant
 * can start treating immediately. The record is flagged incomplete and
 * appears in a "finish registration" queue afterwards — urgent must not mean
 * permanently orphaned.
 */
export async function emergencyRegister({ actor, payload, req }) {
  const facilityId = await facilityOf(actor.id);
  const rhid = await allocateRhid();

  const { data: patient, error } = await supabaseAdmin
    .from('patients')
    .insert({
      rhid,
      full_name: payload.fullName,
      sex: payload.sex,
      // The age constraint still applies; unknown age defaults to 0 and is
      // flagged incomplete rather than blocking care. Downstream triage
      // treats an incomplete record as missing data, which RAISES the tier.
      age_years: payload.ageYears ?? 0,
      facility_id: facilityId,
      emergency_registration: true,
      registration_complete: false,
      created_by: actor.id,
    })
    .select(PATIENT_COLUMNS)
    .single();

  if (error) throw ApiError.badRequest(error.message);

  const { data: visit, error: visitError } = await supabaseAdmin
    .from('visits')
    .insert({
      patient_id: patient.id,
      facility_id: facilityId,
      assistant_id: actor.id,
      chief_complaint: payload.chiefComplaint,
      status: 'open',
    })
    .select('id, status, chief_complaint, started_at')
    .single();

  if (visitError) throw ApiError.badRequest(visitError.message);

  await recordAudit({
    action: 'emergency_registration',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'patient',
    entityId: patient.id,
    metadata: { facilityId, visitId: visit.id },
    severity: 'warning',
    req,
  });

  return {
    patient: toApi(patient),
    visit,
    notice:
      'Registration is incomplete. Complete the patient record once the ' +
      'urgent situation has been handled.',
  };
}

/**
 * Search. RLS scopes results to the caller's facility/district, so a bug
 * here cannot widen the result set beyond what they may already see.
 */
export async function searchPatients({ actor, accessToken, query, req }) {
  const client = supabaseAsUser(accessToken);
  let request = client.from('patients').select(PATIENT_COLUMNS).limit(query.limit);

  if (query.rhid) {
    const rhid = normaliseRhid(query.rhid);
    if (!isValidRhid(rhid)) {
      // Reject before querying: a failed check digit is a typo, not a miss.
      // Telling the user "invalid ID" is more useful than "not found", and it
      // avoids a pointless lookup on every mistyped digit.
      throw ApiError.badRequest(
        'That health ID is not valid — please re-check the 12 digits',
      );
    }
    request = request.eq('rhid', rhid);
  }

  if (query.name) request = request.ilike('full_name', `%${query.name}%`);
  if (query.phone) request = request.ilike('phone', `%${query.phone}%`);

  const { data, error } = await request;
  if (error) throw ApiError.badRequest(error.message);

  await recordAudit({
    action: 'patient_searched',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'patient',
    metadata: {
      by: query.rhid ? 'rhid' : query.name ? 'name' : 'phone',
      resultCount: data.length,
    },
    req,
  });

  return data.map(toApi);
}

/** Full record: patient + history + allergies + recent visits. */
export async function getPatient({ accessToken, patientId }) {
  const client = supabaseAsUser(accessToken);

  const { data: patient, error } = await client
    .from('patients')
    .select(PATIENT_COLUMNS)
    .eq('id', patientId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  // RLS returning zero rows and the patient not existing are indistinguishable
  // to the caller by design — a 404 either way leaks nothing about other
  // facilities' records.
  if (!patient) throw ApiError.notFound('Patient not found');

  const [{ data: history }, { data: allergies }, { data: visits }] = await Promise.all([
    client
      .from('patient_history')
      .select('id, condition, since, notes, source, created_at')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false }),
    client
      .from('allergies')
      .select('id, substance, reaction, severity, source, created_at')
      .eq('patient_id', patientId),
    client
      .from('visits')
      .select('id, status, final_tier, chief_complaint, started_at, closed_at')
      .eq('patient_id', patientId)
      .order('started_at', { ascending: false })
      .limit(20),
  ]);

  return {
    ...toApi(patient),
    history: history ?? [],
    allergies: allergies ?? [],
    visits: visits ?? [],
  };
}

export async function updatePatient({ actor, accessToken, patientId, payload, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: before } = await client
    .from('patients')
    .select(PATIENT_COLUMNS)
    .eq('id', patientId)
    .maybeSingle();

  if (!before) throw ApiError.notFound('Patient not found');

  const patch = {};
  if (payload.fullName !== undefined) patch.full_name = payload.fullName;
  if (payload.sex !== undefined) patch.sex = payload.sex;
  if (payload.ageYears !== undefined) patch.age_years = payload.ageYears;
  if (payload.dateOfBirth !== undefined) {
    patch.date_of_birth = new Date(payload.dateOfBirth).toISOString().slice(0, 10);
  }
  if (payload.preferredLanguage !== undefined) {
    patch.preferred_language = payload.preferredLanguage;
  }
  if (payload.village !== undefined) patch.village = payload.village;
  if (payload.phone !== undefined) patch.phone = payload.phone;
  if (payload.abhaId !== undefined) patch.abha_id = payload.abhaId;

  // Completing an emergency record clears the incomplete flag once the
  // fields triage actually depends on are present.
  if (before.emergency_registration && !before.registration_complete) {
    const willHaveAge =
      patch.age_years !== undefined || patch.date_of_birth !== undefined
        ? true
        : before.age_years > 0 || before.date_of_birth !== null;
    if (willHaveAge) patch.registration_complete = true;
  }

  const { data, error } = await client
    .from('patients')
    .update(patch)
    .eq('id', patientId)
    .select(PATIENT_COLUMNS)
    .single();

  if (error) throw ApiError.badRequest(error.message);

  await recordAudit({
    action: 'patient_updated',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'patient',
    entityId: patientId,
    before: { full_name: before.full_name, age_years: before.age_years },
    after: patch,
    req,
  });

  return toApi(data);
}

export async function addHistory({ actor, accessToken, patientId, payload }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('patient_history')
    .insert({
      patient_id: patientId,
      condition: payload.condition,
      since: payload.since ?? null,
      notes: payload.notes ?? null,
      source: payload.source,
      recorded_by: actor.id,
    })
    .select('id, condition, since, notes, source, created_at')
    .single();

  if (error) throw ApiError.badRequest(error.message);
  return data;
}

export async function addAllergy({ actor, accessToken, patientId, payload }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('allergies')
    .insert({
      patient_id: patientId,
      substance: payload.substance,
      reaction: payload.reaction ?? null,
      severity: payload.severity,
      source: payload.source,
      recorded_by: actor.id,
    })
    .select('id, substance, reaction, severity, source, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw ApiError.conflict('That allergy is already recorded for this patient');
    }
    throw ApiError.badRequest(error.message);
  }
  return data;
}

/** Opens a visit. One open visit per patient at a time. */
export async function openVisit({ actor, accessToken, patientId, payload, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: existing } = await client
    .from('visits')
    .select('id')
    .eq('patient_id', patientId)
    .neq('status', 'closed')
    .maybeSingle();

  if (existing) {
    throw ApiError.conflict('This patient already has an open visit');
  }

  const facilityId = await facilityOf(actor.id);

  const { data, error } = await client
    .from('visits')
    .insert({
      patient_id: patientId,
      facility_id: facilityId,
      assistant_id: actor.id,
      chief_complaint: payload.chiefComplaint ?? null,
      status: 'open',
    })
    .select('id, patient_id, status, chief_complaint, started_at')
    .single();

  if (error) throw ApiError.badRequest(error.message);

  await recordAudit({
    action: 'visit_opened',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'visit',
    entityId: data.id,
    metadata: { patientId },
    req,
  });

  return data;
}

/**
 * The assistant's landing view: the 5–10 most recently handled patients.
 */
export async function recentPatients({ accessToken, limit = 10 }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('visits')
    .select(
      'id, status, final_tier, started_at, chief_complaint, ' +
        'patients(id, rhid, full_name, age_years, sex, village, ' +
        'emergency_registration, registration_complete)',
    )
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) throw ApiError.badRequest(error.message);

  return (data ?? []).map((v) => ({
    visitId: v.id,
    status: v.status,
    finalTier: v.final_tier,
    startedAt: v.started_at,
    chiefComplaint: v.chief_complaint,
    patient: v.patients
      ? {
          id: v.patients.id,
          rhid: v.patients.rhid,
          fullName: v.patients.full_name,
          ageYears: v.patients.age_years,
          sex: v.patients.sex,
          village: v.patients.village,
          emergencyRegistration: v.patients.emergency_registration,
          registrationComplete: v.patients.registration_complete,
        }
      : null,
  }));
}

export default {
  registerPatient,
  emergencyRegister,
  searchPatients,
  getPatient,
  updatePatient,
  addHistory,
  addAllergy,
  openVisit,
  recentPatients,
};
