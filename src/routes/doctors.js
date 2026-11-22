import { Router } from 'express';
import { z } from 'zod';

import { emailField, nameField, passwordField } from '../auth/fields.js';
import { hashPassword } from '../auth/password.js';
import { prisma, uniqueViolationIndex } from '../db.js';
import { AppError, validate } from '../errors.js';
import {
  clinicDateOf,
  dateColumnToString,
  dateStringToDateColumn,
  hhmmToMinutes,
  isValidTimeString,
  minutesToHhmm,
  minutesToTimeColumn,
  timeColumnToMinutes,
} from '../lib/clinicTime.js';
import { DOCTOR_INCLUDE, toDoctor } from '../lib/serializers.js';
import {
  dateString,
  idParam,
  idParamsSchema,
  pageResult,
  paginate,
  paginationSchema,
  queryBoolean,
} from '../lib/validation.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { BOOKABLE_DOCTOR_WHERE, clinicDayRange, slotsForDate } from '../services/slots.js';

// ---------- validation ----------

const feeField = z
  .number({ error: 'Fee must be a number.' })
  .min(0, 'Fee cannot be negative.')
  .max(99999999.99)
  .refine((v) => Math.round(v * 100) === v * 100, 'Fee can have at most 2 decimals.');

// FR-2.2: slot duration 15 or 30 minutes
const slotMinutesField = z.union([z.literal(15), z.literal(30)], {
  error: 'Slot duration must be 15 or 30 minutes.',
});

const bioField = z.string().trim().max(2000);

const createDoctorSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  specializationId: idParam,
  fee: feeField,
  slotMinutes: slotMinutesField,
  bio: bioField.optional(),
});

