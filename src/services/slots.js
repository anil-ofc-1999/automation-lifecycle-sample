// Slot generation (FR-3.4, FR-3.5) — shared by the slots API and booking.
import { prisma } from '../db.js';
import {
  DAY_MS,
  clinicDateTimeToUtc,
  dateStringToDateColumn,
  dayOfWeekOf,
  minutesToHhmm,
  timeColumnToMinutes,
} from '../lib/clinicTime.js';

// A doctor patients can see and book: doctor, account and specialization all active.
export const BOOKABLE_DOCTOR_WHERE = {
  isActive: true,
  user: { isActive: true },
  specialization: { isActive: true },
};

// All slots of one clinic-local date from the schedule blocks.
// Partial slots at the end of a block are not offered (FR-3.4).
export function buildSlots(blocks, slotMinutes, dateString) {
  const slots = [];
  for (const block of blocks) {
    const start = timeColumnToMinutes(block.startTime);
    const end = timeColumnToMinutes(block.endTime);
    for (let m = start; m + slotMinutes <= end; m += slotMinutes) {
      slots.push({
        minutes: m,
        time: minutesToHhmm(m),
        startAt: clinicDateTimeToUtc(dateString, m),
        endAt: clinicDateTimeToUtc(dateString, m + slotMinutes),
      });
    }
  }
  return slots.sort((a, b) => a.minutes - b.minutes);
}

// UTC range [start, end) of a clinic-local date.
export function clinicDayRange(dateString) {
  const start = clinicDateTimeToUtc(dateString, 0);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export async function isOnLeave(client, doctorId, dateString) {
  const leave = await client.doctorLeave.findUnique({
    where: { doctorId_leaveDate: { doctorId, leaveDate: dateStringToDateColumn(dateString) } },
  });
  return leave !== null;
}

// Slots of `doctor` for a clinic date, without leave/past filtering.
export async function scheduledSlots(client, doctor, dateString) {
  const blocks = await client.doctorSchedule.findMany({
    where: { doctorId: doctor.id, dayOfWeek: dayOfWeekOf(dateString) },
  });
  return buildSlots(blocks, doctor.slotMinutes, dateString);
}

const overlaps = (slot, appt) => appt.startAt < slot.endAt && appt.endAt > slot.startAt;

// FR-3.5: each future slot with AVAILABLE / BOOKED.
// A slot counts as BOOKED if any active booking overlaps it (covers old bookings
// made before the doctor changed schedule or slot length — FR-3.6).
export async function slotsForDate(doctor, dateString, now = new Date()) {
  if (await isOnLeave(prisma, doctor.id, dateString)) return { onLeave: true, slots: [] };

  const slots = (await scheduledSlots(prisma, doctor, dateString)).filter((s) => s.startAt > now);
  if (slots.length === 0) return { onLeave: false, slots: [] };

  const { start, end } = clinicDayRange(dateString);
  const booked = await prisma.appointment.findMany({
    where: { doctorId: doctor.id, status: 'BOOKED', startAt: { lt: end }, endAt: { gt: start } },
    select: { startAt: true, endAt: true },
  });

  return {
    onLeave: false,
    slots: slots.map((s) => ({
      time: s.time,
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      status: booked.some((b) => overlaps(s, b)) ? 'BOOKED' : 'AVAILABLE',
    })),
  };
}
