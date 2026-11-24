// D-37: "forgot password" links. A link carries a random token; only its SHA-256 hash is
// stored. Links expire (config.passwordResetMinutes) and work once.
import { createHash, randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { prisma } from '../db.js';
import { sendMail } from '../notifications/mailer.js';
import { hashPassword } from './password.js';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** The email text. The link appears ONLY here — never in logs (MAIL_MODE=log keeps no body). */
export function buildResetEmail(name, link, minutes) {
  return {
    subject: 'Reset your Doctor Appointments password',
    text: [
      `Hello ${name},`,
      '',
      'Someone (hopefully you) asked to reset the password of your account.',
      `Open this link within ${minutes} minutes to choose a new password:`,
      '',
      link,
      '',
      'If you did not ask for this, ignore this email: your password stays the same.',
      '',
      '— Doctor Appointments',
      '(This is an automatic message. Please do not reply.)',
    ].join('\n'),
  };
}

/**
 * Creates a link for this email and sends it. Does nothing (silently) for unknown or
 * disabled accounts, so the answer never reveals whether an email is registered.
 */
export async function requestPasswordReset(email, { requestId } = {}) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return;

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await prisma.$transaction([
    // Only the newest link works: older unused ones are retired.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date(now) },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now + config.passwordResetMinutes * 60_000),
      },
    }),
  ]);

  const link = `${config.appUrl}/reset-password?token=${token}`;
  const { subject, text } = buildResetEmail(user.name, link, config.passwordResetMinutes);
  await sendMail(
    { to: user.email, subject, text },
    { event: 'password.reset_requested', requestId },
  );
}

/**
 * Sets the new password if the token is valid. Returns false for an unknown, used or
 * expired link (the caller shows one message for all of them).
 */
export async function resetPasswordWithToken(token, newPassword) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  const now = new Date();
  if (!record || record.usedAt || record.expiresAt <= now || !record.user.isActive) return false;

  // Whole seconds, like the token's "iat" (D-32): every session of that user ends.
  const changedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const passwordHash = await hashPassword(newPassword);
  return prisma.$transaction(async (tx) => {
    // Claim the link first: if two requests use it at the same moment, only one row
    // update succeeds and the other changes nothing.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count === 0) return false;
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordChangedAt: changedAt },
    });
    // Any other open link of this user stops working too.
    await tx.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    });
    return true;
  });
}
