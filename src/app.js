import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requestLogger } from './middleware/requestLogger.js';
import { appointmentsRouter } from './routes/appointments.js';
import { createAuthRouter } from './routes/auth.js';
import { doctorsRouter } from './routes/doctors.js';
import { healthRouter } from './routes/health.js';
import { specializationsRouter } from './routes/specializations.js';
import { meRouter, usersRouter } from './routes/users.js';

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind a hosting proxy (e.g. Render) every request comes from the proxy's IP; without
  // this the per-IP rate limits would be shared by ALL users. Off by default so a client
  // can never fake its IP with an X-Forwarded-For header (D-30).
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use(requestLogger);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRouter);

  // Feature routes (docs/REQUIREMENTS.md §7, docs/openapi.yaml)
  const api = express.Router();
  // D-34: overall per-IP limit for every API route (login / register / change-password
  // have stricter ones of their own). Created per app so tests stay independent.
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: config.apiRateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many requests. Please wait a minute and try again.',
          },
        }),
    }),
  );
  api.use('/auth', createAuthRouter());
  api.use('/me', meRouter);
  api.use('/users', usersRouter);
  api.use('/specializations', specializationsRouter);
  api.use('/doctors', doctorsRouter);
  api.use('/appointments', appointmentsRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
