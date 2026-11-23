// D-33: add-doctors script logic with a fake API (no database).
// The real API + PostgreSQL run is in tests/integration/addDoctors.test.js.
import { describe, it, expect } from 'vitest';

import { addDoctors, validateData } from '../scripts/lib/addDoctors.mjs';

const SCHEDULES = { day: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] };
const doctor = (n, overrides = {}) => ({
  name: `Dr. Test ${n}`,
  email: `test.${n}@example.com`,
  specialization: 'Cardiology',
  fee: 500,
  slotMinutes: 30,
  schedule: 'day',
  ...overrides,
});
const file = (overrides = {}) => ({
  specializations: ['Cardiology', 'Neurology'],
  schedules: SCHEDULES,
  doctors: [doctor(1), doctor(2, { specialization: 'Neurology' })],
  ...overrides,
});

/** In-memory stand-in for the API, with a call log. */
function fakeApi({ specs = [], doctors = [], takenEmails = [] } = {}) {
  const state = { specs: [...specs], doctors: [...doctors], schedules: {}, calls: [] };
  let nextId = 100;
  const client = async (method, path, body) => {
    state.calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.startsWith('/specializations')) {
      return { status: 200, body: { items: state.specs } };
    }
    if (method === 'GET' && path.startsWith('/doctors')) {
      const page = Number(new URL(`http://x${path}`).searchParams.get('page'));
      const items = state.doctors.slice((page - 1) * 50, page * 50);
      const totalPages = Math.max(1, Math.ceil(state.doctors.length / 50));
      return { status: 200, body: { items, totalPages } };
    }
    if (method === 'POST' && path === '/specializations') {
      const spec = { id: (nextId += 1), name: body.name, isActive: true };
      state.specs.push(spec);
      return { status: 201, body: { specialization: spec } };
    }
    if (method === 'POST' && path === '/doctors') {
      if (takenEmails.includes(body.email)) {
        return { status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'exists' } } };
      }
      const d = { id: (nextId += 1), ...body };
      state.doctors.push(d);
      return { status: 201, body: { doctor: d } };
    }
    if (method === 'PUT' && path.endsWith('/schedule')) {
      state.schedules[path.split('/')[2]] = body.blocks;
      return { status: 200, body: { blocks: body.blocks } };
    }
    return { status: 500, body: { error: { message: 'boom' } } };
  };
  return { client, state };
}

describe('validateData — negative (the file is checked before anything is sent)', () => {
  it.each([
    [
      'same email twice (case-insensitive)',
      file({ doctors: [doctor(1), doctor(2, { email: 'TEST.1@example.com' })] }),
      'email listed twice',
    ],
    [
      'same name twice',
      file({ doctors: [doctor(1), doctor(2, { name: 'dr. test 1' })] }),
      'name listed twice',
    ],
    [
      'same specialization twice',
      file({ specializations: ['Cardiology', ' cardiology ', 'Neurology'] }),
      'listed twice',
    ],
    [
      'doctor with an unlisted specialization',
      file({ doctors: [doctor(1, { specialization: 'Dentistry' })] }),
      'not in the list',
    ],
    ['unknown schedule', file({ doctors: [doctor(1, { schedule: 'night' })] }), 'unknown schedule'],
    ['slot of 20 minutes', file({ doctors: [doctor(1, { slotMinutes: 20 })] }), 'slotMinutes'],
    ['bad email', file({ doctors: [doctor(1, { email: 'no-at-sign' })] }), 'invalid email'],
    ['negative fee', file({ doctors: [doctor(1, { fee: -5 })] }), 'fee'],
    ['missing lists', {}, 'needs "specializations" and "doctors"'],
  ])('%s', (_name, data, message) => {
    expect(validateData(data).join('\n')).toContain(message);
  });

  it('a bad file sends nothing at all', async () => {
    const { client, state } = fakeApi();
    const bad = file({ doctors: [doctor(1), doctor(1)] });

    await expect(addDoctors({ client, data: bad, doctorPassword: 'x' })).rejects.toThrow('problem');
    expect(state.calls).toEqual([]);
  });

  it('the shipped data file is valid: 100 doctors, unique emails and names', async () => {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(
      readFileSync(new URL('../scripts/data/doctors.json', import.meta.url), 'utf8'),
    );

    expect(validateData(data)).toEqual([]);
    expect(data.doctors).toHaveLength(100);
    expect(data.doctors.every((d) => d.email.endsWith('@example.com'))).toBe(true); // NFR-5
  });
});

