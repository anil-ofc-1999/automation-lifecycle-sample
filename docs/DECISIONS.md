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

## Still open

| # | Question |
|---|---|
| O-1 | Is MySQL needed at all in this sample? |
| O-2 | Exact PostgreSQL version (proposal: 17) |
| O-3 | Where will DEV / UAT / PROD run? |
| O-4 | Confirm business limits: 2-hour cancel window, 30-day advance, 1 booking per doctor per day |
| O-5 | Backend language: JavaScript or TypeScript? |
