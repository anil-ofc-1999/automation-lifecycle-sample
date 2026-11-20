// Extra positive / negative scenarios for FR-1 (register, login, /me).
// Complements auth.test.js. Uses a fake database, so no PostgreSQL is needed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../src/db.js', () => ({
  prisma: { user: { findUnique: vi.fn(), create: vi.fn() } },
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: (err) => (err?.code === 'P2002' ? 'users_email_lower_key' : null),
}));

import { prisma } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { signAccessToken, verifyAccessToken } from '../src/auth/tokens.js';

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

const valid = { name: 'Asha Reddy', email: 'asha.reddy@example.com', password: PASSWORD };

let app;
beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.create.mockImplementation(async ({ data }) => ({ id: 21, ...data }));
});

const register = (body) => request(app).post('/api/v1/auth/register').send(body);
const login = (body) => request(app).post('/api/v1/auth/login').send(body);
const me = (authorization) => {
  const req = request(app).get('/api/v1/me');
  return authorization === undefined ? req : req.set('Authorization', authorization);
};

function expectFieldError(res, field, message) {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(res.body.error.details).toContainEqual({
    field,
    message: expect.stringContaining(message),
  });
}

describe('register — positive scenarios (FR-1.1)', () => {
  it('saves an optional phone number (trimmed)', async () => {
    const res = await register({ ...valid, phone: '  +91 98765-43210  ' });

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBe('+91 98765-43210');
  });

  it('works without a phone and returns phone: null', async () => {
    const res = await register(valid);

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBeNull();
    expect(prisma.user.create.mock.calls[0][0].data.phone).toBeUndefined();
  });

  it('trims spaces around name and email', async () => {
    const res = await register({ ...valid, name: '  Asha Reddy ', email: '  ASHA@Example.com ' });

    expect(res.status).toBe(201);
    expect(res.body.user.name).toBe('Asha Reddy');
    expect(res.body.user.email).toBe('asha@example.com');
  });

  it.each([
    ['exactly 8 characters', 'abcdefg1'],
    ['exactly 72 characters', `${'a'.repeat(71)}1`],
    ['special characters', 'P@ss w0rd!#'],
  ])('accepts a password with %s (FR-1.3 boundary)', async (_label, password) => {
    expect((await register({ ...valid, password })).status).toBe(201);
  });

  it('accepts a 2-character name (minimum)', async () => {
    expect((await register({ ...valid, name: 'Al' })).status).toBe(201);
  });

  it('does not return a token on register (user must log in)', async () => {
    const res = await register(valid);

    expect(res.body).not.toHaveProperty('accessToken');
  });
});