const updateDoctorSchema = z
  .object({
    name: nameField.optional(),
    specializationId: idParam.optional(),
    fee: feeField.optional(),
    slotMinutes: slotMinutesField.optional(),
    bio: bioField.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const listQuerySchema = paginationSchema.extend({
  specializationId: idParam.optional(),
  search: z.string().trim().max(100).optional(),
  includeInactive: queryBoolean,
});

const timeField = z.string().refine(isValidTimeString, 'Use HH:MM (24-hour), e.g. 09:30.');

const scheduleSchema = z.object({
  blocks: z
    .array(
      z
        .object({
          dayOfWeek: z.number().int().min(0).max(6, 'dayOfWeek is 0 (Sunday) to 6 (Saturday).'),
          startTime: timeField,
          endTime: timeField,
        })
        .refine(
          // Only compare when both times are valid (otherwise the field errors are enough).
          (b) =>
            !isValidTimeString(b.startTime) ||
            !isValidTimeString(b.endTime) ||
            hhmmToMinutes(b.endTime) > hhmmToMinutes(b.startTime),
          {
            message: 'endTime must be after startTime.',
            path: ['endTime'],
          },
        ),
    )
    .max(50, 'At most 50 schedule blocks.'),
});

const leaveSchema = z.object({ date: dateString });
const slotsQuerySchema = z.object({ date: dateString });
const leaveParamsSchema = z.object({ date: dateString });

// ---------- helpers ----------

const doctorNotFound = () => new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
const emailTaken = () =>
  new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');

async function assertActiveSpecialization(id) {
  const spec = await prisma.specialization.findUnique({ where: { id } });
  if (!spec || !spec.isActive) {
    throw new AppError(
      400,
      'INVALID_SPECIALIZATION',
      'Specialization does not exist or is inactive.',
    );
  }
}

// Prisma `contains` becomes ILIKE '%text%' without escaping, so "%" or "_" typed by a
// user would act as wildcards and match every doctor. Escape them (and the escape char).
export const escapeLikePattern = (text) => text.replace(/[\\%_]/g, '\\$&');

// The doctor profile of the logged-in DOCTOR user.
async function loadOwnDoctor(req) {
  const doctor = await prisma.doctor.findUnique({ where: { userId: req.user.userId } });
  if (!doctor) throw new AppError(403, 'FORBIDDEN', 'No doctor profile for this account.');
  return doctor;
}

// FR-3.2: blocks on the same day must not overlap (touching is fine: 10–13 and 13–15).
function findOverlap(blocks) {
  const sorted = blocks
    .map((b, index) => ({
      ...b,
      index,
      start: hhmmToMinutes(b.startTime),
      end: hhmmToMinutes(b.endTime),
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.dayOfWeek === prev.dayOfWeek && cur.start < prev.end) return [prev, cur];
  }
  return null;
}

const toScheduleBlock = (b) => ({
  id: b.id,
  dayOfWeek: b.dayOfWeek,
  startTime: minutesToHhmm(timeColumnToMinutes(b.startTime)),
  endTime: minutesToHhmm(timeColumnToMinutes(b.endTime)),
});

async function ownSchedule(doctorId) {
  const blocks = await prisma.doctorSchedule.findMany({
    where: { doctorId },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
  return blocks.map(toScheduleBlock);
}

// ---------- routes ----------

export const doctorsRouter = Router();
doctorsRouter.use(requireAuth);

// ----- doctor's own schedule and leaves (FR-3.1 – FR-3.3, FR-3.6) -----
// Declared before "/:id" so "me" is not read as an id.

doctorsRouter.get('/me/schedule', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await loadOwnDoctor(req);
  res.json({ blocks: await ownSchedule(doctor.id) });
});

// PUT replaces the whole weekly schedule. Existing bookings are not touched (FR-3.6).
doctorsRouter.put('/me/schedule', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await loadOwnDoctor(req);
  const { blocks } = validate(scheduleSchema, req.body);

  const clash = findOverlap(blocks);
  if (clash) {
    throw new AppError(
      400,
      'SCHEDULE_OVERLAP',
      'Schedule blocks on the same day must not overlap.',
      [
        { field: `blocks.${clash[0].index}`, message: `${clash[0].startTime}-${clash[0].endTime}` },
        { field: `blocks.${clash[1].index}`, message: `${clash[1].startTime}-${clash[1].endTime}` },
      ],
    );
  }

  await prisma.$transaction([
    prisma.doctorSchedule.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.doctorSchedule.createMany({
      data: blocks.map((b) => ({
        doctorId: doctor.id,
        dayOfWeek: b.dayOfWeek,
        startTime: minutesToTimeColumn(hhmmToMinutes(b.startTime)),
        endTime: minutesToTimeColumn(hhmmToMinutes(b.endTime)),
      })),
    }),
  ]);
  res.json({ blocks: await ownSchedule(doctor.id) });
});

// Upcoming leave dates (today onwards).
doctorsRouter.get('/me/leaves', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await loadOwnDoctor(req);
  const today = dateStringToDateColumn(clinicDateOf(new Date()));
  const leaves = await prisma.doctorLeave.findMany({
    where: { doctorId: doctor.id, leaveDate: { gte: today } },
    orderBy: { leaveDate: 'asc' },
  });
  res.json({ items: leaves.map((l) => ({ date: dateColumnToString(l.leaveDate) })) });
});

// FR-3.3: mark a leave date. Existing bookings on that date are reported, not cancelled.
doctorsRouter.post('/me/leaves', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await loadOwnDoctor(req);
  const { date } = validate(leaveSchema, req.body);
  if (date < clinicDateOf(new Date())) {
    throw new AppError(400, 'LEAVE_IN_PAST', 'Leave date cannot be in the past.');
  }

  try {
    await prisma.doctorLeave.create({
      data: { doctorId: doctor.id, leaveDate: dateStringToDateColumn(date) },
    });
  } catch (err) {
    if (uniqueViolationIndex(err)) {
      throw new AppError(409, 'LEAVE_EXISTS', 'This date is already marked as leave.');
    }
    throw err;
  }

  const { start, end } = clinicDayRange(date);
  const existingBookings = await prisma.appointment.count({
    where: { doctorId: doctor.id, status: 'BOOKED', startAt: { gte: start, lt: end } },
  });
  res.status(201).json({ leave: { date }, existingBookings });
});

doctorsRouter.delete('/me/leaves/:date', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await loadOwnDoctor(req);
  const { date } = validate(leaveParamsSchema, req.params);
  const { count } = await prisma.doctorLeave.deleteMany({
    where: { doctorId: doctor.id, leaveDate: dateStringToDateColumn(date) },
  });
  if (count === 0) throw new AppError(404, 'NOT_FOUND', 'No leave on this date.');
  res.status(204).end();
});

