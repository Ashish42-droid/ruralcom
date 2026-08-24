/**
 * Vitals and assessment route handlers.
 */
import * as vitalsService from '../services/vitals.service.js';
import * as assessmentService from '../services/assessment.service.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

/** POST /api/v1/clinical/visits/:visitId/vitals */
export const recordVitals = asyncHandler(async (req, res) => {
  const vitals = await vitalsService.recordVitals({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    payload: req.body,
    req,
  });
  return created(res, vitals);
});

/** GET /api/v1/clinical/visits/:visitId/vitals */
export const listVitals = asyncHandler(async (req, res) => {
  const data = await vitalsService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/**
 * POST /api/v1/clinical/visits/:visitId/assess
 *
 * Runs the triage engine and stores the result. Rate-limited: each call may
 * spend a real model request.
 */
export const runAssessment = asyncHandler(async (req, res) => {
  const assessment = await assessmentService.assessVisit({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    req,
  });
  return created(res, assessment);
});

/** GET /api/v1/clinical/visits/:visitId/assessments */
export const listAssessments = asyncHandler(async (req, res) => {
  const data = await assessmentService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/** GET /api/v1/clinical/assessments/:assessmentId */
export const getAssessment = asyncHandler(async (req, res) => {
  const data = await assessmentService.getById({
    accessToken: req.accessToken,
    assessmentId: req.params.assessmentId,
  });
  return ok(res, data);
});
