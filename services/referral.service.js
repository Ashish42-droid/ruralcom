/**
 * HIGH-tier referral: find the nearest capable hospital, snapshot what it
 * looked like, and produce a printable slip.
 *
 * ===================== TWO HONESTY CONSTRAINTS =====================
 *
 * 1. DISTANCE IS STRAIGHT-LINE, NOT ROAD DISTANCE. Haversine over
 *    district-centroid coordinates. In rural terrain the two diverge
 *    sharply — a river with no nearby bridge is the ordinary case, not the
 *    exception — so every distance this module emits is labelled
 *    approximate and `distanceBasis: 'straight_line'`. Presenting it as
 *    travel distance to someone deciding whether to move a critical
 *    patient would be actively dangerous.
 *
 * 2. BED COUNTS GO STALE. Capacity is snapshotted at referral time along
 *    with how old the figures already were. A referral made against a
 *    three-day-old count is a different clinical act from one made against
 *    live data, and the record says which it was.
 * ===================================================================
 */
import { supabaseAdmin, supabaseAsUser } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** Facility types able to accept an emergency referral. */
const REFERRAL_CAPABLE = ['district_hospital', 'chc'];

/** Beyond this, warn — a rural transfer this far is its own clinical risk. */
export const LONG_TRANSFER_WARNING_KM = 50;

/** Older than this and the bed figures should not be trusted as current. */
export const STALE_CAPACITY_SECONDS = 24 * 60 * 60;

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. Straight-line — see the note above. */
export function haversineKm(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;

  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h)) * 100) / 100;
}

function ageSeconds(timestamp) {
  if (!timestamp) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
}

/**
 * Ranks candidate hospitals for a referral.
 *
 * Ordering is capability first, then beds, then distance — deliberately
 * NOT distance first. The nearest hospital that cannot take the patient is
 * not a destination, it is a wasted journey, and in a time-critical
 * transfer that is the costliest possible mistake.
 *
 * Hospitals with no free beds are still returned, ranked last and flagged,
 * rather than hidden: when everything nearby is full the assistant needs
 * to see that and call ahead, not be shown an empty list.
 */