// ----- doctors list / details (FR-2.3 – FR-2.5) -----

// GET /doctors?specializationId=&search=&page=&pageSize=  (admin: &includeInactive=true)
doctorsRouter.get('/', async (req, res) => {
  const query = validate(listQuerySchema, req.query);
  const admin = req.user.role === 'ADMIN';
  const showAll = admin && query.includeInactive === true;

  const where = {
    ...(showAll ? {} : BOOKABLE_DOCTOR_WHERE),
    ...(query.specializationId ? { specializationId: query.specializationId } : {}),
    ...(query.search
      ? {
          user: {
            ...(showAll ? {} : BOOKABLE_DOCTOR_WHERE.user),
            name: { contains: escapeLikePattern(query.search), mode: 'insensitive' },
          },
        }
      : {}),
  };

  const [total, doctors] = await Promise.all([
    prisma.doctor.count({ where }),
    prisma.doctor.findMany({
      where,
      include: DOCTOR_INCLUDE,
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
      ...paginate(query),
    }),
  ]);
  res.json(
    pageResult(
      doctors.map((d) => toDoctor(d, { admin })),
      total,
      query,
    ),
  );
});

doctorsRouter.get('/:id', async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const admin = req.user.role === 'ADMIN';
  const doctor = await prisma.doctor.findFirst({
    where: { id, ...(admin ? {} : BOOKABLE_DOCTOR_WHERE) },
    include: DOCTOR_INCLUDE,
  });
  if (!doctor) throw doctorNotFound();
  res.json({ doctor: toDoctor(doctor, { admin }) });
});

// FR-3.5: GET /doctors/:id/slots?date=YYYY-MM-DD
doctorsRouter.get('/:id/slots', async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const { date } = validate(slotsQuerySchema, req.query);
  const doctor = await prisma.doctor.findFirst({ where: { id, ...BOOKABLE_DOCTOR_WHERE } });
  if (!doctor) throw doctorNotFound();

  const result = await slotsForDate(doctor, date);
  res.json({ doctorId: doctor.id, date, slotMinutes: doctor.slotMinutes, ...result });
});

// ----- admin: create / update doctors (FR-2.2, FR-2.3, FR-1.8) -----

doctorsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const input = validate(createDoctorSchema, req.body);
  await assertActiveSpecialization(input.specializationId);

  if (await prisma.user.findUnique({ where: { email: input.email } })) throw emailTaken();

  try {
    const doctor = await prisma.doctor.create({
      data: {
        fee: input.fee,
        slotMinutes: input.slotMinutes,
        bio: input.bio,
        specialization: { connect: { id: input.specializationId } },
        user: {
          create: {
            name: input.name,
            email: input.email,
            passwordHash: await hashPassword(input.password),
            role: 'DOCTOR',
          },
        },
      },
      include: DOCTOR_INCLUDE,
    });
    res.status(201).json({ doctor: toDoctor(doctor, { admin: true }) });
  } catch (err) {
    if (uniqueViolationIndex(err)) throw emailTaken();
    throw err;
  }
});

// Inactive doctors are hidden from patients and cannot be booked (FR-2.3).
doctorsRouter.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const input = validate(updateDoctorSchema, req.body);

  const existing = await prisma.doctor.findUnique({ where: { id } });
  if (!existing) throw doctorNotFound();
  if (input.specializationId !== undefined)
    await assertActiveSpecialization(input.specializationId);

  // Use relation syntax for the specialization: Prisma rejects mixing a plain
  // `specializationId` with the nested `user` update (a rename + specialization change
  // in one request returned 500).
  const { name, specializationId, ...doctorFields } = input;
  const doctor = await prisma.doctor.update({
    where: { id },
    data: {
      ...doctorFields,
      ...(specializationId !== undefined
        ? { specialization: { connect: { id: specializationId } } }
        : {}),
      ...(name !== undefined ? { user: { update: { name } } } : {}),
    },
    include: DOCTOR_INCLUDE,
  });
  res.json({ doctor: toDoctor(doctor, { admin: true }) });
});
