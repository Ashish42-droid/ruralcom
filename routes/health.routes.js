import { Router } from 'express';
import { live, ready, summary } from '../controllers/health.controller.js';

const router = Router();

router.get('/live', live);
router.get('/ready', ready);
router.get('/', summary);

export default router;
