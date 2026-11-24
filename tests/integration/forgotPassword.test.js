// D-37: forgot password by email — real database, MAIL_MODE=memory (nothing really sent).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import { buildResetEmail } from '../../src/auth/passwordReset.js';
import { clearSentMail, sentMail } from '../../src/notifications/mailer.js';
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

const NEW_PASSWORD = 'FreshPass2030';
const T0 = new Date('2030-01-07T08:00:00+05:30');
const MINUTE = 60_000;

let user;

const forgot = (email) => api().post('/auth/forgot-password').send({ email });
const reset = (token, newPassword = NEW_PASSWORD) =>
  api().post('/auth/reset-password').send({ token, newPassword });
const login = (email, password) => api().post('/auth/login').send({ email, password });

/** The token from the last email's link. */
function tokenFromMail() {
  const mail = sentMail().at(-1);
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  return match[1];
}

beforeEach(async () => {
  await resetDatabase();
  freezeTime(T0);
  user = await createUser({ name: 'Asha Reddy' });
  clearSentMail();
});
afterEach(() => {
  vi.restoreAllMocks();
  unfreezeTime();
});
afterAll(() => prisma.$disconnect());

describe('Forgot password — positive', () => {
  it('emails a one-time link to the account; the link sets a new password', async () => {
    const res = await forgot(user.email);

    expect(res.status).toBe(200);
    const mail = sentMail().at(-1);
    expect(mail.to).toBe(user.email);
    expect(mail.subject).toBe('Reset your Doctor Appointments password');
    expect(mail.text).toContain('Hello Asha Reddy,');
    expect(mail.text).toContain('http://localhost:4200/reset-password?token=');
    expect(mail.text).toContain('within 30 minutes');

    expect((await reset(tokenFromMail())).status).toBe(200);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('stores only a SHA-256 hash of the token, never the token itself', async () => {
    await forgot(user.email);
    const token = tokenFromMail();

    const [row] = await prisma.passwordResetToken.findMany();
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toContain(token);
    expect(row.expiresAt.getTime() - T0.getTime()).toBe(30 * MINUTE);
  });

  it('works with the email in any letter case', async () => {
    await forgot(`  ${user.email.toUpperCase()} `);

    expect(sentMail()).toHaveLength(1);
  });

  it('signs out existing sessions after the reset', async () => {
    const oldToken = tokenFor(user);
    freezeTime(new Date(T0.getTime() + MINUTE));
    await forgot(user.email);

    await reset(tokenFromMail());

    const res = await api(oldToken).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('works for doctors and admins too (their own email)', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    await forgot(admin.email);
    expect((await reset(tokenFromMail())).status).toBe(200);
    expect((await login(admin.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('log mode writes no link and no full address (NFR-6)', async () => {
    vi.stubEnv('MAIL_MODE', 'log');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await forgot(user.email);

    vi.unstubAllEnvs();
    const line = log.mock.calls.map((c) => c[0]).join('\n');
    expect(line).toContain('password.reset_requested');
    expect(line).not.toContain('token=');
    expect(line).not.toContain(user.email);
  });
});

describe('Forgot password — negative', () => {
  it('unknown email: same 200 answer, no email, nothing stored (no user enumeration)', async () => {
    const known = await forgot(user.email);
    clearSentMail();

    const unknown = await forgot('nobody@example.com');

    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(sentMail()).toEqual([]);
    expect(await prisma.passwordResetToken.count()).toBe(1); // only the known one
  });

  it('a disabled account gets no link', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    expect((await forgot(user.email)).status).toBe(200);
    expect(sentMail()).toEqual([]);
  });

  it('a link works only once', async () => {
    await forgot(user.email);
    const token = tokenFromMail();
    await reset(token);

    const again = await reset(token, 'AnotherPass2030');

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_LINK');
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a link expires after 30 minutes', async () => {
    await forgot(user.email);
    const token = tokenFromMail();
    freezeTime(new Date(T0.getTime() + 30 * MINUTE + 1000));

    const res = await reset(token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_LINK');
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  });

  it('asking again retires the older link; only the newest works', async () => {
    await forgot(user.email);
    const first = tokenFromMail();
    await forgot(user.email);
    const second = tokenFromMail();

    expect((await reset(first)).status).toBe(400);
    expect((await reset(second)).status).toBe(200);
  });

  it('a made-up token is refused', async () => {
    const res = await reset('x'.repeat(43));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_LINK');
  });

  it('using the same link twice at the same moment changes the password once', async () => {
    await forgot(user.email);
    const token = tokenFromMail();

    const results = await Promise.all([
      reset(token, 'FirstPass2030'),
      reset(token, 'SecondPass2030'),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results[0].status === 200 ? 'FirstPass2030' : 'SecondPass2030';
    const loser = winner === 'FirstPass2030' ? 'SecondPass2030' : 'FirstPass2030';
    expect((await login(user.email, winner)).status).toBe(200);
    expect((await login(user.email, loser)).status).toBe(401);
  });

  it.each([
    [{ token: 'x'.repeat(43), newPassword: 'short1' }, 'newPassword'],
    [{ token: 'x'.repeat(43), newPassword: 'NoNumbersHere' }, 'newPassword'],
    [{ token: 'short', newPassword: NEW_PASSWORD }, 'token'],
    [{}, 'token'],
  ])('invalid input %j is rejected on %s', async (body, field) => {
    const res = await api().post('/auth/reset-password').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('an invalid email in the request is a 400 (nothing sent)', async () => {
    const res = await forgot('not-an-email');

    expect(res.status).toBe(400);
    expect(sentMail()).toEqual([]);
  });
});

describe('buildResetEmail', () => {
  it('names the person, the link and the time limit; plain text only', () => {
    const { subject, text } = buildResetEmail('Asha', 'https://x/reset-password?token=abc', 30);

    expect(subject).toBe('Reset your Doctor Appointments password');
    expect(text).toContain('Hello Asha,');
    expect(text).toContain('https://x/reset-password?token=abc');
    expect(text).toContain('If you did not ask for this');
    expect(text).not.toMatch(/<[a-z]/i);
  });
});
