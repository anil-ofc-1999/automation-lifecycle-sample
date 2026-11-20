// Feature: Doctor search (FR-2.4, FR-2.5, FR-2.3) — every positive and negative
// scenario of GET /doctors, GET /doctors/:id and GET /specializations, on the real database.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import {
  api,
  createDoctor,
  createSpecialization,
  createUser,
  prisma,
  resetDatabase,
  tokenFor,
} from './helpers.js';

let patientApi;
let adminApi;
let cardio;
let derma;
let neuroOff; // inactive specialization

const names = (res) => res.body.items.map((d) => d.name);

beforeEach(async () => {
  await resetDatabase();
  patientApi = api(tokenFor(await createUser({ role: 'PATIENT' })));
  adminApi = api(tokenFor(await createUser({ role: 'ADMIN' })));

  cardio = await createSpecialization({ name: 'Cardiology' });
  derma = await createSpecialization({ name: 'Dermatology' });
  neuroOff = await createSpecialization({ name: 'Neurology', isActive: false });

  await createDoctor({ name: 'Dr. Arjun Rao', specialization: cardio, fee: 800 });
  await createDoctor({ name: 'Dr. Meera Iyer', specialization: cardio });
  await createDoctor({ name: 'Dr. Kiran Shah', specialization: derma, slotMinutes: 15 });
  await createDoctor({ name: 'Dr. Lakshmi Rao', specialization: derma });
});

afterAll(() => prisma.$disconnect());

describe('GET /doctors — positive scenarios', () => {
  it('lists all bookable doctors sorted by name with page info', async () => {
    const res = await patientApi.get('/doctors');

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      'Dr. Arjun Rao',
      'Dr. Kiran Shah',
      'Dr. Lakshmi Rao',
      'Dr. Meera Iyer',
    ]);
    expect(res.body).toMatchObject({ page: 1, pageSize: 10, total: 4, totalPages: 1 });
  });

  it('returns the fields the search screen needs, and no private ones', async () => {
    const res = await patientApi.get('/doctors?search=arjun');

    expect(res.body.items[0]).toEqual({
      id: expect.any(Number),
      name: 'Dr. Arjun Rao',
      specialization: { id: cardio.id, name: 'Cardiology' },
      fee: 800,
      slotMinutes: 30,
      bio: null,
      isActive: true,
    });
  });

  it('filters by specialization', async () => {
    const res = await patientApi.get(`/doctors?specializationId=${derma.id}`);

    expect(names(res)).toEqual(['Dr. Kiran Shah', 'Dr. Lakshmi Rao']);
  });

  it.each([
    ['part of the first name', 'meer', ['Dr. Meera Iyer']],
    ['part of the last name', 'rao', ['Dr. Arjun Rao', 'Dr. Lakshmi Rao']],
    ['UPPER CASE', 'KIRAN', ['Dr. Kiran Shah']],
    ['MiXeD case', 'lAkShMi', ['Dr. Lakshmi Rao']],
    ['the full name', 'Dr. Meera Iyer', ['Dr. Meera Iyer']],
    ['spaces around it (trimmed)', '  iyer  ', ['Dr. Meera Iyer']],
  ])('searches by %s', async (_label, search, expected) => {
    const res = await patientApi.get(`/doctors?search=${encodeURIComponent(search)}`);

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(expected);
  });

  it('combines specialization filter and name search', async () => {
    const res = await patientApi.get(`/doctors?specializationId=${derma.id}&search=rao`);

    expect(names(res)).toEqual(['Dr. Lakshmi Rao']);
    expect(res.body.total).toBe(1);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
  ])('treats an %s search as "no search"', async (_label, search) => {
    const res = await patientApi.get(`/doctors?search=${encodeURIComponent(search)}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it('paginates search results', async () => {
    const res = await patientApi.get('/doctors?search=dr&pageSize=3&page=2');

    expect(res.body).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
    expect(names(res)).toEqual(['Dr. Meera Iyer']);
  });

  it('accepts the maximum page size of 50', async () => {
    const res = await patientApi.get('/doctors?pageSize=50');

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(50);
  });

  it('still lists a doctor who is on leave (leave only removes slots)', async () => {
    const [onLeave] = (await patientApi.get('/doctors?search=kiran')).body.items;
    await prisma.doctorLeave.create({
      data: { doctorId: onLeave.id, leaveDate: new Date('2030-01-08T00:00:00Z') },
    });

    expect(names(await patientApi.get('/doctors?search=kiran'))).toEqual(['Dr. Kiran Shah']);
  });

  it('works the same for a DOCTOR user', async () => {
    const doctorUser = (await createDoctor({ name: 'Dr. Self' })).user;

    const res = await api(tokenFor(doctorUser)).get('/doctors?search=meera');

    expect(names(res)).toEqual(['Dr. Meera Iyer']);
  });
});

describe('GET /doctors — "no results" scenarios', () => {
  it('a name that matches nobody returns an empty page, not an error', async () => {
    const res = await patientApi.get('/doctors?search=zzzz');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it('a specialization with no doctors returns an empty list', async () => {
    const empty = await createSpecialization({ name: 'Orthopedics' });

    expect((await patientApi.get(`/doctors?specializationId=${empty.id}`)).body.total).toBe(0);
  });

  it('an unknown specialization id returns an empty list', async () => {
    expect((await patientApi.get('/doctors?specializationId=99999')).body.total).toBe(0);
  });

  it('a page after the last one returns no items but the right total', async () => {
    const res = await patientApi.get('/doctors?page=9');

    expect(res.body).toMatchObject({ items: [], page: 9, total: 4 });
  });

  it.each(['%', '_', '\\', "' OR 1=1 --", '"; DROP TABLE users; --'])(
    'treats %j as plain text (no wildcards, no SQL injection)',
    async (search) => {
      const res = await patientApi.get(`/doctors?search=${encodeURIComponent(search)}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    },
  );

  it('still finds a name that really contains % or _ (escaped, not blocked)', async () => {
    await createDoctor({ name: 'Dr. 100% Care_Clinic' });

    expect(names(await patientApi.get('/doctors?search=%25'))).toEqual(['Dr. 100% Care_Clinic']);
    expect(names(await patientApi.get('/doctors?search=e_c'))).toEqual(['Dr. 100% Care_Clinic']);
  });

  it('the users table is still there after the injection attempts', async () => {
    await patientApi.get(`/doctors?search=${encodeURIComponent('"; DROP TABLE users; --')}`);

    expect(await prisma.user.count()).toBeGreaterThan(0);
  });
});

