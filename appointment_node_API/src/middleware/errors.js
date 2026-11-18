// Standard error body (docs/REQUIREMENTS.md §7):
// { "error": { "code": "SOME_CODE", "message": "Human readable message." } }

export function notFoundHandler(_req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
}

// Express recognises error handlers by their 4 arguments, so `_next` must stay.
export function errorHandler(err, _req, res, _next) {
  // Malformed JSON body sent by the client
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' },
    });
  }

  // Never leak stack traces or internal details to the client.
  console.error(err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
  });
}
