import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { config } from './config.js';

// One shared Prisma client for the whole app (it keeps a connection pool).
// Prisma 7 talks to PostgreSQL through the `pg` driver adapter.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
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
