import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, validate } from '../errors.js';
import { toPublicUser } from './users.js';

const emailField = z
  .string()
  .trim()
  .toLowerCase() // FR-1.2: email is case-insensitive
  .pipe(z.email('Enter a valid email address.').max(255));

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(100),
  email: emailField,
  // FR-1.1: phone is optional
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number.')
    .optional(),
  // FR-1.3: at least 8 characters, one letter and one number (72 = bcrypt limit)
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(72, 'Password must be at most 72 characters.')
    .regex(/[A-Za-z]/, 'Password must contain at least one letter.')
    .regex(/[0-9]/, 'Password must contain at least one number.'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required.'),
  password: z.string().min(1, 'Password is required.'),
});

// Same message for unknown email and wrong password (no user enumeration).
const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export function createAuthRouter() {
  const router = Router();

  // NFR-3: limit login attempts per IP. Created per app so tests stay independent.
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.loginRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many login attempts. Try again in a minute.',
        },
      }),
  });

  // FR-1.1, FR-1.8: anyone can register, but only as a PATIENT.
  router.post('/register', async (req, res) => {
    const input = validate(registerSchema, req.body);

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    }

    try {
      const user = await prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash: await hashPassword(input.password),
          role: 'PATIENT',
        },
      });
      res.status(201).json({ user: toPublicUser(user) });
    } catch (err) {
      // Two registrations with the same email at the same moment: DB unique index wins.
      if (err.code === 'P2002') {
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw err;
    }
  });

  // FR-1.5: login returns an access token.
  router.post('/login', loginLimiter, async (req, res) => {
    const input = validate(loginSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: input.email } });
    const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordOk) throw invalidCredentials();

    if (!user.isActive) {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled.');
    }

    res.status(200).json({
      accessToken: signAccessToken(user),
      tokenType: 'Bearer',
      expiresIn: config.jwtExpiresIn,
      user: toPublicUser(user),
    });
  });

  return router;
}
