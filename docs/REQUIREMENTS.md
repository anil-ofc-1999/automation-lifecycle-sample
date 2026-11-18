# Doctor Appointment Booking — Requirements

| Item         | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| Document     | Software Requirements (MVP)                                  |
| Version      | 0.1 (Draft)                                                  |
| Date         | 18 November 2026                                             |
| Status       | Draft — pending owner review                                 |
| Project type | Personal sample project for the engineering-automation pilot |
| Related      | `PROJECT_CONTEXT_ENGINEERING_AUTOMATION.md`                  |

> Rules, limits and targets in this document are **proposed defaults** for a sample project.
> The project owner can change them; tests must follow the approved version of this file.

---

## 1. Purpose

Build a small but realistic web application where patients book appointments with doctors.
The project is mainly a vehicle to practise an **automation-first engineering workflow**:
CI, automated tests (unit, API, DB, E2E, load), security checks, and DEV → UAT → PROD promotion.

## 2. Scope

### 2.1 In scope (MVP)

- User registration and login with roles
- Doctor and specialization management
- Doctor weekly availability and leave
- Slot generation, booking, cancellation, rescheduling
- Patient, doctor and admin views
- API documentation (OpenAPI / Swagger)

### 2.2 Out of scope (later phases)

- Online payments
- Video consultation
- Prescriptions and medical records
- SMS / WhatsApp notifications
- Mobile apps
- Multi-clinic / multi-branch support

## 3. Technology context

| Layer                      | Choice                                                                             | Status                                  |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Backend                    | Node.js 24 + Express, JavaScript (ES modules)                                      | Confirmed                               |
| Frontend                   | Angular 21, npm                                                                    | Confirmed                               |
| Database                   | PostgreSQL + Prisma (local via Docker)                                             | Confirmed (exact Postgres version open) |
| MySQL                      | —                                                                                  | **Open:** needed or not?                |
| Source control / CI        | GitHub + GitHub Actions (personal)                                                 | Confirmed                               |
| Repo layout                | Two repos: `appointment_node_API` (API + shared docs), `appointment_web` (Angular) | Confirmed                               |
| Hosting (DEV / UAT / PROD) | —                                                                                  | Open                                    |

See [DECISIONS.md](DECISIONS.md) for reasons and dates.

## 4. Users and roles

| Role        | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| **Patient** | Registers self, searches doctors, books and manages own appointments |
| **Doctor**  | Account created by admin; manages own availability and appointments  |
| **Admin**   | Manages doctors, specializations, and can view all appointments      |

A user has exactly **one** role.

## 5. Functional requirements

Each requirement has an ID so that tests and pull requests can reference it (e.g. `FR-4.2`).

### FR-1 Authentication and authorization

| ID     | Requirement                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------- |
| FR-1.1 | A patient can register with name, email, phone (optional) and password.                         |
| FR-1.2 | Email must be unique (case-insensitive).                                                        |
| FR-1.3 | Password must be at least 8 characters and contain at least one letter and one number.          |
| FR-1.4 | Passwords are stored only as secure hashes (e.g. bcrypt). Never stored or logged in plain text. |
| FR-1.5 | Login with email + password returns an access token (JWT).                                      |
| FR-1.6 | Access token expires after a configured time (default 1 hour).                                  |
| FR-1.7 | Every protected API checks the token and the user's role.                                       |
| FR-1.8 | Doctor and admin accounts cannot be self-registered; only admin creates them.                   |

**Acceptance criteria**

- Registering with an existing email fails with a clear error.
- Wrong password and unknown email return the **same** generic error message (no user enumeration).
- Calling an API without a token → `401`; with a token of the wrong role → `403`.

### FR-2 Specializations and doctors

| ID     | Requirement                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| FR-2.1 | Admin can create, rename and deactivate specializations (e.g. Cardiology, Dermatology).                                          |
| FR-2.2 | Admin can create a doctor with: name, email, specialization, consultation fee, slot duration (15 or 30 minutes), bio (optional). |
| FR-2.3 | Admin can activate / deactivate a doctor. Inactive doctors are hidden from patients and cannot be booked.                        |
| FR-2.4 | Patients can list doctors, filter by specialization, and search by name (partial, case-insensitive).                             |
| FR-2.5 | Doctor list supports pagination (default 10 per page, max 50).                                                                   |

### FR-3 Availability

| ID     | Requirement                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-3.1 | A doctor defines a weekly schedule: day of week + start time + end time. Multiple blocks per day allowed (e.g. 10:00–13:00 and 16:00–19:00). |
| FR-3.2 | Schedule blocks for the same day must not overlap.                                                                                           |
| FR-3.3 | A doctor can mark leave dates; no slots are offered on those dates.                                                                          |
| FR-3.4 | The system generates slots from the schedule using the doctor's slot duration. Partial slots at the end of a block are not offered.          |
| FR-3.5 | Slots API returns, for a doctor and a date, each slot with status `AVAILABLE` or `BOOKED`.                                                   |
| FR-3.6 | Changing the schedule does not cancel existing bookings.                                                                                     |