describe('addDoctors — positive', () => {
  it('creates missing specializations and doctors and sets each schedule', async () => {
    const { client, state } = fakeApi();

    const s = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(s.specializations.created).toEqual(['Cardiology', 'Neurology']);
    expect(s.doctors.created).toEqual(['test.1@example.com', 'test.2@example.com']);
    expect(state.doctors.map((d) => d.password)).toEqual(['DoctorPass2030', 'DoctorPass2030']);
    expect(Object.values(state.schedules)).toEqual([SCHEDULES.day, SCHEDULES.day]);
  });

  it('matches specializations ignoring case and spaces (no "cardiology" duplicate)', async () => {
    const { client, state } = fakeApi({ specs: [{ id: 1, name: 'cardiology', isActive: true }] });

    const s = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(s.specializations.existing).toEqual(['cardiology']);
    expect(s.specializations.created).toEqual(['Neurology']);
    expect(state.doctors[0].specializationId).toBe(1); // uses the existing one
  });

  it('skips doctors whose email already exists (ignoring case)', async () => {
    const { client, state } = fakeApi({
      doctors: [{ id: 1, name: 'Dr. Test 1', email: 'Test.1@Example.com' }],
    });

    const s = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(s.doctors.existing).toEqual(['test.1@example.com']);
    expect(s.doctors.created).toEqual(['test.2@example.com']);
    expect(state.doctors).toHaveLength(2);
  });

  it('reads every page of existing doctors (more than 50)', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: i, email: `old.${i}@example.com` }));
    const { client, state } = fakeApi({ doctors: many });

    await addDoctors({
      client,
      data: file({ doctors: [doctor(1, { email: 'old.119@example.com' })] }),
      doctorPassword: 'DoctorPass2030',
    });

    expect(state.calls.filter((c) => c === 'GET /doctors')).toHaveLength(3);
    expect(state.doctors).toHaveLength(120); // the one on page 3 was found, not re-added
  });

  it('running twice adds nothing the second time', async () => {
    const { client, state } = fakeApi();
    await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    const again = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(again.specializations.created).toEqual([]);
    expect(again.doctors.created).toEqual([]);
    expect(state.specs).toHaveLength(2);
    expect(state.doctors).toHaveLength(2);
  });

  it('dry run: reports what would be added and changes nothing', async () => {
    const { client, state } = fakeApi();

    const s = await addDoctors({ client, data: file(), dryRun: true });

    expect(s.specializations.created).toHaveLength(2);
    expect(s.doctors.created).toHaveLength(2);
    expect(state.calls.every((c) => c.startsWith('GET'))).toBe(true);
  });
});

describe('addDoctors — negative', () => {
  it('an inactive specialization is left alone and its doctors are skipped', async () => {
    const { client, state } = fakeApi({ specs: [{ id: 1, name: 'Cardiology', isActive: false }] });

    const s = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(s.specializations.inactive).toEqual(['Cardiology']);
    expect(s.doctors.skipped).toEqual([
      { email: 'test.1@example.com', reason: 'Cardiology is inactive' },
    ]);
    expect(state.calls).not.toContain('PATCH /specializations/1');
  });

  it('an email used by a patient account is skipped, not overwritten', async () => {
    const { client } = fakeApi({ takenEmails: ['test.1@example.com'] });

    const s = await addDoctors({ client, data: file(), doctorPassword: 'DoctorPass2030' });

    expect(s.doctors.skipped).toEqual([
      { email: 'test.1@example.com', reason: 'email used by another account' },
    ]);
    expect(s.doctors.created).toEqual(['test.2@example.com']);
  });

  it('any other API error stops the run with a clear message', async () => {
    const { client } = fakeApi();
    const failing = async (method, path, body) =>
      method === 'POST' && path === '/doctors'
        ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Bad fee.' } } }
        : client(method, path, body);

    await expect(
      addDoctors({ client: failing, data: file(), doctorPassword: 'DoctorPass2030' }),
    ).rejects.toThrow('POST /doctors: Bad fee.');
  });
});
