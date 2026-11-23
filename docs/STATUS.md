# Project status — Doctor Appointment Booking

_Last updated: 2026-11-23._ Repos: **appointment_node_API** (API + shared docs) and
**appointment_web** (Angular). All work is on `develop`; `main` gets it through a pull
request (`develop → main`, "Create a merge commit").

## 1. Features — all 7 screens done

| #   | Feature (REQUIREMENTS §8)                                              | Who     | Status |
| --- | ---------------------------------------------------------------------- | ------- | ------ |
| 1   | Login / Register                                                       | Anyone  | ✅     |
| 2   | Doctor search (name, specialization, pages)                            | Patient | ✅     |
| 3   | Doctor detail + date picker + slot grid                                | Patient | ✅     |
| 4   | Booking confirmation                                                   | Patient | ✅     |
| 5   | My Appointments (Upcoming / Past, cancel, reschedule)                  | Patient | ✅     |
| 6   | Doctor dashboard (day view, completed / no-show, schedule, leave days) | Doctor  | ✅     |
| 7   | Admin panel (appointments, doctors, specializations)                   | Admin   | ✅     |
| —   | FR-7 emails to the patient: booked / cancelled / rescheduled (D-31)    | System  | ✅     |
| —   | Change password, signs out other sessions (D-32)                       | Anyone  | ✅     |
| —   | `npm run doctors:add`: 100 sample doctors, 17 specializations (D-33)   | Admin   | ✅     |
| —   | Admin reset password for doctors / patients (D-35)                     | Admin   | ✅     |

Every feature was finished end to end before the next one: API tests, web unit tests and
Playwright E2E — positive **and** negative scenarios.

## 2. Tests

| Layer                         | Tool                   | Count       | Command (repo)                   |
| ----------------------------- | ---------------------- | ----------- | -------------------------------- |
| API unit                      | Vitest + Supertest     | 126         | `npm test` (API)                 |
| API integration (real DB)     | Vitest, `itest` schema | 370         | `npm run test:integration` (API) |
| Web unit                      | Vitest via `ng test`   | 512         | `npm test` (web)                 |
| End-to-end (desktop + mobile) | Playwright             | 280 runs    | `npm run e2e` (web)              |
| Load (NFR-1, NFR-2)           | k6                     | 2 scenarios | `npm run load` (API)             |

- `npm run e2e:demo` (web) — watch the automation in Chrome, slowed down.
- Pre-commit hooks run lint + format + tests (+ build for web). GitHub CI (both repos) runs the
  same plus a gitleaks secret scan, CodeQL and the full E2E suite against a fresh PostgreSQL.
- E2E and load tests never touch real data: E2E uses `E2E …` / `e2e-*@example.com` records
  and deletes them; the load test uses its own `loadtest` schema.

## 3. Bugs found by the tests (all fixed, each with a regression test)

| Area | Bug                                                           | Fix                                                             |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| API  | Doctor search: `%` / `_` matched every doctor                 | LIKE wildcards escaped (D-27)                                   |
| API  | Slot grid offered slots > 30 days ahead that booking rejected | Slots limited to the booking window (D-27)                      |
| API  | Times stored 5.5 h off on a PostgreSQL server not in UTC      | Connections use `TimeZone=UTC`; CI DB runs in India time (D-28) |
| API  | Rename + change specialization in one edit → 500              | Relation update via `connect`                                   |
| API  | Booking slow under load (p95 704 ms)                          | Lock per doctor + day, pool 20, fewer queries (D-29)            |
| Web  | Session expired + Enter: stayed on page instead of login      | Typing timer no longer re-navigates                             |
| Web  | Same text after "Clear filters" did not search                | Compare with the active search                                  |
| Web  | Late typing timer undid "Clear filters" / opening a doctor    | Timer cancelled on explicit actions / leaving                   |
| Web  | Reschedule loaded slots twice (and for locked items)          | One combined load key                                           |
| Web  | Phone: floating booking bar covered slot buttons              | Bar in page flow on small screens                               |
| Web  | Phone: schedule form overlapped Save / Discard                | Stacked layout, 15-minute dropdowns                             |
| Web  | Fee ₹725.50 shown as ₹725.5                                   | Two decimals when there are paise                               |

## 4. Load test (NFR-1, NFR-2) — `npm run load`

50 patients (ramping up over 10 s, 1–3 s pauses like real people) search, open slots and
book for 45 s; then 50 patients book the same slot at once.

| p95            | Target                      | Result          |
| -------------- | --------------------------- | --------------- |
| Booking        | < 500 ms                    | 34–69 ms ✅     |
| Doctor search  | < 500 ms                    | 15–27 ms ✅     |
| Slots          | < 500 ms                    | 16–33 ms ✅     |
| Same-slot race | 1 × 201, 49 × 409, 1 stored | exactly that ✅ |

Stress run without pauses (`npm run load:stress`, ~70 requests/s on one laptop): booking
p95 ≈ 620 ms — recorded, not a target.

## 5. Security

- `npm audit --omit=dev`: **0** in both repos (fixed a high `effect` ReDoS via override, D-30).
- Full git-history secret scan: clean (`.env` never committed).
- Passwords bcrypt, JWT HS256 1 h, roles re-read from the DB on every request, inputs validated
  with zod, parameterised queries only, helmet headers, no bodies / tokens in logs.
- Rate limits per IP: login 5/min, **registration 10/min (new)**; `TRUST_PROXY_HOPS` for
  hosting behind a proxy (new, D-30). Open-redirect protection on login return URLs.
- Dependabot: weekly update PRs in both repos (new).
- gitleaks (whole history) and CodeQL (security-extended) run in CI on every push (2026-11-23).
- Both repos are public; history scanned clean before the API repo was opened.

## 6. Deployment plan — Render

| Part     | Render service     | Settings                                                                                                           |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Database | PostgreSQL 16      | Note the **Internal Database URL**                                                                                 |
| API      | Web Service (Node) | Build: `npm ci --include=dev` · Start: `npx prisma migrate deploy && node src/server.js` · Health check: `/health` |
| Web      | Static Site        | Build: `npm ci && npm run build` · Publish: `dist/appointment-web/browser`                                         |

API environment variables: `DATABASE_URL` (internal URL), `JWT_SECRET` (long random value —
let Render generate it), `JWT_EXPIRES_IN=1h`, `TRUST_PROXY_HOPS=1`, `DB_POOL_MAX` below the
database's connection limit (e.g. 10 on small plans).

Static site rewrite rules (same origin, so no CORS needed):

1. `/api/*` → `https://<api-name>.onrender.com/api/*` (Rewrite)
2. `/health` → `https://<api-name>.onrender.com/health` (Rewrite)
3. `/*` → `/index.html` (Rewrite — Angular routes such as `/doctors/5` on reload)

Notes: free web services sleep after 15 min idle (first request then takes ~1 min); free
PostgreSQL expires after 30 days. Seed data (`npm run db:seed`) only for a demo database —
change the seed passwords afterwards.

## 7. Open items

| Who  | Item                                                                                |
| ---- | ----------------------------------------------------------------------------------- |
| You  | Change the admin / sample account passwords on the live site (Change password page) |
| You  | Real emails: create an SMTP account, set `MAIL_MODE=smtp` + `SMTP_URL` on Render    |
| You  | Free Render PostgreSQL expires 2026-12-22: upgrade or recreate before then          |
| Open | UAT environment (O-3): a 2nd free Render database is not allowed on the free plan   |