export function rankHospitals({ origin, candidates, requireEmergency = true }) {
  return candidates
    .map((facility) => {
      const capacity = facility.hospital_capacity ?? null;

      // Do NOT use Number() here: Number(null) is 0, which would place a
      // facility with missing coordinates at (0,0) -- off the coast of
      // Africa -- and render "9045 km away" on a referral screen instead
      // of an honest "distance unknown".
      const toCoord = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
      const distanceKm = haversineKm(origin, {
        lat: toCoord(facility.latitude),
        lng: toCoord(facility.longitude),
      });

      const availableBeds = capacity?.available_beds ?? 0;
      const capacityAge = ageSeconds(capacity?.last_updated_at);

      return {
        facilityId: facility.id,
        name: facility.name,
        type: facility.type,
        contact: facility.contact,
        address: facility.address,
        latitude: facility.latitude,
        longitude: facility.longitude,
        distanceKm,
        // Never presented as travel distance.
        distanceBasis: 'straight_line',
        hasEmergency: capacity?.has_emergency ?? false,
        hasAmbulance: capacity?.has_ambulance ?? false,
        totalBeds: capacity?.total_beds ?? 0,
        availableBeds,
        icuAvailable: capacity?.icu_available ?? 0,
        capacityAgeSeconds: capacityAge,
        capacityIsStale: capacityAge === null || capacityAge > STALE_CAPACITY_SECONDS,
        capacityDataSource: capacity?.data_source ?? null,
        hasCapacityData: Boolean(capacity),
        longTransfer: Number.isFinite(distanceKm) && distanceKm > LONG_TRANSFER_WARNING_KM,
      };
    })
    .filter((h) => !requireEmergency || h.hasEmergency || h.type === 'district_hospital')
    .sort((a, b) => {
      // 1. Somewhere that can actually admit them.
      if ((a.availableBeds > 0) !== (b.availableBeds > 0)) {
        return a.availableBeds > 0 ? -1 : 1;
      }
      // 2. Emergency capability.
      if (a.hasEmergency !== b.hasEmergency) return a.hasEmergency ? -1 : 1;
      // 3. Then, and only then, distance. Unknown distance sorts last.
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

/**
 * Candidate hospitals for a visit, ranked. Read-only — issuing is separate,
 * so the assistant can see the options before committing.
 */
export async function findHospitals({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);

  const { data: visit, error } = await client
    .from('visits')
    .select('id, facility_id, facilities(id, name, district_id, latitude, longitude)')
    .eq('id', visitId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!visit) throw ApiError.notFound('Visit not found');

  // Same nullish care as in rankHospitals: an origin facility with no
  // coordinates must yield "unknown", never a distance measured from (0,0).
  const originCoord = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const origin = {
    lat: originCoord(visit.facilities?.latitude),
    lng: originCoord(visit.facilities?.longitude),
  };

  // Search the whole state, not just the district: the nearest capable
  // hospital is frequently across a district line, and a border facility
  // would otherwise be excluded for an administrative reason that means
  // nothing to a patient in an ambulance.
  const { data: district } = await supabaseAdmin
    .from('districts')
    .select('id, state_id')
    .eq('id', visit.facilities.district_id)
    .single();

  const { data: districts } = await supabaseAdmin
    .from('districts')
    .select('id')
    .eq('state_id', district.state_id);

  const { data: candidates, error: candidatesError } = await supabaseAdmin
    .from('facilities')
    .select(
      'id, name, type, contact, address, latitude, longitude, is_active, district_id, ' +
        'hospital_capacity(total_beds, available_beds, icu_available, has_emergency, ' +
        'has_ambulance, last_updated_at, data_source)',
    )
    .in('district_id', (districts ?? []).map((d) => d.id))
    .in('type', REFERRAL_CAPABLE)
    .eq('is_active', true);

  if (candidatesError) throw ApiError.badRequest(candidatesError.message);

  const ranked = rankHospitals({ origin, candidates: candidates ?? [] });

  return {
    origin: {
      facilityId: visit.facilities.id,
      name: visit.facilities.name,
      latitude: visit.facilities.latitude,
      longitude: visit.facilities.longitude,
    },
    hospitals: ranked,
    notice:
      'Distances are straight-line approximations, not road distances. ' +
      'Confirm bed availability by telephone before transferring.',
  };
}

/** Sequential-ish, human-quotable document number. */
function documentNumber() {
  const now = new Date();
  const stamp =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  return `REF-${stamp}-${rand}`;
}

/**
 * Issues a referral and its printable document.
 *
 * Server-owned (service role): it snapshots capacity and computes
 * distance, neither of which a client may forge, and `referrals` has no
 * INSERT policy for `authenticated`.
 */
export async function issueReferral({ actor, accessToken, visitId, payload, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: visit, error } = await client
    .from('visits')
    .select('id, patient_id, facility_id, status, final_tier')
    .eq('id', visitId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!visit) throw ApiError.notFound('Visit not found');
  if (visit.status === 'closed') throw ApiError.conflict('This visit is closed');

  const { data: existing } = await client
    .from('referrals')
    .select('id')
    .eq('visit_id', visitId)
    .eq('status', 'issued')
    .maybeSingle();

  if (existing) {
    throw ApiError.conflict('This visit already has an active referral', {
      code: 'REFERRAL_EXISTS',
    });
  }

  const { hospitals, origin } = await findHospitals({ accessToken, visitId });

  // An explicit choice wins — the assistant may know the nearest hospital
  // is not accepting, or that transport only runs one route.
  const chosen = payload.targetFacilityId
    ? hospitals.find((h) => h.facilityId === payload.targetFacilityId)
    : hospitals[0];

  if (!chosen) {
    throw ApiError.serviceUnavailable(
      'No referral-capable hospital could be identified for this facility',
      { code: 'NO_HOSPITAL_AVAILABLE' },
    );
  }

  const { data: assessment } = await supabaseAdmin
    .from('ai_assessments')
    .select('id, final_tier')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: referral, error: referralError } = await supabaseAdmin
    .from('referrals')
    .insert({
      visit_id: visitId,
      patient_id: visit.patient_id,
      assessment_id: assessment?.id ?? null,
      target_facility_id: chosen.facilityId,
      origin_facility_id: visit.facility_id,
      reason: payload.reason,
      distance_km: chosen.distanceKm,
      // Frozen at decision time. See the module header.
      capacity_snapshot: {
        totalBeds: chosen.totalBeds,
        availableBeds: chosen.availableBeds,
        icuAvailable: chosen.icuAvailable,
        hasEmergency: chosen.hasEmergency,
        hasAmbulance: chosen.hasAmbulance,
        dataSource: chosen.capacityDataSource,
        wasStale: chosen.capacityIsStale,
      },
      contact_snapshot: {
        name: chosen.name,
        contact: chosen.contact,
        address: chosen.address,
        latitude: chosen.latitude,
        longitude: chosen.longitude,
      },
      capacity_age_seconds: chosen.capacityAgeSeconds,
      created_by: actor.id,
    })
    .select('*')
    .single();

  if (referralError) throw ApiError.badRequest(referralError.message);

  const { data: document, error: documentError } = await supabaseAdmin
    .from('referral_documents')
    .insert({
      referral_id: referral.id,
      visit_id: visitId,
      document_number: documentNumber(),
      // Empty by default: care at a government PHC/CHC is frequently free,
      // and inventing charges would be worse than showing none.
      line_items: payload.lineItems ?? [],
      total_amount: (payload.lineItems ?? []).reduce(
        (sum, item) => sum + Number(item.amount ?? 0),
        0,
      ),
      charge_source: 'PLACEHOLDER_DEMO',
      created_by: actor.id,
    })
    .select('*')
    .single();

  if (documentError) {
    // A referral without its slip leaves the danger-zone state with no way
    // to clear and the patient with nothing to carry.
    await supabaseAdmin.from('referrals').delete().eq('id', referral.id);
    logger.error(
      { err: documentError, visitId },
      'Referral document failed — referral rolled back',
    );
    throw ApiError.internal('Could not produce the referral document');
  }

  await supabaseAdmin
    .from('visits')
    .update({ status: 'referred' })
    .eq('id', visitId);

  await recordAudit({
    action: 'referral_issued',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'referral',
    entityId: referral.id,
    metadata: {
      visitId,
      targetFacilityId: chosen.facilityId,
      distanceKm: chosen.distanceKm,
      availableBedsAtIssue: chosen.availableBeds,
      capacityWasStale: chosen.capacityIsStale,
      documentNumber: document.document_number,
    },
    severity: 'warning',
    req,
  });

  return {
    referral: toReferralApi(referral, chosen),
    document: toDocumentApi(document),
    origin,
    alternatives: hospitals.filter((h) => h.facilityId !== chosen.facilityId).slice(0, 3),
    warnings: buildWarnings(chosen),
  };
}

/** Everything the assistant must be told before moving the patient. */
function buildWarnings(hospital) {
  const warnings = [];

  if (hospital.availableBeds === 0) {
    warnings.push({
      code: 'NO_BEDS_RECORDED',
      severity: 'critical',
      message:
        'This hospital shows no free beds. Telephone before transferring.',
    });
  }

  if (hospital.capacityIsStale) {
    warnings.push({
      code: 'STALE_CAPACITY',
      severity: 'warning',
      message:
        'Bed figures are out of date and may not reflect the current position. Confirm by telephone.',
    });
  }

  if (hospital.capacityDataSource === 'PLACEHOLDER_DEMO') {
    warnings.push({
      code: 'DEMO_DATA',
      severity: 'critical',
      message:
        'Bed availability is DEMONSTRATION DATA, not a live feed. Do not rely on it clinically.',
    });
  }

  if (hospital.longTransfer) {
    warnings.push({
      code: 'LONG_TRANSFER',
      severity: 'warning',
      message: `Approximately ${hospital.distanceKm} km in a straight line — road distance will be greater. Consider transport and escort.`,
    });
  }

  warnings.push({
    code: 'DISTANCE_IS_APPROXIMATE',
    severity: 'info',
    message: 'Distance is straight-line, not road distance.',
  });

  return warnings;
}

function toReferralApi(row, hospital = null) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    assessmentId: row.assessment_id,
    targetFacilityId: row.target_facility_id,
    originFacilityId: row.origin_facility_id,
    reason: row.reason,
    distanceKm: row.distance_km === null ? null : Number(row.distance_km),
    distanceBasis: 'straight_line',
    capacitySnapshot: row.capacity_snapshot,
    contactSnapshot: row.contact_snapshot,
    capacityAgeSeconds: row.capacity_age_seconds,
    status: row.status,
    createdAt: row.created_at,
    hospital,
  };
}

