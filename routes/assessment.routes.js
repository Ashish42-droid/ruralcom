import { Router } from 'express';

import * as assessmentController from '../controllers/assessment.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';
import { assessmentLimiter } from '../middlewares/rateLimiter.js';
import {
  visitIdParamSchema,
  assessmentIdParamSchema,
  recordVitalsSchema,
} from '../models/clinical.schema.js';

const router = Router();

router.use(authenticate);
router.use(denyAdminClinicalWrite);

const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');
const assistantOnly = requireRole('clinical_assistant');

router.post(
  '/visits/:visitId/vitals',
  assistantOnly,
  validate({ params: visitIdParamSchema, body: recordVitalsSchema }),
  assessmentController.recordVitals,
);

router.get(
  '/visits/:visitId/vitals',
  clinicalStaff,
  validate({ params: visitIdParamSchema }),
  assessmentController.listVitals,
);

// Rate-limited because each run may spend a real model request.
router.post(
  '/visits/:visitId/assess',
  assistantOnly,
  assessmentLimiter,
  validate({ params: visitIdParamSchema }),
  assessmentController.runAssessment,
);

router.get(
  '/visits/:visitId/assessments',
  clinicalStaff,
  validate({ params: visitIdParamSchema }),
  assessmentController.listAssessments,
);

router.get(
  '/assessments/:assessmentId',
  clinicalStaff,
  validate({ params: assessmentIdParamSchema }),
  assessmentController.getAssessment,
);

export default router;
