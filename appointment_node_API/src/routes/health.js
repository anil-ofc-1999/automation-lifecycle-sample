import { Router } from 'express';

// NFR-7: health endpoint used by deployment smoke tests.
// Database connectivity check will be added when PostgreSQL is wired in.
export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
