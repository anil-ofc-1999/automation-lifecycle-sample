// Regression (D-28): timestamps must be stored as the right instant even when the
// PostgreSQL server's TimeZone is not UTC (local installs here use Asia/Calcutta;
// CI sets the test database to Asia/Kolkata on purpose).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { api, at, createDoctor, createUser, prisma, resetDatabase, tokenFor } from './helpers.js';

// Raw SQL is not schema-qualified by Prisma: use the test schema explicitly.
const TABLE = `"${new URL(process.env.DATABASE_URL).searchParams.get('schema')}"."appointments"`;

beforeEach(() => resetDatabase());
afterAll(() => prisma.$disconnect());

/** What PostgreSQL itself stored, as epoch milliseconds (independent of Prisma). */
async function storedEpochMs(id) {
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT (extract(epoch FROM start_at) * 1000)::bigint AS ms,
            (start_at AT TIME ZONE 'Asia/Kolkata')::text AS clinic
       FROM ${TABLE} WHERE id = $1`,
    id,
  );
  return { ms: Number(row.ms), clinic: row.clinic };
}

describe('timestamps are stored as the exact instant (D-28)', () => {
  it('the API connection always uses UTC', async () => {
    const [row] = await prisma.$queryRawUnsafe('SHOW TimeZone');

    expect(row.TimeZone ?? row.timezone).toBe('UTC');
  });

  it('a booking made through the API is stored at the right instant', async () => {
    const { doctor } = await createDoctor();
    const patient = await createUser();
    // A date far ahead is outside the 30-day window, so write directly like the API does.
    const startAt = new Date(at('2030-01-08', '10:00'));

    const created = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        startAt,
        endAt: new Date(startAt.getTime() + 30 * 60_000),
      },
    });

    const stored = await storedEpochMs(created.id);
    expect(stored.ms).toBe(startAt.getTime());
    expect(stored.clinic).toBe('2030-01-08 10:00:00');
  });

  it('a row written by raw SQL with an offset is read back the same by the API', async () => {
    const { doctor } = await createDoctor();
    const patient = await createUser();
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (doctor_id, patient_id, start_at, end_at, status, updated_at)
       VALUES ($1, $2, '2030-01-08 10:00:00+05:30', '2030-01-08 10:30:00+05:30', 'CANCELLED', now())`,
      doctor.id,
      patient.id,
    );

    const res = await api(tokenFor(patient)).get('/appointments/me');

    expect(res.body.past[0]).toMatchObject({ date: '2030-01-08', time: '10:00' });
  });
});
