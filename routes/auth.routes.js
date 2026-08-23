import { Router } from 'express';

import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { authLimiter } from '../middlewares/rateLimiter.js';
import {
  loginSchema,
  refreshSchema,
  acceptInvitationSchema,
  updateOwnProfileSchema,
} from '../models/auth.schema.js';

const router = Router();

// NOTE: there is deliberately no POST /register. Doctors and Clinical
// Assistants can never self-register; only an admin provisions accounts.

router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

router.post('/refresh', validate({ body: refreshSchema.partial() }), authController.refresh);

router.post(
  '/accept-invitation',
  authLimiter,
  validate({ body: acceptInvitationSchema }),
  authController.acceptInvitation,
);

router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);
router.patch(
  '/me',
  authenticate,
  validate({ body: updateOwnProfileSchema }),
  authController.updateMe,
);

export default router;
