// Seed / test data (REQUIREMENTS §11): 1 admin, 3 specializations, 5 doctors, 10 patients.
// All names are fake and every email ends in @example.com.
// Safe to run many times: existing rows are updated, not duplicated.
//
// Run with: npm run db:seed

import bcrypt from 'bcryptjs';

import { prisma } from '../src/db.js';

// Test-only password for every seeded account (never a real password).
// Override with SEED_PASSWORD in .env if you like.
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Password123';

// Safety: a database that is not on this machine (e.g. the live one on Render) is only
// seeded with a real password — never the public default "Password123".
const dbHost = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost').hostname;
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(dbHost);
if (!isLocal) {
  const weak =
    !process.env.SEED_PASSWORD ||
    SEED_PASSWORD === 'Password123' ||
    SEED_PASSWORD.length < 12 ||
    !/[A-Za-z]/.test(SEED_PASSWORD) ||
    !/[0-9]/.test(SEED_PASSWORD);
  if (weak) {
    console.error(
      `Refusing to seed "${dbHost}": set SEED_PASSWORD to your own password ` +
        '(at least 12 characters, with letters and numbers).',
    );
    process.exit(1);
  }
}

const SPECIALIZATIONS = ['Cardiology', 'Dermatology', 'General Medicine'];

const DOCTORS = [
  {
    name: 'Dr. Arjun Rao',
    email: 'arjun.rao@example.com',
    specialization: 'Cardiology',
    fee: 800,
    slotMinutes: 30,
  },
  {
    name: 'Dr. Meera Iyer',
    email: 'meera.iyer@example.com',
    specialization: 'Cardiology',
    fee: 900,
    slotMinutes: 30,
  },
  {
    name: 'Dr. Kiran Shah',
    email: 'kiran.shah@example.com',
    specialization: 'Dermatology',
    fee: 600,
    slotMinutes: 15,
  },
  {
    name: 'Dr. Lakshmi Nair',
    email: 'lakshmi.nair@example.com',
    specialization: 'Dermatology',
    fee: 650,
    slotMinutes: 15,
  },
  {
    name: 'Dr. Ravi Kumar',
    email: 'ravi.kumar@example.com',
    specialization: 'General Medicine',
    fee: 400,
    slotMinutes: 15,
  },
];

const PATIENTS = [
  'Asha Reddy',
  'Vikram Singh',
  'Priya Menon',
  'Rahul Verma',
  'Sneha Patil',
  'Anand Joshi',
  'Divya Rao',
  'Suresh Babu',
  'Kavya Sharma',
  'Naveen Gupta',
];

// Monday–Saturday, two blocks a day (FR-3.1): 10:00–13:00 and 16:00–19:00 clinic time.
const WORK_DAYS = [1, 2, 3, 4, 5, 6];
const BLOCKS = [
  ['10:00', '13:00'],
  ['16:00', '19:00'],
];

// Postgres TIME columns are read/written by Prisma as a Date on 1970-01-01 (UTC).
const toTime = (hhmm) => new Date(`1970-01-01T${hhmm}:00Z`);

const emailFor = (name) => `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`;

async function upsertUser({ name, email, role, passwordHash }) {
  return prisma.user.upsert({
    where: { email },
    update: { name, role, isActive: true },
    create: { name, email, role, passwordHash },
  });
}

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  await upsertUser({ name: 'Admin User', email: 'admin@example.com', role: 'ADMIN', passwordHash });

  const specByName = {};
  for (const name of SPECIALIZATIONS) {
    specByName[name] = await prisma.specialization.upsert({
      where: { name },
      update: { isActive: true },
      create: { name },
    });
  }

  for (const d of DOCTORS) {
    const user = await upsertUser({ name: d.name, email: d.email, role: 'DOCTOR', passwordHash });
    const doctorData = {
      specializationId: specByName[d.specialization].id,
      fee: d.fee,
      slotMinutes: d.slotMinutes,
      bio: `${d.specialization} specialist (sample data).`,
      isActive: true,
    };
    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      update: doctorData,
      create: { userId: user.id, ...doctorData },
    });

    // Replace the weekly schedule so re-running the seed gives the same result.
    await prisma.$transaction([
      prisma.doctorSchedule.deleteMany({ where: { doctorId: doctor.id } }),
      prisma.doctorSchedule.createMany({
        data: WORK_DAYS.flatMap((dayOfWeek) =>
          BLOCKS.map(([start, end]) => ({
            doctorId: doctor.id,
            dayOfWeek,
            startTime: toTime(start),
            endTime: toTime(end),
          })),
        ),
      }),
    ]);
  }

  for (const name of PATIENTS) {
    await upsertUser({ name, email: emailFor(name), role: 'PATIENT', passwordHash });
  }

  const [users, doctors, schedules] = await Promise.all([
    prisma.user.count(),
    prisma.doctor.count(),
    prisma.doctorSchedule.count(),
  ]);
  console.log(`Seed done: ${users} users, ${doctors} doctors, ${schedules} schedule blocks.`);
}

try {
  await main();
} catch (err) {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
