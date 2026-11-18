// FR-4: booking — against the real database.
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

const MON = '2030-01-07'; // today
const TUE = '2030-01-08';
const SUN = '2030-01-13';

let doctor;
let patient;
let patientApi;

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor } = await createDoctor({ name: 'Dr. Booking', slotMinutes: 30 }));
  patient = await createUser({ name: 'Asha Patient' });
  patientApi = api(tokenFor(patient));
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

const book = (client, startAt, doctorId = doctor.id) =>
  client.post('/appointments').send({ doctorId, startAt });

describe('Booking a slot (FR-4.1, FR-4.7)', () => {
  it('books an available slot with status BOOKED and writes an audit entry', async () => {
    const res = await book(patientApi, at(TUE, '10:00'));

    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      status: 'BOOKED',
      startAt: utc(TUE, '10:00'),
      endAt: utc(TUE, '10:30'),
      date: TUE,
      time: '10:00',
      doctor: { id: doctor.id, name: 'Dr. Booking' },
      patient: { id: patient.id, name: 'Asha Patient' },
    });

    const audit = await prisma.appointmentAudit.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ oldStatus: null, newStatus: 'BOOKED', changedBy: patient.id });
  });

  it('accepts the same instant written in UTC', async () => {
    const res = await book(patientApi, utc(TUE, '10:00'));
    expect(res.status).toBe(201);
  });

  it('only patients can book (doctor/admin get 403, no token 401)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    expect((await book(api(tokenFor(admin)), at(TUE, '10:00'))).status).toBe(403);
    expect((await book(api(), at(TUE, '10:00'))).status).toBe(401);
  });

  it('validates the body', async () => {
    expect((await patientApi.post('/appointments').send({})).status).toBe(400);
    expect((await book(patientApi, 'tomorrow 10am')).status).toBe(400);
    expect((await book(patientApi, '2030-01-08T10:00:00')).status).toBe(400); // no time zone
    expect((await book(patientApi, at(TUE, '10:00'), 'abc')).status).toBe(400);
  });
});

describe('Booking rules', () => {
  it('FR-4.1: inactive or unknown doctor → 404', async () => {
    expect((await book(patientApi, at(TUE, '10:00'), 9999)).body.error.code).toBe(
      'DOCTOR_NOT_FOUND',
    );
    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });
    expect((await book(patientApi, at(TUE, '10:00'))).status).toBe(404);
  });

  it('FR-4.2: past slots cannot be booked (also earlier today)', async () => {
    const res = await book(patientApi, at('2030-01-05', '10:00'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SLOT_IN_PAST');

    freezeTime(new Date(at(MON, '10:10')));
    const started = await book(api(tokenFor(patient)), at(MON, '10:00'));
    expect(started.body.error.code).toBe('SLOT_IN_PAST');
  });

  it('FR-4.3: at most 30 days in advance', async () => {
    // now = 2030-01-07 08:00 → limit = 2030-02-06 08:00
    expect((await book(patientApi, at('2030-02-05', '16:00'))).status).toBe(201);
    const late = await book(patientApi, at('2030-02-06', '10:00'));
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('BEYOND_BOOKING_WINDOW');
  });

  it('FR-4.6: outside schedule, off-grid times and leave days are rejected', async () => {
    expect((await book(patientApi, at(TUE, '14:00'))).body.error.code).toBe('OUTSIDE_SCHEDULE');
    expect((await book(patientApi, at(TUE, '10:15'))).body.error.code).toBe('OUTSIDE_SCHEDULE');
    expect((await book(patientApi, at(SUN, '10:00'))).body.error.code).toBe('OUTSIDE_SCHEDULE');
    expect((await book(patientApi, at(TUE, '12:30'))).status).toBe(201); // last full slot 12:30–13:00

    await prisma.doctorLeave.create({
      data: { doctorId: doctor.id, leaveDate: new Date('2030-01-09T00:00:00Z') },
    });
    const leave = await book(patientApi, at('2030-01-09', '10:00'));
    expect(leave.status).toBe(400);
    expect(leave.body.error.code).toBe('DOCTOR_ON_LEAVE');
  });

  it('FR-4.4: a booked slot cannot be booked by another patient (409)', async () => {
    expect((await book(patientApi, at(TUE, '10:00'))).status).toBe(201);
    const other = api(tokenFor(await createUser()));

    const res = await book(other, at(TUE, '10:00'));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'SLOT_ALREADY_BOOKED',
      message: 'This slot is no longer available.',
    });
  });

  it('FR-4.5: one active booking per patient per doctor per day', async () => {
    expect((await book(patientApi, at(TUE, '10:00'))).status).toBe(201);

    const sameDay = await book(patientApi, at(TUE, '16:00'));
    expect(sameDay.status).toBe(409);
    expect(sameDay.body.error.code).toBe('DAILY_LIMIT_REACHED');

    // Another day, or another doctor the same day, is fine.
    expect((await book(patientApi, at('2030-01-09', '10:00'))).status).toBe(201);
    const { doctor: other } = await createDoctor();
    expect((await book(patientApi, at(TUE, '10:00'), other.id)).status).toBe(201);
  });

  it('FR-4.5: after cancelling, the patient can book that doctor again the same day', async () => {
    const first = await book(patientApi, at(TUE, '10:00'));
    await patientApi.post(`/appointments/${first.body.appointment.id}/cancel`);
    expect((await book(patientApi, at(TUE, '16:00'))).status).toBe(201);
  });

  it('an old longer booking blocks overlapping new slots (schedule changed, FR-3.6)', async () => {
    // Booked when slots were 30 min; doctor then switches to 15-minute slots.
    expect((await book(patientApi, at(TUE, '10:00'))).status).toBe(201);
    await prisma.doctor.update({ where: { id: doctor.id }, data: { slotMinutes: 15 } });

    const other = api(tokenFor(await createUser()));
    expect((await book(other, at(TUE, '10:15'))).body.error.code).toBe('SLOT_ALREADY_BOOKED');
    expect((await book(other, at(TUE, '10:30'))).status).toBe(201);
  });
});

describe('Concurrency (FR-4.4, NFR-2)', () => {
  it('50 patients booking the same slot at once → exactly 1 success, 49 conflicts', async () => {
    const patients = await Promise.all(Array.from({ length: 50 }, () => createUser()));
    const clients = patients.map((p) => api(tokenFor(p)));

    const results = await Promise.all(clients.map((c) => book(c, at(TUE, '11:00'))));
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);

    const rows = await prisma.appointment.count({
      where: { doctorId: doctor.id, startAt: new Date(at(TUE, '11:00')), status: 'BOOKED' },
    });
    expect(rows).toBe(1);
  });

  it('the database itself rejects a duplicate active booking (last line of defence)', async () => {
    await book(patientApi, at(TUE, '10:00'));
    const other = await createUser();

    await expect(
      prisma.appointment.create({
        data: {
          doctorId: doctor.id,
          patientId: other.id,
          startAt: new Date(at(TUE, '10:00')),
          endAt: new Date(at(TUE, '10:30')),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
