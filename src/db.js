import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { config } from './config.js';

// Optional `?schema=name` in DATABASE_URL (integration tests use their own schema).
function schemaFromUrl(url) {
  try {
    return new URL(url).searchParams.get('schema') ?? undefined;
  } catch {
    return undefined;
  }
}

// One shared Prisma client for the whole app (it keeps a connection pool).
// Prisma 7 talks to PostgreSQL through the `pg` driver adapter.
export const prisma = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: config.databaseUrl },
    { schema: schemaFromUrl(config.databaseUrl) },
  ),
});

// Returns true if the database answers a trivial query, false otherwise.
export async function isDatabaseUp() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// For a unique-constraint error (P2002), returns the violated index/constraint name.
// Our partial unique indexes (FR-4.4, FR-4.5) are only identifiable this way.
export function uniqueViolationIndex(err) {
  if (err?.code !== 'P2002') return null;
  const cause = err.meta?.driverAdapterError?.cause;
  return cause?.constraint?.index ?? cause?.originalMessage ?? 'unknown';
}
