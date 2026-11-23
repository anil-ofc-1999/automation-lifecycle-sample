// FR-7: emails to the patient on booking, cancel and reschedule — real database.
// Tests run with MAIL_MODE=memory (default for NODE_ENV=test), so nothing is really sent.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import { flushNotifications } from '../../src/notifications/appointmentEmails.js';
import { sentMail } from '../../src/notifications/mailer.js';
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

const TUE = '2030-01-08';

let doctor;
let doctorUser;
let patient;
let admin;

const as = (user) => api(tokenFor(user));

async function bookAs(user, startAt) {
  const res = await as(user).post('/appointments').send({ doctorId: doctor.id, startAt });
  expect(res.status).toBe(201);
  return res.body.appointment;
}

/** Emails sent so far (waits for background sending to finish). */
async function mails() {
  await flushNotifications();
  return sentMail();
}

const saved = { ...process.env };

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ slotMinutes: 30 }));
  patient = await createUser({ name: 'Asha Reddy' });
  admin = await createUser({ role: 'ADMIN' });
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  unfreezeTime();
});
afterAll(async () => {
  await flushNotifications();
  await prisma.$disconnect();
});

describe('Emails — positive (FR-7.1)', () => {
  it('booking: the patient gets a confirmation at their own address', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));

    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(patient.email);
    expect(sent[0].subject).toContain('Appointment confirmed');
    expect(sent[0].text).toContain('Hello Asha Reddy,');
    expect(sent[0].text).toContain('Tuesday, 8 January 2030 at 10:00 (India time)');
    expect(sent[0].text).toContain(`Appointment no.: ${appt.id}`);
  });

  it('patient cancels: a cancellation email "as you asked"', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));

    await as(patient).post(`/appointments/${appt.id}/cancel`).expect(200);

    const sent = await mails();
    expect(sent.map((m) => m.subject.split(':')[0])).toEqual([
      'Appointment confirmed',
      'Appointment cancelled',
    ]);
    expect(sent[1].to).toBe(patient.email);
    expect(sent[1].text).toContain('cancelled as you asked');
  });

  it('admin cancels: the PATIENT is told the clinic cancelled it', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));

    await as(admin).post(`/appointments/${appt.id}/cancel`).expect(200);

    const last = (await mails()).at(-1);
    expect(last.to).toBe(patient.email);
    expect(last.text).toContain('The clinic has cancelled your appointment');
  });

  it('reschedule: one email with the old and the new time', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));

    const res = await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '11:30') })
      .expect(201);

    const sent = await mails();
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('Appointment moved');
    expect(sent[1].text).toContain('Old time:        Tuesday, 8 January 2030 at 10:00');
    expect(sent[1].text).toContain('New time:        Tuesday, 8 January 2030 at 11:30');
    expect(sent[1].text).toContain(`Appointment no.: ${res.body.appointment.id}`);
  });
});

describe('Emails — negative (no email when nothing changed)', () => {
  it('a rejected booking (slot taken) sends nothing to the second patient', async () => {
    await bookAs(patient, at(TUE, '10:00'));
    const other = await createUser();

    await as(other)
      .post('/appointments')
      .send({ doctorId: doctor.id, startAt: at(TUE, '10:00') })
      .expect(409);

    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(patient.email);
  });

  it('a cancel inside the 2-hour window is refused and sends nothing', async () => {
    const appt = await bookAs(patient, at('2030-01-07', '10:00'));
    freezeTime(new Date(at('2030-01-07', '08:01'))); // now 1 h 59 min before the start

    await as(patient).post(`/appointments/${appt.id}/cancel`).expect(400);

    expect((await mails()).map((m) => m.subject.split(':')[0])).toEqual(['Appointment confirmed']);
  });

  it('a failed reschedule (slot taken) sends no "moved" email', async () => {
    const appt = await bookAs(patient, at(TUE, '10:00'));
    await bookAs(await createUser(), at(TUE, '11:00'));

    await as(patient)
      .post(`/appointments/${appt.id}/reschedule`)
      .send({ startAt: at(TUE, '11:00') })
      .expect(409);

    expect((await mails()).some((m) => m.subject.includes('moved'))).toBe(false);
  });

  it('doctor marking completed / no-show sends no email', async () => {
    const a1 = await bookAs(patient, at(TUE, '10:00'));
    const other = await createUser();
    const a2 = await bookAs(other, at(TUE, '11:00'));
    freezeTime(new Date(at(TUE, '12:00')));

    await as(doctorUser).post(`/appointments/${a1.id}/complete`).expect(200);
    await as(doctorUser).post(`/appointments/${a2.id}/no-show`).expect(200);

    expect(await mails()).toHaveLength(2); // only the two booking confirmations
  });

  it('when the mail server is down the booking still succeeds; the error is logged', async () => {
    process.env.MAIL_MODE = 'smtp';
    process.env.SMTP_URL = 'smtp://127.0.0.1:1'; // nothing listens here
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const appt = await bookAs(patient, at(TUE, '10:00'));
    await flushNotifications();

    const saved = await prisma.appointment.findUnique({ where: { id: appt.id } });
    expect(saved.status).toBe('BOOKED');
    const line = JSON.parse(errorLog.mock.calls.at(-1)[0]);
    expect(line).toMatchObject({ msg: 'email failed', event: 'appointment.booked' });
    expect(JSON.stringify(line)).not.toContain(patient.email);
  });
});
