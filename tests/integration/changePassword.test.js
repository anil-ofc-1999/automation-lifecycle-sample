// D-32: a logged-in user changes their own password — real database.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

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

const NEW_PASSWORD = 'BetterPass2030';
const T0 = new Date('2030-01-07T08:00:00+05:30');
const LATER = new Date(T0.getTime() + 60_000);

let user;

const login = (email, password) => api().post('/auth/login').send({ email, password });
const change = (token, body) => api(token).post('/auth/change-password').send(body);

beforeEach(async () => {
  await resetDatabase();
  freezeTime(T0);
  user = await createUser({ name: 'Asha Reddy' });
});
afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Change password — positive', () => {
  it('changes the password: old one stops working, new one logs in', async () => {
    const res = await change(tokenFor(user), {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('stores only a bcrypt hash and records when it changed', async () => {
    await change(tokenFor(user), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    const saved = await prisma.user.findUnique({ where: { id: user.id } });
    expect(saved.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(saved.passwordHash).not.toContain(NEW_PASSWORD);
    expect(saved.passwordChangedAt.toISOString()).toBe(T0.toISOString());
  });

  it('signs out older sessions; the returned token keeps this session working', async () => {
    const oldToken = tokenFor(user); // logged in at T0 (e.g. on another device)
    freezeTime(LATER);

    const res = await change(tokenFor(user), {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const old = await api(oldToken).get('/me');
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('TOKEN_EXPIRED');
    expect((await api(res.body.accessToken).get('/me')).status).toBe(200);
    // A later login with the new password works normally.
    freezeTime(new Date(LATER.getTime() + 5_000));
    const relogin = await login(user.email, NEW_PASSWORD);
    expect((await api(relogin.body.accessToken).get('/me')).status).toBe(200);
  });

  it.each(['DOCTOR', 'ADMIN'])('works for a %s account too', async (role) => {
    const staff = await createUser({ role });

    const res = await change(tokenFor(staff), {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe(role);
    expect((await login(staff.email, NEW_PASSWORD)).status).toBe(200);
  });
});

describe('Change password — negative', () => {
  it('needs a login (401) and changes nothing', async () => {
    const res = await change(undefined, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  });

  it('wrong current password: 400 WRONG_PASSWORD on that field; nothing changes', async () => {
    const res = await change(tokenFor(user), {
      currentPassword: 'NotMyPassword1',
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WRONG_PASSWORD');
    expect(res.body.error.details).toEqual([
      { field: 'currentPassword', message: 'Current password is incorrect.' },
    ]);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).passwordChangedAt).toBeNull();
  });

  it.each([
    ['too short', 'abc12', 'at least 8 characters'],
    ['no number', 'OnlyLetters', 'at least one number'],
    ['no letter', '12345678', 'at least one letter'],
    ['too long', `${'a'.repeat(72)}1`, 'at most 72 characters'],
  ])('weak new password (%s) is rejected (FR-1.3)', async (_case, newPassword, message) => {
    const res = await change(tokenFor(user), { currentPassword: PASSWORD, newPassword });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0]).toMatchObject({ field: 'newPassword' });
    expect(res.body.error.details[0].message).toContain(message);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  });

  it('the new password must differ from the current one', async () => {
    const res = await change(tokenFor(user), { currentPassword: PASSWORD, newPassword: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'newPassword', message: 'The new password must be different from the current one.' },
    ]);
  });

  it('missing fields: 400 for both', async () => {
    const res = await change(tokenFor(user), {});

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual([
      'currentPassword',
      'newPassword',
    ]);
  });

  it('a disabled account cannot change its password', async () => {
    const token = tokenFor(user);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    expect(
      (await change(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status,
    ).toBe(401);
  });
});
