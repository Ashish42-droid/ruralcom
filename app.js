/**
 * Express application.
 *
 * Exported without listening so tests can drive it with supertest and so
 * server.js owns process concerns (ports, signals, shutdown).
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import env from './config/env.js';
import logger from './config/logger.js';
import apiRoutes from './routes/index.js';
import requestId from './middlewares/requestId.js';
import notFound from './middlewares/notFound.js';
import errorHandler from './middlewares/errorHandler.js';
import { generalLimiter } from './middlewares/rateLimiter.js';

const app = express();

// Behind Railway/Render/Cloudflare. Required for correct client IPs, which
// rate limiting and the audit log both depend on.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(requestId);

app.use(
  helmet({
    // The API serves JSON and signed file redirects, never HTML, so the
    // default CSP would only get in the way. The web app sets its own.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers (health probes, curl) send no Origin.
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  }),
);

app.use(compression());
// Browser sessions live in httpOnly cookies rather than localStorage, so an
// XSS in a page rendering OCR'd document text cannot exfiltrate a token.
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    // Health probes fire constantly; logging them buries real traffic.
    autoLogging: { ignore: (req) => req.url.startsWith('/api/v1/health') },
  }),
);

app.use(generalLimiter);

app.use('/api/v1', apiRoutes);

// Demo UI. Served from the API so there is one origin, one process and no
// CORS to configure for the demo — see docs/DECISIONS.md D-061.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// The React app is the UI. public/simple.html is kept as a zero-dependency
// fallback: if a build ever breaks on demo day, it still talks to the same
// API with no bundler involved.
app.get('/', (req, res) => res.redirect('/app/'));
app.use(express.static(publicDir, { index: 'index.html' }));

app.use(notFound);
app.use(errorHandler);

export default app;
