// FR-7.1: email the patient when an appointment is booked, cancelled or rescheduled.
// Emails go out AFTER the change is saved and never fail or slow the API response:
// errors are logged, and the request does not wait for delivery.

import { prisma } from '../db.js';
import { clinicDateOf, clinicMinutesOf, minutesToHhmm } from '../lib/clinicTime.js';
import { sendMail } from './mailer.js';

const DETAILS = {
  doctor: {
    select: { user: { select: { name: true } }, specialization: { select: { name: true } } },
  },
  patient: { select: { name: true, email: true } },
};

const longDate = (instant) => {
  const [y, m, d] = clinicDateOf(instant).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};
const shortDate = (instant) => {
  const [y, m, d] = clinicDateOf(instant).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
};
const time = (instant) => minutesToHhmm(clinicMinutesOf(instant));
const when = (a) => `${longDate(a.startAt)} at ${time(a.startAt)} (India time)`;

function detailLines(a, timeLabel = 'Date and time:') {
  return [
    `Doctor:          ${a.doctor.user.name} (${a.doctor.specialization.name})`,
    `${timeLabel.padEnd(16)} ${when(a)}`,
    `Appointment no.: ${a.id}`,
  ];
}

const FOOTER = [
  '',
  'You can see and manage your appointments under "My appointments".',
  '',
  '— Doctor Appointments',
  '(This is an automatic message. Please do not reply.)',
];

/** Builds the email for one event. Pure function: easy to unit test. */
export function buildEmail(type, appointment, { previous, byAdmin = false } = {}) {
  const hello = `Hello ${appointment.patient.name},`;
  switch (type) {
    case 'BOOKED':
      return {
        subject: `Appointment confirmed: ${appointment.doctor.user.name}, ${shortDate(appointment.startAt)} ${time(appointment.startAt)}`,
        lines: [hello, '', 'Your appointment is booked.', '', ...detailLines(appointment)],
      };
    case 'CANCELLED':
      return {
        subject: `Appointment cancelled: ${appointment.doctor.user.name}, ${shortDate(appointment.startAt)} ${time(appointment.startAt)}`,
        lines: [
          hello,
          '',
          byAdmin
            ? 'The clinic has cancelled your appointment. We are sorry for the trouble.'
            : 'Your appointment has been cancelled as you asked.',
          '',
          ...detailLines(appointment),
          '',
          'You can book a new time from the doctor list at any time.',
        ],
      };
    case 'RESCHEDULED':
      return {
        subject: `Appointment moved: ${appointment.doctor.user.name}, ${shortDate(appointment.startAt)} ${time(appointment.startAt)}`,
        lines: [
          hello,
          '',
          'Your appointment has been moved to a new time.',
          '',
          `Old time:        ${when(previous)}`,
          ...detailLines(appointment, 'New time:'),
        ],
      };
    default:
      throw new Error(`Unknown email type: ${type}`);
  }
}

/**
 * Loads the appointment (and the previous one for a reschedule) and emails the patient.
 * Resolves even when sending fails; the failure is logged instead.
 */
export async function sendAppointmentEmail({
  type,
  appointmentId,
  previousAppointmentId,
  byAdmin,
  requestId,
}) {
  const meta = { event: `appointment.${type.toLowerCase()}`, appointmentId, requestId };
  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: DETAILS,
    });
    if (!appointment) return;
    const previous = previousAppointmentId
      ? await prisma.appointment.findUnique({ where: { id: previousAppointmentId } })
      : undefined;

    const { subject, lines } = buildEmail(type, appointment, { previous, byAdmin });
    await sendMail(
      { to: appointment.patient.email, subject, text: [...lines, ...FOOTER].join('\n') },
      meta,
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'email failed',
        ...meta,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

const inFlight = new Set();

/** Starts sending without making the HTTP response wait (fire and forget). */
export function notifyInBackground(args) {
  const task = sendAppointmentEmail(args).finally(() => inFlight.delete(task));
  inFlight.add(task);
}

/** Waits until every background email has finished (tests, graceful shutdown). */
export const flushNotifications = () => Promise.all([...inFlight]);
