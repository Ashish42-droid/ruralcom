/**
 * Intake route handlers — attachments and symptom entry.
 */
import * as attachmentService from '../services/attachment.service.js';
import * as symptomService from '../services/symptom.service.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

/**
 * POST /api/v1/intake/visits/:visitId/attachments
 * Handles one file (camera) and many (file manager) on the same endpoint.
 */
export const upload = asyncHandler(async (req, res) => {
  const result = await attachmentService.uploadAttachments({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    type: req.body.type,
    captureSource: req.body.captureSource,
    files: req.files,
    req,
  });

  return created(res, result, {
    meta: {
      uploadedCount: result.uploaded.length,
      rejectedCount: result.rejected.length,
    },
  });
});

/** GET /api/v1/intake/visits/:visitId/attachments */
export const listAttachments = asyncHandler(async (req, res) => {
  const data = await attachmentService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    type: req.validatedQuery?.type,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** GET /api/v1/intake/attachments/:attachmentId/url */
export const signedUrl = asyncHandler(async (req, res) => {
  const data = await attachmentService.getSignedUrl({
    actor: req.user,
    accessToken: req.accessToken,
    attachmentId: req.params.attachmentId,
    req,
  });
  return ok(res, data);
});

/** POST /api/v1/intake/visits/:visitId/symptoms */
export const recordSymptom = asyncHandler(async (req, res) => {
  if (req.body.inputMode === 'voice') {
    // Better an honest refusal than an entry that looks transcribed and is
    // not. See services/stt/adapters.js.
    throw ApiError.serviceUnavailable(
      'Voice entry is not available yet — no speech provider is configured',
      { code: 'STT_NOT_CONFIGURED' },
    );
  }

  const entry = await symptomService.recordSymptom({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    payload: req.body,
    req,
  });

  return created(res, entry);
});

/** GET /api/v1/intake/visits/:visitId/symptoms */
export const listSymptoms = asyncHandler(async (req, res) => {
  const data = await symptomService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.length } });
});
