// FR-5: cancel, reschedule, complete, no-show — against the real database.
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

const MON = '2030-01-07';
const TUE = '2030-01-08';

let doctor;
let doctorUser;
let patient;
let admin;

// Clients are created per call so tokens always match the frozen "now".
const as = (user) => api(tokenFor(user));

async function bookAs(user, startAt, doctorId = doctor.id) {
  const res = await as(user).post('/appointments').send({ doctorId, startAt });
  expect(res.status).toBe(201);
  return res.body.appointment;
}

const auditOf = (appointmentId) =>
  prisma.appointmentAudit.findMany({ where: { appointmentId }, orderBy: { id: 'asc' } });

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ slotMinutes: 30 }));
  patient = await createUser();
  admin = await createUser({ role: 'ADMIN' });
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Cancel (FR-5.1, FR-5.3, FR-5.5, FR-5.7)', () => {
  it('patient cancels own booking ≥ 2 hours before; slot is free again; audit written', async () => {
    const appt = await bookAs(patient, at(MON, '10:00')); // starts in exactly 2 hours

    const res = await as(patient).post(`/appointments/${appt.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ status: 'CANCELLED', cancelledBy: patient.id });
    expect(res.body.appointment.cancelledAt).toBe(new Date().toISOString());

    const other = await createUser();
    await bookAs(other, at(MON, '10:00'));

    const audit = await auditOf(appt.id);
    expect(audit.map((a) => [a.oldStatus, a.newStatus, a.changedBy])).toEqual([
      [null, 'BOOKED', patient.id],
      ['BOOKED', 'CANCELLED', patient.id],
    ]);
  });

  it('patient cannot cancel less than 2 hours before (400)', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '08:01')));

    const res = await as(patient).post(`/appointments/${appt.id}/cancel`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHANGE_WINDOW_PASSED');
  });

  it('admin can cancel any booking at any time, even after start', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '10:05')));

    const res = await as(admin).post(`/appointments/${appt.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ status: 'CANCELLED', cancelledBy: admin.id });
  });

  it("patient cannot cancel someone else's booking (403); doctor cannot cancel (403)", async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    const stranger = await createUser();

    expect((await as(stranger).post(`/appointments/${appt.id}/cancel`)).status).toBe(403);
    expect((await as(doctorUser).post(`/appointments/${appt.id}/cancel`)).status).toBe(403);
  });

  it('cancelling twice → 409; unknown id → 404; bad id → 400', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    await as(patient).post(`/appointments/${appt.id}/cancel`);

    const again = await as(patient).post(`/appointments/${appt.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    expect((await as(patient).post('/appointments/9999/cancel')).status).toBe(404);
    expect((await as(patient).post('/appointments/abc/cancel')).status).toBe(400);
  });
});

describe('Reschedule (FR-5.2)', () => {
  it('moves to another slot of the same doctor atomically', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));

    const res = await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '16:00') }); // same day is allowed

    expect(res.status).toBe(201);
    expect(res.body.previousAppointmentId).toBe(appt.id);
    expect(res.body.appointment).toMatchObject({ status: 'BOOKED', startAt: utc(TUE, '16:00') });

    const old = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(old.status).toBe('CANCELLED');

    // Old slot released for others.
    await bookAs(await createUser(), at(TUE, '10:00'));
  });

  it('if the new slot is taken, nothing changes (old booking kept)', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    await bookAs(await createUser(), at(TUE, '11:00'));

    const res = await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '11:00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_ALREADY_BOOKED');

    const kept = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(kept.status).toBe('BOOKED');
    expect(await auditOf(appt.id)).toHaveLength(1);
  });

  it('if the new slot is invalid (outside schedule / past / leave), nothing changes', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    const move = (startAt) =>
      as(patient).post(`/appointments/${appt.id}/reschedule`).send({ startAt });

    expect((await move(at(TUE, '14:00'))).body.error.code).toBe('OUTSIDE_SCHEDULE');
    expect((await move(at('2030-01-06', '10:00'))).body.error.code).toBe('SLOT_IN_PAST');
    expect((await move(at(TUE, '10:00'))).body.error.code).toBe('SAME_SLOT');

    const kept = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(kept.status).toBe('BOOKED');
  });

  it('respects the 2-hour rule and ownership', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    const stranger = await createUser();
    expect(
      (
        await as(stranger)
          .post(`/appointments/${appt.id}/reschedule`)
          .send({ startAt: at(TUE, '10:00') })
      ).status,
    ).toBe(403);

    freezeTime(new Date(at(MON, '08:30')));
    const late = await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '10:00') });
    expect(late.body.error.code).toBe('CHANGE_WINDOW_PASSED');
  });

  it('cannot reschedule a cancelled appointment (409)', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    await as(patient).post(`/appointments/${appt.id}/cancel`);

    const res = await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '11:00') });
    expect(res.status).toBe(409);
  });
});

describe('Complete / no-show (FR-5.4, FR-5.6)', () => {
  it('doctor marks own appointment COMPLETED only after start time', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));

    const early = await as(doctorUser).post(`/appointments/${appt.id}/complete`);
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('APPOINTMENT_NOT_STARTED');

    freezeTime(new Date(at(MON, '10:00')));
    const done = await as(doctorUser).post(`/appointments/${appt.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.appointment.status).toBe('COMPLETED');

    const audit = await auditOf(appt.id);
    expect(audit.at(-1)).toMatchObject({
      oldStatus: 'BOOKED',
      newStatus: 'COMPLETED',
      changedBy: doctorUser.id,
    });
  });

  it('doctor marks NO_SHOW after start time', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '10:45')));

    const res = await as(doctorUser).post(`/appointments/${appt.id}/no-show`);
    expect(res.body.appointment.status).toBe('NO_SHOW');
  });

  it("another doctor cannot close this doctor's appointment (403); patient cannot (403)", async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '10:30')));
    const { user: otherDoctor } = await createDoctor();

    expect((await as(otherDoctor).post(`/appointments/${appt.id}/complete`)).status).toBe(403);
    expect((await as(patient).post(`/appointments/${appt.id}/complete`)).status).toBe(403);
  });

  it('final states cannot change any more (FR-5.6)', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '10:30')));
    await as(doctorUser).post(`/appointments/${appt.id}/complete`);

    expect((await as(doctorUser).post(`/appointments/${appt.id}/no-show`)).status).toBe(409);
    expect((await as(doctorUser).post(`/appointments/${appt.id}/complete`)).status).toBe(409);
    expect((await as(admin).post(`/appointments/${appt.id}/cancel`)).status).toBe(409);

    const cancelled = await bookAs(patient, at(TUE, '10:00'));
    await as(patient).post(`/appointments/${cancelled.id}/cancel`);
    freezeTime(new Date(at(TUE, '10:30')));
    expect((await as(doctorUser).post(`/appointments/${cancelled.id}/complete`)).status).toBe(409);
  });

  it('two parallel status changes on one appointment → only one wins', async () => {
    const appt = await bookAs(patient, at(MON, '10:00'));
    freezeTime(new Date(at(MON, '10:30')));

    const [a, b] = await Promise.all([
      as(doctorUser).post(`/appointments/${appt.id}/complete`),
      as(admin).post(`/appointments/${appt.id}/cancel`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await auditOf(appt.id)).toHaveLength(2);
  });
});
