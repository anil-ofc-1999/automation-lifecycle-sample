// Email delivery for FR-7. Three modes (MAIL_MODE, see .env.example):
//   memory — kept in an in-process outbox; the default for tests (FR-7.2: nothing is sent)
//   log    — one structured log line, recipient masked (NFR-6); the default everywhere else
//   smtp   — really sent through SMTP_URL (only when an email account is configured)

import { config } from '../config.js';

const outbox = [];

/** Messages captured in `memory` mode (tests). */
export const sentMail = () => [...outbox];
export const clearSentMail = () => void outbox.splice(0);

// "asha.reddy@example.com" -> "a***@example.com": enough to debug, not full personal data.
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

let smtpTransport;
async function smtp() {
  if (!smtpTransport) {
    const { default: nodemailer } = await import('nodemailer');
    smtpTransport = nodemailer.createTransport(config.smtpUrl, {
      // Plain text messages only: never read files or URLs while building a message.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  return smtpTransport;
}

/** Resets the cached SMTP connection (tests). */
export const resetMailer = () => void (smtpTransport = undefined);

export function mailMode() {
  return config.mailMode;
}

/**
 * Sends (or captures / logs) one plain-text email.
 * @param {{ to: string, subject: string, text: string }} message
 * @param {{ event?: string, appointmentId?: number, requestId?: string }} meta for the log line
 */
export async function sendMail(message, meta = {}) {
  const mode = mailMode();
  if (mode === 'memory') {
    outbox.push({ ...message, from: config.mailFrom });
    return;
  }
  if (mode === 'smtp') {
    const transport = await smtp();
    await transport.sendMail({ from: config.mailFrom, ...message });
  }
  // Both `log` and `smtp` leave a trace — without the body or the full address.
  console.log(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg: mode === 'smtp' ? 'email sent' : 'email (not sent: MAIL_MODE=log)',
      ...meta,
      to: maskEmail(message.to),
      subject: message.subject,
    }),
  );
}
