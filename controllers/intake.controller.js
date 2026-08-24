/**
 * Intake route handlers — attachments and symptom entry.
 */
import * as attachmentService from '../services/attachment.service.js';
import * as symptomService from '../services/symptom.service.js';
import { createSttService } from '../services/stt/index.js';
import { SttRejectedError } from '../services/stt/groqWhisper.js';
import env from '../config/env.js';
import logger from '../config/logger.js';
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

/** Built once; null when no provider is configured. */
let sttService;
function getSttService() {
  if (sttService === undefined) sttService = createSttService(env);
  return sttService;
}

/**
 * POST /api/v1/intake/visits/:visitId/symptoms/voice
 *
 * Transcribes a recording and stores it as a symptom entry, keeping the
 * transcript, its confidence, and the provider that produced it.
 */
export const recordVoiceSymptom = asyncHandler(async (req, res) => {
  const service = getSttService();
  if (!service) {
    throw ApiError.serviceUnavailable(
      'Voice entry is unavailable — no speech provider is configured',
      { code: 'STT_NOT_CONFIGURED' },
    );
  }

  if (!req.file?.buffer?.length) {
    throw ApiError.badRequest('No audio recording was supplied');
  }

  const language = req.body.language ?? 'hi';

  let result;
  try {
    result = await service.transcribe(req.file.buffer, language, { requestId: req.id });
  } catch (err) {
    if (err instanceof SttRejectedError || err.cause instanceof SttRejectedError) {
      // Whisper hallucinates fluent text on silence, so a no-speech
      // rejection is a SAFETY outcome, not a failure to work around.
      throw ApiError.badRequest(err.message, { code: 'NO_SPEECH_DETECTED' });
    }
    logger.warn({ err, requestId: req.id }, 'Voice transcription failed');
    throw ApiError.serviceUnavailable(
      'Could not transcribe the recording — please try again or type the symptoms',
      { code: 'TRANSCRIPTION_FAILED' },
    );
  }

  const entry = await symptomService.recordSymptom({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    payload: {
      rawText: result.text,
      language,
      inputMode: 'voice',
      sttProvider: result.provider,
      sttConfidence: result.confidence,
    },
    req,
  });

  return created(res, {
    ...entry,
    transcription: {
      confidence: result.confidence,
      provider: result.provider,
      latencyMs: result.latencyMs,
      durationSeconds: result.durationSeconds,
      // The health worker should read a low-confidence transcript back to
      // the patient before it is treated as their symptom description.
      needsHumanConfirmation: result.needsHumanConfirmation,
    },
  });
});

/** POST /api/v1/intake/visits/:visitId/symptoms */
export const recordSymptom = asyncHandler(async (req, res) => {
  if (req.body.inputMode === 'voice') {
    throw ApiError.badRequest(
      'Use POST /symptoms/voice with an audio recording for voice entry',
      { code: 'USE_VOICE_ENDPOINT' },
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
