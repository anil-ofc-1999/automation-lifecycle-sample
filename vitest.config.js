import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Real-database tests have their own config (vitest.integration.config.js).
    exclude: ['node_modules/**', 'tests/integration/**'],
    // Rate-limit tests hash many real passwords (bcrypt, ~3 s); 5 s was too tight on a busy machine.
    testTimeout: 15_000,
    // Test-only values; real ones come from .env (never committed).
    env: {
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
      JWT_EXPIRES_IN: '1h',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/server.js'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
