// D-33: admin reads / replaces any doctor's weekly schedule — real database.
// "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import {
  api,
  createDoctor,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const BLOCKS = [
  { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
  { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
  { dayOfWeek: 3, startTime: '10:00', endTime: '13:00' },
];

let doctor;
let doctorUser;
let adminApi;

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  ({ doctor, user: doctorUser } = await createDoctor({ blocks: [] }));
  adminApi = api(tokenFor(await createUser({ role: 'ADMIN' })));
});
afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

const strip = (blocks) => blocks.map(({ id: _id, ...b }) => b);

describe('Admin schedule — positive', () => {
  it('admin sets a doctor schedule; the doctor sees the same hours', async () => {
    const res = await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS });

    expect(res.status).toBe(200);
    expect(strip(res.body.blocks)).toEqual(BLOCKS);
    const own = await api(tokenFor(doctorUser)).get('/doctors/me/schedule');
    expect(strip(own.body.blocks)).toEqual(BLOCKS);
  });

  it('admin reads a doctor schedule (sorted by day and time)', async () => {
    await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: [...BLOCKS].reverse() });

    const res = await adminApi.get(`/doctors/${doctor.id}/schedule`);

    expect(res.status).toBe(200);
    expect(strip(res.body.blocks)).toEqual(BLOCKS);
  });

  it('PUT replaces the whole schedule (running it twice does not duplicate)', async () => {
    await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS });
    await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS });

    expect(await prisma.doctorSchedule.count({ where: { doctorId: doctor.id } })).toBe(3);
  });

  it('the new hours produce bookable slots for patients', async () => {
    await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS });
    const patientApi = api(tokenFor(await createUser()));

    const res = await patientApi.get(`/doctors/${doctor.id}/slots?date=2030-01-09`); // Wednesday

    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });
});

describe('Admin schedule — negative', () => {
  it.each(['PATIENT', 'DOCTOR'])('a %s cannot use it (403)', async (role) => {
    const other = api(tokenFor(await createUser({ role })));

    expect(
      (await other.put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS })).status,
    ).toBe(403);
    expect((await other.get(`/doctors/${doctor.id}/schedule`)).status).toBe(403);
  });

  it('a doctor cannot change another doctor through it either (403)', async () => {
    const { user: otherDoctor } = await createDoctor();

    const res = await api(tokenFor(otherDoctor))
      .put(`/doctors/${doctor.id}/schedule`)
      .send({ blocks: [] });

    expect(res.status).toBe(403);
    expect(await prisma.doctorSchedule.count({ where: { doctorId: doctor.id } })).toBe(0);
  });

  it('needs a login (401)', async () => {
    expect(
      (await api().put(`/doctors/${doctor.id}/schedule`).send({ blocks: BLOCKS })).status,
    ).toBe(401);
  });

  it('unknown doctor: 404', async () => {
    const res = await adminApi.put('/doctors/999999/schedule').send({ blocks: BLOCKS });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCTOR_NOT_FOUND');
  });

  it('overlapping blocks are rejected (FR-3.2) and nothing is saved', async () => {
    const res = await adminApi.put(`/doctors/${doctor.id}/schedule`).send({
      blocks: [
        { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 2, startTime: '11:00', endTime: '13:00' },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCHEDULE_OVERLAP');
    expect(await prisma.doctorSchedule.count({ where: { doctorId: doctor.id } })).toBe(0);
  });

  it.each([
    [{ dayOfWeek: 7, startTime: '09:00', endTime: '10:00' }, 'blocks.0.dayOfWeek'],
    [{ dayOfWeek: 1, startTime: '9am', endTime: '10:00' }, 'blocks.0.startTime'],
    [{ dayOfWeek: 1, startTime: '10:00', endTime: '09:00' }, 'blocks.0.endTime'],
  ])('invalid block %j is rejected on %s', async (block, field) => {
    const res = await adminApi.put(`/doctors/${doctor.id}/schedule`).send({ blocks: [block] });

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });
});
