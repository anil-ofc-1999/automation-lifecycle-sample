// Feature: Doctor detail + slot grid (FR-3.3 to FR-3.5, FR-4.2, FR-4.3, FR-2.3) —
// positive and negative scenarios of GET /doctors/:id/slots on the real database.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import {
  api,
  at,
  createDoctor,
  createSpecialization,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const MON = '2030-01-07'; // today
const TUE = '2030-01-08';
const SUN = '2030-01-13';
const DAY_30 = '2030-02-06'; // Wednesday: now + 30 days = 2030-02-06 08:00
const DAY_29 = '2030-02-05'; // Tuesday
const DAY_31 = '2030-02-07'; // Thursday

let doctor;
let patient;
let patientApi;

const slotsOf = (date, client = patientApi, id = doctor.id) =>
  client.get(`/doctors/${id}/slots?date=${date}`);
const times = (res) => res.body.slots.map((s) => s.time);

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  // Mon–Sat 10:00–13:00 and 16:00–19:00, 30-minute slots.
  doctor = (await createDoctor({ name: 'Dr. Grid' })).doctor;
  patient = await createUser();
  patientApi = api(tokenFor(patient));
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('slot grid — positive scenarios', () => {
  it('returns a full day of 30-minute slots, all AVAILABLE', async () => {
    const res = await slotsOf(TUE);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      doctorId: doctor.id,
      date: TUE,
      slotMinutes: 30,
      onLeave: false,
    });
    expect(times(res)).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '16:00',
      '16:30',
      '17:00',
      '17:30',
      '18:00',
      '18:30',
    ]);
    expect(res.body.slots.every((s) => s.status === 'AVAILABLE')).toBe(true);
  });

  it('15-minute doctors get 15-minute slots', async () => {
    const quick = (await createDoctor({ slotMinutes: 15 })).doctor;

    const res = await slotsOf(TUE, patientApi, quick.id);

    expect(res.body.slotMinutes).toBe(15);
    expect(times(res).slice(0, 4)).toEqual(['10:00', '10:15', '10:30', '10:45']);
    expect(res.body.slots).toHaveLength(24);
  });

  it('marks a booked slot BOOKED and keeps the rest AVAILABLE', async () => {
    await patientApi.post('/appointments').send({ doctorId: doctor.id, startAt: at(TUE, '11:00') });

    const res = await slotsOf(TUE, api(tokenFor(await createUser())));

    expect(res.body.slots.find((s) => s.time === '11:00').status).toBe('BOOKED');
    expect(res.body.slots.filter((s) => s.status === 'BOOKED')).toHaveLength(1);
  });

  it('every slot has startAt / endAt in UTC that match the clinic time', async () => {
    const [first] = (await slotsOf(TUE)).body.slots;

    expect(first).toEqual({
      time: '10:00',
      startAt: '2030-01-08T04:30:00.000Z',
      endAt: '2030-01-08T05:00:00.000Z',
      status: 'AVAILABLE',
    });
  });

  it('today: only slots that have not started yet', async () => {
    freezeTime(new Date(at(MON, '12:10')));

    const res = await slotsOf(MON, api(tokenFor(patient)));

    expect(times(res)).toEqual(['12:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30']);
  });

  it('day 29 is fully bookable', async () => {
    expect((await slotsOf(DAY_29)).body.slots).toHaveLength(12);
  });

  it('day 30: only slots up to exactly 30 days from now (FR-4.3)', async () => {
    freezeTime(new Date(at(MON, '12:00')));

    const res = await slotsOf(DAY_30, api(tokenFor(patient)));

    // now + 30 days = 2030-02-06 12:00 → 12:00 is the last bookable slot
    expect(times(res)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  it('a slot returned on day 30 can really be booked (grid and booking agree)', async () => {
    freezeTime(new Date(at(MON, '12:00')));
    const client = api(tokenFor(patient));
    const last = (await slotsOf(DAY_30, client)).body.slots.at(-1);

    const res = await client
      .post('/appointments')
      .send({ doctorId: doctor.id, startAt: last.startAt });

    expect(res.status).toBe(201);
  });

  it('a DOCTOR or ADMIN user can view slots too', async () => {
    const admin = await createUser({ role: 'ADMIN' });

    expect((await slotsOf(TUE, api(tokenFor(admin)))).status).toBe(200);
  });
});

describe('slot grid — "no slots" scenarios', () => {
  it('a day without schedule (Sunday) has no slots', async () => {
    const res = await slotsOf(SUN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ onLeave: false, slots: [] });
  });

  it('a leave day says onLeave: true and has no slots (FR-3.3)', async () => {
    await prisma.doctorLeave.create({
      data: { doctorId: doctor.id, leaveDate: new Date(`${TUE}T00:00:00Z`) },
    });

    expect((await slotsOf(TUE)).body).toMatchObject({ onLeave: true, slots: [] });
  });

  it('a past date has no slots (FR-4.2)', async () => {
    expect((await slotsOf('2030-01-05')).body.slots).toEqual([]);
  });

  it('today after the last slot has started: no slots left', async () => {
    freezeTime(new Date(at(MON, '18:31')));

    expect((await slotsOf(MON, api(tokenFor(patient)))).body.slots).toEqual([]);
  });

  it('more than 30 days ahead has no slots (FR-4.3)', async () => {
    expect((await slotsOf(DAY_31)).body.slots).toEqual([]);
  });

  it('a doctor without any schedule has no slots on any day', async () => {
    const free = (await createDoctor({ blocks: [] })).doctor;

    expect((await slotsOf(TUE, patientApi, free.id)).body.slots).toEqual([]);
  });
});

describe('slot grid — negative scenarios', () => {
  it.each([
    ['missing date', ''],
    ['wrong format', '?date=08-01-2030'],
    ['impossible date', '?date=2030-02-30'],
    ['text', '?date=tomorrow'],
  ])('400 for %s', async (_label, query) => {
    const res = await patientApi.get(`/doctors/${doctor.id}/slots${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['abc', '0', '-1'])('400 for doctor id %j', async (id) => {
    expect((await patientApi.get(`/doctors/${id}/slots?date=${TUE}`)).status).toBe(400);
  });

  it('404 for an unknown doctor', async () => {
    const res = await slotsOf(TUE, patientApi, 99999);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCTOR_NOT_FOUND');
  });

  it('404 for an inactive doctor (FR-2.3)', async () => {
    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });

    expect((await slotsOf(TUE)).status).toBe(404);
  });

  it('404 for a doctor whose account is disabled', async () => {
    await prisma.user.updateMany({ where: { name: 'Dr. Grid' }, data: { isActive: false } });

    expect((await slotsOf(TUE)).status).toBe(404);
  });

  it('404 for a doctor whose specialization is inactive', async () => {
    const off = await createSpecialization({ isActive: false });
    const hidden = (await createDoctor({ specialization: off })).doctor;

    expect((await slotsOf(TUE, patientApi, hidden.id)).status).toBe(404);
  });

  it('401 without a token', async () => {
    expect((await slotsOf(TUE, api())).status).toBe(401);
  });

  it('a cancelled booking does not block the slot', async () => {
    const booked = await patientApi
      .post('/appointments')
      .send({ doctorId: doctor.id, startAt: at(TUE, '10:00') });
    await patientApi.post(`/appointments/${booked.body.appointment.id}/cancel`);

    expect((await slotsOf(TUE)).body.slots[0].status).toBe('AVAILABLE');
  });
});
