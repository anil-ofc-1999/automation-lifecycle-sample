# appointment_node_API — Doctor Appointment Booking API

Express API for the Doctor Appointment Booking sample: a personal project for practising an
**automation-first engineering workflow** (CI, automated tests, security checks, DEV → UAT → PROD).

The Angular frontend lives in a separate repository: **appointment_web**.

- Requirements (shared by API and Web): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- Decisions log: [docs/DECISIONS.md](docs/DECISIONS.md)
- How we work (branches, commits, PRs): [CONTRIBUTING.md](CONTRIBUTING.md)

## Tech stack

| Layer            | Technology                                        |
| ---------------- | ------------------------------------------------- |
| Runtime          | Node.js 24 (see `.nvmrc`)                         |
| Framework        | Express 5 (JavaScript, ES modules)                |
| ORM / migrations | Prisma (to be added)                              |
| Database         | PostgreSQL (runs in Docker locally — to be added) |
| Tests            | Vitest + Supertest                                |
| Lint / format    | ESLint + Prettier                                 |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)       |

## Repository layout

```
.
├── src/
│   ├── app.js            Express app (no server start — used by tests)
│   ├── server.js         Starts the HTTP server
│   ├── config.js         Reads environment variables
│   ├── routes/           Route handlers (health.js, ...)
│   └── middleware/       Error handling, ...
├── tests/                Vitest + Supertest tests
├── docs/                 Requirements and decisions (shared with appointment_web)
├── .github/
│   ├── workflows/ci.yml  Lint, format, tests, audit on every PR
│   └── pull_request_template.md
├── .env.example          Environment template (placeholders only)
└── .nvmrc                Node.js major version (24)
```

## Prerequisites

| Tool       | Version                | Check            |
| ---------- | ---------------------- | ---------------- |
| Node.js    | 24.x                   | `node --version` |
| npm        | 11.x                   | `npm --version`  |
| Git        | any recent             | `git --version`  |
| PostgreSQL | 16.x (team uses 16.14) | `psql --version` |

## Database setup (first time only)

Install PostgreSQL 16 for Windows (EDB installer), add `C:\Program Files\PostgreSQL\16\bin` to PATH, then:

```powershell
psql -U postgres
```

```sql
CREATE USER app_user WITH PASSWORD 'your_password';
CREATE DATABASE appointments OWNER app_user;
\q
```

Put the same password in `DATABASE_URL` in your `.env`. Avoid `#`, `@`, `/` in the password (they break the URL).

## Local setup

```powershell
npm install                 # also runs `prisma generate`
copy .env.example .env      # first time only, then set DATABASE_URL
npm run db:deploy           # create / update the tables
npm run db:seed             # optional: fake doctors / patients (login password: Password123)
npm run dev                 # http://localhost:3000/health -> "database": "up"
```

| Command                           | What it does                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                     | Start API with auto-reload                                                              |
| `npm start`                       | Start API (no reload)                                                                   |
| `npm run db:deploy`               | Apply all migration files to your local DB (run after `git pull`)                       |
| `npm run db:seed`                 | Fill the DB with fake test data (REQUIREMENTS §11); safe to re-run                      |
| `npm run db:migrate`              | Create/apply a Prisma migration (dev DB)                                                |
| `npm run db:studio`               | Browse the database in Prisma Studio                                                    |
| `npm run lint`                    | ESLint                                                                                  |
| `npm run format` / `format:check` | Prettier write / check                                                                  |
| `npm test`                        | Run tests once                                                                          |
| `npm run test:coverage`           | Tests + coverage report (`coverage/`)                                                   |
| `npm run check`                   | Lint + format + unit + integration tests — **run before every push** (CI runs the same) |

## API endpoints

Base path `/api/v1`. Full contract: [docs/openapi.yaml](docs/openapi.yaml) (OpenAPI 3.1, checked by tests).
Errors use `{ "error": { "code", "message", "details"? } }` (REQUIREMENTS §7).

| Method | Path                                 | Role             | Purpose                                   |
| ------ | ------------------------------------ | ---------------- | ----------------------------------------- |
| POST   | `/auth/register`                     | Public           | Patient registration (FR-1)               |
| POST   | `/auth/login`                        | Public           | Login, 1-hour Bearer token (FR-1)         |
| GET    | `/me`                                | Any              | Current user profile                      |
| GET    | `/specializations`                   | Any              | List specializations                      |
| POST   | `/specializations`                   | Admin            | Create (FR-2.1)                           |
| PATCH  | `/specializations/:id`               | Admin            | Rename / (de)activate (FR-2.1)            |
| GET    | `/doctors`                           | Any              | List / search / paginate (FR-2.4, FR-2.5) |
| GET    | `/doctors/:id`                       | Any              | Doctor details                            |
| POST   | `/doctors`                           | Admin            | Create doctor + login (FR-2.2)            |
| PATCH  | `/doctors/:id`                       | Admin            | Update / (de)activate (FR-2.3)            |
| GET    | `/doctors/:id/slots?date=YYYY-MM-DD` | Any              | Slots AVAILABLE / BOOKED (FR-3.4, FR-3.5) |
| GET    | `/doctors/me/schedule`               | Doctor           | Own weekly schedule                       |
| PUT    | `/doctors/me/schedule`               | Doctor           | Replace weekly schedule (FR-3.1, FR-3.2)  |
| GET    | `/doctors/me/leaves`                 | Doctor           | Upcoming leave dates                      |
| POST   | `/doctors/me/leaves`                 | Doctor           | Add leave date (FR-3.3)                   |
| DELETE | `/doctors/me/leaves/:date`           | Doctor           | Remove leave date                         |
| POST   | `/appointments`                      | Patient          | Book a slot (FR-4)                        |
| GET    | `/appointments/me`                   | Patient / Doctor | Own appointments (FR-6.1, FR-6.2)         |
| GET    | `/appointments`                      | Admin            | All appointments, filters (FR-6.3)        |
| POST   | `/appointments/:id/cancel`           | Patient / Admin  | Cancel (FR-5.1, FR-5.5)                   |
| POST   | `/appointments/:id/reschedule`       | Patient          | Reschedule atomically (FR-5.2)            |
| POST   | `/appointments/:id/complete`         | Doctor           | Mark completed (FR-5.4)                   |
| POST   | `/appointments/:id/no-show`          | Doctor           | Mark no-show (FR-5.4)                     |

