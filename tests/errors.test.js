import { describe, it, expect, vi } from 'vitest';

import { errorHandler } from '../src/middleware/errors.js';

// Minimal fake Express response object
function fakeRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe('errorHandler', () => {
  it('returns 500 INTERNAL_ERROR without leaking error details', () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(new Error('db password=secret'), {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    expect(JSON.stringify(body)).not.toContain('secret');

    spy.mockRestore();
  });
});
