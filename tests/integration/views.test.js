// FR-6 views and FR-1 auth — against the real database.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import {
  PASSWORD,
  api,
  at,
  createDoctor,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const MON = '2030-01-07';
const TUE = '2030-01-08';
const WED = '2030-01-09';

const as = (user) => api(tokenFor(user));

async function bookAs(user, doctorId, startAt) {
  const res = await as(user).post('/appointments').send({ doctorId, startAt });
  expect(res.status).toBe(201);
  return res.body.appointment;
}

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Patient: own appointments (FR-6.1)', () => {
  it('splits into upcoming (soonest first) and past (newest first)', async () => {
    const { doctor: d1 } = await createDoctor({ name: 'Dr. One' });
    const { doctor: d2 } = await createDoctor({ name: 'Dr. Two' });
    const patient = await createUser();
    const other = await createUser();

    const monAppt = await bookAs(patient, d1.id, at(MON, '10:00'));
    const wed = await bookAs(patient, d1.id, at(WED, '10:00'));
    const tue = await bookAs(patient, d2.id, at(TUE, '10:00'));
    const cancelled = await bookAs(patient, d2.id, at(WED, '16:00'));
    await as(patient).post(`/appointments/${cancelled.id}/cancel`);
    await bookAs(other, d1.id, at(TUE, '11:00')); // someone else's — must not appear

    // Move time past Monday's appointment.
    freezeTime(new Date(at(MON, '12:00')));
    const res = await as(patient).get('/appointments/me');

    expect(res.status).toBe(200);
    expect(res.body.upcoming.map((a) => a.id)).toEqual([tue.id, wed.id]);
    expect(res.body.past.map((a) => a.id)).toEqual([cancelled.id, monAppt.id]);
    expect(res.body.upcoming[0]).toMatchObject({
      doctor: { name: 'Dr. Two' },
      date: TUE,
      time: '10:00',
    });
  });
});

describe('Doctor: own appointments for a date (FR-6.2)', () => {
  it('lists the day with patient names and statuses, in time order', async () => {
    const { doctor, user: doctorUser } = await createDoctor();
    const { doctor: otherDoctor } = await createDoctor();
    const asha = await createUser({ name: 'Asha' });
    const ravi = await createUser({ name: 'Ravi' });

    await bookAs(ravi, doctor.id, at(TUE, '16:00'));
    const first = await bookAs(asha, doctor.id, at(TUE, '10:00'));
    await as(asha).post(`/appointments/${first.id}/cancel`);
    await bookAs(asha, otherDoctor.id, at(TUE, '10:00')); // other doctor
    await bookAs(asha, doctor.id, at(WED, '10:00')); // other date

    const res = await as(doctorUser).get(`/appointments/me?date=${TUE}`);
    expect(res.body.date).toBe(TUE);
    expect(res.body.items.map((a) => [a.time, a.patient.name, a.status])).toEqual([
      ['10:00', 'Asha', 'CANCELLED'],
      ['16:00', 'Ravi', 'BOOKED'],
    ]);
  });

  it('defaults to today and validates the date', async () => {
    const { doctor, user: doctorUser } = await createDoctor();
    await bookAs(await createUser(), doctor.id, at(MON, '10:00'));

    const today = await as(doctorUser).get('/appointments/me');
    expect(today.body.date).toBe(MON);
    expect(today.body.items).toHaveLength(1);

    expect((await as(doctorUser).get('/appointments/me?date=bad')).status).toBe(400);
  });

  it('admin cannot use /appointments/me (403)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    expect((await as(admin).get('/appointments/me')).status).toBe(403);
  });
});

describe('Admin: all appointments (FR-6.3)', () => {
  it('filters by doctor, status and date range, paginated, newest first', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const { doctor: d1 } = await createDoctor();
    const { doctor: d2 } = await createDoctor();
    const p1 = await createUser();
    const p2 = await createUser();

    const a = await bookAs(p1, d1.id, at(MON, '10:00'));
    const b = await bookAs(p1, d1.id, at(TUE, '10:00'));
    const c = await bookAs(p2, d1.id, at(WED, '10:00'));
    const d = await bookAs(p2, d2.id, at(TUE, '10:00'));
    await as(p2).post(`/appointments/${c.id}/cancel`);

    const all = await as(admin).get('/appointments');
    expect(all.body).toMatchObject({ total: 4, page: 1, pageSize: 10, totalPages: 1 });
    expect(all.body.items.map((x) => x.id)).toEqual([c.id, d.id, b.id, a.id]);

    const byDoctor = await as(admin).get(`/appointments?doctorId=${d1.id}`);
    expect(byDoctor.body.total).toBe(3);

    const byStatus = await as(admin).get('/appointments?status=CANCELLED');
    expect(byStatus.body.items.map((x) => x.id)).toEqual([c.id]);

    const tueOnly = await as(admin).get(`/appointments?from=${TUE}&to=${TUE}`);
    expect(tueOnly.body.items.map((x) => x.id).sort()).toEqual([b.id, d.id].sort());

    const page2 = await as(admin).get('/appointments?pageSize=3&page=2');
    expect(page2.body.items.map((x) => x.id)).toEqual([a.id]);
  });

  it('validates filters and blocks non-admins', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    expect((await as(admin).get('/appointments?status=DONE')).status).toBe(400);
    expect((await as(admin).get(`/appointments?from=${WED}&to=${TUE}`)).status).toBe(400);
    expect((await as(await createUser()).get('/appointments')).status).toBe(403);
  });
});

describe('Auth against the real database (FR-1)', () => {
  it('register → login → /me, email case-insensitive', async () => {
    const reg = await api()
      .post('/auth/register')
      .send({ name: 'Real Db User', email: 'Real.User@Example.com', password: PASSWORD });
    expect(reg.status).toBe(201);

    const dup = await api()
      .post('/auth/register')
      .send({ name: 'Again', email: 'REAL.USER@example.com', password: PASSWORD });
    expect(dup.status).toBe(409);

    const login = await api()
      .post('/auth/login')
      .send({ email: 'real.user@EXAMPLE.com', password: PASSWORD });
    expect(login.status).toBe(200);

    const me = await api(login.body.accessToken).get('/me');
    expect(me.body.user).toMatchObject({ email: 'real.user@example.com', role: 'PATIENT' });
  });

  it('a deactivated account is locked out immediately, even with a valid token', async () => {
    const user = await createUser();
    const client = as(user);
    expect((await client.get('/me')).status).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await client.get('/me')).status).toBe(401);
    expect(
      (await client.post('/appointments').send({ doctorId: 1, startAt: at(TUE, '10:00') })).status,
    ).toBe(401);
  });

  it('a role change takes effect immediately (role is read from the database)', async () => {
    const user = await createUser({ role: 'ADMIN' });
    const client = as(user);
    expect((await client.get('/appointments')).status).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { role: 'PATIENT' } });
    expect((await client.get('/appointments')).status).toBe(403);
  });
});

describe('Errors and health', () => {
  it('unknown route → 404, request id header is returned', async () => {
    const res = await api().get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('/health reports the database as up', async () => {
    const { app } = api();
    const request = (await import('supertest')).default;
    const res = await request(app).get('/health');
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });
});
