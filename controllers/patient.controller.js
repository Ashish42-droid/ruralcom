/**
 * Patient route handlers.
 */
import * as patientService from '../services/patient.service.js';
import { ok, created } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { formatRhid } from '../utils/rhid.js';

/** POST /api/v1/patients */
export const register = asyncHandler(async (req, res) => {
  const patient = await patientService.registerPatient({
    actor: req.user,
    payload: req.body,
    req,
  });

  return created(res, {
    ...patient,
    // Displayed once at the desk so the health worker can write it on a card.
    rhidFormatted: formatRhid(patient.rhid),
  });
});

/** POST /api/v1/patients/emergency */
export const emergencyRegister = asyncHandler(async (req, res) => {
  const result = await patientService.emergencyRegister({
    actor: req.user,
    payload: req.body,
    req,
  });

  return created(res, {
    ...result,
    patient: { ...result.patient, rhidFormatted: formatRhid(result.patient.rhid) },
  });
});

/** GET /api/v1/patients/search */
export const search = asyncHandler(async (req, res) => {
  const results = await patientService.searchPatients({
    actor: req.user,
    accessToken: req.accessToken,
    query: req.validatedQuery,
    req,
  });

  return ok(
    res,
    results.map((p) => ({ ...p, rhidFormatted: formatRhid(p.rhid) })),
    { meta: { count: results.length } },
  );
});

/** GET /api/v1/patients/recent */
export const recent = asyncHandler(async (req, res) => {
  const results = await patientService.recentPatients({
    accessToken: req.accessToken,
    limit: req.validatedQuery?.limit ?? 10,
  });
  return ok(res, results, { meta: { count: results.length } });
});

/** GET /api/v1/patients/:patientId */
export const getOne = asyncHandler(async (req, res) => {
  const patient = await patientService.getPatient({
    accessToken: req.accessToken,
    patientId: req.params.patientId,
  });
  return ok(res, { ...patient, rhidFormatted: formatRhid(patient.rhid) });
});

/** PATCH /api/v1/patients/:patientId */
export const update = asyncHandler(async (req, res) => {
  const patient = await patientService.updatePatient({
    actor: req.user,
    accessToken: req.accessToken,
    patientId: req.params.patientId,
    payload: req.body,
    req,
  });
  return ok(res, patient);
});

/** POST /api/v1/patients/:patientId/history */
export const addHistory = asyncHandler(async (req, res) => {
  const entry = await patientService.addHistory({
    actor: req.user,
    accessToken: req.accessToken,
    patientId: req.params.patientId,
    payload: req.body,
  });
  return created(res, entry);
});

/** POST /api/v1/patients/:patientId/allergies */
export const addAllergy = asyncHandler(async (req, res) => {
  const entry = await patientService.addAllergy({
    actor: req.user,
    accessToken: req.accessToken,
    patientId: req.params.patientId,
    payload: req.body,
  });
  return created(res, entry);
});

/** POST /api/v1/patients/:patientId/visits */
export const openVisit = asyncHandler(async (req, res) => {
  const visit = await patientService.openVisit({
    actor: req.user,
    accessToken: req.accessToken,
    patientId: req.params.patientId,
    payload: req.body,
    req,
  });
  return created(res, visit);
});
