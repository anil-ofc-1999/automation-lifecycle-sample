// Empties every table of the load-test schema (only "loadtest" — refuses anything else).
import { prisma } from '../src/db.js';

const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
if (schema !== 'loadtest') throw new Error(`Refusing to reset schema "${schema}".`);

const tables = [
  'appointment_audit',
  'appointments',
  'doctor_leaves',
  'doctor_schedules',
  'doctors',
  'specializations',
  'users',
];
await prisma.$executeRawUnsafe(
  `TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
);
await prisma.$disconnect();
console.log(`Schema "${schema}" emptied.`);
