import { describe, it, expect, afterEach } from 'vitest';

import { assertRequiredConfig } from '../src/config.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('assertRequiredConfig', () => {
  it('fails fast when JWT_SECRET is missing', () => {
    process.env.DATABASE_URL = 'postgresql://x';
    delete process.env.JWT_SECRET;

    expect(() => assertRequiredConfig()).toThrow('JWT_SECRET');
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    process.env.DATABASE_URL = 'postgresql://x';
    process.env.JWT_SECRET = 'short';

    expect(() => assertRequiredConfig()).toThrow('at least 32');
  });

  it('passes when everything is set', () => {
    process.env.DATABASE_URL = 'postgresql://x';
    process.env.JWT_SECRET = 'x'.repeat(32);

    expect(() => assertRequiredConfig()).not.toThrow();
  });
});
