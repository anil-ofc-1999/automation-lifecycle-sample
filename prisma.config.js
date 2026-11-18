// Prisma CLI config (migrate, generate, studio).
// Loads .env the same way the app does (D-12: Node's built-in env loader, no dotenv).
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // No .env file (e.g. CI) — DATABASE_URL comes from the real environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
