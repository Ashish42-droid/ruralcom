import { Router } from 'express';
import { z } from 'zod';

import * as videoController from '../controllers/video.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(authenticate);
router.use(denyAdminClinicalWrite);

const visitIdParamSchema = z.object({ visitId: z.string().uuid('Not a valid visit id') });

const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');

router.post(
  '/visits/:visitId/token',
  clinicalStaff,
  validate({ params: visitIdParamSchema }),
  videoController.getJoinToken,
);

router.post(
  '/visits/:visitId/close',
  clinicalStaff,
  validate({ params: visitIdParamSchema }),
  videoController.closeConsultation,
);

export default router;
