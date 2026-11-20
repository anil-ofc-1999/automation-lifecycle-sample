// Feature: My Appointments (FR-6.1, FR-5.1 to FR-5.3, FR-5.6, FR-5.7) — positive and
// negative scenarios for the patient's list, cancel and reschedule on the real database.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time; tokens are made per call.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import {
  api,
  at,
  createDoctor,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
  utc,
} from './helpers.js';

const MON = '2030-01-07'; // today
const TUE = '2030-01-08';
const WED = '2030-01-09';
const THU = '2030-01-10';

let doctor;
let doctorUser;
let patient;
let other;
let admin;

const as = (user) => api(tokenFor(user));
const mine = async (user = patient) => (await as(user).get('/appointments/me')).body;

async function book(user, date, time, doctorId = doctor.id) {
  const res = await as(user)
    .post('/appointments')
    .send({ doctorId, startAt: at(date, time) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.appointment;
}

const cancel = (user, id) => as(user).post(`/appointments/${id}/cancel`);
const reschedule = (user, id, date, time) =>
  as(user)
    .post(`/appointments/${id}/reschedule`)
    .send({ startAt: at(date, time) });
const statusOf = async (id) => (await prisma.appointment.findUnique({ where: { id } })).status;

/** Inserts an appointment directly (for states the API cannot create "in the past"). */
async function insert(date, time, status, patientId = patient.id) {
  const startAt = new Date(at(date, time));
  return prisma.appointment.create({
    data: {
      doctorId: doctor.id,
      patientId,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60_000),
      status,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ name: 'Dr. Mine' }));
  patient = await createUser({ name: 'Priya Patient' });
  other = await createUser({ name: 'Other Patient' });
  admin = await createUser({ role: 'ADMIN' });
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('GET /appointments/me — positive scenarios', () => {
  it('a new patient has empty Upcoming and Past lists', async () => {
    expect(await mine()).toEqual({ upcoming: [], past: [] });
  });

  it('Upcoming: soonest first', async () => {
    await book(patient, THU, '10:00');
    await book(patient, TUE, '16:00');
    await book(patient, WED, '11:00');

    expect((await mine()).upcoming.map((a) => a.date)).toEqual([TUE, WED, THU]);
  });

  it('Past: newest first, with every final status', async () => {
    await insert('2030-01-02', '10:00', 'COMPLETED');
    await insert('2030-01-04', '10:00', 'NO_SHOW');
    await insert('2030-01-03', '10:00', 'CANCELLED');

    expect((await mine()).past.map((a) => [a.date, a.status])).toEqual([
      ['2030-01-04', 'NO_SHOW'],
      ['2030-01-03', 'CANCELLED'],
      ['2030-01-02', 'COMPLETED'],
    ]);
  });

  it('a cancelled future appointment is in Past, not Upcoming', async () => {
    const a = await book(patient, TUE, '10:00');
    await cancel(patient, a.id);

    const { upcoming, past } = await mine();
    expect(upcoming).toEqual([]);
    expect(past.map((p) => [p.id, p.status])).toEqual([[a.id, 'CANCELLED']]);
  });

  it('a BOOKED appointment that already started moves to Past', async () => {
    await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '10:05')));

    const { upcoming, past } = await mine();
    expect(upcoming).toEqual([]);
    expect(past[0]).toMatchObject({ status: 'BOOKED', time: '10:00' });
  });

  it('shows only my own appointments', async () => {
    await book(other, TUE, '10:00');
    await book(patient, TUE, '11:00');

    const { upcoming } = await mine();
    expect(upcoming.map((a) => a.patient.name)).toEqual(['Priya Patient']);
  });

  it('each item has date, time, doctor and specialization for the screen', async () => {
    await book(patient, TUE, '10:00');

    expect((await mine()).upcoming[0]).toMatchObject({
      date: TUE,
      time: '10:00',
      status: 'BOOKED',
      doctor: { id: doctor.id, name: 'Dr. Mine', specialization: expect.any(String) },
    });
  });
});

describe('GET /appointments/me — negative scenarios', () => {
  it('401 without a token', async () => {
    expect((await api().get('/appointments/me')).status).toBe(401);
  });

  it('403 for an admin', async () => {
    expect((await as(admin).get('/appointments/me')).status).toBe(403);
  });
});

