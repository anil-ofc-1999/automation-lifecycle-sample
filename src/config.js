// Central place to read environment variables.
// Values come from the process environment (or .env locally — see .env.example).

const toInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
};

export const config = Object.freeze({
  env: process.env.NODE_ENV ?? 'development',
  port: toInt(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL,
  // FR-1.5 / FR-1.6: secret used to sign access tokens, and how long they live.
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
  // NFR-3: login attempts allowed per IP per minute.
  loginRateLimitPerMinute: toInt(process.env.LOGIN_RATE_LIMIT_PER_MINUTE, 5),
  // Clinic time zone Asia/Kolkata = UTC+05:30 (no daylight saving) — D-22.
  clinicUtcOffsetMinutes: 330,
  // Business limits (REQUIREMENTS FR-4.3, FR-5.1 — open item O-4 to confirm).
  bookingWindowDays: 30,
  patientChangeCutoffHours: 2,
});

// Fails fast at startup instead of failing later on the first request.
export function assertRequiredConfig() {
  const missing = ['DATABASE_URL', 'JWT_SECRET'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }
}
