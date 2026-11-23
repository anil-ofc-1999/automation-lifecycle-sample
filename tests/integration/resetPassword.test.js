// D-35: admin resets a doctor's / patient's password — real database.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import {
  PASSWORD,
  api,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const NEW_PASSWORD = 'TempPass2030x';
const T0 = new Date('2030-01-07T08:00:00+05:30');

let admin;
let adminApi;

const login = (email, password) => api().post('/auth/login').send({ email, password });
const reset = (client, body) => client.post('/users/reset-password').send(body);

beforeEach(async () => {
  await resetDatabase();
  freezeTime(T0);
  admin = await createUser({ role: 'ADMIN' });
  adminApi = api(tokenFor(admin));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unfreezeTime();
});
afterAll(() => prisma.$disconnect());

describe('Admin reset password — positive', () => {
  it.each(['PATIENT', 'DOCTOR'])(
    'resets a %s: new password works, old one does not',
    async (role) => {
      const user = await createUser({ role });

      const res = await reset(adminApi, { email: user.email, newPassword: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: user.id, role });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect((await login(user.email, PASSWORD)).status).toBe(401);
      expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    },
  );

  it('finds the account ignoring case and spaces in the email', async () => {
    const user = await createUser();

    const res = await reset(adminApi, {
      email: `  ${user.email.toUpperCase()} `,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
  });

  it('signs out the existing sessions of that user', async () => {
    const user = await createUser();
    const oldToken = tokenFor(user);
    freezeTime(new Date(T0.getTime() + 60_000));

    await reset(adminApi, { email: user.email, newPassword: NEW_PASSWORD });

    const res = await api(oldToken).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('writes an audit log line with ids but never the password or email', async () => {
    const user = await createUser();

    await reset(adminApi, { email: user.email, newPassword: NEW_PASSWORD });

    const line = console.log.mock.calls
      .map((c) => c[0])
      .find((l) => typeof l === 'string' && l.includes('password reset'));
    expect(JSON.parse(line)).toMatchObject({ adminId: admin.id, userId: user.id });
    expect(line).not.toContain(NEW_PASSWORD);
    expect(line).not.toContain(user.email);
  });
});

describe('Admin reset password — negative', () => {
  it.each(['PATIENT', 'DOCTOR'])('a %s cannot use it (403) and nothing changes', async (role) => {
    const caller = await createUser({ role });
    const victim = await createUser();

    const res = await reset(api(tokenFor(caller)), {
      email: victim.email,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(403);
    expect((await login(victim.email, PASSWORD)).status).toBe(200);
  });

  it('needs a login (401)', async () => {
    const res = await reset(api(), { email: 'x@example.com', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('another admin account is refused (403)', async () => {
    const otherAdmin = await createUser({ role: 'ADMIN' });

    const res = await reset(adminApi, { email: otherAdmin.email, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Change password');
    expect((await login(otherAdmin.email, PASSWORD)).status).toBe(200);
  });

  it('the admin cannot reset their own account here either (use Change password)', async () => {
    const res = await reset(adminApi, { email: admin.email, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('unknown email: 404 USER_NOT_FOUND', async () => {
    const res = await reset(adminApi, { email: 'nobody@example.com', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it.each([
    [{ email: 'not-an-email', newPassword: NEW_PASSWORD }, 'email'],
    [{ email: 'a@example.com', newPassword: 'short1' }, 'newPassword'],
    [{ email: 'a@example.com', newPassword: 'NoNumbersHere' }, 'newPassword'],
    [{}, 'email'],
  ])('invalid input %j is rejected on %s', async (body, field) => {
    const res = await reset(adminApi, body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });
});
