/**
 * Symptom entry.
 *
 * The raw text is always kept in the language it was given. Any translation
 * or normalisation is stored alongside it, never over it: when a translation
 * goes wrong the original is the only evidence, and for clinical review the
 * original is the primary record.
 */
import { supabaseAsUser } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import ApiError from '../utils/ApiError.js';

function toApi(row) {
  return {
    id: row.id,
    visitId: row.visit_id,
    rawText: row.raw_text,
    language: row.language,
    inputMode: row.input_mode,
    normalizedText: row.normalized_text,
    durationDays: row.duration_days,
    onsetDate: row.onset_date,
    severityReported: row.severity_reported,
    sttProvider: row.stt_provider,
    sttConfidence: row.stt_confidence,
    createdAt: row.created_at,
  };
}

export async function recordSymptom({ actor, accessToken, visitId, payload, req }) {
  const client = supabaseAsUser(accessToken);

  const { data: visit, error: visitError } = await client
    .from('visits')
    .select('id, patient_id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (visitError) throw ApiError.badRequest(visitError.message);
  if (!visit) throw ApiError.notFound('Visit not found');
  if (visit.status === 'closed') {
    throw ApiError.conflict('This visit is closed');
  }

  // Onset cannot be in the future. Checked here rather than in the database
  // because "today" depends on the request's timezone, not the server's.
  if (payload.onsetDate && new Date(payload.onsetDate) > new Date()) {
    throw ApiError.badRequest('Onset date cannot be in the future');
  }

  const { data, error } = await client
    .from('symptom_entries')
    .insert({
      visit_id: visitId,
      patient_id: visit.patient_id,
      raw_text: payload.rawText,
      language: payload.language,
      input_mode: payload.inputMode ?? 'text',
      duration_days: payload.durationDays ?? null,
      onset_date: payload.onsetDate ?? null,
      severity_reported: payload.severityReported ?? null,
      // Provenance for voice entries, so a low-confidence transcript is
      // identifiable later rather than indistinguishable from typed text.
      stt_provider: payload.sttProvider ?? null,
      stt_confidence: payload.sttConfidence ?? null,
      recorded_by: actor.id,
    })
    .select('*')
    .single();

  if (error) throw ApiError.badRequest(error.message);

  await recordAudit({
    action: 'symptom_recorded',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'symptom_entry',
    entityId: data.id,
    // The symptom text itself is PHI and never enters the audit metadata.
    metadata: {
      visitId,
      language: payload.language,
      inputMode: payload.inputMode ?? 'text',
      textLength: payload.rawText.length,
    },
    req,
  });

  return toApi(data);
}

export async function listForVisit({ accessToken, visitId }) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('symptom_entries')
    .select('*')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: true });

  if (error) throw ApiError.badRequest(error.message);
  return data.map(toApi);
}

export default { recordSymptom, listForVisit };
