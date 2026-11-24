// Shared helpers for integration tests (real database, "itest" schema).
import { vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { signAccessToken } from '../../src/auth/tokens.js';
import { prisma } from '../../src/db.js';
import { hhmmToMinutes, minutesToTimeColumn } from '../../src/lib/clinicTime.js';
import { flushNotifications } from '../../src/notifications/appointmentEmails.js';
import { clearSentMail } from '../../src/notifications/mailer.js';

export { prisma };
export const PASSWORD = 'Password123';

const SCHEMA = new URL(process.env.DATABASE_URL).searchParams.get('schema');
if (SCHEMA !== 'itest') throw new Error('Integration tests must run on the itest schema.');

const TABLES = [
  'password_reset_tokens',
  'appointment_audit',
  'appointments',
  'doctor_leaves',
  'doctor_schedules',
  'doctors',
  'specializations',
  'users',
];

// Empties every table (schema-qualified, so the real data can never be touched).
export async function resetDatabase() {
  // Background emails of the previous test must not read tables while they are emptied.
  await flushNotifications();
  clearSentMail();
  const list = TABLES.map((t) => `"${SCHEMA}"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// ---- time control: only Date is faked, timers keep working ----

// Monday 2030-01-07, 08:00 clinic time (02:30 UTC).
export const NOW = new Date('2030-01-07T08:00:00+05:30');

export function freezeTime(at = NOW) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

export const unfreezeTime = () => vi.useRealTimers();

// Clinic-local date + time -> ISO string with +05:30 offset.
export const at = (date, time) => `${date}T${time}:00+05:30`;
export const utc = (date, time) => new Date(at(date, time)).toISOString();

// ---- data factories ----

let passwordHash;
const getHash = async () => (passwordHash ??= await hashPassword(PASSWORD));

let seq = 0;
const unique = (prefix) => `${prefix}${(seq += 1)}`;

export async function createUser({ role = 'PATIENT', name, email, isActive = true } = {}) {
  const id = unique(role.toLowerCase());
  return prisma.user.create({
    data: {
      name: name ?? `Test ${id}`,
      email: email ?? `${id}@example.com`,
      passwordHash: await getHash(),
      role,
      isActive,
    },
  });
}

export async function createSpecialization({ name, isActive = true } = {}) {
  return prisma.specialization.create({ data: { name: name ?? unique('Spec '), isActive } });
}

// Mon–Sat 10:00–13:00 and 16:00–19:00 unless `blocks` is given.
export const DEFAULT_BLOCKS = [1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
  { dayOfWeek, startTime: '10:00', endTime: '13:00' },
  { dayOfWeek, startTime: '16:00', endTime: '19:00' },
]);

export async function createDoctor({
  name,
  specialization,
  slotMinutes = 30,
  fee = 500,
  isActive = true,
  blocks = DEFAULT_BLOCKS,
} = {}) {
  const spec = specialization ?? (await createSpecialization());
  const user = await createUser({ role: 'DOCTOR', name });
  const doctor = await prisma.doctor.create({
    data: { userId: user.id, specializationId: spec.id, fee, slotMinutes, isActive },
  });
  if (blocks.length > 0) {
    await prisma.doctorSchedule.createMany({
      data: blocks.map((b) => ({
        doctorId: doctor.id,
        dayOfWeek: b.dayOfWeek,
        startTime: minutesToTimeColumn(hhmmToMinutes(b.startTime)),
        endTime: minutesToTimeColumn(hhmmToMinutes(b.endTime)),
      })),
    });
  }
  return { doctor, user, specialization: spec };
}

export const tokenFor = (user) => signAccessToken(user);

// Small request helper: api(token).get('/doctors')
export function api(token) {
  const app = createApp();
  const wrap = (method) => (path) => {
    const req = request(app)[method](`/api/v1${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  return {
    app,
    get: wrap('get'),
    post: wrap('post'),
    put: wrap('put'),
    patch: wrap('patch'),
    delete: wrap('delete'),
  };
}
