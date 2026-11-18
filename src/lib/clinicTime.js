// Date/time helpers for the clinic's local time.
// Instants are stored in UTC (timestamptz). Dates and schedule times are in clinic time.
// The clinic is in Asia/Kolkata = UTC+05:30 all year (India has no daylight saving),
// so a fixed offset is exact. The DB index for FR-4.5 uses the same zone (D-22).

import { config } from '../config.js';

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

const offsetMs = () => config.clinicUtcOffsetMinutes * MINUTE_MS;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30).
export function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isValidTimeString = (value) => typeof value === 'string' && TIME_RE.test(value);

// 'HH:MM' -> minutes since midnight
export function hhmmToMinutes(value) {
  const [, h, m] = TIME_RE.exec(value);
  return Number(h) * 60 + Number(m);
}

// minutes since midnight -> 'HH:MM'
export function minutesToHhmm(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// Prisma returns TIME columns as a Date on 1970-01-01 UTC.
export const timeColumnToMinutes = (date) => date.getUTCHours() * 60 + date.getUTCMinutes();
export const minutesToTimeColumn = (minutes) => new Date(minutes * MINUTE_MS);

// Prisma returns DATE columns as a Date at 00:00 UTC.
export const dateStringToDateColumn = (value) => new Date(`${value}T00:00:00Z`);
export const dateColumnToString = (date) => date.toISOString().slice(0, 10);

// The clinic-local calendar date ('YYYY-MM-DD') of a UTC instant.
export const clinicDateOf = (instant) =>
  new Date(instant.getTime() + offsetMs()).toISOString().slice(0, 10);

// Minutes since clinic-local midnight of a UTC instant.
export function clinicMinutesOf(instant) {
  const local = new Date(instant.getTime() + offsetMs());
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

// UTC instant for a clinic-local date + minutes since midnight.
export const clinicDateTimeToUtc = (dateString, minutes) =>
  new Date(Date.parse(`${dateString}T00:00:00Z`) + minutes * MINUTE_MS - offsetMs());

// 0 = Sunday … 6 = Saturday, for a clinic-local date.
export const dayOfWeekOf = (dateString) => new Date(`${dateString}T00:00:00Z`).getUTCDay();
