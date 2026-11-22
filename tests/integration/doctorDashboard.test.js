// Feature: Doctor dashboard (FR-6.2, FR-5.4, FR-5.6, FR-3.1 to FR-3.3, FR-3.6) — positive and
// negative scenarios on the real database. "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
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
} from './helpers.js';

const MON = '2030-01-07'; // today
const TUE = '2030-01-08';
const WED = '2030-01-09';

let doctor;
let doctorUser;
let otherDoctorUser;
let patient;
let admin;

const as = (user) => api(tokenFor(user));

async function book(user, date, time, doctorId = doctor.id) {
  const res = await as(user)
    .post('/appointments')
    .send({ doctorId, startAt: at(date, time) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.appointment;
}

const close = (user, id, action) => as(user).post(`/appointments/${id}/${action}`);

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ name: 'Dr. Dash' }));
  ({ user: otherDoctorUser } = await createDoctor({ name: 'Dr. Other' }));
  patient = await createUser({ name: 'Kavya Patient' });
  admin = await createUser({ role: 'ADMIN' });
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Doctor day view — GET /appointments/me (FR-6.2)', () => {
  it('lists the chosen day in time order with patient names and every status', async () => {
    const a = await book(patient, TUE, '16:00');
    const b = await book(await createUser({ name: 'Ravi' }), TUE, '10:00');
    await as(patient).post(`/appointments/${a.id}/cancel`);

    const res = await as(doctorUser).get(`/appointments/me?date=${TUE}`);

    expect(res.status).toBe(200);
    expect(res.body.date).toBe(TUE);
    expect(res.body.items.map((x) => [x.time, x.patient.name, x.status])).toEqual([
      ['10:00', 'Ravi', 'BOOKED'],
      ['16:00', 'Kavya Patient', 'CANCELLED'],
    ]);
    expect(b.id).toBeGreaterThan(0);
  });

  it('defaults to today (clinic time)', async () => {
    const res = await as(doctorUser).get('/appointments/me');

    expect(res.body).toEqual({ date: MON, items: [] });
  });

  it('shows only this doctor’s appointments', async () => {
    await book(patient, TUE, '10:00');
    await book(
      patient,
      WED,
      '10:00',
      (await prisma.doctor.findUnique({ where: { userId: otherDoctorUser.id } })).id,
    );

    const res = await as(otherDoctorUser).get(`/appointments/me?date=${TUE}`);

    expect(res.body.items).toEqual([]);
  });

  it('a past date works (history)', async () => {
    const res = await as(doctorUser).get('/appointments/me?date=2029-12-31');

    expect(res.status).toBe(200);
  });

  it.each(['abc', '2030-02-30', '08-01-2030'])('400 for date %j', async (date) => {
    expect((await as(doctorUser).get(`/appointments/me?date=${date}`)).status).toBe(400);
  });

  it('a DOCTOR account without a doctor profile gets 403', async () => {
    const orphan = await createUser({ role: 'DOCTOR' });

    expect((await as(orphan).get('/appointments/me')).status).toBe(403);
  });
});

describe('Complete / No-show — positive scenarios (FR-5.4)', () => {
  it('exactly at the start time the doctor can mark COMPLETED', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '10:00')));

    const res = await close(doctorUser, a.id, 'complete');

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('COMPLETED');
  });

  it('after the start the doctor can mark NO_SHOW, with an audit entry (FR-5.7)', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '10:20')));

    expect((await close(doctorUser, a.id, 'no-show')).body.appointment.status).toBe('NO_SHOW');
    const audit = await prisma.appointmentAudit.findMany({
      where: { appointmentId: a.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.at(-1)).toMatchObject({
      oldStatus: 'BOOKED',
      newStatus: 'NO_SHOW',
      changedBy: doctorUser.id,
    });
  });

  it('the patient then sees it in Past with the new status', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '11:00')));
    await close(doctorUser, a.id, 'complete');

    const mine = await as(patient).get('/appointments/me');
    expect(mine.body.past[0]).toMatchObject({ id: a.id, status: 'COMPLETED' });
  });
});

