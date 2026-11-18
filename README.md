# Automation Lifecycle Sample — Doctor Appointment Booking

Personal sample project for practising an **automation-first engineering workflow**
(CI, automated tests, security checks, DEV → UAT → PROD promotion) on a realistic app:
patients book appointments with doctors.

- Requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- Decisions log: [docs/DECISIONS.md](docs/DECISIONS.md)
- How we work (branches, commits, PRs): [CONTRIBUTING.md](CONTRIBUTING.md)

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 24 + Express (JavaScript, ES modules) |
| Backend tests / lint | Vitest + Supertest, ESLint, Prettier |
| ORM / migrations | Prisma |
| Database | PostgreSQL (runs in Docker locally) |
| Frontend | Angular 21 |
| Package manager | npm |
| Source control / CI | GitHub + GitHub Actions |

## Repository layout

```
.
├── backend/              Express API
│   ├── src/              app.js, server.js, routes/, middleware/
│   └── tests/            Vitest + Supertest tests
├── frontend/             Angular app (to be scaffolded)
├── docs/                 Requirements, decisions, architecture
├── .github/
│   ├── workflows/        GitHub Actions pipelines (to be added)
│   └── pull_request_template.md
├── .editorconfig         Shared formatting basics
├── .gitattributes        Line-ending normalisation (LF)
├── .gitignore
└── .nvmrc                Node.js major version (24)
```

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 24.x | `node --version` |
| npm | 11.x | `npm --version` |
| Git | any recent | `git --version` |
| Angular CLI | 21.x | `ng version` |
| Docker Desktop | latest | `docker --version` |

## Local setup

### Backend

```powershell
cd backend
npm install
copy .env.example .env      # first time only
npm run dev                 # http://localhost:3000/health
```

| Command | What it does |
|---|---|
| `npm run dev` | Start API with auto-reload |
| `npm start` | Start API (no reload) |
| `npm run lint` | ESLint |
| `npm run format` / `format:check` | Prettier write / check |
| `npm test` | Run tests once |
| `npm run test:coverage` | Tests + coverage report (`coverage/`) |
| `npm run check` | Lint + format check + tests — **run before every push** (CI runs the same) |

### Frontend / database

> Will be added in the next steps.

## Known findings

| Date | Finding | Decision |
|---|---|---|
| 2026-11-18 | `npm audit`: 6 high (ReDoS in `picomatch`) via Vitest — **dev dependencies only** | Accepted for now: not shipped to production (`npm audit --omit=dev` = 0). Re-check on Vitest updates. |

## Secrets

Never commit real secrets. Copy `.env.example` to `.env` and fill in local values.
`.env` files are git-ignored.
