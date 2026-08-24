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
import consultationRoutes from './consultation.routes.js';
import notificationRoutes from './notification.routes.js';
import referralRoutes from './referral.routes.js';

const router = Router();

/**
 * Public bootstrap config for the browser client.
 *
 * Only ever the project URL and the ANON key — both are public by design
 * and every request they make is still subject to row-level security. The
 * service-role key is never exposed here or anywhere client-reachable.
 */
router.get('/config', (req, res) =>
  res.json({
    success: true,
    data: {
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
      videoEnabled: Boolean(process.env.LIVEKIT_URL),
    },
  }),
);

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/patients', patientRoutes);
router.use('/intake', intakeRoutes);
router.use('/clinical', assessmentRoutes);
router.use('/consultations', consultationRoutes);
router.use('/notifications', notificationRoutes);
router.use('/referrals', referralRoutes);
router.use('/video', videoRoutes);

// Mounted in later phases:
// router.use('/iot', iotRoutes);                   // Phase 6

export default router;
