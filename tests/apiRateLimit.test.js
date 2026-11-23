// D-34: every API route has an overall per-IP rate limit; /health does not.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

vi.mock('../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn() } },
  isDatabaseUp: vi.fn().mockResolvedValue(true),
  uniqueViolationIndex: vi.fn(),
}));

let createApp;
beforeAll(async () => {
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '3');
  vi.resetModules(); // config is read at import time
  ({ createApp } = await import('../src/app.js'));
});
afterAll(() => vi.unstubAllEnvs());

describe('overall API rate limit (D-34)', () => {
  it('the 4th request in a minute from one IP gets 429 with the standard error body', async () => {
    const app = createApp();
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/v1/specializations')).status).toBe(401);
    }

    const fourth = await request(app).get('/api/v1/specializations');

    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toEqual({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests. Please wait a minute and try again.',
    });
    expect(fourth.headers['ratelimit-policy']).toBeDefined();
  });

  it('counts all API routes together', async () => {
    const app = createApp();
    await request(app).get('/api/v1/me');
    await request(app).get('/api/v1/doctors');
    await request(app).get('/api/v1/appointments/me');

    expect((await request(app).post('/api/v1/auth/login').send({})).status).toBe(429);
  });

  it('/health is not limited (monitoring must always get an answer)', async () => {
    const app = createApp();
    for (let i = 0; i < 6; i += 1) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });

  it('the default is 300 per minute', async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const { config } = await import('../src/config.js');
    expect(config.apiRateLimitPerMinute).toBe(300);
  });
});