describe('Complete / No-show — negative scenarios', () => {
  it.each(['complete', 'no-show'])(
    '%s before the start: 400 APPOINTMENT_NOT_STARTED',
    async (action) => {
      const a = await book(patient, TUE, '10:00');
      freezeTime(new Date(at(TUE, '09:59')));

      const res = await close(doctorUser, a.id, action);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APPOINTMENT_NOT_STARTED');
    },
  );

  it.each(['complete', 'no-show'])(
    '%s on a cancelled appointment: 409 (FR-5.6)',
    async (action) => {
      const a = await book(patient, TUE, '10:00');
      await as(patient).post(`/appointments/${a.id}/cancel`);
      freezeTime(new Date(at(TUE, '11:00')));

      expect((await close(doctorUser, a.id, action)).status).toBe(409);
    },
  );

  it('COMPLETED cannot become NO_SHOW (FR-5.6)', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '11:00')));
    await close(doctorUser, a.id, 'complete');

    expect((await close(doctorUser, a.id, 'no-show')).body.error.code).toBe(
      'INVALID_STATUS_TRANSITION',
    );
  });

  it("another doctor's appointment: 403", async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '11:00')));

    expect((await close(otherDoctorUser, a.id, 'complete')).status).toBe(403);
  });

  it.each(['PATIENT', 'ADMIN'])('a %s cannot mark it (403)', async (role) => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '11:00')));

    expect((await close(role === 'PATIENT' ? patient : admin, a.id, 'complete')).status).toBe(403);
  });

  it.each([
    ['abc', 400],
    ['99999', 404],
  ])('id %s -> %i', async (id, status) => {
    expect((await close(doctorUser, id, 'complete')).status).toBe(status);
  });
});

