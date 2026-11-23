// Seeds the LIVE (Render) database in one go: npm run seed:live
// Asks for the External Database URL and a new password for the sample accounts,
// checks both, then runs prisma/seed.js against that database. Nothing is saved to disk.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const rl = createInterface({ input: stdin, output: stdout });

console.log('\n=== Fill the LIVE database with sample data ===\n');
console.log('1) In Render: appointments-db -> "External Database URL" -> click the copy icon.');
let url = (await rl.question('   Paste it here and press Enter: ')).trim().replace(/^"|"$/g, '');

let host;
try {
  host = new URL(url).hostname;
} catch {
  host = '';
}
// Exact domain match: "evil-render.com" or "render.com.evil.io" must not pass (CodeQL).
if (host !== 'render.com' && !host.endsWith('.render.com')) {
  console.error('\nThat is not the Render External Database URL (it must contain "render.com").');
  console.error('Copy it again from Render and run: npm run seed:live\n');
  rl.close();
  process.exit(1);
}
// Encrypted and certificate-checked connection. pg already treats "require" as
// "verify-full"; saying so explicitly avoids its deprecation warning.
url = url.replace(/([?&])sslmode=[^&]*/, '$1sslmode=verify-full');
if (!url.includes('sslmode=')) url += (url.includes('?') ? '&' : '?') + 'sslmode=verify-full';

console.log('\n2) Make up a NEW password for the sample accounts (admin, doctors, patients).');
console.log('   At least 12 characters, with letters and numbers. Write it down!');
const password = (await rl.question('   Type it and press Enter: ')).trim();
rl.close();

if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
  console.error('\nToo weak: use at least 12 characters with letters and numbers. Run again.\n');
  process.exit(1);
}

console.log('\nSeeding the live database (takes ~10 seconds)...\n');
const result = spawnSync(process.execPath, ['prisma/seed.js'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url, SEED_PASSWORD: password },
});

if (result.status === 0) {
  console.log(
    '\nDONE. Log in on the website as admin@example.com with the password you just chose.',
  );
  console.log('Next: remove your IP from the database Networking rules in Render.\n');
}
process.exit(result.status ?? 1);
