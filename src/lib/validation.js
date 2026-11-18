// Reusable zod pieces for request validation.
import { z } from 'zod';

import { isValidDateString } from './clinicTime.js';

export const idParam = z.coerce
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .positive('Must be a positive number.');

export const idParamsSchema = z.object({ id: idParam });

export const dateString = z
  .string({ error: 'Date is required.' })
  .refine(isValidDateString, 'Use a valid date in YYYY-MM-DD format.');

export const isoDateTime = z
  .string({ error: 'Date-time is required.' })
  .pipe(
    z.iso.datetime({
      offset: true,
      error: 'Use an ISO date-time, e.g. 2026-12-01T10:00:00+05:30.',
    }),
  )
  .transform((value) => new Date(value));

// FR-2.5: default 10 per page, max 50.
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50, 'pageSize can be at most 50.').default(10),
});

// Query-string booleans: only "true" / "false".
export const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const paginate = ({ page, pageSize }) => ({ skip: (page - 1) * pageSize, take: pageSize });

export const pageResult = (items, total, { page, pageSize }) => ({
  items,
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});
