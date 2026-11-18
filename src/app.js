import express from 'express';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requestLogger } from './middleware/requestLogger.js';
import { appointmentsRouter } from './routes/appointments.js';
import { createAuthRouter } from './routes/auth.js';
import { doctorsRouter } from './routes/doctors.js';
import { healthRouter } from './routes/health.js';
import { specializationsRouter } from './routes/specializations.js';
import { meRouter } from './routes/users.js';

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);

  // Feature routes (docs/REQUIREMENTS.md §7, docs/openapi.yaml)
  const api = express.Router();
  api.use('/auth', createAuthRouter());
  api.use('/me', meRouter);
  api.use('/specializations', specializationsRouter);
  api.use('/doctors', doctorsRouter);
  api.use('/appointments', appointmentsRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
