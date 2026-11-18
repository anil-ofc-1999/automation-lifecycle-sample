// FR-3: schedule, leaves and slots — against the real database.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
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

const TUE = '2030-01-08';
const SUN = '2030-01-13';

let doctor;
let doctorApi;
let patient;
let patientApi;

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  const d = await createDoctor({
    slotMinutes: 30,
    blocks: [
      { dayOfWeek: 2, startTime: '10:00', endTime: '11:00' },
      { dayOfWeek: 2, startTime: '16:00', endTime: '17:15' }, // 17:00–17:15 is a partial slot
    ],
  });
  doctor = d.doctor;
  doctorApi = api(tokenFor(d.user));
  patient = await createUser();
  patientApi = api(tokenFor(patient));
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Weekly schedule (FR-3.1, FR-3.2)', () => {
  it('replaces the schedule and returns it sorted', async () => {
    const res = await doctorApi.put('/doctors/me/schedule').send({
      blocks: [
        { dayOfWeek: 3, startTime: '16:00', endTime: '19:00' },
        { dayOfWeek: 1, startTime: '09:30', endTime: '12:00' },
        { dayOfWeek: 3, startTime: '10:00', endTime: '13:00' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.blocks.map((b) => [b.dayOfWeek, b.startTime, b.endTime])).toEqual([
      [1, '09:30', '12:00'],
      [3, '10:00', '13:00'],
      [3, '16:00', '19:00'],
    ]);
    expect((await doctorApi.get('/doctors/me/schedule')).body.blocks).toHaveLength(3);
  });

  it('rejects overlapping blocks on the same day, allows touching blocks', async () => {
    const overlap = await doctorApi.put('/doctors/me/schedule').send({
      blocks: [
        { dayOfWeek: 1, startTime: '10:00', endTime: '13:00' },
        { dayOfWeek: 1, startTime: '12:00', endTime: '14:00' },
      ],
    });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.code).toBe('SCHEDULE_OVERLAP');

    const touching = await doctorApi.put('/doctors/me/schedule').send({
      blocks: [
        { dayOfWeek: 1, startTime: '10:00', endTime: '13:00' },
        { dayOfWeek: 1, startTime: '13:00', endTime: '14:00' },
        { dayOfWeek: 2, startTime: '12:00', endTime: '14:00' }, // other day: fine
      ],
    });
    expect(touching.status).toBe(200);
  });

  it.each([
    ['end before start', { dayOfWeek: 1, startTime: '13:00', endTime: '10:00' }],
    ['bad time format', { dayOfWeek: 1, startTime: '9:00', endTime: '10:00' }],
    ['day 7', { dayOfWeek: 7, startTime: '10:00', endTime: '11:00' }],
    ['24:00', { dayOfWeek: 1, startTime: '23:00', endTime: '24:00' }],
  ])('rejects %s (400)', async (_label, block) => {
    const res = await doctorApi.put('/doctors/me/schedule').send({ blocks: [block] });
    expect(res.status).toBe(400);
  });

  it('only doctors can change a schedule', async () => {
    expect((await patientApi.put('/doctors/me/schedule').send({ blocks: [] })).status).toBe(403);
  });

  it('changing the schedule keeps existing bookings (FR-3.6)', async () => {
    const booked = await patientApi
      .post('/appointments')
      .send({ doctorId: doctor.id, startAt: at(TUE, '10:00') });
    expect(booked.status).toBe(201);

    await doctorApi.put('/doctors/me/schedule').send({ blocks: [] });

    const appt = await prisma.appointment.findUnique({ where: { id: booked.body.appointment.id } });
    expect(appt.status).toBe('BOOKED');
  });
});