describe('GET /doctors — hidden doctors (FR-2.3)', () => {
  it('hides an inactive doctor from list and search', async () => {
    await createDoctor({ name: 'Dr. Inactive Rao', specialization: cardio, isActive: false });

    expect(names(await patientApi.get('/doctors?search=rao'))).toEqual([
      'Dr. Arjun Rao',
      'Dr. Lakshmi Rao',
    ]);
  });

  it('hides a doctor whose login account is disabled', async () => {
    const { user } = await createDoctor({ name: 'Dr. Disabled Account' });
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    expect((await patientApi.get('/doctors?search=disabled')).body.total).toBe(0);
  });

  it('hides doctors of an inactive specialization, even when filtered by it', async () => {
    await createDoctor({ name: 'Dr. Neuro', specialization: neuroOff });

    expect((await patientApi.get('/doctors?search=neuro')).body.total).toBe(0);
    expect((await patientApi.get(`/doctors?specializationId=${neuroOff.id}`)).body.total).toBe(0);
  });

  it('a patient cannot see hidden doctors with includeInactive=true', async () => {
    await createDoctor({ name: 'Dr. Inactive', isActive: false });

    const res = await patientApi.get('/doctors?includeInactive=true&search=inactive');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('an admin can see hidden doctors with includeInactive=true', async () => {
    await createDoctor({ name: 'Dr. Inactive', isActive: false });

    const res = await adminApi.get('/doctors?includeInactive=true&search=inactive');

    expect(names(res)).toEqual(['Dr. Inactive']);
    expect(res.body.items[0]).toHaveProperty('email'); // admin-only field
  });
});

describe('GET /doctors — negative scenarios (bad input)', () => {
  it.each([
    ['specializationId=abc', 'specializationId'],
    ['specializationId=0', 'specializationId'],
    ['specializationId=-3', 'specializationId'],
    ['specializationId=1.5', 'specializationId'],
    ['page=0', 'page'],
    ['page=abc', 'page'],
    ['pageSize=0', 'pageSize'],
    ['pageSize=51', 'pageSize'],
    ['includeInactive=yes', 'includeInactive'],
  ])('returns 400 for %s', async (query, field) => {
    const res = await patientApi.get(`/doctors?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('returns 400 for a search longer than 100 characters', async () => {
    const res = await patientApi.get(`/doctors?search=${'a'.repeat(101)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('search');
  });

  it('accepts a search of exactly 100 characters', async () => {
    expect((await patientApi.get(`/doctors?search=${'a'.repeat(100)}`)).status).toBe(200);
  });

  it('returns 401 without a token (search needs login)', async () => {
    const res = await api().get('/doctors');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /doctors/:id — the detail link from search', () => {
  it('returns a bookable doctor', async () => {
    const [arjun] = (await patientApi.get('/doctors?search=arjun')).body.items;

    const res = await patientApi.get(`/doctors/${arjun.id}`);

    expect(res.status).toBe(200);
    expect(res.body.doctor.name).toBe('Dr. Arjun Rao');
  });

  it('returns 404 DOCTOR_NOT_FOUND for an inactive doctor (patient)', async () => {
    const { doctor } = await createDoctor({ isActive: false });

    const res = await patientApi.get(`/doctors/${doctor.id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCTOR_NOT_FOUND');
  });

  it('returns 404 for an id that does not exist', async () => {
    expect((await patientApi.get('/doctors/99999')).status).toBe(404);
  });

  it.each(['abc', '0', '-1'])('returns 400 for id %j', async (id) => {
    expect((await patientApi.get(`/doctors/${id}`)).status).toBe(400);
  });
});

describe('GET /specializations — the filter dropdown', () => {
  it('lists only active specializations, sorted by name', async () => {
    const res = await patientApi.get('/specializations');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: cardio.id, name: 'Cardiology', isActive: true },
      { id: derma.id, name: 'Dermatology', isActive: true },
    ]);
  });

  it('a patient cannot see inactive ones with includeInactive=true', async () => {
    const res = await patientApi.get('/specializations?includeInactive=true');

    expect(res.body.items.map((s) => s.name)).toEqual(['Cardiology', 'Dermatology']);
  });

  it('an admin can see inactive ones with includeInactive=true', async () => {
    const res = await adminApi.get('/specializations?includeInactive=true');

    expect(res.body.items.map((s) => s.name)).toEqual(['Cardiology', 'Dermatology', 'Neurology']);
  });

  it('returns 400 for includeInactive=1', async () => {
    expect((await patientApi.get('/specializations?includeInactive=1')).status).toBe(400);
  });

  it('returns 401 without a token', async () => {
    expect((await api().get('/specializations')).status).toBe(401);
  });

  it('returns an empty list when there are no active specializations', async () => {
    await prisma.specialization.updateMany({ data: { isActive: false } });

    expect((await patientApi.get('/specializations')).body.items).toEqual([]);
  });
});
