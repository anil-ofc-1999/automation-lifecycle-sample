// Load test runner (NFR-1, NFR-2). Usage: npm run load
//
// Never touches real data: everything happens in a separate "loadtest" schema of the
// database from .env, which is emptied and re-seeded first. A dedicated API instance
// runs on port 3200 (login rate limit raised: k6 logs in many users from one IP).
import { execSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SCHEMA = 'loadtest';
const PORT = 3200;

try {
  process.loadEnvFile();
} catch {
  // CI: DATABASE_URL comes from the environment.
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', SCHEMA);
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  PORT: String(PORT),
  NODE_ENV: 'test', // quiet request logs
  LOGIN_RATE_LIMIT_PER_MINUTE: '100000',
  API_RATE_LIMIT_PER_MINUTE: '1000000',
  REGISTER_RATE_LIMIT_PER_MINUTE: '100000',
};

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });

console.log(`\n1/4 Preparing schema "${SCHEMA}" (migrate + empty + seed)...`);
run('npx prisma migrate deploy');
run(`node load/reset.mjs`);
run('node prisma/seed.js');

console.log(`\n2/4 Starting a dedicated API on port ${PORT}...`);
const api = spawn(process.execPath, ['src/server.js'], { env, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  try {
    up = (await fetch(`http://localhost:${PORT}/health`)).ok;
  } catch {
    await sleep(500);
  }
}
if (!up) {
  api.kill();
  throw new Error('API did not start.');
}

console.log('\n3/4 Running k6...\n');
let exitCode = 0;
try {
  const stress = process.argv.includes('--stress') ? ' --env STRESS=1' : '';
  run(`k6 run --env BASE_URL=http://localhost:${PORT}${stress} load/booking-load.js`);
} catch {
  exitCode = 1; // k6 exits non-zero when a threshold fails
} finally {
  console.log('\n4/4 Stopping the API.');
  api.kill();
}
process.exit(exitCode);
