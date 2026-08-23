import { Router } from 'express';

import * as adminController from '../controllers/admin.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { requireAdmin } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';
import {
  provisionAccountSchema,
  setActiveSchema,
  listStaffQuerySchema,
} from '../models/auth.schema.js';

const router = Router();

// Every route here requires an admin-family role. RLS additionally scopes
// results to the caller's state/district.
router.use(authenticate, requireAdmin);

router.post('/staff', validate({ body: provisionAccountSchema }), adminController.provisionStaff);

router.get('/staff', validate({ query: listStaffQuerySchema }), adminController.listStaff);

router.patch(
  '/staff/:profileId/status',
  validate({ body: setActiveSchema }),
  adminController.setStaffStatus,
);

router.get('/regions', adminController.listRegions);

export default router;
