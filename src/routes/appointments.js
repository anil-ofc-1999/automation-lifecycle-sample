import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { AppError, validate } from '../errors.js';
import { DAY_MS, clinicDateOf, clinicDateTimeToUtc } from '../lib/clinicTime.js';
import { APPOINTMENT_INCLUDE, toAppointment } from '../lib/serializers.js';
import {
  dateString,
  idParam,
  idParamsSchema,
  isoDateTime,
  pageResult,
  paginate,
  paginationSchema,
} from '../lib/validation.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  bookAppointment,
  cancelAppointment,
  closeAppointment,
  rescheduleAppointment,
} from '../services/appointments.js';
import { clinicDayRange } from '../services/slots.js';

const STATUSES = ['BOOKED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

const bookSchema = z.object({ doctorId: idParam, startAt: isoDateTime });
const rescheduleSchema = z.object({ startAt: isoDateTime });
const doctorDayQuery = z.object({ date: dateString.optional() });
const adminListQuery = paginationSchema
  .extend({
    doctorId: idParam.optional(),
    status: z.enum(STATUSES).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must be on or before "to".',
    path: ['from'],
  });

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

// FR-4.1: POST /appointments — patient books a slot.
appointmentsRouter.post('/', requireRole('PATIENT'), async (req, res) => {
  const { doctorId, startAt } = validate(bookSchema, req.body);
  const appointment = await bookAppointment({ patientId: req.user.userId, doctorId, startAt });
  res.status(201).json({ appointment });
});

// FR-6.1 / FR-6.2: GET /appointments/me
appointmentsRouter.get('/me', requireRole('PATIENT', 'DOCTOR'), async (req, res) => {
  const now = new Date();

  if (req.user.role === 'PATIENT') {
    const all = await prisma.appointment.findMany({
      where: { patientId: req.user.userId },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startAt: 'desc' },
    });
    const isUpcoming = (a) => a.status === 'BOOKED' && a.startAt > now;
    // Upcoming: soonest first. Past (incl. cancelled/completed): newest first (D-23).
    const upcoming = all.filter(isUpcoming).reverse().map(toAppointment);
    const past = all.filter((a) => !isUpcoming(a)).map(toAppointment);
    return res.json({ upcoming, past });
  }

  // Doctor: own appointments for one date (default: today, clinic time).
  const { date = clinicDateOf(now) } = validate(doctorDayQuery, req.query);
  const doctor = await prisma.doctor.findUnique({ where: { userId: req.user.userId } });
  if (!doctor) throw new AppError(403, 'FORBIDDEN', 'No doctor profile for this account.');

  const { start, end } = clinicDayRange(date);
  const items = await prisma.appointment.findMany({
    where: { doctorId: doctor.id, startAt: { gte: start, lt: end } },
    include: APPOINTMENT_INCLUDE,
    orderBy: { startAt: 'asc' },
  });
  return res.json({ date, items: items.map(toAppointment) });
});

// FR-6.3: GET /appointments — admin, filters + pagination, newest first.
appointmentsRouter.get('/', requireRole('ADMIN'), async (req, res) => {
  const query = validate(adminListQuery, req.query);
  const startAt = {};
  if (query.from) startAt.gte = clinicDateTimeToUtc(query.from, 0);
  if (query.to) startAt.lt = new Date(clinicDateTimeToUtc(query.to, 0).getTime() + DAY_MS);

  const where = {
    ...(query.doctorId ? { doctorId: query.doctorId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to ? { startAt } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: APPOINTMENT_INCLUDE,
      orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
      ...paginate(query),
    }),
  ]);
  res.json(pageResult(items.map(toAppointment), total, query));
});

// FR-5.1, FR-5.5: cancel
appointmentsRouter.post('/:id/cancel', requireRole('PATIENT', 'ADMIN'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  res.json({ appointment: await cancelAppointment({ id, user: req.user }) });
});

// FR-5.2: reschedule
appointmentsRouter.post('/:id/reschedule', requireRole('PATIENT'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const { startAt } = validate(rescheduleSchema, req.body);
  res.status(201).json(await rescheduleAppointment({ id, user: req.user, startAt }));
});

// FR-5.4: complete / no-show (doctor)
appointmentsRouter.post('/:id/complete', requireRole('DOCTOR'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  res.json({
    appointment: await closeAppointment({ id, user: req.user, newStatus: 'COMPLETED' }),
  });
});

appointmentsRouter.post('/:id/no-show', requireRole('DOCTOR'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  res.json({
    appointment: await closeAppointment({ id, user: req.user, newStatus: 'NO_SHOW' }),
  });
});
