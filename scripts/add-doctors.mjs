// Adds sample doctors + specializations through the API (local or live), no duplicates.
//
//   npm run doctors:add               add what is missing
//   npm run doctors:add -- --dry-run  only show what would be added
//   npm run doctors:add -- --file my-doctors.json
//
// It asks for the API address, the admin login and a password for the NEW doctor accounts.
// Passwords are typed hidden, used only for this run and never saved or printed.
// For automation the same values can come from API_URL, ADMIN_EMAIL, ADMIN_PASSWORD and
// DOCTOR_PASSWORD environment variables.
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { addDoctors, validateData } from './lib/addDoctors.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const file =
  fileArg >= 0 ? args[fileArg + 1] : fileURLToPath(new URL('./data/doctors.json', import.meta.url));

const LOCAL = 'http://localhost:3000';
const LIVE = 'https://appointment-api-pcyh.onrender.com';

/** Reads a line without showing what is typed (passwords). */
function askHidden(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(rl, question, fallback) {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

const strong = (p) => p.length >= 12 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);

async function main() {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateData(data);
  if (problems.length > 0) {
    console.error(`The data file has problems:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `\n=== Add doctors${dryRun ? ' (DRY RUN — nothing will be changed)' : ''} ===\n` +
      `File: ${data.specializations.length} specializations, ${data.doctors.length} doctors.\n`,
  );

  let apiUrl = process.env.API_URL;
  let adminEmail = process.env.ADMIN_EMAIL;
  if (!apiUrl || !adminEmail) {
    const rl = createInterface({ input: stdin, output: stdout });
    console.log(`1) Which API?  Enter = local (${LOCAL}),  or type: live`);
    const where = await ask(rl, '   API: ', 'local');
    apiUrl ??= where === 'live' ? LIVE : where === 'local' ? LOCAL : where;
    adminEmail ??= await ask(
      rl,
      '2) Admin email (Enter = admin@example.com): ',
      'admin@example.com',
    );
    rl.close();
  }
  apiUrl = apiUrl.replace(/\/+$/, '');
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl);
  if (!isLocal && !apiUrl.startsWith('https://')) {
    console.error('Use https:// for a remote API (passwords must not travel unencrypted).');
    process.exit(1);
  }

  const adminPassword = process.env.ADMIN_PASSWORD ?? (await askHidden('3) Admin password: '));

  let doctorPassword = process.env.DOCTOR_PASSWORD;
  if (!dryRun && !doctorPassword) {
    console.log('4) Password for the NEW doctor accounts (12+ characters, letters and numbers).');
    doctorPassword = await askHidden('   Type it: ');
    if ((await askHidden('   Type it again: ')) !== doctorPassword) {
      console.error('The two passwords are different. Nothing was changed.');
      process.exit(1);
    }
  }
  if (!dryRun && !strong(doctorPassword)) {
    console.error('Doctor password too weak: 12+ characters with letters and numbers.');
    process.exit(1);
  }

  console.log(`\nLogging in to ${apiUrl} ... (a sleeping free server can take ~1 minute)`);
  const login = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok) {
    console.error(`Login failed: ${loginBody?.error?.message ?? login.status}`);
    process.exit(1);
  }
  if (loginBody.user?.role !== 'ADMIN') {
    console.error('That account is not an admin.');
    process.exit(1);
  }

  const client = async (method, path, body) => {
    const res = await fetch(`${apiUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${loginBody.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const s = await addDoctors({ client, data, doctorPassword, dryRun, log: (l) => console.log(l) });

  const verb = dryRun ? 'would be added' : 'added';
  console.log('\n--- Summary ---');
  console.log(`Specializations ${verb}: ${s.specializations.created.length}`);
  console.log(`Specializations already there: ${s.specializations.existing.length}`);
  if (s.specializations.inactive.length) {
    console.log(
      `Specializations inactive (left as they are): ${s.specializations.inactive.join(', ')}`,
    );
  }
  console.log(`Doctors ${verb}: ${s.doctors.created.length}`);
  console.log(`Doctors already there (same email): ${s.doctors.existing.length}`);
  for (const skip of s.doctors.skipped) console.log(`Skipped ${skip.email}: ${skip.reason}`);
  if (!dryRun && s.doctors.created.length) {
    console.log('\nNew doctors log in with their email and the doctor password you typed.');
  }
}

main().catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  console.error('Anything added before this point stays; running again skips it.');
  process.exit(1);
});
