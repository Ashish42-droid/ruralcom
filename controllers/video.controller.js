/**
 * Video consultation route handlers.
 *
 * Authorisation for a video token piggybacks on the SAME RLS check every
 * other visit-scoped endpoint uses: the visit is read through the caller's
 * own JWT (services/attachment.service.js uses the identical pattern for
 * uploads). If RLS will not return the row, no token is minted — a doctor
 * outside the visit's district or an assistant at another facility gets a
 * 404, not a video room.
 *
 * There is deliberately no scheduling, doctor-assignment, or "is this
 * doctor the one assigned to this consultation" check here yet, because
 * that assignment does not exist as data — see docs/DECISIONS.md D-039 for
 * what Phase 5 still needs before this is the full consultation flow.
 */
import { supabaseAsUser } from '../config/supabase.js';
import * as livekit from '../services/video/livekit.js';
import { ok } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

async function assertVisitReachable(accessToken, visitId) {
  const client = supabaseAsUser(accessToken);
  const { data, error } = await client
    .from('visits')
    .select('id, status')
    .eq('id', visitId)
    .maybeSingle();

  if (error) throw ApiError.badRequest(error.message);
  if (!data) throw ApiError.notFound('Visit not found');
  if (data.status === 'closed') {
    throw ApiError.conflict('This visit is closed');
  }
  return data;
}

/** POST /api/v1/video/visits/:visitId/token */
export const getJoinToken = asyncHandler(async (req, res) => {
  await assertVisitReachable(req.accessToken, req.params.visitId);

  await livekit.ensureRoom(req.params.visitId);

  const result = await livekit.createJoinToken({
    visitId: req.params.visitId,
    identity: req.user.id,
    displayName: req.user.fullName,
    role: req.user.role,
  });

  return ok(res, result);
});

/** POST /api/v1/video/visits/:visitId/close */
export const closeConsultation = asyncHandler(async (req, res) => {
  await assertVisitReachable(req.accessToken, req.params.visitId);
  await livekit.closeRoom(req.params.visitId);
  return ok(res, { closed: true });
});
