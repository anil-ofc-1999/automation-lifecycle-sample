// Booking and status changes (FR-4, FR-5). All writes run in a transaction that
// first takes a per-doctor lock, so checks + insert happen one booking at a time
// per doctor. The DB unique indexes (FR-4.4, FR-4.5) stay as the final safety net.

import { config } from '../config.js';
import { prisma, uniqueViolationIndex } from '../db.js';
import { AppError } from '../errors.js';
import { DAY_MS, clinicDateOf } from '../lib/clinicTime.js';
import { APPOINTMENT_INCLUDE, toAppointment } from '../lib/serializers.js';
import { BOOKABLE_DOCTOR_WHERE, clinicDayRange, isOnLeave, scheduledSlots } from './slots.js';

const HOUR_MS = 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

const SLOT_INDEX = 'appointments_doctor_slot_booked_key';
const DAILY_INDEX = 'appointments_patient_doctor_day_booked_key';

const errors = {
  notFound: () => new AppError(404, 'NOT_FOUND', 'Appointment not found.'),
  doctorNotFound: () => new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'),
  slotTaken: () => new AppError(409, 'SLOT_ALREADY_BOOKED', 'This slot is no longer available.'),
  dailyLimit: () =>
    new AppError(
      409,
      'DAILY_LIMIT_REACHED',
      'You already have a booking with this doctor on this day.',
    ),
  badTransition: (status) =>
    new AppError(
      409,
      'INVALID_STATUS_TRANSITION',
      `This appointment is ${status} and can no longer be changed.`,
    ),
};

// Clinic day number (days since 1970-01-01 in clinic time) of an instant.
const clinicDayNumber = (instant) =>
  Math.floor((instant.getTime() + config.clinicUtcOffsetMinutes * 60_000) / DAY_MS);

