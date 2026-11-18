import bcrypt from 'bcryptjs';

const ROUNDS = 10;

// FR-1.4: passwords are stored only as bcrypt hashes.
export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the email is unknown, so "unknown email" and
// "wrong password" take about the same time (no user enumeration by timing).
export const DUMMY_HASH = bcrypt.hashSync('dummy-password-not-used-1', ROUNDS);