function toDocumentApi(row) {
  return {
    id: row.id,
    referralId: row.referral_id,
    visitId: row.visit_id,
    documentNumber: row.document_number,
    lineItems: row.line_items,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    chargeSource: row.charge_source,
    printedAt: row.printed_at,
    createdAt: row.created_at,
    // The UI must not present placeholder amounts as payable.
    chargesAreProvisional: row.charge_source === 'PLACEHOLDER_DEMO',
  };
}

/**
 * Marks the slip printed, which clears the HIGH-tier danger-zone state.
 */
export async function markPrinted({ actor, accessToken, documentId, req }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('referral_documents')
    .update({ printed_at: new Date().toISOString(), printed_by: actor.id })
    .eq('id', documentId)
    .is('printed_at', null)
    .select('*')
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Document not found, or already printed');

  await recordAudit({
    action: 'referral_document_printed',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'referral_document',
    entityId: documentId,
    metadata: { visitId: data.visit_id, documentNumber: data.document_number },
    req,
  });

  return toDocumentApi(data);
}

/** Referrals for a visit, with their documents. */
export async function listForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('referrals')
    .select('*, referral_documents(*)')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false });

  if (error) throw ApiError.badRequest(error.message);

  return (data ?? []).map((r) => ({
    ...toReferralApi(r),
    documents: (r.referral_documents ?? []).map(toDocumentApi),
  }));
}

/**
 * Whether the danger-zone UI state should still be showing for a visit:
 * a referral exists and its document has not been printed.
 */
export async function dangerZoneState({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);

  const { data, error } = await client
    .from('referrals')
    .select('id, status, referral_documents(id, printed_at, document_number)')
    .eq('visit_id', visitId)
    .eq('status', 'issued')
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) return { active: false };

  const unprinted = (data.referral_documents ?? []).filter((d) => !d.printed_at);

  return {
    active: unprinted.length > 0,
    referralId: data.id,
    pendingDocuments: unprinted.map((d) => ({
      id: d.id,
      documentNumber: d.document_number,
    })),
  };
}

export default {
  findHospitals,
  issueReferral,
  markPrinted,
  listForVisit,
  dangerZoneState,
  rankHospitals,
  haversineKm,
};
