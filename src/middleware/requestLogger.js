import { randomUUID } from 'node:crypto';

import { config } from '../config.js';

// NFR-6: one structured (JSON) log line per request, with a request id.
// Never logs bodies, headers, tokens or query strings (they can hold personal data).
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export function requestLogger(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (config.env === 'test') return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : 'info',
        time: new Date().toISOString(),
        requestId: req.id,
        method: req.method,
        path: req.baseUrl + req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        userId: req.user?.userId,
      }),
    );
  });
  next();
}