describe('Cancel — positive scenarios (FR-5.1, FR-5.3)', () => {
  it('returns the cancelled appointment with who and when', async () => {
    const a = await book(patient, TUE, '10:00');

    const res = await cancel(patient, a.id);

    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({
      id: a.id,
      status: 'CANCELLED',
      cancelledBy: patient.id,
      cancelledAt: new Date().toISOString(),
    });
  });

  it('exactly 2 hours before the start is still allowed (boundary)', async () => {
    const a = await book(patient, MON, '10:00');
    freezeTime(new Date(at(MON, '08:00'))); // 10:00 - 2h

    expect((await cancel(patient, a.id)).status).toBe(200);
  });

  it('the slot is free again and I can book it again', async () => {
    const a = await book(patient, TUE, '10:00');
    await cancel(patient, a.id);

    const slots = await as(other).get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(slots.body.slots[0]).toMatchObject({ time: '10:00', status: 'AVAILABLE' });
    expect((await book(patient, TUE, '10:00')).status).toBe('BOOKED');
  });

  it('writes an audit entry BOOKED -> CANCELLED by me (FR-5.7)', async () => {
    const a = await book(patient, TUE, '10:00');
    await cancel(patient, a.id);

    const audit = await prisma.appointmentAudit.findMany({
      where: { appointmentId: a.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((x) => [x.oldStatus, x.newStatus, x.changedBy])).toEqual([
      [null, 'BOOKED', patient.id],
      ['BOOKED', 'CANCELLED', patient.id],
    ]);
  });
});

describe('Cancel — negative scenarios', () => {
  it('1 minute less than 2 hours before: 400 CHANGE_WINDOW_PASSED', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '08:01')));

    const res = await cancel(patient, a.id);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHANGE_WINDOW_PASSED');
    expect(await statusOf(a.id)).toBe('BOOKED');
  });

  it('after the start time: 400 CHANGE_WINDOW_PASSED', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '10:30')));

    expect((await cancel(patient, a.id)).body.error.code).toBe('CHANGE_WINDOW_PASSED');
  });

  it.each(['COMPLETED', 'NO_SHOW', 'CANCELLED'])(
    'a %s appointment cannot be cancelled (409, FR-5.6)',
    async (status) => {
      const a = await insert(THU, '10:00', status);

      const res = await cancel(patient, a.id);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    },
  );

  it("someone else's appointment: 403 and nothing changes", async () => {
    const a = await book(other, TUE, '10:00');

    expect((await cancel(patient, a.id)).status).toBe(403);
    expect(await statusOf(a.id)).toBe('BOOKED');
  });

  it('a doctor cannot cancel (403)', async () => {
    const a = await book(patient, TUE, '10:00');

    expect((await cancel(doctorUser, a.id)).status).toBe(403);
  });

  it.each([
    ['abc', 400],
    ['0', 400],
    ['99999', 404],
  ])('id %s -> %i', async (id, status) => {
    expect((await as(patient).post(`/appointments/${id}/cancel`)).status).toBe(status);
  });
});

describe('Reschedule — positive scenarios (FR-5.2)', () => {
  it('moves to another time on the same day (the daily limit does not block itself)', async () => {
    const a = await book(patient, TUE, '10:00');

    const res = await reschedule(patient, a.id, TUE, '16:00');

    expect(res.status).toBe(201);
    expect(res.body.previousAppointmentId).toBe(a.id);
    expect(res.body.appointment).toMatchObject({ status: 'BOOKED', date: TUE, time: '16:00' });
    expect(await statusOf(a.id)).toBe('CANCELLED');
  });

  it('moves to another day; Upcoming then shows only the new one', async () => {
    const a = await book(patient, TUE, '10:00');
    await reschedule(patient, a.id, THU, '11:30');

    const { upcoming, past } = await mine();
    expect(upcoming.map((x) => [x.date, x.time])).toEqual([[THU, '11:30']]);
    expect(past.map((x) => x.status)).toEqual(['CANCELLED']);
  });

  it('the old slot is free again, the new one is booked', async () => {
    const a = await book(patient, TUE, '10:00');
    await reschedule(patient, a.id, TUE, '11:00');

    const slots = (await as(other).get(`/doctors/${doctor.id}/slots?date=${TUE}`)).body.slots;
    expect(slots.find((s) => s.time === '10:00').status).toBe('AVAILABLE');
    expect(slots.find((s) => s.time === '11:00').status).toBe('BOOKED');
  });

  it('exactly 2 hours before is still allowed (boundary)', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '08:00')));

    expect((await reschedule(patient, a.id, WED, '10:00')).status).toBe(201);
  });
});

