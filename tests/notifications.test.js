// FR-7: appointment emails — message text, delivery modes, privacy of logs (NFR-6).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createTransport = vi.fn();
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { assertRequiredConfig, config } = await import('../src/config.js');
const { buildEmail } = await import('../src/notifications/appointmentEmails.js');
const { clearSentMail, mailMode, maskEmail, resetMailer, sendMail, sentMail } =
  await import('../src/notifications/mailer.js');

// Tuesday 2030-01-08 10:30 clinic time (05:00 UTC).
const appointment = {
  id: 42,
  startAt: new Date('2030-01-08T10:30:00+05:30'),
  doctor: { user: { name: 'Dr. Meera Iyer' }, specialization: { name: 'Cardiology' } },
  patient: { name: 'Asha Reddy', email: 'asha.reddy@example.com' },
};
const previous = { id: 41, startAt: new Date('2030-01-08T09:00:00+05:30') };

const MESSAGE = { to: 'asha.reddy@example.com', subject: 'Hi', text: 'secret body text' };
const saved = { ...process.env };

beforeEach(() => {
  clearSentMail();
  resetMailer();
  createTransport.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('Email text — positive', () => {
  it('BOOKED: subject and body name the doctor, date and time in clinic time', () => {
    const { subject, lines } = buildEmail('BOOKED', appointment);
    const text = lines.join('\n');

    expect(subject).toBe('Appointment confirmed: Dr. Meera Iyer, Tue 8 Jan 10:30');
    expect(text).toContain('Hello Asha Reddy,');
    expect(text).toContain('Dr. Meera Iyer (Cardiology)');
    expect(text).toContain('Tuesday, 8 January 2030 at 10:30 (India time)');
    expect(text).toContain('Appointment no.: 42');
  });

  it('CANCELLED by the patient says "as you asked"', () => {
    const { subject, lines } = buildEmail('CANCELLED', appointment);

    expect(subject).toMatch(/^Appointment cancelled: /);
    expect(lines.join('\n')).toContain('cancelled as you asked');
  });

  it('CANCELLED by the clinic (admin) says so', () => {
    const text = buildEmail('CANCELLED', appointment, { byAdmin: true }).lines.join('\n');

    expect(text).toContain('The clinic has cancelled your appointment');
    expect(text).not.toContain('as you asked');
  });

  it('RESCHEDULED shows the old and the new time', () => {
    const { subject, lines } = buildEmail('RESCHEDULED', appointment, { previous });
    const text = lines.join('\n');

    expect(subject).toBe('Appointment moved: Dr. Meera Iyer, Tue 8 Jan 10:30');
    expect(text).toContain('Old time:        Tuesday, 8 January 2030 at 09:00 (India time)');
    expect(text).toContain('New time:        Tuesday, 8 January 2030 at 10:30 (India time)');
  });

  it('uses the clinic date even when the UTC date is the day before', () => {
    // 01:00 clinic time on 9 Jan = 19:30 UTC on 8 Jan.
    const early = { ...appointment, startAt: new Date('2030-01-09T01:00:00+05:30') };

    expect(buildEmail('BOOKED', early).subject).toContain('Wed 9 Jan 01:00');
  });
});

describe('Email text — negative', () => {
  it('rejects an unknown event type', () => {
    expect(() => buildEmail('DELETED', appointment)).toThrow('Unknown email type');
  });
});

describe('maskEmail (NFR-6: no full personal data in logs)', () => {
  it.each([
    ['asha.reddy@example.com', 'a***@example.com'],
    ['x@y.in', 'x***@y.in'],
    ['no-at-sign', '***'],
    ['@example.com', '***'],
  ])('%s -> %s', (input, masked) => {
    expect(maskEmail(input)).toBe(masked);
  });
});

describe('Delivery modes (FR-7.2)', () => {
  it('tests default to memory: the message is captured, nothing is sent or logged', async () => {
    delete process.env.MAIL_MODE;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMail(MESSAGE);

    expect(mailMode()).toBe('memory');
    expect(sentMail()).toEqual([{ ...MESSAGE, from: config.mailFrom }]);
    expect(log).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('log mode writes one JSON line with a masked address and no body', async () => {
    process.env.MAIL_MODE = 'log';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMail(MESSAGE, { event: 'appointment.booked', appointmentId: 42 });

    expect(sentMail()).toEqual([]);
    expect(createTransport).not.toHaveBeenCalled();
    const line = log.mock.calls[0][0];
    expect(JSON.parse(line)).toMatchObject({
      event: 'appointment.booked',
      appointmentId: 42,
      to: 'a***@example.com',
      subject: 'Hi',
    });
    expect(line).not.toContain('asha.reddy@');
    expect(line).not.toContain('secret body text');
  });

  it('smtp mode sends through SMTP_URL with file and URL access disabled', async () => {
    process.env.MAIL_MODE = 'smtp';
    process.env.SMTP_URL = 'smtp://user:pw@smtp.test:587';
    process.env.MAIL_FROM = 'Clinic <clinic@example.com>';
    const send = vi.fn().mockResolvedValue({});
    createTransport.mockReturnValue({ sendMail: send });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMail(MESSAGE);
    await sendMail(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(1); // one connection, reused
    expect(createTransport).toHaveBeenCalledWith('smtp://user:pw@smtp.test:587', {
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(send).toHaveBeenCalledWith({ from: 'Clinic <clinic@example.com>', ...MESSAGE });
  });

  it('smtp mode: a delivery error is passed to the caller', async () => {
    process.env.MAIL_MODE = 'smtp';
    process.env.SMTP_URL = 'smtp://smtp.test';
    createTransport.mockReturnValue({ sendMail: vi.fn().mockRejectedValue(new Error('down')) });

    await expect(sendMail(MESSAGE)).rejects.toThrow('down');
  });
});

describe('assertRequiredConfig — mail settings', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://x';
    process.env.JWT_SECRET = 'x'.repeat(32);
  });

  it('rejects an unknown MAIL_MODE', () => {
    process.env.MAIL_MODE = 'carrier-pigeon';
    expect(() => assertRequiredConfig()).toThrow('MAIL_MODE must be one of');
  });

  it('rejects MAIL_MODE=smtp without SMTP_URL', () => {
    process.env.MAIL_MODE = 'smtp';
    delete process.env.SMTP_URL;
    expect(() => assertRequiredConfig()).toThrow('needs SMTP_URL');
  });

  it.each(['memory', 'log'])('accepts MAIL_MODE=%s', (mode) => {
    process.env.MAIL_MODE = mode;
    expect(() => assertRequiredConfig()).not.toThrow();
  });

  it('defaults to log outside tests', () => {
    delete process.env.MAIL_MODE;
    process.env.NODE_ENV = 'production';
    expect(config.mailMode).toBe('log');
  });
});
