import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Unit tests use a fake database (no PostgreSQL needed in CI).
vi.mock('../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn(), create: vi.fn() } },
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: (err) => (err?.code === 'P2002' ? 'users_email_lower_key' : null),
}));

import { prisma } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { signAccessToken } from '../src/auth/tokens.js';

const SECRET = process.env.JWT_SECRET;
const PASSWORD = 'Password123';
const passwordHash = await hashPassword(PASSWORD);

const patient = {
  id: 7,
  name: 'Asha Reddy',
  email: 'asha.reddy@example.com',
  phone: null,
  passwordHash,
  role: 'PATIENT',
  isActive: true,
};

let app;
beforeEach(() => {
  vi.clearAllMocks();
  app = createApp(); // fresh app = fresh login rate-limit counter
});

describe('POST /api/v1/auth/register (FR-1.1 - FR-1.4, FR-1.8)', () => {
  const valid = { name: 'Asha Reddy', email: 'Asha.Reddy@Example.com', password: PASSWORD };

  it('creates a PATIENT, lowercases the email and never returns the hash', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }) => ({ id: 7, ...data }));

    const res = await request(app).post('/api/v1/auth/register').send(valid);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: 7,
      name: 'Asha Reddy',
      email: 'asha.reddy@example.com',
      phone: null,
      role: 'PATIENT',
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const saved = prisma.user.create.mock.calls[0][0].data;
    expect(saved.role).toBe('PATIENT');
    expect(saved.passwordHash).toMatch(/^\$2[aby]\$10\$/); // bcrypt, not plain text
    expect(saved.passwordHash).not.toContain(PASSWORD);
  });

  it('ignores a role sent by the client (cannot self-register as ADMIN)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }) => ({ id: 8, ...data }));

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...valid, role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('PATIENT');
  });

  it('returns 409 EMAIL_TAKEN for an existing email (any case)', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    const res = await request(app).post('/api/v1/auth/register').send(valid);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'asha.reddy@example.com' },
    });
  });

  it('returns 409 when the DB unique index catches a parallel duplicate', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    const res = await request(app).post('/api/v1/auth/register').send(valid);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['too short', 'abc12', 'at least 8'],
    ['without a number', 'Passwordonly', 'one number'],
    ['without a letter', '12345678', 'one letter'],
  ])('rejects a password %s (FR-1.3)', async (_label, password, message) => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...valid, password });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toContainEqual({
      field: 'password',
      message: expect.stringContaining(message),
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a missing name and an invalid email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: PASSWORD });

    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email']));
  });
});

describe('POST /api/v1/auth/login (FR-1.5, FR-1.6)', () => {
  it('returns a 1-hour Bearer token for correct credentials', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ASHA.REDDY@example.com', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.user.email).toBe('asha.reddy@example.com');

    const payload = jwt.verify(res.body.accessToken, SECRET);
    expect(payload.sub).toBe('7');
    expect(payload.role).toBe('PATIENT');
    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload).not.toHaveProperty('email'); // no personal data in the token
  });

  it('gives the SAME error for wrong password and unknown email (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(patient);
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: patient.email, password: 'WrongPass99' });

    prisma.user.findUnique.mockResolvedValueOnce(null);
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'WrongPass99' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 403 ACCOUNT_DISABLED for an inactive user', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...patient, isActive: false });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: patient.email, password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('returns 429 after 5 attempts in a minute from the same IP (NFR-3)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const attempt = () =>
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'x@example.com', password: 'Nope1234' });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const sixth = await attempt();

    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('GET /api/v1/me (FR-1.7)', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for a token signed with another secret', async () => {
    const forged = jwt.sign({ role: 'ADMIN' }, 'some-other-secret-value-1234567890', {
      subject: '1',
    });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 10;
    const expired = jwt.sign({ role: 'PATIENT', exp: expiredAt }, SECRET, { subject: '7' });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns the current user for a valid token', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);
    const token = signAccessToken(patient);

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(7);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});
