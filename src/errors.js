// An error we throw on purpose. The error handler turns it into the standard body:
// { "error": { "code": "SOME_CODE", "message": "Human readable message." } }
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Validates `data` with a zod schema. Returns the cleaned data or throws a 400.
export function validate(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', details);
  }
  return result.data;
}
