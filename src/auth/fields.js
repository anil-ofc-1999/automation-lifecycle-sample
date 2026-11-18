// Validation rules for user fields, shared by registration and admin-created doctors.
import { z } from 'zod';

export const nameField = z.string().trim().min(2, 'Name must be at least 2 characters.').max(100);

export const emailField = z
  .string()
  .trim()
  .toLowerCase() // FR-1.2: email is case-insensitive
  .pipe(z.email('Enter a valid email address.').max(255));

// FR-1.1: phone is optional
export const phoneField = z
  .string()
  .trim()
  .regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number.')
  .optional();

// FR-1.3: at least 8 characters, one letter and one number (72 = bcrypt limit)
export const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be at most 72 characters.')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter.')
  .regex(/[0-9]/, 'Password must contain at least one number.');
