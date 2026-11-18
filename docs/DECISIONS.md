# Decisions Log

Record every important technical decision here: what, why, and when.
Newest at the bottom. Change a decision by adding a new entry, not by editing an old one.

| # | Date | Decision | Reason | Status |
|---|---|---|---|---|
| D-1 | 2026-11-18 | Sample app: Doctor Appointment Booking | Realistic, relational data, natural concurrency case for testing | Accepted |
| D-2 | 2026-11-18 | GitHub + GitHub Actions (personal account) instead of Bitbucket | Personal sample; company Bitbucket can't be used. Concepts map back to Bitbucket Pipelines later | Accepted |
| D-3 | 2026-11-18 | Database: PostgreSQL (not MongoDB) | Matches company brief; relational booking data; DB-level unique constraint for double booking | Accepted |
| D-4 | 2026-11-18 | Backend: Node.js 24 + Express | Owner's choice; minimal and familiar | Accepted |
| D-5 | 2026-11-18 | ORM / migrations: Prisma | Schema file + generated migrations + typed client | Accepted |
| D-6 | 2026-11-18 | Mono-repo: `backend/` and `frontend/` in one repo | One CI setup, one PR per feature | Accepted |
| D-7 | 2026-11-18 | Local PostgreSQL via Docker Desktop | Same DB setup locally and in CI; easy reset | Accepted (Docker install pending) |
| D-8 | 2026-11-18 | Frontend: Angular 21 (CLI 21.2.10 installed), npm | Already installed on dev machine | Accepted |
| D-9 | 2026-11-18 | Backend language: JavaScript (ES modules); frontend stays TypeScript (Angular) | Owner's choice; familiar, no build step for the API | Accepted |
| D-10 | 2026-11-18 | Backend tests: Vitest + Supertest | Works with ES modules without extra config; built-in coverage | Accepted (can be revisited) |
| D-11 | 2026-11-18 | Backend lint/format: ESLint (flat config) + Prettier | Standard JS tooling; runs locally and in CI | Accepted |
| D-12 | 2026-11-18 | Env vars loaded with Node's built-in `--env-file-if-exists`; dev reload with `node --watch` | Fewer dependencies (no dotenv / nodemon) | Accepted |
| D-13 | 2026-11-18 | Rename `backend/` → `appointment_node_API/`, `frontend/` → `appointment_web/` (updates D-6 folder names) | Match company naming convention (`<project>_node`, `<project>_web`, e.g. AMS) | Accepted |

## Still open

| # | Question |
|---|---|
| O-1 | Is MySQL needed at all in this sample? |
| O-2 | Exact PostgreSQL version (proposal: 17) |
| O-3 | Where will DEV / UAT / PROD run? |
| O-4 | Confirm business limits: 2-hour cancel window, 30-day advance, 1 booking per doctor per day |
