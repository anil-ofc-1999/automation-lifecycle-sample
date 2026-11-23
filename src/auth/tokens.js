import jwt from 'jsonwebtoken';

import { config } from '../config.js';

// FR-1.5: access token carries only the user id and role — no personal data.
export function signAccessToken(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

// Returns { userId, role, issuedAt } or throws (expired / invalid signature / malformed).
// issuedAt is in whole seconds (the JWT "iat" claim).
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  return { userId: Number(payload.sub), role: payload.role, issuedAt: payload.iat };
}
