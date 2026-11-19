// Feature: Booking confirmation (FR-4.1 to FR-4.7) — extra positive and negative
// scenarios of POST /appointments on the real database (see also booking.test.js).
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
  utc,
} from './helpers.js';

const TUE = '2030-01-08';
const WED = '2030-01-09';

let doctor;
let doctorUser;
let patient;
let patientApi;

const book = (client, body) => client.post('/appointments').send(body);
const slot = (time, date = TUE, doctorId = doctor.id) => ({ doctorId, startAt: at(date, time) });

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ name: 'Dr. Confirm' }));
  patient = await createUser({ name: 'Ravi Patient' });
  patientApi = api(tokenFor(patient));
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('POST /appointments — positive scenarios', () => {
  it('returns everything the confirmation screen shows', async () => {
    const res = await book(patientApi, slot('11:30'));

    expect(res.status).toBe(201);
    expect(res.body.appointment).toEqual({
      id: expect.any(Number),
      status: 'BOOKED',
      startAt: utc(TUE, '11:30'),
      endAt: utc(TUE, '12:00'),
      date: TUE,
      time: '11:30',
      doctor: { id: doctor.id, name: 'Dr. Confirm', specialization: expect.any(String) },
      patient: { id: patient.id, name: 'Ravi Patient' },
      cancelledBy: null,
      cancelledAt: null,
      createdAt: expect.any(String),
    });
  });

  it('never returns personal data like the patient email', async () => {
    const res = await book(patientApi, slot('10:00'));

    expect(JSON.stringify(res.body)).not.toContain('@example.com');
  });

  it('the booked slot then shows as BOOKED in the slot grid', async () => {
    await book(patientApi, slot('10:00'));

    const slots = await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`);

    expect(slots.body.slots[0]).toMatchObject({ time: '10:00', status: 'BOOKED' });
  });

  it('accepts the startAt exactly as the slots API returns it (UTC "Z")', async () => {
    const [first] = (await patientApi.get(`/doctors/${doctor.id}/slots?date=${TUE}`)).body.slots;

    expect((await book(patientApi, { doctorId: doctor.id, startAt: first.startAt })).status).toBe(
      201,
    );
  });

  it('accepts doctorId sent as a numeric string', async () => {
    const res = await book(patientApi, { doctorId: String(doctor.id), startAt: at(TUE, '10:00') });

    expect(res.status).toBe(201);
  });

  it('a 15-minute doctor can be booked at :15 and :45', async () => {
    const quick = (await createDoctor({ slotMinutes: 15 })).doctor;

    expect((await book(patientApi, slot('10:15', TUE, quick.id))).status).toBe(201);
    expect(
      (await book(api(tokenFor(await createUser())), slot('10:45', TUE, quick.id))).status,
    ).toBe(201);
  });

  it('the same patient can book the same doctor on another day (FR-4.5)', async () => {
    expect((await book(patientApi, slot('10:00', TUE))).status).toBe(201);
    expect((await book(patientApi, slot('10:00', WED))).status).toBe(201);
  });

  it('the same patient can book two different doctors on the same day', async () => {
    const other = (await createDoctor()).doctor;

    expect((await book(patientApi, slot('10:00'))).status).toBe(201);
    expect((await book(patientApi, slot('11:00', TUE, other.id))).status).toBe(201);
  });

  it('ignores status / patientId sent by the client (always BOOKED, always me)', async () => {
    const someoneElse = await createUser();

    const res = await book(patientApi, {
      ...slot('10:00'),
      status: 'COMPLETED',
      patientId: someoneElse.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('BOOKED');
    expect(res.body.appointment.patient.id).toBe(patient.id);
  });

  it('records who booked it in the audit log (FR-5.7)', async () => {
    const res = await book(patientApi, slot('10:00'));

    const audit = await prisma.appointmentAudit.findMany({
      where: { appointmentId: res.body.appointment.id },
    });
    expect(audit).toEqual([
      expect.objectContaining({ oldStatus: null, newStatus: 'BOOKED', changedBy: patient.id }),
    ]);
  });
});

describe('POST /appointments — negative scenarios', () => {
  it('the same patient booking the same slot twice gets 409 the second time', async () => {
    expect((await book(patientApi, slot('10:00'))).status).toBe(201);

    const again = await book(patientApi, slot('10:00'));

    expect(again.status).toBe(409);
    expect(['SLOT_ALREADY_BOOKED', 'DAILY_LIMIT_REACHED']).toContain(again.body.error.code);
  });

  it('a second slot with the same doctor the same day: 409 DAILY_LIMIT_REACHED (FR-4.5)', async () => {
    await book(patientApi, slot('10:00'));

    const res = await book(patientApi, slot('16:00'));

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'DAILY_LIMIT_REACHED',
      message: 'You already have a booking with this doctor on this day.',
    });
  });

  it('a slot taken by someone else: 409 SLOT_ALREADY_BOOKED with a clear message', async () => {
    await book(api(tokenFor(await createUser())), slot('10:00'));

    const res = await book(patientApi, slot('10:00'));

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'SLOT_ALREADY_BOOKED',
      message: 'This slot is no longer available.',
    });
  });

  it('a DOCTOR cannot book (403), not even with themself', async () => {
    const res = await book(api(tokenFor(doctorUser)), slot('10:00'));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a disabled patient account cannot book (401)', async () => {
    await prisma.user.update({ where: { id: patient.id }, data: { isActive: false } });

    expect((await book(patientApi, slot('10:00'))).status).toBe(401);
  });

  it('a doctor whose account is disabled cannot be booked (404)', async () => {
    await prisma.user.update({ where: { id: doctorUser.id }, data: { isActive: false } });

    const res = await book(patientApi, slot('10:00'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCTOR_NOT_FOUND');
  });

  it('a doctor of an inactive specialization cannot be booked (404)', async () => {
    const hidden = (
      await createDoctor({ specialization: await createSpecialization({ isActive: false }) })
    ).doctor;

    expect((await book(patientApi, slot('10:00', TUE, hidden.id))).status).toBe(404);
  });

  it.each([
    ['empty body', {}],
    ['missing startAt', { doctorId: 1 }],
    ['missing doctorId', { startAt: '2030-01-08T10:00:00+05:30' }],
    ['doctorId null', { doctorId: null, startAt: '2030-01-08T10:00:00+05:30' }],
    ['doctorId 0', { doctorId: 0, startAt: '2030-01-08T10:00:00+05:30' }],
    ['doctorId -1', { doctorId: -1, startAt: '2030-01-08T10:00:00+05:30' }],
    ['startAt as a number', { doctorId: 1, startAt: 1894083000000 }],
    ['startAt only a date', { doctorId: 1, startAt: '2030-01-08' }],
    ['startAt without time zone', { doctorId: 1, startAt: '2030-01-08T10:00:00' }],
    ['startAt nonsense', { doctorId: 1, startAt: 'next tuesday' }],
  ])('400 VALIDATION_ERROR for %s', async (_label, body) => {
    const res = await book(patientApi, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a time between two slots is rejected (OUTSIDE_SCHEDULE)', async () => {
    const res = await book(patientApi, slot('10:10'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OUTSIDE_SCHEDULE');
  });

  it('nothing is saved when booking fails', async () => {
    await book(patientApi, slot('14:00')); // outside schedule
    await book(patientApi, slot('10:00', '2030-01-01')); // past

    expect(await prisma.appointment.count()).toBe(0);
    expect(await prisma.appointmentAudit.count()).toBe(0);
  });
});
