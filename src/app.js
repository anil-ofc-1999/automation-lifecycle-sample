import express from 'express';
import helmet from 'helmet';

import { healthRouter } from './routes/health.js';
import { createAuthRouter } from './routes/auth.js';
import { meRouter } from './routes/users.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);

  // Feature routes (docs/REQUIREMENTS.md §7)
  const api = express.Router();
  api.use('/auth', createAuthRouter());
  api.use('/me', meRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
