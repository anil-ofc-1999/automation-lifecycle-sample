import { describe, it, expect } from 'vitest';

import {
  clinicDateOf,
  clinicDateTimeToUtc,
  clinicMinutesOf,
  dayOfWeekOf,
  hhmmToMinutes,
  isValidDateString,
  isValidTimeString,
  minutesToHhmm,
} from '../src/lib/clinicTime.js';
import { buildSlots } from '../src/services/slots.js';

const time = (hhmm) => new Date(hhmmToMinutes(hhmm) * 60_000);

describe('clinic time helpers (Asia/Kolkata, UTC+05:30)', () => {
  it('converts clinic date + time to UTC and back', () => {
    const instant = clinicDateTimeToUtc('2030-01-08', hhmmToMinutes('10:00'));
    expect(instant.toISOString()).toBe('2030-01-08T04:30:00.000Z');
    expect(clinicDateOf(instant)).toBe('2030-01-08');
    expect(minutesToHhmm(clinicMinutesOf(instant))).toBe('10:00');
  });

  it('uses the clinic date, not the UTC date, near midnight', () => {
    // 2030-01-08 20:00 UTC = 2030-01-09 01:30 in the clinic
    expect(clinicDateOf(new Date('2030-01-08T20:00:00Z'))).toBe('2030-01-09');
  });

  it('day of week: 0 = Sunday', () => {
    expect(dayOfWeekOf('2030-01-13')).toBe(0);
    expect(dayOfWeekOf('2030-01-07')).toBe(1);
  });

  it('validates dates and times', () => {
    expect(isValidDateString('2030-02-28')).toBe(true);
    expect(isValidDateString('2030-02-30')).toBe(false);
    expect(isValidDateString('2030-2-3')).toBe(false);
    expect(isValidTimeString('09:30')).toBe(true);
    expect(isValidTimeString('9:30')).toBe(false);
    expect(isValidTimeString('24:00')).toBe(false);
  });
});

describe('buildSlots (FR-3.4)', () => {
  it('10:00–11:00 with 30 min → 10:00 and 10:30 (example in REQUIREMENTS)', () => {
    const slots = buildSlots(
      [{ startTime: time('10:00'), endTime: time('11:00') }],
      30,
      '2030-01-08',
    );
    expect(slots.map((s) => s.time)).toEqual(['10:00', '10:30']);
  });

  it('drops a partial slot at the end of a block and sorts blocks', () => {
    const slots = buildSlots(
      [
        { startTime: time('16:00'), endTime: time('16:40') },
        { startTime: time('10:00'), endTime: time('10:15') },
      ],
      15,
      '2030-01-08',
    );
    expect(slots.map((s) => s.time)).toEqual(['10:00', '16:00', '16:15']);
  });
});
