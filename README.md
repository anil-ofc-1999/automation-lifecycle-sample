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

| Tool           | Version                        | Check              |
| -------------- | ------------------------------ | ------------------ |
| Node.js        | 24.x                           | `node --version`   |
| npm            | 11.x                           | `npm --version`    |
| Git            | any recent                     | `git --version`    |
| Docker Desktop | latest (for PostgreSQL, later) | `docker --version` |

## Local setup

```powershell
npm install
copy .env.example .env      # first time only
npm run dev                 # http://localhost:3000/health
```

| Command                           | What it does                                                               |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                     | Start API with auto-reload                                                 |
| `npm start`                       | Start API (no reload)                                                      |
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
