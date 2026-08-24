import { Router } from 'express';
import { z } from 'zod';

import * as consultationController from '../controllers/consultation.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(authenticate);
router.use(denyAdminClinicalWrite);

const visitIdParam = z.object({ visitId: z.string().uuid('Not a valid visit id') });
const consultationIdParam = z.object({
  consultationId: z.string().uuid('Not a valid consultation id'),
});
const assessmentIdParam = z.object({
  assessmentId: z.string().uuid('Not a valid assessment id'),
});
const reviewIdParam = z.object({ reviewId: z.string().uuid('Not a valid review id') });

const submitReviewSchema = z
  .object({
    action: z.enum(['approve', 'flag_to_assistant', 'refer']),
    clinicalNote: z.string().trim().min(1).max(2000).optional(),
    correctedInstruction: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    (v) => v.action !== 'flag_to_assistant' || Boolean(v.clinicalNote),
    {
      path: ['clinicalNote'],
      // Mirrors the flag_requires_note DB constraint, so the caller gets a
      // field-level message instead of a raw constraint violation.
      message: 'A clinical note is required when flagging a case back to the assistant',
    },
  );

const doctorOnly = requireRole('doctor', 'senior_doctor');
const assistantOnly = requireRole('clinical_assistant');
const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');

// --- Consultations ---------------------------------------------

router.post(
  '/visits/:visitId/schedule',
  assistantOnly,
  validate({ params: visitIdParam }),
  consultationController.schedule,
);

router.get('/queue', doctorOnly, consultationController.doctorQueue);

router.get(
  '/visits/:visitId',
  clinicalStaff,
  validate({ params: visitIdParam }),
  consultationController.listForVisit,
);

router.post(
  '/:consultationId/join',
  doctorOnly,
  validate({ params: consultationIdParam }),
  consultationController.join,
);

router.post(
  '/:consultationId/complete',
  doctorOnly,
  validate({ params: consultationIdParam }),
  consultationController.complete,
);

// --- Doctor review queue ---------------------------------------

router.get('/reviews/pending', doctorOnly, consultationController.pendingReviews);

router.post(
  '/assessments/:assessmentId/review',
  doctorOnly,
  validate({ params: assessmentIdParam, body: submitReviewSchema }),
  consultationController.submitReview,
);

// The assistant's "doctor feedback" panel.
router.get('/reviews/flagged', assistantOnly, consultationController.flaggedForAssistant);

router.post(
  '/reviews/:reviewId/acknowledge',
  assistantOnly,
  validate({ params: reviewIdParam }),
  consultationController.acknowledgeReview,
);

export default router;
