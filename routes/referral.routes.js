import { Router } from 'express';
import { z } from 'zod';

import * as referralController from '../controllers/referral.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(authenticate);
router.use(denyAdminClinicalWrite);

const visitIdParam = z.object({ visitId: z.string().uuid('Not a valid visit id') });
const documentIdParam = z.object({ documentId: z.string().uuid('Not a valid document id') });

const issueSchema = z.object({
  reason: z.string().trim().min(3, 'State why the patient is being referred').max(1000),
  // Optional: the assistant may know the nearest hospital is not accepting,
  // or that transport only runs one route.
  targetFacilityId: z.string().uuid().optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        amount: z.coerce.number().min(0).max(1_000_000),
      }),
    )
    .max(20)
    .optional(),
});

const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');
const assistantOrDoctor = requireRole('clinical_assistant', 'doctor', 'senior_doctor');

router.get(
  '/visits/:visitId/hospitals',
  clinicalStaff,
  validate({ params: visitIdParam }),
  referralController.findHospitals,
);

router.post(
  '/visits/:visitId',
  assistantOrDoctor,
  validate({ params: visitIdParam, body: issueSchema }),
  referralController.issue,
);

router.get(
  '/visits/:visitId',
  clinicalStaff,
  validate({ params: visitIdParam }),
  referralController.listForVisit,
);

router.get(
  '/visits/:visitId/danger-zone',
  clinicalStaff,
  validate({ params: visitIdParam }),
  referralController.dangerZone,
);

router.post(
  '/documents/:documentId/printed',
  assistantOrDoctor,
  validate({ params: documentIdParam }),
  referralController.markPrinted,
);

export default router;
