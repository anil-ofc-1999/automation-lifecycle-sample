// k6 load test — run with `npm run load` (see load/run.mjs).
//
// Scenario "browse_and_book" (NFR-1): 50 patients at the same time search doctors, open
//   slots and book for 45 s, pausing 1–3 s between actions like real people.
//   Target: p95 < 500 ms for slots and booking, < 1 % server errors.
//   STRESS=1 removes the pauses (each user acts every ~0.5 s): a stress number, not NFR-1.
// Scenario "same_slot_race" (NFR-2): afterwards 50 patients book THE SAME slot at once.
//   Target: exactly 1 success (201) and 49 conflicts (409), and only 1 booking stored.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = `${__ENV.BASE_URL || 'http://localhost:3200'}/api/v1`;
const USERS = 100; // 50 for each scenario
const PASSWORD = 'Password123';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const STRESS = __ENV.STRESS === '1';
/** Think time between user actions (none under STRESS). */
const think = () => sleep(STRESS ? 0 : 1 + Math.random() * 2);

const raceSuccess = new Counter('race_booking_success');
const raceConflict = new Counter('race_booking_conflict');
const raceOther = new Counter('race_booking_other');

export const options = {
  scenarios: {
    browse_and_book: {
      // Users arrive over 10 s (not all in the same millisecond), then 50 stay busy.
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '35s', target: 50 },
      ],
      gracefulRampDown: '5s',
      exec: 'browseAndBook',
    },
    same_slot_race: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      startTime: '50s',
      exec: 'sameSlotRace',
    },
  },
  thresholds: {
    // NFR-1 (STRESS runs only report these numbers, with a loose 5 s sanity limit)
    'http_req_duration{name:slots}': [STRESS ? 'p(95)<5000' : 'p(95)<500'],
    'http_req_duration{name:book}': [STRESS ? 'p(95)<5000' : 'p(95)<500'],
    'http_req_duration{name:doctors}': [STRESS ? 'p(95)<5000' : 'p(95)<500'],
    // Server errors / network failures only (409 conflicts are expected answers).
    'checks{type:no_server_error}': ['rate>0.99'],
    // NFR-2
    race_booking_success: ['count==1'],
    race_booking_conflict: ['count==49'],
    race_booking_other: ['count==0'],
  },
};

/** Clinic (UTC+05:30) date string, `days` from now. */
function clinicDate(days) {
  const d = new Date(Date.now() + 330 * 60_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Next date (from `fromDay` on) that is not a Sunday — seed doctors work Mon–Sat. */
function workingDate(fromDay) {
  for (let i = fromDay; i < fromDay + 7; i += 1) {
    const date = clinicDate(i);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) return date;
  }
  return clinicDate(fromDay);
}

export function setup() {
  // Patients: register + log in (the load-test API has a high login limit).
  const tokens = [];
  for (let i = 0; i < USERS; i += 1) {
    const email = `load-${i}-${Date.now()}@example.com`;
    const body = JSON.stringify({ name: `Load Patient ${i}`, email, password: PASSWORD });
    http.post(`${BASE}/auth/register`, body, { headers: JSON_HEADERS });
    const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
      headers: JSON_HEADERS,
    });
    tokens.push(login.json('accessToken'));
  }

  const doctors = http
    .get(`${BASE}/doctors?pageSize=50`, { headers: { Authorization: `Bearer ${tokens[0]}` } })
    .json('items')
    .map((d) => d.id);
  if (doctors.length === 0) throw new Error('No doctors — did the seed run?');

  // The race slot: last doctor, a working day ~3 weeks ahead (browsing uses days 1–14).
  const raceDate = workingDate(21);
  const raceSlots = http
    .get(`${BASE}/doctors/${doctors[doctors.length - 1]}/slots?date=${raceDate}`, {
      headers: { Authorization: `Bearer ${tokens[0]}` },
    })
    .json('slots');
  return {
    tokens,
    doctors,
    race: { doctorId: doctors[doctors.length - 1], startAt: raceSlots[0].startAt },
  };
}

const auth = (token) => ({ headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` } });
const noServerError = (res) =>
  check(
    res,
    { 'no 5xx / network error': (r) => r.status > 0 && r.status < 500 },
    {
      type: 'no_server_error',
    },
  );

export function browseAndBook(data) {
  const vu = exec.vu.idInTest; // 1..50
  const token = data.tokens[vu - 1];
  const doctorId = data.doctors[Math.floor(Math.random() * data.doctors.length)];
  const date = workingDate(1 + Math.floor(Math.random() * 14));

  noServerError(
    http.get(`${BASE}/doctors?search=dr&pageSize=10`, {
      ...auth(token),
      tags: { name: 'doctors' },
    }),
  );
  think(); // reads the list, picks a doctor

  const slotsRes = http.get(`${BASE}/doctors/${doctorId}/slots?date=${date}`, {
    ...auth(token),
    tags: { name: 'slots' },
  });
  noServerError(slotsRes);
  think(); // looks at the slot grid

  const free = (slotsRes.json('slots') || []).filter((s) => s.status === 'AVAILABLE');
  if (free.length > 0) {
    const slot = free[Math.floor(Math.random() * free.length)];
    const book = http.post(
      `${BASE}/appointments`,
      JSON.stringify({ doctorId, startAt: slot.startAt }),
      { ...auth(token), tags: { name: 'book' } },
    );
    // 201 booked, or 409 (taken meanwhile / one per doctor per day) — both are correct.
    check(book, { 'booked or clean conflict': (r) => r.status === 201 || r.status === 409 });
    noServerError(book);
  }
  sleep(STRESS ? 0.5 : 1 + Math.random() * 2);
}

export function sameSlotRace(data) {
  const vu = exec.vu.idInTest; // 51..100 in this scenario
  const token = data.tokens[(vu - 1) % data.tokens.length];
  const res = http.post(
    `${BASE}/appointments`,
    JSON.stringify({ doctorId: data.race.doctorId, startAt: data.race.startAt }),
    { ...auth(token), tags: { name: 'race' } },
  );
  if (res.status === 201) raceSuccess.add(1);
  else if (res.status === 409) raceConflict.add(1);
  else raceOther.add(1);
}

export function teardown(data) {
  // Exactly one stored booking for the race slot (checked through the admin API).
  const admin = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: 'admin@example.com', password: PASSWORD }),
    { headers: JSON_HEADERS },
  );
  const date = data.race.startAt.slice(0, 10);
  const list = http.get(
    `${BASE}/appointments?doctorId=${data.race.doctorId}&status=BOOKED&pageSize=50`,
    auth(admin.json('accessToken')),
  );
  const atRaceSlot = (list.json('items') || []).filter((a) => a.startAt === data.race.startAt);
  check(atRaceSlot, {
    'NFR-2: exactly one booking stored for the race slot': (a) => a.length === 1,
  });
  console.log(`Race slot ${data.race.startAt} (${date}): ${atRaceSlot.length} booking(s) stored.`);
}
