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

// Every connection uses UTC. The pg adapter sends timestamps as UTC wall-clock time
// without an offset; on a server whose TimeZone is not UTC (e.g. a local install set to
// Asia/Calcutta) PostgreSQL would read them as local time and store instants that are
// hours off — invisible to Prisma, but wrong for raw SQL, reports and the FR-4.5
// "one booking per doctor per day" index. (D-28)
export const SESSION_OPTIONS = '-c TimeZone=UTC';

// One shared Prisma client for the whole app (it keeps a connection pool).
// Prisma 7 talks to PostgreSQL through the `pg` driver adapter.
export const prisma = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: config.databaseUrl, options: SESSION_OPTIONS },
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