**Example:** schedule 10:00–11:00, slot duration 30 min → slots 10:00 and 10:30.

### FR-4 Booking (core)

| ID     | Requirement                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-4.1 | A patient can book an `AVAILABLE` slot of an active doctor.                                                                                                                                                           |
| FR-4.2 | Slots in the past cannot be booked.                                                                                                                                                                                   |
| FR-4.3 | Bookings are allowed at most **30 days** in advance.                                                                                                                                                                  |
| FR-4.4 | **One slot can have only one active booking.** If two patients book the same slot at the same time, exactly one succeeds; the other gets a conflict error. This must be enforced at database level, not only in code. |
| FR-4.5 | A patient can have at most **one active booking per doctor per day**.                                                                                                                                                 |
| FR-4.6 | Booking on a doctor's leave date or outside schedule is rejected.                                                                                                                                                     |
| FR-4.7 | A new booking has status `BOOKED`.                                                                                                                                                                                    |

### FR-5 Appointment lifecycle

Status flow:

```
BOOKED ──► COMPLETED     (doctor)
   │──────► NO_SHOW       (doctor, only after appointment start time)
   └──────► CANCELLED     (patient or admin)
```

| ID     | Requirement                                                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-5.1 | A patient can cancel own `BOOKED` appointment up to **2 hours** before start time.                                                                                                                                                 |
| FR-5.2 | A patient can reschedule own `BOOKED` appointment up to 2 hours before start time, to another available slot of the **same doctor**. Rescheduling is atomic: the old slot is released only if the new slot is booked successfully. |
| FR-5.3 | Cancelled slots become available again.                                                                                                                                                                                            |
| FR-5.4 | A doctor can mark own appointments `COMPLETED` or `NO_SHOW` only after the appointment start time.                                                                                                                                 |
| FR-5.5 | Admin can cancel any `BOOKED` appointment (no time limit).                                                                                                                                                                         |
| FR-5.6 | `COMPLETED`, `CANCELLED`, `NO_SHOW` are final; no further transitions.                                                                                                                                                             |
| FR-5.7 | Every status change records who changed it and when (audit).                                                                                                                                                                       |

### FR-6 Views

| ID     | Requirement                                                                       |
| ------ | --------------------------------------------------------------------------------- |
| FR-6.1 | Patient: list of own appointments, split into Upcoming and Past, newest first.    |
| FR-6.2 | Doctor: own appointments for a selected date, with patient name and status.       |
| FR-6.3 | Admin: all appointments with filters by doctor, date range and status, paginated. |

### FR-7 Notifications (Phase 2 — optional)

| ID     | Requirement                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| FR-7.1 | On booking / cancel / reschedule, send an email to the patient.                                              |
| FR-7.2 | In DEV and test environments, emails are not really sent; they are logged or captured by a mock mail server. |

## 6. Data model (proposed)

```
users            (id, name, email UNIQUE, phone, password_hash, role, is_active, created_at, updated_at)
specializations  (id, name UNIQUE, is_active)
doctors          (id, user_id FK→users UNIQUE, specialization_id FK, fee, slot_minutes, bio, is_active)
doctor_schedules (id, doctor_id FK, day_of_week 0-6, start_time, end_time)
doctor_leaves    (id, doctor_id FK, leave_date, UNIQUE(doctor_id, leave_date))
appointments     (id, doctor_id FK, patient_id FK→users, start_at, end_at, status,
                  created_at, updated_at, cancelled_by, cancelled_at)
appointment_audit(id, appointment_id FK, old_status, new_status, changed_by, changed_at)
```

Key database rules:

- Partial unique index: `UNIQUE (doctor_id, start_at) WHERE status = 'BOOKED'` → enforces FR-4.4.
- Timestamps stored in UTC (`timestamptz`); displayed in the clinic's time zone (default `Asia/Kolkata`).
- Schema changes only through versioned migration files.

## 7. API overview (draft)

Base path: `/api/v1`

| Method | Path                                 | Role             | Purpose                        |
| ------ | ------------------------------------ | ---------------- | ------------------------------ |
| POST   | `/auth/register`                     | Public           | Patient registration           |
| POST   | `/auth/login`                        | Public           | Login, returns token           |
| GET    | `/me`                                | Any              | Current user profile           |
| GET    | `/specializations`                   | Any              | List specializations           |
| POST   | `/specializations`                   | Admin            | Create specialization          |
| GET    | `/doctors`                           | Any              | List / search doctors          |
| POST   | `/doctors`                           | Admin            | Create doctor                  |
| PATCH  | `/doctors/:id`                       | Admin            | Update / activate / deactivate |
| PUT    | `/doctors/me/schedule`               | Doctor           | Set weekly schedule            |
| POST   | `/doctors/me/leaves`                 | Doctor           | Add leave date                 |
| GET    | `/doctors/:id/slots?date=YYYY-MM-DD` | Any              | Slots for a date               |
| POST   | `/appointments`                      | Patient          | Book a slot                    |
| GET    | `/appointments/me`                   | Patient / Doctor | Own appointments               |
| GET    | `/appointments`                      | Admin            | All appointments               |
| POST   | `/appointments/:id/cancel`           | Patient / Admin  | Cancel                         |
| POST   | `/appointments/:id/reschedule`       | Patient          | Reschedule                     |
| POST   | `/appointments/:id/complete`         | Doctor           | Mark completed                 |
| POST   | `/appointments/:id/no-show`          | Doctor           | Mark no-show                   |

