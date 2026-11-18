import { AppError } from '../errors.js';

// Standard error body (docs/REQUIREMENTS.md §7):
// { "error": { "code": "SOME_CODE", "message": "Human readable message." } }

export function notFoundHandler(_req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
}

// Express recognises error handlers by their 4 arguments, so `_next` must stay.
export function errorHandler(err, req, res, _next) {
  // Errors we raised on purpose (validation, auth, conflicts...)
  if (err instanceof AppError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json({ error: body });
  }

  // Malformed JSON body sent by the client
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' },
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
    });
  }

  // Never leak stack traces or internal details to the client.
  console.error(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      requestId: req?.id,
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    }),
  );
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
  });
}
