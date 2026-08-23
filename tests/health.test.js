import request from 'supertest';

import app from '../app.js';
import { closePool } from '../config/db.js';

afterAll(async () => {
  await closePool();
});

describe('GET /api/v1/health/live', () => {
  it('reports alive without touching any dependency', async () => {
    const res = await request(app).get('/api/v1/health/live').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('alive');
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
  });

  it('echoes a request id header', async () => {
    const res = await request(app).get('/api/v1/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
  });

  it('preserves a caller-supplied request id for tracing', async () => {
    const res = await request(app)
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });
});

describe('GET /api/v1/health/ready', () => {
  it('checks Postgres and Supabase and reports each', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect([200, 503]).toContain(res.status);
    expect(res.body.data.checks).toHaveProperty('database');
    expect(res.body.data.checks).toHaveProperty('supabaseAuth');
  });
});

describe('GET /api/v1/health', () => {
  it('returns a summary identifying the responding instance', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.service).toBe('ruralai-core-api');
    expect(res.body.data.environment).toBe('test');
    expect(res.body.data.instance).toBeDefined();
  });
});

describe('error handling', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await request(app).get('/api/v1/does-not-exist').expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeDefined();
  });

  it('does not leak the Express fingerprint', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
