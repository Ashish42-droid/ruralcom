/**
 * HIGH-tier referral route handlers.
 */
import * as referralService from '../services/referral.service.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

/** GET /api/v1/referrals/visits/:visitId/hospitals — ranked options, read-only */
export const findHospitals = asyncHandler(async (req, res) => {
  const data = await referralService.findHospitals({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.hospitals.length } });
});

/** POST /api/v1/referrals/visits/:visitId — issue a referral + its document */
export const issue = asyncHandler(async (req, res) => {
  const data = await referralService.issueReferral({
    actor: req.user,
    accessToken: req.accessToken,
    visitId: req.params.visitId,
    payload: req.body,
    req,
  });
  return created(res, data);
});

/** GET /api/v1/referrals/visits/:visitId */
export const listForVisit = asyncHandler(async (req, res) => {
  const data = await referralService.listForVisit({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data, { meta: { count: data.length } });
});

/**
 * GET /api/v1/referrals/visits/:visitId/danger-zone
 * Whether the HIGH-tier danger-zone UI state should still be showing.
 */
export const dangerZone = asyncHandler(async (req, res) => {
  const data = await referralService.dangerZoneState({
    accessToken: req.accessToken,
    visitId: req.params.visitId,
  });
  return ok(res, data);
});

/** POST /api/v1/referrals/documents/:documentId/printed — clears danger zone */
export const markPrinted = asyncHandler(async (req, res) => {
  const data = await referralService.markPrinted({
    actor: req.user,
    accessToken: req.accessToken,
    documentId: req.params.documentId,
    req,
  });
  return ok(res, data);
});
