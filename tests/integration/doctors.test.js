// FR-2: specializations and doctors — against the real database.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import {
  api,
  createDoctor,
  createSpecialization,
  createUser,
  prisma,
  resetDatabase,
  tokenFor,
  PASSWORD,
} from './helpers.js';

let admin;
let patient;
let adminApi;
let patientApi;

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser({ role: 'ADMIN' });
  patient = await createUser({ role: 'PATIENT' });
  adminApi = api(tokenFor(admin));
  patientApi = api(tokenFor(patient));
});

afterAll(() => prisma.$disconnect());

describe('Specializations (FR-2.1)', () => {
  it('admin creates, renames and deactivates; patients see only active ones', async () => {
    const created = await adminApi.post('/specializations').send({ name: 'Cardiology' });
    expect(created.status).toBe(201);
    const id = created.body.specialization.id;

    const renamed = await adminApi.patch(`/specializations/${id}`).send({ name: 'Heart Care' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.specialization.name).toBe('Heart Care');

    await adminApi.post('/specializations').send({ name: 'Dermatology' });
    await adminApi.patch(`/specializations/${id}`).send({ isActive: false });

    const forPatient = await patientApi.get('/specializations');
    expect(forPatient.body.items.map((s) => s.name)).toEqual(['Dermatology']);

    const forAdmin = await adminApi.get('/specializations?includeInactive=true');
    expect(forAdmin.body.items).toHaveLength(2);

    // A patient asking for inactive ones still gets only active ones.
    const sneaky = await patientApi.get('/specializations?includeInactive=true');
    expect(sneaky.body.items).toHaveLength(1);
  });

  it('rejects duplicate names ignoring case (409)', async () => {
    await adminApi.post('/specializations').send({ name: 'Cardiology' });
    const dup = await adminApi.post('/specializations').send({ name: '  cardiology ' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SPECIALIZATION_EXISTS');
  });

  it('rejects rename to an existing name, but allows changing own case', async () => {
    const a = await adminApi.post('/specializations').send({ name: 'Cardiology' });
    await adminApi.post('/specializations').send({ name: 'Dermatology' });
    const id = a.body.specialization.id;

    expect(
      (await adminApi.patch(`/specializations/${id}`).send({ name: 'DERMATOLOGY' })).status,
    ).toBe(409);
    expect(
      (await adminApi.patch(`/specializations/${id}`).send({ name: 'CARDIOLOGY' })).status,
    ).toBe(200);
  });

  it('only admin can create (403) and login is required (401)', async () => {
    expect((await patientApi.post('/specializations').send({ name: 'X Ray' })).status).toBe(403);
    expect((await api().get('/specializations')).status).toBe(401);
  });

  it('validates input and returns 404 for unknown id', async () => {
    expect((await adminApi.post('/specializations').send({ name: '' })).status).toBe(400);
    expect((await adminApi.patch('/specializations/999').send({ name: 'Ok Name' })).status).toBe(
      404,
    );
    expect((await adminApi.patch('/specializations/abc').send({ name: 'Ok Name' })).status).toBe(
      400,
    );
    expect((await adminApi.patch('/specializations/1').send({})).status).toBe(400);
  });
});

describe('Admin creates and updates doctors (FR-2.2, FR-2.3, FR-1.8)', () => {
  it('creates a doctor account that can then log in', async () => {
    const spec = await createSpecialization({ name: 'Cardiology' });

    const res = await adminApi.post('/doctors').send({
      name: 'Dr. Test Rao',
      email: 'Test.Rao@Example.com',
      password: PASSWORD,
      specializationId: spec.id,
      fee: 750.5,
      slotMinutes: 15,
      bio: 'Heart specialist',
    });

    expect(res.status).toBe(201);
    expect(res.body.doctor).toMatchObject({
      name: 'Dr. Test Rao',
      email: 'test.rao@example.com',
      specialization: { id: spec.id, name: 'Cardiology' },
      fee: 750.5,
      slotMinutes: 15,
      bio: 'Heart specialist',
      isActive: true,
    });

    const login = await api()
      .post('/auth/login')
      .send({ email: 'test.rao@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('DOCTOR');
  });

  it.each([
    ['slot duration 20', { slotMinutes: 20 }],
    ['negative fee', { fee: -1 }],
    ['fee with 3 decimals', { fee: 10.123 }],
    ['weak password', { password: 'short' }],
    ['missing specialization', { specializationId: undefined }],
  ])('rejects %s (400)', async (_label, change) => {
    const spec = await createSpecialization();
    const body = {
      name: 'Dr. Bad Input',
      email: 'bad@example.com',
      password: PASSWORD,
      specializationId: spec.id,
      fee: 500,
      slotMinutes: 30,
      ...change,
    };
    const res = await adminApi.post('/doctors').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an inactive or unknown specialization and a taken email', async () => {
    const inactive = await createSpecialization({ isActive: false });
    const base = {
      name: 'Dr. X',
      email: 'x1@example.com',
      password: PASSWORD,
      fee: 1,
      slotMinutes: 30,
    };

    const r1 = await adminApi.post('/doctors').send({ ...base, specializationId: inactive.id });
    expect(r1.body.error.code).toBe('INVALID_SPECIALIZATION');
    const r2 = await adminApi.post('/doctors').send({ ...base, specializationId: 9999 });
    expect(r2.body.error.code).toBe('INVALID_SPECIALIZATION');

    const active = await createSpecialization();
    const r3 = await adminApi
      .post('/doctors')
      .send({ ...base, email: patient.email.toUpperCase(), specializationId: active.id });
    expect(r3.status).toBe(409);
    expect(r3.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('patients cannot create doctors (403)', async () => {
    const spec = await createSpecialization();
    const res = await patientApi.post('/doctors').send({
      name: 'Dr. X',
      email: 'x2@example.com',
      password: PASSWORD,
      specializationId: spec.id,
      fee: 1,
      slotMinutes: 30,
    });
    expect(res.status).toBe(403);
  });

  it('updates fields; deactivated doctor is hidden from patients but visible to admin', async () => {
    const { doctor } = await createDoctor({ name: 'Dr. Hidden' });

    const upd = await adminApi
      .patch(`/doctors/${doctor.id}`)
      .send({ name: 'Dr. Renamed', fee: 999, slotMinutes: 15, bio: null, isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body.doctor).toMatchObject({
      name: 'Dr. Renamed',
      fee: 999,
      slotMinutes: 15,
      isActive: false,
    });

    expect((await patientApi.get(`/doctors/${doctor.id}`)).status).toBe(404);
    expect((await patientApi.get('/doctors')).body.total).toBe(0);
    expect((await adminApi.get(`/doctors/${doctor.id}`)).status).toBe(200);
    expect((await adminApi.get('/doctors?includeInactive=true')).body.total).toBe(1);
  });

  it('returns 404 when updating an unknown doctor', async () => {
    expect((await adminApi.patch('/doctors/9999').send({ fee: 1 })).status).toBe(404);
  });
});

describe('Doctor list (FR-2.4, FR-2.5)', () => {
  it('filters by specialization, searches by partial name (any case) and paginates', async () => {
    const cardio = await createSpecialization({ name: 'Cardiology' });
    const derma = await createSpecialization({ name: 'Dermatology' });
    await createDoctor({ name: 'Dr. Arjun Rao', specialization: cardio });
    await createDoctor({ name: 'Dr. Meera Iyer', specialization: cardio });
    await createDoctor({ name: 'Dr. Kiran Shah', specialization: derma });

    const byspec = await patientApi.get(`/doctors?specializationId=${cardio.id}`);
    expect(byspec.body.items.map((d) => d.name)).toEqual(['Dr. Arjun Rao', 'Dr. Meera Iyer']);

    const search = await patientApi.get('/doctors?search=MEER');
    expect(search.body.items.map((d) => d.name)).toEqual(['Dr. Meera Iyer']);

    const page2 = await patientApi.get('/doctors?page=2&pageSize=2');
    expect(page2.body).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(page2.body.items).toHaveLength(1);

    // Patients never see doctor emails
    expect(page2.body.items[0]).not.toHaveProperty('email');
  });

  it('defaults to 10 per page and rejects pageSize above 50', async () => {
    const spec = await createSpecialization();
    for (let i = 0; i < 12; i += 1) await createDoctor({ specialization: spec });

    const first = await patientApi.get('/doctors');
    expect(first.body).toMatchObject({ page: 1, pageSize: 10, total: 12, totalPages: 2 });
    expect(first.body.items).toHaveLength(10);

    expect((await patientApi.get('/doctors?pageSize=51')).status).toBe(400);
    expect((await patientApi.get('/doctors?page=0')).status).toBe(400);
  });

  it('hides doctors whose specialization or account is inactive', async () => {
    const off = await createSpecialization({ isActive: false });
    await createDoctor({ specialization: off });
    const { user } = await createDoctor();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    await createDoctor({ name: 'Dr. Visible' });

    const res = await patientApi.get('/doctors');
    expect(res.body.items.map((d) => d.name)).toEqual(['Dr. Visible']);
  });
});
