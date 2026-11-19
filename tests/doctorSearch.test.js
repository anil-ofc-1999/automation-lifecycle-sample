// Unit tests for the doctor search helper (no database needed).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  prisma: {},
  isDatabaseUp: vi.fn(),
  uniqueViolationIndex: vi.fn(),
}));

import { escapeLikePattern } from '../src/routes/doctors.js';

describe('escapeLikePattern (FR-2.4 search)', () => {
  it.each([
    ['Meera', 'Meera'],
    ['Dr. Rao', 'Dr. Rao'],
    ['', ''],
  ])('leaves normal text %j unchanged', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  it.each([
    ['%', '\\%'],
    ['_', '\\_'],
    ['\\', '\\\\'],
    ['100%_x\\', '100\\%\\_x\\\\'],
  ])('escapes LIKE wildcards in %j', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });
});
