// D-30: rate limits must count per real client, also behind a hosting proxy.
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue(null) } },
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: vi.fn(),
}));

const loginFrom = (app, ip) => {
  const req = request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'x@example.com', password: 'Nope1234' });
  return ip ? req.set('X-Forwarded-For', ip) : req;
};

async function appWith(hops) {
  vi.resetModules();
  vi.stubEnv('TRUST_PROXY_HOPS', String(hops));
  const { createApp } = await import('../src/app.js');
  return createApp();
}

afterEach(() => vi.unstubAllEnvs());

describe('trust proxy (D-30)', () => {
  it('behind a proxy (hops=1): each real client has its own login limit', async () => {
    const app = await appWith(1);
    for (let i = 0; i < 5; i += 1) await loginFrom(app, '203.0.113.1');

    expect((await loginFrom(app, '203.0.113.1')).status).toBe(429);
    expect((await loginFrom(app, '203.0.113.2')).status).toBe(401); // another user is not blocked
  });

  it('without a proxy (default): a faked X-Forwarded-For cannot dodge the limit', async () => {
    const app = await appWith(0);
    for (let i = 0; i < 5; i += 1) await loginFrom(app, `198.51.100.${i}`);

    expect((await loginFrom(app, '198.51.100.99')).status).toBe(429);
  });
});