### Error responses (proposed standard)

| Situation                                                       | HTTP status                        |
| --------------------------------------------------------------- | ---------------------------------- |
| Validation failure (bad input, past slot, beyond 30 days)       | `400`                              |
| Missing / invalid / expired token                               | `401`                              |
| Wrong role or not the owner                                     | `403`                              |
| Resource not found                                              | `404`                              |
| Slot already booked, duplicate email, invalid status transition | `409`                              |
| Unexpected server error                                         | `500` (no stack trace in response) |

Error body format:

```json
{ "error": { "code": "SLOT_ALREADY_BOOKED", "message": "This slot is no longer available." } }
```

## 8. Frontend screens (Angular)

1. Login / Register
2. Doctor search (filter by specialization, search by name)
3. Doctor detail + date picker + slot grid
4. Booking confirmation
5. My Appointments (Upcoming / Past, cancel / reschedule actions)
6. Doctor dashboard (appointments by date, mark completed / no-show, schedule and leave management)
7. Admin panel (doctors, specializations, all appointments)

UI rules:

- Show clear messages for every error code above.
- Disable booked and past slots in the slot grid.
- Responsive layout (desktop and mobile width).

## 9. Non-functional requirements

| ID     | Area          | Requirement (sample targets — to be verified)                                                                  |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------- |
| NFR-1  | Performance   | Slots and booking APIs p95 < 500 ms at 50 concurrent users in the test environment.                            |
| NFR-2  | Concurrency   | 50 parallel booking requests for the same slot → exactly 1 success, 49 conflicts, no duplicates in DB.         |
| NFR-3  | Security      | Inputs validated server-side; parameterised queries only; rate limit on login (e.g. 5 attempts / minute / IP). |
| NFR-4  | Secrets       | No secrets in source control. `.env` is git-ignored; `.env.example` with placeholders is committed.            |
| NFR-5  | Data          | Only synthetic test data. No real patient information in any environment of this sample.                       |
| NFR-6  | Logging       | Structured logs with request id. Never log passwords, tokens or full personal data.                            |
| NFR-7  | Observability | `/health` endpoint (app + DB connectivity) used by deployment smoke tests.                                     |
| NFR-8  | Documentation | OpenAPI spec kept in sync with the implemented API.                                                            |
| NFR-9  | Accessibility | Forms usable with keyboard; labels on all inputs.                                                              |
| NFR-10 | Time          | All business rules (past slot, 2-hour cancel, 30-day window) use server time in UTC.                           |

## 10. Test strategy mapping

| Layer        | Examples                                                                      | Candidate tool                      |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------- |
| Backend unit | Slot generation (FR-3.4), cancel window (FR-5.1), status transitions (FR-5.6) | Jest / Vitest                       |
| API          | 401 / 403 / 409 / 400 cases, booking rules FR-4.x                             | Supertest / Playwright API          |
| Database     | Unique index (FR-4.4), migrations up / down, transactions                     | Postgres in Docker / Testcontainers |
| Frontend     | Slot grid component, forms validation                                         | Angular test tooling                |
| E2E          | Patient register → search → book → cancel                                     | Playwright                          |
| Load         | NFR-1, NFR-2                                                                  | k6                                  |
| Security     | Secret scan, dependency scan, static analysis                                 | Gitleaks, Dependabot, CodeQL        |

Every confirmed bug gets a regression test referencing its requirement ID.

## 11. Seed / test data

- 1 admin, 5 doctors across 3 specializations, 10 patients — all fake names and `@example.com` emails.
- Seed passwords are test-only values stored in the seed script / `.env.example`, never real passwords.

## 12. Open decisions

| #   | Question                                                                                     | Owner         |
| --- | -------------------------------------------------------------------------------------------- | ------------- |
| 1   | Is MySQL needed at all in this sample? If yes, for what?                                     | Project owner |
| 2   | Exact PostgreSQL version (proposal: 17)?                                                     | Project owner |
| 4   | Where will DEV / UAT / PROD run (local Docker, free cloud tier …)?                           | Project owner |
| 5   | Confirm proposed limits: 2-hour cancel window, 30-day advance, 1 booking per doctor per day. | Project owner |

Resolved on 2026-11-18: Express, Prisma, Angular 21 + npm, mono-repo, Docker for local DB (see DECISIONS.md).

## 13. Change log

| Version | Date       | Change                                                                   |
| ------- | ---------- | ------------------------------------------------------------------------ |
| 0.1     | 2026-11-18 | Initial draft                                                            |
| 0.2     | 2026-11-18 | Tech stack decisions recorded; open decisions updated                    |
| 0.3     | 2026-11-18 | API implemented for FR-1 – FR-6; clarifications in DECISIONS D-22 – D-26 |