Login is limited to 5 attempts per minute per IP (NFR-3).
Seeded accounts (`npm run db:seed`) log in with password `Password123`, e.g. `admin@example.com`,
`arjun.rao@example.com` (doctor), `asha.reddy@example.com` (patient).

## Tests

| Command                    | What runs                                                                    |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm test`                 | Unit tests (fake database, fast)                                             |
| `npm run test:integration` | Real-PostgreSQL tests in a separate `itest` schema — never touches your data |
| `npm run check`            | Lint + format + unit + integration (pre-commit hook and CI run this)         |
| `npm run load`             | k6 load test for NFR-1 / NFR-2 (needs [k6](https://k6.io) installed)         |
| `npm run load:stress`      | Same without think time — a stress number, not a pass/fail target            |

GitHub Actions (`.github/workflows`) runs on every push to `develop` / `main` and every PR:
`npm run check` + audit, a **gitleaks** secret scan of the whole history, **CodeQL**, and the
full **Playwright E2E** suite (this API + the web app + a throw-away PostgreSQL).

## Emails (FR-7)

The patient gets an email after booking, cancelling (by them or the clinic) and
rescheduling. `MAIL_MODE` decides what happens (D-31):

| `MAIL_MODE` | What happens                                                 | Used by                 |
| ----------- | ------------------------------------------------------------ | ----------------------- |
| `memory`    | Captured in memory, never sent                               | tests (default)         |
| `log`       | One JSON log line: event, masked address, subject — not sent | local, Render (default) |
| `smtp`      | Really sent through `SMTP_URL`; `MAIL_FROM` is the sender    | once an account exists  |

Keep `SMTP_URL` (it contains the mail password) in `.env` / the Render dashboard, never in git.

### Load test (NFR-1, NFR-2)

`npm run load` re-creates a separate `loadtest` schema (migrate + seed — your data is never
touched), starts its own API on port 3200 and runs `load/booking-load.js`:

- **browse_and_book** — 50 patients (ramping up over 10 s) search doctors, open slots and
  book, pausing 1–3 s between actions. Pass: p95 < 500 ms for search, slots and booking.
- **same_slot_race** — 50 patients book the same slot at the same moment. Pass: exactly 1 × 201,
  49 × 409, and exactly 1 booking stored.

Results on the development laptop (API, PostgreSQL and k6 on one machine), 2026-11-22:

| p95            | NFR-1 run (`npm run load`) | Stress (`npm run load:stress`, ~70 req/s) |
| -------------- | -------------------------- | ----------------------------------------- |
| Booking        | 66–69 ms ✅                | 621 ms                                    |
| Doctor search  | 25–27 ms ✅                | 281 ms                                    |
| Slots          | 33 ms ✅                   | 385 ms                                    |
| Same-slot race | 1 booked / 49 conflicts ✅ | 1 booked / 49 conflicts                   |

## Branch protection

`main` is protected by the `protect-main` ruleset: changes only via pull request, the
**Backend - lint, format, test** check must pass, no force pushes, no deletion.

## Secrets

Never commit real secrets. Copy `.env.example` to `.env` and fill in local values.
`.env` files are git-ignored.

## Known findings

| Date       | Finding                                                                           | Decision                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-18 | `npm audit`: 6 high (ReDoS in `picomatch`) via Vitest — **dev dependencies only** | Accepted for now: not shipped to production (`npm audit --omit=dev` = 0). Re-check on Vitest updates.                                                                                      |
| 2026-11-22 | `npm audit --omit=dev`: 3 high (ReDoS in `effect` ≤ 3.22.0) via the Prisma CLI    | Fixed: `overrides.effect = 3.22.5` (same major version; Prisma generate / migrate verified). Remove the override once Prisma ships a fixed `effect`. Audit now 0.                          |
| 2026-11-22 | Registration had no rate limit (bulk account creation)                            | Fixed: 10 per minute per IP (`REGISTER_RATE_LIMIT_PER_MINUTE`), D-30.                                                                                                                      |
| 2026-11-22 | Behind a hosting proxy all users would share one IP for rate limits               | Fixed: `TRUST_PROXY_HOPS` (set `1` on Render, `0` locally so `X-Forwarded-For` cannot be faked), D-30.                                                                                     |
| 2026-11-22 | Secret scan of the full git history (both repos)                                  | Clean: `.env` never committed, only `CHANGE_ME` placeholders and test-only values. Dependabot added (weekly, both repos). 2026-11-23: gitleaks + CodeQL now run in CI.                     |
| 2026-11-18 | GitHub Free does not enforce rulesets on **private** repos                        | Repo made public (no secrets / personal data in code). Same plan-dependency exists in Bitbucket ("Enforce merge checks" needs Premium) — check the plan before rolling out at the company. |
