import { Router } from 'express';

import { isDatabaseUp } from '../db.js';

// NFR-7: health endpoint used by deployment smoke tests.
// Returns 503 when the database is unreachable, so a broken deploy is caught early.
export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const databaseUp = await isDatabaseUp();

  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'ok' : 'degraded',
    database: databaseUp ? 'up' : 'down',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
