import { Router } from 'express';
import { z } from 'zod';

import * as patientController from '../controllers/patient.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';
import { patientLookupLimiter } from '../middlewares/rateLimiter.js';
import {
  createPatientSchema,
  emergencyRegisterSchema,
  updatePatientSchema,
  searchPatientQuerySchema,
  addHistorySchema,
  addAllergySchema,
  openVisitSchema,
  patientIdParamSchema,
} from '../models/patient.schema.js';

const router = Router();

router.use(authenticate);

// Admins have no clinical access at all — not read, not write. Region-level
// management does not require seeing a named patient's record. RLS enforces
// this independently; this guard just fails faster and audits the attempt.
router.use(denyAdminClinicalWrite);

const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');
const assistantOnly = requireRole('clinical_assistant');

// Registration is the Clinical Assistant's job.
router.post(
  '/',
  assistantOnly,
  validate({ body: createPatientSchema }),
  patientController.register,
);

// Urgent path: minimal data, opens a visit immediately.
router.post(
  '/emergency',
  assistantOnly,
  validate({ body: emergencyRegisterSchema }),
  patientController.emergencyRegister,
);

// Rate-limited and audited so probing the 12-digit ID space is impractical
// and detectable.
router.get(
  '/search',
  clinicalStaff,
  patientLookupLimiter,
  validate({ query: searchPatientQuerySchema }),
  patientController.search,
);

router.get(
  '/recent',
  clinicalStaff,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(20).default(10) }) }),
  patientController.recent,
);

router.get(
  '/:patientId',
  clinicalStaff,
  validate({ params: patientIdParamSchema }),
  patientController.getOne,
);

router.patch(
  '/:patientId',
  clinicalStaff,
  validate({ params: patientIdParamSchema, body: updatePatientSchema }),
  patientController.update,
);

router.post(
  '/:patientId/history',
  clinicalStaff,
  validate({ params: patientIdParamSchema, body: addHistorySchema }),
  patientController.addHistory,
);

router.post(
  '/:patientId/allergies',
  clinicalStaff,
  validate({ params: patientIdParamSchema, body: addAllergySchema }),
  patientController.addAllergy,
);

router.post(
  '/:patientId/visits',
  assistantOnly,
  validate({ params: patientIdParamSchema, body: openVisitSchema }),
  patientController.openVisit,
);

export default router;
