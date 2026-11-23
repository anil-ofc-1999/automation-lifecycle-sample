import { Router } from 'express';
import { z } from 'zod';

import { emailField, passwordField } from '../auth/fields.js';
import { hashPassword } from '../auth/password.js';
import { prisma } from '../db.js';
import { AppError, validate } from '../errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Fields safe to send to the client — never the password hash.
export function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
  };
}

export const meRouter = Router();

// GET /api/v1/me — current user's profile (any role).
meRouter.get('/', requireAuth, (req, res) => {
  res.status(200).json({ user: toPublicUser(req.currentUser) });
});

const resetSchema = z.object({ email: emailField, newPassword: passwordField });

// D-35: admin sets a new password for a DOCTOR or PATIENT account (e.g. forgotten password).
export const usersRouter = Router();
usersRouter.use(requireAuth, requireRole('ADMIN'));

usersRouter.post('/reset-password', async (req, res) => {
  const { email, newPassword } = validate(resetSchema, req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'No account with this email.');
  // Admins change their own password themselves; one admin cannot take over another.
  if (user.role === 'ADMIN') {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Admin passwords can only be changed by their owner (Change password page).',
    );
  }

  // Whole seconds, like the token's "iat" (D-32): every session of that user ends.
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: changedAt },
  });

  // Audit trail without the password or email (NFR-6).
  console.log(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg: 'password reset by admin',
      requestId: req.id,
      adminId: req.user.userId,
      userId: updated.id,
    }),
  );
  res.status(200).json({ user: toPublicUser(updated) });
});
