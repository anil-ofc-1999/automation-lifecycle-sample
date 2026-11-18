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
| Backend | Node.js 24 + Express |
| ORM / migrations | Prisma |
| Database | PostgreSQL (runs in Docker locally) |
| Frontend | Angular 21 |
| Package manager | npm |
| Source control / CI | GitHub + GitHub Actions |

## Repository layout

```
.
├── backend/              Express API (to be scaffolded)
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

> Will be filled in as backend, frontend and database are added.

## Secrets

Never commit real secrets. Copy `.env.example` to `.env` and fill in local values.
`.env` files are git-ignored.
