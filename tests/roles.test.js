import { describe, it, expect, vi } from 'vitest';

import { requireRole } from '../src/middleware/auth.js';
import { AppError } from '../src/errors.js';

describe('requireRole (FR-1.7)', () => {
  it('lets an allowed role through', () => {
    const next = vi.fn();

    requireRole('ADMIN', 'DOCTOR')({ user: { role: 'DOCTOR' } }, {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 FORBIDDEN for a wrong role', () => {
    const next = vi.fn();

    requireRole('ADMIN')({ user: { role: 'PATIENT' } }, {}, next);

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });
});
