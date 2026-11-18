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
npm run dev                 # http://localhost:3000/health -> "database": "up"
```

| Command                           | What it does                                                               |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                     | Start API with auto-reload                                                 |
| `npm start`                       | Start API (no reload)                                                      |
| `npm run db:migrate`              | Create/apply a Prisma migration (dev DB)                                   |
| `npm run db:studio`               | Browse the database in Prisma Studio                                       |
| `npm run lint`                    | ESLint                                                                     |
| `npm run format` / `format:check` | Prettier write / check                                                     |
| `npm test`                        | Run tests once                                                             |
| `npm run test:coverage`           | Tests + coverage report (`coverage/`)                                      |
| `npm run check`                   | Lint + format check + tests — **run before every push** (CI runs the same) |

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
| 2026-11-18 | GitHub Free does not enforce rulesets on **private** repos                        | Repo made public (no secrets / personal data in code). Same plan-dependency exists in Bitbucket ("Enforce merge checks" needs Premium) — check the plan before rolling out at the company. |