// Serialises booking work per doctor AND clinic day for the rest of the transaction.
// Both booking rules (one booking per slot, one per patient per doctor per day) are about
// a single day, so bookings for other days of the same doctor no longer wait (D-29).
// Several days are locked in ascending order, so two transactions can never deadlock.
// The partial unique indexes stay the final guard (FR-4.4, FR-4.5).
async function lockDoctorDays(tx, doctorId, ...instants) {
  const days = [...new Set(instants.map(clinicDayNumber))].sort((a, b) => a - b);
  for (const day of days) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${doctorId}::int, ${day}::int)`;
  }
}

function mapUniqueViolation(err) {
  const index = uniqueViolationIndex(err);
  if (index?.includes(SLOT_INDEX)) return errors.slotTaken();
  if (index?.includes(DAILY_INDEX)) return errors.dailyLimit();
  return err;
}

async function runInTransaction(work) {
  try {
    return await prisma.$transaction(work, TX_OPTIONS);
  } catch (err) {
    throw mapUniqueViolation(err);
  }
}

// FR-4.2, FR-4.3, FR-4.6, FR-4.4, FR-4.5 — returns the matching slot.
async function assertSlotBookable(tx, { doctor, patientId, startAt, now }) {
  if (startAt <= now) throw new AppError(400, 'SLOT_IN_PAST', 'This slot is in the past.');
  if (startAt.getTime() > now.getTime() + config.bookingWindowDays * DAY_MS) {
    throw new AppError(
      400,
      'BEYOND_BOOKING_WINDOW',
      `Bookings are allowed at most ${config.bookingWindowDays} days in advance.`,
    );
  }

  const date = clinicDateOf(startAt);
  if (await isOnLeave(tx, doctor.id, date)) {
    throw new AppError(400, 'DOCTOR_ON_LEAVE', 'The doctor is on leave on this date.');
  }

  const slot = (await scheduledSlots(tx, doctor, date)).find(
    (s) => s.startAt.getTime() === startAt.getTime(),
  );
  if (!slot) {
    throw new AppError(
      400,
      'OUTSIDE_SCHEDULE',
      "This time is not a slot in the doctor's schedule.",
    );
  }

  // One query for both rules (fewer round trips under load, D-29):
  // - any active booking overlapping this slot (FR-4.4)
  // - this patient's active booking with this doctor on this clinic day (FR-4.5)
  const { start, end } = clinicDayRange(date);
  const conflicts = await tx.appointment.findMany({
    where: {
      doctorId: doctor.id,
      status: 'BOOKED',
      OR: [
        { startAt: { lt: slot.endAt }, endAt: { gt: slot.startAt } },
        { patientId, startAt: { gte: start, lt: end } },
      ],
    },
    select: { patientId: true, startAt: true, endAt: true },
  });
  const overlaps = (a) => a.startAt < slot.endAt && a.endAt > slot.startAt;
  if (conflicts.some(overlaps)) throw errors.slotTaken();
  if (conflicts.some((a) => a.patientId === patientId)) throw errors.dailyLimit();

  return slot;
}

async function createBooking(tx, { doctor, patientId, slot }) {
  const appt = await tx.appointment.create({
    data: { doctorId: doctor.id, patientId, startAt: slot.startAt, endAt: slot.endAt },
  });
  // FR-5.7: audit — first entry has no old status.
  await tx.appointmentAudit.create({
    data: { appointmentId: appt.id, oldStatus: null, newStatus: 'BOOKED', changedBy: patientId },
  });
  return appt;
}

async function findBookableDoctor(tx, doctorId) {
  const doctor = await tx.doctor.findFirst({ where: { id: doctorId, ...BOOKABLE_DOCTOR_WHERE } });
  if (!doctor) throw errors.doctorNotFound();
  return doctor;
}

const withDetails = (client, id) =>
  client.appointment.findUnique({ where: { id }, include: APPOINTMENT_INCLUDE });

// FR-4.1, FR-4.7: book a slot (patient).
export async function bookAppointment({ patientId, doctorId, startAt, now = new Date() }) {
  const created = await runInTransaction(async (tx) => {
    await lockDoctorDays(tx, doctorId, startAt);
    const doctor = await findBookableDoctor(tx, doctorId);
    const slot = await assertSlotBookable(tx, { doctor, patientId, startAt, now });
    return createBooking(tx, { doctor, patientId, slot });
  });
  return toAppointment(await withDetails(prisma, created.id));
}

// Loads an appointment inside a transaction, taking the doctor/day lock(s) first:
// its own day, plus the target day of a reschedule.
async function loadForChange(tx, id, newStartAt) {
  const head = await tx.appointment.findUnique({
    where: { id },
    select: { doctorId: true, startAt: true },
  });
  if (!head) throw errors.notFound();
  await lockDoctorDays(tx, head.doctorId, head.startAt, ...(newStartAt ? [newStartAt] : []));
  return tx.appointment.findUnique({ where: { id }, include: { doctor: true } });
}

async function setStatus(tx, appt, { newStatus, changedBy, now }) {
  const data = { status: newStatus };
  if (newStatus === 'CANCELLED') {
    data.cancelledBy = changedBy;
    data.cancelledAt = now;
  }
  // Only moves from BOOKED; a parallel change makes count 0.
  const { count } = await tx.appointment.updateMany({
    where: { id: appt.id, status: 'BOOKED' },
    data,
  });
  if (count === 0) throw errors.badTransition(appt.status);
  await tx.appointmentAudit.create({
    data: { appointmentId: appt.id, oldStatus: 'BOOKED', newStatus, changedBy },
  });
}

function assertBooked(appt) {
  // FR-5.6: COMPLETED, CANCELLED, NO_SHOW are final.
  if (appt.status !== 'BOOKED') throw errors.badTransition(appt.status);
}

function assertBeforeCutoff(appt, now, action) {
  const cutoff = appt.startAt.getTime() - config.patientChangeCutoffHours * HOUR_MS;
  if (now.getTime() > cutoff) {
    throw new AppError(
      400,
      'CHANGE_WINDOW_PASSED',
      `You can ${action} only up to ${config.patientChangeCutoffHours} hours before the appointment.`,
    );
  }
}

// FR-5.1, FR-5.3, FR-5.5: cancel (patient: own + 2-hour rule; admin: any time).
export async function cancelAppointment({ id, user, now = new Date() }) {
  await runInTransaction(async (tx) => {
    const appt = await loadForChange(tx, id);
    const isAdmin = user.role === 'ADMIN';
    if (!isAdmin && appt.patientId !== user.userId) throw errors.forbidden();
    assertBooked(appt);
    if (!isAdmin) assertBeforeCutoff(appt, now, 'cancel');
    await setStatus(tx, appt, { newStatus: 'CANCELLED', changedBy: user.userId, now });
  });
  return toAppointment(await withDetails(prisma, id));
}

// FR-5.2: reschedule to another slot of the same doctor, atomically:
// the old booking is cancelled only if the new one is created (same transaction).
export async function rescheduleAppointment({ id, user, startAt, now = new Date() }) {
  const created = await runInTransaction(async (tx) => {
    const appt = await loadForChange(tx, id, startAt);
    if (appt.patientId !== user.userId) throw errors.forbidden();
    assertBooked(appt);
    assertBeforeCutoff(appt, now, 'reschedule');
    if (appt.startAt.getTime() === startAt.getTime()) {
      throw new AppError(400, 'SAME_SLOT', 'Choose a different slot.');
    }

    const doctor = await findBookableDoctor(tx, appt.doctorId);
    await setStatus(tx, appt, { newStatus: 'CANCELLED', changedBy: user.userId, now });
    const slot = await assertSlotBookable(tx, { doctor, patientId: user.userId, startAt, now });
    return createBooking(tx, { doctor, patientId: user.userId, slot });
  });
  return {
    appointment: toAppointment(await withDetails(prisma, created.id)),
    previousAppointmentId: id,
  };
}

// FR-5.4: doctor marks own appointment COMPLETED / NO_SHOW after start time.
export async function closeAppointment({ id, user, newStatus, now = new Date() }) {
  await runInTransaction(async (tx) => {
    const appt = await loadForChange(tx, id);
    if (appt.doctor.userId !== user.userId) throw errors.forbidden();
    assertBooked(appt);
    if (now < appt.startAt) {
      throw new AppError(
        400,
        'APPOINTMENT_NOT_STARTED',
        'This can be done only after the appointment start time.',
      );
    }
    await setStatus(tx, appt, { newStatus, changedBy: user.userId, now });
  });
  return toAppointment(await withDetails(prisma, id));
}