describe('Weekly schedule (FR-3.1, FR-3.2, FR-3.6)', () => {
  const put = (blocks, user = doctorUser) => as(user).put('/doctors/me/schedule').send({ blocks });

  it('GET returns my schedule sorted by day and time', async () => {
    const res = await as(doctorUser).get('/doctors/me/schedule');

    expect(res.status).toBe(200);
    expect(res.body.blocks[0]).toMatchObject({
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '13:00',
    });
    expect(res.body.blocks).toHaveLength(12);
  });

  it('PUT replaces it; the new hours change the slots', async () => {
    const res = await put([{ dayOfWeek: 2, startTime: '08:00', endTime: '09:00' }]);

    expect(res.body.blocks).toEqual([
      { id: expect.any(Number), dayOfWeek: 2, startTime: '08:00', endTime: '09:00' },
    ]);
    const slots = await as(patient).get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(slots.body.slots.map((s) => s.time)).toEqual(['08:00', '08:30']);
  });

  it('PUT with no blocks clears the schedule (no slots any more)', async () => {
    await put([]);

    expect((await as(patient).get(`/doctors/${doctor.id}/slots?date=${TUE}`)).body.slots).toEqual(
      [],
    );
  });

  it('touching blocks are allowed (10–13 and 13–15)', async () => {
    const res = await put([
      { dayOfWeek: 3, startTime: '10:00', endTime: '13:00' },
      { dayOfWeek: 3, startTime: '13:00', endTime: '15:00' },
    ]);

    expect(res.status).toBe(200);
  });

  it('an existing booking survives a schedule change (FR-3.6)', async () => {
    const a = await book(patient, TUE, '10:00');
    await put([{ dayOfWeek: 4, startTime: '10:00', endTime: '11:00' }]);

    expect((await prisma.appointment.findUnique({ where: { id: a.id } })).status).toBe('BOOKED');
  });

  it.each([
    [
      'overlapping blocks',
      [
        { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '11:00', endTime: '13:00' },
      ],
      'SCHEDULE_OVERLAP',
    ],
    [
      'end before start',
      [{ dayOfWeek: 1, startTime: '12:00', endTime: '10:00' }],
      'VALIDATION_ERROR',
    ],
    [
      'end equal to start',
      [{ dayOfWeek: 1, startTime: '10:00', endTime: '10:00' }],
      'VALIDATION_ERROR',
    ],
    ['dayOfWeek 7', [{ dayOfWeek: 7, startTime: '10:00', endTime: '11:00' }], 'VALIDATION_ERROR'],
    [
      'time 9:00 (no leading zero)',
      [{ dayOfWeek: 1, startTime: '9:00', endTime: '11:00' }],
      'VALIDATION_ERROR',
    ],
    ['time 24:00', [{ dayOfWeek: 1, startTime: '10:00', endTime: '24:00' }], 'VALIDATION_ERROR'],
  ])('400 for %s', async (_label, blocks, code) => {
    const res = await put(blocks);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('400 for more than 50 blocks', async () => {
    const blocks = Array.from({ length: 51 }, (_, i) => ({
      dayOfWeek: i % 7,
      startTime: '00:00',
      endTime: '00:30',
    }));

    expect((await put(blocks)).status).toBe(400);
  });

  it('400 when "blocks" is missing', async () => {
    expect((await as(doctorUser).put('/doctors/me/schedule').send({})).status).toBe(400);
  });

  it('a failed PUT keeps the old schedule', async () => {
    await put([{ dayOfWeek: 1, startTime: '12:00', endTime: '10:00' }]);

    expect((await as(doctorUser).get('/doctors/me/schedule')).body.blocks).toHaveLength(12);
  });

  it.each(['PATIENT', 'ADMIN'])('a %s cannot read or change a schedule (403)', async (role) => {
    const user = role === 'PATIENT' ? patient : admin;

    expect((await as(user).get('/doctors/me/schedule')).status).toBe(403);
    expect((await put([], user)).status).toBe(403);
  });
});

describe('Leaves (FR-3.3)', () => {
  const addLeave = (date, user = doctorUser) => as(user).post('/doctors/me/leaves').send({ date });

  it('adds a leave day: no slots that day, and reports 0 existing bookings', async () => {
    const res = await addLeave(WED);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ leave: { date: WED }, existingBookings: 0 });
    expect((await as(patient).get(`/doctors/${doctor.id}/slots?date=${WED}`)).body.onLeave).toBe(
      true,
    );
  });

  it('today can be a leave day', async () => {
    expect((await addLeave(MON)).status).toBe(201);
  });

  it('warns about bookings that already exist on that day (they are kept)', async () => {
    const a = await book(patient, WED, '10:00');

    const res = await addLeave(WED);

    expect(res.body.existingBookings).toBe(1);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } })).status).toBe('BOOKED');
  });

  it('lists only today and future leaves, soonest first', async () => {
    await addLeave('2030-01-20');
    await addLeave(TUE);
    await prisma.doctorLeave.create({
      data: { doctorId: doctor.id, leaveDate: new Date('2030-01-01T00:00:00Z') },
    });

    const res = await as(doctorUser).get('/doctors/me/leaves');

    expect(res.body.items).toEqual([{ date: TUE }, { date: '2030-01-20' }]);
  });

  it('removing a leave day brings the slots back', async () => {
    await addLeave(WED);

    expect((await as(doctorUser).delete(`/doctors/me/leaves/${WED}`)).status).toBe(204);
    expect((await as(patient).get(`/doctors/${doctor.id}/slots?date=${WED}`)).body.onLeave).toBe(
      false,
    );
  });

  it('400 LEAVE_IN_PAST for yesterday', async () => {
    const res = await addLeave('2030-01-06');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LEAVE_IN_PAST');
  });

  it('409 LEAVE_EXISTS for the same day twice', async () => {
    await addLeave(WED);

    const res = await addLeave(WED);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LEAVE_EXISTS');
  });

  it.each(['', 'tomorrow', '2030-02-30'])('400 for date %j', async (date) => {
    expect((await addLeave(date)).status).toBe(400);
  });

  it('404 when removing a day that is not a leave day', async () => {
    expect((await as(doctorUser).delete(`/doctors/me/leaves/${WED}`)).status).toBe(404);
  });

  it('400 when removing an invalid date', async () => {
    expect((await as(doctorUser).delete('/doctors/me/leaves/abc')).status).toBe(400);
  });

  it("one doctor cannot see or remove another doctor's leave", async () => {
    await addLeave(WED);

    expect((await as(otherDoctorUser).get('/doctors/me/leaves')).body.items).toEqual([]);
    expect((await as(otherDoctorUser).delete(`/doctors/me/leaves/${WED}`)).status).toBe(404);
  });

  it.each(['PATIENT', 'ADMIN'])('a %s cannot manage leaves (403)', async (role) => {
    expect((await addLeave(WED, role === 'PATIENT' ? patient : admin)).status).toBe(403);
  });
});
