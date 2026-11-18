// Shapes sent to the client. Never include password hashes.
import { clinicDateOf, minutesToHhmm, clinicMinutesOf } from './clinicTime.js';

export const DOCTOR_INCLUDE = {
  user: { select: { id: true, name: true, email: true, isActive: true } },
  specialization: { select: { id: true, name: true, isActive: true } },
};

export function toSpecialization(s) {
  return { id: s.id, name: s.name, isActive: s.isActive };
}

// `admin` adds fields only admins need (email, account status).
export function toDoctor(d, { admin = false } = {}) {
  const doctor = {
    id: d.id,
    name: d.user.name,
    specialization: { id: d.specialization.id, name: d.specialization.name },
    fee: Number(d.fee),
    slotMinutes: d.slotMinutes,
    bio: d.bio ?? null,
    isActive: d.isActive,
  };
  if (admin) {
    doctor.email = d.user.email;
    doctor.userId = d.user.id;
    doctor.accountActive = d.user.isActive;
  }
  return doctor;
}

export const APPOINTMENT_INCLUDE = {
  doctor: {
    select: {
      id: true,
      userId: true,
      user: { select: { name: true } },
      specialization: { select: { name: true } },
    },
  },
  patient: { select: { id: true, name: true } },
};

export function toAppointment(a) {
  return {
    id: a.id,
    status: a.status,
    startAt: a.startAt.toISOString(),
    endAt: a.endAt.toISOString(),
    // Clinic-local date and time, handy for display.
    date: clinicDateOf(a.startAt),
    time: minutesToHhmm(clinicMinutesOf(a.startAt)),
    doctor: {
      id: a.doctor.id,
      name: a.doctor.user.name,
      specialization: a.doctor.specialization.name,
    },
    patient: { id: a.patient.id, name: a.patient.name },
    cancelledBy: a.cancelledBy ?? null,
    cancelledAt: a.cancelledAt ? a.cancelledAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}
