/**
 * Consultation and doctor-review route handlers.
 */
import * as consultationService from '../services/consultation.service.js';
import * as reviewService from '../services/review.service.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

/** POST /api/v1/consultations/visits/:visitId/schedule */
export const schedule = asyncHandler(async (req, res) => {
  const consultation = await consultationService.scheduleConsultation({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    req,
  });
  return created(res, consultation);
});

/** GET /api/v1/consultations/queue — the doctor's own queue */
export const doctorQueue = asyncHandler(async (req, res) => {
  const data = await consultationService.listForDoctor({
    accessToken: req.accessToken,
    actorId: req.user.id,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** GET /api/v1/consultations/visits/:visitId */
export const listForVisit = asyncHandler(async (req, res) => {
  const data = await consultationService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** POST /api/v1/consultations/:consultationId/join */
export const join = asyncHandler(async (req, res) => {
  const data = await consultationService.joinConsultation({
    actor: req.user,
    consultationId: req.params.consultationId,
    req,
  });
  return ok(res, data);
});

/** POST /api/v1/consultations/:consultationId/complete */
export const complete = asyncHandler(async (req, res) => {
  const data = await consultationService.completeConsultation({
    actor: req.user,
    consultationId: req.params.consultationId,
    req,
  });
  return ok(res, data);
});

// ---------------------------------------------------------------
// Doctor review queue
// ---------------------------------------------------------------

/** GET /api/v1/consultations/reviews/pending */
export const pendingReviews = asyncHandler(async (req, res) => {
  const data = await reviewService.listPendingReviews({
    accessToken: req.accessToken,
    actorId: req.user.id,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** POST /api/v1/consultations/assessments/:assessmentId/review */
export const submitReview = asyncHandler(async (req, res) => {
  const data = await reviewService.submitReview({
    actor: req.user,
    accessToken: req.accessToken,
    assessmentId: req.params.assessmentId,
    payload: req.body,
    req,
  });
  return created(res, data);
});

/** GET /api/v1/consultations/reviews/flagged — the assistant's feedback panel */
export const flaggedForAssistant = asyncHandler(async (req, res) => {
  const data = await reviewService.listFlaggedForAssistant({
    accessToken: req.accessToken,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** POST /api/v1/consultations/reviews/:reviewId/acknowledge */
export const acknowledgeReview = asyncHandler(async (req, res) => {
  const data = await reviewService.acknowledgeReview({
    actor: req.user,
    accessToken: req.accessToken,
    reviewId: req.params.reviewId,
    req,
  });
  return ok(res, data);
});
