/**
 * API v1 router.
 *
 * Domain routers are mounted here as each build phase lands. Versioned from
 * the start so a breaking change can ship as /api/v2 without stranding
 * devices in the field on an old build — relevant when the client is a
 * tablet in a village health centre that nobody updates promptly.
 */
import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import patientRoutes from './patient.routes.js';
import intakeRoutes from './intake.routes.js';
import videoRoutes from './video.routes.js';
import assessmentRoutes from './assessment.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/patients', patientRoutes);
router.use('/intake', intakeRoutes);
router.use('/clinical', assessmentRoutes);
router.use('/video', videoRoutes);

// Mounted in later phases:
// router.use('/consultations', consultationRoutes);// Phase 5 — scheduling,
//   the 5-minute tolerance window, doctor load balancing (D-039)
// router.use('/notifications', notificationRoutes);// Phase 5
// router.use('/iot', iotRoutes);                   // Phase 6

export default router;
