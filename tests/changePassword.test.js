// D-32: change password — rate limit and token revocation with a fake database.
// The full behaviour against PostgreSQL is in tests/integration/changePassword.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: vi.fn(),
}));

import { prisma } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { signAccessToken } from '../src/auth/tokens.js';

const user = {
  id: 7,
  name: 'Asha Reddy',
  email: 'asha.reddy@example.com',
  phone: null,
  passwordHash: await hashPassword('Password123'),
  role: 'PATIENT',
  isActive: true,
  passwordChangedAt: null,
};

let app;
beforeEach(() => {
  vi.clearAllMocks();
  app = createApp(); // fresh rate-limit counter
});

const change = (token, body) =>
  request(app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('POST /api/v1/auth/change-password — unit', () => {
  it('returns 429 after 5 attempts in a minute (guessing the current password)', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    const token = signAccessToken(user);
    const wrong = { currentPassword: 'Guess1234', newPassword: 'NewPassword9' };

    for (let i = 0; i < 5; i += 1) {
      expect((await change(token, wrong)).status).toBe(400);
    }
    const sixth = await change(token, wrong);

    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a token issued before passwordChangedAt is rejected on any protected route', async () => {
    const token = signAccessToken(user); // issued "now"
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      passwordChangedAt: new Date(Date.now() + 5_000), // changed 5 s later
    });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(res.body.error.message).toContain('password was changed');
  });

  it('a token issued in the same second as the change is still accepted', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 400);
    const token = signAccessToken(user);
    vi.useRealTimers();
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordChangedAt: new Date(now) });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