describe('register — negative scenarios', () => {
  it('rejects an empty body with errors for name, email and password', async () => {
    const res = await register({});

    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email', 'password']));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['1 character', 'A'],
    ['only spaces', '    '],
  ])('rejects a name with %s', async (_label, name) => {
    expectFieldError(await register({ ...valid, name }), 'name', 'at least 2');
  });

  it('rejects a name longer than 100 characters', async () => {
    const res = await register({ ...valid, name: 'a'.repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('name');
  });

  it.each([
    ['no @', 'asha.example.com'],
    ['no domain', 'asha@'],
    ['spaces inside', 'asha reddy@example.com'],
    ['empty', ''],
  ])('rejects an email with %s', async (_label, email) => {
    expectFieldError(await register({ ...valid, email }), 'email', 'valid email');
  });

  it('rejects an email longer than 255 characters', async () => {
    const res = await register({ ...valid, email: `${'a'.repeat(250)}@example.com` });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('email');
  });

  it.each([
    ['7 characters', 'abcdef1', 'at least 8'],
    ['73 characters', `${'a'.repeat(72)}1`, 'at most 72'],
    ['empty', '', 'at least 8'],
  ])('rejects a password with %s (FR-1.3 boundary)', async (_label, password, message) => {
    expectFieldError(await register({ ...valid, password }), 'password', message);
  });

  it.each([
    ['letters', 'phone-number'],
    ['too short', '12345'],
    ['too long', '1'.repeat(21)],
  ])('rejects a phone with %s', async (_label, phone) => {
    expectFieldError(await register({ ...valid, phone }), 'phone', 'valid phone');
  });

  it.each([
    ['name as a number', { name: 12345 }, 'name'],
    ['email as an object', { email: { $ne: '' } }, 'email'],
    ['password as an array', { password: ['Password123'] }, 'password'],
  ])('rejects wrong data types: %s', async (_label, override, field) => {
    const res = await register({ ...valid, ...override });

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('returns 400 INVALID_JSON for a broken JSON body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"name": "Asha",');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('never echoes the password back in a validation error', async () => {
    const res = await register({ ...valid, password: 'secretonly' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secretonly');
  });
});

describe('login — positive scenarios (FR-1.5)', () => {
  it('accepts an email with different case and extra spaces', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    const res = await login({ email: '  ASHA.Reddy@EXAMPLE.com ', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'asha.reddy@example.com' },
    });
  });

  it('returns the public user without the password hash', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    const res = await login({ email: patient.email, password: PASSWORD });

    expect(res.body.user).toEqual({
      id: 7,
      name: 'Asha Reddy',
      email: 'asha.reddy@example.com',
      phone: null,
      role: 'PATIENT',
    });
    expect(JSON.stringify(res.body)).not.toContain('$2');
    expect(res.body.expiresIn).toBe('1h');
  });

  it('issues a token that the API itself accepts on /me', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);
    const { body } = await login({ email: patient.email, password: PASSWORD });

    const res = await me(`Bearer ${body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(patient.email);
  });

  it.each(['DOCTOR', 'ADMIN'])('lets a %s log in and puts the role in the token', async (role) => {
    prisma.user.findUnique.mockResolvedValue({ ...patient, role });

    const res = await login({ email: patient.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.accessToken, SECRET).role).toBe(role);
  });
});

describe('login — negative scenarios', () => {
  it.each([
    ['missing email', { password: PASSWORD }, 'email'],
    ['missing password', { email: patient.email }, 'password'],
    ['empty email', { email: '   ', password: PASSWORD }, 'email'],
    ['empty password', { email: patient.email, password: '' }, 'password'],
  ])('returns 400 for %s and does not touch the database', async (_label, body, field) => {
    const res = await login(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('is case-sensitive for the password', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    const res = await login({ email: patient.email, password: PASSWORD.toUpperCase() });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('does not trim the password (spaces are part of it)', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);

    expect((await login({ email: patient.email, password: ` ${PASSWORD} ` })).status).toBe(401);
  });

  it('rejects an object instead of a password string (no injection tricks)', async () => {
    const res = await login({ email: patient.email, password: { $ne: null } });

    expect(res.status).toBe(400);
  });

  it('does not issue a token for a disabled account even with the right password', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...patient, isActive: false });

    const res = await login({ email: patient.email, password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('rate limit also counts successful logins (5 per minute per IP)', async () => {
    prisma.user.findUnique.mockResolvedValue(patient);
    for (let i = 0; i < 5; i += 1) {
      expect((await login({ email: patient.email, password: PASSWORD })).status).toBe(200);
    }

    const sixth = await login({ email: patient.email, password: PASSWORD });

    expect(sixth.status).toBe(429);
    expect(sixth.headers).toHaveProperty('ratelimit');
  });

  it('register is NOT rate-limited by the login limiter', async () => {
    for (let i = 0; i < 6; i += 1) {
      expect((await register({ ...valid, email: `user${i}@example.com` })).status).toBe(201);
    }
  });
});

describe('/me and tokens — negative scenarios (FR-1.7)', () => {
  it.each([
    ['wrong scheme', `Token ${signAccessToken(patient)}`],
    ['Bearer without a token', 'Bearer'],
    ['Bearer with empty token', 'Bearer '],
    ['random text', 'Bearer not.a.jwt'],
    ['lowercase scheme', `bearer ${signAccessToken(patient)}`],
  ])('returns 401 UNAUTHORIZED for %s', async (_label, header) => {
    const res = await me(header);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for a tampered token (role changed to ADMIN)', async () => {
    const [header, , signature] = signAccessToken(patient).split('.');
    const fakePayload = Buffer.from(
      JSON.stringify({ sub: '7', role: 'ADMIN', exp: 9999999999 }),
    ).toString('base64url');

    const res = await me(`Bearer ${header}.${fakePayload}.${signature}`);

    expect(res.status).toBe(401);
  });

  it('returns 401 for an unsigned token (alg: none)', async () => {
    const unsigned = jwt.sign({ role: 'ADMIN' }, null, { algorithm: 'none', subject: '1' });

    expect((await me(`Bearer ${unsigned}`)).status).toBe(401);
  });

  it('returns 401 when the user in the token no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    expect((await me(`Bearer ${signAccessToken(patient)}`)).status).toBe(401);
  });

  it('returns 401 when the account was disabled after login', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...patient, isActive: false });

    expect((await me(`Bearer ${signAccessToken(patient)}`)).status).toBe(401);
  });

  it('uses the role from the database, not the token', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...patient, role: 'DOCTOR' });

    const res = await me(`Bearer ${signAccessToken(patient)}`);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('DOCTOR');
  });

  it('returns 401 for a token whose subject is not a number', async () => {
    const odd = jwt.sign({ role: 'PATIENT' }, SECRET, { subject: 'abc', algorithm: 'HS256' });

    const res = await me(`Bearer ${odd}`);

    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('token helpers (FR-1.5, FR-1.6)', () => {
  it('round-trips user id and role', () => {
    expect(verifyAccessToken(signAccessToken(patient))).toEqual({ userId: 7, role: 'PATIENT' });
  });

  it('rejects a token signed with HS512 (only HS256 allowed)', () => {
    const other = jwt.sign({ role: 'PATIENT' }, SECRET, { subject: '7', algorithm: 'HS512' });

    expect(() => verifyAccessToken(other)).toThrow();
  });
});
