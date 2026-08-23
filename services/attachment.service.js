/**
 * Attachment upload, storage and retrieval.
 *
 * PHI DISCIPLINE (enforced throughout this file):
 *   - Original filenames are never logged. "ramesh-kumar-xray.jpg" is PHI.
 *   - Storage paths are opaque (facility/visit/uuid.ext) and carry no name,
 *     so the path itself is safe to log and appears in error messages.
 *   - Files are reachable only through short-TTL signed URLs. No bucket is
 *     public and nothing creates one.
 */
import { randomUUID } from 'node:crypto';

import { supabaseAdmin, supabaseAsUser } from '../config/supabase.js';
import { recordAudit } from './audit.service.js';
import { validateUpload } from '../utils/fileSignature.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** Signed URLs are short-lived: a leaked link should expire before it travels. */
const SIGNED_URL_TTL_SECONDS = 300;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 10;

const BUCKET_FOR_TYPE = Object.freeze({
  prescription: 'prescriptions',
  wound_image: 'wound-images',
  lab_report: 'lab-reports',
  other: 'prescriptions',
});

/** OCR only applies to documents, not to wound photographs. */
const OCR_APPLICABLE = new Set(['prescription', 'lab_report']);

function toApi(row) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    type: row.type,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    originalName: row.original_name,
    captureSource: row.capture_source,
    ocrStatus: row.ocr_status,
    needsHumanReview: row.needs_human_review,
    uploadBatchId: row.upload_batch_id,
    createdAt: row.created_at,
  };
}

/**
 * Confirms the caller may write to this visit, and returns its facility.
 * Read through the caller's JWT so RLS decides, not this function.
 */
async function assertVisitWritable(accessToken, visitId) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('visits')
    .select('id, patient_id, facility_id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Visit not found');
  if (data.status === 'closed') {
    throw ApiError.conflict('This visit is closed and cannot accept new files');
  }
  return data;
}

/**
 * Uploads one validated file.
 *
 * Called per file by `uploadAttachments`, which handles batching. Kept
 * separate so a partial batch failure is reportable per file rather than
 * failing the whole upload — a health worker who uploaded four photos and
 * lost all of them because the fifth was a HEIC will not upload again.
 */
async function uploadOne({ file, visit, type, captureSource, batchId, actor, req }) {
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      // No filename in the message — it goes to logs and Sentry.
      reason: `File exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit`,
    };
  }

  const check = validateUpload(file.buffer, type, file.mimetype);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (check.mismatch) {
    logger.info(
      {
        visitId: visit.id,
        declared: check.mismatch.declared,
        actual: check.mismatch.actual,
      },
      'Upload MIME mismatch — trusting magic bytes',
    );
  }

  const bucket = BUCKET_FOR_TYPE[type];
  // Opaque by construction: no patient name, no original filename.
  const storagePath = `${visit.facility_id}/${visit.id}/${randomUUID()}.${check.ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(bucket)
    .upload(storagePath, file.buffer, {
      contentType: check.mime,
      upsert: false,
    });

  if (uploadError) {
    logger.error(
      { err: uploadError, bucket, storagePath, visitId: visit.id },
      'Storage upload failed',
    );
    return { ok: false, reason: 'Storage upload failed' };
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from('attachments')
    .insert({
      visit_id: visit.id,
      patient_id: visit.patient_id,
      type,
      bucket,
      storage_path: storagePath,
      mime: check.mime,
      size_bytes: file.size,
      original_name: file.originalname ?? null,
      capture_source: captureSource,
      ocr_status: OCR_APPLICABLE.has(type) ? 'pending' : 'not_applicable',
      needs_human_review: OCR_APPLICABLE.has(type),
      upload_batch_id: batchId,
      uploaded_by: actor.id,
    })
    .select('*')
    .single();

  if (insertError) {
    // Roll back the object so storage does not accumulate orphans that no
    // row references and nothing will ever clean up.
    await supabaseAdmin.storage.from(bucket).remove([storagePath]).catch(() => {});
    logger.error(
      { err: insertError, bucket, storagePath },
      'Attachment row insert failed — storage object rolled back',
    );
    return { ok: false, reason: 'Could not record the attachment' };
  }

  await recordAudit({
    action: 'attachment_uploaded',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'attachment',
    entityId: row.id,
    // storage_path is opaque; original_name is deliberately absent.
    metadata: { visitId: visit.id, type, mime: check.mime, sizeBytes: file.size },
    req,
  });

  return { ok: true, attachment: toApi(row) };
}

/**
 * Uploads one or many files against a visit.
 *
 * The single-file and multi-file paths are the same endpoint on purpose:
 * the camera path sends one file, the file-manager path sends N, and the
 * client should not have to care which it is.
 */
export async function uploadAttachments({
  actor,
  accessToken,
  visitId,
  type,
  captureSource,
  files,
  req,
}) {
  if (!files?.length) throw ApiError.badRequest('No files were supplied');
  if (files.length > MAX_FILES_PER_BATCH) {
    throw ApiError.badRequest(`At most ${MAX_FILES_PER_BATCH} files per upload`);
  }

  const visit = await assertVisitWritable(accessToken, visitId);
  const batchId = randomUUID();

  const results = [];
  for (const file of files) {
    // Sequential rather than parallel: a rural uplink does not benefit from
    // ten concurrent multipart writes, and serialising keeps memory bounded.
    results.push(await uploadOne({ file, visit, type, captureSource, batchId, actor, req }));
  }

  const uploaded = results.filter((r) => r.ok).map((r) => r.attachment);
  const rejected = results
    .map((r, i) => (r.ok ? null : { index: i, reason: r.reason }))
    .filter(Boolean);

  if (!uploaded.length) {
    throw ApiError.badRequest('No files could be accepted', {
      code: 'UPLOAD_REJECTED',
      details: rejected,
    });
  }

  return { batchId, uploaded, rejected };
}

/** Lists attachments for a visit. RLS scopes it. */
export async function listForVisit({ accessToken, visitId, type }) {
  const client = supabaseAsUser(accessToken);
  let query = client
    .from('attachments')
    .select('*')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false });

  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) throw ApiError.badRequest(error.message);
  return data.map(toApi);
}

/**
 * Issues a short-lived signed URL.
 *
 * Authorisation comes from reading the row through the caller's JWT first —
 * if RLS will not return the row, no URL is minted.
 */
export async function getSignedUrl({ actor, accessToken, attachmentId, req }) {
  const client = supabaseAsUser(accessToken);
  const { data: row, error } = await client
    .from('attachments')
    .select('id, bucket, storage_path, mime, visit_id')
    .eq('id', attachmentId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!row) throw ApiError.notFound('Attachment not found');

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(row.bucket)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

  if (signError) {
    logger.error(
      { err: signError, bucket: row.bucket, storagePath: row.storage_path },
      'Could not sign attachment URL',
    );
    throw ApiError.internal('Could not generate a download link');
  }

  await recordAudit({
    action: 'attachment_downloaded',
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'attachment',
    entityId: row.id,
    metadata: { visitId: row.visit_id, ttlSeconds: SIGNED_URL_TTL_SECONDS },
    req,
  });

  return {
    url: signed.signedUrl,
    mime: row.mime,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  };
}

export default {
  uploadAttachments,
  listForVisit,
  getSignedUrl,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
};
