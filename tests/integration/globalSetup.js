// Runs once before all integration tests: brings the "itest" schema up to date
// with the migration files (non-destructive; tests empty the tables themselves).
import { execSync } from 'node:child_process';

export default function setup() {
  const url = new URL(process.env.DATABASE_URL);
  const schema = url.searchParams.get('schema');
  // Safety: integration tests may only ever touch the "itest" schema.
  if (schema !== 'itest') {
    throw new Error(`Integration tests must use the "itest" schema, got "${schema}".`);
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
}
