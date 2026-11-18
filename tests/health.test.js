import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Unit tests must not need a real database: replace the db module with a fake.
vi.mock('../src/db.js', () => ({
  isDatabaseUp: vi.fn(),
  prisma: {},
}));

import { isDatabaseUp } from '../src/db.js';
import { createApp } from '../src/app.js';

const app = createApp();

describe('GET /health (NFR-7)', () => {
  beforeEach(() => {
    isDatabaseUp.mockResolvedValue(true);
  });

  it('returns 200 with status ok when the database is up', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('returns 503 degraded when the database is down', async () => {
    isDatabaseUp.mockResolvedValue(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database).toBe('down');
  });

  it('does not expose the x-powered-by header', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Error handling', () => {
  it('returns 404 with the standard error body for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
    });
  });

  it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"bad json"');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
