import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { emailField, nameField, passwordField, phoneField } from '../auth/fields.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { prisma, uniqueViolationIndex } from '../db.js';
import { AppError, validate } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { toPublicUser } from './users.js';

const registerSchema = z.object({
  name: nameField,
  email: emailField,
  phone: phoneField,
  password: passwordField,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: passwordField,
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'The new password must be different from the current one.',
    path: ['newPassword'],
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

  // D-30: limit registrations per IP so nobody can create accounts in bulk.
  const registerLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.registerRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many registrations from this network. Try again in a minute.',
        },
      }),
  });

  // D-32: guessing the current password is limited like login attempts.
  const changePasswordLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.loginRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many password change attempts. Try again in a minute.',
        },
      }),
  });

  // FR-1.1, FR-1.8: anyone can register, but only as a PATIENT.
  router.post('/register', registerLimiter, async (req, res) => {
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
      if (uniqueViolationIndex(err)) {
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

  // D-32: a logged-in user (any role) changes their own password. Needs the current
  // password; every older session is signed out, this one gets a fresh token.
  router.post('/change-password', changePasswordLimiter, requireAuth, async (req, res) => {
    const input = validate(changePasswordSchema, req.body);
    const user = req.currentUser;

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError(400, 'WRONG_PASSWORD', 'Your current password is incorrect.', [
        { field: 'currentPassword', message: 'Current password is incorrect.' },
      ]);
    }

    // Whole seconds, like the token's "iat": the new token below (same second) stays valid.
    const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: changedAt },
    });

    res.status(200).json({
      accessToken: signAccessToken(updated),
      tokenType: 'Bearer',
      expiresIn: config.jwtExpiresIn,
      user: toPublicUser(updated),
    });
  });

  return router;
}
