// Feature: Admin panel (FR-2.1 to FR-2.3, FR-6.3, FR-5.5) — positive and negative
// scenarios on the real database. "Now" is frozen at Monday 2030-01-07 08:00 clinic time.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import {
  PASSWORD,
  api,
  at,
  createDoctor,
  createSpecialization,
  createUser,
  freezeTime,
  prisma,
  resetDatabase,
  tokenFor,
  unfreezeTime,
} from './helpers.js';

const TUE = '2030-01-08';
const WED = '2030-01-09';
const THU = '2030-01-10';

let admin;
let patient;
let doctorUser;
let doctor;
let cardio;

const as = (user) => api(tokenFor(user));
const adminApi = () => as(admin);

const newDoctorBody = (overrides = {}) => ({
  name: 'Dr. New Admin',
  email: `new.doctor.${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: PASSWORD,
  specializationId: cardio.id,
  fee: 750,
  slotMinutes: 30,
  ...overrides,
});

async function book(user, date, time, doctorId = doctor.id) {
  const res = await as(user)
    .post('/appointments')
    .send({ doctorId, startAt: at(date, time) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.appointment;
}

beforeEach(async () => {
  await resetDatabase();
  freezeTime();
  admin = await createUser({ role: 'ADMIN' });
  patient = await createUser({ name: 'Admin Test Patient' });
  cardio = await createSpecialization({ name: 'Cardiology' });
  ({ doctor, user: doctorUser } = await createDoctor({
    name: 'Dr. Managed',
    specialization: cardio,
  }));
});

afterEach(() => unfreezeTime());
afterAll(() => prisma.$disconnect());

describe('Admin: doctors list (FR-2.3)', () => {
  it('includeInactive=true shows inactive doctors with admin-only fields', async () => {
    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });

    const res = await adminApi().get('/doctors?includeInactive=true');

    expect(res.body.items).toEqual([
      expect.objectContaining({
        id: doctor.id,
        isActive: false,
        email: expect.stringContaining('@example.com'),
        userId: doctorUser.id,
        accountActive: true,
      }),
    ]);
  });

  it('without includeInactive the admin sees only bookable doctors', async () => {
    await prisma.doctor.update({ where: { id: doctor.id }, data: { isActive: false } });

    expect((await adminApi().get('/doctors')).body.total).toBe(0);
  });
});

describe('Admin: create doctor — positive (FR-2.2)', () => {
  it('creates an active doctor with bio, 15-minute slots and a 2-decimal fee', async () => {
    const res = await adminApi()
      .post('/doctors')
      .send(newDoctorBody({ bio: 'Heart care.', slotMinutes: 15, fee: 499.5 }));

    expect(res.status).toBe(201);
    expect(res.body.doctor).toMatchObject({
      name: 'Dr. New Admin',
      specialization: { id: cardio.id, name: 'Cardiology' },
      fee: 499.5,
      slotMinutes: 15,
      bio: 'Heart care.',
      isActive: true,
      accountActive: true,
    });
  });

  it('the new doctor can log in and has the DOCTOR role (FR-1.8)', async () => {
    const body = newDoctorBody();
    await adminApi().post('/doctors').send(body);

    const login = await api().post('/auth/login').send({ email: body.email, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('DOCTOR');
  });

  it('a fee of 0 is allowed (free consultation)', async () => {
    expect(
      (
        await adminApi()
          .post('/doctors')
          .send(newDoctorBody({ fee: 0 }))
      ).status,
    ).toBe(201);
  });
});

describe('Admin: create doctor — negative', () => {
  it.each([
    ['negative fee', { fee: -1 }, 'fee'],
    ['fee with 3 decimals', { fee: 10.555 }, 'fee'],
    ['fee as text', { fee: 'five hundred' }, 'fee'],
    ['20-minute slots', { slotMinutes: 20 }, 'slotMinutes'],
    ['weak password', { password: 'password' }, 'password'],
    ['invalid email', { email: 'not-an-email' }, 'email'],
    ['1-letter name', { name: 'A' }, 'name'],
    ['missing specialization', { specializationId: undefined }, 'specializationId'],
  ])('400 for %s', async (_label, overrides, field) => {
    const res = await adminApi().post('/doctors').send(newDoctorBody(overrides));

    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('409 EMAIL_TAKEN for an email already used (any case)', async () => {
    const res = await adminApi()
      .post('/doctors')
      .send(newDoctorBody({ email: patient.email.toUpperCase() }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('400 INVALID_SPECIALIZATION for an inactive or unknown specialization', async () => {
    const off = await createSpecialization({ isActive: false });

    for (const specializationId of [off.id, 99999]) {
      const res = await adminApi().post('/doctors').send(newDoctorBody({ specializationId }));
      expect(res.body.error.code).toBe('INVALID_SPECIALIZATION');
    }
  });

  it('nothing is created when validation fails', async () => {
    const before = await prisma.user.count();
    await adminApi()
      .post('/doctors')
      .send(newDoctorBody({ fee: -5 }));

    expect(await prisma.user.count()).toBe(before);
  });

  it.each(['PATIENT', 'DOCTOR'])('a %s cannot create doctors (403)', async (role) => {
    const user = role === 'PATIENT' ? patient : doctorUser;

    expect((await as(user).post('/doctors').send(newDoctorBody())).status).toBe(403);
  });
});

describe('Admin: update doctor (FR-2.2, FR-2.3)', () => {
  it('renames, changes specialization, fee, slot length and bio', async () => {
    const derma = await createSpecialization({ name: 'Dermatology' });

    const res = await adminApi().patch(`/doctors/${doctor.id}`).send({
      name: 'Dr. Renamed',
      specializationId: derma.id,
      fee: 900,
      slotMinutes: 15,
      bio: 'New bio',
    });

    expect(res.status).toBe(200);
    expect(res.body.doctor).toMatchObject({
      name: 'Dr. Renamed',
      specialization: { id: derma.id, name: 'Dermatology' },
      fee: 900,
      slotMinutes: 15,
      bio: 'New bio',
    });
  });

  it('bio: null clears the bio', async () => {
    await adminApi().patch(`/doctors/${doctor.id}`).send({ bio: 'Something' });

    expect(
      (await adminApi().patch(`/doctors/${doctor.id}`).send({ bio: null })).body.doctor.bio,
    ).toBeNull();
  });

  it('deactivating hides the doctor and blocks new bookings; existing bookings stay', async () => {
    const a = await book(patient, TUE, '10:00');

    await adminApi().patch(`/doctors/${doctor.id}`).send({ isActive: false });

    expect((await as(patient).get('/doctors')).body.total).toBe(0);
    expect(
      (
        await as(patient)
          .post('/appointments')
          .send({ doctorId: doctor.id, startAt: at(WED, '10:00') })
      ).status,
    ).toBe(404);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } })).status).toBe('BOOKED');
  });

  it('reactivating makes the doctor bookable again', async () => {
    await adminApi().patch(`/doctors/${doctor.id}`).send({ isActive: false });
    await adminApi().patch(`/doctors/${doctor.id}`).send({ isActive: true });

    expect((await as(patient).get('/doctors')).body.total).toBe(1);
  });

  it.each([
    ['empty body', {}],
    ['fee -1', { fee: -1 }],
    ['slotMinutes 45', { slotMinutes: 45 }],
    ['isActive as text', { isActive: 'no' }],
  ])('400 for %s', async (_label, body) => {
    expect((await adminApi().patch(`/doctors/${doctor.id}`).send(body)).status).toBe(400);
  });

  it('400 for an inactive specialization', async () => {
    const off = await createSpecialization({ isActive: false });

    const res = await adminApi().patch(`/doctors/${doctor.id}`).send({ specializationId: off.id });

    expect(res.body.error.code).toBe('INVALID_SPECIALIZATION');
  });

  it.each([
    ['abc', 400],
    ['99999', 404],
  ])('id %s -> %i', async (id, status) => {
    expect((await adminApi().patch(`/doctors/${id}`).send({ fee: 1 })).status).toBe(status);
  });

  it.each(['PATIENT', 'DOCTOR'])('a %s cannot update doctors (403)', async (role) => {
    const user = role === 'PATIENT' ? patient : doctorUser;

    expect((await as(user).patch(`/doctors/${doctor.id}`).send({ fee: 1 })).status).toBe(403);
  });
});

describe('Admin: specializations (FR-2.1)', () => {
  it('creates one (name trimmed); it appears in the list sorted by name', async () => {
    const res = await adminApi().post('/specializations').send({ name: '  Anaesthesia  ' });

    expect(res.status).toBe(201);
    expect(res.body.specialization).toMatchObject({ name: 'Anaesthesia', isActive: true });
    expect((await as(patient).get('/specializations')).body.items.map((s) => s.name)).toEqual([
      'Anaesthesia',
      'Cardiology',
    ]);
  });

  it('renames one', async () => {
    const res = await adminApi().patch(`/specializations/${cardio.id}`).send({ name: 'Heart' });

    expect(res.body.specialization.name).toBe('Heart');
  });

  it('deactivating hides it and its doctors from patients; reactivating brings them back', async () => {
    await adminApi().patch(`/specializations/${cardio.id}`).send({ isActive: false });

    expect((await as(patient).get('/specializations')).body.items).toEqual([]);
    expect((await as(patient).get('/doctors')).body.total).toBe(0);
    expect((await adminApi().get('/specializations?includeInactive=true')).body.items).toHaveLength(
      1,
    );

    await adminApi().patch(`/specializations/${cardio.id}`).send({ isActive: true });
    expect((await as(patient).get('/doctors')).body.total).toBe(1);
  });

  it.each([
    ['same name, other case', 'CARDIOLOGY'],
    ['same name with spaces', '  Cardiology '],
  ])('409 SPECIALIZATION_EXISTS for %s', async (_label, name) => {
    const res = await adminApi().post('/specializations').send({ name });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SPECIALIZATION_EXISTS');
  });

  it('409 when renaming to another existing name', async () => {
    const derma = await createSpecialization({ name: 'Dermatology' });

    expect(
      (await adminApi().patch(`/specializations/${derma.id}`).send({ name: 'cardiology' })).status,
    ).toBe(409);
  });

  it.each([
    ['1 letter', { name: 'A' }],
    ['empty', { name: '' }],
    ['missing', {}],
  ])('400 when creating with a %s name', async (_label, body) => {
    expect((await adminApi().post('/specializations').send(body)).status).toBe(400);
  });

  it('400 for an empty update; 404 for an unknown id', async () => {
    expect((await adminApi().patch(`/specializations/${cardio.id}`).send({})).status).toBe(400);
    expect((await adminApi().patch('/specializations/99999').send({ name: 'Xy' })).status).toBe(
      404,
    );
  });

  it.each(['PATIENT', 'DOCTOR'])(
    'a %s cannot create or change specializations (403)',
    async (role) => {
      const user = role === 'PATIENT' ? patient : doctorUser;

      expect((await as(user).post('/specializations').send({ name: 'Nope' })).status).toBe(403);
      expect(
        (await as(user).patch(`/specializations/${cardio.id}`).send({ name: 'Nope' })).status,
      ).toBe(403);
    },
  );
});

describe('Admin: all appointments (FR-6.3)', () => {
  let other;

  beforeEach(async () => {
    ({ doctor: other } = await createDoctor({ name: 'Dr. Other', specialization: cardio }));
    await book(patient, TUE, '10:00');
    await book(patient, WED, '11:00');
    await book(patient, THU, '12:00', other.id);
    const p2 = await createUser();
    const c = await book(p2, WED, '16:00', other.id);
    await as(p2).post(`/appointments/${c.id}/cancel`);
  });

  it('newest first with page info', async () => {
    const res = await adminApi().get('/appointments');

    expect(res.body.items.map((a) => a.date)).toEqual([THU, WED, WED, TUE]);
    expect(res.body).toMatchObject({ total: 4, page: 1, pageSize: 10, totalPages: 1 });
  });

  it('combines doctor + status + date range', async () => {
    const res = await adminApi().get(
      `/appointments?doctorId=${other.id}&status=BOOKED&from=${WED}&to=${THU}`,
    );

    expect(res.body.items.map((a) => [a.date, a.time])).toEqual([[THU, '12:00']]);
  });

  it.each([
    ['only from', `from=${WED}`, 3],
    ['only to', `to=${TUE}`, 1],
    ['one day (from = to)', `from=${WED}&to=${WED}`, 2],
    ['status CANCELLED', 'status=CANCELLED', 1],
  ])('filter %s', async (_label, query, total) => {
    expect((await adminApi().get(`/appointments?${query}`)).body.total).toBe(total);
  });

  it('pages with pageSize up to 50', async () => {
    const page2 = await adminApi().get('/appointments?pageSize=3&page=2');

    expect(page2.body).toMatchObject({ page: 2, totalPages: 2 });
    expect(page2.body.items).toHaveLength(1);
    expect((await adminApi().get('/appointments?pageSize=50')).status).toBe(200);
  });

  it.each([
    'doctorId=abc',
    'status=booked',
    'from=2030-02-30',
    `from=${THU}&to=${TUE}`,
    'page=0',
    'pageSize=51',
  ])('400 for %s', async (query) => {
    expect((await adminApi().get(`/appointments?${query}`)).status).toBe(400);
  });

  it('401 without a token; 403 for patients and doctors', async () => {
    expect((await api().get('/appointments')).status).toBe(401);
    expect((await as(patient).get('/appointments')).status).toBe(403);
    expect((await as(doctorUser).get('/appointments')).status).toBe(403);
  });
});

describe('Admin: cancel any appointment (FR-5.5)', () => {
  it('can cancel even after the start time; records the admin (FR-5.7)', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '10:15')));

    const res = await adminApi().post(`/appointments/${a.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ status: 'CANCELLED', cancelledBy: admin.id });
    const audit = await prisma.appointmentAudit.findMany({
      where: { appointmentId: a.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.at(-1)).toMatchObject({ newStatus: 'CANCELLED', changedBy: admin.id });
  });

  it('cannot cancel a COMPLETED appointment (409, FR-5.6)', async () => {
    const a = await book(patient, TUE, '10:00');
    freezeTime(new Date(at(TUE, '11:00')));
    await as(doctorUser).post(`/appointments/${a.id}/complete`);

    expect((await adminApi().post(`/appointments/${a.id}/cancel`)).status).toBe(409);
  });
});