describe('Reschedule — negative scenarios (the old booking is always kept)', () => {
  async function expectKept(id) {
    expect(await statusOf(id)).toBe('BOOKED');
    expect(await prisma.appointment.count({ where: { status: 'BOOKED' } })).toBeGreaterThan(0);
  }

  it('same slot: 400 SAME_SLOT', async () => {
    const a = await book(patient, TUE, '10:00');

    const res = await reschedule(patient, a.id, TUE, '10:00');

    expect(res.body.error.code).toBe('SAME_SLOT');
    await expectKept(a.id);
  });

  it('a slot booked by someone else: 409 SLOT_ALREADY_BOOKED', async () => {
    const a = await book(patient, TUE, '10:00');
    await book(other, WED, '10:00');

    const res = await reschedule(patient, a.id, WED, '10:00');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_ALREADY_BOOKED');
    await expectKept(a.id);
  });

  it('a day where I already have this doctor: 409 DAILY_LIMIT_REACHED', async () => {
    const a = await book(patient, TUE, '10:00');
    await book(patient, WED, '10:00');

    const res = await reschedule(patient, a.id, WED, '16:00');

    expect(res.body.error.code).toBe('DAILY_LIMIT_REACHED');
    await expectKept(a.id);
  });

  it.each([
    ['more than 30 days ahead', '2030-02-10', '10:00', 'BEYOND_BOOKING_WINDOW'],
    ['in the past', '2030-01-05', '10:00', 'SLOT_IN_PAST'],
    ['outside the schedule', TUE, '14:00', 'OUTSIDE_SCHEDULE'],
  ])('%s: 400 %s', async (_label, date, time, code) => {
    const a = await book(patient, TUE, '10:00');

    const res = await reschedule(patient, a.id, date, time);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    await expectKept(a.id);
  });

  it('less than 2 hours before: 400 CHANGE_WINDOW_PASSED', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '08:30')));

    expect((await reschedule(patient, a.id, WED, '10:00')).body.error.code).toBe(
      'CHANGE_WINDOW_PASSED',
    );
    await expectKept(a.id);
  });

  it('the doctor was deactivated: 404 and the booking is kept', async () => {
    const a = await book(patient, TUE, '10:00');
    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });

    expect((await reschedule(patient, a.id, WED, '10:00')).status).toBe(404);
    await expectKept(a.id);
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('a %s appointment: 409', async (status) => {
    const a = await insert(THU, '10:00', status);

    expect((await reschedule(patient, a.id, WED, '10:00')).status).toBe(409);
  });

  it("someone else's appointment: 403", async () => {
    const a = await book(other, TUE, '10:00');

    expect((await reschedule(patient, a.id, WED, '10:00')).status).toBe(403);
    await expectKept(a.id);
  });

  it.each(['DOCTOR', 'ADMIN'])('a %s cannot reschedule (403)', async (role) => {
    const a = await book(patient, TUE, '10:00');
    const user = role === 'DOCTOR' ? doctorUser : admin;

    expect((await reschedule(user, a.id, WED, '10:00')).status).toBe(403);
  });

  it.each([
    ['empty body', {}],
    ['no time zone', { startAt: '2030-01-09T10:00:00' }],
    ['nonsense', { startAt: 'later' }],
  ])('invalid body (%s): 400', async (_label, body) => {
    const a = await book(patient, TUE, '10:00');

    const res = await as(patient).post(`/appointments/${a.id}/reschedule`).send(body);

    expect(res.status).toBe(400);
    await expectKept(a.id);
  });

  it('exactly one booking exists after a failed reschedule (no half-done state)', async () => {
    const a = await book(patient, TUE, '10:00');
    await reschedule(patient, a.id, TUE, '14:00'); // outside schedule

    expect(await prisma.appointment.count()).toBe(1);
    expect(utc(TUE, '10:00')).toBe((await prisma.appointment.findFirst()).startAt.toISOString());
  });
});
