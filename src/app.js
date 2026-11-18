import express from 'express';
import helmet from 'helmet';

import { healthRouter } from './routes/health.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);
  // Feature routes will be mounted under /api/v1 (see docs/REQUIREMENTS.md §7).

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
