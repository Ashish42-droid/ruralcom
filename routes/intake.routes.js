import { Router } from 'express';

import * as intakeController from '../controllers/intake.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireRole, denyAdminClinicalWrite } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';
import { acceptFiles, acceptAudio, handleUploadErrors } from '../middlewares/upload.js';
import {
  visitIdParamSchema,
  attachmentIdParamSchema,
  uploadBodySchema,
  listAttachmentsQuerySchema,
  recordSymptomSchema,
} from '../models/intake.schema.js';

const router = Router();

router.use(authenticate);
router.use(denyAdminClinicalWrite);

const clinicalStaff = requireRole('clinical_assistant', 'doctor', 'senior_doctor');
const assistantOnly = requireRole('clinical_assistant');

// One endpoint for both entry points: the camera sends a single file, the
// file manager sends several, and the client should not have to care.
router.post(
  '/visits/:visitId/attachments',
  assistantOnly,
  acceptFiles,
  handleUploadErrors,
  validate({ params: visitIdParamSchema, body: uploadBodySchema }),
  intakeController.upload,
);

router.get(
  '/visits/:visitId/attachments',
  clinicalStaff,
  validate({ params: visitIdParamSchema, query: listAttachmentsQuerySchema }),
  intakeController.listAttachments,
);

// Short-TTL signed URL. No bucket is public; this is the only way in.
router.get(
  '/attachments/:attachmentId/url',
  clinicalStaff,
  validate({ params: attachmentIdParamSchema }),
  intakeController.signedUrl,
);

router.post(
  '/visits/:visitId/symptoms',
  assistantOnly,
  validate({ params: visitIdParamSchema, body: recordSymptomSchema }),
  intakeController.recordSymptom,
);

router.post(
  '/visits/:visitId/symptoms/voice',
  assistantOnly,
  acceptAudio,
  handleUploadErrors,
  validate({ params: visitIdParamSchema }),
  intakeController.recordVoiceSymptom,
);

router.get(
  '/visits/:visitId/symptoms',
  clinicalStaff,
  validate({ params: visitIdParamSchema }),
  intakeController.listSymptoms,
);

export default router;
