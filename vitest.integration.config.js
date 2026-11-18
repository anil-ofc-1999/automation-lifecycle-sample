// Integration tests: real PostgreSQL, separate "itest" schema, so local data in
// the normal schema is never touched. Run with: npm run test:integration
import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile();
} catch {
  // No .env (CI) — DATABASE_URL / TEST_DATABASE_URL come from the environment.
}

function withTestSchema(url) {
  if (!url) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) to run integration tests.');
  const u = new URL(url);
  u.searchParams.set('schema', 'itest');
  return u.toString();
}

const testDatabaseUrl = withTestSchema(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
// globalSetup (same process) reads it from here.
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.js'],
    globalSetup: ['tests/integration/globalSetup.js'],
    // One file at a time: all files share the same test schema.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
      JWT_EXPIRES_IN: '1h',
      LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    },
  },
});
