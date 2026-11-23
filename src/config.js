// Central place to read environment variables.
// Values come from the process environment (or .env locally — see .env.example).

const toInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
};

const MAIL_MODES = ['memory', 'log', 'smtp'];
const defaultMailMode = () => (process.env.NODE_ENV === 'test' ? 'memory' : 'log');

export const config = Object.freeze({
  env: process.env.NODE_ENV ?? 'development',
  port: toInt(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL,
  // Database connections per API instance (D-29). Keep below the server's limit.
  dbPoolMax: toInt(process.env.DB_POOL_MAX, 20),
  // FR-1.5 / FR-1.6: secret used to sign access tokens, and how long they live.
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
  // NFR-3: login attempts allowed per IP per minute.
  loginRateLimitPerMinute: toInt(process.env.LOGIN_RATE_LIMIT_PER_MINUTE, 5),
  // Registrations allowed per IP per minute (stops account spam; D-30).
  registerRateLimitPerMinute: toInt(process.env.REGISTER_RATE_LIMIT_PER_MINUTE, 10),
  // Number of proxies in front of the API (Render: 1). 0 = no proxy (local, default).
  trustProxyHops: toInt(process.env.TRUST_PROXY_HOPS, 0),
  // Clinic time zone Asia/Kolkata = UTC+05:30 (no daylight saving) — D-22.
  clinicUtcOffsetMinutes: 330,
  // Business limits (REQUIREMENTS FR-4.3, FR-5.1 — open item O-4 to confirm).
  bookingWindowDays: 30,
  patientChangeCutoffHours: 2,
  // FR-7: appointment emails. memory (tests) | log (default) | smtp (really sent).
  // Read on use (getters), so tests can switch the mode.
  get mailMode() {
    return process.env.MAIL_MODE || defaultMailMode();
  },
  get mailFrom() {
    return process.env.MAIL_FROM || 'Doctor Appointments <no-reply@example.com>';
  },
  get smtpUrl() {
    return process.env.SMTP_URL;
  },
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
  const mailMode = process.env.MAIL_MODE;
  if (mailMode && !MAIL_MODES.includes(mailMode)) {
    throw new Error(`MAIL_MODE must be one of: ${MAIL_MODES.join(', ')}.`);
  }
  if (mailMode === 'smtp' && !process.env.SMTP_URL) {
    throw new Error('MAIL_MODE=smtp needs SMTP_URL.');
  }
}
