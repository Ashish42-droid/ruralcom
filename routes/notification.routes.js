import { Router } from 'express';
import { z } from 'zod';

import * as notificationService from '../services/notification.service.js';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { ok } from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

const router = Router();

router.use(authenticate);

// Every role has notifications — including admins, whose notifications are
// operational rather than clinical — so this router deliberately has no
// role guard beyond authentication. RLS restricts each caller to their own.

router.get(
  '/',
  validate({
    query: z.object({
      unreadOnly: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await notificationService.listForUser({
      accessToken: req.accessToken,
      unreadOnly: req.validatedQuery?.unreadOnly === 'true',
      limit: req.validatedQuery?.limit ?? 50,
    });
    return ok(res, data, { meta: { count: data.length } });
  }),
);

router.post(
  '/:notificationId/read',
  validate({ params: z.object({ notificationId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const data = await notificationService.markRead({
      accessToken: req.accessToken,
      notificationId: req.params.notificationId,
    });
    return ok(res, data);
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const data = await notificationService.markAllRead({ accessToken: req.accessToken });
    return ok(res, data);
  }),
);

export default router;