describe('Slots (FR-3.4, FR-3.5)', () => {
  it('generates slots, drops partial ones and marks booked ones', async () => {
    await patientApi.post('/appointments').send({ doctorId: doctor.id, startAt: at(TUE, '10:30') });

    const res = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      doctorId: doctor.id,
      date: TUE,
      slotMinutes: 30,
      onLeave: false,
    });
    expect(res.body.slots).toEqual([
      { time: '10:00', startAt: utc(TUE, '10:00'), endAt: utc(TUE, '10:30'), status: 'AVAILABLE' },
      { time: '10:30', startAt: utc(TUE, '10:30'), endAt: utc(TUE, '11:00'), status: 'BOOKED' },
      { time: '16:00', startAt: utc(TUE, '16:00'), endAt: utc(TUE, '16:30'), status: 'AVAILABLE' },
      { time: '16:30', startAt: utc(TUE, '16:30'), endAt: utc(TUE, '17:00'), status: 'AVAILABLE' },
    ]);
  });

  it('example from the requirements: 10:00–11:00, 30 min → 10:00 and 10:30', async () => {
    const res = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(res.body.slots.slice(0, 2).map((s) => s.time)).toEqual(['10:00', '10:30']);
  });

  it('returns no slots on a day without schedule', async () => {
    const res = await patientApi.get(`/doctors/${doctor.id}/slots?date=${SUN}`);
    expect(res.body.slots).toEqual([]);
  });

  it('hides slots that already started today', async () => {
    freezeTime(new Date(at(TUE, '10:15')));
    // New token: the one from beforeEach expired 26 hours "ago".
    const res = await api(tokenFor(patient)).get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(res.body.slots.map((s) => s.time)).toEqual(['10:30', '16:00', '16:30']);
  });

  it('a cancelled booking makes the slot available again (FR-5.3)', async () => {
    const b = await patientApi
      .post('/appointments')
      .send({ doctorId: doctor.id, startAt: at(TUE, '10:00') });
    await patientApi.post(`/appointments/${b.body.appointment.id}/cancel`);

    const res = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(res.body.slots[0]).toMatchObject({ time: '10:00', status: 'AVAILABLE' });
  });

  it('validates the date and the doctor', async () => {
    expect((await patientApi.get(`/doctors/${doctor.id}/slots`)).status).toBe(400);
    expect((await patientApi.get(`/doctors/${doctor.id}/slots?date=2030-02-30`)).status).toBe(400);
    expect((await patientApi.get(`/doctors/9999/slots?date=${TUE}`)).status).toBe(404);

    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });
    expect((await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`)).status).toBe(404);
  });
});

describe('Leaves (FR-3.3)', () => {
  it('no slots on a leave date; leave can be listed and removed', async () => {
    const add = await doctorApi.post('/doctors/me/leaves').send({ date: TUE });
    expect(add.status).toBe(201);
    expect(add.body).toEqual({ leave: { date: TUE }, existingBookings: 0 });

    const slots = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(slots.body).toMatchObject({ onLeave: true, slots: [] });

    expect((await doctorApi.get('/doctors/me/leaves')).body.items).toEqual([{ date: TUE }]);

    expect((await doctorApi.delete(`/doctors/me/leaves/${TUE}`)).status).toBe(204);
    expect((await doctorApi.delete(`/doctors/me/leaves/${TUE}`)).status).toBe(404);
    const again = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);
    expect(again.body.slots.length).toBeGreaterThan(0);
  });

  it('rejects duplicate (409) and past (400) leave dates', async () => {
    await doctorApi.post('/doctors/me/leaves').send({ date: TUE });
    const dup = await doctorApi.post('/doctors/me/leaves').send({ date: TUE });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LEAVE_EXISTS');

    const past = await doctorApi.post('/doctors/me/leaves').send({ date: '2030-01-06' });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('LEAVE_IN_PAST');
  });

  it('reports bookings that already exist on the leave date', async () => {
    await patientApi.post('/appointments').send({ doctorId: doctor.id, startAt: at(TUE, '10:00') });
    const res = await doctorApi.post('/doctors/me/leaves').send({ date: TUE });
    expect(res.body.existingBookings).toBe(1);
  });
});
