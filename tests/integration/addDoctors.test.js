// D-33: the add-doctors script against the real API + PostgreSQL, with the shipped
// 100-doctor data file. "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { readFileSync } from 'node:fs';

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import { addDoctors } from '../../scripts/lib/addDoctors.mjs';
import {
  api,
  createDoctor,
  createSpecialization,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const DATA = JSON.parse(
  readFileSync(new URL('../../scripts/data/doctors.json', import.meta.url), 'utf8'),
);
const DOCTOR_PASSWORD = 'DoctorPass2030';

let admin;

/** The script's client, but calling the in-process app instead of a URL. */
const clientFor = (user) => {
  const http = api(tokenFor(user));
  return async (method, path, body) => {
    const req = http[method.toLowerCase()](path);
    const res = await (body ? req.send(body) : req);
    return { status: res.status, body: res.body };
  };
};

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  admin = await createUser({ role: 'ADMIN' });
});
afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('add-doctors with the real data file', () => {
  it('adds 17 specializations and 100 doctors with schedules; a 2nd run adds nothing', async () => {
    const first = await addDoctors({
      client: clientFor(admin),
      data: DATA,
      doctorPassword: DOCTOR_PASSWORD,
    });

    expect(first.specializations.created).toHaveLength(17);
    expect(first.doctors.created).toHaveLength(100);
    expect(await prisma.specialization.count()).toBe(17);
    expect(await prisma.doctor.count()).toBe(100);
    const withoutSchedule = await prisma.doctor.count({ where: { schedules: { none: {} } } });
    expect(withoutSchedule).toBe(0);

    const second = await addDoctors({
      client: clientFor(admin),
      data: DATA,
      doctorPassword: DOCTOR_PASSWORD,
    });

    expect(second.specializations.created).toEqual([]);
    expect(second.doctors.created).toEqual([]);
    expect(second.doctors.existing).toHaveLength(100);
    expect(await prisma.doctor.count()).toBe(100);
    expect(await prisma.specialization.count()).toBe(17);
  }, 180_000);

  it('keeps existing data: same-name specialization (other case) and existing doctor', async () => {
    const cardiology = await createSpecialization({ name: 'cardiology' });
    const first = DATA.doctors[0];
    await createDoctor({ name: first.name, specialization: cardiology });
    await prisma.user.updateMany({
      where: { role: 'DOCTOR' },
      data: { email: first.email.toUpperCase() },
    });
    const small = { ...DATA, doctors: DATA.doctors.slice(0, 3) };

    const s = await addDoctors({
      client: clientFor(admin),
      data: small,
      doctorPassword: DOCTOR_PASSWORD,
    });

    expect(s.specializations.existing).toEqual(['cardiology']);
    expect(
      await prisma.specialization.count({
        where: { name: { equals: 'Cardiology', mode: 'insensitive' } },
      }),
    ).toBe(1);
    expect(s.doctors.existing).toEqual([first.email]);
    expect(await prisma.doctor.count()).toBe(3);
  }, 60_000);

  it('a new doctor can log in with the chosen password and patients see slots', async () => {
    const small = { ...DATA, doctors: DATA.doctors.slice(0, 1) };
    await addDoctors({ client: clientFor(admin), data: small, doctorPassword: DOCTOR_PASSWORD });
    const d = DATA.doctors[0];

    const login = await api()
      .post('/auth/login')
      .send({ email: d.email, password: DOCTOR_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('DOCTOR');

    const patient = api(tokenFor(await createUser()));
    const found = await patient.get(`/doctors?search=${encodeURIComponent(d.name.slice(4))}`);
    expect(found.body.items).toHaveLength(1);
    const days = [
      '2030-01-07',
      '2030-01-08',
      '2030-01-09',
      '2030-01-10',
      '2030-01-11',
      '2030-01-12',
    ];
    const slotCounts = await Promise.all(
      days.map(async (date) => {
        const res = await patient.get(`/doctors/${found.body.items[0].id}/slots?date=${date}`);
        return res.body.slots.length;
      }),
    );
    expect(slotCounts.some((n) => n > 0)).toBe(true);
  }, 60_000);

  it('a non-admin cannot run it: the first write is refused (403) and nothing is added', async () => {
    const patient = await createUser();

    await expect(
      addDoctors({ client: clientFor(patient), data: DATA, doctorPassword: DOCTOR_PASSWORD }),
    ).rejects.toThrow();
    expect(await prisma.doctor.count()).toBe(0);
    expect(await prisma.specialization.count()).toBe(0);
  });
});
